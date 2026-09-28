// What a running agent tells skillhook about the task, and what a person answers back. Everything is files in the job
// directory, so it works for every runner (a shell script can write them), needs no token in the agent's
// environment, survives a restart and can be read by the CLI, the MCP tools and the server alike:
//   progress.jsonl   append-only timeline (progress, note, question, answer, outcome entries)
//   progress.json    the current state: working | blocked | waiting_human | done
//   question.json    the pending (or last) question a person was asked
//   answer.json      the answer, once a person gave one
// The queue tails progress.jsonl for running jobs and turns new entries into job.* events; `skillhook job …`,
// the per-run MCP tools (`skillhook mcp --job`) and `skillhook jobs answer` are the writers.
import { appendFileSync, closeSync, existsSync, openSync, readFileSync, readSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { randomToken } from "./ids.js";
import { isPlainObject, nowIso, sleep, truncate, writeJsonFile } from "./util.js";

export type ProgressState = "working" | "blocked" | "waiting_human" | "done";
export const PROGRESS_STATES: ProgressState[] = ["working", "blocked", "waiting_human", "done"];

export interface JobProgress {
  state: ProgressState;
  message: string;
  percent?: number;
  step?: string;
  updated_at: string;
}

export interface JobQuestion {
  id: string;
  text: string;
  options?: string[];
  /** What the person needs to know to answer (a diff, a URL, the alternatives). */
  context?: string;
  asked_at: string;
  /** Until when the agent said it would wait for a live answer. */
  wait_until?: string;
  answered_at?: string;
}

export interface JobAnswer {
  /** The question answered; absent when a person answered a job that finished with outcome `needs_human` without asking anything. */
  question_id?: string;
  text: string;
  /** One of the question's options, when the person picked one. */
  option?: string;
  by?: string;
  at: string;
}

export type ProgressEntry = { at: string } & (
  | { type: "progress"; state: "working" | "blocked"; message: string; percent?: number; step?: string }
  | { type: "note"; message: string }
  | { type: "question"; id: string; text: string; options?: string[]; context?: string; wait_until?: string }
  | { type: "answer"; question_id?: string; text: string; option?: string; by?: string }
  | { type: "outcome"; outcome: string; summary: string }
);

export const PROGRESS_LOG = "progress.jsonl";
export const PROGRESS_FILE = "progress.json";
export const QUESTION_FILE = "question.json";
export const ANSWER_FILE = "answer.json";
/** How long `ask` waits for a live answer when neither the call nor the skill says. */
export const DEFAULT_HUMAN_WAIT_SECONDS = 300;
export const MAX_HUMAN_WAIT_SECONDS = 86_400;
const MESSAGE_MAX = 2000;
const CONTEXT_MAX = 20_000;
const OPTIONS_MAX = 20;

export function progressPaths(jobDir: string): { log: string; current: string; question: string; answer: string } {
  return { log: path.join(jobDir, PROGRESS_LOG), current: path.join(jobDir, PROGRESS_FILE), question: path.join(jobDir, QUESTION_FILE), answer: path.join(jobDir, ANSWER_FILE) };
}

function append(jobDir: string, entry: ProgressEntry): ProgressEntry {
  const file = progressPaths(jobDir).log;
  if (!existsSync(file)) writeFileSync(file, "", { mode: 0o600 });
  appendFileSync(file, `${JSON.stringify(entry)}\n`);
  return entry;
}

function setCurrent(jobDir: string, progress: JobProgress): JobProgress {
  writeJsonFile(progressPaths(jobDir).current, progress);
  return progress;
}

function clean(text: string, max: number): string {
  return truncate(text.trim(), max);
}

/** `working` or `blocked` with a message: what the agent is doing right now. */
export function reportProgress(jobDir: string, input: { message: string; state?: "working" | "blocked"; percent?: number; step?: string }): JobProgress {
  const at = nowIso();
  const state = input.state ?? "working";
  const message = clean(input.message, MESSAGE_MAX);
  const percent = typeof input.percent === "number" && Number.isFinite(input.percent) ? Math.max(0, Math.min(100, Math.round(input.percent))) : undefined;
  const step = input.step ? clean(input.step, 200) : undefined;
  append(jobDir, { at, type: "progress", state, message, ...(percent !== undefined ? { percent } : {}), ...(step ? { step } : {}) });
  return setCurrent(jobDir, { state, message, ...(percent !== undefined ? { percent } : {}), ...(step ? { step } : {}), updated_at: at });
}

/** A timeline note that does not change the state. */
export function addNote(jobDir: string, message: string): ProgressEntry {
  return append(jobDir, { at: nowIso(), type: "note", message: clean(message, MESSAGE_MAX) });
}

/** Records that the agent reported an outcome (the `response.json` it wrote), for the timeline. */
export function recordOutcome(jobDir: string, outcome: string, summary: string): ProgressEntry {
  const at = nowIso();
  setCurrent(jobDir, { state: "done", message: clean(summary, MESSAGE_MAX), updated_at: at });
  return append(jobDir, { at, type: "outcome", outcome, summary: clean(summary, MESSAGE_MAX) });
}

export function readQuestion(jobDir: string): JobQuestion | undefined {
  const file = progressPaths(jobDir).question;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
    return isPlainObject(parsed) && typeof parsed.id === "string" && typeof parsed.text === "string" ? (parsed as unknown as JobQuestion) : undefined;
  } catch {
    return undefined;
  }
}

