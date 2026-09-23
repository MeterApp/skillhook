// Cron expressions for `schedule:`: parsing, and the next or previous occurrence in an IANA time zone, with
// node built-ins only. Five fields (minute hour day-of-month month day-of-week) or the usual `@aliases`, Vixie
// semantics for the two day fields (when both are restricted a date matches if either does). Occurrences are
// found by stepping through wall-clock minutes of the zone (Intl.DateTimeFormat), so DST behaves like a wall
// clock: a slot that does not exist on a spring-forward day is skipped, and a slot that exists twice on a
// fall-back day has one `slotKey`, which the scheduler uses to fire it once.

export interface CronSpec {
  /** The expression, aliases expanded, whitespace normalized. */
  text: string;
  minutes: Set<number>;
  hours: Set<number>;
  daysOfMonth: Set<number>;
  /** 1-12 */
  months: Set<number>;
  /** 0 (Sunday) to 6 (Saturday); `7` in the expression means Sunday too. */
  daysOfWeek: Set<number>;
  domRestricted: boolean;
  dowRestricted: boolean;
}

export class CronError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CronError";
  }
}

const ALIASES: Record<string, string> = {
  "@hourly": "0 * * * *",
  "@daily": "0 0 * * *",
  "@midnight": "0 0 * * *",
  "@weekly": "0 0 * * 0",
  "@monthly": "0 0 1 * *",
  "@yearly": "0 0 1 1 *",
  "@annually": "0 0 1 1 *",
};
export const CRON_ALIASES = Object.keys(ALIASES);

const MONTH_NAMES = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const DAY_NAMES = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

interface FieldDef {
  name: string;
  min: number;
  max: number;
  /** Three-letter names accepted instead of numbers; the index maps to `min`. */
  names?: string[];
}

const FIELDS: FieldDef[] = [
  { name: "minute", min: 0, max: 59 },
  { name: "hour", min: 0, max: 23 },
  { name: "day of month", min: 1, max: 31 },
  { name: "month", min: 1, max: 12, names: MONTH_NAMES },
  { name: "day of week", min: 0, max: 7, names: DAY_NAMES },
];

function parseValue(token: string, def: FieldDef): number {
  if (def.names) {
    const index = def.names.indexOf(token.toLowerCase());
    if (index >= 0) return def.min + index;
  }
  if (!/^\d{1,2}$/.test(token)) throw new CronError(`"${token}" is not a valid ${def.name}`);
  const value = Number(token);
  if (value < def.min || value > def.max) throw new CronError(`${def.name} ${value} is out of range ${def.min}-${def.max}`);
  return value;
}

function parseField(field: string, def: FieldDef): { values: Set<number>; restricted: boolean } {
  const values = new Set<number>();
  let restricted = true;
  for (const part of field.split(",")) {
    if (part === "") throw new CronError(`empty item in the ${def.name} field "${field}"`);
    const slash = part.indexOf("/");
    const rangeText = slash === -1 ? part : part.slice(0, slash);
    const stepText = slash === -1 ? undefined : part.slice(slash + 1);
    if (stepText !== undefined && !/^\d+$/.test(stepText)) throw new CronError(`step "${stepText}" in the ${def.name} field must be a positive integer`);
    const step = stepText === undefined ? 1 : Number(stepText);
    if (step < 1) throw new CronError(`step "${stepText}" in the ${def.name} field must be a positive integer`);
    let low: number;
    let high: number;
    if (rangeText === "*") {
      low = def.min;
      high = def.max;
      if (stepText === undefined) restricted = false;
    } else {
      const dash = rangeText.indexOf("-");
      if (dash === -1) {
        low = parseValue(rangeText, def);
        high = stepText === undefined ? low : def.max;
      } else {
        low = parseValue(rangeText.slice(0, dash), def);
        high = parseValue(rangeText.slice(dash + 1), def);
        if (high < low) throw new CronError(`range "${rangeText}" in the ${def.name} field is reversed`);
      }
    }
    for (let value = low; value <= high; value += step) values.add(value);
  }
  return { values, restricted };
}

