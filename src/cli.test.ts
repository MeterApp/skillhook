import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createServer } from "node:http";
import { main, nodeVersionProblem } from "./commands/main.js";
import type { CliIO } from "./commands/shared.js";
import { FAKE_CLAUDE, tempHome } from "./test-support/helpers.js";

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