export function readAnswer(jobDir: string): JobAnswer | undefined {
  const file = progressPaths(jobDir).answer;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
    return isPlainObject(parsed) && typeof parsed.text === "string" && typeof parsed.at === "string" ? (parsed as unknown as JobAnswer) : undefined;
  } catch {
    return undefined;
  }
}

export function readCurrent(jobDir: string): JobProgress | undefined {
  try {
    const parsed = JSON.parse(readFileSync(progressPaths(jobDir).current, "utf8")) as unknown;
    return isPlainObject(parsed) && typeof parsed.state === "string" && (PROGRESS_STATES as string[]).includes(parsed.state) ? (parsed as unknown as JobProgress) : undefined;
  } catch {
    return undefined;
  }
}

/** Asks a person something: the question is written, the state becomes `waiting_human`, and any earlier answer is discarded. */
export function askQuestion(jobDir: string, input: { text: string; options?: string[]; context?: string; waitSeconds?: number }): JobQuestion {
  const at = nowIso();
  const waitSeconds = Math.min(MAX_HUMAN_WAIT_SECONDS, Math.max(0, Math.floor(input.waitSeconds ?? DEFAULT_HUMAN_WAIT_SECONDS)));
  const options = input.options?.map((option) => clean(String(option), 200)).filter(Boolean).slice(0, OPTIONS_MAX);
  const question: JobQuestion = {
    id: randomToken(8),
    text: clean(input.text, CONTEXT_MAX),
    ...(options?.length ? { options } : {}),
    ...(input.context ? { context: clean(input.context, CONTEXT_MAX) } : {}),
    asked_at: at,
    wait_until: new Date(Date.parse(at) + waitSeconds * 1000).toISOString(),
  };
  const paths = progressPaths(jobDir);
  writeJsonFile(paths.question, question);
  try {
    writeFileSync(paths.answer, "", { mode: 0o600 });
  } catch {
    /* nothing to clear */
  }
  append(jobDir, { at, type: "question", id: question.id, text: question.text, ...(question.options ? { options: question.options } : {}), ...(question.context ? { context: question.context } : {}), wait_until: question.wait_until });
  setCurrent(jobDir, { state: "waiting_human", message: truncate(question.text, MESSAGE_MAX), updated_at: at });
  return question;
}

export class NoQuestionError extends Error {
  constructor(jobDir: string) {
    super(`no question is waiting for an answer in ${jobDir}`);
    this.name = "NoQuestionError";
  }
}

/**
 * A person answers the pending question (or, with `questionId`, a specific one). With `requireQuestion` an unanswered
 * question must exist (the live path: a waiting `ask` call picks the answer up); otherwise the answer may stand alone,
 * for a job that finished with outcome `needs_human` without asking anything. The state goes back to `working`.
 */
