import { describe, expect, it } from "vitest";
import { FAKE_TOOLS } from "../test-support/fake-cloud.js";
import type { FleetClient } from "./api.js";
import { callTimeoutMs, fetchCatalog, renderResult, toolInput, ToolInputError, toolName, toolParameters, toolUsage, type CatalogTool } from "./tools.js";

const tool = (name: string) => ({ ...FAKE_TOOLS.find((t) => t.name === name)!, allowed: true }) as unknown as CatalogTool;
const files: Record<string, string> = { "event.json": '{"action":"opened"}', "SKILL.md": "---\nname: hello\n---\nSay hello.\n" };
const sources = { stdin: async () => "from stdin", file: (path: string) => files[path] ?? (() => { throw new ToolInputError(`Cannot read ${path}`); })() };
const saveSkill = { name: "save_skill", description: "Write a SKILL.md.", scope: "fleet:admin", kind: "destructive", allowed: true, input_schema: { type: "object", properties: { machine: { type: "string" }, skill: { type: "string" }, content: { type: "string" }, allow_unauthenticated: { type: "boolean" } }, required: ["machine", "skill", "content"] } } as CatalogTool;
const reportIssue = { name: "report_issue", description: "Report a problem.", scope: "fleet:read", kind: "write", allowed: true, input_schema: { type: "object", properties: { title: { type: "string" }, body: { type: "string" } }, required: ["title"] } } as CatalogTool;

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

  it("takes required parameters as arguments in order and the rest as typed flags, global options aside", async () => {
    expect(await toolInput(tool("answer_job"), ["20260929T101500Z-a1b2c3", "ship it", "--option", "yes", "--wait-seconds", "5"], sources)).toEqual({ job: "20260929T101500Z-a1b2c3", answer: "ship it", option: "yes", wait_seconds: 5 });
    expect(await toolInput(tool("list_jobs"), ["--waiting", "--limit=10", "--json", "--dir", "/tmp/home"], sources)).toEqual({ waiting: true, limit: 10 });
    expect(await toolInput(tool("list_jobs"), ["--dir=/tmp/home", "-h", "-v", "--home", "/tmp/other", "--waiting"], sources)).toEqual({ waiting: true });
    // --dir takes the next word as every command reads it: not one that starts with a dash.
    expect(await toolInput(tool("get_job"), ["--dir", "--json", "job-1"], sources)).toEqual({ job: "job-1" });
    expect(await toolInput(tool("list_jobs"), ["--no-waiting"], sources)).toEqual({ waiting: false });
    expect(await toolInput(tool("list_jobs"), ["--waiting=false"], sources)).toEqual({ waiting: false });
    expect(await toolInput(tool("get_delivery"), ["--include-body", "dlv-1"], sources)).toEqual({ delivery: "dlv-1", include_body: true });
  });

  it("keeps arguments in their order around switches, and gives a text parameter the next word whatever it is", async () => {
    expect(await toolInput(saveSkill, ["mac-mini", "--allow-unauthenticated", "hello", "--content-file", "SKILL.md"], sources)).toEqual({ machine: "mac-mini", skill: "hello", content: files["SKILL.md"], allow_unauthenticated: true });
    expect(await toolInput(saveSkill, ["mac-mini", "hello", "--allow-unauthenticated", "-"], sources)).toEqual({ machine: "mac-mini", skill: "hello", content: "from stdin", allow_unauthenticated: true });
    expect(await toolInput(reportIssue, ["Replays hang", "--body", "since 0.6.0"], sources)).toEqual({ title: "Replays hang", body: "since 0.6.0" });
    expect(await toolInput(tool("answer_job"), ["job-1", "--answer", "--no-op is fine"], sources)).toEqual({ job: "job-1", answer: "--no-op is fine" });
    expect(await toolInput(tool("answer_job"), ["job-1", "--", "--force"], sources)).toEqual({ job: "job-1", answer: "--force" });
  });

  it("never takes skillhook's own options as a value: they mean the same everywhere, and the text itself goes after =", async () => {
    for (const own of ["--json", "--help", "-h", "--version", "-v", "--dir", "--home", "--json=false", "--dir=/tmp/x"]) {
      await expect(toolInput(tool("answer_job"), ["job-1", "--answer", own], sources)).rejects.toThrow(`--answer needs a value: ${own} is skillhook's own option (as the text itself: --answer=${own})`);
    }
    expect(await toolInput(tool("answer_job"), ["job-1", "--answer=--json"], sources)).toEqual({ job: "job-1", answer: "--json" });
    expect(await toolInput(tool("answer_job"), ["job-1", "--answer=-v"], sources)).toEqual({ job: "job-1", answer: "-v" });
    expect(await toolInput(tool("answer_job"), ["job-1", "--answer", "--jsonish", "--option", "-"], sources)).toEqual({ job: "job-1", answer: "--jsonish", option: "from stdin" });
    await expect(toolInput(tool("answer_job"), ["--input", "--json"], sources)).rejects.toThrow("--input needs a value");
  });

  it("reads JSON, files and stdin where a parameter takes them, and --input under the flags", async () => {
    expect(await toolInput(tool("run_skill"), ["mac-mini", "triage", "--payload", '{"a":[1,2]}'], sources)).toEqual({ machine: "mac-mini", skill: "triage", payload: { a: [1, 2] } });
    expect(await toolInput(tool("run_skill"), ["mac-mini", "triage", "--payload", "@event.json"], sources)).toMatchObject({ payload: { action: "opened" } });
    expect(await toolInput(tool("run_skill"), ["mac-mini", "triage", "--payload", "just text"], sources)).toMatchObject({ payload: "just text" });
    expect(await toolInput(tool("save_skill"), ["mac-mini", "hello", "--content-file", "SKILL.md"], sources)).toEqual({ machine: "mac-mini", skill: "hello", content: files["SKILL.md"] });
    expect(await toolInput(tool("answer_job"), ["job-1", "--answer", "-"], sources)).toMatchObject({ answer: "from stdin" });
    expect(await toolInput(tool("answer_job"), ["--input", '{"job":"job-1","answer":"no","option":"no"}', "--option", "yes"], sources)).toEqual({ job: "job-1", answer: "no", option: "yes" });
  });

  it("refuses what the tool does not take, with what it does", async () => {
    await expect(toolInput(tool("get_job"), [], sources)).rejects.toThrow("get_job needs <job>");
    await expect(toolInput(tool("get_job"), ["a", "b"], sources)).rejects.toThrow('takes no more arguments (got "b")');
    await expect(toolInput(tool("get_job"), ["a", "--machine", "m"], sources)).rejects.toThrow("get_job has no --machine; its parameters: --job");
    await expect(toolInput(tool("list_jobs"), ["--limit", "ten"], sources)).rejects.toThrow('--limit must be a whole number, got "ten"');
    await expect(toolInput(tool("list_jobs"), ["--limit", "2.5"], sources)).rejects.toThrow("whole number");
    await expect(toolInput(tool("list_jobs"), ["--status", "done"], sources)).rejects.toThrow("--status must be one of queued, running, succeeded, failed");
    await expect(toolInput(tool("list_jobs"), ["--machine"], sources)).rejects.toThrow("--machine needs a value");
    await expect(toolInput(tool("list_jobs"), ["--waiting=maybe"], sources)).rejects.toThrow("--waiting is a switch");
    await expect(toolInput(tool("answer_job"), ["--input", "[1]"], sources)).rejects.toThrow("--input must be a JSON object");
    await expect(toolInput(tool("save_skill"), ["m", "s", "--content-file", "missing.md"], sources)).rejects.toThrow("Cannot read missing.md");
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

  it("renders an answer as readable lines, text and keys from machines without control characters", () => {
    const text = renderResult({ job: { id: "j1", status: "failed", tags: ["a", "b"], question: null, result: "line 1\nline 2\u001b[31m", timeline: [], steps: [{ at: "t1", message: "started" }, { at: "t2", message: "done" }] }, empty: {}, query: { "x\u001b]52;c;\u0007": "y" } });
    expect(text).toBe(["job:", "  id: j1", "  status: failed", "  tags: a, b", "  question: -", "  result: |", "    line 1", "    line 2[31m", "  timeline: []", "  steps:", "    - at: t1", "      message: started", "    - at: t2", "      message: done", "empty: {}", "query:", "  x]52;c;: y"].join("\n"));
  });
});

