import test from "node:test";
import assert from "node:assert/strict";
import { Scheduler } from "../extension/lib/engine.mjs";
import { localZone } from "../extension/lib/schedule.mjs";

class MemoryStore {
  jobs = new Map();
  payloads = new Map();
  async all() { return [...this.jobs.values()].map(j => structuredClone(j)); }
  async get(id) { return structuredClone(this.jobs.get(id)); }
  async payload(id) { return structuredClone(this.payloads.get(id)); }
  async put(job) { this.jobs.set(job.id, structuredClone(job)); }
  async create(job, payload) { await this.put(job); this.payloads.set(job.id, structuredClone(payload)); }
  async finish(job) { await this.put(job); this.payloads.delete(job.id); }
  async remove(id) { this.jobs.delete(id); this.payloads.delete(id); }
}
const payload = { details: { subject: "hello", to: ["friend@example.invalid"], from: "me@example.invalid" }, attachments: [{ name: "test.txt", file: new Blob(["retained attachment"]) }] };
function fixture(deliver) {
  const store = new MemoryStore();
  let now = new Date("2026-10-24T12:00:00Z").getTime();
  let online = true;
  const sent = [];
  const scheduler = new Scheduler({ store, clock: () => now, online: async () => online, deliver: deliver || (async message => { sent.push(message); }) });
  return { store, scheduler, sent, setOnline: value => online = value, advance: ms => now += ms,
    create: (extra = {}) => scheduler.create({ startAt: now + 60000, ...extra }, payload) };
}

test("restoring an edited draft keeps its time and recurrence but uses edited content", async () => {
  const f = fixture();
  const previous = await f.create({ recurrence: { unit: "monthly", interval: 2 } });
  await f.scheduler.cancelRemoved([previous.id]);
  const edited = { ...payload, details: { ...payload.details, subject: "edited", to: ["new@example.invalid"] } };
  const restored = await f.scheduler.restoreEdited(previous, edited);
  assert.notEqual(restored.id, previous.id);
  assert.deepEqual(restored.rule, previous.rule);
  assert.equal(restored.nextAt, previous.nextAt);
  assert.equal(restored.occurrence, previous.occurrence);
  assert.equal(restored.subject, "edited");
  f.advance(60000);
  await f.scheduler.tick();
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].details.subject, "edited");
  assert.equal((await f.store.get(previous.id)).status, "cancelled");
});

test("restoring an edited draft never resumes a paused or uncertain send automatically", async () => {
  for (const status of ["paused", "review"]) {
    const f = fixture();
    const previous = { ...await f.create(), status, sentCount: 3, occurrence: 3, error: status === "review" ? "errorInterrupted" : null };
    await f.store.put(previous);
    await f.scheduler.cancelRemoved([previous.id]);
    f.advance(120000);
    const restored = await f.scheduler.restoreEdited(previous, payload);
    assert.equal(restored.status, status);
    assert.equal(restored.sentCount, 3);
    assert.equal(restored.occurrence, 3);
    assert.equal(restored.error, previous.error);
    await f.scheduler.tick();
    assert.equal(f.sent.length, 0);
  }
});

test("restoring a late edited draft applies its delivery window and rejects timezone changes", async () => {
  const f = fixture();
  const previous = await f.create({ window: { start: "01:00", end: "02:00" } });
  await f.scheduler.cancelRemoved([previous.id]);
  f.advance(48 * 3600000);
  const restored = await f.scheduler.restoreEdited(previous, payload);
  assert(restored.nextAt > previous.nextAt);
  assert.equal(new Date(restored.nextAt).getHours(), 1);
  f.scheduler.zone = () => "different/timezone";
  await assert.rejects(f.scheduler.restoreEdited(previous, payload), { code: "errorTimeZone" });
});

test("snapshot survives a new scheduler, sends once, then releases message bytes", async () => {
  const f = fixture();
  const job = await f.create();
  assert.equal(await (await f.store.payload(job.id)).attachments[0].file.text(), "retained attachment");
  await f.scheduler.tick();
  assert.equal(f.sent.length, 0);
  f.advance(60000);
  await Promise.all([f.scheduler.tick(), f.scheduler.tick(), f.scheduler.tick()]);
  assert.equal(f.sent.length, 1);
  assert.equal((await f.store.get(job.id)).status, "sent");
  assert.equal(await f.store.payload(job.id), undefined);
});

