// Jobs that did not arrive over HTTP: `skillhook run`, the MCP `run_skill` tool without a server, scheduled slots and
// replays. A leaf module (no ops/server imports) so the server, the scheduler and the replay planner can share it.
import type { Config, RunnerName } from "./config.js";
import { newJobId } from "./ids.js";
import type { JobRecord, JobStore } from "./jobs.js";
import { redactHeaders, type BodyKind, type Trigger, type WebhookEvent } from "./payload.js";
import { resolveRunSettings } from "./run.js";
import type { Skill } from "./skills.js";

export interface ManualRunInput {
  skill: Skill;
  payload: unknown;
  headers?: Record<string, string>;
  query?: Record<string, string>;
  trigger: Trigger;
  overrides?: { runner?: RunnerName; model?: string; effort?: string; cwd?: string };
  /** Recorded on the job and the event; the caller is responsible for `rememberDelivery`. The scheduler uses `schedule:<slot>`. */
  deliveryId?: string;
  /** `source.method` on the job (default `LOCAL`; the scheduler writes `SCHEDULE`, replays `REPLAY`). */
  sourceMethod?: string;
  /** `source.ip` and `event.source_ip` (default `127.0.0.1`; a replay keeps the original sender's). */
  sourceIp?: string;
  /** What this run replays, when it is a replay. */
  replayOf?: { delivery?: string; job?: string };
  /** The body as originally received, when it should be reproduced exactly (kind, content type, raw bytes for binary bodies). */
  body?: { kind: BodyKind; contentType: string | null; raw?: Buffer };
}

export function buildManualEvent(input: ManualRunInput, id = newJobId()): WebhookEvent {
  const headers = { "content-type": typeof input.payload === "string" ? "text/plain" : "application/json", "user-agent": `skillhook-${input.trigger}`, ...(input.headers ?? {}) };
  const body = typeof input.payload === "string" ? input.payload : JSON.stringify(input.payload ?? null);
  return {
    id,
    skill: input.skill.name,
    trigger: input.trigger,
    received_at: new Date().toISOString(),
    method: "POST",
    path: `/hooks/${input.skill.name}`,
    query: input.query ?? {},
    headers: redactHeaders(headers),
    source_ip: input.sourceIp ?? "127.0.0.1",
    content_type: input.body ? input.body.contentType : headers["content-type"],
    content_length: input.body?.raw?.length ?? Buffer.byteLength(body),
    body_kind: input.body?.kind ?? (typeof input.payload === "string" ? "text" : "json"),
    delivery_id: input.deliveryId,
    payload: input.payload,
  };
}

/** Creates (but does not enqueue) a job for a run that did not arrive over HTTP. Needs only the config and the job store, so the scheduler can call it with the server's own instances. */
export function createManualJob(ops: { config: Config; store: JobStore }, input: ManualRunInput, store = ops.store): JobRecord {
  const settings = resolveRunSettings(input.skill, ops.config, input.overrides);
  const id = newJobId();
  const event = buildManualEvent(input, id);
  return store.create({
    id,
    skill: input.skill.name,
    trigger: input.trigger,
    runner: settings.runner,
    model: settings.model,
    effort: settings.effort,
    source: { ip: input.sourceIp ?? "127.0.0.1", method: input.sourceMethod ?? "LOCAL", path: event.path, content_type: event.content_type, user_agent: event.headers["user-agent"] },
    delivery_id: input.deliveryId,
    replay_of: input.replayOf,
    event,
    rawBody: input.body?.raw,
  });
}
