import { firstOccurrence, localInput, localZone, nextOccurrence, normalizeRule, parseLocalDateTime } from "./schedule.mjs";
import { el, formatDate, language, t } from "./ui.mjs";

let sequence = 0;
export class RuleForm {
  constructor(container, onChange = () => {}) {
    this.prefix = `rule-${++sequence}`;
    this.onChange = onChange;
    const input = (name, type, attrs = {}) => this[name] = el("input", { id: `${this.prefix}-${name}`, type, ...attrs });
    const label = (name, key) => el("label", { for: `${this.prefix}-${name}` }, t(key));
    this.mode = "delay";
    this.delayTab = el("button", { type: "button", className: "segment selected", "aria-pressed": "true", onclick: () => this.setMode("delay") }, t("afterDelay"));
    this.dateTab = el("button", { type: "button", className: "segment", "aria-pressed": "false", onclick: () => this.setMode("date") }, t("atDateTime"));
    this.presets = el("div", { className: "presets", role: "group", "aria-label": t("presets") },
      ...[5, 10, 30].map(minutes => el("button", { type: "button", className: minutes === 10 ? "preset selected" : "preset", "data-minutes": minutes,
        "aria-pressed": String(minutes === 10), onclick: () => { this.delay.value = minutes; this.setMode("delay"); } }, t("inMinutes", String(minutes)))));
    this.delayRow = el("div", { className: "field" }, label("delay", "delayLabel"),
      el("div", { className: "input-unit" }, input("delay", "number", { min: 1, max: 10000000, step: 1, value: 10, inputmode: "numeric", required: true }), el("span", {}, t("minutes"))));
    this.dateRow = el("div", { className: "field", hidden: true }, label("date", "dateLabel"),
      input("date", "datetime-local", { value: localInput(Date.now() + 3600000), step: 60 }));
    this.repeat = el("select", { id: `${this.prefix}-repeat` }, ...["none", "minutes", "daily", "monthly", "yearly"].map(value => el("option", { value }, t(`unit_${value}`))));
    this.intervalRow = el("div", { className: "field interval", hidden: true }, label("interval", "every"), input("interval", "number", { min: 1, max: 10000, step: 1, value: 1 }));
    this.windowInputs = el("div", { className: "window-inputs", hidden: true },
      el("div", { className: "field" }, label("start", "fromTime"), input("start", "time", { value: "01:00", step: 60 })),
      el("div", { className: "field" }, label("end", "untilTime"), input("end", "time", { value: "05:00", step: 60 })));
    this.days = [];
    this.dayRow = el("div", { className: "weekdays", hidden: true });
    for (const day of [1, 2, 3, 4, 5, 6, 0]) {
      const date = new Date(2024, 0, 7 + day);
      const short = new Intl.DateTimeFormat(language(), { weekday: "short" }).format(date);
      const full = new Intl.DateTimeFormat(language(), { weekday: "long" }).format(date);
      const checkbox = el("input", { type: "checkbox", value: day, checked: true, "aria-label": full });
      this.days.push(checkbox);
      this.dayRow.append(el("label", { className: "weekday", title: full }, checkbox, el("span", {}, short)));
    }
    this.rules = el("details", { className: "rules" }, el("summary", {}, t("deliveryRules")),
      el("div", { className: "rules-content" },
        el("label", { className: "check" }, input("useWindow", "checkbox"), t("useWindow")), this.windowInputs,
        el("label", { className: "check" }, input("useDays", "checkbox"), t("useDays")), this.dayRow,
        el("p", { className: "hint" }, t("windowHint"))));
    this.previewValue = el("strong", { id: `${this.prefix}-preview` });
    this.previewNext = el("span", { className: "hint" });
    this.preview = el("div", { className: "preview", "aria-live": "polite", "aria-atomic": "true" },
      el("span", { className: "eyebrow" }, t("nextDelivery")), this.previewValue, this.previewNext);
    container.append(this.presets, el("div", { className: "segments", role: "group", "aria-label": t("scheduleType") }, this.delayTab, this.dateTab),
      this.delayRow, this.dateRow, el("p", { className: "timezone hint" }, t("localTimeZone", localZone())),
      el("div", { className: "repeat-row" }, el("div", { className: "field" }, label("repeat", "repeat"), this.repeat), this.intervalRow), this.rules, this.preview);
    this.container = container;
    container.addEventListener("input", () => this.update());
    container.addEventListener("change", () => this.update());
    this.update();
    this.timer = setInterval(() => this.update(), 30_000);
  }
  setMode(mode) {
    this.mode = mode;
    this.delayTab.classList.toggle("selected", mode === "delay");
    this.dateTab.classList.toggle("selected", mode === "date");
    this.delayTab.setAttribute("aria-pressed", String(mode === "delay"));
    this.dateTab.setAttribute("aria-pressed", String(mode === "date"));
    this.delayRow.hidden = mode !== "delay";
    this.dateRow.hidden = mode !== "date";
    this.delay.disabled = mode !== "delay";
    this.date.disabled = mode !== "date";
    this.date.required = mode === "date";
    this.update();
  }
  read(now = Date.now()) {
    const delay = Number(this.delay.value);
    if (this.mode === "delay" && (!Number.isSafeInteger(delay) || delay < 1 || delay > 10000000)) throw new Error("errorDelay");
    return normalizeRule({
      startAt: this.mode === "date" ? parseLocalDateTime(this.date.value) : now + delay * 60_000,
      recurrence: { unit: this.repeat.value, interval: Number(this.interval.value) },
      window: this.useWindow.checked ? { start: this.start.value, end: this.end.value } : null,
      weekdays: this.useDays.checked ? this.days.filter(d => d.checked).map(d => Number(d.value)) : [0, 1, 2, 3, 4, 5, 6],
      timeZone: localZone()
    }, now);
  }
  update() {
    this.intervalRow.hidden = this.repeat.value === "none";
    this.interval.disabled = this.repeat.value === "none";
    this.windowInputs.hidden = !this.useWindow.checked;
    this.start.disabled = this.end.disabled = !this.useWindow.checked;
    this.dayRow.hidden = !this.useDays.checked;
    for (const button of this.presets.children) {
      const selected = this.mode === "delay" && button.dataset.minutes === this.delay.value;
      button.classList.toggle("selected", selected);
      button.setAttribute("aria-pressed", String(selected));
    }
    try {
      const rule = this.read();
      const first = firstOccurrence(rule);
      const next = nextOccurrence(rule, first.index, first.at);
      this.previewValue.textContent = formatDate(first.at);
      this.previewNext.textContent = next ? t("thenDelivery", formatDate(next.at)) : t("oneTime");
      this.preview.classList.remove("invalid");
      this.valid = true;
    } catch (error) {
      this.previewValue.textContent = t(error.code || error.message);
      this.previewNext.textContent = "";
      this.preview.classList.add("invalid");
      this.valid = false;
    }
    this.onChange(this.valid);
  }
  set(rule) {
    this.date.value = localInput(Math.max(rule.startAt, Date.now() + 3600000));
    this.repeat.value = rule.recurrence.unit;
    this.interval.value = rule.recurrence.interval;
    this.useWindow.checked = Boolean(rule.window);
    if (rule.window) { this.start.value = rule.window.start; this.end.value = rule.window.end; }
    this.useDays.checked = rule.weekdays.length !== 7;
    for (const day of this.days) day.checked = rule.weekdays.includes(Number(day.value));
    this.rules.open = this.useDays.checked || this.useWindow.checked;
    this.setMode("date");
  }
  destroy() { clearInterval(this.timer); }
}
