// The agent-facing side of the job API: `skillhook job progress|ask|outcome|note|context`, run by the agent (or a shell
// skill) inside a job, which it finds through SKILLHOOK_JOB_ID / SKILLHOOK_JOB_DIR (the runners set both) or `--job`.
// Every subcommand writes the progress files of the job directory; the server (or `skillhook run`) watches them.
// Anything else under `skillhook job …` is the operator's `skillhook jobs …`.
import { existsSync } from "node:fs";
import path from "node:path";
import { addNote, askQuestion, DEFAULT_HUMAN_WAIT_SECONDS, MAX_HUMAN_WAIT_SECONDS, readProgress, recordOutcome, reportProgress, waitForAnswer } from "../progress.js";
import { LINK_KINDS, parseLinkArg, type ResponseLink } from "../reporting.js";
import { buildResponse, REPORTABLE_OUTCOMES, RESPONSE_FILE, type JobOutcome } from "../response.js";
import { readJsonFileOr, writeJsonFile } from "../util.js";
import { jobsCommand, JOBS_USAGE } from "./jobs.js";
import { bool, CommandError, list, num, str, UsageError, type Ctx } from "./shared.js";

export const JOB_USAGE = `Usage (inside a run; the job comes from $SKILLHOOK_JOB_ID and $SKILLHOOK_JOB_DIR, or --job <id>):
  skillhook job progress "<what you are doing>" [--title "<what this job is about>"] [--state working|blocked] [--percent N] [--step NAME]
  skillhook job ask "<question>" [--option A]... [--recommended A] [--multiple] [--context TEXT] [--wait SECONDS]   wait for a person's answer; prints JSON, exit 3 when none came
  skillhook job outcome <${REPORTABLE_OUTCOMES.join("|")}> [--headline "<the result in one line>"] [--summary TEXT] [--title TEXT] [--link LINK]... [--links JSON] [--option A]... [--recommended A] [--multiple] [--data JSON]
  skillhook job note "<text>"
  skillhook job context

A LINK is a URL or [title](URL), either one optionally after a kind and a colon:
  --link "pull_request:[Fix the sync 500](https://github.com/acme/api/pull/7)"   kinds: ${LINK_KINDS.join(", ")}
--links takes a JSON array of URLs or {"url", "title", "kind"} objects. Summaries, questions and progress may use Markdown.

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
      const title = str(ctx.flags, "title");
      const progress = reportProgress(dir, { message: first, title, state: state as "working" | "blocked" | undefined, percent: num(ctx.flags, "percent"), step: str(ctx.flags, "step") });
      ctx.print(`${progress.state}: ${progress.message}`, { ok: true, job_id: id, progress, ...(title ? { title } : {}) });
      return 0;
    }
    case "ask": {
      if (!first) throw new UsageError("Missing the question", JOB_USAGE);
      const envWait = Number(ctx.io.env.SKILLHOOK_HUMAN_WAIT_SECONDS);
      const wait = Math.min(MAX_HUMAN_WAIT_SECONDS, Math.max(0, num(ctx.flags, "wait") ?? (Number.isFinite(envWait) && envWait > 0 ? envWait : DEFAULT_HUMAN_WAIT_SECONDS)));
      const question = askQuestion(dir, { text: first, options: list(ctx.flags, "option"), recommended: str(ctx.flags, "recommended"), multiple: bool(ctx.flags, "multiple"), context: str(ctx.flags, "context"), waitSeconds: wait });
      const answer = await waitForAnswer(dir, question.id, { timeoutMs: wait * 1000 });
      // The agent reads this from its shell: always JSON, whatever the flags.
      const data = answer
        ? { answered: true, question_id: question.id, answer: answer.text, option: answer.option ?? null, ...(question.multiple ? { options: answer.options ?? [] } : {}), by: answer.by ?? null, answered_at: answer.at }
        : { answered: false, question_id: question.id, waited_seconds: wait, hint: 'No answer arrived in time. Finish with outcome "needs_human" and say exactly what is needed: a person can answer later and the session is resumed with the answer.' };
      ctx.io.stdout(`${JSON.stringify(data, null, 2)}\n`);
      return answer ? 0 : NO_ANSWER_EXIT_CODE;
    }
    case "outcome": {
      const outcome = first as JobOutcome | undefined;
      if (!outcome || !REPORTABLE_OUTCOMES.includes(outcome)) throw new UsageError(`The outcome must be one of ${REPORTABLE_OUTCOMES.join(", ")}`, JOB_USAGE);
      const summary = str(ctx.flags, "summary") ?? ctx.args[2] ?? "";
      const links: ResponseLink[] = [];
      for (const arg of list(ctx.flags, "link")) {
        const link = parseLinkArg(arg);
        const url = link === undefined ? "" : typeof link === "string" ? link : link.url;
        // A kind that is not one ("pull-request:https://…") would otherwise end up inside the URL.
        const misnamed = /^([a-z][\w-]*):(?:https?|mailto):/i.exec(url);
        if (misnamed) throw new UsageError(`--link: "${misnamed[1]}" is not a kind of link (${LINK_KINDS.join(", ")})`, JOB_USAGE);
        if (!link || !URL.canParse(url)) throw new UsageError(`--link ${JSON.stringify(arg)} is not a URL or [title](URL)`, JOB_USAGE);
        links.push(link);
      }
      const extraLinks = parseJsonFlag(ctx, "links");
      if (extraLinks !== undefined && !Array.isArray(extraLinks)) throw new UsageError("--links must be a JSON array", JOB_USAGE);
      const data = parseJsonFlag(ctx, "data");
      const response = buildResponse({ outcome, summary, headline: str(ctx.flags, "headline"), title: str(ctx.flags, "title"), links: [...links, ...((extraLinks as unknown[] | undefined) ?? [])], options: list(ctx.flags, "option"), recommended: str(ctx.flags, "recommended"), multiple: bool(ctx.flags, "multiple"), data });
      const file = path.join(dir, RESPONSE_FILE);
      writeJsonFile(file, response);
      recordOutcome(dir, outcome, summary, { title: response.title, headline: response.headline });
      const said = response.headline ?? summary;
      ctx.print(`Recorded outcome ${outcome}${said ? `: ${said}` : ""}`, { ok: true, job_id: id, response, path: file });
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
        title: job.title ?? null,
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
      const lines = [`job ${id} (${String(job.skill ?? "?")}, ${String(job.trigger ?? "?")}) in ${dir}`, ...(typeof job.title === "string" ? [`  title:    ${job.title}`] : []), `  progress: ${report.progress ? `${report.progress.state}: ${report.progress.message}` : "nothing reported yet"}`, ...(report.question ? [`  question: ${report.question.text}${report.question.answered_at ? " (answered)" : " (waiting)"}`] : []), ...(report.answer ? [`  answer:   ${report.answer.text}`] : [])];
      ctx.print(lines.join("\n"), data);
      return 0;
    }
    default:
      throw new UsageError(`Unknown job subcommand "${sub}"`, JOB_USAGE);
  }
}

/** A flag whose value is JSON (`--data`, `--links`); undefined when it was not given. */
function parseJsonFlag(ctx: Ctx, name: string): unknown {
  const raw = str(ctx.flags, name);
  if (raw === undefined) return undefined;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new UsageError(`--${name} must be JSON`, JOB_USAGE);
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
