// The agent-facing side of the job API: `skillhook job progress|ask|outcome|note|context`, run by the agent (or a shell
// skill) inside a job, which it finds through SKILLHOOK_JOB_ID / SKILLHOOK_JOB_DIR (the runners set both) or `--job`.
// Every subcommand writes the progress files of the job directory; the server (or `skillhook run`) watches them.
// Anything else under `skillhook job …` is the operator's `skillhook jobs …`.
import { existsSync } from "node:fs";
import path from "node:path";
import { addNote, askQuestion, DEFAULT_HUMAN_WAIT_SECONDS, MAX_HUMAN_WAIT_SECONDS, readProgress, recordOutcome, reportProgress, waitForAnswer } from "../progress.js";
import { REPORTABLE_OUTCOMES, RESPONSE_FILE, type JobOutcome, type JobResponse } from "../response.js";
import { readJsonFileOr, writeJsonFile } from "../util.js";
import { jobsCommand, JOBS_USAGE } from "./jobs.js";
import { CommandError, list, num, str, UsageError, type Ctx } from "./shared.js";

export const JOB_USAGE = `Usage (inside a run; the job comes from $SKILLHOOK_JOB_ID and $SKILLHOOK_JOB_DIR, or --job <id>):
  skillhook job progress "<what you are doing>" [--state working|blocked] [--percent N] [--step NAME]
  skillhook job ask "<question>" [--option A]... [--context TEXT] [--wait SECONDS]   wait for a person's answer; prints JSON, exit 3 when none came
  skillhook job outcome <${REPORTABLE_OUTCOMES.join("|")}> [--summary TEXT] [--link URL]... [--data JSON]
  skillhook job note "<text>"
  skillhook job context

Any other subcommand, or none, is the operator's skillhook jobs (skillhook jobs --help).`;

const AGENT_SUBCOMMANDS = new Set(["progress", "ask", "outcome", "note", "context"]);
/** `skillhook job ask` exits with this when the wait ends without an answer. */
export const NO_ANSWER_EXIT_CODE = 3;

/** What `skillhook job … --help` prints: this usage for the agent's subcommands (or none), the `jobs` usage for the rest. */
export function jobUsage(args: string[]): string {
  const [sub] = args;
  return sub && !AGENT_SUBCOMMANDS.has(sub) ? JOBS_USAGE : JOB_USAGE;
}

