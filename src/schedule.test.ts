import { describe, expect, it } from "vitest";
import { cronMatches, isValidTimeZone, nextRun, nextRuns, parseCron, previousRun, slotKey, zonedParts } from "./schedule.js";

const iso = (d: Date | undefined) => d?.toISOString();

describe("parseCron", () => {
  it("parses fields, ranges, steps, lists and names", () => {
    const spec = parseCron("*/15 9-17 1,15 jan-mar,dec mon-fri");
    expect([...spec.minutes]).toEqual([0, 15, 30, 45]);
    expect([...spec.hours]).toEqual([9, 10, 11, 12, 13, 14, 15, 16, 17]);
    expect([...spec.daysOfMonth]).toEqual([1, 15]);
    expect([...spec.months]).toEqual([1, 2, 3, 12]);
    expect([...spec.daysOfWeek]).toEqual([1, 2, 3, 4, 5]);
    expect(spec.domRestricted).toBe(true);
    expect(spec.dowRestricted).toBe(true);
    expect(parseCron("0 0 * * 7").daysOfWeek.has(0)).toBe(true);
    expect(parseCron("5/20 * * * *").minutes).toEqual(new Set([5, 25, 45]));
    expect(parseCron("  0   9 * * 1-5 ").text).toBe("0 9 * * 1-5");
    expect(parseCron("0 9 * * SUN,Sat").daysOfWeek).toEqual(new Set([0, 6]));
  });

  it("expands aliases", () => {
    expect(parseCron("@hourly").text).toBe("0 * * * *");
    expect(parseCron("@daily").text).toBe("0 0 * * *");
    expect(parseCron("@midnight").text).toBe("0 0 * * *");
    expect(parseCron("@weekly").text).toBe("0 0 * * 0");
    expect(parseCron("@monthly").text).toBe("0 0 1 * *");
    expect(parseCron("@yearly").text).toBe("0 0 1 1 *");
    expect(parseCron("@Annually").text).toBe("0 0 1 1 *");
  });

  it("rejects malformed expressions with a reason", () => {
    expect(() => parseCron("")).toThrow(/empty/);
    expect(() => parseCron("* * * *")).toThrow(/5 fields/);
    expect(() => parseCron("60 * * * *")).toThrow(/out of range/);
    expect(() => parseCron("* 24 * * *")).toThrow(/out of range/);
    expect(() => parseCron("* * 0 * *")).toThrow(/out of range/);
    expect(() => parseCron("* * * 13 *")).toThrow(/out of range/);
    expect(() => parseCron("* * * * 8")).toThrow(/out of range/);
    expect(() => parseCron("*/0 * * * *")).toThrow(/positive integer/);
    expect(() => parseCron("*/x * * * *")).toThrow(/positive integer/);
    expect(() => parseCron("10-5 * * * *")).toThrow(/reversed/);
    expect(() => parseCron("1,,2 * * * *")).toThrow(/empty item/);
    expect(() => parseCron("* * * * monday")).toThrow(/not a valid day of week/);
    expect(() => parseCron("@every5m")).toThrow(/5 fields/);
  });
});

describe("nextRun / previousRun in UTC", () => {
  it("finds the next minute, hour, day and month boundaries", () => {
    const after = new Date("2026-09-23T10:07:30Z");
    expect(iso(nextRun(parseCron("*/30 * * * *"), after))).toBe("2026-09-23T10:30:00.000Z");
    expect(iso(nextRun(parseCron("17 * * * *"), after))).toBe("2026-09-23T10:17:00.000Z");
    expect(iso(nextRun(parseCron("5 9 * * 1-5"), after))).toBe("2026-09-24T09:05:00.000Z");
    expect(iso(nextRun(parseCron("0 16 * * 5"), after))).toBe("2026-09-25T16:00:00.000Z");
    expect(iso(nextRun(parseCron("0 0 1 * *"), after))).toBe("2026-10-01T00:00:00.000Z");
    expect(iso(nextRun(parseCron("0 0 29 2 *"), after))).toBe("2028-02-29T00:00:00.000Z");
    expect(nextRun(parseCron("0 0 31 2 *"), after)).toBeUndefined();
  });

  it("is strictly after the given instant and ignores seconds", () => {
    const spec = parseCron("*/30 * * * *");
    expect(iso(nextRun(spec, new Date("2026-09-23T10:30:00Z")))).toBe("2026-09-23T11:00:00.000Z");
    expect(iso(nextRun(spec, new Date("2026-09-23T10:29:59.999Z")))).toBe("2026-09-23T10:30:00.000Z");
    expect(iso(previousRun(spec, new Date("2026-09-23T10:30:59Z")))).toBe("2026-09-23T10:30:00.000Z");
    expect(iso(previousRun(spec, new Date("2026-09-23T10:29:59Z")))).toBe("2026-09-23T10:00:00.000Z");
    expect(iso(previousRun(parseCron("0 16 * * 5"), new Date("2026-09-23T10:00:00Z")))).toBe("2026-09-18T16:00:00.000Z");
  });

  it("applies Vixie semantics to the two day fields", () => {
    // Both restricted: either the 15th or a Monday.
    const either = parseCron("0 12 15 * 1");
    expect(iso(nextRun(either, new Date("2026-09-13T00:00:00Z")))).toBe("2026-09-14T12:00:00.000Z"); // Monday the 14th
    expect(iso(nextRun(either, new Date("2026-09-14T13:00:00Z")))).toBe("2026-09-15T12:00:00.000Z"); // the 15th (a Tuesday)
    // Only day-of-week restricted: the 15th does not matter.
    expect(iso(nextRun(parseCron("0 12 * * 1"), new Date("2026-09-14T13:00:00Z")))).toBe("2026-09-21T12:00:00.000Z");
    expect(cronMatches(parseCron("0 12 * * 1"), zonedParts(new Date("2026-09-14T12:00:00Z")))).toBe(true);
    expect(cronMatches(parseCron("0 12 * * 1"), zonedParts(new Date("2026-09-15T12:00:00Z")))).toBe(false);
  });

  it("lists upcoming runs", () => {
    expect(nextRuns(parseCron("0 * * * *"), new Date("2026-09-23T10:07:00Z"), "UTC", 3).map(iso)).toEqual(["2026-09-23T11:00:00.000Z", "2026-09-23T12:00:00.000Z", "2026-09-23T13:00:00.000Z"]);
  });
});

