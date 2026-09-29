// The task-level outcome of a job: whether the skill completed what it was asked, needs a person, found nothing to
// do, or failed. Distinct from `status`, which only says how the runner process ended. Sources, in order: the
// structured answer a runner returned (`response: { mode: structured }` in the skill), else a `response.json` the
// agent wrote in the job directory (`SKILLHOOK_RESPONSE_PATH`). A shell command that exited 0 counts as completed;
// any other successful run that reported nothing is `unknown`; every other terminal status is `failed`.
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import type { RunnerName } from "./config.js";
import type { JobRecord, JobStatus } from "./jobs.js";
import type { Skill } from "./skills.js";
import { isPlainObject, truncate } from "./util.js";

export type JobOutcome = "completed" | "partial" | "needs_human" | "nothing_to_do" | "failed" | "unknown";
export const JOB_OUTCOMES: JobOutcome[] = ["completed", "partial", "needs_human", "nothing_to_do", "failed", "unknown"];
/** What an agent may report; `unknown` is what skillhook records when it reported nothing. */
export const REPORTABLE_OUTCOMES: JobOutcome[] = ["completed", "partial", "needs_human", "nothing_to_do", "failed"];

export interface JobResponse {
  outcome: JobOutcome;
  /** One paragraph for a person: what was done, what was found, what remains. */
  summary: string;
  /** URLs a person should open (pull requests, tickets, documents). */
  links?: string[];
  /** Structured details for other systems; capped inline, complete in `response.json`. */
  data?: unknown;
}

export const RESPONSE_FILE = "response.json";
export const RESPONSE_SCHEMA_FILE = "response.schema.json";
const RESPONSE_FILE_MAX = 256 * 1024;
const SUMMARY_MAX = 4000;
const LINKS_MAX = 50;
const DATA_INLINE_MAX = 64 * 1024;

/** The JSON Schema a structured run must answer with unless the skill brings its own (`response.schema`). */
export const DEFAULT_RESPONSE_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    outcome: {
      type: "string",
      enum: REPORTABLE_OUTCOMES,
      description: "completed: the task is done; partial: some of it is; needs_human: a person must decide or act before it can be finished; nothing_to_do: the event needed no action; failed: it could not be done",
    },
    summary: { type: "string", description: "One paragraph for a person: what was done, what was found, what remains" },
    links: { type: "array", items: { type: "string" }, description: "URLs a person should open (pull requests, tickets, documents)" },
    data: { type: "object", description: "Structured details for other systems", additionalProperties: true },
  },
  required: ["outcome", "summary"],
  additionalProperties: false,
};

export function responseSchemaFor(skill: Skill): Record<string, unknown> {
  return skill.config.response?.schema ?? DEFAULT_RESPONSE_SCHEMA;
}

/**
 * Turns what an agent reported (structured output or `response.json`) into a `JobResponse`. A custom schema without
 * `outcome`/`summary` keeps the whole object as `data` and takes the outcome from how the run ended.
 */
export function parseResponseObject(value: unknown, fallback: { ok: boolean; result?: string }): JobResponse | undefined {
  if (!isPlainObject(value)) return undefined;
  const standard = "outcome" in value || "summary" in value;
  const outcome = typeof value.outcome === "string" && (JOB_OUTCOMES as string[]).includes(value.outcome) ? (value.outcome as JobOutcome) : fallback.ok ? "completed" : "failed";
  const response: JobResponse = { outcome, summary: truncate(typeof value.summary === "string" ? value.summary : (fallback.result ?? ""), SUMMARY_MAX) };
  if (Array.isArray(value.links)) {
    const links = value.links.filter((link): link is string => typeof link === "string").slice(0, LINKS_MAX);
    if (links.length) response.links = links;
  }
  const data = value.data !== undefined ? value.data : standard ? undefined : value;
  if (data !== undefined) {
    const text = JSON.stringify(data);
    response.data = text !== undefined && text.length > DATA_INLINE_MAX ? { truncated: true, bytes: text.length, note: `complete in ${RESPONSE_FILE}` } : data;
  }
  return response;
}

/** The parsed `response.json` of a job directory, or undefined when absent, too large or not JSON. */
export function readResponseFile(jobDir: string): unknown {
  const file = path.join(jobDir, RESPONSE_FILE);
  try {
    if (!existsSync(file) || statSync(file).size > RESPONSE_FILE_MAX) return undefined;
    return JSON.parse(readFileSync(file, "utf8")) as unknown;
  } catch {
    return undefined;
  }
}

export function resolveJobResponse(input: { jobDir: string; structured?: unknown; ok: boolean; result?: string }): JobResponse | undefined {
  const raw = input.structured !== undefined ? input.structured : readResponseFile(input.jobDir);
  return parseResponseObject(raw, { ok: input.ok, result: input.result });
}

/** The outcome to record for a job that reached `status`; undefined while it is still queued or running. */
export function deriveOutcome(status: JobStatus, runner: RunnerName, response?: JobResponse): JobOutcome | undefined {
  if (status === "queued" || status === "running") return undefined;
  if (status !== "succeeded") return "failed";
  return response?.outcome ?? (runner === "shell" ? "completed" : "unknown");
}

/** A job's outcome, derived for records written before outcomes existed. */
export function jobOutcome(job: Pick<JobRecord, "status" | "runner" | "outcome" | "response">): JobOutcome | undefined {
  return job.outcome ?? deriveOutcome(job.status, job.runner, job.response);
}
