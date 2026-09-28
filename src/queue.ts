import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { createWriteStream, existsSync } from "node:fs";
import type { Config } from "./config.js";
import type { Secrets } from "./env.js";
import { Events } from "./events.js";
import { isTerminal, type JobRecord, type JobStore } from "./jobs.js";
import type { Logger } from "./logger.js";
import { answerQuestion, readTimeline, type JobAnswer, type JobQuestion, type ProgressEntry } from "./progress.js";
import { deriveOutcome, resolveJobResponse } from "./response.js";
import { prepareRun } from "./run.js";
import type { RunnerOutcome, StreamState } from "./runners/index.js";
import type { SkillRegistry } from "./registry.js";
import { loadAdhocSkill, type Skill } from "./skills.js";
import { errorMessage, nowIso, tail, truncate, writeJsonFile } from "./util.js";

export interface QueueDeps {
  store: JobStore;
  config: Config;
  registry: SkillRegistry;
  secrets: () => Secrets;
  /** Secrets from the .env file only; defaults to `secrets`. */
  fileSecrets?: () => Secrets;
  logger: Logger;
  /** Where `job.*` events are published; the server's bus in `serve`, a private one otherwise. */
  events?: Events;
  /** The environment runs are built from (default `process.env`); tests pass their own. */
  processEnv?: NodeJS.ProcessEnv;
  /** How often the progress files of running jobs are read (default 1000 ms). */
  progressPollMs?: number;
}

interface Running {
  job: JobRecord;
  child?: ChildProcess;
  cancelled: boolean;
  timedOut: boolean;
  /** Bytes of `progress.jsonl` already turned into record updates and events. */
  progressOffset: number;
  /** The timeout clock, once the process runs: paused while the agent waits for a person. */
  clock?: { pause(waitUntil?: string): void; resume(): void };
}

const STDOUT_KEEP = 32 * 1024 * 1024;
const KILL_GRACE_MS = 10_000;
/** How often the progress files of running jobs are read. */
const PROGRESS_POLL_MS = 1000;
/** Slack after a question's `wait_until` before the timeout clock restarts by itself (the agent should have given up by then). */
const WAIT_GRACE_MS = 30_000;

/**
 * In-memory FIFO with a global concurrency cap and one-at-a-time per skill by default. Jobs are
 * persisted before they are enqueued, so a crash loses nothing but the running processes.
 */
export class JobQueue extends EventEmitter {
  private queued: JobRecord[] = [];
  private running = new Map<string, Running>();
  private stopping = false;
  private watcher?: NodeJS.Timeout;
  /** Typed `job.*` events (`job.queued`, `job.started`, `job.updated`, `job.cancelled`, `job.finished`). */
  readonly events: Events;

  constructor(private readonly deps: QueueDeps) {
    super();
    // Every `?wait=` request adds a `finished` listener; Node would warn past ten of them.
    this.setMaxListeners(0);
    this.events = deps.events ?? new Events(deps.logger);
  }

  enqueue(job: JobRecord): void {
    this.queued.push(job);
    this.deps.logger.info("job queued", { job: job.id, skill: job.skill, runner: job.runner, position: this.queued.length });
    this.events.emit("job.queued", { job });
    queueMicrotask(() => this.tick());
  }

  stats(): { running: number; queued: number; running_ids: string[] } {
    return { running: this.running.size, queued: this.queued.length, running_ids: [...this.running.keys()] };
  }

  isActive(id: string): boolean {
    return this.running.has(id) || this.queued.some((j) => j.id === id);
  }

  /** The running (preferred) or queued job of this skill, if any: what `schedule.overlap: skip` looks at. */
  inFlight(skill: string): JobRecord | undefined {
    for (const running of this.running.values()) if (running.job.skill === skill) return running.job;
    return this.queued.find((job) => job.skill === skill);
  }

  /** The running (preferred) or queued job of this skill with the same delivery fingerprint, if any. */
  findInFlight(skill: string, fingerprint: string): JobRecord | undefined {
    for (const running of this.running.values()) if (running.job.skill === skill && running.job.fingerprint === fingerprint) return running.job;
    return this.queued.find((job) => job.skill === skill && job.fingerprint === fingerprint);
  }

