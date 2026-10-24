import test from "node:test";
import assert from "node:assert/strict";
import { firstOccurrence, localInput, localZone, nextAllowed, nextOccurrence, normalizeRule, parseLocalDateTime } from "../extension/lib/schedule.mjs";

process.env.TZ = "Europe/Paris";
const at = value => new Date(value).getTime();
const rule = (input = {}) => normalizeRule({ startAt: at("2026-01-01T09:00:00+01:00"), ...input }, at("2025-12-31T00:00:00Z"));
const calendar = (date, unit, interval = 1) => rule({ startAt: at(date), recurrence: { unit, interval } });

test("validates future dates, integral delays, weekdays and windows", () => {
  assert.throws(() => normalizeRule({ startAt: Date.now() - 1 }), /errorFuture/);
  assert.throws(() => rule({ recurrence: { unit: "minutes", interval: 1.5 } }), /errorInterval/);
  assert.throws(() => rule({ recurrence: { unit: "weekly", interval: 1 } }), /errorInterval/);
  assert.throws(() => rule({ weekdays: [] }), /errorWeekdays/);
  assert.throws(() => rule({ weekdays: [7] }), /errorWeekdays/);
  assert.throws(() => rule({ window: { start: "25:00", end: "05:00" } }), /errorWindow/);
  assert.throws(() => rule({ window: { start: "05:00", end: "05:00" } }), /errorWindow/);
  assert.throws(() => rule({ timeZone: "America/New_York" }), /errorTimeZone/);
  assert.equal(localZone(), "Europe/Paris");
});

test("local date input rejects invalid calendar dates and missing DST hour", () => {
  assert.throws(() => parseLocalDateTime("2026-02-30T12:00"), /errorDate/);
  assert.throws(() => parseLocalDateTime("2026-03-29T02:30"), /errorDate/);
  assert.throws(() => parseLocalDateTime("bad date"), /errorDate/);
  assert.equal(localInput(parseLocalDateTime("2026-10-24T15:47")), "2026-10-24T15:47");
  assert.equal(new Date(parseLocalDateTime("2026-10-25T02:30")).getTimezoneOffset(), -120, "Ambiguous input chooses first occurrence");
});

test("one-shot scheduling and weekday gates", () => {
  const r = rule({ weekdays: [1, 2, 3, 4, 5] });
  assert.equal(firstOccurrence(r).at, r.startAt);
  assert.equal(nextOccurrence(r, 0, r.startAt), null);
  assert.equal(localInput(nextAllowed(at("2026-01-03T13:00:00+01:00"), r)), "2026-01-05T00:00");
});

test("window is inclusive at start, exclusive at end", () => {
  const r = rule({ window: { start: "01:00", end: "05:00" } });
  assert.equal(localInput(firstOccurrence(r).at), "2026-01-02T01:00");
  for (const [time, expected] of [["00:59", "2026-01-02T01:00"], ["01:00", "2026-01-02T01:00"], ["04:59", "2026-01-02T04:59"], ["05:00", "2026-01-03T01:00"]]) {
    assert.equal(localInput(nextAllowed(at(`2026-01-02T${time}:00+01:00`), r)), expected);
  }
});

test("overnight windows apply weekdays to the actual send date", () => {
  const r = rule({ weekdays: [1], window: { start: "22:00", end: "05:00" } });
  assert.equal(localInput(nextAllowed(at("2026-01-04T23:00:00+01:00"), r)), "2026-01-05T00:00");
  assert.equal(localInput(nextAllowed(at("2026-01-05T04:00:00+01:00"), r)), "2026-01-05T04:00");
  assert.equal(localInput(nextAllowed(at("2026-01-05T05:00:00+01:00"), r)), "2026-01-05T22:00");
  assert.equal(localInput(nextAllowed(at("2026-01-06T01:00:00+01:00"), r)), "2026-01-12T00:00");
});

test("monthly and yearly recurrences preserve Jan 31 and leap-day anchors", () => {
  const r = calendar("2026-01-31T09:00:00+01:00", "monthly");
  const feb = nextOccurrence(r, 0, r.startAt);
  const mar = nextOccurrence(r, feb.index, feb.at);
  assert.equal(localInput(feb.at), "2026-02-28T09:00");
  assert.equal(localInput(mar.at), "2026-03-31T09:00");
  const leap = calendar("2028-02-29T12:00:00+01:00", "yearly");
  assert.equal(localInput(nextOccurrence(leap, 0, leap.startAt).at), "2029-02-28T12:00");
  assert.equal(localInput(nextOccurrence(leap, 2, at("2031-03-01T00:00:00Z")).at), "2032-02-29T12:00");
});

test("daily repeats keep wall time through both DST changes", () => {
  const spring = calendar("2026-03-28T09:00:00+01:00", "daily");
  const next = nextOccurrence(spring, 0, spring.startAt);
  assert.equal(localInput(next.at), "2026-03-29T09:00");
  assert.equal(next.at - spring.startAt, 23 * 3600000);
  const fall = calendar("2026-10-24T09:00:00+02:00", "daily");
  assert.equal(nextOccurrence(fall, 0, fall.startAt).at - fall.startAt, 25 * 3600000);
});

test("minute repeats measure elapsed time, including DST", () => {
  const r = calendar("2026-03-29T01:50:00+01:00", "minutes", 30);
  assert.equal(localInput(nextOccurrence(r, 0, r.startAt).at), "2026-03-29T03:20");
});

test("missing DST window skips to a day when the window exists", () => {
  const r = rule({ window: { start: "02:00", end: "03:00" } });
  assert.equal(localInput(nextAllowed(at("2026-03-29T00:00:00+01:00"), r)), "2026-03-30T02:00");
});

test("missed recurrences are skipped efficiently without a catch-up burst", () => {
  const r = calendar("2026-01-01T09:00:00+01:00", "minutes");
  const later = at("2040-01-01T09:00:00+01:00");
  const next = nextOccurrence(r, 0, later);
  assert.equal(next.at, later + 60000);
  assert(next.index > 7_000_000);
});

test("constraints do not produce multiple occurrences at the same adjusted time", () => {
  const r = rule({ recurrence: { unit: "minutes", interval: 1 }, window: { start: "10:00", end: "11:00" } });
  const first = firstOccurrence(r);
  assert.equal(localInput(first.at), "2026-01-01T10:00");
  assert.equal(localInput(nextOccurrence(r, 0, first.at).at), "2026-01-01T10:01");
});
