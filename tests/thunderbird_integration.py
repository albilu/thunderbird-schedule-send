#!/usr/bin/env python3
"""Native integration tests: disposable Thunderbird profile + loopback SMTP.

Never opens the user's profile. Mail is captured locally, not relayed. Requires
Thunderbird 153+, Xvfb and optionally xfwm4 / ImageMagick for UI screenshots.
No Python packages or downloaded browser drivers are needed.
"""
import base64
import email.policy
from email.parser import BytesParser
import json
import os
from pathlib import Path
import re
import shutil
import socket
import socketserver
import subprocess
import sys
import tempfile
import threading
import time

from marionette import Marionette

ROOT = Path(__file__).resolve().parents[1]
LOCALE = os.environ.get("SCHEDULE_TEST_LOCALE", "en-US")
LANGUAGE = "fr" if LOCALE.startswith("fr") else "en"
MESSAGES = json.loads((ROOT / f"extension/_locales/{LANGUAGE}/messages.json").read_text())
RESULTS = ROOT / "test-results" / LOCALE
ADDON = "scheduled-send@thunderbird-schedule-send.local"
QUEUE = "message/message.html?integration"
MANAGE = "message/message.html"
POPUP = "popup/popup.html"
API = "window.wrappedJSObject.messenger"


class SMTPHandler(socketserver.StreamRequestHandler):
    def handle(self):
        self.wfile.write(b"220 localhost fixture ESMTP\r\n")
        recipients = []
        while line := self.rfile.readline():
            verb = line.split(b" ", 1)[0].strip().upper()
            if verb in (b"EHLO", b"HELO"):
                self.wfile.write(b"250-localhost\r\n250-SIZE 73400320\r\n250 8BITMIME\r\n")
            elif verb == b"MAIL":
                recipients = []
                self.wfile.write(b"250 sender accepted\r\n")
            elif verb == b"RCPT":
                recipients.append(line.decode().strip())
                self.wfile.write(b"250 recipient accepted\r\n")
            elif verb == b"DATA":
                self.wfile.write(b"354 end with dot\r\n")
                parts = []
                while (part := self.rfile.readline()) not in (b".\r\n", b""):
                    parts.append(part[1:] if part.startswith(b"..") else part)
                self.server.messages.append((b"".join(parts), recipients[:]))
                self.wfile.write(b"250 message accepted\r\n")
            elif verb == b"QUIT":
                self.wfile.write(b"221 bye\r\n")
                return
            else:
                self.wfile.write(b"250 OK\r\n")


