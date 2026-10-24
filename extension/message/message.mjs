import { RuleForm } from "../lib/rule-form.mjs";
import { applyTheme, el, errorText, formatDate, language, localize, recurrenceText, request, t } from "../lib/ui.mjs";

localize();
void applyTheme();
const $ = id => document.getElementById(id);
let job;
let messageId;
let jobId;
let editing;
let editForm;
let loading = false;
let reloadAgain = false;
let mutating = false;

function confirmAction(title, description, action) {
  $("confirmation-title").textContent = title;
  $("confirmation-text").textContent = description;
  $("confirm-action").textContent = action;
  const dialog = $("confirmation");
  dialog.returnValue = "cancel";
  dialog.showModal();
  return new Promise(resolve => dialog.addEventListener("close", () => resolve(dialog.returnValue === "confirm"), { once: true }));
}

function ruleSummary(job) {
  const parts = [recurrenceText(job.rule)];
  if (job.rule.window) parts.push(t("windowSummary", [job.rule.window.start, job.rule.window.end]));
  if (job.rule.weekdays.length < 7) parts.push(job.rule.weekdays.map(day => new Intl.DateTimeFormat(language(), { weekday: "short" }).format(new Date(2024, 0, 7 + day))).join(", "));
  if (job.attachmentCount) parts.push(t("attachmentCount", String(job.attachmentCount)));
  if (job.sentCount) parts.push(t("sentCount", String(job.sentCount)));
  return parts.join(" · ");
}

function render() {
  const fragment = document.createDocumentFragment();
  if (job) {
    const button = (action, label, className = "subtle") => el("button", { type: "button", className,
      "data-action": action, "data-job": job.id, disabled: mutating, onclick: () => act(job, action) }, t(label));
    const controls = el("div", { className: "actions" });
    if (job.status === "pending") controls.append(button("pause", "pause"));
    if (job.status === "paused") controls.append(button("resume", "resume"));
    if (job.status === "review") controls.append(button("resume", "reviewRetry"));
    if (["pending", "paused", "review"].includes(job.status)) {
      controls.append(button("reschedule", "reschedule"), button("edit", "editDraft"), button("cancel", "cancelSchedule", "subtle danger"));
    }
    const when = job.nextAt ? t("scheduledFor", formatDate(job.nextAt, job.rule.timeZone))
      : job.lastSentAt ? t("sentAt", formatDate(job.lastSentAt, job.rule.timeZone)) : t("status_cancelled");
    fragment.append(el("article", { className: "job", "data-job": job.id },
      el("div", { className: "job-header" }, el("div", {}, el("h2", {}, job.subject || t("noSubject")),
        el("p", { className: "recipient hint" }, t("toRecipients", (job.to || []).join(", ") || t("otherRecipients")))),
        el("span", { className: `status ${job.status}` }, t(`status_${job.status}`))),
      el("p", { className: "when" }, when), el("p", { className: "rules-summary hint" }, ruleSummary(job)),
      job.error ? el("p", { className: "error" }, t(job.error)) : null, controls));
  }
  if (!job) fragment.append(el("p", { className: "hint" }, t(messageId ? "inactiveMessage" : "selectScheduledMessage")));
  // Preserve keyboard focus across live queue updates.
  const active = document.activeElement;
  const focused = active?.dataset.action ? { action: active.dataset.action, id: active.dataset.job } : null;
  $("message").replaceChildren(fragment);
  if (focused) [...$("message").querySelectorAll("button")].find(b => b.dataset.action === focused.action && b.dataset.job === focused.id)?.focus();
}

async function load() {
  if (loading) { reloadAgain = true; return; }
  loading = true;
  try {
    if (!messageId) {
      const [tab] = await messenger.tabs.query({ active: true, currentWindow: true });
      if (tab && ["mail", "messageDisplay"].includes(tab.type)) messageId = (await messenger.messageDisplay.getDisplayedMessage(tab.id))?.id;
    }
    if (messageId) {
      const response = await request(jobId ? { type: "job", id: jobId } : { type: "selected", messageId });
      job = response.job;
      jobId = job?.id || jobId;
      $("connection").textContent = t(response.online ? "online" : "offline");
      $("connection").classList.toggle("offline", !response.online);
    }
    render();
  } catch (error) { $("error").textContent = error.message; }
  finally {
    loading = false;
    $("message").setAttribute("aria-busy", "false");
    if (reloadAgain) { reloadAgain = false; void load(); }
  }
}

async function act(job, action) {
  if (mutating) return;
  mutating = true;
  $("error").textContent = "";
  $("feedback").textContent = "";
  try {
    const options = {};
    if (["resume", "reschedule"].includes(action) && job.status === "review") {
      if (!await confirmAction(t("reviewRetry"), t("duplicateRisk"), t("acceptRetry"))) return;
      options.acceptDuplicateRisk = true;
    }
    if (action === "cancel" && !await confirmAction(t("cancelSchedule"), t("cancelDescription"), t("cancelSchedule"))) return;
    if (action === "reschedule") {
      editing = { id: job.id, options };
      editForm?.destroy();
      $("edit-rule").replaceChildren();
      $("edit-error").textContent = "";
      editForm = new RuleForm($("edit-rule"), valid => { $("save-edit").disabled = !valid; });
      editForm.set(job.rule);
      $("edit-dialog").showModal();
      return;
    }
    if (action === "edit") {
      await request({ type: "edit", id: job.id });
      window.close();
    } else await request({ type: "act", id: job.id, action, options });
    await load();
  } catch (error) { $("error").textContent = error.message; }
  finally { mutating = false; render(); }
}

$("edit-form").addEventListener("submit", async event => {
  event.preventDefault();
  if (mutating) return;
  mutating = true;
  $("save-edit").disabled = true;
  try {
    await request({ type: "act", id: editing.id, action: "reschedule", options: { ...editing.options, rule: editForm.read() } });
    $("edit-dialog").close();
    await load();
  } catch (error) { $("edit-error").textContent = errorText(error); }
  finally { mutating = false; editForm?.update(); }
});
$("close-edit").addEventListener("click", () => $("edit-dialog").close());
$("edit-dialog").addEventListener("close", () => editForm?.destroy());
$("folder").addEventListener("click", async () => {
  try { await request({ type: "queue", id: job?.id }); window.close(); }
  catch (error) { $("error").textContent = errorText(error); }
});
$("refresh").addEventListener("click", load);
const port = messenger.runtime.connect({ name: "queue" });
port.onMessage.addListener(() => void load());
port.onDisconnect.addListener(() => { $("error").textContent = t("errorDisconnected"); });
const timer = setInterval(load, 30_000);
window.addEventListener("unload", () => { clearInterval(timer); editForm?.destroy(); port.disconnect(); });
await load();
