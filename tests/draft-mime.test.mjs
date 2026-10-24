import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const scope = vm.createContext({});
vm.runInContext(readFileSync(new URL("../extension/experiments/scheduleBridge/draft-mime.js", import.meta.url), "utf8"), scope);
const mime = scope.DraftMime;
const raw = "From: sender@example.invalid\r\nTo: receiver@example.invalid\r\nBcc: hidden@example.invalid\r\n\t, other@example.invalid\r\nSubject: =?UTF-8?Q?caf=C3=A9?=\r\nMessage-ID: <original@example.invalid>\r\nDate: Fri, 23 Oct 2026 00:00:00 GMT\r\nReferences: <parent@example.invalid>\r\nX-Mozilla-Draft-Info: internal/draft; DSN=1\r\nX-Identity-Key: id1\r\nFcc: imap://sender@host/Sent\r\nX-Custom: keep\r\nContent-Type: multipart/mixed; boundary=fixture\r\n\r\n--fixture\r\nContent-Type: application/octet-stream\r\n\r\n\x00\xffattachment bytes\r\n--fixture--\r\n";
const job = { id: "job", owner: "origin", status: "pending", nextAt: 1792857600000,
  rule: { timeZone: "Europe/Paris", recurrence: { unit: "monthly", interval: 1 }, weekdays: [1, 2, 3, 4, 5] }, occurrence: 0, sentCount: 0 };

test("schedule metadata survives folding and MIME bytes remain untouched", () => {
  const scheduled = mime.rewrite(raw, { job, messageId: "scheduled@invalid", date: job.nextAt });
  assert.deepEqual(JSON.parse(JSON.stringify(mime.schedule(scheduled))), { version: 1, ...job });
  assert.equal(mime.parse(scheduled).body, mime.parse(raw).body);
  assert.equal(mime.get(scheduled, "Bcc"), "hidden@example.invalid , other@example.invalid");
  assert(scheduled.split("\r\n").every(line => line.length < 998));
});

test("delivery strips scheduling, draft control and folded Bcc headers only", () => {
  const scheduled = mime.rewrite(raw, { job, messageId: "scheduled@invalid", date: job.nextAt });
  const sent = mime.rewrite(scheduled, { messageId: "fresh@invalid", date: Date.now(), delivery: true });
  for (const field of ["bcc", "x-scheduled-send", "x-mozilla-draft-info", "x-identity-key", "fcc"]) assert.equal(mime.get(sent, field), "");
  assert.equal(mime.get(sent, "message-id"), "<fresh@invalid>");
  assert.equal(mime.get(sent, "references"), "<parent@example.invalid>");
  assert.equal(mime.get(sent, "x-custom"), "keep");
  assert.equal(mime.parse(sent).body, mime.parse(raw).body);
});

test("cancellation leaves an editable ordinary draft, with Bcc and attachments", () => {
  const scheduled = mime.rewrite(raw, { job, messageId: "scheduled@invalid", date: job.nextAt });
  const cancelled = mime.rewrite(scheduled, { messageId: "ordinary@invalid", date: Date.now() });
  assert.equal(mime.schedule(cancelled), null);
  assert(mime.get(cancelled, "bcc").includes("hidden@"));
  assert.equal(mime.parse(cancelled).body, mime.parse(raw).body);
});

test("missing, damaged and unknown scheduling headers never activate a draft", () => {
  assert.equal(mime.schedule(raw), null);
  for (const value of ["%invalid", encodeURIComponent('{"version":2,"id":"job","owner":"origin"}')]) {
    assert.equal(mime.schedule(`X-Scheduled-Send: ${value}\r\n${raw}`), null);
  }
});
