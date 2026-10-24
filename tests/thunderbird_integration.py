#!/usr/bin/env python3
"""Native integration tests: disposable Thunderbird profile + loopback IMAP/SMTP.

Never opens the user's profile. Mail is captured locally, not relayed. Requires
Thunderbird 128+, Xvfb and optionally xfwm4 / ImageMagick for UI screenshots.
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
from urllib.parse import quote, unquote

from marionette import Marionette
from imap_fixture import IMAPServer
from theme_checks import theme_tests

ROOT = Path(__file__).resolve().parents[1]
LOCALE = os.environ.get("SCHEDULE_TEST_LOCALE", "en-US")
LANGUAGE = "fr" if LOCALE.startswith("fr") else "en"
MESSAGES = json.loads((ROOT / f"extension/_locales/{LANGUAGE}/messages.json").read_text())
RESULTS = Path(os.environ.get("SCHEDULE_TEST_RESULTS", ROOT / "test-results" / LOCALE))
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


def wait_ui(client, path, expression):
    deadline = time.monotonic() + 15
    while time.monotonic() < deadline:
        if client.page(path, f"return {expression};"):
            return
        time.sleep(.1)
    raise AssertionError(f"UI did not become ready: {expression}")


def finish_edited_draft(client, choice, action="close"):
    client.script("""
      globalThis.editedCompose = Services.wm.getMostRecentWindow('msgcompose');
      editedCompose.setTimeout(() => {
        if (arguments[0] === 'save') void editedCompose.SaveAsDraft();
        else editedCompose.ComposeCanClose();
      }, 0);
    """, action)
    client.wait("""
      globalThis.schedulePrompt = [...Services.wm.getEnumerator(null)].find(w => w.document.documentURI.includes('commonDialog'));
      return schedulePrompt?.document.querySelector('dialog')?.getButton('accept');
    """)
    assert client.script("return schedulePrompt.document.getElementById('infoBody').textContent;").startswith(MESSAGES["keepScheduleDescription"]["message"].split("$1")[0])
    screenshot(client, "keep-schedule.png")
    client.script("""
      const button = arguments[0] === 0 ? 'accept' : arguments[0] === 1 ? 'cancel' : 'extra1';
      schedulePrompt.document.querySelector('dialog').getButton(button).click();
    """, choice)


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


def queued_raw(imap, job_id):
    with imap.lock:
        for message in imap.mailboxes["Drafts"]:
            if b"X-Scheduled-Send:" in message["raw"] and job_id.encode() in re.sub(br"\r\n[ \t]+", b"", message["raw"]) and "\\Deleted" not in message["flags"]:
                return message
    return None


def tagged_draft_test(client, imap, smtp):
    original = imap.append("Drafts", b"From: sender@example.invalid\r\nTo: receiver@example.invalid\r\nSubject: Tagged original draft\r\nMessage-ID: <tagged-draft@example.invalid>\r\nDate: Sat, 24 Oct 2026 12:00:00 +0000\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\nOriginal draft contents.\r\n", ["\\Seen", "\\Draft", "project-tag"])
    client.async_script("""
      const { MailServices } = ChromeUtils.importESModule('resource:///modules/MailServices.sys.mjs');
      const { MailUtils } = ChromeUtils.importESModule('resource:///modules/MailUtils.sys.mjs');
      MailServices.tags.addTagForKey('project-tag', 'Project', '#008080', '');
      const folder = MailUtils.getExistingFolder('imap://sender@127.0.0.1/Drafts');
      await new Promise((resolve, reject) => MailServices.imap.selectFolder(folder, {
        OnStartRunningUrl() {},
        OnStopRunningUrl(url, status) { if (Components.isSuccessCode(status)) resolve(); else reject(new Error(String(status))); }
      }, null));
      const header = folder.msgDatabase.getMsgHdrForMessageID('tagged-draft@example.invalid');
      MailServices.compose.OpenComposeWindow(null, header, folder.getUriForMsg(header),
        Ci.nsIMsgCompType.Draft, Ci.nsIMsgCompFormat.Default, MailServices.accounts.getIdentity('id1'), null, null);
    """)
    client.wait("""
      globalThis.taggedCompose = Services.wm.getMostRecentWindow('msgcompose');
      return taggedCompose?.composeEditorReady;
    """)
    tab_id = client.script("return testExtension.tabManager.convert(taggedCompose).id;")
    client.background(f"return {API}.compose.setComposeDetails(arguments[0], {{subject:'Tagged edited draft', plainTextBody:'Edited tagged draft contents.'}});", tab_id)
    assert client.script("return taggedCompose.gMsgCompose.savedFolderURI;") == "", "Exercise a reopened draft before its first save"
    scheduled = request(client, {"type": "schedule", "tabId": tab_id, "rule": {"startAt": int(time.time() * 1000) + 3600000}})["job"]
    client.wait("return taggedCompose.closed;")
    remaining = [m for m in imap.mailboxes["Drafts"] if b"Subject: Tagged" in m["raw"] and "\\Deleted" not in m["flags"]]
    assert len(remaining) == 1, [(m["uid"], sorted(m["flags"])) for m in remaining]
    # Older Thunderbird versions mark IMAP messages deleted without immediately
    # expunging them. Require server-side deletion and exactly one visible draft.
    assert original not in imap.mailboxes["Drafts"] or "\\Deleted" in original["flags"], "The original draft must be deleted on the server"
    visible = client.background(f"""
      const api = {API};
      const folder = await api.scheduleBridge.draftsFolder(null);
      return (await api.messages.list(folder.id)).messages.filter(m => m.subject.startsWith('Tagged')).map(m => m.subject);
    """)
    assert visible == ["Tagged edited draft"], visible
    assert {"project-tag", "scheduledsend-pending"}.issubset(remaining[0]["flags"]), remaining[0]["flags"]
    assert b"Edited tagged draft contents." in remaining[0]["raw"]
    for action, status in [("pause", "paused"), ("resume", "pending")]:
        request(client, {"type": "act", "id": scheduled["id"], "action": action})
        assert {"project-tag", f"scheduledsend-{status}"}.issubset(queued_raw(imap, scheduled["id"])["flags"])
    request(client, {"type": "edit", "id": scheduled["id"]})
    deadline = time.monotonic() + 15
    while time.monotonic() < deadline:
        state = next(j for j in request(client, {"type": "list"})["jobs"] if j["id"] == scheduled["id"])
        if state["status"] == "cancelled" and state.get("draftCleaned"):
            break
        time.sleep(.1)
    assert state.get("draftCleaned"), state
    client.async_script("""
      globalThis.editedCompose = Services.wm.getMostRecentWindow('msgcompose');
      editedCompose.document.getElementById('msgSubject').value = 'Tagged edited again';
      editedCompose.gContentChanged = true;
      await editedCompose.GenericSendMessage(Ci.nsIMsgCompDeliverMode.AutoSaveAsDraft);
    """)
    client.wait("return !editedCompose.gSaveOperationInProgress;")
    previous_jobs = {j["id"] for j in request(client, {"type": "list"})["jobs"]}
    finish_edited_draft(client, 0, "save")
    client.wait("return editedCompose.closed;", timeout=25)
    restored = next(j for j in request(client, {"type": "list"})["jobs"] if j["id"] not in previous_jobs)
    assert {"project-tag", "scheduledsend-pending"}.issubset(queued_raw(imap, restored["id"])["flags"]), queued_raw(imap, restored["id"])["flags"]
    assert restored["nextAt"] == scheduled["nextAt"]
    scheduled = restored
    request(client, {"type": "act", "id": scheduled["id"], "action": "cancel"})
    remaining = [m for m in imap.mailboxes["Drafts"] if b"Subject: Tagged" in m["raw"] and "\\Deleted" not in m["flags"]]
    assert len(remaining) == 1 and "project-tag" in remaining[0]["flags"]
    assert not any(flag.startswith("scheduledsend-") for flag in remaining[0]["flags"])
    assert len(smtp.messages) == 2
    print("PASS: scheduling an edited tagged draft replaces its source and preserves user tags through pause/resume/edit/cancel", flush=True)


def scheduled_button_test(client, imap):
    folders = client.script("""
      const { MailServices } = ChromeUtils.importESModule('resource:///modules/MailServices.sys.mjs');
      const { MailUtils } = ChromeUtils.importESModule('resource:///modules/MailUtils.sys.mjs');
      const server = MailServices.accounts.createIncomingServer('second', '127.0.0.1', 'imap');
      server.port = arguments[0];
      server.socketType = 0;
      server.authMethod = 3;
      server.prettyName = 'Second IMAP test account';
      const identity = MailServices.accounts.createIdentity();
      identity.email = 'second@example.invalid';
      if ('draftsFolderURI' in identity) identity.draftsFolderURI = server.serverURI + '/Drafts';
      else identity.draftFolder = server.serverURI + '/Drafts';
      const account = MailServices.accounts.createAccount();
      account.incomingServer = server;
      account.addIdentity(identity);
      return ['imap://sender@127.0.0.1', server.serverURI].map(uri => ({
        inbox: testExtension.folderManager.convert(MailUtils.getOrCreateFolder(uri + '/INBOX')).id,
        drafts: testExtension.folderManager.convert(MailUtils.getOrCreateFolder(uri + '/Drafts')).id,
        draftURI: uri + '/Drafts'
      }));
    """, imap.server_address[1])
    tab = client.background(f"return {API}.mailTabs.create({{displayedFolder: arguments[0]}});", folders[0]["inbox"])
    count = client.background(f"return (await {API}.mailTabs.query({{}})).length;")
    for folder in [folders[0], folders[1], folders[0]]:
        client.background(f"await {API}.mailTabs.update(arguments[0], {{displayedFolder: arguments[1]}}); await {API}.tabs.update(arguments[0], {{active: true}});", tab["id"], folder["inbox"])
        client.wait("""
          globalThis.scheduledButton = Services.wm.getMostRecentWindow('mail:3pane').document.querySelector(
            '#unifiedToolbarContent [extension="scheduled-send@thunderbird-schedule-send.local"]');
          return scheduledButton?.label?.textContent;
        """)
        assert client.script("return scheduledButton.label.textContent;") == MESSAGES["queueTitle"]["message"]
        client.script("scheduledButton.click();")
        client.wait(f"return testExtension.tabManager.get({tab['id']}).nativeTab.chromeBrowser.contentWindow.gFolder?.URI === {json.dumps(folder['draftURI'])};")
        current = client.background(f"return (await {API}.mailTabs.query({{active: true, currentWindow: true}}))[0];")
        assert current["id"] == tab["id"] and current["displayedFolder"]["id"] == folder["drafts"], current
        assert client.background(f"return (await {API}.mailTabs.query({{}})).length;") == count
    screenshot(client, "scheduled-button.png")
    print("PASS: Scheduled toolbar button opens the corresponding account Drafts in the current mail tab", flush=True)


def run_tests(client, xpi, smtp, imap):
    client.script("Services.io.offline = false;")
    # Capture native alerts across both service APIs without desktop notices.
    client.script("""
      globalThis.nativeNotifications = [];
      const alerts = {
        QueryInterface: ChromeUtils.generateQI(['nsIAlertsService']),
        showAlert(alert, listener) {
          nativeNotifications.push({name: alert.name, title: alert.title, imageURL: alert.imageURL});
          listener?.observe(null, 'alertshow', alert.name);
        },
        showAlertNotification(imageURL, title, text, clickable, cookie, listener, name) {
          this.showAlert({imageURL, title, name}, listener);
        },
        closeAlert() {}
      };
      globalThis.alertFactory = {
        QueryInterface: ChromeUtils.generateQI(['nsIFactory']),
        createInstance(iid) { return alerts.QueryInterface(iid); }
      };
      Components.manager.QueryInterface(Ci.nsIComponentRegistrar).registerFactory(
        Components.ID('{ecff5129-7782-4d23-8c59-63dc14ac6063}'), 'Test alerts', '@mozilla.org/alerts-service;1', alertFactory);
    """)
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
    theme_tests(client, screenshot)

    tab = create_compose(client)
    client.wait("return testCompose.document.getElementById('blockedContentOptions').value;")
    blocked = client.page(QUEUE, f"return {API}.runtime.sendMessage(arguments[0]);", {"type": "schedule", "tabId": tab["id"], "rule": {"startAt": int(time.time() * 1000) + 3600000}})
    assert blocked.get("error") == "errorBlockedContent", blocked
    assert client.script("return !testCompose.gWindowLocked;")
    client.script("testCompose.onUnblockResource(arguments[0], testCompose.document.getElementById('blockedContentOptions'));", client.inline_image.as_uri())
    print("PASS: native blocked-resource protection is respected before capturing a message", flush=True)
    client.script("Services.prefs.setStringPref('mail.identity.id1.draft_folder', 'mailbox://nobody@Local%20Folders/Drafts');")
    local = client.page(QUEUE, f"return {API}.runtime.sendMessage(arguments[0]);", {"type": "schedule", "tabId": tab["id"], "rule": {"startAt": int(time.time() * 1000) + 3600000}})
    assert local.get("error") == "errorServerDrafts", local
    assert client.script("return !testCompose.closed && !testCompose.gWindowLocked;")
    client.script("Services.prefs.setStringPref('mail.identity.id1.draft_folder', 'imap://sender@127.0.0.1/Drafts');")
    assert not imap.mailboxes["Drafts"]
    print("PASS: local Drafts is rejected without closing or changing the composition", flush=True)
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
    end = time.monotonic() + 25
    saved = []
    while time.monotonic() < end:
        saved = request(client, {"type": "list"})["jobs"]
        if saved:
            break
        time.sleep(.1)
    if len(saved) != 1:
        print("Compose:", client.script("return {locked: testCompose.gWindowLocked, save: testCompose.gSaveOperationInProgress, send: testCompose.gSendOperationInProgress};"), flush=True)
        print("Popup:", client.page(POPUP, "return {error: document.getElementById('error').textContent, disabled: document.getElementById('submit').disabled, label: document.getElementById('submit').textContent, validity: [...document.querySelectorAll('input')].map(i => ({id: i.id, value: i.value, disabled: i.disabled, valid: i.validity.valid}))};"), flush=True)
    assert len(saved) == 1, saved
    job = saved[0]
    assert job["status"] == "pending" and job["attachmentCount"] == 1, job
    assert client.background(f"return {API}.browserAction.getBadgeText({{}});") == "1"
    client.wait("return testCompose.closed;")
    assert modify_jobs(client, "return !(await store.payload((await store.all())[0].id));")
    assert job["draft"]["folderURI"].startswith("imap:"), job
    client.inline_image.unlink()
    assert not smtp.messages
    print("PASS: native adjacent button, translated popup, presets, constraints, durable snapshot and compose close", flush=True)

    # The queue contains actual readable RFC822 messages, independent of the UI.
    native = client.background(f"""
      const api = {API};
      const folder = await api.scheduleBridge.draftsFolder(null);
      const messages = (await api.messages.list(folder.id)).messages;
      const raw = await api.messages.getRaw(messages[0].id);
      return {{folder, messages, raw: typeof raw === 'string' ? raw : await raw.text(),
        options: api.runtime.getManifest().options_ui || null}};
    """)
    assert native["folder"]["name"] == "Drafts", native
    assert len(native["messages"]) == 1 and native["options"] is None
    assert queued_raw(imap, job["id"]), "Draft must exist on the server"
    queued_mail = BytesParser(policy=email.policy.default).parsebytes(native["raw"].encode())
    assert queued_mail["Subject"] == job["subject"]
    assert "hidden@example.invalid" in str(queued_mail["Bcc"])
    assert any(p.get_filename() == "fixture.txt" for p in queued_mail.walk())
    assert "scheduledsend-pending" in native["messages"][0]["tags"]
    request(client, {"type": "queue"})
    request(client, {"type": "queue"})
    assert client.background(f"return (await {API}.mailTabs.query({{}})).filter(t => t.displayedFolder?.id === arguments[0]).length;", native["folder"]["id"]) == 1
    print("PASS: server Drafts, synchronized MIME, status highlighting and native navigation", flush=True)

    # A user-created copy in another folder is ordinary mail, even with the
    # same Message-ID. Its controls/deletion must not affect the real schedule.
    copied_folder = client.async_script("""
      const { MailServices } = ChromeUtils.importESModule('resource:///modules/MailServices.sys.mjs');
      const { MailUtils } = ChromeUtils.importESModule('resource:///modules/MailUtils.sys.mjs');
      const source = MailUtils.getExistingFolder(arguments[0]);
      const destination = MailServices.accounts.localFoldersServer.rootFolder.getChildNamed('Sent');
      const header = source.msgDatabase.getMsgHdrForMessageID(arguments[1]);
      await new Promise((resolve, reject) => MailServices.copy.copyMessages(source, [header], destination, false, {
        onStartCopy() {}, onProgress() {}, setMessageKey() {}, getMessageId() {return '';},
        onStopCopy(status) { if (Components.isSuccessCode(status)) resolve(); else reject(new Error(String(status))); }
      }, null, false));
      return testExtension.folderManager.convert(destination);
    """, job["draft"]["folderURI"], job["draft"]["messageId"])
    assert client.background(f"""
      const message = (await {API}.messages.list(arguments[0])).messages[0];
      return await {API}.scheduleBridge.queuedId(message.id);
    """, copied_folder["id"]) is None
    client.script("""
      const { MailServices } = ChromeUtils.importESModule('resource:///modules/MailServices.sys.mjs');
      const folder = MailServices.accounts.localFoldersServer.rootFolder.getChildNamed('Sent');
      folder.deleteMessages([...folder.messages], null, true, false, null, false);
    """)
    assert request(client, {"type": "list"})["jobs"][0]["status"] == "pending"
    assert queued_raw(imap, job["id"])
    print("PASS: unrelated copies cannot control or cancel the scheduled server draft", flush=True)

    # Migrate a schedule from the initial private-payload implementation.
    legacy_id = modify_jobs(client, f"""
      const original = await store.get({json.dumps(job['id'])});
      const legacy = {{...original, id: crypto.randomUUID(), subject: 'Legacy migration fixture'}};
      delete legacy.draft; delete legacy.owner;
      await store.create(legacy, {{details: {{identityId: 'id1', subject: legacy.subject,
        to: ['receiver@example.invalid'], isPlainText: true, plainTextBody: 'Legacy saved content'}},
        native: {{from: 'sender@example.invalid', to: 'receiver@example.invalid'}}, attachments: []}});
      return legacy.id;
    """)
    # A real add-on shutdown/restart retains the journal and migrates old bytes.
    client.async_script("""
      const { AddonManager } = ChromeUtils.importESModule('resource://gre/modules/AddonManager.sys.mjs');
      const addon = await AddonManager.getAddonByID(arguments[0]);
      await addon.reload();
    """, ADDON)
    set_extension(client)
    migrated = queue(client)["jobs"]
    assert {j["id"] for j in migrated} == {job["id"], legacy_id}
    assert all(j["draft"]["folderURI"].startswith("imap:") for j in migrated)
    assert modify_jobs(client, "return !(await store.payload((await store.all())[0].id));")
    assert client.background(f"return (await {API}.messages.list((await {API}.scheduleBridge.draftsFolder(null)).id)).messages.length;") == 2
    request(client, {"type": "act", "id": legacy_id, "action": "cancel"})
    assert not queued_raw(imap, legacy_id)
    assert any(b'Legacy saved content' in m['raw'] and b'X-Scheduled-Send:' not in m['raw'] for m in imap.mailboxes['Drafts'])
    request(client, {"type": "act", "id": legacy_id, "action": "remove"})
    print("PASS: restart durability and idempotent migration of existing schedules", flush=True)

    request(client, {"type": "act", "id": job["id"], "action": "pause"})
    assert request(client, {"type": "list"})["jobs"][0]["status"] == "paused"
    request(client, {"type": "act", "id": job["id"], "action": "resume"})
    client.script("Services.io.offline = true;")
    server_draft = queued_raw(imap, job["id"])
    assert b"scheduled world" in server_draft["raw"]
    imap.replace(server_draft["uid"], server_draft["raw"].replace(b"scheduled world", b"edited on another client"))
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
    assert "edited on another client" in html and "café" in html, html
    references = set(re.findall(r'cid:([^"\s>]+)', html))
    content_ids = {part["Content-ID"].strip("<>") for part in message.walk() if part["Content-ID"]}
    assert references and references.issubset(content_ids), (references, content_ids)
    assert any(part.get_content_type() == "multipart/related" for part in message.walk())
    attachments = [part for part in message.walk() if part.get_filename() == "fixture.txt"]
    assert len(attachments) == 1 and "Café" in attachments[0].get_payload(decode=True).decode(), attachments
    assert any(part.get_content_type() == "image/gif" for part in message.walk()), [part.get_content_type() for part in message.walk()]
    assert modify_jobs(client, "return (await store.payload((await store.all())[0].id)) === undefined;")
    assert message["X-Scheduled-Send"] is None
    print("PASS: external IMAP draft edits reach SMTP; offline wait, HTML, attachments, inline images, reply headers and Bcc privacy", flush=True)

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

    tagged_draft_test(client, imap, smtp)

    # Exercise actual queue controls and a recurring schedule without sending it.
    tab = create_compose(client, "Recurring check", attachment=False)
    rule = {"startAt": int(time.time() * 1000) + 3600000, "recurrence": {"unit": "monthly", "interval": 1}, "weekdays": [1, 2, 3, 4, 5], "window": {"start": "01:00", "end": "05:00"}}
    recurring = request(client, {"type": "schedule", "tabId": tab["id"], "rule": rule})["job"]
    request(client, {"type": "queue"})
    selected = client.background(f"""
      const api = {API};
      const folder = await api.scheduleBridge.draftsFolder(null);
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
    wait_ui(client, MANAGE, "!document.getElementById('edit-dialog').open && !document.querySelector('button[data-action=pause]')?.disabled")
    edited = next(j for j in request(client, {"type": "list"})["jobs"] if j["id"] == recurring["id"])
    assert edited["rule"]["recurrence"]["unit"] == "yearly", edited
    client.page(MANAGE, "document.querySelector('button[data-action=\"pause\"]').click();")
    wait_ui(client, MANAGE, "document.querySelector('button[data-action=resume]') && !document.querySelector('button[data-action=resume]').disabled")
    client.page(MANAGE, "document.querySelector('button[data-action=\"resume\"]').click();")
    wait_ui(client, MANAGE, "document.querySelector('button[data-action=pause]') && !document.querySelector('button[data-action=pause]').disabled")
    request(client, {"type": "edit", "id": recurring["id"]})
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        state = next(j for j in request(client, {"type": "list"})["jobs"] if j["id"] == recurring["id"])
        if state["status"] == "cancelled" and state.get("draftCleaned"):
            break
        time.sleep(.1)
    assert state["status"] == "cancelled" and state.get("draftCleaned"), state
    assert not queued_raw(imap, recurring["id"])
    ordinary = [BytesParser(policy=email.policy.default).parsebytes(m["raw"]) for m in imap.mailboxes["Drafts"] if b"Subject: Recurring check" in m["raw"] and "\\Deleted" not in m["flags"]]
    assert len(ordinary) == 1 and ordinary[0]["X-Scheduled-Send"] is None
    assert "scheduled world" in ordinary[0].get_body(preferencelist=("html",)).get_content()
    assert any(p.get_content_type() == "image/gif" for p in ordinary[0].walk())
    client.async_script("""
      globalThis.editedCompose = Services.wm.getMostRecentWindow('msgcompose');
      editedCompose.document.getElementById('msgSubject').value = 'Edited recurring check';
      editedCompose.gContentChanged = true;
      await editedCompose.GenericSendMessage(Ci.nsIMsgCompDeliverMode.AutoSaveAsDraft);
    """)
    client.wait("return !editedCompose.gSaveOperationInProgress;")
    assert client.script("return ![...Services.wm.getEnumerator(null)].some(w => w.document.documentURI.includes('commonDialog'));")
    assert not queued_raw(imap, recurring["id"])
    assert len(smtp.messages) == 2
    finish_edited_draft(client, 1)
    assert client.script("return !editedCompose.closed;")
    assert not queued_raw(imap, recurring["id"])
    previous_jobs = {j["id"] for j in request(client, {"type": "list"})["jobs"]}
    finish_edited_draft(client, 0, "save")
    client.wait("return editedCompose.closed;", timeout=25)
    restored = next(j for j in request(client, {"type": "list"})["jobs"] if j["id"] not in previous_jobs)
    assert restored["status"] == "pending" and restored["subject"] == "Edited recurring check", restored
    assert restored["rule"] == edited["rule"] and restored["nextAt"] == edited["nextAt"]
    assert queued_raw(imap, restored["id"])
    # Open directly through Thunderbird as a normal Drafts double-click does.
    client.script("""
      const { MailServices } = ChromeUtils.importESModule('resource:///modules/MailServices.sys.mjs');
      const { MailUtils } = ChromeUtils.importESModule('resource:///modules/MailUtils.sys.mjs');
      const folder = MailUtils.getExistingFolder(arguments[0]);
      const header = folder.msgDatabase.getMsgHdrForMessageID(arguments[1]);
      MailServices.compose.OpenComposeWindow(null, header, folder.getUriForMsg(header),
        Ci.nsIMsgCompType.Draft, Ci.nsIMsgCompFormat.Default, MailServices.accounts.getIdentity('id1'), null, null);
    """, restored["draft"]["folderURI"], restored["draft"]["messageId"])
    deadline = time.monotonic() + 15
    while time.monotonic() < deadline:
        state = next(j for j in request(client, {"type": "list"})["jobs"] if j["id"] == restored["id"])
        if state["status"] == "cancelled" and state.get("draftCleaned"):
            break
        time.sleep(.1)
    finish_edited_draft(client, 2)
    client.wait("return editedCompose.closed;", timeout=25)
    assert not queued_raw(imap, restored["id"])
    assert any(b'Subject: Edited recurring check' in m['raw'] and b'X-Scheduled-Send:' not in m['raw'] for m in imap.mailboxes['Drafts'])
    assert len(smtp.messages) == 2
    client.script("Services.wm.getMostRecentWindow('mail:3pane').focus();")
    print("PASS: native save/close prompt, continue editing, restore schedule with edits, and save without a schedule", flush=True)

    # Other mail clients may discard custom headers. Never send a stale local
    # copy, nor claim a draft carrying another profile's scheduling identity.
    for external_change in ["removed metadata", "foreign owner"]:
        tab = create_compose(client, f"External {external_change}", attachment=False)
        external = request(client, {"type": "schedule", "tabId": tab["id"], "rule": {"startAt": int(time.time() * 1000) + 3600000}})["job"]
        client.script("Services.io.offline = true;")
        original = queued_raw(imap, external["id"])
        pattern = br"^X-Scheduled-Send:[^\r\n]*(?:\r\n[ \t][^\r\n]*)*\r\n"
        header = re.search(pattern, original["raw"], re.M)[0]
        replacement = b""
        if external_change == "foreign owner":
            metadata = json.loads(unquote(re.sub(br"\s", b"", header.split(b":", 1)[1]).decode()))
            metadata["owner"] = "another-thunderbird-profile"
            replacement = b"X-Scheduled-Send: " + quote(json.dumps(metadata, separators=(",", ":"))).encode() + b"\r\n"
        raw = original["raw"].replace(header, replacement)
        edited_draft = imap.replace(original["uid"], raw)
        modify_jobs(client, f"const job = await store.get({json.dumps(external['id'])}); job.nextAt = Date.now() - 1000; await store.put(job);")
        client.script("Services.io.offline = false;")
        client.background(f"return {API}.alarms.create('next-send', {{when: Date.now() + 100}});")
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            state = next(j for j in request(client, {"type": "list"})["jobs"] if j["id"] == external["id"])
            if state["status"] == "cancelled" and state.get("draftCleaned"):
                break
            time.sleep(.1)
        assert state["status"] == "cancelled", state
        assert edited_draft in imap.mailboxes["Drafts"] and edited_draft["raw"] == raw
        assert len(smtp.messages) == 2
    print("PASS: discarded schedule headers and foreign ownership prevent delivery without changing the server draft", flush=True)

    # Native actions must cancel without relying on the custom controls or
    # waiting for the next send alarm.
    for action in ["delete", "move"]:
        tab = create_compose(client, f"Native {action} fixture", attachment=False)
        removed = request(client, {"type": "schedule", "tabId": tab["id"], "rule": {"startAt": int(time.time() * 1000) + 3600000}})["job"]
        if action == "move":
            request(client, {"type": "act", "id": removed["id"], "action": "pause"})
            removed = next(j for j in request(client, {"type": "list"})["jobs"] if j["id"] == removed["id"])
        client.async_script("""
          const { MailServices } = ChromeUtils.importESModule('resource:///modules/MailServices.sys.mjs');
          const { MailUtils } = ChromeUtils.importESModule('resource:///modules/MailUtils.sys.mjs');
          const folder = MailUtils.getExistingFolder(arguments[0]);
          const header = folder.msgDatabase.getMsgHdrForMessageID(arguments[1]);
          const root = MailServices.accounts.localFoldersServer.rootFolder;
          await new Promise((resolve, reject) => {
            const listener = {
              onStartCopy() {}, onProgress() {}, setMessageKey() {}, getMessageId() {return '';},
              onStopCopy(status) { if (Components.isSuccessCode(status)) resolve(); else reject(new Error(String(status))); }
            };
            if (arguments[2] === 'move') MailServices.copy.copyMessages(folder, [header], root.getChildNamed('Sent'), true, listener, null, false);
            else folder.deleteMessages([header], null, false, false, listener, false);
          });
        """, removed["draft"]["folderURI"], removed["draft"]["messageId"], action)
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
    print("PASS: native IMAP delete and move cancel pending/paused drafts", flush=True)

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

    client.wait(f"return nativeNotifications.some(n => n.name === 'review-{interrupted['id']}');")
    notification = client.script("return nativeNotifications.find(n => n.name === arguments[0]);", f"review-{interrupted['id']}")
    app_icon = client.background(f"return {API}.scheduleBridge.notificationIcon();")
    assert notification["imageURL"] == app_icon and notification["title"] == MESSAGES["queueTitle"]["message"], notification
    icon_bytes = base64.b64decode(app_icon.split(",", 1)[1])
    assert icon_bytes.startswith(b"\x89PNG\r\n\x1a\n") and int.from_bytes(icon_bytes[16:20], "big") == 64
    assert client.async_script("""
      const image = new (Services.wm.getMostRecentWindow('mail:3pane').Image)();
      image.src = arguments[0];
      await image.decode();
      return [image.naturalWidth, image.naturalHeight];
    """, app_icon) == [64, 64]
    print("PASS: scheduled-message notifications decode and display Thunderbird's application icon", flush=True)

    scheduled_button_test(client, imap)

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
        raise SystemExit("Install Thunderbird 128+ and Xvfb to run the native integration tests.")
    RESULTS.mkdir(parents=True, exist_ok=True)
    subprocess.run([sys.executable, str(ROOT / "scripts/package.py")], check=True)
    version = json.loads((ROOT / "extension/manifest.json").read_text())["version"]
    xpi = ROOT / "dist" / f"thunderbird-scheduled-send-{version}.xpi"
    with IMAPServer() as imap, SMTPServer(("127.0.0.1", 0), SMTPHandler) as smtp, tempfile.TemporaryDirectory(prefix="scheduled-send-test-") as temporary:
        smtp.messages = []
        thread = threading.Thread(target=smtp.serve_forever, daemon=True)
        thread.start()
        threading.Thread(target=imap.serve_forever, daemon=True).start()
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
            "mail.accountmanager.accounts": "account2,account1", "mail.accountmanager.defaultaccount": "account2",
            "mail.account.account2.server": "server2", "mail.account.account2.identities": "id1",
            "mail.server.server2.type": "imap", "mail.server.server2.hostname": "127.0.0.1",
            "mail.server.server2.name": "IMAP Test Account", "mail.server.server2.userName": "sender",
            "mail.server.server2.port": imap.server_address[1], "mail.server.server2.socketType": 0,
            "mail.server.server2.authMethod": 3, "mail.server.server2.login_at_startup": False,
            "mail.server.server2.check_new_mail": False, "mail.server.server2.delete_model": 1,
            "mail.imap.mime_parts_on_demand": False,
            "mail.accountmanager.localfoldersserver": "server1", "mail.account.account1.server": "server1",
            "mail.account.account1.identities": "", "mail.server.server1.type": "none",
            "mail.server.server1.hostname": "Local Folders", "mail.server.server1.name": "Local Folders",
            "mail.server.server1.userName": "nobody", "mail.server.server1.directory": str(profile / "Mail" / "Local Folders"),
            "mail.identity.id1.fullName": "Scheduled Send Test", "mail.identity.id1.useremail": "sender@example.invalid",
            "mail.identity.id1.compose_html": True, "mail.identity.id1.fcc": True,
            "mail.identity.id1.fcc_folder": "mailbox://nobody@Local%20Folders/Sent",
            "mail.identity.id1.draft_folder": "imap://sender@127.0.0.1/Drafts",
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
                run_tests(client, xpi, smtp, imap)
            except Exception:
                print("IMAP errors:", imap.errors, "Recent commands:", imap.commands[-30:], flush=True)
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
                imap.shutdown()
                (RESULTS / 'imap.log').write_text('\n'.join(imap.commands))


if __name__ == "__main__":
    main()