test("offline delivery stays pending and waits for reconnection", async () => {
  const f = fixture();
  const job = await f.create();
  f.setOnline(false); f.advance(300000);
  await f.scheduler.tick();
  assert.equal(f.sent.length, 0);
  assert.equal((await f.store.get(job.id)).status, "pending");
  f.setOnline(true);
  await f.scheduler.tick();
  assert.equal(f.sent.length, 1);
});

test("deleting or moving a queued message cancels even while offline or paused", async () => {
  for (const status of ["pending", "paused", "review"]) {
    const f = fixture();
    const job = await f.create();
    await f.store.put({ ...job, status });
    f.scheduler.isPresent = async () => false;
    f.setOnline(false);
    await f.scheduler.tick();
    assert.equal((await f.store.get(job.id)).status, "cancelled");
    assert.equal(await f.store.payload(job.id), undefined);
    f.setOnline(true); f.advance(60000);
    await f.scheduler.tick();
    assert.equal(f.sent.length, 0);
  }
});

test("removing a message during preparation prevents transport", async () => {
  const f = fixture();
  const job = await f.create(); f.advance(60000);
  let checks = 0;
  f.scheduler.isPresent = async () => ++checks === 1;
  await f.scheduler.tick();
  assert.equal((await f.store.get(job.id)).status, "cancelled");
  assert.equal(f.sent.length, 0);
});

test("native pre-transport cancellation removes the payload without a retry", async () => {
  const f = fixture(async () => { const error = new Error("removed"); error.code = "errorQueueRemoved"; throw error; });
  const job = await f.create(); f.advance(60000);
  await f.scheduler.tick();
  assert.equal((await f.store.get(job.id)).status, "cancelled");
  assert.equal(await f.store.payload(job.id), undefined);
});

test("undoing a native deletion cannot reactivate its captured schedule", async () => {
  const f = fixture();
  const job = await f.create();
  // The message is already back in the folder by the time its event is handled.
  f.scheduler.isPresent = async () => true;
  await f.scheduler.cancelRemoved([job.id, job.id]);
  f.advance(60000);
  await f.scheduler.tick();
  assert.equal((await f.store.get(job.id)).status, "cancelled");
  assert.equal(await f.store.payload(job.id), undefined);
  assert.equal(f.sent.length, 0);
});

test("a removal event takes effect before a running tick sends its next message", async () => {
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  let sends = 0;
  const f = fixture(async () => { sends++; entered.resolve(); await release.promise; });
  await f.create();
  const second = await f.create();
  f.advance(60000);
  const tick = f.scheduler.tick();
  await entered.promise;
  const cancellation = f.scheduler.cancelRemoved([second.id]);
  release.resolve();
  await Promise.all([tick, cancellation]);
  assert.equal(sends, 1);
  assert.equal((await f.store.get(second.id)).status, "cancelled");
});

test("missing queued copies cannot be resumed; folder errors cannot cause a send", async () => {
  const f = fixture();
  const job = await f.create();
  await f.scheduler.act(job.id, "pause");
  f.scheduler.isPresent = async () => false;
  await assert.rejects(f.scheduler.act(job.id, "resume"), /errorQueueRemoved/);
  assert.equal((await f.store.get(job.id)).status, "cancelled");
  const next = await f.create();
  f.scheduler.isPresent = async () => { throw new Error("Folder unavailable"); };
  f.advance(60000);
  await assert.rejects(f.scheduler.tick(), /Folder unavailable/);
  assert.equal((await f.store.get(next.id)).status, "pending");
  assert.equal(f.sent.length, 0);
});

test("going offline immediately before transport is safely retryable", async () => {
  const f = fixture(async () => { const error = new Error("offline"); error.code = "errorOffline"; throw error; });
  const job = await f.create(); f.advance(60000);
  await f.scheduler.tick();
  assert.equal((await f.store.get(job.id)).status, "pending");
});

