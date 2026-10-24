import { Scheduler } from "../lib/engine.mjs";
import { DraftStore } from "../lib/draft-store.mjs";
import { localZone, ScheduleError } from "../lib/schedule.mjs";

const api = messenger;
const store = new DraftStore(api.scheduleBridge);
const captures = new Set();
const ports = new Set();
const notified = new Set();
const MAX_BYTES = 50 * 1024 * 1024;
let notificationIcon;

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
    for (const job of jobs.filter(j => j.status === "review" || j.error === "errorTimeZone" || j.error === "errorDraftMigration")) {
      const key = `${job.id}:${job.attemptedAt}:${job.error}`;
      if (notified.has(key)) continue;
      notified.add(key);
      await api.notifications.create(`review-${job.id}`, {
        type: "basic", iconUrl: await (notificationIcon ||= api.scheduleBridge.notificationIcon()),
        title: api.i18n.getMessage("queueTitle"), message: api.i18n.getMessage("notificationReview")
      });
    }
  } catch (error) { console.error("Scheduled Send UI update failed", error); }
}

const scheduler = new Scheduler({ store, changed,
  isPresent: job => job.draft ? api.scheduleBridge.hasDraft(job, true) : true,
  online: async () => navigator.onLine && await api.scheduleBridge.isOnline(),
  deliver: async (payload, job) => {
    try { return await api.scheduleBridge.deliver(await store.get(job.id)); }
    catch (error) {
      for (const code of ["errorOffline", "errorQueueRemoved"]) if (error.message.includes(code)) error.code = code;
      throw error;
    }
  }
});

async function schedule(tabId, rule, previous = null) {
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
    const payload = { details, native: extra.native, attachments };
    const job = previous ? await scheduler.restoreEdited(previous, payload) : await scheduler.create(rule, payload);
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

async function openQueue(message = {}, clickedTab = null) {
  await ready;
  const active = clickedTab || (await api.tabs.query({ active: true, currentWindow: true }))[0];
  const mailTabs = await api.mailTabs.query({});
  const current = mailTabs.find(tab => tab.id === active?.id);
  const context = current || mailTabs.find(tab => tab.active && tab.windowId === active?.windowId);
  let identityId = message.id ? (await store.get(message.id))?.identityId : undefined;
  if (message.tabId) identityId = (await api.compose.getComposeDetails(message.tabId)).identityId;
  if (!identityId) {
    // An empty or hidden message pane may never finish loading. Folder
    // navigation needs the mail selection, without waiting for that pane.
    const selected = current ? (await api.mailTabs.getSelectedMessages(current.id)).messages : [];
    const displayed = selected.length === 1 ? selected[0] : active?.type === "messageDisplay"
      ? await api.messageDisplay.getDisplayedMessage(active.id) : null;
    const jobId = displayed && await api.scheduleBridge.queuedId(displayed.id);
    if (jobId) identityId = (await store.get(jobId))?.identityId;
    const accountId = displayed?.folder?.accountId || context?.displayedFolder?.accountId;
    if (!identityId && accountId) identityId = (await api.identities.getDefault(accountId))?.id;
  }
  await api.scheduleBridge.openDrafts(identityId || null);
}

const ready = (async () => {
  let { instanceId } = await api.storage.local.get("instanceId");
  if (!instanceId) {
    instanceId = crypto.randomUUID();
    await api.storage.local.set({ instanceId });
  }
  store.owner = instanceId;
  await api.scheduleBridge.start(instanceId);
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
      case "job": return { ok: true, job: await store.get(message.id),
        online: navigator.onLine && await api.scheduleBridge.isOnline(), timeZone: localZone() };
      case "act": return { ok: true, job: await scheduler.act(message.id, message.action, message.options) };
      case "queue": await openQueue(message); return { ok: true };
      case "edit": {
        let job = await store.get(message.id);
        if (!["pending", "paused", "review"].includes(job?.status)) throw new ScheduleError("errorAction");
        const previousStatus = job.status;
        // Stop pending delivery before waiting for the native editor to open.
        if (job.status === "pending") {
          await scheduler.act(job.id, "pause");
          job = await store.get(job.id);
        }
        await api.scheduleBridge.editDraft({ ...job, previousStatus });
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
api.browserAction.onClicked.addListener(tab => void openQueue({}, tab).catch(console.error));
api.notifications.onClicked.addListener(() => void openQueue().catch(console.error));
api.scheduleBridge.onQueueChanged.addListener(ids => {
  // Capture removal intent even if Thunderbird immediately undoes a move.
  void ready.then(async () => {
    await scheduler.cancelRemoved(ids);
    await scheduler.tick();
  }).catch(error => console.error("Scheduled Send folder reconciliation failed", error));
});
api.scheduleBridge.onRestoreEdited.addListener(async ({ tabId, previous }) => {
  try {
    await ready;
    await schedule(tabId, null, previous);
    return { ok: true };
  } catch (error) {
    console.error("Scheduled Send edit restoration failed", error);
    return { ok: false, error: error.code || /\berror[A-Z]\w+/.exec(error.message)?.[0] || "errorUnexpected" };
  }
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
