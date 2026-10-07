// The job API as an MCP server for one run: `skillhook mcp --job`, started by the Claude and Codex runners with the job in
// its environment (`--mcp-config` / `mcp_servers.skillhook_job`), so the agent sees job_progress, job_ask_human,
// job_set_outcome, job_note and job_context without any user setup. Everything is the files of the job directory
// (progress.ts): the server (or `skillhook run`) watches them and a person's answer arrives through them.
import { existsSync } from "node:fs";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { jobPathsFor } from "./jobs.js";
import { addNote, askQuestion, DEFAULT_HUMAN_WAIT_SECONDS, MAX_HUMAN_WAIT_SECONDS, readProgress, recordOutcome, reportProgress, waitForAnswer } from "./progress.js";
import { HEADLINE_MAX, LINK_KIND_DESCRIPTIONS, LINK_KINDS, LINK_TITLE_MAX, OPTION_MAX, OPTIONS_MAX, TITLE_MAX } from "./reporting.js";
import { buildResponse, REPORTABLE_OUTCOMES, RESPONSE_FILE, type JobOutcome } from "./response.js";
import { errorMessage, readJsonFileOr, writeJsonFile } from "./util.js";
import { VERSION } from "./version.js";

export interface JobMcpTarget {
  jobId: string;
  jobDir: string;
  /** How long job_ask_human waits by default (the skill's `human_wait_seconds`). */
  humanWaitSeconds?: number;
}

export const JOB_MCP_INSTRUCTIONS = `This server is the skillhook job API for the run you are in. Use job_progress at meaningful steps so people can follow along (name the job with title in the first report), and job_ask_human when you need a decision or information from a person: it waits for the answer and returns it. If it returns without an answer, or you cannot wait, finish the task as far as you safely can and report outcome "needs_human" with exactly what is needed (and options when the person picks from a few); a person can answer later and your session will be resumed with the answer. job_set_outcome records the task outcome (completed, partial, needs_human, nothing_to_do, failed) with a headline (the result in one line), a summary for a person and links: what started the run, what you opened or changed, how to check it. The guardrails may also ask for it as your final answer or as response.json, which is equivalent. People read all of this on Skillhook Cloud's inbox, Markdown included.`;

const linkSchema = z.union([
  z.string().url(),
  z.object({
    url: z.string().url(),
    title: z.string().max(LINK_TITLE_MAX).optional().describe("What a person sees instead of the URL"),
    kind: z.enum(LINK_KINDS).optional().describe(Object.entries(LINK_KIND_DESCRIPTIONS).map(([kind, text]) => `${kind}: ${text}`).join("; ")),
  }),
]);
const choiceSchema = {
  options: z.array(z.string().min(1).max(OPTION_MAX)).max(OPTIONS_MAX).optional(),
  recommended: z.string().max(OPTION_MAX).optional().describe("The option you suggest (one of options)"),
  multiple: z.boolean().optional().describe("The person may pick several options; the answer lists them one per line"),
};

type ToolResult = { content: { type: "text"; text: string }[]; structuredContent?: Record<string, unknown>; isError?: boolean };

function ok(data: Record<string, unknown>, summary?: string): ToolResult {
  return { content: [{ type: "text", text: `${summary ? `${summary}\n\n` : ""}${JSON.stringify(data, null, 2)}` }], structuredContent: data };
}

function fail(error: unknown): ToolResult {
  return { content: [{ type: "text", text: `Error: ${errorMessage(error)}` }], isError: true };
}

function wrap<T>(fn: (input: T) => Promise<ToolResult> | ToolResult) {
  return async (input: T): Promise<ToolResult> => {
    try {
      return await fn(input);
    } catch (error) {
      return fail(error);
    }
  };
}

