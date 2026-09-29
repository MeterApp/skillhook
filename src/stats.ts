// Numbers over the job records and the delivery log: how many, how they ended, how long, what they cost, per skill.
// Pure aggregation (`computeStats`) over records the caller loaded, plus `collectStats` for the store and the log.
import { DELIVERY_OUTCOMES, type DeliveryLog, type DeliveryOutcome, type DeliveryRecord } from "./delivery-log.js";
import type { RunnerName } from "./config.js";
import { isTerminal, isWaitingForHuman, JOB_STATUSES, type JobRecord, type JobStatus, type JobStore } from "./jobs.js";
import { TRIGGERS, type Trigger } from "./payload.js";
import { JOB_OUTCOMES, jobOutcome, type JobOutcome } from "./response.js";
import { FAILURE_KINDS, type FailureKind } from "./runners/failure.js";
import { isPlainObject } from "./util.js";

export interface Percentiles {
  count: number;
  p50: number;
  p95: number;
  avg: number;
  max: number;
}

export interface Tokens {
  input: number;
  output: number;
  cached_input: number;
}

export interface JobStats {
  total: number;
  /** Jobs that ended (every status but queued and running). */
  finished: number;
  queued: number;
  running: number;
  by_status: Record<JobStatus, number>;
  by_outcome: Record<JobOutcome, number>;
  by_trigger: Record<Trigger, number>;
  by_runner: Record<RunnerName, number>;
  by_failure_kind: Record<FailureKind, number>;
  /** succeeded / finished, or null without finished jobs. */
  success_rate: number | null;
  /** (completed + nothing_to_do) / finished jobs with a reported outcome (unknown excluded), or null. */
  completion_rate: number | null;
  duration_ms: Percentiles | null;
  /** From creation to start. */
  queue_wait_ms: Percentiles | null;
  cost_usd: number;
  tokens: Tokens;
  /** Jobs waiting for a person right now (an open question, or outcome needs_human nobody answered). */
  waiting_for_human: number;
}

export interface DeliveryStats {
  total: number;
  by_outcome: Record<DeliveryOutcome, number>;
  by_http_status: Record<string, number>;
  /** accepted / total, or null without deliveries. */
  accepted_rate: number | null;
  last_received_at: string | null;
}

export interface SkillStats {
  jobs: number;
  by_status: Record<JobStatus, number>;
  by_outcome: Record<JobOutcome, number>;
  success_rate: number | null;
  cost_usd: number;
  tokens: Tokens;
  duration_ms: Percentiles | null;
  deliveries: number;
  last_job: { id: string; status: JobStatus; outcome: JobOutcome | null; created_at: string } | null;
}

export interface StatsReport {
  window: { since: string | null; until: string | null; skill: string | null };
  jobs: JobStats;
  deliveries: DeliveryStats;
  skills: Record<string, SkillStats>;
  generated_at: string;
}

const RELATIVE_UNITS: Record<string, number> = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 };

/** `24h`, `7d`, `30m`, `2w` (ago) or an ISO-8601 instant, as an ISO string; undefined for anything else. */
export function parseSince(value: string | undefined, now = Date.now()): string | undefined {
  if (!value) return undefined;
  const text = value.trim();
  const unit = text.slice(-1);
  const amount = Number(text.slice(0, -1));
  if (RELATIVE_UNITS[unit] !== undefined && Number.isFinite(amount) && amount > 0 && /^\d+(\.\d+)?$/.test(text.slice(0, -1))) return new Date(now - amount * RELATIVE_UNITS[unit]).toISOString();
  const parsed = Date.parse(text);
  return Number.isNaN(parsed) ? undefined : new Date(parsed).toISOString();
}

export function percentiles(values: number[]): Percentiles | null {
  const sorted = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const at = (p: number) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))] as number;
  return { count: sorted.length, p50: at(50), p95: at(95), avg: Math.round(sorted.reduce((a, b) => a + b, 0) / sorted.length), max: sorted[sorted.length - 1] as number };
}

function counter<K extends string>(keys: K[]): Record<K, number> {
  return Object.fromEntries(keys.map((key) => [key, 0])) as Record<K, number>;
}

/** Claude reports `input_tokens`, `output_tokens`, `cache_read_input_tokens`; Codex `input_tokens`, `cached_input_tokens`, `output_tokens`. */
export function tokensOf(usage: unknown): Tokens {
  if (!isPlainObject(usage)) return { input: 0, output: 0, cached_input: 0 };
  const n = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : 0);
  return { input: n(usage.input_tokens), output: n(usage.output_tokens), cached_input: n(usage.cache_read_input_tokens) + n(usage.cached_input_tokens) };
}

function addTokens(into: Tokens, more: Tokens): void {
  into.input += more.input;
  into.output += more.output;
  into.cached_input += more.cached_input;
}

function rate(part: number, whole: number): number | null {
  return whole ? Math.round((part / whole) * 1000) / 1000 : null;
}

