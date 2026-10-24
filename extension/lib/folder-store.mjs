import { ScheduleStore } from "./store.mjs";

export const ACTIVE_STATUSES = ["pending", "paused", "sending", "review"];

export async function nativePayload(payload) {
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

// The readable mail copy is saved before the scheduling transaction commits.
// A crash between the two leaves an inert message, never an untracked send.
export class FolderStore extends ScheduleStore {
  constructor(bridge, indexedDB) { super(indexedDB); this.bridge = bridge; }
  async create(job, payload) {
    await this.bridge.stage(job, await nativePayload(payload));
    job.folderBacked = true;
    try { await super.create(job, payload); }
    catch (error) {
      await this.bridge.removeQueued(job.id, true).catch(console.error);
      throw error;
    }
  }
  async migrate() {
    for (const job of await this.all()) {
      if (job.folderBacked || !ACTIVE_STATUSES.includes(job.status)) continue;
      const payload = await this.payload(job.id);
      if (!payload) throw new Error("errorMissingMessage");
      // stage is idempotent by Message-ID, including after an interrupted upgrade.
      await this.bridge.stage(job, await nativePayload(payload));
      job.folderBacked = true;
      await this.put(job);
    }
  }
  async sync() {
    for (const job of await this.all()) {
      if (!job.folderBacked) continue;
      if (ACTIVE_STATUSES.includes(job.status) || job.error === "errorSentCopy") {
        await this.bridge.updateQueued(job);
      } else {
        // Cancelled copies go to Trash; successfully sent copies are consumed.
        await this.bridge.removeQueued(job.id, job.status === "sent");
      }
    }
  }
}