describe("the catalogue", () => {
  const client = (listing: unknown): FleetClient => ({ url: "https://cloud.example.test", get: async (_path, schema) => ({ data: schema.parse(listing), raw: listing }), post: async () => ({ data: {} as never, raw: {}, status: 200 }) });
  const good = (name: string) => ({ name, description: "A tool.", input_schema: { type: "object" } });

  it("keeps the tools it can read and the first of a name listed twice", async () => {
    const catalog = await fetchCatalog(
      client({
        version: 1,
        tools: [
          good("list_jobs"),
          { name: "Bad-Name", description: "x", input_schema: { type: "object" } },
          { name: "no_schema", description: "x" },
          { name: "not_an_object", description: "x", input_schema: { type: "string" } },
          { name: "untyped", description: "x", input_schema: {} },
          { name: "null_parameter", description: "x", input_schema: { type: "object", properties: { a: null } } },
          { name: "listed_parameter", description: "x", input_schema: { type: "object", properties: { a: [] } } },
          { name: "odd_required", description: "x", input_schema: { type: "object", required: 5 } },
          { ...good("list_jobs"), description: "A second one." },
          { ...good("get_job"), input_schema: { type: "object", properties: { job: { type: "string" } }, required: ["job"], additionalProperties: false } },
        ],
      }),
    );
    expect(catalog.tools.map((t) => [t.name, t.description])).toEqual([
      ["list_jobs", "A tool."],
      ["get_job", "A tool."],
    ]);
    expect(catalog.tools[1]?.input_schema).toEqual({ type: "object", properties: { job: { type: "string" } }, required: ["job"], additionalProperties: false });
  });

  it("asks for a newer skillhook when the catalogue's shape is newer than it reads", async () => {
    await expect(fetchCatalog(client({ version: 2, tools: [] }))).rejects.toThrow("version 2 of the catalogue; this skillhook reads version 1: update it");
  });
});