export interface ComputeStatsInput {
  jobs: JobRecord[];
  deliveries: DeliveryRecord[];
  since?: string;
  until?: string;
  skill?: string;
  now?: Date;
}

export function computeStats(input: ComputeStatsInput): StatsReport {
  const jobs = input.skill ? input.jobs.filter((j) => j.skill === input.skill) : input.jobs;
  const deliveries = input.skill ? input.deliveries.filter((d) => d.skill === input.skill) : input.deliveries;
  const stats: JobStats = {
    total: jobs.length,
    finished: 0,
    queued: 0,
    running: 0,
    by_status: counter(JOB_STATUSES),
    by_outcome: counter(JOB_OUTCOMES),
    by_trigger: counter(TRIGGERS),
    by_runner: counter<RunnerName>(["claude", "codex", "shell"]),
    by_failure_kind: counter(FAILURE_KINDS),
    success_rate: null,
    completion_rate: null,
    duration_ms: null,
    queue_wait_ms: null,
    cost_usd: 0,
    tokens: { input: 0, output: 0, cached_input: 0 },
    waiting_for_human: 0,
  };
  const durations: number[] = [];
  const waits: number[] = [];
  const skills = new Map<string, { jobs: JobRecord[]; deliveries: number }>();
  for (const job of jobs) {
    stats.by_status[job.status]++;
    if (job.status === "queued") stats.queued++;
    else if (job.status === "running") stats.running++;
    else stats.finished++;
    const outcome = jobOutcome(job);
    if (outcome) stats.by_outcome[outcome]++;
    if (stats.by_trigger[job.trigger] !== undefined) stats.by_trigger[job.trigger]++;
    if (stats.by_runner[job.runner] !== undefined) stats.by_runner[job.runner]++;
    if (job.failure && stats.by_failure_kind[job.failure.kind] !== undefined) stats.by_failure_kind[job.failure.kind]++;
    if (typeof job.duration_ms === "number" && isTerminal(job.status)) durations.push(job.duration_ms);
    if (job.started_at) {
      const wait = Date.parse(job.started_at) - Date.parse(job.created_at);
      if (Number.isFinite(wait) && wait >= 0) waits.push(wait);
    }
    if (typeof job.cost_usd === "number") stats.cost_usd += job.cost_usd;
    addTokens(stats.tokens, tokensOf(job.usage));
    if (isWaitingForHuman(job)) stats.waiting_for_human++;
    const entry = skills.get(job.skill) ?? { jobs: [], deliveries: 0 };
    entry.jobs.push(job);
    skills.set(job.skill, entry);
  }
  stats.success_rate = rate(stats.by_status.succeeded, stats.finished);
  const reported = stats.finished - stats.by_outcome.unknown;
  stats.completion_rate = rate(stats.by_outcome.completed + stats.by_outcome.nothing_to_do, reported);
  stats.duration_ms = percentiles(durations);
  stats.queue_wait_ms = percentiles(waits);
  stats.cost_usd = Math.round(stats.cost_usd * 10_000) / 10_000;

  const deliveryStats: DeliveryStats = { total: deliveries.length, by_outcome: counter(DELIVERY_OUTCOMES), by_http_status: {}, accepted_rate: null, last_received_at: null };
  for (const delivery of deliveries) {
    if (deliveryStats.by_outcome[delivery.outcome] !== undefined) deliveryStats.by_outcome[delivery.outcome]++;
    const status = String(delivery.http_status);
    deliveryStats.by_http_status[status] = (deliveryStats.by_http_status[status] ?? 0) + 1;
    if (!deliveryStats.last_received_at || delivery.received_at > deliveryStats.last_received_at) deliveryStats.last_received_at = delivery.received_at;
    const entry = skills.get(delivery.skill) ?? { jobs: [], deliveries: 0 };
    entry.deliveries++;
    skills.set(delivery.skill, entry);
  }
  deliveryStats.accepted_rate = rate(deliveryStats.by_outcome.accepted, deliveries.length);

  const perSkill: Record<string, SkillStats> = {};
  for (const [name, entry] of [...skills.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const s: SkillStats = { jobs: entry.jobs.length, by_status: counter(JOB_STATUSES), by_outcome: counter(JOB_OUTCOMES), success_rate: null, cost_usd: 0, tokens: { input: 0, output: 0, cached_input: 0 }, duration_ms: null, deliveries: entry.deliveries, last_job: null };
    const skillDurations: number[] = [];
    let finished = 0;
    for (const job of entry.jobs) {
      s.by_status[job.status]++;
      if (isTerminal(job.status)) finished++;
      const outcome = jobOutcome(job);
      if (outcome) s.by_outcome[outcome]++;
      if (typeof job.duration_ms === "number" && isTerminal(job.status)) skillDurations.push(job.duration_ms);
      if (typeof job.cost_usd === "number") s.cost_usd += job.cost_usd;
      addTokens(s.tokens, tokensOf(job.usage));
      if (!s.last_job || job.created_at > s.last_job.created_at) s.last_job = { id: job.id, status: job.status, outcome: outcome ?? null, created_at: job.created_at };
    }
    s.success_rate = rate(s.by_status.succeeded, finished);
    s.cost_usd = Math.round(s.cost_usd * 10_000) / 10_000;
    s.duration_ms = percentiles(skillDurations);
    perSkill[name] = s;
  }

  return { window: { since: input.since ?? null, until: input.until ?? null, skill: input.skill ?? null }, jobs: stats, deliveries: deliveryStats, skills: perSkill, generated_at: (input.now ?? new Date()).toISOString() };
}

export interface StatsQuery {
  /** ISO-8601 (use `parseSince` for `24h`-style values first). */
  since?: string;
  until?: string;
  skill?: string;
  /** At most this many jobs and deliveries are read (default 5000, newest first). */
  limit?: number;
}

/** The report over what is on disk: the job directories and the delivery log, newest first, capped by `limit`. */
export function collectStats(store: JobStore, deliveryLog: DeliveryLog | undefined, query: StatsQuery = {}): StatsReport {
  const limit = query.limit ?? 5000;
  const jobs = store.list({ since: query.since, until: query.until, skill: query.skill, limit });
  const deliveries = deliveryLog ? deliveryLog.list({ since: query.since, skill: query.skill, limit }).deliveries.filter((d) => !query.until || d.received_at <= query.until) : [];
  return computeStats({ jobs, deliveries, since: query.since, until: query.until, skill: query.skill });
}

function ms(value: number): string {
  if (value < 1000) return `${value}ms`;
  if (value < 60_000) return `${(value / 1000).toFixed(1)}s`;
  const minutes = Math.floor(value / 60_000);
  const seconds = Math.round((value % 60_000) / 1000);
  return `${minutes}m${seconds ? ` ${seconds}s` : ""}`;
}

function pct(value: number | null): string {
  return value === null ? "n/a" : `${Math.round(value * 100)}%`;
}

function nonZero(record: Record<string, number>): string {
  const parts = Object.entries(record).filter(([, n]) => n > 0).map(([k, n]) => `${k} ${n}`);
  return parts.length ? parts.join(" · ") : "none";
}

function tokens(t: Tokens): string {
  const k = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 100_000 ? 0 : 1)}k` : String(n));
  return `in ${k(t.input)} / out ${k(t.output)} / cached ${k(t.cached_input)}`;
}

export function formatStats(report: StatsReport): string {
  const { jobs, deliveries } = report;
  const window = [report.window.since ? `since ${report.window.since}` : "all time", report.window.until ? `until ${report.window.until}` : "", report.window.skill ? `skill ${report.window.skill}` : ""].filter(Boolean).join(", ");
  const lines = [
    `jobs (${window}): ${jobs.total} total · ${nonZero(jobs.by_status)} · success ${pct(jobs.success_rate)}`,
    `outcomes: ${nonZero(jobs.by_outcome)} · completion ${pct(jobs.completion_rate)}${jobs.waiting_for_human ? ` · ${jobs.waiting_for_human} waiting for a person` : ""}`,
    `runners: ${nonZero(jobs.by_runner)} · triggers: ${nonZero(jobs.by_trigger)}`,
    ...(Object.values(jobs.by_failure_kind).some((n) => n > 0) ? [`failures: ${nonZero(jobs.by_failure_kind)}`] : []),
    ...(jobs.duration_ms ? [`duration: p50 ${ms(jobs.duration_ms.p50)} · p95 ${ms(jobs.duration_ms.p95)} · max ${ms(jobs.duration_ms.max)}${jobs.queue_wait_ms ? ` · queue wait p50 ${ms(jobs.queue_wait_ms.p50)}` : ""}`] : []),
    `cost: $${jobs.cost_usd.toFixed(4)} · tokens ${tokens(jobs.tokens)}`,
    `deliveries: ${deliveries.total} total · ${nonZero(deliveries.by_outcome)} · accepted ${pct(deliveries.accepted_rate)}${deliveries.last_received_at ? ` · last ${deliveries.last_received_at}` : ""}`,
  ];
  const names = Object.keys(report.skills);
  if (names.length) {
    lines.push("", "by skill:");
    const width = Math.max(...names.map((n) => n.length));
    for (const name of names) {
      const s = report.skills[name]!;
      lines.push(`  ${name.padEnd(width)}  ${s.jobs} job(s), ${s.deliveries} deliverie(s), success ${pct(s.success_rate)}, ${nonZero(s.by_outcome)}, $${s.cost_usd.toFixed(4)}${s.duration_ms ? `, p50 ${ms(s.duration_ms.p50)}` : ""}${s.last_job ? `, last ${s.last_job.status}${s.last_job.outcome ? ` (${s.last_job.outcome})` : ""} ${s.last_job.created_at}` : ""}`);
    }
  }
  return lines.join("\n");
}
