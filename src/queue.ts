import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { createWriteStream } from "node:fs";
import type { Config } from "./config.js";
import type { Secrets } from "./env.js";
import { isTerminal, type JobRecord, type JobStore } from "./jobs.js";
import type { Logger } from "./logger.js";
import { prepareRun } from "./run.js";
import type { RunnerOutcome, StreamState } from "./runners/index.js";
import type { SkillRegistry } from "./registry.js";
import type { Skill } from "./skills.js";
import { errorMessage, nowIso, tail } from "./util.js";

export interface QueueDeps {
  store: JobStore;
  config: Config;
  registry: SkillRegistry;
  secrets: () => Secrets;
  /** Secrets from the .env file only; defaults to `secrets`. */
  fileSecrets?: () => Secrets;
  logger: Logger;
}

interface Running {
  job: JobRecord;
  child?: ChildProcess;
  cancelled: boolean;
  timedOut: boolean;
}

const STDOUT_KEEP = 32 * 1024 * 1024;
const KILL_GRACE_MS = 10_000;

/**
 * In-memory FIFO with a global concurrency cap and one-at-a-time per skill by default. Jobs are
 * persisted before they are enqueued, so a crash loses nothing but the running processes.
 */
export class JobQueue extends EventEmitter {
  private queued: JobRecord[] = [];
  private running = new Map<string, Running>();
  private stopping = false;

  constructor(private readonly deps: QueueDeps) {
    super();
  }

  enqueue(job: JobRecord): void {
    this.queued.push(job);
    this.deps.logger.info("job queued", { job: job.id, skill: job.skill, runner: job.runner, position: this.queued.length });
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
      const updated = this.deps.store.update(id, { status: "cancelled", finished_at: nowIso(), error: "cancelled before it started" });
      this.deps.logger.info("job cancelled", { job: id, skill: job?.skill });
      this.emit("finished", updated);
      return true;
    }
    const running = this.running.get(id);
    if (!running) return false;
    running.cancelled = true;
    killTree(running.child, "SIGTERM");
    setTimeout(() => killTree(running.child, "SIGKILL"), KILL_GRACE_MS).unref();
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

  /** Stops starting new jobs and terminates running ones (they are marked interrupted). */
  async shutdown(): Promise<void> {
    this.stopping = true;
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

  private finish(job: JobRecord, patch: Partial<JobRecord>): void {
    this.running.delete(job.id);
    const finished_at = nowIso();
    const started = job.started_at ? Date.parse(job.started_at) : Date.parse(job.created_at);
    const updated = this.deps.store.update(job.id, { finished_at, duration_ms: Date.now() - started, pid: undefined, ...patch });
    this.deps.logger.info("job finished", { job: job.id, skill: job.skill, status: updated.status, duration_ms: updated.duration_ms, cost_usd: updated.cost_usd, error: updated.error });
    this.emit("finished", updated);
    queueMicrotask(() => this.tick());
  }

  private async execute(job: JobRecord): Promise<void> {
    const { store, config, registry, logger } = this.deps;
    const running: Running = { job, cancelled: false, timedOut: false };
    this.running.set(job.id, running);

    let skill: Skill | undefined;
    try {
      skill = registry.get(job.skill);
      if (!skill) throw new Error(`skill "${job.skill}" no longer exists`);
    } catch (error) {
      this.finish(job, { status: "failed", started_at: nowIso(), error: errorMessage(error) });
      return;
    }

    let prepared: ReturnType<typeof prepareRun>;
    try {
      prepared = prepareRun({ skill, config, secrets: this.deps.secrets(), fileSecrets: this.deps.fileSecrets?.(), store, job, event: store.readEvent(job.id) });
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

    const timer = setTimeout(() => {
      running.timedOut = true;
      logger.warn("job timed out; terminating", { job: job.id, timeout_s: ctx.timeoutSeconds });
      killTree(child, "SIGTERM");
      setTimeout(() => killTree(child, "SIGKILL"), KILL_GRACE_MS).unref();
    }, ctx.timeoutSeconds * 1000);

    const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null; error?: Error }>((resolve) => {
      child.once("error", (error) => resolve({ code: null, signal: null, error }));
      child.once("spawn", () => {
        store.update(job.id, { pid: child.pid });
        if (child.stdin) {
          child.stdin.on("error", () => {
            /* the process may exit before reading stdin */
          });
          child.stdin.end(invocation.stdin ?? "");
        }
      });
      child.once("close", (code, signal) => resolve({ code, signal }));
    });
    clearTimeout(timer);
    if (lineBuffer) feedLine(lineBuffer);
    await Promise.all([new Promise((r) => outFile.end(r)), new Promise((r) => errFile.end(r))]);

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
    this.finish(running.job, {
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
