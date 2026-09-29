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
import { REPORTABLE_OUTCOMES, RESPONSE_FILE, type JobOutcome, type JobResponse } from "./response.js";
import { errorMessage, readJsonFileOr, writeJsonFile } from "./util.js";
import { VERSION } from "./version.js";

export interface JobMcpTarget {
  jobId: string;
  jobDir: string;
  /** How long job_ask_human waits by default (the skill's `human_wait_seconds`). */
  humanWaitSeconds?: number;
}

export const JOB_MCP_INSTRUCTIONS = `This server is the skillhook job API for the run you are in. Use job_progress at meaningful steps so people can follow along, and job_ask_human when you need a decision or information from a person: it waits for the answer and returns it. If it returns without an answer, or you cannot wait, finish the task as far as you safely can and report outcome "needs_human" with exactly what is needed; a person can answer later and your session will be resumed with the answer. job_set_outcome records the task outcome (completed, partial, needs_human, nothing_to_do, failed) with a summary for a person; the guardrails may also ask for it as your final answer or as response.json, which is equivalent.`;

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
    { title: "Report progress", description: "Tell skillhook (and the people watching) what you are doing right now. `state` is working (default) or blocked; `percent` 0-100 and `step` are optional.", inputSchema: z.object({ message: z.string().min(1).max(2000), state: z.enum(["working", "blocked"]).optional(), percent: z.number().min(0).max(100).optional(), step: z.string().max(200).optional() }) },
    wrap(({ message, state, percent, step }) => {
      const progress = reportProgress(jobDir, { message, state, percent, step });
      return ok({ ok: true, job_id: jobId, progress });
    }),
  );

  server.registerTool(
    "job_ask_human",
    { title: "Ask a person", description: `Ask a person a question and wait for the answer (up to wait_seconds, default ${defaultWait}). Give the options when there are a few, and in \`context\` what they need to know to decide (a diff, a URL, the alternatives). Returns {answered: true, answer, option, by} or {answered: false}: then finish with outcome "needs_human" saying exactly what is needed; the person can answer later and your session is resumed with the answer.`, inputSchema: z.object({ question: z.string().min(1).max(20_000), options: z.array(z.string().min(1).max(200)).max(20).optional(), context: z.string().max(20_000).optional(), wait_seconds: z.number().int().min(0).max(MAX_HUMAN_WAIT_SECONDS).optional() }) },
    wrap(async ({ question, options, context, wait_seconds }) => {
      const wait = wait_seconds ?? defaultWait;
      const asked = askQuestion(jobDir, { text: question, options, context, waitSeconds: wait });
      const answer = await waitForAnswer(jobDir, asked.id, { timeoutMs: wait * 1000 });
      if (!answer) return ok({ answered: false, question_id: asked.id, waited_seconds: wait }, `No answer arrived within ${wait}s. Finish with outcome "needs_human" and state exactly what is needed; a person can answer later and this session will be resumed with the answer.`);
      return ok({ answered: true, question_id: asked.id, answer: answer.text, option: answer.option ?? null, by: answer.by ?? null, answered_at: answer.at }, `Answer${answer.by ? ` from ${answer.by}` : ""}: ${answer.option ? `${answer.option}: ` : ""}${answer.text}`);
    }),
  );

  server.registerTool(
    "job_set_outcome",
    { title: "Report the outcome", description: "Record the task outcome and a one-paragraph summary for a person (plus links and data when useful). Writes response.json in the job directory; equivalent to the final-answer / response.json instructions in the guardrails.", inputSchema: z.object({ outcome: z.enum(REPORTABLE_OUTCOMES as [JobOutcome, ...JobOutcome[]]), summary: z.string().min(1).max(4000), links: z.array(z.string().url()).max(20).optional(), data: z.unknown().optional() }) },
    wrap(({ outcome, summary, links, data }) => {
      const response: JobResponse = { outcome, summary, ...(links?.length ? { links } : {}), ...(data !== undefined ? { data } : {}) };
      const file = path.join(jobDir, RESPONSE_FILE);
      writeJsonFile(file, response);
      recordOutcome(jobDir, outcome, summary);
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