test("transport errors need explicit review, not automatic retries", async () => {
  let attempts = 0;
  const f = fixture(async () => { attempts++; throw new Error("SMTP connection lost"); });
  const job = await f.create(); f.advance(60000);
  await f.scheduler.tick(); await f.scheduler.tick();
  assert.equal(attempts, 1);
  assert.equal((await f.store.get(job.id)).status, "review");
  await assert.rejects(f.scheduler.act(job.id, "resume"), /errorConfirmRetry/);
  await f.scheduler.act(job.id, "resume", { acceptDuplicateRisk: true });
  await f.scheduler.tick();
  assert.equal(attempts, 2);
});

test("restart during a send marks delivery uncertain, including after SMTP acceptance", async () => {
  const f = fixture();
  const job = await f.create();
  await f.store.put({ ...job, status: "sending" });
  const restarted = new Scheduler({ store: f.store, online: async () => true, deliver: async () => assert.fail("must not retry") });
  await restarted.initialize(); await restarted.tick();
  assert.equal((await f.store.get(job.id)).status, "review");
  assert.equal((await f.store.get(job.id)).error, "errorInterrupted");
});

test("recurrences send once after a long absence and move ahead", async () => {
  const f = fixture();
  const job = await f.create({ recurrence: { unit: "minutes", interval: 5 } });
  f.advance(3 * 86400000);
  await f.scheduler.tick(); await f.scheduler.tick();
  assert.equal(f.sent.length, 1);
  const updated = await f.store.get(job.id);
  assert.equal(updated.status, "pending");
  assert.equal(updated.sentCount, 1);
  assert(updated.nextAt > updated.lastSentAt);
  assert(await f.store.payload(job.id));
});

test("pause, resume, reschedule, cancel and history deletion", async () => {
  const f = fixture();
  const job = await f.create();
  await f.scheduler.act(job.id, "pause"); f.advance(60000);
  await f.scheduler.tick(); assert.equal(f.sent.length, 0);
  await f.scheduler.act(job.id, "resume");
  const newStart = job.rule.startAt + 3600000;
  await f.scheduler.act(job.id, "reschedule", { rule: { startAt: newStart } });
  assert.equal((await f.store.get(job.id)).nextAt, newStart);
  await f.scheduler.act(job.id, "cancel");
  assert.equal((await f.store.get(job.id)).status, "cancelled");
  assert.equal(await f.store.payload(job.id), undefined);
  f.advance(7200000); await f.scheduler.tick(); assert.equal(f.sent.length, 0);
  await f.scheduler.act(job.id, "remove"); assert.equal(await f.store.get(job.id), undefined);
});

test("missing payload is reviewable and cannot silently disappear", async () => {
  const f = fixture();
  const job = await f.create();
  f.store.payloads.delete(job.id); f.advance(60000);
  await f.scheduler.tick();
  assert.equal((await f.store.get(job.id)).error, "errorMissingMessage");
  assert.equal(f.sent.length, 0);
});

test("system timezone changes pause schedules", async () => {
  const f = fixture();
  const job = await f.create();
  f.scheduler.zone = () => localZone() === "UTC" ? "Europe/Paris" : "UTC";
  await f.scheduler.tick();
  assert.equal((await f.store.get(job.id)).status, "paused");
  await assert.rejects(f.scheduler.act(job.id, "resume"), /errorTimeZone/);
});

test("late delivery is moved into its allowed window", async () => {
  process.env.TZ = "UTC";
  const f = fixture();
  const job = await f.create({ window: { start: "12:00", end: "13:00" } });
  f.advance(2 * 3600000);
  await f.scheduler.tick();
  assert.equal(f.sent.length, 0);
  assert.equal(new Date((await f.store.get(job.id)).nextAt).toISOString(), "2026-10-25T12:00:00.000Z");
});

test("a sent-copy failure records success without resending", async () => {
  let attempts = 0;
  const f = fixture(async () => { attempts++; return { warning: "errorSentCopy" }; });
  const job = await f.create(); f.advance(60000);
  await f.scheduler.tick(); await f.scheduler.tick();
  const final = await f.store.get(job.id);
  assert.equal(final.status, "sent"); assert.equal(final.error, "errorSentCopy"); assert.equal(attempts, 1);
});

test("sending marker is durable before the transport is invoked", async () => {
  let job;
  const f = fixture(async () => assert.equal((await f.store.get(job.id)).status, "sending"));
  job = await f.create(); f.advance(60000);
  await f.scheduler.tick();
});
