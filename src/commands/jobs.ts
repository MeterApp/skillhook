import { existsSync, readFileSync, statSync } from "node:fs";
import { spawn } from "node:child_process";
import { AnswerError, answerJob, type AnswerJobResult } from "../answer.js";
import { adminRequest, findRunningServer, openAdminEventStream } from "../client.js";
import { isTerminal, isWaitingForHuman, JOB_STATUSES, type JobArtifact, type JobRecord, type JobStatus } from "../jobs.js";
import { createOps, runJobLocally } from "../ops.js";
import { TRIGGERS, type Trigger } from "../payload.js";
import { readProgress, type ProgressEntry } from "../progress.js";
import { JOB_OUTCOMES, jobOutcome, type JobOutcome } from "../response.js";
import { FAILURE_KINDS, type FailureKind } from "../runners/failure.js";
import { resolveRunSettings } from "../run.js";
import { publicJob } from "../server.js";
import { sleep } from "../util.js";
import { replayCommand } from "./replay.js";
import { bool, CommandError, formatDuration, num, relativeTime, str, table, UsageError, type Ctx } from "./shared.js";

const USAGE = `Usage:
  skillhook jobs list [--skill NAME] [--status ${JOB_STATUSES.join("|")}] [--outcome ${JOB_OUTCOMES.join("|")}] [--failure ${FAILURE_KINDS.join("|")}] [--trigger ${TRIGGERS.join("|")}] [--waiting] [--since ISO] [--after ID] [--limit N]
  skillhook jobs show <id> [--result] [--response] [--prompt] [--stdout] [--stderr]
  skillhook jobs logs <id> [--follow|-f] [--stderr]
  skillhook jobs answer <id> "<answer>" [--option X] [--by NAME] [--no-resume] [--wait S]   answer the question a job asked, or a job that ended needs_human (a new job then continues its session)
  skillhook jobs cancel <id>
  skillhook jobs replay <id> [--skip-filters] [--runner R] [--model M] [--effort E] [--wait S]   run the same request again as a new job
  skillhook jobs resume <id> [--exec]      print (or run) the command that reopens the agent session
  skillhook jobs path <id>
  skillhook jobs prune [--keep N]`;