export function answerQuestion(jobDir: string, input: { text: string; option?: string; by?: string; questionId?: string; requireQuestion?: boolean }): JobAnswer {
  const question = readQuestion(jobDir);
  const pending = question && !question.answered_at ? question : undefined;
  const questionId = input.questionId ?? pending?.id;
  if (input.requireQuestion && !questionId) throw new NoQuestionError(jobDir);
  const at = nowIso();
  const answer: JobAnswer = { ...(questionId ? { question_id: questionId } : {}), text: clean(input.text, CONTEXT_MAX), ...(input.option ? { option: clean(input.option, 200) } : {}), ...(input.by ? { by: clean(input.by, 200) } : {}), at };
  const paths = progressPaths(jobDir);
  writeJsonFile(paths.answer, answer);
  if (question && questionId && question.id === questionId) writeJsonFile(paths.question, { ...question, answered_at: at });
  append(jobDir, { at, type: "answer", ...(questionId ? { question_id: questionId } : {}), text: answer.text, ...(answer.option ? { option: answer.option } : {}), ...(answer.by ? { by: answer.by } : {}) });
  setCurrent(jobDir, { state: "working", message: `answered: ${truncate(answer.text, 200)}`, updated_at: at });
  return answer;
}

/** Polls `answer.json` until an answer to `questionId` appears, the timeout passes or `signal` aborts. */
export async function waitForAnswer(jobDir: string, questionId: string, options: { timeoutMs: number; pollMs?: number; signal?: AbortSignal }): Promise<JobAnswer | undefined> {
  const deadline = Date.now() + Math.max(0, options.timeoutMs);
  const pollMs = options.pollMs ?? 500;
  while (true) {
    const answer = readAnswer(jobDir);
    if (answer && answer.question_id === questionId) return answer;
    if (options.signal?.aborted || Date.now() >= deadline) return undefined;
    await sleep(Math.min(pollMs, Math.max(1, deadline - Date.now())));
  }
}

function parseEntry(line: string): ProgressEntry | undefined {
  try {
    const parsed = JSON.parse(line) as unknown;
    if (!isPlainObject(parsed) || typeof parsed.type !== "string" || typeof parsed.at !== "string") return undefined;
    return parsed as unknown as ProgressEntry;
  } catch {
    return undefined;
  }
}

/** New complete lines of `progress.jsonl` after byte `offset` (what the queue tails); `offset` advances past them. */
export function readTimeline(jobDir: string, offset = 0): { entries: ProgressEntry[]; offset: number } {
  const file = progressPaths(jobDir).log;
  let size: number;
  try {
    size = statSync(file).size;
  } catch {
    return { entries: [], offset };
  }
  if (size <= offset) return { entries: [], offset: size < offset ? 0 : offset };
  const fd = openSync(file, "r");
  let text: string;
  try {
    const buffer = Buffer.alloc(size - offset);
    const read = readSync(fd, buffer, 0, buffer.length, offset);
    text = buffer.subarray(0, read).toString("utf8");
  } finally {
    closeSync(fd);
  }
  const lastNewline = text.lastIndexOf("\n");
  if (lastNewline < 0) return { entries: [], offset };
  const complete = text.slice(0, lastNewline);
  const entries: ProgressEntry[] = [];
  for (const line of complete.split("\n")) {
    if (!line.trim()) continue;
    const entry = parseEntry(line);
    if (entry) entries.push(entry);
  }
  return { entries, offset: offset + Buffer.byteLength(complete) + 1 };
}

export interface ProgressReport {
  progress?: JobProgress;
  question?: JobQuestion;
  answer?: JobAnswer;
  timeline: ProgressEntry[];
}

/** Everything the files say about a job: current state, pending question, answer and the whole timeline. */
export function readProgress(jobDir: string, options: { timelineLimit?: number } = {}): ProgressReport {
  const { entries } = readTimeline(jobDir, 0);
  const limit = options.timelineLimit ?? 500;
  return { progress: readCurrent(jobDir), question: readQuestion(jobDir), answer: readAnswer(jobDir), timeline: entries.length > limit ? entries.slice(entries.length - limit) : entries };
}
