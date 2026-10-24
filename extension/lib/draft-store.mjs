import { ScheduleStore } from "./store.mjs";

export const ACTIVE_STATUSES = ["pending", "paused", "sending", "review"];

async function nativePayload(payload) {
  const attachments = [];
  for (const attachment of payload.attachments) {
    const bytes = new Uint8Array(await attachment.file.arrayBuffer());
    let binary = "";
    for (let offset = 0; offset < bytes.length; offset += 32768) {
      binary += String.fromCharCode(...bytes.subarray(offset, offset + 32768));
    }
    attachments.push({ name: attachment.name, type: attachment.type, base64: btoa(binary) });
  }
  return { ...payload, attachments };
}

// Only the delivery journal and schedule metadata live in IndexedDB. The actual
// message is the synchronized IMAP draft, read again at delivery time.
export class DraftStore extends ScheduleStore {
  constructor(bridge, indexedDB) { super(indexedDB); this.bridge = bridge; }
  async create(job, payload) {
    Object.assign(job, { owner: this.owner, identityId: payload.details.identityId });
    job.draft = await this.bridge.stage(job, await nativePayload(payload));
    try { await super.put(job); }
    catch (error) {
      // Leave an ordinary recoverable draft if the local journal cannot commit.
      await this.bridge.cancelDraft(job).catch(console.error);
      throw error;
    }
  }
  async payload(id) {
    const job = await this.get(id);
    if (!job?.draft || job.owner !== this.owner) return null;
    return await this.bridge.hasDraft(job, true) ? { draft: true } : null;
  }
  async migrate() {
    for (const job of await this.all()) {
      if (job.draft || !ACTIVE_STATUSES.includes(job.status)) continue;
      try {
        const payload = await super.payload(job.id);
        if (!payload) throw new Error("errorMissingMessage");
        await this.create(job, payload);
        await super.finish(job); // Release the old private message bytes.
        await this.bridge.removeLegacy(job.id);
      } catch (error) {
        // A failed upgrade must retain the old contents and never send locally.
        job.status = "paused";
        job.error = "errorDraftMigration";
        await super.put(job);
        console.error("Scheduled Send draft migration failed", error);
      }
    }
  }
  async sync() {
    for (const job of await this.all()) {
      if (!job.draft || job.owner !== this.owner) continue;
      await this.bridge.watchDraft(job);
      if (ACTIVE_STATUSES.includes(job.status)) {
        const updated = await this.bridge.updateDraft(job);
        if (updated && updated.messageId !== job.draft.messageId) {
          const previous = { ...job };
          job.draft = updated;
          await super.put(job);
          await this.bridge.watchDraft(job);
          await this.bridge.removeDraft(previous);
        }
      } else if (!job.draftCleaned) {
        if (job.status === "sent" && job.error !== "errorSentCopy") await this.bridge.removeDraft(job);
        else await this.bridge.cancelDraft(job);
        job.draftCleaned = true;
        await super.put(job);
      }
    }
  }
}
