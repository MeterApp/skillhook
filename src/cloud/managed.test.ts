import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig, type Config } from "../config.js";
import { buildDefinition, collectDefinition, type SkillDefinition } from "../definitions.js";
import { loadSecrets } from "../env.js";
import { Events, type SkillhookEvent } from "../events.js";
import { JobStore } from "../jobs.js";
import { silentLogger } from "../logger.js";
import { readManagedState } from "../managed-state.js";
import { createManualJob } from "../manual.js";
import { webhookPolicy } from "../project-refresh.js";
import { JobQueue } from "../queue.js";
import { SkillRegistry } from "../registry.js";
import { FakeCloud } from "../test-support/fake-cloud.js";
import { tempHome, writeConfigFile, writeEnv, writeSkill } from "../test-support/helpers.js";
import { checkDefinition, ManagedError, ManagedSkills, validateDefinition } from "./managed.js";

const cleanups: (() => Promise<unknown> | unknown)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});

/** A shell skill whose output names the version and the definition the run was given. */
function skillMd(name: string, version: string, extra = ""): string {
  return `---\nname: ${name}\ndescription: Cloud-managed ${version}.\nskillhook:\n  runner: shell\n  shell:\n    command: ["sh", "-c", "echo ran-${version} def=$SKILLHOOK_DEFINITION"]\n${extra}---\n\nBody ${version}.\n`;
}

function definition(name: string, version: string, extra = "", files: Record<string, string> = {}): SkillDefinition {
  return buildDefinition("skill", name, { "SKILL.md": skillMd(name, version, extra), ...files });
}

async function setup(cloud: Partial<Config["cloud"]> = {}, options: { env?: NodeJS.ProcessEnv; token?: boolean } = {}) {
  const fake = await FakeCloud.start();
  cleanups.push(() => fake.close());
  const paths = tempHome("skillhook-managed-");
  writeConfigFile(paths, { concurrency: 2, cloud: { enabled: true, url: fake.url, machine_id: fake.machineId, mode: "control", managed_skills: true, ...cloud } });
  writeEnv(paths, options.token === false ? {} : { SKILLHOOK_CLOUD_TOKEN: fake.token });
  const config = loadConfig(paths);
  const events = new Events(silentLogger);
  const seen: SkillhookEvent[] = [];
  events.onAny((event) => seen.push(event));
  const registry = new SkillRegistry(paths.skillsDir, { cloudSkillsDir: paths.cloudSkillsDir, managedEnabled: () => config.cloud.managed_skills, onChange: (change) => events.emit("skill.changed", change) });
  const secrets = () => loadSecrets(paths, {});
  const managed = new ManagedSkills({ paths, config, secrets, logger: silentLogger, events, registry, env: options.env ?? {}, timing: { freshenMs: 1_000, syncMs: 2_000 } });
  return { fake, paths, config, events, seen, registry, secrets, managed };
}

