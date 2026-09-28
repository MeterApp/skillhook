// Jobs that did not arrive over HTTP: `skillhook run`, the MCP `run_skill` tool without a server, scheduled slots and
// replays. A leaf module (no ops/server imports) so the server, the scheduler and the replay planner can share it.
import { mkdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Config, RunnerName } from "./config.js";
import { parseFrontmatter } from "./frontmatter.js";
import { newJobId } from "./ids.js";
import type { JobRecord, JobStore } from "./jobs.js";
import { redactHeaders, type BodyKind, type Trigger, type WebhookEvent } from "./payload.js";
import type { JobAnswer, JobQuestion } from "./progress.js";
import { resolveRunSettings } from "./run.js";
import { parseSkillDocument, SkillError, type Skill } from "./skills.js";
import { errorMessage, isValidSkillName } from "./util.js";

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
  /** Use this id instead of a fresh one (an ad-hoc run names its skill directory after the job before creating it). */
  jobId?: string;
  /** The SKILL.md came with the request and lives in the job directory. */
  adhoc?: true;
  /** For `trigger: resume`: the job a person answered, the session to continue (when it has one), what was asked and answered, and why it cannot be resumed when it cannot. */
  resume?: { of: string; session?: { session_id: string; runner: RunnerName }; question?: JobQuestion; answer: JobAnswer; runnerReason?: string };
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
  const id = input.jobId ?? newJobId();
  const event = buildManualEvent(input, id);
  return store.create({
    id,
    skill: input.skill.name,
    trigger: input.trigger,
    runner: settings.runner,
    model: settings.model,
    effort: settings.effort,
    // A cwd override has to survive until the queue prepares the run; other jobs resolve it from the skill then.
    cwd: input.overrides?.cwd ? settings.cwd : undefined,
    source: { ip: input.sourceIp ?? "127.0.0.1", method: input.sourceMethod ?? "LOCAL", path: event.path, content_type: event.content_type, user_agent: event.headers["user-agent"] },
    delivery_id: input.deliveryId,
    replay_of: input.replayOf,
    adhoc: input.adhoc,
    skill_file: input.skill.file,
    resume_of: input.resume?.of,
    resume: input.resume?.session,
    question: input.resume?.question,
    answer: input.resume?.answer,
    runner_reason: input.resume?.runnerReason,
    event,
    rawBody: input.body?.raw,
  });
}

export interface AdhocRunInput {
  /** The complete SKILL.md text, frontmatter included. */
  skillMd: string;
  payload: unknown;
  headers?: Record<string, string>;
  overrides?: ManualRunInput["overrides"];
}

/**
 * A job for a SKILL.md that is not installed (`POST /skills/test`, `skillhook run --file`): the document is validated,
 * the job is created with `trigger: test`, and the file is written to `jobs/<id>/skill/<name>/SKILL.md`, where the queue
 * loads it from (the server writes nothing outside the jobs directory). Throws `SkillError` for an invalid document.
 */
export function createAdhocJob(ops: { config: Config; store: JobStore }, input: AdhocRunInput): { job: JobRecord; skill: Skill } {
  let name: unknown;
  try {
    name = parseFrontmatter(input.skillMd).data.name;
  } catch (error) {
    throw new SkillError(`Invalid SKILL.md: ${errorMessage(error)}`, "");
  }
  if (typeof name !== "string" || !isValidSkillName(name)) throw new SkillError(`SKILL.md needs a valid \`name\` (1-64 lowercase letters, digits and single hyphens)`, "");
  const id = newJobId();
  const dir = path.join(ops.store.pathsFor(id).skillDir, name);
  const skill = parseSkillDocument(input.skillMd, dir); // throws SkillError; the name matches the directory by construction
  skill.source = { type: "adhoc", job: id };
  const job = createManualJob(ops, { skill, payload: input.payload, headers: input.headers, trigger: "test", overrides: input.overrides, sourceMethod: "TEST", jobId: id, adhoc: true });
  mkdirSync(dir, { recursive: true });
  writeFileSync(skill.file, input.skillMd, { mode: 0o600 });
  skill.mtimeMs = statSync(skill.file).mtimeMs;
  return { job, skill };
}