describe("time zones and DST (America/New_York, 2026)", () => {
  const ny = "America/New_York";

  it("reads the expression in the zone", () => {
    // 09:05 New York on a weekday: EDT in September (UTC-4).
    expect(iso(nextRun(parseCron("5 9 * * 1-5"), new Date("2026-09-23T14:00:00Z"), ny))).toBe("2026-09-24T13:05:00.000Z");
    expect(zonedParts(new Date("2026-09-24T13:05:00Z"), ny)).toMatchObject({ year: 2026, month: 9, day: 24, hour: 9, minute: 5, weekday: 4 });
    expect(slotKey(new Date("2026-09-24T13:05:00Z"), ny)).toBe("2026-09-24T09:05");
    expect(slotKey(new Date("2026-09-24T13:05:00Z"))).toBe("2026-09-24T13:05");
  });

  it("follows the offset change across the spring-forward weekend", () => {
    // Friday 2026-03-06 (EST, UTC-5) to Monday 2026-03-09 (EDT, UTC-4).
    expect(iso(nextRun(parseCron("0 9 * * 1-5"), new Date("2026-03-06T15:00:00Z"), ny))).toBe("2026-03-09T13:00:00.000Z");
  });

  it("skips a wall-clock slot that does not exist on the spring-forward day", () => {
    // 02:30 does not happen on 2026-03-08 (clocks go 01:59 -> 03:00); the next 02:30 is on the 9th, EDT.
    expect(iso(nextRun(parseCron("30 2 * * *"), new Date("2026-03-08T05:00:00Z"), ny))).toBe("2026-03-09T06:30:00.000Z");
    // Hourly schedules simply continue: 01:30 EST, then 03:30 EDT (same instant spacing of one hour).
    expect(nextRuns(parseCron("30 * * * *"), new Date("2026-03-08T06:00:00Z"), ny, 3).map(iso)).toEqual(["2026-03-08T06:30:00.000Z", "2026-03-08T07:30:00.000Z", "2026-03-08T08:30:00.000Z"]);
  });

  it("gives the two occurrences of a fall-back slot one key", () => {
    // 01:30 happens twice on 2026-11-01: first EDT (05:30Z), then EST (06:30Z).
    const spec = parseCron("30 1 * * *");
    const first = nextRun(spec, new Date("2026-10-31T12:00:00Z"), ny) as Date;
    const second = nextRun(spec, first, ny) as Date;
    expect(iso(first)).toBe("2026-11-01T05:30:00.000Z");
    expect(iso(second)).toBe("2026-11-01T06:30:00.000Z");
    expect(slotKey(first, ny)).toBe("2026-11-01T01:30");
    expect(slotKey(second, ny)).toBe(slotKey(first, ny));
    expect(iso(nextRun(spec, second, ny))).toBe("2026-11-02T06:30:00.000Z");
  });

  it("validates zone names", () => {
    expect(isValidTimeZone("UTC")).toBe(true);
    expect(isValidTimeZone("Europe/Berlin")).toBe(true);
    expect(isValidTimeZone("Asia/Kolkata")).toBe(true);
    expect(isValidTimeZone("Mars/Olympus")).toBe(false);
    expect(isValidTimeZone("")).toBe(false);
    // Half-hour offsets step on the zone's hour boundaries, not UTC's.
    expect(iso(nextRun(parseCron("0 9 * * *"), new Date("2026-09-23T00:00:00Z"), "Asia/Kolkata"))).toBe("2026-09-23T03:30:00.000Z");
  });
});
