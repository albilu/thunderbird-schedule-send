import { Scheduler } from "../lib/engine.mjs";
import { FolderStore, nativePayload } from "../lib/folder-store.mjs";
import { localZone, ScheduleError } from "../lib/schedule.mjs";

const api = messenger;
const store = new FolderStore(api.scheduleBridge);
const captures = new Set();
const ports = new Set();
const notified = new Set();
const MAX_BYTES = 50 * 1024 * 1024;

async function changed() {
  // Metadata is already committed; a folder repaint/cleanup failure cannot
  // turn a confirmed SMTP send into an automatic retry.
  await store.sync().catch(error => console.error("Scheduled Send folder update failed", error));
  // A cosmetic failure must never make a committed schedule appear unsaved.
  try {
    const jobs = await store.all();
    const active = jobs.filter(j => ["pending", "paused", "sending", "review"].includes(j.status));
    await api.browserAction.setBadgeText({ text: active.length ? String(active.length) : "" });
    await api.browserAction.setBadgeBackgroundColor({ color: active.some(j => j.status === "review") ? "#b45309" : "#1373d9" });
    const due = jobs.filter(j => j.status === "pending").map(j => j.nextAt);
    if (due.length) api.alarms.create("next-send", { when: Math.max(Date.now() + 1000, Math.min(...due)) });
    else await api.alarms.clear("next-send");
    for (const port of ports) {
      try { port.postMessage({ type: "changed" }); } catch { ports.delete(port); }
    }
    for (const job of jobs.filter(j => j.status === "review" || j.error === "errorTimeZone")) {
      const key = `${job.id}:${job.attemptedAt}:${job.error}`;
      if (notified.has(key)) continue;
      notified.add(key);
      await api.notifications.create(`review-${job.id}`, {
        type: "basic", iconUrl: api.runtime.getURL("icons/schedule.svg"),
        title: api.i18n.getMessage("queueTitle"), message: api.i18n.getMessage("notificationReview")
      });
    }
  } catch (error) { console.error("Scheduled Send UI update failed", error); }
}

const scheduler = new Scheduler({ store, changed,
  isPresent: job => api.scheduleBridge.hasQueued(job.id),
  online: async () => navigator.onLine && await api.scheduleBridge.isOnline(),
  deliver: async (payload, job) => {
    try { return await api.scheduleBridge.deliver(await nativePayload(payload), job.id); }
    catch (error) {
      for (const code of ["errorOffline", "errorQueueRemoved"]) if (error.message.includes(code)) error.code = code;
      throw error;
    }
  }
});

async function schedule(tabId, rule) {
  if (!Number.isInteger(tabId) || captures.has(tabId)) throw new ScheduleError("errorComposeBusy");
  captures.add(tabId);
  let locked = false;
  let committed = false;
  try {
    const extra = await api.scheduleBridge.capture(tabId);
    locked = true;
    const details = await api.compose.getComposeDetails(tabId);
    if (details.newsgroups?.length) throw new ScheduleError("errorNewsgroups");
    if (extra.body) details.body = extra.body;
    // Only durable values are retained. relatedMessageId is a session-only ID;
    // the native References header is the durable thread relationship instead.
    delete details.relatedMessageId;
    const attachments = [];
    let size = new Blob([details.body || details.plainTextBody || ""]).size;
    for (const attachment of await api.compose.listAttachments(tabId)) {
      const file = await api.compose.getAttachmentFile(attachment.id);
      size += file.size;
      if (size > MAX_BYTES) throw new ScheduleError("errorTooLarge");
      attachments.push({ file, name: attachment.name, type: file.type });
    }
    if (size > MAX_BYTES) throw new ScheduleError("errorTooLarge");
    const job = await scheduler.create(rule, { details, native: extra.native, attachments });
    committed = true;
    try { await api.scheduleBridge.release(tabId, true); }
    catch (error) {
      console.error("Scheduled message saved; compose close failed", error);
      await scheduler.act(job.id, "pause");
      throw new ScheduleError("errorComposeClose");
    }
    return job;
  } finally {
    if (locked && !committed) await api.scheduleBridge.release(tabId, false).catch(console.error);
    captures.delete(tabId);
  }
}