export async function jobCommand(ctx: Ctx): Promise<number> {
  const [sub, first] = ctx.args;
  if (!sub || !AGENT_SUBCOMMANDS.has(sub)) return jobsCommand(ctx);
  const { id, dir } = resolveJob(ctx);
  switch (sub) {
    case "progress": {
      if (!first) throw new UsageError("Missing the progress message", JOB_USAGE);
      const state = str(ctx.flags, "state");
      if (state && state !== "working" && state !== "blocked") throw new UsageError("--state must be working or blocked", JOB_USAGE);
      const progress = reportProgress(dir, { message: first, state: state as "working" | "blocked" | undefined, percent: num(ctx.flags, "percent"), step: str(ctx.flags, "step") });
      ctx.print(`${progress.state}: ${progress.message}`, { ok: true, job_id: id, progress });
      return 0;
    }
    case "ask": {
      if (!first) throw new UsageError("Missing the question", JOB_USAGE);
      const envWait = Number(ctx.io.env.SKILLHOOK_HUMAN_WAIT_SECONDS);
      const wait = Math.min(MAX_HUMAN_WAIT_SECONDS, Math.max(0, num(ctx.flags, "wait") ?? (Number.isFinite(envWait) && envWait > 0 ? envWait : DEFAULT_HUMAN_WAIT_SECONDS)));
      const question = askQuestion(dir, { text: first, options: list(ctx.flags, "option"), context: str(ctx.flags, "context"), waitSeconds: wait });
      const answer = await waitForAnswer(dir, question.id, { timeoutMs: wait * 1000 });
      // The agent reads this from its shell: always JSON, whatever the flags.
      const data = answer
        ? { answered: true, question_id: question.id, answer: answer.text, option: answer.option ?? null, by: answer.by ?? null, answered_at: answer.at }
        : { answered: false, question_id: question.id, waited_seconds: wait, hint: 'No answer arrived in time. Finish with outcome "needs_human" and say exactly what is needed: a person can answer later and the session is resumed with the answer.' };
      ctx.io.stdout(`${JSON.stringify(data, null, 2)}\n`);
      return answer ? 0 : NO_ANSWER_EXIT_CODE;
    }
    case "outcome": {
      const outcome = first as JobOutcome | undefined;
      if (!outcome || !REPORTABLE_OUTCOMES.includes(outcome)) throw new UsageError(`The outcome must be one of ${REPORTABLE_OUTCOMES.join(", ")}`, JOB_USAGE);
      const summary = str(ctx.flags, "summary") ?? ctx.args[2] ?? "";
      const links = list(ctx.flags, "link");
      let data: unknown;
      const rawData = str(ctx.flags, "data");
      if (rawData !== undefined) {
        try {
          data = JSON.parse(rawData) as unknown;
        } catch {
          throw new UsageError("--data must be JSON", JOB_USAGE);
        }
      }
      const response: JobResponse = { outcome, summary, ...(links.length ? { links } : {}), ...(data !== undefined ? { data } : {}) };
      const file = path.join(dir, RESPONSE_FILE);
      writeJsonFile(file, response);
      recordOutcome(dir, outcome, summary);
      ctx.print(`Recorded outcome ${outcome}${summary ? `: ${summary}` : ""}`, { ok: true, job_id: id, response, path: file });
      return 0;
    }
    case "note": {
      if (!first) throw new UsageError("Missing the note", JOB_USAGE);
      const entry = addNote(dir, first);
      ctx.print(`Noted: ${first}`, { ok: true, job_id: id, entry });
      return 0;
    }
    case "context": {
      const job = readJsonFileOr<Record<string, unknown>>(path.join(dir, "job.json"), {});
      const report = readProgress(dir, { timelineLimit: 50 });
      const data = {
        job_id: id,
        job_dir: dir,
        skill: job.skill ?? null,
        trigger: job.trigger ?? null,
        runner: job.runner ?? null,
        resume_of: job.resume_of ?? null,
        payload_path: path.join(dir, "payload.json"),
        event_path: path.join(dir, "event.json"),
        response_path: path.join(dir, RESPONSE_FILE),
        progress: report.progress ?? null,
        question: report.question ?? null,
        answer: report.answer ?? null,
        timeline: report.timeline,
      };
      const lines = [`job ${id} (${String(job.skill ?? "?")}, ${String(job.trigger ?? "?")}) in ${dir}`, `  progress: ${report.progress ? `${report.progress.state}: ${report.progress.message}` : "nothing reported yet"}`, ...(report.question ? [`  question: ${report.question.text}${report.question.answered_at ? " (answered)" : " (waiting)"}`] : []), ...(report.answer ? [`  answer:   ${report.answer.text}`] : [])];
      ctx.print(lines.join("\n"), data);
      return 0;
    }
    default:
      throw new UsageError(`Unknown job subcommand "${sub}"`, JOB_USAGE);
  }
}

/** The job directory this process runs in: the runner's environment first (works whatever `--dir` says), else the store. */
function resolveJob(ctx: Ctx): { id: string; dir: string } {
  const flagId = str(ctx.flags, "job");
  const envId = ctx.io.env.SKILLHOOK_JOB_ID;
  const envDir = ctx.io.env.SKILLHOOK_JOB_DIR;
  if (!flagId && envId && envDir && existsSync(envDir)) return { id: envId, dir: envDir };
  const id = flagId ?? envId;
  if (!id) throw new UsageError("Not inside a skillhook run: SKILLHOOK_JOB_ID and SKILLHOOK_JOB_DIR are not set. Pass --job <id> to address a job by id.", JOB_USAGE);
  const dir = ctx.store().pathsFor(id).dir;
  if (!existsSync(dir)) throw new CommandError(`Unknown job ${id}`);
  return { id, dir };
}