class SMTPServer(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


def request(client, value):
    result = client.page(QUEUE, f"return {API}.runtime.sendMessage(arguments[0]);", value)
    assert result and result.get("ok"), result
    return result


def wait_page(client, path):
    client.wait(f"return [...testExtension.views].some(v => v.uri?.spec === testExtension.baseURI.resolve({json.dumps(path)}));")


def queue(client):
    client.background(f"return {API}.tabs.create({{url: {API}.runtime.getURL('{QUEUE}')}});")
    wait_page(client, QUEUE)
    return request(client, {"type": "list"})


def set_extension(client):
    client.script("""
      const { ExtensionParent } = ChromeUtils.importESModule('resource://gre/modules/ExtensionParent.sys.mjs');
      globalThis.testExtension = ExtensionParent.GlobalManager.extensionMap.get(arguments[0]);
    """, ADDON)
    wait_page(client, "background/background.html")


def create_compose(client, subject="Scheduled integration message", attachment=True):
    tab = client.background(f"""
      const api = {API};
      const tab = await api.compose.beginNew({{
        to: ['receiver@example.invalid'], cc: ['copy@example.invalid'], bcc: ['hidden@example.invalid'],
        subject: arguments[0], isPlainText: false, deliveryFormat: 'both',
        body: '<p>Hello <strong>scheduled world</strong> — café.</p><img alt="pixel" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7">' +
          (arguments[2] ? '<img alt="saved local image" src="' + arguments[2] + '">' : '')
      }});
      if (arguments[1]) await api.compose.addAttachment(tab.id, {{file: new File(['Attachment survives the compose window. Café.'], 'fixture.txt', {{type: 'text/plain'}})}});
      return tab;
    """, subject, attachment, client.inline_image.as_uri() if client.inline_image.exists() else None)
    client.script("globalThis.testCompose = Services.wm.getMostRecentWindow('msgcompose'); testCompose.focus();")
    client.wait("return testCompose.document.getElementById('scheduled-send_thunderbird-schedule-send_local-composeAction-toolbarbutton');")
    assert client.script("""
      return testCompose.document.getElementById('button-send').nextElementSibling.id;
    """) == "scheduled-send_thunderbird-schedule-send_local-composeAction-toolbarbutton"
    client.script("testCompose.gMsgCompose.compFields.references = '<parent@example.invalid>';")
    return tab


def screenshot(client, name):
    if shutil.which("import"):
        time.sleep(.15)  # Let Gecko paint the just-updated popup or queue.
        subprocess.run(["import", "-window", "root", str(RESULTS / name)], env=client.test_env, check=True)


def modify_jobs(client, source):
    return client.background(f"""
      const api = {API};
      const {{ ScheduleStore }} = await import(api.runtime.getURL('lib/store.mjs'));
      const store = new ScheduleStore();
      {source}
    """)


def theme_tests(client):
    themes = client.async_script("""
      const { AddonManager } = ChromeUtils.importESModule('resource://gre/modules/AddonManager.sys.mjs');
      return (await AddonManager.getAddonsByTypes(['theme'])).map(t => ({id: t.id, active: t.isActive}));
    """)
    original = next(theme['id'] for theme in themes if theme['active'])
    backgrounds = []
    try:
        for scheme in ['light', 'dark']:
            theme = next(t['id'] for t in themes if f'compact-{scheme}@' in t['id'])
            client.async_script("""
              const { AddonManager } = ChromeUtils.importESModule('resource://gre/modules/AddonManager.sys.mjs');
              await (await AddonManager.getAddonByID(arguments[0])).enable();
            """, theme)
            time.sleep(.4)
            backgrounds.append(client.page(QUEUE, "return getComputedStyle(document.documentElement).backgroundColor;"))
        assert backgrounds[0] != backgrounds[1], backgrounds
        print("PASS: UI follows Thunderbird light/dark theme changes", flush=True)
    finally:
        client.async_script("""
          const { AddonManager } = ChromeUtils.importESModule('resource://gre/modules/AddonManager.sys.mjs');
          await (await AddonManager.getAddonByID(arguments[0])).enable();
        """, original)


def run_tests(client, xpi, smtp):
    print(f"Thunderbird {client.script('return Services.appinfo.version;')}, locale {LOCALE}", flush=True)
    installed = client.async_script("""
      const { AddonManager } = ChromeUtils.importESModule('resource://gre/modules/AddonManager.sys.mjs');
      const file = Cc['@mozilla.org/file/local;1'].createInstance(Ci.nsIFile);
      file.initWithPath(arguments[0]);
      const addon = await AddonManager.installTemporaryAddon(file);
      return {id: addon.id, active: addon.isActive};
    """, str(xpi))
    assert installed == {"id": ADDON, "active": True}, installed
    set_extension(client)
    assert queue(client)["jobs"] == []
    print("PASS: packaged add-on installs, initializes IndexedDB and opens the queue", flush=True)
    theme_tests(client)

    tab = create_compose(client)
    client.wait("return testCompose.document.getElementById('blockedContentOptions').value;")
    blocked = client.page(QUEUE, f"return {API}.runtime.sendMessage(arguments[0]);", {"type": "schedule", "tabId": tab["id"], "rule": {"startAt": int(time.time() * 1000) + 3600000}})
    assert blocked.get("error") == "errorBlockedContent", blocked
    assert client.script("return !testCompose.gWindowLocked;")
    client.script("testCompose.onUnblockResource(arguments[0], testCompose.document.getElementById('blockedContentOptions'));", client.inline_image.as_uri())
    print("PASS: native blocked-resource protection is respected before capturing a message", flush=True)
    client.background(f"return {API}.composeAction.openPopup({{windowId: arguments[0]}});", tab["windowId"])
    wait_page(client, POPUP)
    time.sleep(.5)
    localized = client.page(POPUP, "return {title: document.title, label: document.getElementById('submit').textContent, lang: document.documentElement.lang};")
    assert localized["title"] == MESSAGES["scheduleSend"]["message"], localized
    assert localized["label"] == MESSAGES["scheduleMessage"]["message"], localized
    values = client.page(POPUP, """
      document.querySelector('[data-minutes="5"]').click();
      return {delay: document.querySelector('input[type="number"]').value,
        overflow: document.documentElement.scrollWidth > innerWidth,
        innerWidth, scrollWidth: document.documentElement.scrollWidth, bodyWidth: document.body.getBoundingClientRect().width,
        footerVisible: document.querySelector('footer').getBoundingClientRect().bottom <= innerHeight + 1,
        innerHeight, footerBottom: document.querySelector('footer').getBoundingClientRect().bottom,
        enabled: !document.getElementById('submit').disabled,
        background: getComputedStyle(document.body).backgroundColor};
    """)
    screenshot(client, "popup.png")
    assert values["delay"] == "5" and values["enabled"] and not values["overflow"] and values["footerVisible"] and 395 <= values["innerWidth"] <= 420, values
    client.page(POPUP, """document.querySelector('details').open = true; document.querySelector('input[id$="useWindow"]').click(); document.querySelector('input[id$="useDays"]').click();""")
    screenshot(client, "popup-rules.png")
    # Verify empty weekday selection disables scheduling, then restore defaults.
    assert client.page(POPUP, """
      for (const input of document.querySelectorAll('.weekdays input')) input.click();
      return document.getElementById('submit').disabled;
    """)
    client.page(POPUP, """document.querySelector('input[id$="useWindow"]').click(); document.querySelector('input[id$="useDays"]').click(); document.getElementById('submit').click();""")
    end = time.monotonic() + 15
    saved = []
    while time.monotonic() < end:
        saved = request(client, {"type": "list"})["jobs"]
        if saved:
            break
        time.sleep(.1)
    if len(saved) != 1:
        print("Capture diagnostic:", client.page(QUEUE, f"return {API}.runtime.sendMessage(arguments[0]);", {"type": "schedule", "tabId": tab["id"], "rule": {"startAt": int(time.time() * 1000) + 3600000}}), flush=True)
        print("Compose:", client.script("return {locked: testCompose.gWindowLocked, save: testCompose.gSaveOperationInProgress, send: testCompose.gSendOperationInProgress};"), flush=True)
        print("Popup:", client.page(POPUP, "return {error: document.getElementById('error').textContent, disabled: document.getElementById('submit').disabled, label: document.getElementById('submit').textContent, validity: [...document.querySelectorAll('input')].map(i => ({id: i.id, value: i.value, disabled: i.disabled, valid: i.validity.valid}))};"), flush=True)
    assert len(saved) == 1, saved
    job = saved[0]
    assert job["status"] == "pending" and job["attachmentCount"] == 1, job
    assert client.background(f"return {API}.browserAction.getBadgeText({{}});") == "1"
    client.wait("return testCompose.closed;")
    preserved = modify_jobs(client, "const jobs = await store.all(); const payload = await store.payload(jobs[0].id); return {text: await payload.attachments[0].file.text(), references: payload.native.references};")
    assert "Café" in preserved["text"] and preserved["references"] == "<parent@example.invalid>", preserved
    assert modify_jobs(client, "return !(await store.payload((await store.all())[0].id)).details.body.includes('file:');")
    client.inline_image.unlink()
    assert not smtp.messages
    print("PASS: native adjacent button, translated popup, presets, constraints, durable snapshot and compose close", flush=True)

    # The queue contains actual readable RFC822 messages, independent of the UI.
    native = client.background(f"""
      const api = {API};
      const folder = await api.scheduleBridge.queueFolder();
      const messages = (await api.messages.list(folder.id)).messages;
      const raw = await api.messages.getRaw(messages[0].id);
      return {{folder, messages, raw: typeof raw === 'string' ? raw : await raw.text(),
        options: api.runtime.getManifest().options_ui || null}};
    """)
    assert native["folder"]["name"] == MESSAGES["queueFolder"]["message"], native
    assert len(native["messages"]) == 1 and native["options"] is None
    queued_mail = BytesParser(policy=email.policy.default).parsebytes(native["raw"].encode())
    assert queued_mail["Subject"] == job["subject"]
    assert "hidden@example.invalid" in str(queued_mail["Bcc"])
    assert any(p.get_filename() == "fixture.txt" for p in queued_mail.walk())
    assert "scheduledsend-pending" in native["messages"][0]["tags"]
    request(client, {"type": "queue"})
    request(client, {"type": "queue"})
    assert client.background(f"return (await {API}.mailTabs.query({{}})).filter(t => t.displayedFolder?.id === arguments[0]).length;", native["folder"]["id"]) == 1
    print("PASS: real local-folder MIME copies, status tags and native queue navigation", flush=True)

    # Simulate legacy metadata and an interrupted migration with a copy already
    # present. Reload must create exactly one copy per active schedule.
    legacy_id = modify_jobs(client, f"""
      const original = await store.get({json.dumps(job['id'])});
      delete original.folderBacked;
      await store.put(original);
      const legacy = {{...original, id: crypto.randomUUID(), subject: 'Legacy migration fixture'}};
      const payload = await store.payload(original.id);
      payload.details.subject = legacy.subject;
      await store.create(legacy, payload);
      return legacy.id;
    """)
    # A real add-on shutdown/restart must retain both the queue and File objects.
    client.async_script("""
      const { AddonManager } = ChromeUtils.importESModule('resource://gre/modules/AddonManager.sys.mjs');
      const addon = await AddonManager.getAddonByID(arguments[0]);
      await addon.reload();
    """, ADDON)
    set_extension(client)
    migrated = queue(client)["jobs"]
    assert {j["id"] for j in migrated} == {job["id"], legacy_id}
    assert all(j["folderBacked"] for j in migrated)
    assert "Café" in modify_jobs(client, "const jobs = await store.all(); return await (await store.payload(jobs[0].id)).attachments[0].file.text();")
    assert client.background(f"return (await {API}.messages.list((await {API}.scheduleBridge.queueFolder()).id)).messages.length;") == 2
    request(client, {"type": "act", "id": legacy_id, "action": "cancel"})
    assert client.background(f"return (await {API}.messages.list((await {API}.scheduleBridge.queueFolder()).id)).messages.length;") == 1
    request(client, {"type": "act", "id": legacy_id, "action": "remove"})
    print("PASS: restart durability and idempotent migration of existing schedules", flush=True)

    request(client, {"type": "act", "id": job["id"], "action": "pause"})
    assert request(client, {"type": "list"})["jobs"][0]["status"] == "paused"
    request(client, {"type": "act", "id": job["id"], "action": "resume"})
    client.script("Services.io.offline = true;")
    modify_jobs(client, "for (const job of await store.all()) {job.nextAt = Date.now() - 1000; await store.put(job);} await api.alarms.create('next-send', {when: Date.now() + 100});")
    time.sleep(.8)
    assert not smtp.messages
    assert request(client, {"type": "list"})["jobs"][0]["status"] == "pending"
    client.script("Services.io.offline = false;")
    client.background(f"return {API}.alarms.create('next-send', {{when: Date.now() + 100}});")
    end = time.monotonic() + 20
    while time.monotonic() < end:
        state = request(client, {"type": "list"})["jobs"][0]
        if state["status"] in ("sent", "review"):
            break
        time.sleep(.15)
    assert state["status"] == "sent", state
    assert not state.get("error"), state
    assert client.script("""
      const { MailServices } = ChromeUtils.importESModule('resource:///modules/MailServices.sys.mjs');
      return MailServices.accounts.localFoldersServer.rootFolder.getChildNamed('Sent').getTotalMessages(false);
    """) == 1
    assert len(smtp.messages) == 1, len(smtp.messages)
    wire, recipients = smtp.messages[0]
    message = BytesParser(policy=email.policy.default).parsebytes(wire)
    assert message["Subject"] == "Scheduled integration message", message.items()
    assert message["References"] == "<parent@example.invalid>", message.items()
    assert message["Bcc"] is None, "Bcc must not leak in the message headers"
    assert any("hidden@example.invalid" in r for r in recipients), recipients
    html = message.get_body(preferencelist=("html",)).get_content()
    assert "scheduled world" in html and "café" in html
    references = set(re.findall(r'cid:([^"\s>]+)', html))
    content_ids = {part["Content-ID"].strip("<>") for part in message.walk() if part["Content-ID"]}
    assert references and references.issubset(content_ids), (references, content_ids)
    assert any(part.get_content_type() == "multipart/related" for part in message.walk())
    attachments = [part for part in message.walk() if part.get_filename() == "fixture.txt"]
    assert len(attachments) == 1 and "Café" in attachments[0].get_payload(decode=True).decode(), attachments
    assert any(part.get_content_type() == "image/gif" for part in message.walk()), [part.get_content_type() for part in message.walk()]
    assert modify_jobs(client, "return (await store.payload((await store.all())[0].id)) === undefined;")
    print("PASS: real background SMTP delivery, offline wait, HTML, attachment bytes, inline image, reply headers, Bcc privacy and payload cleanup", flush=True)

    client.script("Services.prefs.setStringPref('mail.identity.id1.escapedVCard', encodeURIComponent('BEGIN:VCARD\\r\\nVERSION:3.0\\r\\nFN:Scheduled Test\\r\\nEMAIL:sender@example.invalid\\r\\nEND:VCARD\\r\\n'));")
    plain = client.background(f"""
      return await {API}.compose.beginNew({{to: ['plain@example.invalid'], subject: 'Plain text fixture',
        isPlainText: true, plainTextBody: 'Plain text — café.\\nSecond line.', attachVCard: true}});
    """)
    plain_job = request(client, {"type": "schedule", "tabId": plain["id"], "rule": {"startAt": int(time.time() * 1000) + 60000}})["job"]
    modify_jobs(client, f"const job = await store.get({json.dumps(plain_job['id'])}); job.nextAt = Date.now() - 1000; await store.put(job); await api.alarms.create('next-send', {{when: Date.now() + 100}});")
    end = time.monotonic() + 15
    while time.monotonic() < end:
        state = next(j for j in request(client, {"type": "list"})["jobs"] if j["id"] == plain_job["id"])
        if state["status"] in ("sent", "review"):
            break
        time.sleep(.1)
    assert state["status"] == "sent" and not state.get("error"), state
    assert len(smtp.messages) == 2
    plain_message = BytesParser(policy=email.policy.default).parsebytes(smtp.messages[1][0])
    plain_body = plain_message.get_body(preferencelist=("plain",)).get_content()
    assert "Plain text — café." in plain_body and "Second line." in plain_body, plain_body
    assert not any(p.get_content_type() == "text/html" for p in plain_message.walk())
    assert any(p.get_filename() == "sender.vcf" and b"BEGIN:VCARD" in p.get_payload(decode=True) for p in plain_message.walk())
    assert plain_message["Message-ID"] != message["Message-ID"]
    print("PASS: plain-text Unicode delivery, requested vCard and fresh Message-ID", flush=True)

    # Exercise actual queue controls and a recurring schedule without sending it.
    tab = create_compose(client, "Recurring check", attachment=False)
    rule = {"startAt": int(time.time() * 1000) + 3600000, "recurrence": {"unit": "monthly", "interval": 1}, "weekdays": [1, 2, 3, 4, 5], "window": {"start": "01:00", "end": "05:00"}}
    recurring = request(client, {"type": "schedule", "tabId": tab["id"], "rule": rule})["job"]
    request(client, {"type": "queue"})
    selected = client.background(f"""
      const api = {API};
      const folder = await api.scheduleBridge.queueFolder();
      const tabs = await api.mailTabs.query({{}});
      const tab = tabs.find(t => t.displayedFolder?.id === folder.id);
      const messages = (await api.messages.list(folder.id)).messages;
      const message = messages.find(m => m.subject === 'Recurring check');
      await api.mailTabs.setSelectedMessages(tab.id, [message.id]);
      return {{tab, message}};
    """)
    time.sleep(.5)
    screenshot(client, "queue-folder.png")
    assert client.background(f"return {API}.messageDisplayAction.isEnabled({{tabId: arguments[0]}});", selected["tab"]["id"])
    client.background(f"return {API}.messageDisplayAction.openPopup({{windowId: arguments[0]}});", selected["tab"]["windowId"])
    wait_page(client, MANAGE)
    time.sleep(.3)
    client.page(MANAGE, "document.getElementById('refresh').click();")
    time.sleep(.2)
    screenshot(client, "message-controls.png")
    client.page(MANAGE, "document.querySelector('button[data-action=" + '"reschedule"' + "]').click();")
    assert client.page(MANAGE, "return document.getElementById('edit-dialog').open;")
    client.page(MANAGE, "document.querySelector('#edit-rule select').value = 'yearly'; document.querySelector('#edit-rule select').dispatchEvent(new Event('change', {bubbles:true})); document.getElementById('save-edit').click();")
    time.sleep(.3)
    edited = next(j for j in request(client, {"type": "list"})["jobs"] if j["id"] == recurring["id"])
    assert edited["rule"]["recurrence"]["unit"] == "yearly", edited
    client.page(MANAGE, "document.querySelector('button[data-action=\"pause\"]').click();")
    time.sleep(.2)
    client.page(MANAGE, "document.querySelector('button[data-action=\"resume\"]').click();")
    time.sleep(.2)
    request(client, {"type": "restore", "id": recurring["id"]})
    assert next(j for j in request(client, {"type": "list"})["jobs"] if j["id"] == recurring["id"])["status"] == "paused"
    # Close the editable copy without sending and cancel via the native action.
    client.script("""
      const copy = Services.wm.getMostRecentWindow('msgcompose');
      copy.gContentChanged = false; copy.gMsgCompose.bodyModified = false;
      copy.close();
      Services.wm.getMostRecentWindow('mail:3pane').focus();
    """)
    client.background(f"return {API}.messageDisplayAction.openPopup({{windowId: arguments[0]}});", selected["tab"]["windowId"])
    wait_page(client, MANAGE)
    time.sleep(.3)
    client.page(MANAGE, "document.querySelector('button[data-action=\"cancel\"]').click();")
    assert client.page(MANAGE, "return document.getElementById('confirmation').open;")
    client.page(MANAGE, "document.getElementById('confirm-action').click();")
    time.sleep(.3)
    assert next(j for j in request(client, {"type": "list"})["jobs"] if j["id"] == recurring["id"])["status"] == "cancelled"
    print("PASS: native message controls, reschedule, restored copy, pause, resume and cancellation", flush=True)

    # Native actions must cancel without relying on the custom controls or
    # waiting for the next send alarm, including while Thunderbird is offline.
    client.script("Services.io.offline = true;")
    for action in ["delete", "move"]:
        tab = create_compose(client, f"Native {action} fixture", attachment=False)
        removed = request(client, {"type": "schedule", "tabId": tab["id"], "rule": {"startAt": int(time.time() * 1000) + 3600000}})["job"]
        if action == "move":
            request(client, {"type": "act", "id": removed["id"], "action": "pause"})
        client.async_script("""
          const { MailServices } = ChromeUtils.importESModule('resource:///modules/MailServices.sys.mjs');
          const root = MailServices.accounts.localFoldersServer.rootFolder;
          const folder = [...root.subFolders].find(f => f.getStringProperty('scheduledSendOwner') === arguments[0]);
          const header = folder.msgDatabase.getMsgHdrForMessageID(`scheduled-send-${arguments[1]}@scheduled-send.local`);
          await new Promise((resolve, reject) => {
            const listener = {
              onStartCopy() {}, onProgress() {}, setMessageKey() {}, getMessageId() {return '';},
              onStopCopy(status) { if (Components.isSuccessCode(status)) resolve(); else reject(new Error(String(status))); }
            };
            if (arguments[2] === 'move') MailServices.copy.copyMessages(folder, [header], root.getChildNamed('Sent'), true, listener, null, false);
            else folder.deleteMessages([header], null, false, false, listener, false);
          });
        """, ADDON, removed["id"], action)
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            cancelled = next(j for j in request(client, {"type": "list"})["jobs"] if j["id"] == removed["id"])
            if cancelled["status"] == "cancelled":
                break
            time.sleep(.1)
        assert cancelled["status"] == "cancelled", cancelled
        assert modify_jobs(client, f"return !(await store.payload({json.dumps(removed['id'])}));")
        assert len(smtp.messages) == 2
    client.script("Services.io.offline = false;")
    print("PASS: native delete and move cancel pending/paused mail while offline", flush=True)

    # Mark a durable send as interrupted, reload, and verify no retransmission.
    tab = create_compose(client, "Interrupted fixture", attachment=False)
    interrupted = request(client, {"type": "schedule", "tabId": tab["id"], "rule": {"startAt": int(time.time() * 1000) + 3600000}})["job"]
    modify_jobs(client, f"const job = await store.get({json.dumps(interrupted['id'])}); job.status = 'sending'; await store.put(job);")
    client.async_script("""
      const { AddonManager } = ChromeUtils.importESModule('resource://gre/modules/AddonManager.sys.mjs');
      await (await AddonManager.getAddonByID(arguments[0])).reload();
    """, ADDON)
    set_extension(client)
    reviewed = next(j for j in queue(client)["jobs"] if j["id"] == interrupted["id"])
    assert reviewed["status"] == "review" and reviewed["error"] == "errorInterrupted", reviewed
    assert len(smtp.messages) == 2
    print("PASS: interrupted send is held for review across native reload", flush=True)

    tab = create_compose(client, "Security check", attachment=False)
    client.script("testCompose.gSendSigned = true;")
    rejected = client.page(QUEUE, f"return {API}.runtime.sendMessage(arguments[0]);", {"type": "schedule", "tabId": tab["id"], "rule": {"startAt": int(time.time() * 1000) + 3600000}})
    assert rejected.get("ok") is False and rejected.get("error") == "errorEncryption", rejected
    assert client.script("return !testCompose.closed && !testCompose.gWindowLocked;")
    client.script("testCompose.gSendSigned = false;")
    client.async_script("""
      const { AddonManager } = ChromeUtils.importESModule('resource://gre/modules/AddonManager.sys.mjs');
      await (await AddonManager.getAddonByID(arguments[0])).disable();
    """, ADDON)
    assert client.script("return !testCompose.document.getElementById('scheduled-send_thunderbird-schedule-send_local-composeAction-toolbarbutton') && !testCompose.gWindowLocked;")
    assert len(smtp.messages) == 2
    print("PASS: signed mail fails safely; disabling removes UI and leaves compose usable", flush=True)
    (RESULTS / "result.json").write_text(json.dumps({"passed": True, "thunderbird": client.script("return Services.appinfo.version;"), "locale": LOCALE, "smtpMessages": len(smtp.messages), "artifact": xpi.name}, indent=2) + "\n")


def main():
    thunderbird = shutil.which(os.environ.get("THUNDERBIRD_BINARY", "thunderbird"))
    if not thunderbird or not shutil.which("Xvfb"):
        raise SystemExit("Install Thunderbird 153+ and Xvfb to run the native integration tests.")
    RESULTS.mkdir(parents=True, exist_ok=True)
    subprocess.run([sys.executable, str(ROOT / "scripts/package.py")], check=True)
    version = json.loads((ROOT / "extension/manifest.json").read_text())["version"]
    xpi = ROOT / "dist" / f"thunderbird-scheduled-send-{version}.xpi"
    with SMTPServer(("127.0.0.1", 0), SMTPHandler) as smtp, tempfile.TemporaryDirectory(prefix="scheduled-send-test-") as temporary:
        smtp.messages = []
        thread = threading.Thread(target=smtp.serve_forever, daemon=True)
        thread.start()
        profile = Path(temporary) / "profile"
        profile.mkdir()
        (profile / "Mail" / "Local Folders").mkdir(parents=True)
        (profile / "Mail" / "Local Folders" / "Sent").touch()
        inline_image = Path(temporary) / "inline.gif"
        inline_image.write_bytes(base64.b64decode("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"))
        with socket.socket() as free:
            free.bind(("127.0.0.1", 0))
            port = free.getsockname()[1]
        prefs = {
            "marionette.port": port, "marionette.enabled": True,
            "mail.shell.checkDefaultClient": False, "mail.provider.enabled": False,
            "mail.provider.suppress_dialog_on_startup": True, "mailnews.start_page.enabled": False,
            "mail.accountmanager.accounts": "account1", "mail.accountmanager.defaultaccount": "account1",
            "mail.accountmanager.localfoldersserver": "server1", "mail.account.account1.server": "server1",
            "mail.account.account1.identities": "id1", "mail.server.server1.type": "none",
            "mail.server.server1.hostname": "Local Folders", "mail.server.server1.name": "Local Folders",
            "mail.server.server1.userName": "nobody", "mail.server.server1.directory": str(profile / "Mail" / "Local Folders"),
            "mail.identity.id1.fullName": "Scheduled Send Test", "mail.identity.id1.useremail": "sender@example.invalid",
            "mail.identity.id1.compose_html": True, "mail.identity.id1.fcc": True,
            "mail.identity.id1.fcc_folder": "mailbox://nobody@Local%20Folders/Sent",
            "mail.identity.id1.draft_folder": "mailbox://nobody@Local%20Folders/Drafts",
            "mail.smtpservers": "smtp1", "mail.smtp.defaultserver": "smtp1", "mail.identity.id1.smtpServer": "smtp1",
            "mail.smtpserver.smtp1.hostname": "127.0.0.1", "mail.smtpserver.smtp1.port": smtp.server_address[1],
            "mail.smtpserver.smtp1.authMethod": 1, "mail.smtpserver.smtp1.try_ssl": 0,
            "mail.smtpserver.smtp1.username": "", "mailnews.sendInBackground": True,
            "app.update.auto": False, "datareporting.policy.dataSubmissionEnabled": False,
            "toolkit.telemetry.reportingpolicy.firstRun": False,
            "browser.startup.homepage_override.mstone": "ignore", "mailnews.start_page.override_url": "",
        }
        (profile / "user.js").write_text("\n".join(f"user_pref({json.dumps(key)}, {json.dumps(value)});" for key, value in prefs.items()))
        with (RESULTS / "thunderbird.log").open("w") as log:
            display = subprocess.Popen(["Xvfb", "-displayfd", "1", "-screen", "0", "1280x960x24", "-nolisten", "tcp"], stdout=subprocess.PIPE, stderr=log)
            process = manager = client = None
            try:
                number = display.stdout.readline().decode().strip()
                if not number:
                    raise RuntimeError("Xvfb failed to start")
                env = {**os.environ, "DISPLAY": f":{number}", "MOZ_ENABLE_WAYLAND": "0", "MOZ_REMOTE_ALLOW_SYSTEM_ACCESS": "1", "TZ": "Europe/Paris"}
                if shutil.which("xfwm4"):
                    manager = subprocess.Popen(["xfwm4", "--compositor=off"], env=env, stdout=log, stderr=log)
                process = subprocess.Popen([thunderbird, "-no-remote", "-profile", str(profile), "-offline", "-marionette"], env=env, stdout=log, stderr=log)
                deadline = time.monotonic() + 40
                while time.monotonic() < deadline:
                    if process.poll() is not None:
                        raise RuntimeError("Thunderbird exited; see test-results log")
                    try:
                        client = Marionette(port)
                        break
                    except (ConnectionRefusedError, TimeoutError):
                        time.sleep(.2)
                if not client:
                    raise RuntimeError("Thunderbird automation did not start")
                client.test_env = env
                client.inline_image = inline_image
                client.script("Services.locale.availableLocales = [...new Set([...Services.locale.availableLocales, arguments[0]])]; Services.locale.requestedLocales = [arguments[0]];", LOCALE)
                run_tests(client, xpi, smtp)
            except Exception:
                if client:
                    try:
                        print("Diagnostics:", client.script("return Services.console.getMessageArray().slice(-20).map(item => item.message);"), flush=True)
                        screenshot(client, "failure.png")
                    except Exception:
                        pass
                raise
            finally:
                if client:
                    client.socket.close()
                for child in [process, manager, display]:
                    if child:
                        child.terminate()
                        try:
                            child.wait(timeout=8)
                        except subprocess.TimeoutExpired:
                            child.kill()
                            child.wait()
                smtp.shutdown()


if __name__ == "__main__":
    main()
