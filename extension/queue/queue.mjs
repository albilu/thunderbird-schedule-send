import { RuleForm } from "../lib/rule-form.mjs";
import { applyTheme, el, errorText, formatDate, language, localize, recurrenceText, request, t } from "../lib/ui.mjs";

localize();
void applyTheme();
const $ = id => document.getElementById(id);
$("search").placeholder = t("searchSchedules");
let jobs = [];
let view = "active";
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
  const search = $("search").value.toLocaleLowerCase();
  const visible = jobs.filter(job => (view === "history") === ["sent", "cancelled"].includes(job.status))
    .filter(job => `${job.subject} ${(job.to || []).join(" ")} ${job.from}`.toLocaleLowerCase().includes(search))
    .sort((a, b) => view === "history" ? b.createdAt - a.createdAt : (a.nextAt ?? Infinity) - (b.nextAt ?? Infinity));
  const fragment = document.createDocumentFragment();
  for (const job of visible) {
    const button = (action, label, className = "subtle") => el("button", { type: "button", className,
      "data-action": action, "data-job": job.id, disabled: mutating, onclick: () => act(job, action) }, t(label));
    const controls = el("div", { className: "actions" });
    if (job.status === "pending") controls.append(button("pause", "pause"));
    if (job.status === "paused") controls.append(button("resume", "resume"));
    if (job.status === "review") controls.append(button("resume", "reviewRetry"));
    if (["pending", "paused", "review"].includes(job.status)) {
      controls.append(button("reschedule", "reschedule"), button("restore", "openCopy"), button("cancel", "cancelSchedule", "subtle danger"));
    }
    if (["sent", "cancelled"].includes(job.status)) controls.append(button("remove", "removeHistory"));
    const when = job.nextAt ? t("scheduledFor", formatDate(job.nextAt, job.rule.timeZone))
      : job.lastSentAt ? t("sentAt", formatDate(job.lastSentAt, job.rule.timeZone)) : t("status_cancelled");
    fragment.append(el("article", { className: "job", "data-job": job.id },
      el("div", { className: "job-header" }, el("div", {}, el("h3", {}, job.subject || t("noSubject")),
        el("p", { className: "recipient hint" }, t("toRecipients", (job.to || []).join(", ") || t("otherRecipients")))),
        el("span", { className: `status ${job.status}` }, t(`status_${job.status}`))),
      el("p", { className: "when" }, when), el("p", { className: "rules-summary hint" }, ruleSummary(job)),
      job.error ? el("p", { className: "error" }, t(job.error)) : null, controls));
  }
  if (!visible.length) fragment.append(el("div", { className: "empty" }, el("div", { className: "empty-icon", "aria-hidden": "true" }, "◷"),
    el("h2", {}, t(search ? "noResults" : view === "history" ? "emptyHistory" : "emptyQueue")),
    el("p", { className: "hint" }, t(search ? "searchHint" : "emptyQueueHint"))));
  // Preserve keyboard focus across live queue updates.
  const active = document.activeElement;
  const focused = active?.dataset.action ? { action: active.dataset.action, id: active.dataset.job } : null;
  $("jobs").replaceChildren(fragment);
  if (focused) [...$("jobs").querySelectorAll("button")].find(b => b.dataset.action === focused.action && b.dataset.job === focused.id)?.focus();
}

async function load() {
  if (loading) { reloadAgain = true; return; }
  loading = true;
  try {
    const response = await request({ type: "list" });
    jobs = response.jobs;
    $("connection").textContent = t(response.online ? "online" : "offline");
    $("connection").classList.toggle("offline", !response.online);
    $("timezone").textContent = response.timeZone;
    render();
  } catch (error) { $("error").textContent = error.message; }
  finally {
    loading = false;
    $("jobs").setAttribute("aria-busy", "false");
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
    if (action === "restore") {
      await request({ type: "restore", id: job.id });
      $("feedback").textContent = t("restoredMessage");
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
for (const mode of ["active", "history"]) $(mode).addEventListener("click", () => {
  view = mode;
  for (const id of ["active", "history"]) {
    $(id).classList.toggle("selected", id === mode);
    $(id).setAttribute("aria-pressed", String(id === mode));
  }
  render();
});
$("search").addEventListener("input", render);
$("refresh").addEventListener("click", load);
const port = messenger.runtime.connect({ name: "queue" });
port.onMessage.addListener(() => void load());
port.onDisconnect.addListener(() => { $("error").textContent = t("errorDisconnected"); });
const timer = setInterval(load, 30_000);
window.addEventListener("unload", () => { clearInterval(timer); editForm?.destroy(); port.disconnect(); });
await load();