export function buildJobMcpServer(target: JobMcpTarget): McpServer {
  const server = new McpServer({ name: "skillhook-job", version: VERSION }, { capabilities: { tools: {} }, instructions: JOB_MCP_INSTRUCTIONS });
  const { jobId, jobDir } = target;
  const defaultWait = Math.min(MAX_HUMAN_WAIT_SECONDS, Math.max(1, target.humanWaitSeconds ?? DEFAULT_HUMAN_WAIT_SECONDS));

  server.registerTool(
    "job_progress",
    {
      title: "Report progress",
      description: "Tell skillhook (and the people watching) what you are doing right now (Markdown). `state` is working (default) or blocked; `percent` 0-100 and `step` are optional. `title` names the whole job in a few words (\"Fix the 500 on /api/sync\") and stays until a later report changes it: give it in the first report.",
      inputSchema: z.object({ message: z.string().min(1).max(2000), title: z.string().max(TITLE_MAX).optional(), state: z.enum(["working", "blocked"]).optional(), percent: z.number().min(0).max(100).optional(), step: z.string().max(200).optional() }),
    },
    wrap(({ message, title, state, percent, step }) => {
      const progress = reportProgress(jobDir, { message, title, state, percent, step });
      return ok({ ok: true, job_id: jobId, progress, ...(title ? { title } : {}) });
    }),
  );

  server.registerTool(
    "job_ask_human",
    {
      title: "Ask a person",
      description: `Ask a person a question (Markdown) and wait for the answer (up to wait_seconds, default ${defaultWait}). Give the options when there are a few (buttons on Skillhook Cloud's inbox; recommended marks the one you suggest, multiple lets them pick several), and in \`context\` what they need to know to decide (a diff, a URL, the alternatives). Returns {answered: true, answer, option, options, by} (options: what they picked of a multiple-choice question) or {answered: false}: then finish with outcome "needs_human" saying exactly what is needed; the person can answer later and your session is resumed with the answer.`,
      inputSchema: z.object({ question: z.string().min(1).max(20_000), ...choiceSchema, context: z.string().max(20_000).optional(), wait_seconds: z.number().int().min(0).max(MAX_HUMAN_WAIT_SECONDS).optional() }),
    },
    wrap(async ({ question, options, recommended, multiple, context, wait_seconds }) => {
      const wait = wait_seconds ?? defaultWait;
      const asked = askQuestion(jobDir, { text: question, options, recommended, multiple, context, waitSeconds: wait });
      const answer = await waitForAnswer(jobDir, asked.id, { timeoutMs: wait * 1000 });
      if (!answer) return ok({ answered: false, question_id: asked.id, waited_seconds: wait }, `No answer arrived within ${wait}s. Finish with outcome "needs_human" and state exactly what is needed; a person can answer later and this session will be resumed with the answer.`);
      return ok({ answered: true, question_id: asked.id, answer: answer.text, option: answer.option ?? null, ...(asked.multiple ? { options: answer.options ?? [] } : {}), by: answer.by ?? null, answered_at: answer.at }, `Answer${answer.by ? ` from ${answer.by}` : ""}: ${answer.option && answer.option !== answer.text ? `${answer.option}: ` : ""}${answer.text}`);
    }),
  );

  server.registerTool(
    "job_set_outcome",
    {
      title: "Report the outcome",
      description:
        "Record the task outcome for the people who follow this job: headline (the result in one line), summary (one paragraph, Markdown: what was done, what was found, what remains, how to check it), title (what the job was about, when job_progress did not name it), links (what started the run as kind source, what you opened or changed, how to test it) and data when useful. With needs_human, options (and recommended, multiple) become buttons a person answers with; the answer resumes this session. Writes response.json in the job directory; equivalent to the final-answer / response.json instructions in the guardrails.",
      inputSchema: z.object({
        outcome: z.enum(REPORTABLE_OUTCOMES as [JobOutcome, ...JobOutcome[]]),
        headline: z.string().max(HEADLINE_MAX).optional(),
        summary: z.string().min(1).max(4000),
        title: z.string().max(TITLE_MAX).optional(),
        links: z.array(linkSchema).max(20).optional(),
        ...choiceSchema,
        data: z.unknown().optional(),
      }),
    },
    wrap(({ outcome, headline, summary, title, links, options, recommended, multiple, data }) => {
      const response = buildResponse({ outcome, headline, summary, title, links, options, recommended, multiple, data });
      const file = path.join(jobDir, RESPONSE_FILE);
      writeJsonFile(file, response);
      recordOutcome(jobDir, outcome, summary, { title: response.title, headline: response.headline });
      return ok({ ok: true, job_id: jobId, response, path: file });
    }),
  );

  server.registerTool(
    "job_note",
    { title: "Add a note", description: "Add a line to the job's timeline without changing its state (a finding, a decision, a link).", inputSchema: z.object({ text: z.string().min(1).max(2000) }) },
    wrap(({ text }) => ok({ ok: true, job_id: jobId, entry: addNote(jobDir, text) })),
  );

  server.registerTool(
    "job_context",
    { title: "Job context", description: "What this run is: job id and directory, skill, trigger, the payload and event files, what was reported so far and any earlier question and answer (useful when the session was resumed).", inputSchema: z.object({}) },
    wrap(() => {
      const job = readJsonFileOr<Record<string, unknown>>(path.join(jobDir, "job.json"), {});
      const report = readProgress(jobDir, { timelineLimit: 50 });
      return ok({
        job_id: jobId,
        job_dir: jobDir,
        skill: job.skill ?? null,
        title: job.title ?? null,
        trigger: job.trigger ?? null,
        runner: job.runner ?? null,
        resume_of: job.resume_of ?? null,
        payload_path: path.join(jobDir, "payload.json"),
        event_path: path.join(jobDir, "event.json"),
        response_path: path.join(jobDir, RESPONSE_FILE),
        progress: report.progress ?? null,
        question: report.question ?? null,
        answer: report.answer ?? null,
        timeline: report.timeline,
      });
    }),
  );

  return server;
}

/** The job this process serves: the environment the runner injected, or `--job <id>` under `jobsDir`. */
export function jobFromEnv(env: NodeJS.ProcessEnv, jobsDir: string, jobId?: string): JobMcpTarget | undefined {
  const waitEnv = Number(env.SKILLHOOK_HUMAN_WAIT_SECONDS);
  const humanWaitSeconds = Number.isFinite(waitEnv) && waitEnv > 0 ? waitEnv : undefined;
  const id = jobId ?? env.SKILLHOOK_JOB_ID;
  if (!id) return undefined;
  const dir = !jobId && env.SKILLHOOK_JOB_DIR ? env.SKILLHOOK_JOB_DIR : jobPathsFor(jobsDir, id).dir;
  if (!existsSync(dir)) return undefined;
  return { jobId: id, jobDir: dir, humanWaitSeconds };
}

export async function serveJobMcp(target: JobMcpTarget): Promise<void> {
  const { serveStdio } = await import("@modelcontextprotocol/server/stdio");
  serveStdio(() => buildJobMcpServer(target), { onerror: (error) => console.error(`[skillhook mcp --job] ${error.message}`) });
}
