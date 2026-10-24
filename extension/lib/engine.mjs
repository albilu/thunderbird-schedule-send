import { firstOccurrence, localZone, nextAllowed, nextOccurrence, normalizeRule, ScheduleError } from "./schedule.mjs";

export class Scheduler {
  constructor({ store, deliver, online, isPresent = async () => true, changed = async () => {}, clock = Date.now, zone = localZone }) {
    Object.assign(this, { store, deliver, online, isPresent, changed, clock, zone });
    this.tail = Promise.resolve();
    this.removedIds = new Set();
  }
  // Every mutation, including UI actions and alarms, uses one serial queue.
  serial(task) {
    const result = this.tail.then(task);
    this.tail = result.catch(() => {});
    return result;
  }
  async initialize() {
    return this.serial(async () => {
      for (const job of await this.store.all()) {
        if (job.status === "sending") {
          job.status = "review";
          job.error = "errorInterrupted";
          await this.store.put(job);
        }
      }
      await this.changed();
    });
  }
  create(input, payload) {
    return this.serial(async () => {
      const rule = normalizeRule(input, this.clock());
      const first = firstOccurrence(rule);
      const job = { id: crypto.randomUUID(), rule, nextAt: first.at, occurrence: first.index,
        status: "pending", createdAt: this.clock(), sentCount: 0,
        subject: payload.details.subject, to: payload.details.to,
        from: payload.details.from, attachmentCount: payload.attachments.length };
      await this.store.create(job, payload);
      await this.changed();
      return job;
    });
  }
  cancelRemoved(ids) {
    const removed = new Set(ids);
    // Make intent visible to an already-running tick before its next message.
    // The durable cancellation still uses the serialized mutation queue.
    for (const id of removed) this.removedIds.add(id);
    return this.serial(async () => {
      let changed = false;
      for (const id of removed) {
        const job = await this.store.get(id);
        if (!job || !["pending", "paused", "review"].includes(job.status)) continue;
        job.status = "cancelled";
        job.nextAt = null;
        await this.store.finish(job);
        changed = true;
      }
      if (changed) await this.changed();
      for (const id of removed) this.removedIds.delete(id);
    });
  }
  async present(job) {
    return !this.removedIds.has(job.id) && await this.isPresent(job);
  }
  tick() {
    return this.serial(async () => {
      const jobs = (await this.store.all()).sort((a, b) => a.nextAt - b.nextAt);
      for (const job of jobs) {
        if (["pending", "paused", "review"].includes(job.status) && !await this.present(job)) {
          job.status = "cancelled";
          job.nextAt = null;
          await this.store.finish(job);
          continue;
        }
        if (job.status !== "pending") continue;
        if (!(await this.online())) continue;
        if (job.rule.timeZone !== this.zone()) {
          job.status = "paused";
          job.error = "errorTimeZone";
          await this.store.put(job);
          continue;
        }
        const now = this.clock();
        if (job.nextAt > now) continue;
        const allowed = nextAllowed(now, job.rule);
        if (allowed > now) {
          job.nextAt = allowed;
          await this.store.put(job);
          continue;
        }
        if (!(await this.online())) break;
        const payload = await this.store.payload(job.id);
        if (!payload) {
          job.status = "review";
          job.error = "errorMissingMessage";
          await this.store.put(job);
          continue;
        }
        // Folder membership is authoritative. A move/delete during preparation
        // cancels the schedule too, before committing a transport attempt.
        if (!await this.present(job)) {
          job.status = "cancelled";
          job.nextAt = null;
          await this.store.finish(job);
          continue;
        }
        // Commit before invoking the mail transport. A crash after this point
        // is ambiguous: it must NEVER trigger an automatic retransmission.
        job.status = "sending";
        job.attemptedAt = now;
        await this.store.put(job);
        await this.changed();
        let result;
        try {
          result = await this.deliver(payload, job);
        } catch (error) {
          if (error.code === "errorQueueRemoved") {
            job.status = "cancelled";
            job.nextAt = null;
            await this.store.finish(job);
            continue;
          } else if (error.code === "errorOffline") {
            job.status = "pending";
          } else {
            job.status = "review";
            job.error = "errorDelivery";
            job.detail = String(error.message || error).slice(0, 600);
          }
          await this.store.put(job);
          continue;
        }
        job.sentCount++;
        job.lastSentAt = this.clock();
        job.error = result?.warning || null;
        job.detail = null;
        const next = nextOccurrence(job.rule, job.occurrence, Math.max(job.lastSentAt, job.nextAt));
        if (next) {
          job.status = "pending";
          job.nextAt = next.at;
          job.occurrence = next.index;
          await this.store.put(job);
        } else {
          job.status = "sent";
          job.nextAt = null;
          await this.store.finish(job);
        }
      }
      await this.changed();
    });
  }
  act(id, action, options = {}) {
    return this.serial(async () => {
      const job = await this.store.get(id);
      if (!job) throw new ScheduleError("errorMissingMessage");
      if (job.status === "sending") throw new ScheduleError("errorSending");
      if (["pending", "paused", "review"].includes(job.status) && !await this.present(job)) {
        job.status = "cancelled";
        job.nextAt = null;
        await this.store.finish(job);
        await this.changed();
        throw new ScheduleError("errorQueueRemoved");
      }
      if (action === "remove") {
        if (!["sent", "cancelled"].includes(job.status)) throw new ScheduleError("errorAction");
        await this.store.remove(id);
      } else if (action === "cancel") {
        if (!["pending", "paused", "review"].includes(job.status)) throw new ScheduleError("errorAction");
        job.status = "cancelled";
        job.nextAt = null;
        await this.store.finish(job);
      } else if (action === "pause") {
        if (job.status !== "pending") throw new ScheduleError("errorAction");
        job.status = "paused";
        await this.store.put(job);
      } else if (action === "resume") {
        if (!["paused", "review"].includes(job.status)) throw new ScheduleError("errorAction");
        if (job.status === "review" && options.acceptDuplicateRisk !== true) throw new ScheduleError("errorConfirmRetry");
        if (job.rule.timeZone !== this.zone()) throw new ScheduleError("errorTimeZone");
        job.status = "pending";
        job.error = null;
        job.detail = null;
        job.nextAt = nextAllowed(Math.max(this.clock(), job.nextAt), job.rule);
        await this.store.put(job);
      } else if (action === "reschedule") {
        if (!["pending", "paused", "review"].includes(job.status)) throw new ScheduleError("errorAction");
        if (job.status === "review" && options.acceptDuplicateRisk !== true) throw new ScheduleError("errorConfirmRetry");
        job.rule = normalizeRule(options.rule, this.clock());
        const first = firstOccurrence(job.rule);
        Object.assign(job, { status: "pending", nextAt: first.at, occurrence: first.index, error: null, detail: null });
        await this.store.put(job);
      } else throw new ScheduleError("errorAction");
      await this.changed();
      return job;
    });
  }
}
