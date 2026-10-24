import { RuleForm } from "../lib/rule-form.mjs";
import { applyTheme, errorText, localize, request, t } from "../lib/ui.mjs";

localize();
void applyTheme();
const submit = document.getElementById("submit");
const error = document.getElementById("error");
let tabId;
let busy = false;
const form = new RuleForm(document.getElementById("rule-form"), valid => {
  submit.disabled = busy || !valid || tabId === undefined;
});

try {
  const tabs = await messenger.tabs.query({ active: true, currentWindow: true });
  const tab = tabs.find(tab => tab.type === "messageCompose");
  if (!tab) throw new Error(t("errorCompose"));
  tabId = tab.id;
  form.update();
} catch (failure) { error.textContent = failure.message; }

document.getElementById("schedule-form").addEventListener("submit", async event => {
  event.preventDefault();
  if (busy || tabId === undefined) return;
  busy = true;
  submit.disabled = true;
  submit.textContent = t("saving");
  error.textContent = "";
  try {
    await request({ type: "schedule", tabId, rule: form.read() });
    window.close();
  } catch (failure) {
    error.textContent = errorText(failure);
    error.scrollIntoView({ block: "nearest" });
    busy = false;
    submit.textContent = t("scheduleMessage");
    form.update();
  }
});
document.getElementById("open-queue").addEventListener("click", async () => {
  try { await request({ type: "queue", tabId }); window.close(); } catch (failure) { error.textContent = failure.message; }
});
window.addEventListener("unload", () => form.destroy());
