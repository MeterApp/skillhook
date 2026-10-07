// A person answers a job. Live when the job is running and waiting (the agent's `ask` call returns the answer);
// otherwise the answer is recorded and, unless asked not to, a new job continues the agent's session with it
// (`trigger: resume`, `claude -p --resume <session>` / `codex exec resume <thread>`). A leaf module like manual.ts:
// the server, the CLI and the MCP tools all call it; the queue is only a type here.
import { copyFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import type { Config } from "./config.js";
import type { Events } from "./events.js";
import { newJobId } from "./ids.js";
import { isTerminal, isWaitingForHuman, type JobRecord, type JobStore } from "./jobs.js";
import { createManualJob } from "./manual.js";
import { answerQuestion, NoQuestionError, readQuestion, type JobAnswer, type JobQuestion } from "./progress.js";
import type { JobQueue } from "./queue.js";
import type { SkillRegistry } from "./registry.js";
import { jobOutcome } from "./response.js";
import { loadAdhocSkill, type Skill } from "./skills.js";

export type AnswerErrorCode = "unknown_job" | "not_waiting" | "unknown_skill";

export class AnswerError extends Error {
  constructor(
    public readonly code: AnswerErrorCode,
    message: string,
    public readonly status: 404 | 409,
  ) {
    super(message);
    this.name = "AnswerError";
  }
}

export interface AnswerJobInput {
  jobId: string;
  text: string;
  /** One of the question's options, when the person picked one. */
  option?: string;
  /** Who answered (a name, an email, a dashboard user), for the record and the prompt. */
  by?: string;
  /** `auto` (default): a finished job is continued by a new job; `never`: only record the answer. */
  resume?: "auto" | "never";
}

export interface AnswerJobResult {
  /** The job that was answered, as updated. */
  job: JobRecord;
  answer: JobAnswer;
  /** `live`: the waiting agent gets it now; `resumed`: `resumeJob` continues the session; `recorded`: stored only. */
  delivered: "live" | "resumed" | "recorded";
  resumeJob?: JobRecord;
  /** The skill of the resume job (what `runJobLocally` needs when no server runs it). */
  skill?: Skill;
}

type AnswerOps = { config: Config; store: JobStore; registry: SkillRegistry };

/**
 * A new job that continues `original` with a person's answer: the same skill, runner, model and working directory,
 * the original event as its payload, `resume_of` and, when the original has a session id, `resume` so the runner reopens
 * that session (`--resume` / `exec resume`) and the prompt is only the `<human_answer>` block. Without a session (a shell
 * run, a crash before the id was captured) the skill runs afresh with the answer appended, and `runner_reason` says so.
 */
export function createResumeJob(ops: { config: Config; store: JobStore }, input: { original: JobRecord; skill: Skill; answer: JobAnswer }): JobRecord {
  const { original, skill, answer } = input;
  const event = ops.store.readEvent(original.id);
  // What the person answered: the question the agent asked, or what it said it needed (and offered) when it finished with needs_human.
  const response = original.response;
  const question: JobQuestion | undefined = original.question ?? (response?.outcome === "needs_human" ? { id: "outcome", text: response.summary, ...(response.options ? { options: response.options } : {}), ...(response.recommended ? { recommended: response.recommended } : {}), ...(response.multiple ? { multiple: true } : {}), asked_at: original.finished_at ?? original.created_at } : undefined);
  const session = original.session_id && original.runner !== "shell" ? { session_id: original.session_id, runner: original.runner } : undefined;
  const runnerReason = session ? undefined : original.runner === "shell" ? "a shell run has no session to resume: the command runs again with the answer" : `job ${original.id} has no session id to resume: the skill runs again with the answer`;
  const id = newJobId();
  const job = createManualJob(ops, {
    skill,
    payload: event.payload,
    headers: { ...event.headers, "x-skillhook-resume-of": original.id },
    query: event.query,
    trigger: "resume",
    overrides: { runner: original.runner, model: original.model, effort: original.effort, cwd: original.cwd },
    sourceMethod: "RESUME",
    sourceIp: event.source_ip,
    body: { kind: event.body_kind, contentType: event.content_type },
    jobId: id,
    adhoc: original.adhoc,
    resume: { of: original.id, session, question, answer, runnerReason, title: original.title ?? response?.title },
  });
  if (original.adhoc) {
    // The ad-hoc SKILL.md travels with its job: the resume job needs its own copy for the queue to load.
    const dir = path.join(ops.store.pathsFor(id).skillDir, skill.name);
    mkdirSync(dir, { recursive: true });
    copyFileSync(skill.file, path.join(dir, "SKILL.md"));
  }
  return job;
}

function skillFor(ops: AnswerOps, job: JobRecord): Skill {
  const skill = job.adhoc ? loadAdhocSkill(ops.store.pathsFor(job.id).skillDir, job.id, job.skill) : ops.registry.get(job.skill);
  if (!skill) throw new AnswerError("unknown_skill", `skill "${job.skill}" of job ${job.id} no longer exists`, 409);
  return skill;
}

function notWaiting(job: JobRecord): AnswerError {
  return new AnswerError("not_waiting", `job ${job.id} is not waiting for a person (status ${job.status}${jobOutcome(job) ? `, outcome ${jobOutcome(job)}` : ""})`, 409);
}

/**
 * Answers a job. `queue` is the server's queue: it delivers to a job it is running and enqueues the resume job; without
 * one, a running job owned by another process (`skillhook run` in a terminal) is answered through the files that process
 * watches, and the caller runs `resumeJob` itself. Throws `AnswerError` (`unknown_job`, `not_waiting`, `unknown_skill`).
 */
export function answerJob(ops: AnswerOps, input: AnswerJobInput, options: { queue?: JobQueue; events?: Events } = {}): AnswerJobResult {
  let job = ops.store.get(input.jobId);
  if (!job) throw new AnswerError("unknown_job", `unknown job ${input.jobId}`, 404);
  const dir = ops.store.pathsFor(job.id).dir;
  if (!job.question && !options.queue?.isActive(job.id)) {
    // A question written by `skillhook job ask` that no queue recorded (the run was not watched): the files decide.
    const asked = readQuestion(dir);
    if (asked && !asked.answered_at) job = ops.store.update(job.id, { question: asked, answer: undefined });
  }
  const details = { text: input.text, option: input.option, by: input.by };
  if (options.queue?.isActive(job.id)) {
    let answer: JobAnswer | undefined;
    try {
      answer = options.queue.answer(job.id, details);
    } catch (error) {
      if (error instanceof NoQuestionError) throw notWaiting(job);
      throw error;
    }
    if (!answer) throw notWaiting(job); // queued: nothing has asked yet
    return { job: ops.store.require(job.id), answer, delivered: "live" };
  }
  if (job.status === "running") {
    if (!job.question || job.question.answered_at || job.answer) throw notWaiting(job);
    const answer = answerQuestion(dir, { ...details, questionId: job.question.id, requireQuestion: true });
    return { job: ops.store.update(job.id, { answer, question: { ...job.question, answered_at: answer.at } }), answer, delivered: "live" };
  }
  if (!isTerminal(job.status) || !isWaitingForHuman(job)) throw notWaiting(job);
  // Without a question, the choices are the ones the needs_human outcome offered.
  const answer = answerQuestion(dir, { ...details, questionId: job.question?.id, choices: job.question ? undefined : job.response });
  let updated = ops.store.update(job.id, { answer, question: job.question ? { ...job.question, answered_at: answer.at } : undefined });
  if (input.resume === "never") {
    options.events?.emit("job.answered", { job: updated, answer, delivered: "recorded" });
    return { job: updated, answer, delivered: "recorded" };
  }
  const skill = skillFor(ops, job);
  const resumeJob = createResumeJob(ops, { original: updated, skill, answer });
  updated = ops.store.update(job.id, { resolved_by: resumeJob.id });
  options.queue?.enqueue(resumeJob);
  options.events?.emit("job.answered", { job: updated, answer, delivered: "resumed", resume_job_id: resumeJob.id });
  return { job: updated, answer, delivered: "resumed", resumeJob, skill };
}
