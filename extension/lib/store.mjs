// Metadata and complete message snapshots share one database transaction.
// Files/Blobs are structured-cloned by IndexedDB, never stored as transient URLs.
export class ScheduleStore {
  constructor(indexedDB = globalThis.indexedDB) { this.indexedDB = indexedDB; }
  async open() {
    if (this.db) return;
    this.db = await new Promise((resolve, reject) => {
      const request = this.indexedDB.open("scheduled-send", 1);
      request.onupgradeneeded = () => {
        request.result.createObjectStore("jobs", { keyPath: "id" });
        request.result.createObjectStore("payloads");
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error("errorStorage"));
    });
    this.db.onversionchange = () => { this.db.close(); this.db = null; };
  }
  async transaction(names, mode, operation) {
    await this.open();
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(names, mode, mode === "readwrite" ? { durability: "strict" } : {});
      let request;
      try { request = operation(tx); } catch (error) { tx.abort(); reject(error); return; }
      tx.oncomplete = () => resolve(request?.result);
      tx.onerror = () => reject(tx.error || new Error("errorStorage"));
      tx.onabort = () => reject(tx.error || new Error("errorStorage"));
    });
  }
  all() { return this.transaction(["jobs"], "readonly", tx => tx.objectStore("jobs").getAll()); }
  get(id) { return this.transaction(["jobs"], "readonly", tx => tx.objectStore("jobs").get(id)); }
  payload(id) { return this.transaction(["payloads"], "readonly", tx => tx.objectStore("payloads").get(id)); }
  create(job, payload) {
    return this.transaction(["jobs", "payloads"], "readwrite", tx => {
      tx.objectStore("jobs").add(job);
      tx.objectStore("payloads").add(payload, job.id);
    });
  }
  put(job) { return this.transaction(["jobs"], "readwrite", tx => tx.objectStore("jobs").put(job)); }
  finish(job) {
    return this.transaction(["jobs", "payloads"], "readwrite", tx => {
      tx.objectStore("jobs").put(job);
      tx.objectStore("payloads").delete(job.id);
    });
  }
  remove(id) {
    return this.transaction(["jobs", "payloads"], "readwrite", tx => {
      tx.objectStore("jobs").delete(id);
      tx.objectStore("payloads").delete(id);
    });
  }
}
