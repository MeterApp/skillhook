import { describe, expect, it } from "vitest";
import { FAKE_TOOLS } from "../test-support/fake-cloud.js";
import { callTimeoutMs, renderResult, toolInput, ToolInputError, toolName, toolParameters, toolUsage, type CatalogTool } from "./tools.js";

const tool = (name: string) => ({ ...FAKE_TOOLS.find((t) => t.name === name)!, allowed: true }) as unknown as CatalogTool;
const files: Record<string, string> = { "event.json": '{"action":"opened"}', "SKILL.md": "---\nname: hello\n---\nSay hello.\n" };
const sources = { stdin: async () => "from stdin", file: (path: string) => files[path] ?? (() => { throw new ToolInputError(`Cannot read ${path}`); })() };

describe("the cloud's tools on the command line", () => {
  it("reads each parameter's kind, flag, choices and whether it is required from the JSON Schema", () => {
    expect(toolParameters(tool("list_jobs"))).toEqual([
      { name: "machine", flag: "machine", kind: "string", required: false, description: "Machine id or name (list_machines shows them)", choices: null },
      { name: "waiting", flag: "waiting", kind: "boolean", required: false, description: "Only jobs waiting for a person", choices: null },
      { name: "status", flag: "status", kind: "string", required: false, description: null, choices: ["queued", "running", "succeeded", "failed"] },
      { name: "limit", flag: "limit", kind: "integer", required: false, description: null, choices: null },
    ]);
    expect(toolParameters(tool("run_skill")).find((p) => p.name === "payload")).toMatchObject({ kind: "json" });
    expect(toolParameters(tool("answer_job")).find((p) => p.name === "wait_seconds")).toMatchObject({ flag: "wait-seconds", kind: "integer" });
  });

  it("takes required parameters as arguments in order and the rest as typed flags", async () => {
    expect(await toolInput(tool("answer_job"), ["20260929T101500Z-a1b2c3", "ship it"], { option: "yes", "wait-seconds": "5" }, sources)).toEqual({ job: "20260929T101500Z-a1b2c3", answer: "ship it", option: "yes", wait_seconds: 5 });
    expect(await toolInput(tool("list_jobs"), [], { waiting: true, limit: "10", json: true, dir: "/tmp/home" }, sources)).toEqual({ waiting: true, limit: 10 });
    expect(await toolInput(tool("list_jobs"), [], { waiting: false }, sources)).toEqual({ waiting: false });
    // A switch that took the next word (`--include-body <id>`) gives the word back.
    expect(await toolInput(tool("get_delivery"), [], { "include-body": "dlv-1" }, sources)).toEqual({ delivery: "dlv-1", include_body: true });
    expect(await toolInput(tool("get_delivery"), ["dlv-1"], { include_body: "true" }, sources)).toEqual({ delivery: "dlv-1", include_body: true });
  });

  it("reads JSON, files and stdin where a parameter takes them", async () => {
    expect(await toolInput(tool("run_skill"), ["mac-mini", "triage"], { payload: '{"a":[1,2]}' }, sources)).toEqual({ machine: "mac-mini", skill: "triage", payload: { a: [1, 2] } });
    expect(await toolInput(tool("run_skill"), ["mac-mini", "triage"], { payload: "@event.json" }, sources)).toMatchObject({ payload: { action: "opened" } });
    expect(await toolInput(tool("run_skill"), ["mac-mini", "triage"], { payload: "just text" }, sources)).toMatchObject({ payload: "just text" });
    expect(await toolInput(tool("save_skill"), ["mac-mini", "hello"], { "content-file": "SKILL.md" }, sources)).toEqual({ machine: "mac-mini", skill: "hello", content: files["SKILL.md"] });
    expect(await toolInput(tool("answer_job"), ["job-1"], { answer: "-" }, sources)).toMatchObject({ answer: "from stdin" });
    expect(await toolInput(tool("answer_job"), [], { input: '{"job":"job-1","answer":"no"}', option: "no" }, sources)).toEqual({ job: "job-1", answer: "no", option: "no" });
  });

  it("refuses what the tool does not take, with what it does", async () => {
    await expect(toolInput(tool("get_job"), [], {}, sources)).rejects.toThrow("get_job needs <job>");
    await expect(toolInput(tool("get_job"), ["a", "b"], {}, sources)).rejects.toThrow('takes no more arguments (got "b")');
    await expect(toolInput(tool("get_job"), ["a"], { machine: "m" }, sources)).rejects.toThrow("get_job has no --machine; its parameters: --job");
    await expect(toolInput(tool("list_jobs"), [], { limit: "ten" }, sources)).rejects.toThrow('--limit must be a whole number, got "ten"');
    await expect(toolInput(tool("list_jobs"), [], { limit: "2.5" }, sources)).rejects.toThrow("whole number");
    await expect(toolInput(tool("list_jobs"), [], { status: "done" }, sources)).rejects.toThrow("--status must be one of queued, running, succeeded, failed");
    await expect(toolInput(tool("list_jobs"), [], { machine: true }, sources)).rejects.toThrow("--machine needs a value");
    await expect(toolInput(tool("answer_job"), [], { input: "[1]" }, sources)).rejects.toThrow("--input must be a JSON object");
    await expect(toolInput(tool("save_skill"), ["m", "s"], { "content-file": "missing.md" }, sources)).rejects.toThrow("Cannot read missing.md");
  });

  it("documents a tool from its schema", () => {
    const usage = toolUsage(tool("answer_job"));
    expect(usage).toMatch(/^skillhook cloud answer_job <job> <answer> \[options\]/);
    expect(usage).toContain("Scope: fleet:run · write");
    expect(usage).toMatch(/--wait-seconds N\s+$/m);
    expect(usage).toMatch(/--job TEXT\s+\(required\) Job id/);
    expect(toolUsage({ ...tool("save_skill"), allowed: false })).toContain("Scope: fleet:admin (this key does not have it)");
  });

  it("names tools either way and waits long enough for what a call waits for", () => {
    expect(toolName("List-Jobs")).toBe("list_jobs");
    expect(callTimeoutMs({})).toBe(90_000);
    expect(callTimeoutMs({ wait_seconds: 240 })).toBe(330_000);
    expect(callTimeoutMs({ wait_seconds: "x" })).toBe(90_000);
  });

  it("renders an answer as readable lines, text from machines without control characters", () => {
    const text = renderResult({ job: { id: "j1", status: "failed", tags: ["a", "b"], question: null, result: "line 1\nline 2\u001b[31m", timeline: [], steps: [{ at: "t1", message: "started" }, { at: "t2", message: "done" }] }, empty: {} });
    expect(text).toBe(["job:", "  id: j1", "  status: failed", "  tags: a, b", "  question: -", "  result: |", "    line 1", "    line 2[31m", "  timeline: []", "  steps:", "    - at: t1", "      message: started", "    - at: t2", "      message: done", "empty: {}"].join("\n"));
  });
});
