// Replaying what the server already received: a delivery from the delivery log (accepted or not) or an earlier job,
// through the skill as it is now. Signatures are not checked again (they were, or the delivery was rejected and needs
// `force`), `when` filters apply unless skipped, and nothing is de-duplicated: a replay is a new job with
// `trigger: replay` and `replay_of` pointing at the original.
import { existsSync, readFileSync } from "node:fs";
import type { Config } from "./config.js";
import type { DeliveryLog, DeliveryRecord } from "./delivery-log.js";
import { describeCondition, evaluateConditions } from "./filters.js";
import type { JobRecord, JobStore } from "./jobs.js";
import type { ManualRunInput } from "./manual.js";
import { parseBody, type BodyKind } from "./payload.js";
import type { SkillRegistry } from "./registry.js";
import type { RunOverrides } from "./run.js";
import type { Skill } from "./skills.js";
import { errorMessage } from "./util.js";

export interface ReplayInput {
  source: "delivery" | "job";
  id: string;
  /** Run even when the skill's `when` conditions do not match the original request. */
  skipFilters?: boolean;
  /** Replay a delivery that was rejected (or failed with an error), whose body was therefore never verified. */
  force?: boolean;
  overrides?: RunOverrides;
}

export type ReplayErrorCode = "unknown_delivery" | "unknown_job" | "unknown_skill" | "replay_needs_force" | "no_body";

export class ReplayError extends Error {
  constructor(
    public readonly code: ReplayErrorCode,
    message: string,
    public readonly status: 404 | 409,
  ) {
    super(message);
    this.name = "ReplayError";
  }
}

export interface ReplayOrigin {
  delivery?: DeliveryRecord;
  job?: JobRecord;
}

export type ReplayPlan = { ok: true; skill: Skill; input: ManualRunInput; origin: ReplayOrigin } | { ok: false; skipped: true; reason: string; skill: Skill; origin: ReplayOrigin };

export interface ReplayDeps {
  config: Config;
  store: JobStore;
  registry: SkillRegistry;
  deliveryLog?: DeliveryLog;
}

/** `{delivery, job}` ids of what a plan replays, for responses. */
export function replayOfFor(origin: ReplayOrigin): { delivery?: string; job?: string } {
  return { ...(origin.delivery ? { delivery: origin.delivery.id } : {}), ...(origin.job ? { job: origin.job.id } : {}) };
}

export function planReplay(deps: ReplayDeps, input: ReplayInput): ReplayPlan {
  const origin: ReplayOrigin = {};
  let job: JobRecord | undefined;
  if (input.source === "delivery") {
    const delivery = deps.deliveryLog?.get(input.id);
    if (!delivery) throw new ReplayError("unknown_delivery", `unknown delivery ${input.id}`, 404);
    origin.delivery = delivery;
    if ((delivery.outcome === "rejected" || delivery.outcome === "error") && !input.force) {
      throw new ReplayError("replay_needs_force", `delivery ${delivery.id} was ${delivery.outcome} (${delivery.code ?? delivery.http_status}), so its body was never verified; pass force to replay it anyway`, 409);
    }
    if (delivery.job_id) job = deps.store.get(delivery.job_id);
  } else {
    job = deps.store.get(input.id);
    if (!job) throw new ReplayError("unknown_job", `unknown job ${input.id}`, 404);
  }
  if (job) origin.job = job;
  const skillName = job?.skill ?? (origin.delivery as DeliveryRecord).skill;
  let skill: Skill | undefined;
  try {
    skill = deps.registry.get(skillName);
  } catch (error) {
    throw new ReplayError("unknown_skill", `skill "${skillName}" cannot be loaded: ${errorMessage(error)}`, 404);
  }
  if (!skill || !skill.enabled) throw new ReplayError("unknown_skill", `skill "${skillName}" is not installed or is disabled`, 404);

  let payload: unknown;
  let kind: BodyKind;
  let headers: Record<string, string>;
  let query: Record<string, string>;
  let contentType: string | null;
  let raw: Buffer | undefined;
  let sourceIp: string;
  if (job) {
    const event = deps.store.readEvent(job.id);
    payload = event.payload;
    kind = event.body_kind;
    headers = event.headers;
    query = event.query;
    contentType = event.content_type;
    sourceIp = event.source_ip;
    const bodyFile = deps.store.pathsFor(job.id).body;
    if (kind === "binary" && existsSync(bodyFile)) raw = readFileSync(bodyFile);
  } else {
    const delivery = origin.delivery as DeliveryRecord;
    const stored = deps.deliveryLog?.readBody(delivery.id);
    if (!stored) throw new ReplayError("no_body", `delivery ${delivery.id} has no stored body to replay (deliveries.store_bodies was off, or the record was compacted away)`, 409);
    if (stored.truncated) throw new ReplayError("no_body", `the stored body of delivery ${delivery.id} was cut at deliveries.body_max_bytes and cannot be replayed whole`, 409);
    const parsed = parseBody(delivery.content_type ?? undefined, stored.bytes);
    payload = parsed.payload;
    kind = parsed.kind;
    headers = delivery.headers;
    query = delivery.query;
    contentType = delivery.content_type;
    sourceIp = delivery.ip;
    if (kind === "binary") raw = stored.bytes;
  }
  if (!input.skipFilters) {
    const filter = evaluateConditions(skill.config.when, { payload, headers, query });
    if (!filter.ok) return { ok: false, skipped: true, reason: `${describeCondition(filter.condition)}: ${filter.reason}`, skill, origin };
  }
  const originId = input.source === "delivery" ? input.id : (job as JobRecord).id;
  const runInput: ManualRunInput = {
    skill,
    payload,
    headers: { ...headers, "x-skillhook-replay-of": originId },
    query,
    trigger: "replay",
    overrides: input.overrides,
    sourceMethod: "REPLAY",
    sourceIp,
    replayOf: replayOfFor(origin),
    body: { kind, contentType, raw },
  };
  return { ok: true, skill, input: runInput, origin };
}