async function openQueue() {
  await ready;
  const folder = await api.scheduleBridge.queueFolder();
  const existing = (await api.mailTabs.query({})).find(tab => tab.displayedFolder?.id === folder.id);
  if (existing) await api.tabs.update(existing.id, { active: true });
  else await api.mailTabs.create({ displayedFolder: folder.id, sortType: "date", sortOrder: "ascending" });
}

const ready = (async () => {
  await api.scheduleBridge.start();
  await store.open();
  await store.migrate();
  await scheduler.initialize();
  // Thunderbird waits for a paint even in hidden message panes. This cosmetic
  // update must not block startup or the scheduler.
  void api.messageDisplayAction.disable().catch(console.error);
  api.alarms.create("heartbeat", { periodInMinutes: 1 });
})();

api.runtime.onConnect.addListener(port => {
  if (port.name !== "queue" || port.sender.id !== api.runtime.id) return;
  ports.add(port);
  port.onDisconnect.addListener(() => ports.delete(port));
});

api.runtime.onMessage.addListener(async (message, sender) => {
  if (sender.id !== api.runtime.id || !sender.url?.startsWith(api.runtime.getURL(""))) return;
  try {
    await ready;
    switch (message.type) {
      case "schedule": return { ok: true, job: await schedule(message.tabId, message.rule) };
      case "list": return { ok: true, jobs: await store.all(), online: navigator.onLine && await api.scheduleBridge.isOnline(), timeZone: localZone() };
      case "selected": {
        const id = await api.scheduleBridge.queuedId(message.messageId);
        return { ok: true, job: id ? await store.get(id) : null,
          online: navigator.onLine && await api.scheduleBridge.isOnline(), timeZone: localZone() };
      }
      case "act": return { ok: true, job: await scheduler.act(message.id, message.action, message.options) };
      case "queue": await openQueue(); return { ok: true };
      case "restore": {
        // Pause BEFORE opening a copy, so editing can never race a due delivery.
        const job = await store.get(message.id);
        if (job?.status === "pending") await scheduler.act(job.id, "pause");
        else if (!["paused", "review"].includes(job?.status)) throw new ScheduleError("errorAction");
        const payload = await store.payload(message.id);
        if (!payload) throw new ScheduleError("errorMissingMessage");
        const details = { ...payload.details };
        for (const key of ["type", "isModified", "selectedEncryptionTechnology"]) delete details[key];
        details.attachments = payload.attachments.map(a => ({ file: a.file, name: a.name }));
        await api.compose.beginNew(details);
        return { ok: true };
      }
      default: throw new ScheduleError("errorAction");
    }
  } catch (error) {
    console.error("Scheduled Send operation failed", error);
    const code = error.code || /\berror[A-Z]\w+/.exec(error.message)?.[0] || "errorUnexpected";
    return { ok: false, error: code, detail: String(error.message || error).slice(0, 600) };
  }
});

const tick = () => ready.then(() => scheduler.tick()).catch(error => console.error("Scheduled Send queue check failed", error));
api.alarms.onAlarm.addListener(alarm => { if (["heartbeat", "next-send"].includes(alarm.name)) void tick(); });
window.addEventListener("online", tick);
api.browserAction.onClicked.addListener(openQueue);
api.notifications.onClicked.addListener(openQueue);
api.scheduleBridge.onQueueChanged.addListener(ids => {
  // Capture removal intent even if Thunderbird immediately undoes a move.
  void ready.then(async () => {
    await scheduler.cancelRemoved(ids);
    await scheduler.tick();
  }).catch(error => console.error("Scheduled Send folder reconciliation failed", error));
});
const updateMessageAction = async (tab, message) => {
  try {
    await ready;
    const id = message && await api.scheduleBridge.queuedId(message.id);
    if (id) await api.messageDisplayAction.enable(tab.id);
    else await api.messageDisplayAction.disable(tab.id);
  } catch (error) { console.error("Scheduled Send message controls failed", error); }
};
api.messageDisplay.onMessageDisplayed.addListener(updateMessageAction);
ready.then(async () => {
  for (const tab of await api.tabs.query({})) {
    if (["mail", "messageDisplay"].includes(tab.type)) void updateMessageAction(tab, await api.messageDisplay.getDisplayedMessage(tab.id));
  }
}).catch(console.error);
ready.then(tick).catch(error => console.error("Scheduled Send initialization failed", error));
