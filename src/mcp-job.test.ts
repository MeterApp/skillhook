import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildJobMcpServer, jobFromEnv, JOB_MCP_INSTRUCTIONS } from "./mcp-job.js";
import { answerQuestion, readProgress, readQuestion } from "./progress.js";
import { tempHome } from "./test-support/helpers.js";
import { connectMcp } from "./test-support/mcp-client.js";

async function connect(jobId: string, jobDir: string) {
  return connectMcp(buildJobMcpServer({ jobId, jobDir, humanWaitSeconds: 2 }));
}

describe("skillhook mcp --job", () => {
  it("serves the job API over MCP: progress, questions with live answers, outcome, notes and context", async () => {
    const paths = tempHome("skillhook-mcpjob-");
    const jobId = "20260928T120000Z-mcpjob";
    const jobDir = path.join(paths.jobsDir, jobId);
    mkdirSync(jobDir, { recursive: true });
    writeFileSync(path.join(jobDir, "job.json"), JSON.stringify({ id: jobId, skill: "demo", trigger: "webhook", runner: "claude" }));
    const client = await connect(jobId, jobDir);
    expect((client.init.result as { serverInfo: { name: string }; instructions: string }).serverInfo.name).toBe("skillhook-job");
    expect((client.init.result as { instructions: string }).instructions).toBe(JOB_MCP_INSTRUCTIONS);
    const tools = (await client.request("tools/list")).result as { tools: { name: string }[] };
    expect(tools.tools.map((t) => t.name).sort()).toEqual(["job_ask_human", "job_context", "job_note", "job_progress", "job_set_outcome"]);

    const progress = await client.call("job_progress", { message: "looking at the diff", percent: 20, step: "review" });
    expect(progress.data).toMatchObject({ ok: true, job_id: jobId, progress: { state: "working", message: "looking at the diff", percent: 20, step: "review" } });
    expect(readProgress(jobDir).progress).toMatchObject({ state: "working", percent: 20 });

    const unanswered = await client.call("job_ask_human", { question: "Merge it?", options: ["yes", "no"], wait_seconds: 0 });
    expect(unanswered.data).toMatchObject({ answered: false, waited_seconds: 0 });
    expect(unanswered.text).toContain('"needs_human"');
    expect(readQuestion(jobDir)).toMatchObject({ text: "Merge it?", options: ["yes", "no"] });

    const asking = client.call("job_ask_human", { question: "Which branch?", context: "main is frozen", wait_seconds: 5 });
    await new Promise((r) => setTimeout(r, 150));
    const question = readQuestion(jobDir)!;
    expect(question).toMatchObject({ text: "Which branch?", context: "main is frozen" });
    answerQuestion(jobDir, { text: "release", by: "ada" });
    const answered = await asking;
    expect(answered.data).toMatchObject({ answered: true, question_id: question.id, answer: "release", by: "ada", option: null });
    expect(answered.text).toContain("Answer from ada: release");

    const note = await client.call("job_note", { text: "two candidates" });
    expect(note.data).toMatchObject({ ok: true, entry: { type: "note", message: "two candidates" } });

    const outcome = await client.call("job_set_outcome", { outcome: "completed", summary: "Merged.", links: ["https://example.com/pr/1"], data: { pr: 1 } });
    expect(outcome.data).toMatchObject({ ok: true, path: path.join(jobDir, "response.json") });
    expect(JSON.parse(readFileSync(path.join(jobDir, "response.json"), "utf8"))).toEqual({ outcome: "completed", summary: "Merged.", links: ["https://example.com/pr/1"], data: { pr: 1 } });
    const bad = await client.call("job_set_outcome", { outcome: "unknown", summary: "x" });
    expect(bad.isError).toBe(true);

    const context = await client.call("job_context");
    expect(context.data).toMatchObject({ job_id: jobId, job_dir: jobDir, skill: "demo", trigger: "webhook", response_path: path.join(jobDir, "response.json"), progress: { state: "done", message: "Merged." }, question: { text: "Which branch?" }, answer: { text: "release" } });
    expect((context.data.timeline as unknown[]).length).toBeGreaterThanOrEqual(6);
    await client.close();
  });

  it("finds the job it serves in the runner's environment or by id under the home", () => {
    const paths = tempHome("skillhook-mcpjob-");
    const jobId = "20260928T120000Z-envjob";
    const jobDir = path.join(paths.jobsDir, jobId);
    expect(jobFromEnv({}, paths.jobsDir)).toBeUndefined();
    expect(jobFromEnv({ SKILLHOOK_JOB_ID: jobId }, paths.jobsDir)).toBeUndefined(); // the directory does not exist yet
    mkdirSync(jobDir, { recursive: true });
    expect(jobFromEnv({ SKILLHOOK_JOB_ID: jobId, SKILLHOOK_JOB_DIR: jobDir, SKILLHOOK_HUMAN_WAIT_SECONDS: "45" }, "/elsewhere")).toEqual({ jobId, jobDir, humanWaitSeconds: 45 });
    expect(jobFromEnv({ SKILLHOOK_JOB_ID: jobId }, paths.jobsDir)).toEqual({ jobId, jobDir, humanWaitSeconds: undefined });
    expect(jobFromEnv({ SKILLHOOK_JOB_DIR: "/ignored/when/an/id/is/given" }, paths.jobsDir, jobId)).toEqual({ jobId, jobDir, humanWaitSeconds: undefined });
    expect(existsSync(jobDir)).toBe(true);
  });
});