  cancel(id: string): boolean {
    const queuedIndex = this.queued.findIndex((j) => j.id === id);
    if (queuedIndex >= 0) {
      const [job] = this.queued.splice(queuedIndex, 1);
      const updated = this.deps.store.update(id, { status: "cancelled", finished_at: nowIso(), error: "cancelled before it started", outcome: "failed" });
      this.deps.logger.info("job cancelled", { job: id, skill: job?.skill });
      this.events.emit("job.cancelled", { job: updated, state: "queued" });
      this.emit("finished", updated);
      this.events.emit("job.finished", { job: updated });
      return true;
    }
    const running = this.running.get(id);
    if (!running) return false;
    running.cancelled = true;
    killTree(running.child, "SIGTERM");
    setTimeout(() => killTree(running.child, "SIGKILL"), KILL_GRACE_MS).unref();
    this.events.emit("job.cancelled", { job: running.job, state: "running" });
    return true;
  }

  /** Resolves with the final record, or the current one when the timeout elapses first. */
  waitFor(id: string, timeoutMs: number): Promise<JobRecord | undefined> {
    const current = this.deps.store.get(id);
    if (!current) return Promise.resolve(undefined);
    if (isTerminal(current.status)) return Promise.resolve(current);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.off("finished", onFinished);
        resolve(this.deps.store.get(id));
      }, timeoutMs);
      const onFinished = (job: JobRecord) => {
        if (job.id !== id) return;
        clearTimeout(timer);
        this.off("finished", onFinished);
        resolve(job);
      };
      this.on("finished", onFinished);
    });
  }

  /**
   * A person answers the question a running job is waiting on: the files are written (the agent's `ask` call picks them
   * up), the record and the timeout clock are updated and `job.answered` is emitted. Undefined when this queue does not
   * run the job; `NoQuestionError` when it is not waiting for anyone.
   */
  answer(id: string, input: { text: string; option?: string; by?: string }): JobAnswer | undefined {
    const running = this.running.get(id);
    if (!running) return undefined;
    this.readProgress(running); // catch up first, so a question the watcher has not seen yet is answered, not overwritten
    const answer = answerQuestion(this.deps.store.pathsFor(id).dir, { ...input, requireQuestion: true });
    this.recordAnswer(running, answer);
    this.events.emit("job.answered", { job: running.job, answer, delivered: "live" });
    return answer;
  }

  /** Stops starting new jobs and terminates running ones (they are marked interrupted). */
  async shutdown(): Promise<void> {
    this.stopping = true;
    if (this.watcher) clearInterval(this.watcher);
    this.watcher = undefined;
    for (const running of this.running.values()) {
      running.cancelled = true;
      killTree(running.child, "SIGTERM");
    }
    const deadline = Date.now() + KILL_GRACE_MS;
    while (this.running.size > 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
    for (const running of this.running.values()) killTree(running.child, "SIGKILL");
  }

  private perSkillLimit(skillName: string): number {
    try {
      return this.deps.registry.get(skillName)?.config.concurrency ?? 1;
    } catch {
      return 1;
    }
  }

  private tick(): void {
    if (this.stopping) return;
    while (this.running.size < this.deps.config.concurrency) {
      const index = this.queued.findIndex((job) => {
        const runningForSkill = [...this.running.values()].filter((r) => r.job.skill === job.skill).length;
        return runningForSkill < this.perSkillLimit(job.skill);
      });
      if (index < 0) break;
      const [job] = this.queued.splice(index, 1);
      if (job) void this.execute(job);
    }
  }

  private ensureWatcher(): void {
    if (this.watcher) return;
    this.watcher = setInterval(() => {
      for (const running of this.running.values()) this.readProgress(running);
      if (this.running.size === 0 && this.watcher) {
        clearInterval(this.watcher);
        this.watcher = undefined;
      }
    }, this.deps.progressPollMs ?? PROGRESS_POLL_MS);
    this.watcher.unref();
  }

  /** Turns the new lines of a running job's `progress.jsonl` into record updates and `job.*` events. */
  private readProgress(running: Running): void {
    if (running.job.status !== "running") return;
    const dir = this.deps.store.pathsFor(running.job.id).dir;
    let read: ReturnType<typeof readTimeline>;
    try {
      read = readTimeline(dir, running.progressOffset);
    } catch {
      return;
    }
    running.progressOffset = read.offset;
    for (const entry of read.entries) {
      try {
        this.applyProgress(running, entry);
      } catch (error) {
        this.deps.logger.warn("could not record progress", { job: running.job.id, type: entry.type, error: errorMessage(error) });
      }
    }
  }

  private applyProgress(running: Running, entry: ProgressEntry): void {
    const { store, logger } = this.deps;
    const id = running.job.id;
    switch (entry.type) {
      case "progress":
        running.job = store.update(id, { progress: { state: entry.state, message: entry.message, ...(entry.percent !== undefined ? { percent: entry.percent } : {}), ...(entry.step ? { step: entry.step } : {}), updated_at: entry.at } });
        this.events.emit("job.progress", { job: running.job, entry });
        break;
      case "note":
        this.events.emit("job.progress", { job: running.job, entry });
        break;
      case "outcome":
        running.job = store.update(id, { progress: { state: "done", message: entry.summary, updated_at: entry.at } });
        this.events.emit("job.progress", { job: running.job, entry });
        break;
      case "question": {
        const question: JobQuestion = { id: entry.id, text: entry.text, ...(entry.options ? { options: entry.options } : {}), ...(entry.context ? { context: entry.context } : {}), asked_at: entry.at, ...(entry.wait_until ? { wait_until: entry.wait_until } : {}) };
        running.job = store.update(id, { question, answer: undefined, progress: { state: "waiting_human", message: entry.text, updated_at: entry.at } });
        running.clock?.pause(entry.wait_until);
        logger.info("job waiting for a person", { job: id, skill: running.job.skill, question: truncate(entry.text, 200) });
        this.events.emit("job.waiting_human", { job: running.job, question });
        break;
      }
      case "answer": {
        const known = running.job.answer;
        if (known && known.at === entry.at && known.question_id === entry.question_id) break; // recorded by answer() already
        const answer: JobAnswer = { ...(entry.question_id ? { question_id: entry.question_id } : {}), text: entry.text, ...(entry.option ? { option: entry.option } : {}), ...(entry.by ? { by: entry.by } : {}), at: entry.at };
        this.recordAnswer(running, answer);
        this.events.emit("job.answered", { job: running.job, answer, delivered: "live" });
        break;
      }
      default:
        break;
    }
  }

  private recordAnswer(running: Running, answer: JobAnswer): void {
    const question = running.job.question && running.job.question.id === answer.question_id ? { ...running.job.question, answered_at: answer.at } : running.job.question;
    running.job = this.deps.store.update(running.job.id, { answer, question, progress: { state: "working", message: `answered: ${truncate(answer.text, 200)}`, updated_at: answer.at } });
    running.clock?.resume();
  }

  private finish(job: JobRecord, patch: Partial<JobRecord>): void {
    this.running.delete(job.id);
    const finished_at = nowIso();
    const started = job.started_at ? Date.parse(job.started_at) : Date.parse(job.created_at);
    const outcome = patch.outcome ?? deriveOutcome(patch.status ?? job.status, job.runner, patch.response ?? job.response);
    const updated = this.deps.store.update(job.id, { finished_at, duration_ms: Date.now() - started, pid: undefined, outcome, ...patch });
    this.deps.logger.info("job finished", { job: job.id, skill: job.skill, status: updated.status, duration_ms: updated.duration_ms, cost_usd: updated.cost_usd, error: updated.error });
    this.emit("finished", updated);
    this.events.emit("job.finished", { job: updated });
    queueMicrotask(() => this.tick());
  }

  private async execute(job: JobRecord): Promise<void> {
    const { store, config, registry, logger } = this.deps;
    const running: Running = { job, cancelled: false, timedOut: false, progressOffset: 0 };
    this.running.set(job.id, running);
    this.ensureWatcher();

    let skill: Skill | undefined;
    try {
      // An ad-hoc job carries its own SKILL.md; everything else is looked up as it is now.
      skill = job.adhoc ? loadAdhocSkill(store.pathsFor(job.id).skillDir, job.id, job.skill) : registry.get(job.skill);
      if (!skill) throw new Error(`skill "${job.skill}" no longer exists`);
    } catch (error) {
      this.finish(job, { status: "failed", started_at: nowIso(), error: errorMessage(error) });
      return;
    }

    let prepared: ReturnType<typeof prepareRun>;
    try {
      prepared = prepareRun({ skill, config, secrets: this.deps.secrets(), fileSecrets: this.deps.fileSecrets?.(), store, job, event: store.readEvent(job.id), cwd: job.cwd, processEnv: this.deps.processEnv });
    } catch (error) {
      this.finish(job, { status: "failed", started_at: nowIso(), error: errorMessage(error) });
      return;
    }

    const { runner, ctx, invocation } = prepared;
    const paths = store.pathsFor(job.id);
    running.job = store.update(job.id, {
      status: "running",
      started_at: nowIso(),
      cwd: invocation.cwd,
      command: [invocation.command, ...invocation.args],
      model: ctx.model,
      effort: ctx.effort,
    });
    logger.info("job started", { job: job.id, skill: job.skill, runner: runner.name, model: ctx.model, cwd: invocation.cwd, timeout_s: ctx.timeoutSeconds });
    this.events.emit("job.started", { job: running.job });

    let child: ChildProcess;
    try {
      child = spawn(invocation.command, invocation.args, { cwd: invocation.cwd, env: invocation.env, stdio: ["pipe", "pipe", "pipe"], detached: process.platform !== "win32" });
    } catch (error) {
      this.finish(running.job, { status: "failed", error: `failed to start ${invocation.command}: ${errorMessage(error)}` });
      return;
    }
    running.child = child;

    const state: StreamState = {};
    let stdout = "";
    let stderr = "";
    let lineBuffer = "";
    const outFile = createWriteStream(paths.stdout, { mode: 0o600 });
    const errFile = createWriteStream(paths.stderr, { mode: 0o600 });

    const feedLine = (line: string) => {
      if (!runner.onLine) return;
      try {
        runner.onLine(line, state);
      } catch {
        /* ignore parser errors */
      }
      if (state.sessionId && !running.job.session_id) {
        running.job = store.update(job.id, { session_id: state.sessionId, resume_command: runner.resumeCommand?.(state.sessionId, invocation.cwd) });
        this.events.emit("job.updated", { job: running.job, fields: ["session_id", "resume_command"] });
      }
    };

    child.stdout?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      outFile.write(chunk);
      stdout = tail(stdout + text, STDOUT_KEEP);
      lineBuffer += text;
      let newline = lineBuffer.indexOf("\n");
      while (newline >= 0) {
        feedLine(lineBuffer.slice(0, newline));
        lineBuffer = lineBuffer.slice(newline + 1);
        newline = lineBuffer.indexOf("\n");
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      errFile.write(chunk);
      stderr = tail(stderr + chunk.toString("utf8"), 1024 * 1024);
    });

    // The timeout clock: it stops while the agent waits for a person (a question in progress.jsonl) and restarts with
    // the remaining time on the answer, or by itself once the question's wait_until (plus a little slack) has passed.
    let remainingMs = ctx.timeoutSeconds * 1000;
    let armedAt = 0;
    let timer: NodeJS.Timeout | undefined;
    let waitGuard: NodeJS.Timeout | undefined;
    const fire = () => {
      timer = undefined;
      running.timedOut = true;
      logger.warn("job timed out; terminating", { job: job.id, timeout_s: ctx.timeoutSeconds });
      killTree(child, "SIGTERM");
      setTimeout(() => killTree(child, "SIGKILL"), KILL_GRACE_MS).unref();
    };
    const arm = () => {
      if (timer || running.timedOut) return;
      if (remainingMs <= 0) return fire();
      armedAt = Date.now();
      timer = setTimeout(fire, remainingMs);
    };
    const disarm = () => {
      if (!timer) return;
      clearTimeout(timer);
      timer = undefined;
      remainingMs = Math.max(0, remainingMs - (Date.now() - armedAt));
    };
    running.clock = {
      pause(waitUntil) {
        disarm();
        if (waitGuard) clearTimeout(waitGuard);
        const until = waitUntil ? Date.parse(waitUntil) : Number.NaN;
        waitGuard = setTimeout(arm, (Number.isFinite(until) ? Math.max(0, until - Date.now()) : 0) + WAIT_GRACE_MS);
        waitGuard.unref();
      },
      resume() {
        if (waitGuard) clearTimeout(waitGuard);
        waitGuard = undefined;
        arm();
      },
    };
    arm();

    const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null; error?: Error }>((resolve) => {
      child.once("error", (error) => resolve({ code: null, signal: null, error }));
      child.once("spawn", () => {
        running.job = store.update(job.id, { pid: child.pid });
        this.events.emit("job.updated", { job: running.job, fields: ["pid"] });
        if (child.stdin) {
          child.stdin.on("error", () => {
            /* the process may exit before reading stdin */
          });
          child.stdin.end(invocation.stdin ?? "");
        }
      });
      child.once("close", (code, signal) => resolve({ code, signal }));
    });
    disarm();
    if (waitGuard) clearTimeout(waitGuard);
    running.clock = undefined;
    if (lineBuffer) feedLine(lineBuffer);
    await Promise.all([new Promise((r) => outFile.end(r)), new Promise((r) => errFile.end(r))]);
    this.readProgress(running); // the last progress lines, before the record is final

    if (exit.error) {
      this.finish(running.job, { status: "failed", error: `failed to start ${invocation.command}: ${exit.error.message}` });
      return;
    }

    let outcome: RunnerOutcome;
    try {
      outcome = runner.parse({ stdout, stderr, exitCode: exit.code, signal: exit.signal, state }, ctx);
    } catch (error) {
      outcome = { ok: false, error: `failed to parse runner output: ${errorMessage(error)}` };
    }
    const status = running.timedOut ? "timed_out" : running.cancelled ? (this.stopping ? "interrupted" : "cancelled") : outcome.ok ? "succeeded" : "failed";
    const error =
      status === "timed_out" ? `timed out after ${ctx.timeoutSeconds}s` : status === "cancelled" ? "cancelled" : status === "interrupted" ? "server shut down while the job was running" : outcome.error;
    const sessionId = outcome.sessionId ?? state.sessionId ?? running.job.session_id;
    // A structured answer becomes response.json too, so the artifact exists whichever way the agent reported.
    if (outcome.structuredOutput !== undefined && !existsSync(paths.response)) {
      try {
        writeJsonFile(paths.response, outcome.structuredOutput);
      } catch (error) {
        logger.warn("could not write response.json", { job: job.id, error: errorMessage(error) });
      }
    }
    const response = resolveJobResponse({ jobDir: paths.dir, structured: outcome.structuredOutput, ok: outcome.ok, result: outcome.result });
    // A run that ends with its question unanswered and nothing reported is waiting for that answer: a person can give it later.
    const questionPending = running.job.question !== undefined && !running.job.question.answered_at && !running.job.answer;
    const outcomeOverride = status === "succeeded" && !response && questionPending ? ("needs_human" as const) : undefined;
    this.finish(running.job, {
      ...(outcomeOverride ? { outcome: outcomeOverride } : {}),
      status,
      exit_code: exit.code,
      signal: exit.signal,
      session_id: sessionId,
      resume_command: sessionId ? runner.resumeCommand?.(sessionId, invocation.cwd) : undefined,
      cost_usd: outcome.costUsd,
      usage: outcome.usage,
      num_turns: outcome.numTurns,
      result: outcome.result,
      error,
      response,
    });
  }
}

export function killTree(child: ChildProcess | undefined, signal: NodeJS.Signals): void {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
  try {
    if (process.platform !== "win32") process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      /* already gone */
    }
  }
}