/** Parses a five-field cron expression or an alias (`@hourly`, `@daily`, `@midnight`, `@weekly`, `@monthly`, `@yearly`). Throws `CronError`. */
export function parseCron(text: string): CronSpec {
  if (typeof text !== "string" || !text.trim()) throw new CronError("cron expression is empty");
  const trimmed = text.trim().replace(/\s+/g, " ");
  const expanded = ALIASES[trimmed.toLowerCase()] ?? trimmed;
  const fields = expanded.split(" ");
  if (fields.length !== 5) throw new CronError(`"${text}" needs 5 fields (minute hour day-of-month month day-of-week) or an alias such as @hourly or @daily`);
  const [minute, hour, dom, month, dow] = fields as [string, string, string, string, string];
  const minutes = parseField(minute, FIELDS[0] as FieldDef);
  const hours = parseField(hour, FIELDS[1] as FieldDef);
  const daysOfMonth = parseField(dom, FIELDS[2] as FieldDef);
  const months = parseField(month, FIELDS[3] as FieldDef);
  const daysOfWeek = parseField(dow, FIELDS[4] as FieldDef);
  if (daysOfWeek.values.has(7)) {
    daysOfWeek.values.delete(7);
    daysOfWeek.values.add(0);
  }
  return {
    text: expanded,
    minutes: minutes.values,
    hours: hours.values,
    daysOfMonth: daysOfMonth.values,
    months: months.values,
    daysOfWeek: daysOfWeek.values,
    domRestricted: daysOfMonth.restricted,
    dowRestricted: daysOfWeek.restricted,
  };
}

// ---------------------------------------------------------------------------
// Wall-clock time in a zone
// ---------------------------------------------------------------------------

export interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  /** 0 = Sunday */
  weekday: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  const cached = formatters.get(timeZone);
  if (cached) return cached;
  const formatter = new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", weekday: "short" });
  formatters.set(timeZone, formatter);
  return formatter;
}

export function isValidTimeZone(timeZone: string): boolean {
  try {
    formatterFor(timeZone);
    return true;
  } catch {
    return false;
  }
}

export function zonedParts(date: Date, timeZone = "UTC"): ZonedParts {
  const parts = formatterFor(timeZone).formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? "";
  return {
    year: Number(get("year")),
    month: Number(get("month")),
    day: Number(get("day")),
    hour: Number(get("hour")) % 24,
    minute: Number(get("minute")),
    weekday: Math.max(0, DAY_NAMES.indexOf(get("weekday").toLowerCase().slice(0, 3))),
  };
}

/** `2026-11-01T01:30`: the wall-clock minute of an instant in the zone. Two instants on a fall-back day can share one key. */
export function slotKey(date: Date, timeZone = "UTC"): string {
  const p = zonedParts(date, timeZone);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}`;
}

function dayMatches(spec: CronSpec, p: ZonedParts): boolean {
  if (!spec.months.has(p.month)) return false;
  const dom = spec.daysOfMonth.has(p.day);
  const dow = spec.daysOfWeek.has(p.weekday);
  if (spec.domRestricted && spec.dowRestricted) return dom || dow;
  if (spec.domRestricted) return dom;
  if (spec.dowRestricted) return dow;
  return true;
}

/** True when the wall-clock minute matches the expression. */
export function cronMatches(spec: CronSpec, p: ZonedParts): boolean {
  return spec.minutes.has(p.minute) && spec.hours.has(p.hour) && dayMatches(spec, p);
}

const MINUTE_MS = 60_000;
/** Enough hour boundaries for about five years; an expression that never matches (`0 0 31 2 *`) gives up here. */
const MAX_STEPS = 5 * 366 * 25;

function floorMinute(date: Date): number {
  return Math.floor(date.getTime() / MINUTE_MS) * MINUTE_MS;
}

/** The first occurrence strictly after `after`, or undefined when there is none within about five years. */
export function nextRun(spec: CronSpec, after: Date, timeZone = "UTC"): Date | undefined {
  let t = floorMinute(after) + MINUTE_MS;
  for (let i = 0; i < MAX_STEPS; i++) {
    const p = zonedParts(new Date(t), timeZone);
    if (!dayMatches(spec, p) || !spec.hours.has(p.hour)) {
      // Nothing later in this wall-clock hour can match; jump to the next hour boundary of the zone.
      t += (60 - p.minute) * MINUTE_MS;
      continue;
    }
    if (!spec.minutes.has(p.minute)) {
      t += MINUTE_MS;
      continue;
    }
    return new Date(t);
  }
  return undefined;
}

/** The last occurrence at or before `before`, or undefined. */
export function previousRun(spec: CronSpec, before: Date, timeZone = "UTC"): Date | undefined {
  let t = floorMinute(before);
  for (let i = 0; i < MAX_STEPS; i++) {
    const p = zonedParts(new Date(t), timeZone);
    if (!dayMatches(spec, p) || !spec.hours.has(p.hour)) {
      // Back to the last minute of the previous wall-clock hour.
      t -= (p.minute + 1) * MINUTE_MS;
      continue;
    }
    if (!spec.minutes.has(p.minute)) {
      t -= MINUTE_MS;
      continue;
    }
    return new Date(t);
  }
  return undefined;
}

/** The next `count` occurrences after `after`. */
export function nextRuns(spec: CronSpec, after: Date, timeZone = "UTC", count = 5): Date[] {
  const out: Date[] = [];
  let cursor = after;
  while (out.length < count) {
    const next = nextRun(spec, cursor, timeZone);
    if (!next) break;
    out.push(next);
    cursor = next;
  }
  return out;
}