describe("checkDefinition", () => {
  const dir = "/tmp/cloud-skills/hello/sha/hello";

  it("accepts a complete, consistent skill definition", () => {
    const def = definition("hello", "v1", "", { "references/a.md": "A" });
    expect(checkDefinition(def, "hello", { dir }).files.map((f) => f.path)).toEqual(["SKILL.md", "references/a.md"]);
  });

  it("refuses what cannot or must not be installed", () => {
    const def = definition("hello", "v1");
    const refuse = (value: SkillDefinition, name: string, code: string, message: RegExp, allow = false) => {
      let caught: unknown;
      try {
        checkDefinition(value, name, { dir, allowUnauthenticated: allow });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(ManagedError);
      expect((caught as ManagedError).code).toBe(code);
      expect((caught as ManagedError).message).toMatch(message);
    };
    refuse({ ...def, kind: "hook" }, "hello", "invalid_args", /hook definition/);
    refuse(def, "other", "invalid_args", /named "hello", not "other"/);
    refuse({ ...def, files: [{ ...def.files[0]!, text: undefined, text_omitted: "too_large" }] }, "hello", "invalid_args", /without its text/);
    refuse({ ...def, files: [{ ...def.files[0]!, text: "tampered" }] }, "hello", "invalid_args", /does not match its hash/);
    refuse({ ...def, sha256: "0".repeat(64) }, "hello", "invalid_args", /digest does not match/);
    const noRoot = buildDefinition("skill", "hello", { "docs/SKILL.md": skillMd("hello", "v1") });
    refuse(noRoot, "hello", "invalid_args", /no SKILL.md at its root/);
    const badName = buildDefinition("skill", "hello", { "SKILL.md": skillMd("other", "v1") });
    refuse(badName, "hello", "invalid_args", /must match its directory name/);
    const open = definition("hello", "v1", "  auth:\n    type: none\n");
    refuse(open, "hello", "denied_by_policy", /auth: none/);
    expect(checkDefinition(open, "hello", { dir, allowUnauthenticated: true }).webhookUnauthenticated).toBe(true);
    // Paths are checked by the schema before anything else: no `..`, no absolute paths, no backslashes.
    for (const bad of ["../x", "a/../b", "/etc/passwd", "a\\b", "./x", "a/./b"]) {
      expect(() => validateDefinition({ ...def, files: [...def.files, { path: bad, sha256: "0".repeat(64), bytes: 0, text: "" }] }), bad).toThrow(ManagedError);
    }
    // A dotfile passes the path rule (hook definitions sit under `.claude/`) but is never installed as part of a skill.
    for (const hidden of [".env", "a/.hidden", ".mcp.json"]) {
      const withHidden = buildDefinition("skill", "hello", { "SKILL.md": skillMd("hello", "v1"), [hidden]: "x" });
      expect(validateDefinition(withHidden).files.map((f) => f.path)).toContain(hidden);
      refuse(withHidden, "hello", "invalid_args", /carries no dotfiles/);
    }
  });
});

describe("ManagedSkills", () => {
  it("installs a definition completely before pointing at it, serves it through the registry and keeps two earlier versions", async () => {
    const { paths, registry, managed, seen } = await setup();
    registry.list(); // prime: changes from here on are notified
    const versions = ["v1", "v2", "v3", "v4"].map((v) => definition("cloudy", v));
    const first = managed.install("cloudy", versions[0]!, { by: "test" });
    expect(first).toMatchObject({ name: "cloudy", changed: true, created: true, sha256: versions[0]!.sha256 });
    const skill = registry.get("cloudy")!;
    expect(skill.source).toEqual({ type: "cloud", sha256: versions[0]!.sha256, installed_at: expect.any(String) });
    expect(skill.file).toBe(path.join(paths.cloudSkillsDir, "cloudy", versions[0]!.sha256, "cloudy", "SKILL.md"));
    expect(skill.definition?.sha256).toBe(versions[0]!.sha256); // the files on disk hash to what the cloud said
    expect(seen.filter((e) => e.type === "skill.changed").map((e) => e.data)).toEqual([{ name: "cloudy", action: "added", source: skill.source, definition_sha256: versions[0]!.sha256 }]);
    // Installing the same definition again changes nothing.
    expect(managed.install("cloudy", versions[0]!)).toMatchObject({ changed: false });
    for (const v of versions.slice(1)) managed.install("cloudy", v, { by: "test" });
    const state = readManagedState(paths.cloudSkillsDir);
    expect(state.skills.cloudy).toMatchObject({ sha256: versions[3]!.sha256, previous: [versions[2]!.sha256, versions[1]!.sha256], by: "test" });
    expect(readdirSync(path.join(paths.cloudSkillsDir, "cloudy")).sort()).toEqual([versions[1]!.sha256, versions[2]!.sha256, versions[3]!.sha256].sort());
    expect(registry.get("cloudy")?.description).toBe("Cloud-managed v4.");
    expect(registry.list().skills.map((s) => s.name)).toEqual(["cloudy"]);
    // A local skill of the same name wins, and the shadowing is reported.
    writeSkill(paths, "cloudy", "description: local wins");
    const listed = registry.list();
    expect(listed.skills.find((s) => s.name === "cloudy")?.source).toEqual({ type: "home" });
    expect(listed.errors.map((e) => e.error)).toEqual([expect.stringContaining('cloud-managed skill "cloudy" is shadowed by')]);
    // Removal keeps the files where a person finds them.
    const removed = managed.remove("cloudy");
    expect(removed.removed).toBe(true);
    expect(removed.kept_at).toContain(path.join(paths.jobsDir, ".removed-skills", "cloudy-cloud-"));
    expect(existsSync(path.join(paths.cloudSkillsDir, "cloudy"))).toBe(false);
    expect(managed.remove("cloudy")).toEqual({ removed: false });
  });

  it("reconciles with what the cloud assigns: installs, updates, removes, and reports a cloud it cannot reach without changing anything", async () => {
    const { fake, paths, registry, managed, seen } = await setup();
    const a1 = definition("alpha", "v1");
    const b1 = definition("beta", "v1");
    fake.assigned.set("alpha", { definition: a1 });
    fake.assigned.set("beta", { definition: b1 });
    const first = await managed.reconcile("connect");
    expect(first).toMatchObject({ reason: "connect", installed: ["alpha", "beta"], updated: [], removed: [], unchanged: 0, errors: [] });
    expect(registry.list().skills.map((s) => s.name)).toEqual(["alpha", "beta"]);
    expect(fake.skillRequests.map((r) => r.path)).toEqual(["/api/agent/skills", "/api/agent/skills/alpha", "/api/agent/skills/beta"]);
    // Nothing changed: one request, nothing pulled.
    fake.skillRequests.length = 0;
    expect(await managed.reconcile("interval")).toMatchObject({ installed: [], updated: [], removed: [], unchanged: 2 });
    expect(fake.skillRequests.map((r) => r.path)).toEqual(["/api/agent/skills"]);
    // A new version of alpha, beta unassigned.
    const a2 = definition("alpha", "v2");
    fake.assigned.set("alpha", { definition: a2 });
    fake.assigned.delete("beta");
    const third = await managed.reconcile("command", { by: "ada" });
    expect(third).toMatchObject({ installed: [], updated: ["alpha"], removed: ["beta"], unchanged: 0 });
    expect(registry.get("alpha")?.description).toBe("Cloud-managed v2.");
    expect(registry.get("beta")).toBeUndefined();
    expect(readManagedState(paths.cloudSkillsDir).skills.alpha?.by).toBe("ada");
    expect(seen.filter((e) => e.type === "skills.synced")).toHaveLength(3);
    // A definition the machine refuses is an error line, the rest proceeds.
    fake.assigned.set("open", { definition: definition("open", "v1", "  auth:\n    type: none\n") });
    const fourth = await managed.reconcile("interval");
    expect(fourth?.errors).toEqual([{ name: "open", error: expect.stringContaining("auth: none") }]);
    expect(registry.get("open")).toBeUndefined();
    fake.assigned.set("open", { definition: definition("open", "v1", "  auth:\n    type: none\n"), allow_unauthenticated: true });
    expect(await managed.reconcile("interval")).toMatchObject({ installed: ["open"], errors: [] });
    // The cloud is down: a report with one error, the served set untouched.
    fake.assignedMode = "500";
    const down = await managed.reconcile("interval");
    expect(down).toMatchObject({ installed: [], updated: [], removed: [], unchanged: 0, errors: [{ name: "*", error: expect.stringContaining("could not list") }] });
    expect(registry.list().skills.map((s) => s.name)).toEqual(["alpha", "open"]);
    expect(managed.status()).toMatchObject({ enabled: true, allowed: true, last_sync_at: down?.at, skills: [{ name: "alpha", sha256: a2.sha256 }, { name: "open" }] });
  });

  it("pulls nothing unless the machine opted in and its policy allows skills.sync", async () => {
    const observe = await setup({ mode: "observe" });
    observe.fake.assigned.set("alpha", { definition: definition("alpha", "v1") });
    expect(await observe.managed.reconcile("connect")).toBeUndefined();
    expect(observe.managed.gate()).toEqual({ ok: false, reason: expect.stringContaining("cloud.mode: control") });
    expect(observe.fake.skillRequests).toEqual([]);
    const allowed = await setup({ mode: "observe", allow_commands: ["skills.sync"] });
    allowed.fake.assigned.set("alpha", { definition: definition("alpha", "v1") });
    expect(await allowed.managed.reconcile("connect")).toMatchObject({ installed: ["alpha"] });
    const denied = await setup({ deny_commands: ["skills.*"] });
    expect(denied.managed.gate()).toEqual({ ok: false, reason: expect.stringContaining("deny_commands") });
    const off = await setup({ managed_skills: false });
    expect(off.managed.gate()).toEqual({ ok: false, reason: "cloud.managed_skills is false" });
    expect(off.managed.status()).toMatchObject({ enabled: false, allowed: false, skills: [] });
    const killed = await setup({}, { env: { SKILLHOOK_NO_CLOUD: "1" } });
    expect(killed.managed.gate()).toEqual({ ok: false, reason: "SKILLHOOK_NO_CLOUD is set" });
    const noToken = await setup({}, { token: false });
    expect(noToken.managed.gate()).toEqual({ ok: false, reason: expect.stringContaining("SKILLHOOK_CLOUD_TOKEN") });
    const disabled = await setup({ enabled: false });
    expect(disabled.managed.gate()).toEqual({ ok: false, reason: "cloud.enabled is false" });
    // The gate is read at use time: turning the switch on in the live config is enough. The registry follows the same
    // switch: with it off, nothing in cloud-skills/ is served, whatever is on disk.
    off.managed.install("alpha", definition("alpha", "v1"));
    expect(off.registry.get("alpha")).toBeUndefined();
    expect(off.registry.list().skills).toEqual([]);
    off.config.cloud.managed_skills = true;
    expect(off.managed.gate()).toEqual({ ok: true });
    expect(off.registry.get("alpha")?.source).toMatchObject({ type: "cloud" });
    off.config.cloud.managed_skills = false;
    expect(off.registry.get("alpha")).toBeUndefined();
  });

  it("checks a skill against the cloud before a run: unchanged, changed, unassigned, unreachable", async () => {
    const { fake, paths, managed, registry } = await setup();
    const v1 = definition("cloudy", "v1");
    fake.assigned.set("cloudy", { definition: v1 });
    await managed.reconcile("connect");
    fake.skillRequests.length = 0;
    expect(await managed.freshen("cloudy")).toEqual({ fresh: true, changed: false, sha256: v1.sha256 });
    expect(fake.skillRequests).toEqual([{ path: "/api/agent/skills/cloudy", ifNoneMatch: `"${v1.sha256}"` }]);
    const v2 = definition("cloudy", "v2");
    fake.assigned.set("cloudy", { definition: v2 });
    expect(await managed.freshen("cloudy")).toEqual({ fresh: true, changed: true, sha256: v2.sha256 });
    expect(registry.get("cloudy")?.description).toBe("Cloud-managed v2.");
    fake.assignedMode = "500";
    expect(await managed.freshen("cloudy")).toEqual({ fresh: false, changed: false, sha256: v2.sha256, error: expect.stringContaining("boom") });
    fake.assignedMode = "hang";
    fake.hangMs = 3_000;
    expect(await managed.freshen("cloudy")).toMatchObject({ fresh: false, changed: false, sha256: v2.sha256 });
    fake.assignedMode = "ok";
    // The cloud sends something this machine refuses: the copy on disk stays.
    fake.assigned.set("cloudy", { definition: definition("cloudy", "v3", "  auth:\n    type: none\n") });
    expect(await managed.freshen("cloudy")).toEqual({ fresh: false, changed: false, sha256: v2.sha256, error: expect.stringContaining("auth: none") });
    expect(registry.get("cloudy")?.description).toBe("Cloud-managed v2.");
    fake.assigned.delete("cloudy");
    expect(await managed.freshen("cloudy")).toEqual({ fresh: true, changed: true, unassigned: true });
    expect(registry.get("cloudy")).toBeUndefined();
    expect(existsSync(path.join(paths.cloudSkillsDir, "cloudy"))).toBe(false);
    expect(await managed.freshen("cloudy")).toMatchObject({ fresh: false, changed: false, error: expect.stringContaining("not a cloud-managed skill") });
    expect(await managed.freshen("never")).toMatchObject({ fresh: false, error: expect.stringContaining("not a cloud-managed skill") });
  });

  it("adopts a home skill whose definition the cloud already holds, and refuses one it does not", async () => {
    const { paths, registry, managed } = await setup();
    writeSkill(paths, "hello", "description: adopt me");
    const sha = collectDefinition(registry.get("hello")!)!.sha256;
    expect(() => managed.adopt("hello", "0".repeat(64))).toThrow(/the cloud holds 000000000000…/);
    expect(() => managed.adopt("missing", sha)).toThrow(/no skill named/);
    const adopted = managed.adopt("hello", sha, { by: "ada" });
    expect(adopted).toMatchObject({ name: "hello", sha256: sha, changed: true, created: true });
    expect(existsSync(path.join(paths.skillsDir, "hello"))).toBe(false);
    expect(readFileSync(path.join(adopted.kept_at, "SKILL.md"), "utf8")).toContain("adopt me");
    const skill = registry.get("hello")!;
    expect(skill.source).toMatchObject({ type: "cloud", sha256: sha });
    expect(skill.definition?.sha256).toBe(sha); // the same files, the same hash: adoption changes nothing the cloud sees
    expect(readManagedState(paths.cloudSkillsDir).skills.hello).toMatchObject({ by: "ada", adopted_from: adopted.kept_at });
    expect(() => managed.adopt("hello", sha)).toThrow(/already cloud-managed/);
  });
});

describe("JobQueue with cloud-managed skills", () => {
  async function queueSetup(cloud: Partial<Config["cloud"]> = {}) {
    const ctx = await setup(cloud);
    const store = new JobStore(ctx.paths.jobsDir, { maxJobs: 100, dedupeWindowSeconds: 60 });
    const queue = new JobQueue({ store, config: ctx.config, registry: ctx.registry, secrets: ctx.secrets, fileSecrets: ctx.secrets, logger: silentLogger, events: ctx.events, managed: ctx.managed });
    cleanups.push(() => queue.shutdown());
    return { ...ctx, store, queue };
  }

  it("runs the definition the cloud holds at the start of the job, and records which one and whether the cloud was asked", async () => {
    const { fake, store, queue, registry, managed, config } = await queueSetup();
    const v1 = definition("cloudy", "v1");
    fake.assigned.set("cloudy", { definition: v1 });
    await managed.reconcile("connect");
    const skill = registry.get("cloudy")!;
    // Unchanged: the cached copy runs, confirmed.
    const same = createManualJob({ config, store }, { skill, payload: {}, headers: {}, trigger: "api", sourceMethod: "LOCAL" });
    queue.enqueue(same);
    const sameDone = await queue.waitFor(same.id, 15_000);
    expect(sameDone).toMatchObject({ status: "succeeded", definition_sha256: v1.sha256, definition_fresh: true });
    expect(sameDone?.result).toContain(`ran-v1 def=${v1.sha256}`);
    // Changed between admission and run: the new definition runs.
    const v2 = definition("cloudy", "v2");
    const admitted = createManualJob({ config, store }, { skill, payload: {}, headers: {}, trigger: "api", sourceMethod: "LOCAL" });
    fake.assigned.set("cloudy", { definition: v2 });
    queue.enqueue(admitted);
    const changed = await queue.waitFor(admitted.id, 15_000);
    expect(changed).toMatchObject({ status: "succeeded", definition_sha256: v2.sha256, definition_fresh: true });
    expect(changed?.result).toContain(`ran-v2 def=${v2.sha256}`);
    expect(changed?.skill_file).toContain(v2.sha256);
    // The cloud cannot be asked: the copy on disk runs, flagged.
    fake.assignedMode = "500";
    const offline = createManualJob({ config, store }, { skill: registry.get("cloudy")!, payload: {}, headers: {}, trigger: "api", sourceMethod: "LOCAL" });
    queue.enqueue(offline);
    const ran = await queue.waitFor(offline.id, 15_000);
    expect(ran).toMatchObject({ status: "succeeded", definition_sha256: v2.sha256, definition_fresh: false });
    expect(ran?.result).toContain("ran-v2");
    // … unless the machine requires a fresh definition.
    config.cloud.require_fresh_definitions = true;
    const strict = createManualJob({ config, store }, { skill: registry.get("cloudy")!, payload: {}, headers: {}, trigger: "api", sourceMethod: "LOCAL" });
    queue.enqueue(strict);
    const failed = await queue.waitFor(strict.id, 15_000);
    expect(failed).toMatchObject({ status: "failed", error: expect.stringContaining("cloud.require_fresh_definitions is on") });
    config.cloud.require_fresh_definitions = false;
    fake.assignedMode = "ok";
    // Unassigned meanwhile: the job fails, the skill is gone.
    const doomed = createManualJob({ config, store }, { skill: registry.get("cloudy")!, payload: {}, headers: {}, trigger: "api", sourceMethod: "LOCAL" });
    fake.assigned.delete("cloudy");
    queue.enqueue(doomed);
    expect(await queue.waitFor(doomed.id, 15_000)).toMatchObject({ status: "failed", error: expect.stringContaining("no longer assigned to this machine") });
    expect(registry.get("cloudy")).toBeUndefined();
  });

  it("fails a webhook job whose admission policy the new definition changed, so the sender verifies again", async () => {
    const { fake, store, queue, registry, managed, config } = await queueSetup();
    const v1 = definition("cloudy", "v1");
    fake.assigned.set("cloudy", { definition: v1 });
    await managed.reconcile("connect");
    const skill = registry.get("cloudy")!;
    const admit = () => store.create({ skill: "cloudy", trigger: "webhook", runner: "shell", webhook_policy: webhookPolicy(registry.get("cloudy")!), run_overrides: {}, source: { ip: "203.0.113.1", method: "POST", path: "/hooks/cloudy", content_type: "application/json" }, event: { id: "", skill: "cloudy", trigger: "webhook", received_at: new Date().toISOString(), method: "POST", path: "/hooks/cloudy", query: {}, headers: {}, source_ip: "203.0.113.1", content_type: "application/json", content_length: 2, body_kind: "json", payload: {} } });
    void skill;
    // A new body with the same policy runs.
    const bodyOnly = admit();
    fake.assigned.set("cloudy", { definition: definition("cloudy", "v2") });
    queue.enqueue(bodyOnly);
    expect(await queue.waitFor(bodyOnly.id, 15_000)).toMatchObject({ status: "succeeded" });
    // A changed filter does not: the delivery was admitted under other rules.
    const filtered = admit();
    fake.assigned.set("cloudy", { definition: definition("cloudy", "v3", "  when:\n    - { path: action, equals: opened }\n") });
    queue.enqueue(filtered);
    expect(await queue.waitFor(filtered.id, 15_000)).toMatchObject({ status: "failed", error: expect.stringContaining("webhook policy changed since admission") });
  });
});
