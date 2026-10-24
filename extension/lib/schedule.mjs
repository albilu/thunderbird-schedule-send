// Calendar rules use local wall time. The IANA zone is pinned in each schedule;
// a changed system zone pauses delivery until the user reviews the schedule.
export class ScheduleError extends Error {
  constructor(code) { super(code); this.name = "ScheduleError"; this.code = code; }
}

export const localZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;
const MINUTE = 60_000;
const DAY = 86_400_000;
const units = new Set(["none", "minutes", "daily", "monthly", "yearly"]);

export function parseLocalDateTime(value) {
  const parts = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
  if (!parts) throw new ScheduleError("errorDate");
  const [, y, m, d, h, min] = parts.map(Number);
  const date = new Date(y, m - 1, d, h, min);
  // Reject invalid dates and the missing hour at the spring DST transition.
  if (y < 1970 || date.getFullYear() !== y || date.getMonth() !== m - 1 ||
      date.getDate() !== d || date.getHours() !== h || date.getMinutes() !== min) {
    throw new ScheduleError("errorDate");
  }
  return date.getTime();
}

export function localInput(timestamp) {
  const date = new Date(timestamp);
  const pad = n => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function timeMinutes(value) {
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) throw new ScheduleError("errorWindow");
  const [hour, minute] = value.split(":").map(Number);
  return hour * 60 + minute;
}

export function normalizeRule(input, now = Date.now()) {
  if (!input || !Number.isFinite(input.startAt) || input.startAt <= now ||
      input.startAt > new Date(9998, 11, 31).getTime()) throw new ScheduleError("errorFuture");
  const unit = input.recurrence?.unit ?? "none";
  const interval = unit === "none" ? 1 : input.recurrence?.interval;
  if (!units.has(unit) || !Number.isSafeInteger(interval) || interval < 1 || interval > 10000) {
    throw new ScheduleError("errorInterval");
  }
  const weekdays = input.weekdays ?? [0, 1, 2, 3, 4, 5, 6];
  if (!Array.isArray(weekdays) || !weekdays.length || weekdays.some(d => !Number.isInteger(d) || d < 0 || d > 6)) {
    throw new ScheduleError("errorWeekdays");
  }
  let window = null;
  if (input.window) {
    const { start, end } = input.window;
    timeMinutes(start); timeMinutes(end);
    if (start === end) throw new ScheduleError("errorWindow");
    window = { start, end };
  }
  const timeZone = input.timeZone || localZone();
  if (timeZone !== localZone()) throw new ScheduleError("errorTimeZone");
  return { startAt: input.startAt, recurrence: { unit, interval },
    weekdays: [...new Set(weekdays)].sort(), window, timeZone };
}

// Weekdays refer to the actual send date, including the morning part of an
// overnight window. Windows are start-inclusive and end-exclusive.
export function nextAllowed(timestamp, rule) {
  const initial = new Date(timestamp);
  const start = rule.window ? timeMinutes(rule.window.start) : 0;
  const end = rule.window ? timeMinutes(rule.window.end) : 1440;
  const ranges = start < end ? [[start, end]] : [[0, end], [start, 1440]];
  for (let offset = 0; offset < 15; offset++) {
    const day = new Date(initial.getFullYear(), initial.getMonth(), initial.getDate() + offset);
    if (!rule.weekdays.includes(day.getDay())) continue;
    for (const [from, to] of ranges) {
      const lower = new Date(day.getFullYear(), day.getMonth(), day.getDate(), 0, from).getTime();
      const upper = new Date(day.getFullYear(), day.getMonth(), day.getDate(), 0, to).getTime();
      const candidate = Math.max(timestamp, lower);
      const wall = new Date(candidate);
      const minute = wall.getHours() * 60 + wall.getMinutes();
      if (candidate < upper && minute >= from && minute < to && rule.weekdays.includes(wall.getDay())) {
        return candidate;
      }
    }
  }
  throw new ScheduleError("errorNoOccurrence");
}

const daysInMonth = (year, month) => new Date(year, month + 1, 0).getDate();

export function occurrence(rule, index) {
  const anchor = new Date(rule.startAt);
  const { unit, interval } = rule.recurrence;
  const step = index * interval;
  if (unit === "none") return index === 0 ? rule.startAt : null;
  if (unit === "minutes") return rule.startAt + step * MINUTE;
  let year = anchor.getFullYear();
  let month = anchor.getMonth();
  let day = anchor.getDate();
  if (unit === "daily") day += step;
  if (unit === "monthly") {
    year += Math.floor((month + step) / 12);
    month = (month + step) % 12;
    day = Math.min(day, daysInMonth(year, month));
  }
  if (unit === "yearly") {
    year += step;
    day = Math.min(day, daysInMonth(year, month));
  }
  const date = new Date(year, month, day, anchor.getHours(), anchor.getMinutes(), anchor.getSeconds(), anchor.getMilliseconds());
  if (!Number.isFinite(date.getTime()) || date.getFullYear() > 9999) return null;
  return date.getTime();
}

export const firstOccurrence = rule => ({ index: 0, at: nextAllowed(rule.startAt, rule) });

// Derive every calendar occurrence from the original anchor (Jan 31 -> Feb 28
// -> Mar 31), and skip missed nominal occurrences without a catch-up burst.
export function nextOccurrence(rule, previousIndex, after) {
  const { unit, interval } = rule.recurrence;
  if (unit === "none") return null;
  const anchor = new Date(rule.startAt);
  const now = new Date(after);
  let estimate = 0;
  if (unit === "minutes") estimate = Math.floor((after - rule.startAt) / (interval * MINUTE));
  if (unit === "daily") estimate = Math.floor((Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()) -
    Date.UTC(anchor.getFullYear(), anchor.getMonth(), anchor.getDate())) / (DAY * interval));
  if (unit === "monthly") estimate = Math.floor(((now.getFullYear() - anchor.getFullYear()) * 12 + now.getMonth() - anchor.getMonth()) / interval);
  if (unit === "yearly") estimate = Math.floor((now.getFullYear() - anchor.getFullYear()) / interval);
  let index = Math.max(previousIndex + 1, estimate, 0);
  for (let attempts = 0; attempts < 10; attempts++, index++) {
    const nominal = occurrence(rule, index);
    if (nominal === null) return null;
    if (nominal > after) return { index, at: nextAllowed(nominal, rule) };
  }
  throw new ScheduleError("errorNoOccurrence");
}
