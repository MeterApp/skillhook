import { existsSync, readFileSync } from "node:fs";
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
      res.writeHead(req.url === "/skillhook/latest" ? 200 : 404, { "content-type": "application/json" });
      res.end(JSON.stringify(req.url === "/skillhook/latest" ? { version: newer } : { error: "Not found" }));
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
      expect(human.out()).toContain(`Update available: skillhook`);
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
