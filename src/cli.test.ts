import { appendFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createServer } from "node:http";
import { DEFAULT_CLOUD_URL } from "./cloud/config.js";
import { COMMANDS, main, nodeVersionProblem, usageOf } from "./commands/main.js";
import { VERSION } from "./version.js";
import type { CliIO } from "./commands/shared.js";
import { installService, restartService, uninstallService } from "./service.js";
import { disableExposure, enableExposure } from "./tailscale.js";
import { FAKE_CLAUDE, FAKE_CODEX, tempHome, writeConfigFile, writeEnv, writeSkill } from "./test-support/helpers.js";

// No test installs, removes or restarts this machine's service or changes its Tailscale Funnel/Serve, not even when a
// regression lets `service install --help` or `expose off --help` run: here those only record the call.
vi.mock("./service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./service.js")>()),
  installService: vi.fn(async () => ({ ok: false, file: "", output: "not from a test" })),
  uninstallService: vi.fn(async () => ({ ok: false, output: "not from a test" })),
  restartService: vi.fn(async () => ({ ok: false, output: "not from a test" })),
}));
vi.mock("./tailscale.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./tailscale.js")>()),
  enableExposure: vi.fn(async () => ({ ok: false, output: "not from a test" })),
  disableExposure: vi.fn(async () => ({ ok: false, output: "not from a test" })),
}));

function io(env: NodeJS.ProcessEnv = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const cli: CliIO = { stdout: (t) => out.push(t), stderr: (t) => err.push(t), env, isTTY: false };
  return { cli, out: () => out.join(""), err: () => err.join(""), json: () => JSON.parse(out.join("")) as Record<string, unknown> };
}

/**
 * Skillhook Cloud itself, played by `fake`: a request addressed to the default cloud is answered by the fake one and
 * recorded, so a test of a machine that names no cloud never reaches the real service. `restore` puts fetch back.
 */
function playProduction(fake: { url: string }): { requests: string[]; restore: () => void } {
  const requests: string[] = [];
  const real = globalThis.fetch;
  vi.stubGlobal("fetch", (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input);
    if (url.origin !== DEFAULT_CLOUD_URL) return real(input, init);
    requests.push(`${init?.method ?? "GET"} ${url.href}`);
    return real(`${fake.url}${url.pathname}${url.search}`, init);
  });
  return { requests, restore: () => vi.unstubAllGlobals() };
}

/** Every entry under `dir` with its mtime and each file's content: an equal snapshot means nothing was written, created or removed. */
function snapshot(dir: string): Record<string, string> {
  const entries: Record<string, string> = {};
  for (const name of readdirSync(dir, { recursive: true, encoding: "utf8" }).sort()) {
    const file = path.join(dir, name);
    const stat = lstatSync(file);
    entries[name] = `${stat.mtimeMs} ${stat.isFile() ? readFileSync(file, "utf8") : stat.isDirectory() ? "(directory)" : "(other)"}`;
  }
  return entries;
}

/** What main() returned, or "still running" after `ms` (a line that started a server, say). */
async function settle(running: Promise<number>, ms = 5_000): Promise<number | "still running"> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<"still running">((resolve) => (timer = setTimeout(() => resolve("still running"), ms)));
  try {
    return await Promise.race([running, late]);
  } finally {
    clearTimeout(timer);
  }
}

