import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { setImmediate } from "node:timers/promises";
import vm from "node:vm";

function fixture() {
  const files = new Set();
  const started = Promise.withResolvers();
  const nativeResult = Promise.withResolvers();
  const identity = { key: "id1", email: "sender@example.invalid", fccFolder: "imap://sender/Sent" };
  let nativeFailures = 0;
  class MessageSend {
    sendMessageFile(identity, account, fields, file, remove, digest, mode, replace, listener) {
      started.resolve({ sender: this, fields, file, listener });
      return nativeResult.promise;
    }
    fail() { nativeFailures++; }
  }
  const scope = vm.createContext({
    MessageSend, ExtensionError: Error,
    MailServices: { accounts: { getIdentity: () => identity, accounts: [{ key: "account1", identities: [identity] }] } },
    Cc: {
      "@mozilla.org/supports-interface-pointer;1": { createInstance: () => ({}) },
      "@mozilla.org/messengercompose/composefields;1": {
        createInstance: () => ({ setRawHeader(name, value) { this[name] = value; } })
      },
      "@mozilla.org/messengercompose/computils;1": { createInstance: () => ({ msgGenerateMessageId: () => "<fresh@invalid>" }) }
    },
    Ci: { nsIMsgSend: { nsMsgDeliverNow: 0 } },
    ChromeUtils: { generateQI: () => function() { return this; } },
    Components: { isSuccessCode: status => status === 0 },
    Services: { io: { offline: false }, uuid: { generateUUID: () => "fixture" } },
    PathUtils: { tempDir: "/tmp", join: (...parts) => parts.join("/") },
    IOUtils: { write: async path => files.add(path), remove: async path => files.delete(path) },
    fileAt: path => path, console
  });
  for (const file of ["draft-mime.js", "drafts.js"]) {
    vm.runInContext(readFileSync(new URL(`../extension/experiments/scheduleBridge/${file}`, import.meta.url), "utf8"), scope);
  }
  const mailbox = new scope.DraftMailbox({});
  mailbox.read = async () => ({ raw: "From: sender@example.invalid\r\nTo: recipient@example.invalid\r\nSubject: Test\r\n\r\nBody" });
  mailbox.header = () => ({});
  const delivery = mailbox.deliver({ id: "job", identityId: "id1" });
  return { files, started: started.promise, nativeResult, delivery, nativeFailures: () => nativeFailures };
}

test("SMTP completion on Thunderbird 128 keeps the message until its Sent copy finishes", async () => {
  const f = fixture();
  const { listener, fields, file } = await f.started;
  assert.equal(fields.fcc, "imap://sender/Sent");
  listener.onStopSending("fresh@invalid", 0);
  f.nativeResult.resolve();
  let finished = false;
  f.delivery.then(() => { finished = true; });
  await setImmediate();
  assert.equal(finished, false);
  assert(f.files.has(file), "Sent-folder copy still needs the source message");
  listener.onStopCopy(0);
  assert.equal((await f.delivery).messageId, "<fresh@invalid>");
  assert.equal(f.files.size, 0);
});

test("native copy failures after SMTP return a warning without retrying delivery", async () => {
  for (const failure of ["legacy", "listener", "promise"]) {
    const f = fixture();
    const { sender, listener } = await f.started;
    listener.onStopSending("fresh@invalid", 0);
    if (failure === "promise") f.nativeResult.reject(new Error("copy failed"));
    else {
      f.nativeResult.resolve();
      // Thunderbird 128 uses fail(NS_OK) after declining a failed copy retry.
      if (failure === "legacy") sender.fail(0, null);
      else listener.onStopCopy(1);
    }
    assert.equal((await f.delivery).warning, "errorSentCopy", failure);
    assert.equal(f.files.size, 0, failure);
    if (failure === "legacy") assert.equal(f.nativeFailures(), 1, "native cleanup must still run");
  }
});

test("SMTP failure and cancellation never count as successful delivery", async () => {
  for (const callback of ["onStopSending", "onSendNotPerformed"]) {
    const f = fixture();
    const { listener } = await f.started;
    listener[callback](null, 1);
    f.nativeResult.resolve();
    await assert.rejects(f.delivery, { message: "errorDelivery" });
    assert.equal(f.files.size, 0);
  }
});
