// The task-level outcome of a job: whether the skill completed what it was asked, needs a person, found nothing to
// do, or failed. Distinct from `status`, which only says how the runner process ended. Sources, in order: the
// structured answer a runner returned (`response: { mode: structured }` in the skill), else a `response.json` the
// agent wrote in the job directory (`SKILLHOOK_RESPONSE_PATH`). A shell command that exited 0 counts as completed;
// any other successful run that reported nothing is `unknown`; every other terminal status is `failed`.
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import type { RunnerName } from "./config.js";
import type { JobRecord, JobStatus } from "./jobs.js";
import { cleanLine, HEADLINE_MAX, LINK_KIND_DESCRIPTIONS, LINK_KINDS, normalizeChoices, normalizeLinks, OPTIONS_MAX, TITLE_MAX, type ResponseLink } from "./reporting.js";
import type { Skill } from "./skills.js";
import { isPlainObject, truncate } from "./util.js";

export type JobOutcome = "completed" | "partial" | "needs_human" | "nothing_to_do" | "failed" | "unknown";
export const JOB_OUTCOMES: JobOutcome[] = ["completed", "partial", "needs_human", "nothing_to_do", "failed", "unknown"];
/** What an agent may report; `unknown` is what skillhook records when it reported nothing. */
export const REPORTABLE_OUTCOMES: JobOutcome[] = ["completed", "partial", "needs_human", "nothing_to_do", "failed"];

export interface JobResponse {
  outcome: JobOutcome;
  /** What the job was about, in a few words ("Fix the 500 on /api/sync"); shown instead of the skill's name. Becomes `job.title`. */
  title?: string;
  /** The result in one line, at most 280 characters: what a person sees first in a list. */
  headline?: string;
  /** One paragraph (Markdown welcome) for a person: what was done, what was found, what remains. */
  summary: string;
  /** Where to look: bare URLs, or `{url, title, kind}` (the event's source, pull requests, tickets, messages, documents, deployments, how to test). */
  links?: ResponseLink[];
  /** With `needs_human`: what the person can pick from (Skillhook Cloud shows buttons); the pick resumes the session. */
  options?: string[];
  /** The option the agent suggests. */
  recommended?: string;
  /** The person may pick several options. */
  multiple?: boolean;
  /** Structured details for other systems; capped inline, complete in `response.json`. */
  data?: unknown;
}

export const RESPONSE_FILE = "response.json";
export const RESPONSE_SCHEMA_FILE = "response.schema.json";
const RESPONSE_FILE_MAX = 256 * 1024;
const SUMMARY_MAX = 4000;
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
    title: { type: "string", maxLength: TITLE_MAX, description: "What this job was about, in a few words (shown instead of the skill's name)" },
    headline: { type: "string", maxLength: HEADLINE_MAX, description: "The result in one line, for a list of jobs" },
    summary: { type: "string", description: "One paragraph for a person (Markdown): what was done, what was found, what remains" },
    links: {
      type: "array",
      description: "Where to look: the event's source, pull requests, tickets, messages, documents, deployments, how to test",
      items: {
        type: "object",
        properties: {
          url: { type: "string" },
          title: { type: "string", description: "What a person sees instead of the URL" },
          kind: { type: "string", enum: [...LINK_KINDS], description: Object.entries(LINK_KIND_DESCRIPTIONS).map(([kind, text]) => `${kind}: ${text}`).join("; ") },
        },
        required: ["url"],
        additionalProperties: false,
      },
    },
    options: { type: "array", items: { type: "string" }, maxItems: OPTIONS_MAX, description: "With needs_human: the choices a person can pick from; their pick resumes this session" },
    recommended: { type: "string", description: "The option you suggest" },
    multiple: { type: "boolean", description: "The person may pick several options" },
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
 * `outcome`/`summary` keeps the whole object as `data` and takes the outcome from how the run ended; its fields are
 * never read as a title, links or choices.
 */
export function parseResponseObject(value: unknown, fallback: { ok: boolean; result?: string }): JobResponse | undefined {
  if (!isPlainObject(value)) return undefined;
  const standard = "outcome" in value || "summary" in value;
  const outcome = typeof value.outcome === "string" && (JOB_OUTCOMES as string[]).includes(value.outcome) ? (value.outcome as JobOutcome) : fallback.ok ? "completed" : "failed";
  const summary = truncate(typeof value.summary === "string" ? value.summary : (fallback.result ?? ""), SUMMARY_MAX);
  const title = standard ? cleanLine(value.title, TITLE_MAX) : undefined;
  const headline = standard ? cleanLine(value.headline, HEADLINE_MAX) : undefined;
  const links = standard ? normalizeLinks(value.links) : undefined;
  const response: JobResponse = { outcome, ...(title ? { title } : {}), ...(headline ? { headline } : {}), summary, ...(links ? { links } : {}), ...(standard ? normalizeChoices(value) : {}) };
  const data = value.data !== undefined ? value.data : standard ? undefined : value;
  if (data !== undefined) {
    const text = JSON.stringify(data);
    response.data = text !== undefined && text.length > DATA_INLINE_MAX ? { truncated: true, bytes: text.length, note: `complete in ${RESPONSE_FILE}` } : data;
  }
  return response;
}

export interface ReportInput {
  outcome: JobOutcome;
  summary: string;
  title?: string;
  headline?: string;
  links?: unknown[];
  options?: string[];
  recommended?: string;
  multiple?: boolean;
  data?: unknown;
}

/**
 * The `response.json` the job API writes for `job_set_outcome` / `skillhook job outcome`: the same normalization as a
 * file the agent writes itself, except that `data` is kept whole (only the copy on the job record is capped).
 */
export function buildResponse(input: ReportInput): JobResponse {
  const title = cleanLine(input.title, TITLE_MAX);
  const headline = cleanLine(input.headline, HEADLINE_MAX);
  const links = normalizeLinks(input.links);
  return { outcome: input.outcome, ...(title ? { title } : {}), ...(headline ? { headline } : {}), summary: truncate(input.summary, SUMMARY_MAX), ...(links ? { links } : {}), ...normalizeChoices(input), ...(input.data !== undefined ? { data: input.data } : {}) };
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