export async function jobsCommand(ctx: Ctx): Promise<number> {
  const [sub = "list", id] = ctx.args;
  const store = ctx.store();
  switch (sub) {
    case "list":
    case "ls": {
      const status = str(ctx.flags, "status") as JobStatus | undefined;
      if (status && !JOB_STATUSES.includes(status)) throw new UsageError(`--status must be one of ${JOB_STATUSES.join(", ")}`, USAGE);
      const trigger = str(ctx.flags, "trigger") as Trigger | undefined;
      if (trigger && !TRIGGERS.includes(trigger)) throw new UsageError(`--trigger must be one of ${TRIGGERS.join(", ")}`, USAGE);
      const outcome = str(ctx.flags, "outcome") as JobOutcome | undefined;
      if (outcome && !JOB_OUTCOMES.includes(outcome)) throw new UsageError(`--outcome must be one of ${JOB_OUTCOMES.join(", ")}`, USAGE);
      const since = str(ctx.flags, "since");
      if (since && Number.isNaN(Date.parse(since))) throw new UsageError("--since must be an ISO-8601 instant", USAGE);
      const failure = str(ctx.flags, "failure") as FailureKind | undefined;
      if (failure && !FAILURE_KINDS.includes(failure)) throw new UsageError(`--failure must be one of ${FAILURE_KINDS.join(", ")}`, USAGE);
      const waiting = bool(ctx.flags, "waiting") || undefined;
      const page = store.listPage({ skill: str(ctx.flags, "skill"), status, trigger, outcome, failure, waiting, since, after: str(ctx.flags, "after"), limit: num(ctx.flags, "limit") ?? 30 });
      const jobs = page.jobs;
      const rows = jobs.map((j) => [j.id, j.skill, `${j.status}${j.failure ? ` (${j.failure.kind})` : ""}`, jobOutcome(j) ?? "", isWaitingForHuman(j) ? "waiting" : (j.progress?.state ?? ""), j.runner + (j.model ? `/${j.model}` : ""), formatDuration(j.duration_ms), relativeTime(j.created_at), (isWaitingForHuman(j) && j.question ? `? ${j.question.text}` : (j.response?.summary ?? j.error ?? j.result ?? "")).split("\n")[0]?.slice(0, 60) ?? ""]);
      const human = rows.length ? `${table(rows, ["job", "skill", "status", "outcome", "human", "runner", "took", "when", "summary"])}${page.next_after ? `\n(more: --after ${page.next_after})` : ""}` : waiting ? "No job is waiting for a person" : `No jobs in ${store.jobsDir}`;
      ctx.print(human, { jobs: jobs.map(publicJob), next_after: page.next_after });
      return 0;
    }
    case "show":
    case "get": {
      const job = store.get(requireId(id));
      if (!job) throw new CommandError(`Unknown job ${id}`);
      const wanted: JobArtifact[] = (["result", "response", "prompt", "stdout", "stderr"] as const).filter((a) => bool(ctx.flags, a));
      const artifacts: Record<string, string | undefined> = {};
      for (const a of wanted) artifacts[a] = store.readArtifact(job.id, a);
      const outcome = jobOutcome(job);
      const progress = readProgress(store.pathsFor(job.id).dir, { timelineLimit: 20 });
      const lines = [
        `${job.id}  ${job.skill}  ${job.status}${outcome ? `  (${outcome})` : ""}${isWaitingForHuman(job) ? "  WAITING FOR A PERSON" : ""}`,
        ...(job.response ? [`  outcome:  ${job.response.outcome}: ${job.response.summary.split("\n")[0] ?? ""}`, ...(job.response.links?.length ? [`  links:    ${job.response.links.join(", ")}`] : [])] : []),
        ...(job.progress ? [`  progress: ${job.progress.state}: ${job.progress.message.split("\n")[0] ?? ""}${job.progress.percent !== undefined ? ` (${job.progress.percent}%)` : ""}`] : []),
        ...(job.question ? [`  question: ${job.question.text.split("\n")[0] ?? ""}${job.question.options?.length ? ` [${job.question.options.join(" | ")}]` : ""}${job.question.answered_at ? "" : "  (unanswered: skillhook jobs answer " + job.id + ' "…")'}`] : []),
        ...(job.answer ? [`  answer:   ${job.answer.option ? `${job.answer.option}: ` : ""}${job.answer.text.split("\n")[0] ?? ""}${job.answer.by ? ` (${job.answer.by})` : ""}`] : []),
        ...(job.resume_of ? [`  resumes:  job ${job.resume_of}${job.resume ? ` (session ${job.resume.session_id})` : job.runner_reason ? ` (${job.runner_reason})` : ""}`] : []),
        ...(job.resolved_by ? [`  resolved: by job ${job.resolved_by}`] : []),
        `  runner:   ${job.runner}${job.model ? ` (${job.model})` : ""}${job.effort ? ` effort=${job.effort}` : ""}${job.runner_requested ? `  (asked for ${job.runner_requested}: ${job.runner_reason ?? "fallback"})` : ""}`,
        ...(job.failure ? [`  failure:  ${job.failure.kind}${job.failure.code ? ` (${job.failure.code})` : ""}${job.failure.retryable ? ", retryable" : ""}`] : []),
        ...(job.attempts?.length ? [`  attempts: ${job.attempts.map((a, i) => `${i + 1}. ${a.runner} ${a.status}${a.failure ? ` (${a.failure.kind})` : ""}`).join("; ")}; ${job.attempts.length + 1}. ${job.runner} ${job.status}`] : []),
        `  trigger:  ${job.trigger} from ${job.source.ip}${job.source.user_agent ? ` (${job.source.user_agent})` : ""}`,
        `  created:  ${job.created_at}${job.duration_ms !== undefined ? `  took ${formatDuration(job.duration_ms)}` : ""}`,
        ...(job.replay_of ? [`  replays:  ${[job.replay_of.delivery ? `delivery ${job.replay_of.delivery}` : "", job.replay_of.job ? `job ${job.replay_of.job}` : ""].filter(Boolean).join(", ")}`] : []),
        ...(job.cwd ? [`  cwd:      ${job.cwd}`] : []),
        ...(job.cost_usd !== undefined ? [`  cost:     $${job.cost_usd.toFixed(4)}`] : []),
        ...(job.session_id ? [`  session:  ${job.session_id}`] : []),
        ...(job.resume_command ? [`  resume:   ${job.resume_command}`] : []),
        ...(job.error ? [`  error:    ${job.error}`] : []),
        `  dir:      ${store.pathsFor(job.id).dir}`,
        ...(progress.timeline.length ? ["", "timeline:", ...progress.timeline.map(describeEntry)] : []),
        ...(job.result && !wanted.includes("result") ? ["", "result:", job.result] : []),
        ...wanted.flatMap((a) => ["", `--- ${a} ---`, artifacts[a] ?? "(missing)"]),
      ];
      ctx.print(lines.join("\n"), { job, dir: store.pathsFor(job.id).dir, artifacts, progress });
      return 0;
    }
    case "answer": {
      const job = store.get(requireId(id));
      if (!job) throw new CommandError(`Unknown job ${id}`);
      const text = ctx.args[2];
      if (!text?.trim()) throw new UsageError("Missing the answer text", USAGE);
      const option = str(ctx.flags, "option");
      const by = str(ctx.flags, "by") ?? ctx.io.env.USER;
      const resume: "auto" | "never" = ctx.flags.resume === false ? "never" : "auto";
      const wait = num(ctx.flags, "wait");
      const running = await findRunningServer(ctx.paths);
      if (running) {
        const response = await adminRequest<Record<string, unknown>>(running.baseUrl, ctx.secrets(), `/jobs/${job.id}/answer`, { method: "POST", body: { answer: text, option, by, resume, wait: wait ?? 0 } });
        if (response.status >= 400) throw new CommandError(`Could not answer ${job.id}: ${String(response.body.error)}: ${String(response.body.message)}`);
        const resumeJob = response.body.resume_job as JobRecord | undefined;
        ctx.print(describeAnswer(String(response.body.delivered), job.id, resumeJob), { ...response.body, via: "server", base_url: running.baseUrl });
        return 0;
      }
      const ops = createOps(ctx.paths, { env: ctx.io.env, config: ctx.config() });
      let result: AnswerJobResult;
      try {
        result = answerJob(ops, { jobId: job.id, text, option, by, resume });
      } catch (error) {
        if (error instanceof AnswerError) throw new CommandError(error.message);
        throw error;
      }
      if (result.delivered === "resumed" && result.resumeJob && result.skill) {
        if (!ctx.json) ctx.warn(`▶ job ${result.resumeJob.id}: resuming ${job.id} with the answer${result.resumeJob.resume ? "" : ` (${result.resumeJob.runner_reason ?? "fresh run"})`} — ${store.pathsFor(result.resumeJob.id).dir}`);
        const finished = await runJobLocally(ops, result.resumeJob, { waitMs: wait ? wait * 1000 : undefined, timeoutSeconds: resolveRunSettings(result.skill, ops.config).timeoutSeconds });
        const human = [describeAnswer("resumed", job.id, finished), ...(finished.response ? [`outcome: ${finished.response.outcome}: ${finished.response.summary}`] : []), ...(finished.result ? ["", finished.result] : [])].join("\n");
        ctx.print(human, { ok: finished.status === "succeeded", job_id: job.id, delivered: "resumed", answer: result.answer, resume_job_id: finished.id, resume_job: publicJob(finished), job: publicJob(result.job), via: "local" });
        return finished.status === "succeeded" ? 0 : 1;
      }
      ctx.print(describeAnswer(result.delivered, job.id), { ok: true, job_id: job.id, delivered: result.delivered, answer: result.answer, resume_job_id: null, job: publicJob(result.job), via: "local" });
      return 0;
    }
    case "logs":
    case "log":
    case "tail": {
      const job = store.get(requireId(id));
      if (!job) throw new CommandError(`Unknown job ${id}`);
      const wantStderr = bool(ctx.flags, "stderr");
      const file = wantStderr ? store.pathsFor(job.id).stderr : store.pathsFor(job.id).stdout;
      const follow = bool(ctx.flags, "follow", "f");
      if (follow && !isTerminal(job.status)) {
        // A running server streams the file and the status changes as they happen; without one, poll the file below.
        const running = await findRunningServer(ctx.paths);
        if (running) {
          const streamed = await openAdminEventStream(running.baseUrl, ctx.secrets(), `/jobs/${job.id}/events?streams=${wantStderr ? "stderr" : "stdout"}`, (event) => {
            if (event.event === "stdout" || event.event === "stderr") {
              const text = JSON.parse(event.data) as string;
              ctx.io.stdout(text.endsWith("\n") ? text : `${text}\n`);
            } else if (event.event === "end") {
              const final = JSON.parse(event.data) as { status: string; error?: string };
              ctx.warn(`— job ${final.status}${final.error ? `: ${final.error}` : ""}`);
            }
          });
          if (streamed.status === 200) return 0;
        }
      }
      let offset = 0;
      const emit = () => {
        if (!existsSync(file)) return;
        const size = statSync(file).size;
        if (size > offset) {
          const text = readFileSync(file, "utf8").slice(offset);
          offset = size;
          ctx.io.stdout(text.endsWith("\n") ? text : `${text}\n`);
        }
      };
      emit();
      if (follow) {
        while (true) {
          const current = store.get(job.id);
          if (!current) break;
          await sleep(500);
          emit();
          if (isTerminal(current.status)) {
            emit();
            ctx.warn(`— job ${current.status}${current.error ? `: ${current.error}` : ""}`);
            break;
          }
        }
      }
      return 0;
    }
    case "cancel":
    case "stop": {
      const job = store.get(requireId(id));
      if (!job) throw new CommandError(`Unknown job ${id}`);
      if (isTerminal(job.status)) {
        ctx.print(`Job ${job.id} is already ${job.status}`, { ok: false, job });
        return 1;
      }
      const running = await findRunningServer(ctx.paths);
      if (!running) throw new CommandError("No running server owns this job (it may belong to a `skillhook run` process). Kill that process instead.");
      const response = await adminRequest<{ ok: boolean; status?: string }>(running.baseUrl, ctx.secrets(), `/jobs/${job.id}/cancel`, { method: "POST" });
      ctx.print(response.body.ok ? `Cancelling ${job.id}` : `Could not cancel ${job.id}: ${JSON.stringify(response.body)}`, { ...response.body, http_status: response.status });
      return response.body.ok ? 0 : 1;
    }
    case "replay":
    case "rerun":
      return replayCommand(ctx, "job", id, USAGE);
    case "resume": {
      const job = store.get(requireId(id));
      if (!job) throw new CommandError(`Unknown job ${id}`);
      if (!job.resume_command) throw new CommandError(`Job ${job.id} has no resumable session (runner ${job.runner}, status ${job.status})`);
      if (bool(ctx.flags, "exec")) {
        const child = spawn(job.resume_command, { shell: true, stdio: "inherit" });
        return await new Promise<number>((resolve) => child.on("close", (code) => resolve(code ?? 0)));
      }
      ctx.print(job.resume_command, { job_id: job.id, resume_command: job.resume_command, session_id: job.session_id, cwd: job.cwd });
      return 0;
    }
    case "path":
    case "dir": {
      const job = store.get(requireId(id));
      if (!job) throw new CommandError(`Unknown job ${id}`);
      ctx.print(store.pathsFor(job.id).dir, store.pathsFor(job.id));
      return 0;
    }
    case "prune": {
      const removed = store.prune(num(ctx.flags, "keep") ?? ctx.config().jobs.max_jobs);
      ctx.print(`Removed ${removed} old job(s)`, { ok: true, removed });
      return 0;
    }
    default:
      throw new UsageError(`Unknown jobs subcommand "${sub}"`, USAGE);
  }
}

