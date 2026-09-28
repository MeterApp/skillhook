import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createServer } from "node:http";
import { main, nodeVersionProblem } from "./commands/main.js";
import type { CliIO } from "./commands/shared.js";
import { FAKE_CLAUDE, FAKE_CODEX, tempHome, writeSkill } from "./test-support/helpers.js";

function io(env: NodeJS.ProcessEnv = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const cli: CliIO = { stdout: (t) => out.push(t), stderr: (t) => err.push(t), env, isTTY: false };
  return { cli, out: () => out.join(""), err: () => err.join(""), json: () => JSON.parse(out.join("")) as Record<string, unknown> };
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
});