describe("cli", () => {
  const paths = tempHome();
  const dir = ["--dir", paths.home];

  it("prints help and version", async () => {
    const h = io();
    expect(await main(["help"], h.cli)).toBe(0);
    expect(h.out()).toContain("Usage: skillhook");
    const v = io();
    expect(await main(["--version"], v.cli)).toBe(0);
    expect(v.out().trim()).toMatch(/^\d+\.\d+\.\d+/);
    expect(nodeVersionProblem("20.19.0")).toContain("Node 22 or newer");
    expect(nodeVersionProblem("22.0.0")).toBeUndefined();
    expect(nodeVersionProblem()).toBeUndefined();
    const bad = io();
    expect(await main(["bogus"], bad.cli)).toBe(1);
  });

  it("init scaffolds config, secrets and the hello skill", async () => {
    const t = io();
    expect(await main(["init", ...dir, "--runner", "claude", "--json"], t.cli)).toBe(0);
    const result = t.json();
    expect(result.ok).toBe(true);
    expect(existsSync(paths.configFile)).toBe(true);
    expect(existsSync(path.join(paths.skillsDir, "hello", "SKILL.md"))).toBe(true);
    const env = readFileSync(paths.envFile, "utf8");
    expect(env).toContain("SKILLHOOK_ADMIN_TOKEN=");
    expect(env).toContain("SKILLHOOK_SECRET_HELLO=");
    const again = io();
    expect(await main(["init", ...dir, "--json"], again.cli)).toBe(0);
    expect((again.json().skipped as string[]).length).toBeGreaterThan(0);
  });

  it("lists, creates and validates skills", async () => {
    const l = io();
    expect(await main(["skills", "list", ...dir, "--json"], l.cli)).toBe(0);
    expect((l.json().skills as { name: string }[]).map((s) => s.name)).toContain("hello");

    const n = io();
    expect(await main(["skills", "new", "demo-skill", ...dir, "--description", "Demo skill for tests", "--runner", "claude", "--model", "haiku", "--json"], n.cli)).toBe(0);
    const created = n.json();
    expect(created.secret_env).toBe("SKILLHOOK_SECRET_DEMO_SKILL");
    expect(typeof created.secret).toBe("string");
    expect(readFileSync(String(created.file), "utf8")).toContain("model: haiku");

    const dup = io();
    expect(await main(["skills", "new", "demo-skill", ...dir, "--json"], dup.cli)).toBe(1);

    const gh = io();
    expect(await main(["skills", "new", "gh-skill", ...dir, "--auth", "github", "--json"], gh.cli)).toBe(0);
    expect(gh.json().secret).toBeNull();
    expect(String(gh.json().auth_note)).toContain("secret set");

    const v = io();
    expect(await main(["skills", "validate", ...dir, "--json"], v.cli)).toBe(0);
    expect((v.json().warnings as string[]).some((w) => w.includes("gh-skill"))).toBe(true);

    const s = io();
    expect(await main(["skills", "show", "demo-skill", ...dir, "--json"], s.cli)).toBe(0);
    expect(String(s.json().content)).toContain("name: demo-skill");

    const ex = io();
    expect(await main(["skills", "examples", ...dir, "--json"], ex.cli)).toBe(0);
    expect((ex.json().examples as { name: string }[]).map((e) => e.name)).toContain("hello");
  });

  it("manages secrets", async () => {
    const set = io();
    expect(await main(["secret", "set", "gh-skill", ...dir, "--value", "provider-secret", "--json"], set.cli)).toBe(0);
    expect(set.json().env).toBe("SKILLHOOK_SECRET_GH_SKILL");
    const list = io();
    expect(await main(["secret", "list", ...dir, "--json"], list.cli)).toBe(0);
    expect(list.json().names).toContain("SKILLHOOK_SECRET_GH_SKILL");
    const gen = io();
    expect(await main(["secret", "generate", "admin", ...dir, "--json"], gen.cli)).toBe(0);
    expect(gen.json().existed).toBe(true);
    const rot = io();
    expect(await main(["secret", "generate", "admin", ...dir, "--force", "--json"], rot.cli)).toBe(0);
    expect(typeof rot.json().secret).toBe("string");
    const unset = io();
    expect(await main(["secret", "unset", "SKILLHOOK_SECRET_GH_SKILL", ...dir, "--json"], unset.cli)).toBe(0);
    expect(unset.json().removed).toBe(true);
  });

  it("edits config and runs skills locally (dry run and real)", async () => {
    const set = io();
    expect(await main(["config", "set", "runners.claude.command", JSON.stringify(FAKE_CLAUDE), ...dir, "--json"], set.cli)).toBe(0);
    const get = io();
    expect(await main(["config", "get", "runners.claude.command", ...dir, "--json"], get.cli)).toBe(0);
    expect(get.json().value).toEqual(FAKE_CLAUDE);

    const dry = io();
    expect(await main(["run", "hello", ...dir, "--payload", '{"name":"dry"}', "--dry-run", "--json"], dry.cli)).toBe(0);
    const plan = dry.json();
    expect((plan.command as string[])[0]).toBe(FAKE_CLAUDE[0]);
    expect(plan.command as string[]).toContain("-p");
    expect(String(plan.prompt)).toContain('"name": "dry"');
    expect((plan.env_names as string[]).includes("SKILLHOOK_JOB_ID")).toBe(true);

    const run = io();
    expect(await main(["run", "hello", ...dir, "--payload", '{"name":"real"}', "--model", "sonnet", "--json"], run.cli)).toBe(0);
    const result = run.json();
    expect(result.ok).toBe(true);
    const job = result.job as { id: string; status: string; result: string; model: string };
    expect(job.status).toBe("succeeded");
    expect(job.result).toContain("model=sonnet");
    expect(existsSync(path.join(String(result.job_dir), "prompt.md"))).toBe(true);

    const jobs = io();
    expect(await main(["jobs", "list", ...dir, "--json"], jobs.cli)).toBe(0);
    expect((jobs.json().jobs as { id: string }[]).map((j) => j.id)).toContain(job.id);
    const show = io();
    expect(await main(["jobs", "show", job.id, ...dir, "--result", "--json"], show.cli)).toBe(0);
    expect(String((show.json().artifacts as Record<string, string>).result)).toContain("model=sonnet");
    const resume = io();
    expect(await main(["jobs", "resume", job.id, ...dir, "--json"], resume.cli)).toBe(0);
    expect(String(resume.json().resume_command)).toContain("claude --resume");
  });

  it("lists and shows deliveries the server recorded", async () => {
    const { DeliveryLog } = await import("./delivery-log.js");
    const log = new DeliveryLog(paths.jobsDir, () => ({ max: 100, store_bodies: true, body_max_bytes: 1000 }));
    const rejected = log.record({ skill: "hello", received_at: "2026-09-28T12:00:00.000Z", outcome: "rejected", http_status: 401, code: "missing_token", reason: "no bearer token", ip: "203.0.113.9", method: "POST", path: "/hooks/hello", query: { a: "1" }, headers: { "content-type": "application/json", "user-agent": "curl/8" }, user_agent: "curl/8", content_type: "application/json", bytes: 7, duration_ms: 1, rawBody: Buffer.from('{"x":1}') });
    log.record({ skill: "hello", received_at: "2026-09-28T12:00:01.000Z", outcome: "accepted", http_status: 202, job_id: "20260928T120001Z-abcdef", ip: "127.0.0.1", method: "POST", path: "/hooks/hello", query: {}, headers: {}, content_type: "application/json", bytes: 2, body_kind: "json", duration_ms: 2 });
    const list = io();
    expect(await main(["deliveries", "list", ...dir, "--json"], list.cli)).toBe(0);
    expect((list.json().deliveries as { outcome: string }[]).map((d) => d.outcome)).toEqual(["accepted", "rejected"]);
    const only = io();
    expect(await main(["deliveries", "list", ...dir, "--outcome", "rejected", "--limit", "1", "--json"], only.cli)).toBe(0);
    expect((only.json().deliveries as { id: string }[]).map((d) => d.id)).toEqual([rejected.id]);
    expect(only.json().next_after).toBe(rejected.id);
    const bad = io();
    expect(await main(["deliveries", "list", ...dir, "--outcome", "nope", "--json"], bad.cli)).toBe(2);
    const show = io();
    expect(await main(["deliveries", "show", rejected.id, ...dir, "--body", "--json"], show.cli)).toBe(0);
    expect((show.json().delivery as { code: string }).code).toBe("missing_token");
    expect(show.json().body).toMatchObject({ encoding: "utf8", text: '{"x":1}', source: "log" });
    const human = io();
    expect(await main(["deliveries", "show", rejected.id, ...dir, "--body"], human.cli)).toBe(0);
    expect(human.out()).toContain("missing_token");
    expect(human.out()).toContain("no bearer token");
    expect(human.out()).toContain('{"x":1}');
    const missing = io();
    expect(await main(["deliveries", "show", "20200101T000000Z-zzzzzz", ...dir, "--json"], missing.cli)).toBe(1);
    const table = io();
    expect(await main(["deliveries", ...dir], table.cli)).toBe(0);
    expect(table.out()).toContain("rejected");
    expect(table.out()).toContain("accepted");
    const jobs = io();
    expect(await main(["jobs", "list", ...dir, "--trigger", "cli", "--limit", "1", "--json"], jobs.cli)).toBe(0);
    expect((jobs.json().jobs as { trigger: string }[]).every((j) => j.trigger === "cli")).toBe(true);
    expect(typeof jobs.json().next_after === "string" || jobs.json().next_after === null).toBe(true);
    const badTrigger = io();
    expect(await main(["jobs", "list", ...dir, "--trigger", "nope", "--json"], badTrigger.cli)).toBe(2);
    const unknown = io();
    expect(await main(["jobs", "list", ...dir, "--outcome", "unknown", "--json"], unknown.cli)).toBe(0);
    expect((unknown.json().jobs as { outcome?: string }[]).length).toBeGreaterThan(0);
    expect((unknown.json().jobs as { outcome?: string }[]).every((j) => j.outcome === "unknown")).toBe(true);
    const badOutcome = io();
    expect(await main(["jobs", "list", ...dir, "--outcome", "nope", "--json"], badOutcome.cli)).toBe(2);
    const jobsTable = io();
    expect(await main(["jobs", "list", ...dir], jobsTable.cli)).toBe(0);
    expect(jobsTable.out()).toContain("outcome");
  });

  it("replays a recorded delivery and an earlier job in this process when no server is running", async () => {
    const { DeliveryLog } = await import("./delivery-log.js");
    const log = new DeliveryLog(paths.jobsDir, () => ({ max: 100, store_bodies: true, body_max_bytes: 10_000 }));
    const base = { skill: "hello", received_at: "2026-09-28T12:05:00.000Z", ip: "203.0.113.9", method: "POST", path: "/hooks/hello", query: {}, headers: { "content-type": "application/json" }, content_type: "application/json", bytes: 17, body_kind: "json" as const, duration_ms: 1 };
    const skipped = log.record({ ...base, outcome: "skipped", http_status: 200, code: "skipped", reason: "payload.action equals \"x\": missing", rawBody: Buffer.from('{"name":"Replay"}') });
    const r = io();
    expect(await main(["deliveries", "replay", skipped.id, ...dir, "--json"], r.cli)).toBe(0);
    expect(r.json().via).toBe("local");
    const replayed = r.json().job as { id: string; trigger: string; status: string; replay_of: { delivery: string }; source: { method: string; ip: string } };
    expect(replayed).toMatchObject({ trigger: "replay", status: "succeeded", replay_of: { delivery: skipped.id }, source: { method: "REPLAY", ip: "203.0.113.9" } });
    const rejected = log.record({ ...base, outcome: "rejected", http_status: 401, code: "missing_token", reason: "no bearer token", rawBody: Buffer.from('{"name":"R2"}') });
    const refused = io();
    expect(await main(["deliveries", "replay", rejected.id, ...dir, "--json"], refused.cli)).toBe(1);
    expect(String(refused.json().error)).toContain("force");
    const forced = io();
    expect(await main(["deliveries", "replay", rejected.id, ...dir, "--force", "--json"], forced.cli)).toBe(0);
    expect((forced.json().job as { status: string }).status).toBe("succeeded");
    const j = io();
    expect(await main(["jobs", "replay", replayed.id, ...dir, "--json"], j.cli)).toBe(0);
    expect((j.json().job as { replay_of: { job: string }; trigger: string }).replay_of).toEqual({ job: replayed.id });
    const missing = io();
    expect(await main(["jobs", "replay", "20200101T000000Z-zzzzzz", ...dir, "--json"], missing.cli)).toBe(1);
    const noId = io();
    expect(await main(["deliveries", "replay", ...dir, "--json"], noId.cli)).toBe(2);
  });

  it("runs a SKILL.md that is not installed from a file or stdin, dry and for real", async () => {
    const file = path.join(paths.home, "scratch.md");
    writeFileSync(file, "---\nname: scratch-cli\ndescription: Scratch.\nskillhook:\n  model: haiku\n---\n\nScratch {{payload.x}}.\n");
    const dry = io();
    expect(await main(["run", "--file", file, ...dir, "--payload", '{"x":"one"}', "--dry-run", "--json"], dry.cli)).toBe(0);
    expect(dry.json()).toMatchObject({ dry_run: true, skill: "scratch-cli", adhoc: true, model: "haiku" });
    expect(String(dry.json().prompt)).toContain("Scratch one.");
    expect(String(dry.json().cwd)).toContain(path.join("skill", "scratch-cli"));
    const run = io();
    expect(await main(["run", "--file", file, ...dir, "--payload", '{"x":"two"}', "--json"], run.cli)).toBe(0);
    const job = run.json().job as { id: string; trigger: string; adhoc: boolean; skill: string; status: string; skill_file: string };
    expect(job).toMatchObject({ trigger: "test", adhoc: true, skill: "scratch-cli", status: "succeeded" });
    expect(job.skill_file).toBe(path.join(paths.jobsDir, job.id, "skill", "scratch-cli", "SKILL.md"));
    expect(readFileSync(job.skill_file, "utf8")).toContain("name: scratch-cli");
    const viaStdin = io();
    viaStdin.cli.stdin = async () => readFileSync(file, "utf8");
    expect(await main(["run", "--stdin", ...dir, "--payload", '{"x":"three"}', "--json"], viaStdin.cli)).toBe(0);
    expect((viaStdin.json().job as { trigger: string }).trigger).toBe("test");
    const both = io();
    expect(await main(["run", "hello", "--file", file, ...dir, "--json"], both.cli)).toBe(2);
    const none = io();
    expect(await main(["run", ...dir, "--json"], none.cli)).toBe(2);
    const gone = io();
    expect(await main(["run", "--file", path.join(paths.home, "nope.md"), ...dir, "--json"], gone.cli)).toBe(1);
    writeFileSync(file, "no frontmatter");
    const invalid = io();
    expect(await main(["run", "--file", file, ...dir, "--json"], invalid.cli)).toBe(1);
  });

  it("gives a running skill the job API and lets a person answer from the terminal", async () => {
    // A finished job stands in for a running one: the files are the same.
    const run = io();
    expect(await main(["run", "hello", ...dir, "--payload", '{"name":"loop"}', "--json"], run.cli)).toBe(0);
    const job = run.json().job as { id: string };
    const jobDir = String(run.json().job_dir);
    const inside = { SKILLHOOK_JOB_ID: job.id, SKILLHOOK_JOB_DIR: jobDir };
    const outside = io();
    expect(await main(["job", "progress", "nope", ...dir, "--json"], outside.cli)).toBe(2);
    const progress = io(inside);
    expect(await main(["job", "progress", "reading the payload", "--percent", "10", "--step", "read", "--json"], progress.cli)).toBe(0);
    expect(progress.json()).toMatchObject({ ok: true, job_id: job.id, progress: { state: "working", message: "reading the payload", percent: 10, step: "read" } });
    const blocked = io(inside);
    expect(await main(["job", "progress", "waiting on a lock", "--state", "blocked"], blocked.cli)).toBe(0);
    expect(blocked.out()).toContain("blocked: waiting on a lock");
    const badState = io(inside);
    expect(await main(["job", "progress", "x", "--state", "done"], badState.cli)).toBe(2);
    const note = io(inside);
    expect(await main(["job", "note", "two candidates", "--json"], note.cli)).toBe(0);
    expect(note.json()).toMatchObject({ ok: true, entry: { type: "note", message: "two candidates" } });
    // Asking with nobody around: JSON on stdout and exit code 3.
    const ask = io(inside);
    expect(await main(["job", "ask", "A or B?", "--option", "A", "--option", "B", "--wait", "0"], ask.cli)).toBe(3);
    expect(ask.json()).toMatchObject({ answered: false, waited_seconds: 0 });
    const questionId = String(ask.json().question_id);
    // An operator answers while the agent waits (the job is finished, so the answer is only recorded here).
    const asking = main(["job", "ask", "Still A or B?", "--option", "A", "--option", "B", "--wait", "5"], io(inside).cli);
    await new Promise((r) => setTimeout(r, 300));
    const answer = io();
    expect(await main(["jobs", "answer", job.id, "Go with B", "--option", "B", "--by", "ada", "--no-resume", ...dir, "--json"], answer.cli)).toBe(0);
    expect(answer.json()).toMatchObject({ ok: true, job_id: job.id, delivered: "recorded", via: "local", answer: { text: "Go with B", option: "B", by: "ada" } });
    expect(await asking).toBe(0);
    expect(String(answer.json().resume_job_id ?? "")).toBe("");
    const show = io();
    expect(await main(["jobs", "show", job.id, ...dir, "--json"], show.cli)).toBe(0);
    const shown = show.json() as { job: { answer: { text: string }; question: { id: string; answered_at?: string } }; progress: { timeline: { type: string }[] } };
    expect(shown.job.answer.text).toBe("Go with B");
    expect(shown.job.question.id).not.toBe(questionId); // the second question replaced the first
    expect(shown.job.question.answered_at).toBeDefined();
    expect(shown.progress.timeline.map((e) => e.type)).toEqual(["progress", "progress", "note", "question", "question", "answer"]);
    const human = io();
    expect(await main(["jobs", "show", job.id, ...dir], human.cli)).toBe(0);
    expect(human.out()).toContain("timeline:");
    expect(human.out()).toContain("answered by ada: B: Go with B");
    const outcome = io(inside);
    expect(await main(["job", "outcome", "partial", "--summary", "Did half", "--link", "https://example.com/1", "--data", '{"n":1}', "--json"], outcome.cli)).toBe(0);
    expect(JSON.parse(readFileSync(path.join(jobDir, "response.json"), "utf8"))).toEqual({ outcome: "partial", summary: "Did half", links: ["https://example.com/1"], data: { n: 1 } });
    const badOutcome = io(inside);
    expect(await main(["job", "outcome", "unknown"], badOutcome.cli)).toBe(2);
    const context = io(inside);
    expect(await main(["job", "context", "--json"], context.cli)).toBe(0);
    expect(context.json()).toMatchObject({ job_id: job.id, job_dir: jobDir, skill: "hello", progress: { state: "done", message: "Did half" }, answer: { text: "Go with B" } });
    const notWaiting = io();
    expect(await main(["jobs", "answer", job.id, "again", ...dir, "--json"], notWaiting.cli)).toBe(1);
    expect(String(notWaiting.json().error)).toContain("not waiting");
    const noText = io();
    expect(await main(["jobs", "answer", job.id, ...dir, "--json"], noText.cli)).toBe(2);
  });

  it("resumes a job that ended needs_human with the person's answer, in this process", async () => {
    writeSkill(paths, "needy", "description: n\nskillhook:\n  response:\n    mode: structured\n  env: [FAKE_CLAUDE_OUTCOME]");
    const env = { FAKE_CLAUDE_OUTCOME: "needs_human" };
    const run = io(env);
    expect(await main(["run", "needy", ...dir, "--payload", '{"k":1}', "--json"], run.cli)).toBe(0);
    const job = run.json().job as { id: string; outcome: string; session_id: string };
    expect(job.outcome).toBe("needs_human");
    const waiting = io();
    expect(await main(["jobs", "list", "--waiting", ...dir, "--json"], waiting.cli)).toBe(0);
    expect((waiting.json().jobs as { id: string }[]).map((j) => j.id)).toContain(job.id);
    const answer = io(env);
    expect(await main(["jobs", "answer", job.id, "do B", "--by", "grace", ...dir, "--json"], answer.cli)).toBe(0);
    const result = answer.json() as { delivered: string; resume_job_id: string; resume_job: { trigger: string; status: string; resume_of: string; resume: { session_id: string }; result: string; answer: { by: string } }; job: { resolved_by: string } };
    expect(result.delivered).toBe("resumed");
    expect(result.resume_job).toMatchObject({ trigger: "resume", status: "succeeded", resume_of: job.id, resume: { session_id: job.session_id }, answer: { by: "grace" } });
    expect(result.resume_job.result).toContain(`resumed=${job.session_id}`);
    expect(result.job.resolved_by).toBe(result.resume_job_id);
    expect(readFileSync(path.join(paths.jobsDir, result.resume_job_id, "prompt.md"), "utf8")).toContain("<human_answer>\ndo B\n(answered by grace)\n</human_answer>");
    const gone = io();
    expect(await main(["jobs", "list", "--waiting", ...dir, "--json"], gone.cli)).toBe(0);
    expect((gone.json().jobs as { id: string }[]).map((j) => j.id)).not.toContain(job.id);
  });

  it("links a repository's skillhook.yaml, lists and runs its hooks, and unlinks it", async () => {
    const repo = path.join(paths.home, "repo");
    const bare = path.join(paths.home, "bare");
    mkdirSync(bare, { recursive: true });
    const nothing = io();
    expect(await main(["link", bare, ...dir, "--json"], nothing.cli)).toBe(1);
    expect(String(nothing.json().error)).toContain("skillhook.yaml");

    const init = io();
    expect(await main(["projects", "init", repo, ...dir, "--json"], init.cli)).toBe(0);
    const initialized = init.json();
    expect(initialized.written).toBe(true);
    expect(existsSync(path.join(repo, "skillhook.yaml"))).toBe(true);
    expect(((initialized.project as { hooks: { name: string }[] }).hooks).map((h) => h.name)).toEqual(["pull-after-merge"]);
    expect(JSON.parse(readFileSync(paths.configFile, "utf8")).projects).toEqual([repo]);

    writeFileSync(path.join(repo, "skillhook.yaml"), ["hooks:", "  where:", "    run: pwd", "  greet:", "    prompt: Say hi to {{payload.name}}.", "    model: haiku", ""].join("\n"));
    const again = io();
    expect(await main(["link", repo, ...dir, "--json"], again.cli)).toBe(0);
    const linked = again.json();
    expect(linked.added).toBe(false);
    expect((linked.secrets as { env: string; secret: string | null }[]).map((s) => s.env).sort()).toEqual(["SKILLHOOK_SECRET_GREET", "SKILLHOOK_SECRET_WHERE"]);
    expect(readFileSync(paths.envFile, "utf8")).toContain("SKILLHOOK_SECRET_WHERE=");

    const list = io();
    expect(await main(["projects", ...dir, "--json"], list.cli)).toBe(0);
    const projects = list.json().projects as { dir: string; hooks: { name: string; runner: string; source: { kind: string } }[] }[];
    expect(projects).toHaveLength(1);
    expect(projects[0]?.hooks.map((h) => [h.name, h.runner, h.source.kind])).toEqual([["where", "shell", "run"], ["greet", "claude", "prompt"]]);
    const human = io();
    expect(await main(["projects", ...dir], human.cli)).toBe(0);
    expect(human.out()).toContain("where");
    expect(human.out()).toContain("/hooks/greet");

    const skills = io();
    expect(await main(["skills", "list", ...dir, "--json"], skills.cli)).toBe(0);
    const where = (skills.json().skills as { name: string; source: { type: string; dir?: string } }[]).find((s) => s.name === "where");
    expect(where?.source).toMatchObject({ type: "project", dir: repo });
    const show = io();
    expect(await main(["skills", "show", "where", ...dir], show.cli)).toBe(0);
    expect(show.out()).toContain("shell command");

    const run = io();
    expect(await main(["run", "where", ...dir, "--payload", "{}", "--json"], run.cli)).toBe(0);
    expect((run.json().job as { result: string; runner: string }).result).toBe(repo);
    const dry = io();
    expect(await main(["run", "greet", ...dir, "--payload", '{"name":"Ada"}', "--dry-run", "--json"], dry.cli)).toBe(0);
    expect(String(dry.json().prompt)).toContain("Say hi to Ada.");
    expect(dry.json().cwd).toBe(repo);

    const validate = io();
    expect(await main(["skills", "validate", ...dir, "--json"], validate.cli)).toBe(0);
    expect(validate.json().valid).toContain("where");
    const doctor = io({ SKILLHOOK_NO_UPDATE_CHECK: "1" });
    await main(["doctor", ...dir, "--json"], doctor.cli);
    expect((doctor.json().checks as { name: string; status: string; detail: string }[]).find((c) => c.name.startsWith("project "))).toMatchObject({ status: "ok", detail: expect.stringContaining("where") });

    const unlink = io();
    expect(await main(["unlink", repo, ...dir, "--json"], unlink.cli)).toBe(0);
    expect(unlink.json().removed).toBe(true);
    expect(JSON.parse(readFileSync(paths.configFile, "utf8")).projects).toBeUndefined();
    const gone = io();
    expect(await main(["run", "where", ...dir, "--json"], gone.cli)).toBe(1);
    const twice = io();
    expect(await main(["unlink", repo, ...dir, "--json"], twice.cli)).toBe(1);
  });

  it("lists, previews and fires schedules", async () => {
    const tickDir = path.join(paths.skillsDir, "tick");
    mkdirSync(tickDir, { recursive: true });
    writeFileSync(path.join(tickDir, "SKILL.md"), '---\nname: tick\ndescription: Prints tick on a schedule.\nskillhook:\n  runner: shell\n  shell:\n    command: ["sh", "-c", "echo tick"]\n  webhook: false\n  schedule:\n    cron: "*/5 * * * *"\n    timezone: Europe/Berlin\n---\n\nNot used by the shell runner.\n');
    const list = io();
    expect(await main(["schedules", "list", ...dir, "--json"], list.cli)).toBe(0);
    const listed = list.json();
    expect(listed.server_running).toBe(false);
    const tick = (listed.schedules as { skill: string; next_due: string | null }[]).find((s) => s.skill === "tick");
    expect(tick).toMatchObject({ cron: "*/5 * * * *", timezone: "Europe/Berlin", webhook: false, catch_up: "latest", last_job: null });
    expect(tick?.next_due).toMatch(/Z$/);
    const human = io();
    expect(await main(["schedules", ...dir], human.cli)).toBe(0);
    expect(human.out()).toContain("tick");
    expect(human.out()).toContain("No server is running");
    const next = io();
    expect(await main(["schedules", "next", "tick", ...dir, "--count", "3", "--json"], next.cli)).toBe(0);
    expect(next.json().next as string[]).toHaveLength(3);
    const run = io();
    expect(await main(["schedules", "run", "tick", ...dir, "--json"], run.cli)).toBe(0);
    expect(run.json().job as Record<string, unknown>).toMatchObject({ status: "succeeded", result: "tick", trigger: "cli" });
    const payload = JSON.parse(readFileSync(path.join(String(run.json().job_dir), "payload.json"), "utf8")) as { scheduled_for: string; schedule: { manual: boolean; cron: string } };
    expect(payload.schedule).toMatchObject({ manual: true, cron: "*/5 * * * *" });
    expect(payload.scheduled_for).toMatch(/Z$/);
    const validate = io();
    expect(await main(["skills", "validate", "tick", ...dir, "--json"], validate.cli)).toBe(0);
    expect(validate.json().warnings as string[]).toEqual([]);
    const skills = io();
    expect(await main(["skills", "list", ...dir], skills.cli)).toBe(0);
    expect(skills.out()).toContain("schedule only");
    const show = io();
    expect(await main(["skills", "show", "tick", ...dir], show.cli)).toBe(0);
    expect(show.out()).toContain("schedule: */5 * * * * (Europe/Berlin)");
    const doctor = io({ SKILLHOOK_NO_UPDATE_CHECK: "1" });
    await main(["doctor", ...dir, "--json"], doctor.cli);
    const checks = doctor.json().checks as { name: string; status: string; detail: string }[];
    expect(checks.find((c) => c.name === "skill tick")).toMatchObject({ status: "ok", detail: expect.stringContaining("schedule only") });
    expect(checks.find((c) => c.name === "schedules")).toMatchObject({ status: "ok", detail: expect.stringContaining("tick (*/5 * * * *") });
    const none = io();
    expect(await main(["schedules", "next", "hello", ...dir, "--json"], none.cli)).toBe(1);
    const usage = io();
    expect(await main(["schedules", "bogus", ...dir], usage.cli)).toBe(2);
  });

  it("reports failures with a non-zero exit code", async () => {
    const missing = io();
    expect(await main(["run", "nope", ...dir, "--json"], missing.cli)).toBe(1);
    expect(missing.json().ok).toBe(false);
    const usage = io();
    expect(await main(["skills", "frobnicate", ...dir], usage.cli)).toBe(2);
    expect(usage.err()).toContain("Unknown skills subcommand");
  });

  it("prints the grouped health report, quick and deep", async () => {
    const quick = io({ SKILLHOOK_NO_UPDATE_CHECK: "1" });
    expect([0, 1]).toContain(await main(["health", "--quick", "--local", ...dir, "--json"], quick.cli));
    const report = quick.json() as { deep: boolean; network: boolean; groups: Record<string, { ok: number }>; checks: { name: string; group: string; status: string; detail: string }[] };
    expect(report).toMatchObject({ deep: false, network: true });
    expect(Object.keys(report.groups)).toEqual(["system", "skillhook", "runners", "tools", "skills", "exposure"]);
    expect(report.checks.find((c) => c.name === "disk")).toMatchObject({ group: "system" });
    expect(report.checks.find((c) => c.name === "version")).toMatchObject({ status: "skip" });
    expect(report.checks.some((c) => c.group === "tools")).toBe(false);
    const deep = io({ SKILLHOOK_NO_UPDATE_CHECK: "1" });
    expect([0, 1]).toContain(await main(["health", "--local", ...dir], deep.cli));
    expect(deep.out()).toContain("tools\n");
    expect(deep.out()).toContain("claude mcp stitch");
    expect(deep.out()).toMatch(/\d+ ok, \d+ warnings, \d+ failures, \d+ skipped \(deep/);
  });

  it("reports runner readiness and filters jobs by failure kind", async () => {
    const codex = io();
    expect(await main(["config", "set", "runners.codex.command", JSON.stringify(FAKE_CODEX), ...dir, "--json"], codex.cli)).toBe(0);
    const local = io();
    expect(await main(["runners", "--local", ...dir, "--json"], local.cli)).toBe(0);
    const report = local.json() as { via: string; default_runner: string; runners: { runner: string; ready: boolean; version?: string; method?: string }[] };
    expect(report).toMatchObject({ via: "local", default_runner: "claude" });
    expect(report.runners.map((r) => [r.runner, r.ready])).toEqual([
      ["claude", true],
      ["codex", true],
      ["shell", true],
    ]);
    expect(report.runners[0]).toMatchObject({ version: "2.1.270", method: "subscription" });
    const human = io();
    expect(await main(["runners", "--local", ...dir], human.cli)).toBe(0);
    expect(human.out()).toContain("claude");
    expect(human.out()).toContain("ready");
    const none = io();
    expect(await main(["jobs", "list", "--failure", "auth", ...dir, "--json"], none.cli)).toBe(0);
    expect(Array.isArray(none.json().jobs)).toBe(true);
    const bad = io();
    expect(await main(["jobs", "list", "--failure", "nope", ...dir, "--json"], bad.cli)).toBe(2);
  });

  it("tells about the server when the config changes, and reload needs one", async () => {
    const set = io();
    expect(await main(["config", "set", "max_wait_seconds", "45", ...dir, "--json"], set.cli)).toBe(0);
    expect(set.json()).toMatchObject({ ok: true, key: "max_wait_seconds", value: 45, server: null });
    const unset = io();
    expect(await main(["config", "unset", "max_wait_seconds", ...dir], unset.cli)).toBe(0);
    expect(unset.out()).toContain("Removed max_wait_seconds");
    expect(unset.out()).not.toContain("Server at");
    const reload = io();
    expect(await main(["config", "reload", ...dir, "--json"], reload.cli)).toBe(1);
    expect(String(reload.json().error)).toContain("No running server");
    const where = io();
    expect(await main(["config", "path", ...dir, "--json"], where.cli)).toBe(0);
    expect(where.json().restart_keys).toEqual(["host", "port"]);
  });

  it("prints stats over the local jobs", async () => {
    const stats = io();
    expect(await main(["stats", ...dir, "--json"], stats.cli)).toBe(0);
    const report = stats.json() as { jobs: { total: number; by_status: Record<string, number> }; deliveries: { total: number }; skills: Record<string, { jobs: number }> };
    expect(report.jobs.total).toBeGreaterThan(3);
    expect(report.jobs.by_status.succeeded).toBeGreaterThan(0);
    expect(report.skills.hello?.jobs).toBeGreaterThan(0);
    const human = io();
    expect(await main(["stats", "--since", "7d", "--skill", "hello", ...dir], human.cli)).toBe(0);
    expect(human.out()).toContain("skill hello");
    expect(human.out()).toContain("by skill:");
    const bad = io();
    expect(await main(["stats", "--since", "lately", ...dir, "--json"], bad.cli)).toBe(2);
  });

  it("pairs with Skillhook Cloud, reports the link and disconnects, never printing the token", async () => {
    const { FakeCloud } = await import("./test-support/fake-cloud.js");
    const fake = await FakeCloud.start();
    try {
      const env = { SKILLHOOK_CLOUD_URL: fake.url, SKILLHOOK_NO_UPDATE_CHECK: "1" };
      const before = io(env);
      expect(await main(["cloud", "status", ...dir, "--json"], before.cli)).toBe(0);
      expect(before.json()).toMatchObject({ enabled: false, token_present: false, url: fake.url, server_running: false });
      const usage = io(env);
      expect(await main(["cloud", "connect", ...dir, "--json"], usage.cli)).toBe(2);
      const unknown = io(env);
      expect(await main(["cloud", "connect", "--code", "ZZZZ-ZZZZ", ...dir, "--json"], unknown.cli)).toBe(1);
      expect(String(unknown.json().error)).toContain("unknown_code");
      const insecure = io({ ...env, SKILLHOOK_CLOUD_URL: "http://cloud.example.invalid" });
      expect(await main(["cloud", "connect", "--code", fake.code, ...dir, "--json"], insecure.cli)).toBe(1);
      expect(String(insecure.json().error)).toContain("https");
      expect(fake.pairs).toHaveLength(1);

      const connect = io(env);
      expect(await main(["cloud", "connect", "--code", fake.code.toLowerCase(), "--control", ...dir, "--json"], connect.cli)).toBe(0);
      expect(connect.json()).toMatchObject({ ok: true, machine_id: fake.machineId, mode: "control", url: fake.url, server_running: false });
      expect(connect.out()).not.toContain(fake.token);
      expect(fake.pairs[1]).toMatchObject({ code: fake.code, requested_mode: "control", machine: { os: process.platform } });
      expect(readFileSync(paths.envFile, "utf8")).toContain(`SKILLHOOK_CLOUD_TOKEN=${fake.token}`);
      expect(readFileSync(paths.envFile, "utf8")).toContain("SKILLHOOK_CLOUD_PRIVATE_KEY=");
      expect(fake.pairs[1]?.public_key).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect((JSON.parse(readFileSync(paths.configFile, "utf8")) as { cloud: unknown }).cloud).toMatchObject({ enabled: true, machine_id: fake.machineId, mode: "control", url: fake.url });
      const again = io(env);
      expect(await main(["cloud", "connect", "--code", fake.code, ...dir, "--json"], again.cli)).toBe(1);
      expect(String(again.json().error)).toContain("Already connected");

      const status = io(env);
      expect(await main(["cloud", "status", ...dir, "--json"], status.cli)).toBe(0);
      expect(status.json()).toMatchObject({ enabled: true, token_present: true, machine_id: fake.machineId, mode: "control", link: null });
      expect(status.out()).not.toContain(fake.token);
      const human = io(env);
      expect(await main(["cloud", "status", ...dir], human.cli)).toBe(0);
      expect(human.out()).toContain(`machine ${fake.machineId}`);
      expect(human.out()).toContain("link: no running server");
      const doctor = io(env);
      await main(["doctor", ...dir, "--json"], doctor.cli);
      expect((doctor.json().checks as { name: string; status: string }[]).find((c) => c.name === "cloud link")).toMatchObject({ status: "warn" });

      const off = io(env);
      expect(await main(["cloud", "disconnect", ...dir, "--json"], off.cli)).toBe(0);
      expect(off.json()).toMatchObject({ ok: true, was_enabled: true, token_removed: true, revoked: true });
      expect(fake.disconnects).toBe(1);
      expect(readFileSync(paths.envFile, "utf8")).not.toContain("SKILLHOOK_CLOUD_TOKEN");
      expect(readFileSync(paths.envFile, "utf8")).not.toContain("SKILLHOOK_CLOUD_PRIVATE_KEY");
      expect((JSON.parse(readFileSync(paths.configFile, "utf8")) as { cloud: { enabled: boolean; machine_id?: string } }).cloud).toMatchObject({ enabled: false });
      const after = io(env);
      await main(["doctor", ...dir, "--json"], after.cli);
      expect((after.json().checks as { name: string; status: string }[]).find((c) => c.name === "cloud link")).toMatchObject({ status: "skip" });
    } finally {
      await fake.close();
    }
  });

  it("reports a problem to the Skillhook team from a paired machine, scrubbed of every .env value", async () => {
    const { FakeCloud } = await import("./test-support/fake-cloud.js");
    const { startFakeServer } = await import("./test-support/fake-server.js");
    const fake = await FakeCloud.start();
    const home = tempHome("skillhook-cli-report-");
    const at = ["--dir", home.home];
    const envValue = "placeholder-report-env-value"; // a value in .env, not a real credential
    const server = await startFakeServer(home, {
      cloud: { state: "connected", mode: "observe", last_error: null },
      checks: { ok: false, summary: { ok: 8, warn: 1, fail: 0, skip: 3 }, checks: [{ name: "admin token", status: "warn", detail: "SKILLHOOK_ADMIN_TOKEN not set", group: "skillhook" }] },
      runners: [{ runner: "claude", ready: true }, { runner: "codex", ready: false }, { runner: "shell", ready: true }],
    });
    try {
      const env = { SKILLHOOK_CLOUD_URL: fake.url, SKILLHOOK_NO_UPDATE_CHECK: "1" };
      const unpaired = io(env);
      expect(await main(["cloud", "report", "Webhooks fail", ...at, "--json"], unpaired.cli)).toBe(1);
      expect(String(unpaired.json().error)).toContain("skillhook cloud connect --code");
      writeConfigFile(home, { runners: { claude: { command: FAKE_CLAUDE }, codex: { command: FAKE_CODEX } }, cloud: { enabled: true, url: fake.url, machine_id: fake.machineId } });
      writeEnv(home, { SKILLHOOK_CLOUD_TOKEN: fake.token, SKILLHOOK_SECRET_HELLO: envValue });

      for (const [args, message] of [
        [[], "Missing the title"],
        [["x", "--kind", "complaint"], "--kind must be one of bug, question, feature, other"],
        [["x", "--severity", "critical"], "--severity must be one of low, normal, high, urgent"],
        [["x", "--body", "a", "--body-file", "notes.txt"], "not both"],
        [["x", "--title", "y"], "Give the title once"],
        [["x", "--body"], "--body needs the text"],
      ] as const) {
        const usage = io(env);
        expect(await main(["cloud", "report", ...args, ...at], usage.cli)).toBe(2);
        expect(usage.err()).toContain(message);
      }
      const killed = io({ ...env, SKILLHOOK_NO_CLOUD: "1" });
      expect(await main(["cloud", "report", "Webhooks fail", ...at, "--json"], killed.cli)).toBe(1);
      expect(String(killed.json().error)).toContain("SKILLHOOK_NO_CLOUD is set");
      // --help shows the usage and sends nothing.
      const help = io(env);
      expect(await main(["cloud", "report", "Webhooks fail", "--help", ...at], help.cli)).toBe(0);
      expect(help.out()).toContain("skillhook cloud report");
      expect(fake.issues).toEqual([]);

      // The title's words need no quotes; --body takes its text here (it is a switch for `deliveries show`); --json is the cloud's answer.
      const plain = io(env);
      expect(await main(["cloud", "report", "Hosted", "URLs", "missing", "--body", "The dashboard shows none.", "--kind", "question", "--no-diagnostics", ...at, "--json"], plain.cli)).toBe(0);
      expect(plain.json()).toEqual({ ok: true, issue_id: "iss_41", number: 41, url: `${fake.url}/o/fake/issues/41`, acknowledged: false });
      expect(fake.issues[0]).toEqual({ title: "Hosted URLs missing", body: "The dashboard shows none.", kind: "question", report_id: expect.any(String) });

      // The body from stdin before the title, references, a contact address, and the running server's diagnostics.
      const piped = io(env);
      piped.cli.stdin = async () => `It broke with ${envValue}\n`;
      expect(await main(["cloud", "report", "--body", "-", `Replays fail with ${envValue}`, "--job", "20260929T101500Z-a1b2c3", "--delivery", "d_7", "--skill", "hello", "--severity", "urgent", "--email", "ada@example.com", ...at], piped.cli)).toBe(0);
      expect(piped.out()).toContain(`Reported as #42: ${fake.url}/o/fake/issues/42`);
      expect(piped.out()).toContain("A confirmation email was sent to ada@example.com.");
      expect(piped.out()).toContain("Diagnostics went with it");
      expect(fake.issues[1]).toEqual({
        title: "Replays fail with [redacted]",
        body: "It broke with [redacted]",
        severity: "urgent",
        contact_email: "ada@example.com",
        job_id: "20260929T101500Z-a1b2c3",
        delivery_id: "d_7",
        skill: "hello",
        report_id: expect.any(String),
        diagnostics: {
          skillhook_version: expect.any(String),
          node_version: process.versions.node,
          os: process.platform,
          arch: process.arch,
          mode: "observe",
          link: { state: "connected" },
          runners: [
            { runner: "claude", ready: true },
            { runner: "codex", ready: false },
            { runner: "shell", ready: true },
          ],
          health: { ok: false, summary: { ok: 8, warn: 1, fail: 0, skip: 3 }, failing: [{ id: "admin token", status: "warn", message: "SKILLHOOK_ADMIN_TOKEN not set" }] },
        },
      });
      expect(JSON.stringify(fake.issues)).not.toContain(envValue);

      // --body-file with --title, and --dry-run: exactly what would go, nothing sent.
      const notes = path.join(home.home, "notes.txt");
      writeFileSync(notes, `Notes from a file\n${envValue}\n`);
      const dry = io(env);
      expect(await main(["cloud", "report", "--title", "From a file", "--body-file", notes, "--dry-run", ...at, "--json"], dry.cli)).toBe(0);
      expect(dry.json()).toMatchObject({ dry_run: true, url: fake.url, request: { title: "From a file", body: "Notes from a file\n[redacted]", diagnostics: { link: { state: "connected" } } } });
      const off = io(env);
      expect(await main(["cloud", "report", "From a file", "--diagnostics", "false", "--dry-run", ...at, "--json"], off.cli)).toBe(0);
      expect((off.json().request as Record<string, unknown>).diagnostics).toBeUndefined();
      const human = io(env);
      expect(await main(["cloud", "report", "From a file", "--body-file", notes, "--dry-run", "--no-diagnostics", ...at], human.cli)).toBe(0);
      expect(human.out()).toContain(`Would send to ${fake.url}/api/agent/issues (nothing was sent):`);
      expect(fake.issues).toHaveLength(2);
      const missing = io(env);
      expect(await main(["cloud", "report", "x", "--body-file", path.join(home.home, "nope.txt"), ...at, "--json"], missing.cli)).toBe(1);

      // What the cloud refuses is the command's failure, as JSON with --json.
      fake.issuesMode = "401";
      const refused = io(env);
      expect(await main(["cloud", "report", "Webhooks fail", "--no-diagnostics", ...at, "--json"], refused.cli)).toBe(1);
      expect(String(refused.json().error)).toContain("pair it again");
    } finally {
      await server.close();
      await fake.close();
    }
  });

  it("reads the organisation's fleet with an API key, never with the machine token, and never prints the key", async () => {
    const { FakeCloud } = await import("./test-support/fake-cloud.js");
    const fake = await FakeCloud.start();
    const home = tempHome("skillhook-cli-fleet-");
    const at = ["--dir", home.home];
    try {
      const env = { SKILLHOOK_CLOUD_URL: fake.url, SKILLHOOK_NO_UPDATE_CHECK: "1" };
      writeEnv(home, { SKILLHOOK_CLOUD_TOKEN: fake.token }); // a paired machine: its token must not read the organisation
      const none = io(env);
      expect(await main(["cloud", "machines", ...at, "--json"], none.cli)).toBe(1);
      expect(String(none.json().error)).toContain("skillhook cloud login");
      // --key without one, and no terminal to ask at: nothing to log in with (without --key it would sign in with the browser).
      const usage = io(env);
      expect(await main(["cloud", "login", "--key", ...at], usage.cli)).toBe(2);
      expect(usage.err()).toContain("--key needs the organisation API key");
      const machineToken = io(env);
      expect(await main(["cloud", "login", "--key", fake.token, ...at], machineToken.cli)).toBe(2);
      expect(machineToken.err()).toContain("not an organisation API key");
      const pasted = io(env);
      pasted.cli.stdin = async () => `${fake.apiKey}\nshc_placeholder-second-line\n`;
      expect(await main(["cloud", "login", "--key", "-", ...at, "--json"], pasted.cli)).toBe(2);
      expect(pasted.out() + pasted.err()).not.toContain("shc_placeholder");
      expect(fake.apiRequests).toEqual([]);
      const wrong = io(env);
      expect(await main(["cloud", "login", "--key", "shc_placeholder-unknown-key", ...at, "--json"], wrong.cli)).toBe(1);
      expect(String(wrong.json().error)).toMatch(/refused the API key \(invalid_key: The API key is unknown, revoked or expired\. \(request req_\d+\)\)\. Log in again: skillhook cloud login --url http:\/\/127\.0\.0\.1:\d+$/);
      expect(readFileSync(home.envFile, "utf8")).not.toContain("SKILLHOOK_CLOUD_API_KEY");

      // A key kept by skillhook 0.6 has no cloud of its own: it goes to the machine's, and status says so.
      writeEnv(home, { SKILLHOOK_CLOUD_TOKEN: fake.token, SKILLHOOK_CLOUD_API_KEY: fake.apiKey });
      expect(await main(["cloud", "machines", ...at], io(env).cli)).toBe(0);
      const unbound = io(env);
      expect(await main(["cloud", "status", ...at], unbound.cli)).toBe(0);
      expect(unbound.out()).toContain(`API key: present, kept without its cloud: it goes to the machine's (${fake.url}) until skillhook cloud login names one`);
      writeEnv(home, { SKILLHOOK_CLOUD_TOKEN: fake.token });

      // Checked with /me, kept in .env (mode 600), never printed; from the flag or from stdin.
      const login = io(env);
      expect(await main(["cloud", "login", "--key", fake.apiKey, ...at], login.cli)).toBe(0);
      expect(login.out()).toContain(`Logged in to ${fake.url} as Fake Org: key "laptop" (fleet:read), kept in ${home.envFile} with its cloud (SKILLHOOK_CLOUD_API_KEY, SKILLHOOK_CLOUD_API_URL).`);
      const piped = io(env);
      piped.cli.stdin = async () => `${fake.apiKey}\n`;
      expect(await main(["cloud", "login", "--key", "-", ...at, "--json"], piped.cli)).toBe(0);
      expect(piped.json()).toMatchObject({ ok: true, url: fake.url, organisation: { name: "Fake Org" }, key: { name: "laptop", scopes: ["fleet:read"] }, role: "viewer" });
      for (const output of [login.out(), login.err(), piped.out(), piped.err()]) expect(output).not.toContain(fake.apiKey);
      expect(readFileSync(home.envFile, "utf8")).toContain(`SKILLHOOK_CLOUD_API_KEY=${fake.apiKey}`);
      expect(readFileSync(home.envFile, "utf8")).toContain(`SKILLHOOK_CLOUD_API_URL=${fake.url}`);
      expect(statSync(home.envFile).mode & 0o777).toBe(0o600);

      const machines = io(env);
      expect(await main(["cloud", "machines", ...at], machines.cli)).toBe(0);
      expect(machines.out()).toMatch(/machine\s+status\s+mode\s+version\s+last seen/);
      expect(machines.out()).toMatch(/mac-mini\s+online\s+control\s+0\.6\.0\s+\d+s ago/);
      expect(machines.out()).toMatch(/build-box\s+offline\s+observe\s+0\.5\.0\s+3d ago/);
      const machinesJson = io(env);
      expect(await main(["cloud", "machines", ...at, "--json"], machinesJson.cli)).toBe(0);
      expect(machinesJson.json()).toEqual({ machines: fake.machines });

      // Filters become the query; machine names instead of ids; a waiting job shows its question.
      const waiting = io(env);
      expect(await main(["cloud", "jobs", "--waiting", "--machine", "mac-mini", "--limit", "5", ...at], waiting.cli)).toBe(0);
      expect(fake.apiRequests.map((r) => r.path)).toContain("/api/v1/jobs?machine=mac-mini&waiting=1&limit=5");
      expect(waiting.out()).toMatch(/20260929T101500Z-a1b2c3\s+mac-mini\s+triage\s+running\s+waiting\s+\d+m ago\s+\? Deploy the fix to production\?/);
      const done = io(env);
      expect(await main(["cloud", "jobs", "--status", "succeeded", "--outcome", "completed", ...at, "--json"], done.cli)).toBe(0);
      expect(done.json()).toEqual({ jobs: [fake.jobs[1]], next_before: expect.any(String) });
      for (const args of [["--status", "done"], ["--outcome", "great"], ["--limit", "500"]]) expect(await main(["cloud", "jobs", ...args, ...at], io(env).cli)).toBe(2);

      const job = io(env);
      expect(await main(["cloud", "job", "20260929T090000Z-d4e5f6", ...at], job.cli)).toBe(0);
      expect(job.out()).toContain("20260929T090000Z-d4e5f6  nightly-report  succeeded  (completed)");
      expect(job.out()).toContain("  machine:   build-box");
      expect(job.out()).toContain("  outcome:   completed: Report sent to #ops");
      expect(job.out()).toContain("result:\nReport sent to #ops\nThree incidents, all resolved.");
      const asking = io(env);
      expect(await main(["cloud", "job", "c1f4e0aa-0b1c-4d2e-8f3a-9b8c7d6e5f01", ...at], asking.cli)).toBe(0);
      expect(asking.out()).toContain("WAITING FOR A PERSON");
      expect(asking.out()).toContain("  question:  Deploy the fix to production? [yes | no]  (answer it on the dashboard)");
      const jobJson = io(env);
      expect(await main(["cloud", "job", "20260929T090000Z-d4e5f6", ...at, "--json"], jobJson.cli)).toBe(0);
      expect(jobJson.json()).toEqual({ job: { ...fake.jobs[1], timeline: [] } });
      const unknown = io(env);
      expect(await main(["cloud", "job", "nope", ...at, "--json"], unknown.cli)).toBe(1);
      expect(String(unknown.json().error)).toContain('unknown_job: No job "nope" in Fake Org.');
      expect(await main(["cloud", "job", ...at], io(env).cli)).toBe(2);

      // A key without the scope: the error names it.
      fake.apiMode = "forbidden";
      const forbidden = io(env);
      expect(await main(["cloud", "machines", ...at, "--json"], forbidden.cli)).toBe(1);
      expect(String(forbidden.json().error)).toContain("it needs the fleet:read scope");
      fake.apiMode = "ok";
      expect(fake.apiRequests.length).toBeGreaterThan(5);
      expect(fake.apiRequests.every((r) => r.method === "GET" && r.authorization !== `Bearer ${fake.token}`)).toBe(true);
      expect(fake.requests).toEqual([]); // no sync, no pairing: only the reads a person asked for

      // The environment wins (CI); logout forgets the file's copy and leaves the pairing alone.
      const ci = io({ ...env, SKILLHOOK_CLOUD_API_KEY: "shc_placeholder-revoked-key" });
      expect(await main(["cloud", "machines", ...at], ci.cli)).toBe(1);
      expect(ci.err()).toContain("refused the API key");
      const killed = io({ ...env, SKILLHOOK_NO_CLOUD: "1" });
      expect(await main(["cloud", "jobs", ...at], killed.cli)).toBe(1);
      expect(killed.err()).toContain("SKILLHOOK_NO_CLOUD is set");
      // A key from the environment goes to the cloud kept with that same key at login, else where the environment says,
      // and only over https.
      const same = io({ SKILLHOOK_NO_UPDATE_CHECK: "1", SKILLHOOK_CLOUD_API_KEY: fake.apiKey, SKILLHOOK_CLOUD_URL: "http://cloud.example.invalid" });
      expect(await main(["cloud", "machines", ...at], same.cli)).toBe(0);
      const insecure = io({ SKILLHOOK_NO_UPDATE_CHECK: "1", SKILLHOOK_CLOUD_API_KEY: "shc_placeholder-ci-key", SKILLHOOK_CLOUD_URL: "http://cloud.example.invalid" });
      expect(await main(["cloud", "machines", ...at], insecure.cli)).toBe(1);
      expect(insecure.err()).toContain("must use https");
      expect(await main(["cloud", "logout", "--help", ...at], io(env).cli)).toBe(0);
      expect(readFileSync(home.envFile, "utf8")).toContain("SKILLHOOK_CLOUD_API_KEY");
      const logout = io(env);
      expect(await main(["cloud", "logout", ...at, "--json"], logout.cli)).toBe(0);
      expect(logout.json()).toEqual({ ok: true, removed: true, env_var_set: false });
      expect(readFileSync(home.envFile, "utf8")).not.toContain("SKILLHOOK_CLOUD_API_KEY");
      expect(readFileSync(home.envFile, "utf8")).not.toContain("SKILLHOOK_CLOUD_API_URL");
      expect(readFileSync(home.envFile, "utf8")).toContain(`SKILLHOOK_CLOUD_TOKEN=${fake.token}`);
      const again = io(env);
      expect(await main(["cloud", "logout", ...at], again.cli)).toBe(0);
      expect(again.out()).toContain("No API key was kept");
    } finally {
      await fake.close();
    }
  });

  it("signs in with the browser: the link and the code shown, the browser opened, the key the cloud hands over kept and never printed", async () => {
    const { FakeCloud } = await import("./test-support/fake-cloud.js");
    const fake = await FakeCloud.start();
    const home = tempHome("skillhook-cli-browser-login-");
    const at = ["--dir", home.home];
    try {
      const env = { SKILLHOOK_CLOUD_URL: fake.url, SKILLHOOK_NO_UPDATE_CHECK: "1" };
      fake.apiScopes = ["fleet:run"];
      // Waiting, asked to slow down, the cloud in trouble for a moment, waiting again; then approved.
      fake.signInScript.push("pending", "slow_down", "500", "pending");
      const opened: string[] = [];
      const waits: number[] = [];
      const login = io(env);
      login.cli.openUrl = (url) => opened.push(url) > 0;
      login.cli.sleep = async (ms) => void waits.push(ms);
      expect(await main(["cloud", "login", ...at], login.cli)).toBe(0);
      const page = `${fake.url}/activate?user_code=WXYZ-2345`;
      expect(opened).toEqual([page]);
      expect(login.err()).toContain(`Sign in to ${fake.url} to log this computer in:\n  ${page}\n\nCheck that the page shows this code: WXYZ-2345\n\nOpened your browser (--no-browser to skip). Waiting for your approval (the code expires in 10 minutes; Ctrl-C stops)…`);
      expect(waits).toEqual([1_000, 1_000, 6_000, 12_000, 12_000]);
      expect(login.out()).toContain(`Logged in to ${fake.url} as Fake Org: key "laptop" (fleet:run), kept in ${home.envFile} with its cloud (SKILLHOOK_CLOUD_API_KEY, SKILLHOOK_CLOUD_API_URL).`);
      for (const output of [login.out(), login.err()]) expect(output).not.toContain(fake.apiKey);
      expect(readFileSync(home.envFile, "utf8")).toContain(`SKILLHOOK_CLOUD_API_KEY=${fake.apiKey}\nSKILLHOOK_CLOUD_API_URL=${fake.url}`);
      expect(statSync(home.envFile).mode & 0o777).toBe(0o600);
      // Only the name this computer gives itself went with the sign-in: no key, no token. The key was checked with /me.
      expect(fake.signIns).toEqual([expect.objectContaining({ clientName: expect.stringMatching(/^skillhook CLI on \S+/), authorization: undefined, polls: 5, claimed: true })]);
      expect(fake.apiRequests).toEqual([{ method: "GET", path: "/api/v1/me", authorization: `Bearer ${fake.apiKey}` }]);

      // --no-browser prints the link and opens nothing; --json keeps stdout for the answer.
      const quiet = io(env);
      quiet.cli.openUrl = (url) => opened.push(url) > 0;
      quiet.cli.sleep = async () => {};
      expect(await main(["cloud", "login", "--no-browser", ...at, "--json"], quiet.cli)).toBe(0);
      expect(opened).toHaveLength(1);
      expect(quiet.err()).toContain("Open the link in a browser where you can sign in.");
      expect(quiet.json()).toEqual({ ok: true, method: "browser", url: fake.url, organisation: { id: "org_fake", slug: "fake", name: "Fake Org" }, key: { id: "key_1", name: "laptop", scopes: ["fleet:run"] }, role: "member", env_file: home.envFile });
      // Nothing opens where it was not asked for: without openUrl (an embedder, these tests) the link is the way.
      const embedded = io(env);
      embedded.cli.sleep = async () => {};
      expect(await main(["cloud", "login", ...at], embedded.cli)).toBe(0);
      expect(embedded.err()).toContain("Open the link in a browser where you can sign in.");

      // Cancelled in the browser, or never approved: the command fails and nothing is kept.
      writeEnv(home, {});
      for (const [answer, message] of [["deny", "The sign-in was not approved: The sign-in was cancelled in the browser."], ["expire", "The code expired before it was approved. Run skillhook cloud login again."]] as const) {
        fake.signInScript.push(answer);
        const refused = io(env);
        refused.cli.sleep = async () => {};
        expect(await main(["cloud", "login", ...at, "--json"], refused.cli)).toBe(1);
        expect(refused.json()).toEqual({ ok: false, error: message });
      }
      expect(readFileSync(home.envFile, "utf8")).not.toContain("SKILLHOOK_CLOUD_API_KEY");

      // A cloud from before browser sign-in says how to log in with a key instead.
      fake.signInMode = "missing";
      const old = io(env);
      expect(await main(["cloud", "login", ...at, "--json"], old.cli)).toBe(1);
      expect(old.json().error).toBe(`${fake.url} does not offer signing in with the browser. Log in with a key from its dashboard (Settings → API keys) instead: skillhook cloud login --url ${fake.url} --key`);
      fake.signInMode = "ok";

      // Nobody to approve in CI, nothing sent under the kill switch, nothing in plain http: no sign-in starts.
      const started = fake.signIns.length;
      const ci = io({ ...env, CI: "true" });
      expect(await main(["cloud", "login", ...at], ci.cli)).toBe(2);
      expect(ci.err()).toContain("Signing in with the browser needs a person at it. In CI, give the key: --key - with it on stdin");
      const killed = io({ ...env, SKILLHOOK_NO_CLOUD: "1" });
      expect(await main(["cloud", "login", ...at], killed.cli)).toBe(1);
      expect(killed.err()).toContain("SKILLHOOK_NO_CLOUD is set");
      const insecure = io({ ...env, SKILLHOOK_CLOUD_URL: "http://cloud.example.invalid" });
      expect(await main(["cloud", "login", ...at], insecure.cli)).toBe(1);
      expect(insecure.err()).toContain("must use https");
      expect(fake.signIns).toHaveLength(started);
    } finally {
      await fake.close();
    }
  });

  it("logs in to Skillhook Cloud itself on a machine that names no cloud, and keeps the key with it", async () => {
    const { FakeCloud } = await import("./test-support/fake-cloud.js");
    const fake = await FakeCloud.start();
    const home = tempHome("skillhook-cli-production-");
    const at = ["--dir", home.home];
    const production = playProduction(fake);
    try {
      const env = { SKILLHOOK_NO_UPDATE_CHECK: "1" };
      // Without a key: the command that keeps one, nothing to fill in.
      const none = io(env);
      expect(await main(["cloud", "overview", ...at, "--json"], none.cli)).toBe(1);
      expect(none.json().error).toBe("No organisation API key. Sign in with the browser: skillhook cloud login   (or set SKILLHOOK_CLOUD_API_KEY)");
      const login = io(env);
      expect(await main(["cloud", "login", "--key", fake.apiKey, ...at], login.cli)).toBe(0);
      expect(login.out()).toContain(`Logged in to https://skillhook.dev as Fake Org: key "laptop" (fleet:read), kept in ${home.envFile} with its cloud`);
      expect(readFileSync(home.envFile, "utf8")).toContain("SKILLHOOK_CLOUD_API_URL=https://skillhook.dev\n");
      const overview = io(env);
      expect(await main(["cloud", "overview", ...at], overview.cli)).toBe(0);
      expect(overview.out()).toContain('Fake Org · key "laptop" (fleet:read)');
      // Pairing with another cloud later moves neither the key nor where it goes; a new login asks which cloud it is for.
      writeConfigFile(home, { cloud: { url: fake.url } });
      expect(await main(["cloud", "machines", ...at], io(env).cli)).toBe(0);
      const ambiguous = io(env);
      expect(await main(["cloud", "login", "--key", fake.apiKey, ...at], ambiguous.cli)).toBe(2);
      expect(ambiguous.err()).toContain(`The key kept here was for https://skillhook.dev, and this machine's cloud is ${fake.url}: name the one to log in to`);
      expect(production.requests).toEqual(["GET https://skillhook.dev/api/v1/me", "POST https://skillhook.dev/api/v1/tools/describe_cloud", "GET https://skillhook.dev/api/v1/machines"]);
      expect(fake.requests).toEqual([]);
    } finally {
      production.restore();
      await fake.close();
    }
  });

  it("does what the cloud's catalogue offers: login with --url, the overview, every tool by name, a sealed secret", async () => {
    const { FakeCloud } = await import("./test-support/fake-cloud.js");
    const fake = await FakeCloud.start();
    const home = tempHome("skillhook-cli-tools-");
    const at = ["--dir", home.home];
    try {
      const env = { SKILLHOOK_NO_UPDATE_CHECK: "1" };
      // Without a key, a word that is no subcommand is a usage mistake, and nothing is sent.
      const typo = io(env);
      expect(await main(["cloud", "stauts", ...at], typo.cli)).toBe(2);
      expect(typo.err()).toContain('Unknown cloud subcommand "stauts" (the cloud\'s tools, skillhook cloud tools, need an organisation API key: skillhook cloud login)');

      // --url names the cloud the key is checked against and kept with; the machine's own link (cloud.url) is not touched.
      const insecure = io(env);
      expect(await main(["cloud", "login", "--url", "http://cloud.example.invalid", "--key", fake.apiKey, ...at], insecure.cli)).toBe(1);
      expect(insecure.err()).toContain("must use https");
      expect(fake.apiRequests).toEqual([]);
      writeConfigFile(home, { cloud: { enabled: false, url: "https://other-cloud.example.invalid", machine_id: "m1" } });
      const login = io(env);
      expect(await main(["cloud", "login", "--url", `${fake.url}/`, "--key", fake.apiKey, ...at], login.cli)).toBe(0);
      expect(login.out()).toContain(`Logged in to ${fake.url} as Fake Org: key "laptop" (fleet:read), kept in ${home.envFile} with its cloud (SKILLHOOK_CLOUD_API_KEY, SKILLHOOK_CLOUD_API_URL).`);
      expect(login.out()).not.toContain(fake.apiKey);
      expect(JSON.parse(readFileSync(home.configFile, "utf8"))).toMatchObject({ cloud: { url: "https://other-cloud.example.invalid", machine_id: "m1" } });
      expect(readFileSync(home.envFile, "utf8")).toContain(`SKILLHOOK_CLOUD_API_URL=${fake.url}\n`);
      const status = io(env);
      expect(await main(["cloud", "status", ...at], status.cli)).toBe(0);
      expect(status.out()).toContain(`API key: present for ${fake.url} (${home.envFile})`);
      // Logging in again without --url: the key kept here was for one cloud, the machine is paired with another, and the
      // new key could be for either, so it is sent to neither until the person names one.
      const ambiguous = io(env);
      const before = fake.apiRequests.length;
      expect(await main(["cloud", "login", "--key", fake.apiKey, ...at], ambiguous.cli)).toBe(2);
      expect(ambiguous.err()).toContain(`The key kept here was for ${fake.url}, and this machine's cloud is https://other-cloud.example.invalid: name the one to log in to, skillhook cloud login --url https://…`);
      expect(fake.apiRequests.length).toBe(before);
      // Asked before the key is: at a terminal, nobody types a key only to be told which cloud is missing; nor is a browser
      // sign-in started for one of the two.
      const asked = io(env);
      asked.cli.isTTY = true;
      expect(await main(["cloud", "login", "--key", ...at], asked.cli)).toBe(2);
      expect(asked.err()).toContain("name the one to log in to");
      const browser = io(env);
      expect(await main(["cloud", "login", ...at], browser.cli)).toBe(2);
      expect(browser.err()).toContain("name the one to log in to");
      expect(fake.signIns).toEqual([]);
      // A blank --url is no cloud at all, not "no --url".
      const blank = io(env);
      expect(await main(["cloud", "login", "--url", " ", "--key", fake.apiKey, ...at], blank.cli)).toBe(2);
      expect(blank.err()).toContain("--url needs the cloud's address");
      expect(fake.apiRequests.length).toBe(before);
      // A machine that names no cloud has Skillhook Cloud's own: a second cloud the new key could be for.
      writeConfigFile(home, {});
      const unnamed = io(env);
      expect(await main(["cloud", "login", "--key", fake.apiKey, ...at], unnamed.cli)).toBe(2);
      expect(unnamed.err()).toContain(`The key kept here was for ${fake.url}, and this machine's cloud is https://skillhook.dev: name the one to log in to`);
      expect(fake.apiRequests.length).toBe(before);
      // With one cloud to go by (the key's is the machine's), that is the one.
      writeConfigFile(home, { cloud: { url: fake.url } });
      const relogin = io(env);
      expect(await main(["cloud", "login", "--key", fake.apiKey, ...at], relogin.cli)).toBe(0);
      expect(relogin.out()).toContain(`Logged in to ${fake.url} as Fake Org`);

      writeConfigFile(home, { cloud: { url: "https://somewhere-else.example.invalid" } });
      const overview = io(env);
      expect(await main(["cloud", "overview", ...at], overview.cli)).toBe(0);
      expect(fake.apiRequests.at(-1)).toMatchObject({ method: "POST", path: "/api/v1/tools/describe_cloud", authorization: `Bearer ${fake.apiKey}` });
      expect(overview.out()).toContain('Fake Org · key "laptop" (fleet:read) · 1/2 machines online');
      expect(overview.out()).toContain("Waiting for a person (1)\n  20260929T101500Z-a1b2c3  triage on mac-mini: Deploy the fix to production? [yes | no]");
      expect(overview.out()).toContain("Failing health checks\n  mac-mini  claude auth (fail): not logged in  fix: run claude login");
      expect(overview.out()).toContain("Last 24 h: 2 jobs (1 succeeded, 0 failed, 1 running), $0.01; 3 webhooks (3 accepted, 0 rejected)");
      expect(overview.out()).toMatch(/build-box\s+offline\s+observe\s+0\.5\.0\s+3d ago/);
      expect(overview.out()).toContain("Next steps\n  - 1 agent(s) wait for a person");

      const tools = io(env);
      expect(await main(["cloud", "tools", ...at], tools.cli)).toBe(0);
      expect(tools.out()).toMatch(/answer_job\s+fleet:run\s+no\s+Answer an agent/);
      expect(tools.out()).toMatch(/describe_cloud\s+fleet:read\s+yes\s+Overview/);
      const one = io(env);
      expect(await main(["cloud", "tools", "answer-job", ...at], one.cli)).toBe(0);
      expect(one.out()).toContain("skillhook cloud answer_job <job> <answer> [options]");
      expect(one.out()).toContain("Scope: fleet:run (this key does not have it)");
      const catalog = io(env);
      expect(await main(["cloud", "tools", ...at, "--json"], catalog.cli)).toBe(0);
      expect((catalog.json().tools as unknown[]).length).toBeGreaterThan(5);

      // Any tool by name (kebab or snake case): arguments in order, typed flags, the answer as text or as it came.
      const waiting = io(env);
      expect(await main(["cloud", "list-jobs", "--waiting", "--limit", "5", ...at], waiting.cli)).toBe(0);
      expect(fake.toolCalls.at(-1)).toEqual({ name: "list_jobs", input: { waiting: true, limit: 5 } });
      expect(waiting.out()).toContain("jobs:\n  - id: c1f4e0aa-0b1c-4d2e-8f3a-9b8c7d6e5f01");
      expect(waiting.out()).toContain("    question:\n      id: q1\n      text: Deploy the fix to production?\n      options: yes, no");
      const job = io(env);
      expect(await main(["cloud", "get_job", "20260929T090000Z-d4e5f6", ...at, "--json"], job.cli)).toBe(0);
      expect(job.json()).toEqual({ job: { ...fake.jobs[1], timeline: [] } });
      const body = io(env);
      expect(await main(["cloud", "get_delivery", "--include-body", "dlv-1", ...at, "--json"], body.cli)).toBe(0);
      expect(fake.toolCalls.at(-1)).toEqual({ name: "get_delivery", input: { delivery: "dlv-1", include_body: true } });
      const report = io(env);
      expect(await main(["cloud", "report_issue", "Replays hang", "--body", "since 0.6.0", ...at, "--json"], report.cli)).toBe(0);
      expect(fake.toolCalls.at(-1)).toEqual({ name: "report_issue", input: { title: "Replays hang", body: "since 0.6.0" } });
      const unknownJob = io(env);
      expect(await main(["cloud", "get_job", "nope", ...at, "--json"], unknownJob.cli)).toBe(1);
      expect(String(unknownJob.json().error)).toContain('unknown_job: No job "nope" in Fake Org.');
      // What the cloud says reaches the terminal without control characters or bidirectional overrides.
      const shady = io(env);
      expect(await main(["cloud", "get_job", "nope\u202eevil\u001b[2J\u009b", ...at], shady.cli)).toBe(1);
      expect(shady.err()).toContain('No job "nopeevil[2J" in Fake Org.');
      // With --json they are escapes: the same JSON, nothing a terminal acts on.
      const shadyJson = io(env);
      expect(await main(["cloud", "get_job", "nope\u202eevil\u009b", ...at, "--json"], shadyJson.cli)).toBe(1);
      expect(shadyJson.out()).toContain("nope\\u202eevil\\u009b");
      expect(shadyJson.out()).not.toMatch(/[\u0080-\u009f\u202a-\u202e]/);
      expect(String(shadyJson.json().error)).toContain('No job "nope\u202eevil\u009b"');

      // Mistakes are usage errors with the tool's usage; a tool beyond the key's scope is refused before anything is sent.
      const calls = fake.toolCalls.length;
      const missing = io(env);
      expect(await main(["cloud", "get_job", ...at], missing.cli)).toBe(2);
      expect(missing.err()).toContain("get_job needs <job>");
      expect(missing.err()).toContain("skillhook cloud get_job <job>");
      expect(await main(["cloud", "list_jobs", "--colour", "red", ...at], io(env).cli)).toBe(2);
      const nope = io(env);
      expect(await main(["cloud", "drop_everything", ...at], nope.cli)).toBe(2);
      expect(nope.err()).toContain('Unknown cloud subcommand or tool "drop_everything"');
      const answer = io(env);
      expect(await main(["cloud", "answer_job", "20260929T101500Z-a1b2c3", "yes", ...at], answer.cli)).toBe(1);
      expect(answer.err()).toContain("answer_job needs a key with the fleet:run scope; this one has fleet:read.");
      expect(fake.toolCalls.length).toBe(calls);

      // With a wider key the same line runs; a JSON payload from a file reaches the tool as JSON.
      fake.apiScopes = ["fleet:admin"];
      // Before a tool's name only skillhook's own options: one of the tool's could swallow the name (a switch only its
      // schema knows), and words before `cloud` never reach the tool.
      const beforeMisplaced = fake.toolCalls.length;
      for (const line of [["cloud", "--machine", "mac-mini", "list_jobs"], ["--machine", "mac-mini", "cloud", "list_jobs"], ["cloud", "--store-payloads", "update_settings"]]) {
        const misplaced = io(env);
        expect(await main([...line, ...at], misplaced.cli)).toBe(2);
        expect(misplaced.err()).toContain("Name the subcommand or tool first, then its options: skillhook cloud <subcommand|tool>");
      }
      expect(fake.toolCalls.length).toBe(beforeMisplaced);
      // After `--`, as for every command, every word is an argument: the subcommand's and the tool's.
      const ended = io(env);
      expect(await main(["cloud", ...at, "--", "status"], ended.cli)).toBe(0);
      expect(ended.out()).toContain("API key: present for");
      const endedTool = io(env);
      expect(await main(["cloud", ...at, "--", "get_job", "20260929T090000Z-d4e5f6"], endedTool.cli)).toBe(0);
      expect(fake.toolCalls.at(-1)).toEqual({ name: "get_job", input: { job: "20260929T090000Z-d4e5f6" } });
      expect(await main(["cloud", ...at, "--", "get_job", "20260929T090000Z-d4e5f6", "--json"], io(env).cli)).toBe(2);
      expect(await main(["--json", "cloud", ...at, "list_jobs", "--machine", "mac-mini", "--waiting"], io(env).cli)).toBe(0);
      expect(fake.toolCalls.at(-1)).toEqual({ name: "list_jobs", input: { machine: "mac-mini", waiting: true } });
      // skillhook's own options mean the same wherever they stand, never a parameter's value: the text goes after =.
      const sent = fake.toolCalls.length;
      const ownJson = io(env);
      expect(await main(["cloud", "answer_job", "20260929T101500Z-a1b2c3", "--answer", "--json", ...at], ownJson.cli)).toBe(2);
      expect(ownJson.err()).toContain("--answer needs a value: --json is skillhook's own option (as the text itself: --answer=--json)");
      const version = io(env);
      expect(await main(["cloud", "answer_job", "20260929T101500Z-a1b2c3", "--answer", "-v", ...at], version.cli)).toBe(0);
      expect(version.out()).toBe(`${VERSION}\n`);
      const usage = io(env);
      expect(await main(["cloud", "answer_job", "20260929T101500Z-a1b2c3", "--answer", "--help", ...at], usage.cli)).toBe(0);
      expect(usage.out()).toContain("skillhook cloud <tool> [arguments] [--param value]");
      // Their --no- forms too: the last one wins for skillhook, and the tool takes neither as its text.
      const negated = io(env);
      expect(await main(["cloud", "answer_job", "20260929T101500Z-a1b2c3", "--help", "--answer", "--no-help", ...at], negated.cli)).toBe(2);
      expect(negated.err()).toContain("--answer needs a value: --no-help is skillhook's own option");
      expect(fake.toolCalls.length).toBe(sent);
      const literal = io(env);
      expect(await main(["cloud", "answer_job", "20260929T101500Z-a1b2c3", "--answer=--json", "--option", "yes", ...at, "--json"], literal.cli)).toBe(0);
      expect(fake.toolCalls.at(-1)).toEqual({ name: "answer_job", input: { job: "20260929T101500Z-a1b2c3", answer: "--json", option: "yes" } });
      expect(literal.json()).toMatchObject({ delivered: "live" });
      const answered = io(env);
      expect(await main(["cloud", "answer_job", "20260929T101500Z-a1b2c3", "yes", "--option", "yes", ...at], answered.cli)).toBe(0);
      expect(fake.toolCalls.at(-1)).toEqual({ name: "answer_job", input: { job: "20260929T101500Z-a1b2c3", answer: "yes", option: "yes" } });
      expect(answered.out()).toContain("delivered: live");
      const event = path.join(home.home, "event.json");
      writeFileSync(event, '{"action":"opened","number":7}');
      expect(await main(["cloud", "run_skill", "mac-mini", "triage", "--payload", `@${event}`, "--wait-seconds", "0", ...at], io(env).cli)).toBe(0);
      expect(fake.toolCalls.at(-1)).toEqual({ name: "run_skill", input: { machine: "mac-mini", skill: "triage", payload: { action: "opened", number: 7 }, wait_seconds: 0 } });

      // A secret is generated on the machine, sealed to this terminal's key pair, and opened only here.
      const secret = io(env);
      expect(await main(["cloud", "secret", "mac-mini", "hello", ...at], secret.cli)).toBe(0);
      expect(secret.out()).toContain(`SKILLHOOK_SECRET_HELLO=${fake.secretValue}`);
      expect(fake.secretRequests).toMatchObject([{ machine: "mac-mini", name: "SKILLHOOK_SECRET_HELLO", claims: 2 }]);
      expect(fake.secretRequests[0]?.recipient_key).toMatch(/^[A-Za-z0-9_-]{43}$/);
      const kept = io(env);
      expect(await main(["cloud", "secret", "mac-mini", "SKILLHOOK_SECRET_KEPT", ...at, "--json"], kept.cli)).toBe(0);
      expect(kept.json()).toMatchObject({ ok: true, name: "SKILLHOOK_SECRET_KEPT", secret: null, existed: true });
      const noSkill = io(env);
      expect(await main(["cloud", "secret", "mac-mini", "nope", ...at], noSkill.cli)).toBe(1);
      expect(noSkill.err()).toContain("mac-mini has no skill named nope");
      // Only a skill's secret: never the machine's admin token (even when an older machine has a skill naming it) or a
      // runner's API key.
      const requests = fake.secretRequests.length;
      for (const [given, said] of [["SKILLHOOK_ADMIN_TOKEN", "SKILLHOOK_ADMIN_TOKEN is mac-mini's own credential, not a skill's secret"], ["legacy", "SKILLHOOK_ADMIN_TOKEN is mac-mini's own credential"], ["SKILLHOOK_CLOUD_TOKEN", "SKILLHOOK_CLOUD_TOKEN is mac-mini's own credential"], ["ANTHROPIC_API_KEY", "ANTHROPIC_API_KEY is not a skill's secret on mac-mini"]] as const) {
        const other = io(env);
        expect(await main(["cloud", "secret", "mac-mini", given, "--force", ...at], other.cli)).toBe(1);
        expect(other.err()).toContain(said);
      }
      expect(fake.secretRequests.length).toBe(requests);
      // A skill saved a moment ago is not listed yet: the machine's own answer names its secret.
      const fresh = io(env);
      expect(await main(["cloud", "secret", "mac-mini", "fresh", ...at, "--json"], fresh.cli)).toBe(0);
      expect(fresh.json()).toMatchObject({ name: "SKILLHOOK_SECRET_FRESH", secret: fake.secretValue });
      fake.apiScopes = ["fleet:run"];
      const denied = io(env);
      expect(await main(["cloud", "secret", "mac-mini", "SKILLHOOK_SECRET_HELLO", ...at], denied.cli)).toBe(1);
      expect(denied.err()).toContain("needs the admin role");

      const killed = io({ ...env, SKILLHOOK_NO_CLOUD: "1" });
      expect(await main(["cloud", "get_stats", ...at, "--json"], killed.cli)).toBe(1);
      expect(String(killed.json().error)).toContain("SKILLHOOK_NO_CLOUD is set");

      // A cloud from before the catalogue says so; the reads of 0.6 still work there.
      fake.catalogMode = "missing";
      const old = io(env);
      expect(await main(["cloud", "tools", ...at], old.cli)).toBe(1);
      expect(old.err()).toContain("has no tool catalogue (GET /api/v1/tools): it runs an older Skillhook Cloud");
      expect(await main(["cloud", "machines", ...at], io(env).cli)).toBe(0);
      expect(fake.requests).toEqual([]);
    } finally {
      await fake.close();
    }
  });

  it("runs doctor, url and expose status without crashing", async () => {
    const d = io({ SKILLHOOK_NO_UPDATE_CHECK: "1" });
    const code = await main(["doctor", ...dir, "--json"], d.cli);
    expect([0, 1]).toContain(code);
    expect(Array.isArray(d.json().checks)).toBe(true);
    const u = io();
    expect(await main(["url", ...dir, "--local", "--json"], u.cli)).toBe(0);
    expect(String((u.json().urls as Record<string, string>).hello)).toMatch(/\/hooks\/hello$/);
    const e = io();
    expect(await main(["expose", "status", ...dir, "--json"], e.cli)).toBe(0);
    const m = io();
    expect(await main(["mcp", "--print-config", ...dir, "--json"], m.cli)).toBe(0);
    expect(String(m.json().claude_code)).toContain("claude mcp add skillhook");
    const checks = d.json().checks as { name: string; status: string; detail: string }[];
    expect(checks.find((c) => c.name === "version")).toMatchObject({ status: "skip" });
    expect(checks.find((c) => c.name === "version")?.detail).toContain("disabled");
  });

  it("checks for updates against the registry and never installs from a source checkout", async () => {
    const newer = `${Number(process.env.npm_package_version?.split(".")[0] ?? 99) + 99}.0.0`;
    const registry = createServer((req, res) => {
      res.writeHead(req.url === "/@meterapp%2Fskillhook/latest" ? 200 : 404, { "content-type": "application/json" });
      res.end(JSON.stringify(req.url === "/@meterapp%2Fskillhook/latest" ? { version: newer } : { error: "Not found" }));
    });
    await new Promise<void>((resolve) => registry.listen(0, "127.0.0.1", () => resolve()));
    const address = registry.address();
    const env = { SKILLHOOK_NPM_REGISTRY: `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}` };
    try {
      const check = io(env);
      expect(await main(["update", ...dir, "--json"], check.cli)).toBe(0);
      expect(check.json()).toMatchObject({ ok: true, latest: newer, available: true, cached: false, install: { method: "source" } });
      expect(existsSync(path.join(paths.home, "update-check.json"))).toBe(true);
      const human = io(env);
      expect(await main(["update", ...dir], human.cli)).toBe(0);
      expect(human.out()).toContain(`Update available: @meterapp/skillhook`);
      expect(human.out()).toContain("git pull");
      const install = io(env);
      expect(await main(["update", ...dir, "--install", "--json"], install.cli)).toBe(1);
      expect(String(install.json().error)).toContain("source checkout");
      const quiet = io(env);
      expect(await main(["update", "--refresh", ...dir], quiet.cli)).toBe(0);
      expect(quiet.out()).toBe("");
      // The doctor consults the registry too, and points at the release notes.
      const d = io(env);
      await main(["doctor", ...dir, "--json"], d.cli);
      expect((d.json().checks as { name: string; status: string; hint?: string }[]).find((c) => c.name === "version")).toMatchObject({ status: "warn", hint: expect.stringContaining(`releases/tag/v${newer}`) });
    } finally {
      registry.close();
    }
    const offline = io({ SKILLHOOK_NPM_REGISTRY: "http://127.0.0.1:1" });
    expect(await main(["update", ...dir, "--json"], offline.cli)).toBe(0);
    expect(offline.json()).toMatchObject({ latest: newer, cached: true });
    const fresh = io({ SKILLHOOK_NPM_REGISTRY: "http://127.0.0.1:1", SKILLHOOK_HOME: paths.home });
    const emptyHome = ["--dir", path.join(paths.home, "empty-home")];
    expect(await main(["update", ...emptyHome, "--json"], fresh.cli)).toBe(1);
    expect(fresh.json().ok).toBe(false);
  });

  it("prints the usage for --help, -h and help <command> and runs nothing, for every command and subcommand", async () => {
    const home = tempHome("skillhook-cli-help-");
    const at = ["--dir", home.home];
    // A home where every line below has something to act on: a job to prune or answer, a delivery to replay, secrets and
    // config to change, a linked project to unlink, a schedule to fire, an API key to forget.
    expect(await main(["init", ...at, "--json"], io().cli)).toBe(0);
    writeConfigFile(home, { runners: { claude: { command: FAKE_CLAUDE }, codex: { command: FAKE_CODEX } } });
    const run = io();
    expect(await main(["run", "hello", ...at, "--payload", '{"name":"help"}', "--json"], run.cli)).toBe(0);
    const job = (run.json().job as { id: string }).id;
    const { DeliveryLog } = await import("./delivery-log.js");
    const delivery = new DeliveryLog(home.jobsDir, () => ({ max: 100, store_bodies: true, body_max_bytes: 1000 })).record({ skill: "hello", received_at: "2026-09-29T12:00:00.000Z", outcome: "rejected", http_status: 401, code: "missing_token", reason: "no bearer token", ip: "203.0.113.9", method: "POST", path: "/hooks/hello", query: {}, headers: {}, content_type: "application/json", bytes: 2, duration_ms: 1, rawBody: Buffer.from("{}") }).id;
    const linked = path.join(home.home, "linked");
    expect(await main(["projects", "init", linked, ...at, "--json"], io().cli)).toBe(0);
    const unlinked = path.join(home.home, "unlinked");
    mkdirSync(unlinked);
    writeFileSync(path.join(unlinked, "skillhook.yaml"), "hooks:\n  where:\n    run: pwd\n");
    writeSkill(home, "tick", 'description: Ticks.\nskillhook:\n  runner: shell\n  shell:\n    command: ["sh", "-c", "echo tick"]\n  webhook: false\n  schedule: "*/5 * * * *"');
    appendFileSync(home.envFile, "SKILLHOOK_CLOUD_API_KEY=shc_placeholder-help-key\n");
    // Should a line run after all, nothing leaves the machine: no registry, no cloud, fake runners (and the stubs above).
    const env = { SKILLHOOK_NO_UPDATE_CHECK: "1", SKILLHOOK_NPM_REGISTRY: "http://127.0.0.1:1", SKILLHOOK_CLOUD_URL: "http://127.0.0.1:1", SKILLHOOK_NO_CLOUD: "1", SKILLHOOK_JOB_ID: job, SKILLHOOK_JOB_DIR: path.join(home.jobsDir, job) };

    // Each command with each subcommand, and arguments that would change the home if it ran; an alias gets its command's.
    const lines: Record<string, string[][]> = {
      init: [[], ["--force", "--runner", "codex"]],
      serve: [[], ["--port", "0"]],
      skills: [[], ["list"], ["show", "hello"], ["new", "fresh"], ["add", "hello", "--as", "copy"], ["examples"], ["validate"], ["path", "hello"]],
      secret: [[], ["list"], ["set", "hello", "--value", "changed"], ["set", "hello", "--stdin"], ["generate", "admin", "--force"], ["rotate", "hello"], ["unset", "hello"]],
      run: [["hello", "--payload", "{}"], ["hello", "--dry-run"], ["--file", path.join(home.skillsDir, "hello", "SKILL.md")], ["--stdin"]],
      send: [["hello", "--wait", "5"]],
      jobs: [[], ["list"], ["show", job], ["logs", job, "--follow"], ["answer", job, "yes", "--no-resume"], ["cancel", job], ["replay", job], ["resume", job], ["path", job], ["prune", "--keep", "0"]],
      job: [[], ["progress", "halfway", "--percent", "50"], ["ask", "Go?", "--wait", "0"], ["outcome", "completed", "--summary", "done"], ["note", "noted"], ["context"], ["prune", "--keep", "0"]],
      deliveries: [[], ["list"], ["show", delivery, "--body"], ["replay", delivery, "--force"]],
      expose: [[], ["tailscale"], ["serve"], ["status"], ["off"], ["cloudflare"], ["ngrok"]],
      url: [[], ["hello", "--local"]],
      service: [[], ["install"], ["uninstall"], ["status"], ["restart"], ["logs", "--lines", "5"]],
      doctor: [[]],
      health: [[], ["--quick", "--local"]],
      runners: [[], ["--refresh", "--local"]],
      stats: [[], ["--since", "7d"]],
      config: [[], ["show"], ["get", "port"], ["set", "port", "9999"], ["unset", "runners"], ["reload"], ["path"]],
      cloud: [[], ["connect", "--code", "ABCD-EFGH", "--control"], ["disconnect"], ["status"], ["report", "Broken", "--body", "details"], ["login", "--key", "shc_placeholder-other-key", "--url", "https://cloud.example.invalid"], ["login", "--no-browser"], ["logout"], ["overview"], ["machines"], ["jobs", "--waiting"], ["job", job], ["tools"], ["tools", "answer_job"], ["answer_job", job, "yes"], ["save-skill", "mac-mini", "hello", "--content-file", "SKILL.md"], ["secret", "mac-mini", "hello", "--force"]],
      mcp: [[], ["--print-config"], ["--cloud"], ["--job", job]],
      update: [[], ["--install"], ["--refresh"]],
      link: [[], [unlinked]],
      unlink: [[linked]],
      projects: [[], ["list"], ["init", path.join(home.home, "fresh")], ["add", unlinked], ["remove", linked]],
      schedules: [[], ["list"], ["next", "tick"], ["run", "tick"]],
    };
    for (const name of Object.keys(lines)) expect(COMMANDS, name).toHaveProperty(name);

    const before = snapshot(home.home);
    const prune = io(env);
    expect(await main(["jobs", "prune", "--keep", "0", "--help", ...at], prune.cli)).toBe(0);
    expect(prune.out()).toContain("skillhook jobs prune [--keep N]");
    const agent = io(env);
    expect(await main(["job", "progress", "halfway", "-h", ...at], agent.cli)).toBe(0);
    expect(agent.out()).toContain('skillhook job progress "<what you are doing>"');
    const operator = io(env);
    expect(await main(["help", "job", "prune", ...at, "--json"], operator.cli)).toBe(0);
    expect(operator.json()).toMatchObject({ ok: true, command: "job", usage: expect.stringContaining("skillhook jobs prune [--keep N]") });

    const documented: string[] = [];
    let stdinReads = 0;
    for (const [name, command] of Object.entries(COMMANDS)) {
      const own = lines[name] ?? Object.entries(lines).find(([other]) => COMMANDS[other]?.run === command.run)?.[1];
      expect(own, `no --help lines for skillhook ${name}`).toBeDefined();
      expect(usageOf(command, []), name).toMatch(/^Usage/);
      // Every subcommand the usage documents (`skillhook jobs prune …`, `skillhook projects add|remove …`) has a line.
      const words = usageOf(command, []).split(/\s+/);
      for (const sub of words.flatMap((word, i) => (words[i - 2] === "skillhook" && words[i - 1] === name && /^[a-z]/.test(word) ? word.split("|") : []))) {
        documented.push(`${name} ${sub}`);
        expect(own?.map((args) => args[0]), `skillhook ${name} ${sub} --help`).toContain(sub);
      }

      for (const args of own ?? []) {
        const usage = usageOf(command, args);
        for (const argv of [[name, ...args, "--help", ...at], [name, "-h", ...args, ...at, "--json"], ["help", name, ...args, ...at]]) {
          const line = `skillhook ${argv.join(" ")}`;
          const h = io(env);
          h.cli.stdin = async () => {
            stdinReads++;
            return "";
          };
          expect(await settle(main(argv, h.cli)), line).toBe(0);
          if (argv.includes("--json")) expect(h.json(), line).toEqual({ ok: true, command: name, usage });
          else expect(h.out(), line).toBe(`${usage}\n`);
          expect(h.err(), line).toBe("");
          expect(snapshot(home.home), line).toEqual(before);
        }
      }
    }
    expect(documented).toEqual(expect.arrayContaining(["jobs prune", "job progress", "service install", "config set", "cloud report", "projects remove"]));
    expect(stdinReads).toBe(0);
    for (const stub of [installService, uninstallService, restartService, enableExposure, disableExposure]) expect(stub).not.toHaveBeenCalled();

    // The same line without --help does what it says, and the snapshot sees it.
    const pruned = io(env);
    expect(await main(["jobs", "prune", "--keep", "0", ...at, "--json"], pruned.cli)).toBe(0);
    expect(pruned.json().removed).toBeGreaterThan(0);
    expect(snapshot(home.home)).not.toEqual(before);
  });
});