function requireId(id: string | undefined): string {
  if (!id) throw new UsageError("Missing job id", USAGE);
  return id;
}

function describeAnswer(delivered: string, jobId: string, resumeJob?: JobRecord): string {
  if (delivered === "live") return `Answer delivered to job ${jobId}; the agent continues.`;
  if (delivered === "recorded") return `Answer recorded on job ${jobId} (not resumed).`;
  if (!resumeJob) return `Answer recorded; a new job continues ${jobId}.`;
  return `Answer recorded; job ${resumeJob.id} continues ${jobId}${resumeJob.resume ? ` in session ${resumeJob.resume.session_id}` : resumeJob.runner_reason ? ` (${resumeJob.runner_reason})` : ""}: ${resumeJob.status}${resumeJob.outcome ? ` (${resumeJob.outcome})` : ""}${resumeJob.error ? ` (${resumeJob.error})` : ""}`;
}

function describeEntry(entry: ProgressEntry): string {
  const at = entry.at.slice(11, 19);
  switch (entry.type) {
    case "progress":
      return `  ${at}  ${entry.state}${entry.percent !== undefined ? ` ${entry.percent}%` : ""}${entry.step ? ` [${entry.step}]` : ""}: ${entry.message.split("\n")[0] ?? ""}`;
    case "note":
      return `  ${at}  note: ${entry.message.split("\n")[0] ?? ""}`;
    case "question":
      return `  ${at}  asked: ${entry.text.split("\n")[0] ?? ""}${entry.options?.length ? ` [${entry.options.join(" | ")}]` : ""}`;
    case "answer":
      return `  ${at}  answered${entry.by ? ` by ${entry.by}` : ""}: ${entry.option ? `${entry.option}: ` : ""}${entry.text.split("\n")[0] ?? ""}`;
    case "outcome":
      return `  ${at}  outcome ${entry.outcome}: ${entry.summary.split("\n")[0] ?? ""}`;
    default:
      return `  ${at}  ${JSON.stringify(entry)}`;
  }
}
