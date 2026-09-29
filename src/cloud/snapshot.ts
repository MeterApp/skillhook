// The periodic picture of a machine the cloud keeps: skills, projects, schedules, the effective configuration, the
// latest health and readiness answers, a day of stats. Everything is what the admin API would say; nothing from `.env`.
import type { Config } from "../config.js";
import type { DeliveryLog } from "../delivery-log.js";
import type { Secrets } from "../env.js";
import type { HealthCache } from "../health.js";
import type { JobStore } from "../jobs.js";
import type { ReadinessCache } from "../readiness.js";
import type { SkillRegistry } from "../registry.js";
import type { ScheduleStatus } from "../scheduler.js";
import { skillSummary, type ServerState } from "../server.js";
import { collectStats, parseSince } from "../stats.js";
import { scrubSecrets, secretValues } from "./redact.js";
import { RUNNER_NAMES, type Snapshot } from "./protocol.js";

export interface SnapshotDeps {
  config: Config;
  secrets: () => Secrets;
  /** The `.env` values, for scrubbing. */
  fileSecrets: () => Secrets;
  registry: SkillRegistry;
  store: JobStore;
  deliveryLog?: DeliveryLog;
  schedules?: () => ScheduleStatus[];
  health?: HealthCache;
  readiness?: ReadinessCache;
  serverState?: () => ServerState | undefined;
}

export function buildSnapshot(deps: SnapshotDeps): Snapshot {
  const secrets = deps.secrets();
  const loaded = deps.registry.list();
  const state = deps.serverState?.();
  const health = deps.health?.last();
  const readiness = deps.readiness ? RUNNER_NAMES.map((runner) => deps.readiness?.last(runner)).filter((r): r is NonNullable<typeof r> => Boolean(r)) : [];
  let stats: Record<string, unknown> | undefined;
  try {
    stats = collectStats(deps.store, deps.deliveryLog, { since: parseSince("24h"), limit: 2000 }) as unknown as Record<string, unknown>;
  } catch {
    stats = undefined;
  }
  const snapshot: Snapshot = {
    ...(state ? { server: { started_at: state.started_at, version: state.version, host: state.host, port: state.port, ...(state.public_url ? { public_url: state.public_url } : {}) } } : {}),
    skills: loaded.skills.map((skill) => skillSummary(skill, deps.config, secrets) as Snapshot["skills"][number]),
    skill_errors: loaded.errors.map((e) => ({ name: e.name, error: e.error })),
    projects: loaded.projects.map((p) => ({ dir: p.dir, file: p.file, hooks: p.hooks.map((h) => h.name), ...(p.error ? { error: p.error } : {}), ...(p.errors.length ? { errors: p.errors.map((e) => ({ name: e.name, error: e.error })) } : {}) })),
    schedules: (deps.schedules?.() ?? []) as unknown as Snapshot["schedules"],
    config: deps.config as unknown as Record<string, unknown>,
    ...(health ? { health: { ok: health.ok, summary: health.summary, generated_at: health.generated_at, deep: health.deep, groups: health.groups } } : {}),
    ...(readiness.length ? { runners: readiness as unknown as Snapshot["runners"] } : {}),
    ...(stats ? { stats } : {}),
  };
  return scrubSecrets(snapshot, secretValues(deps.fileSecrets()));
}
