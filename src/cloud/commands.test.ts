import { writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../config.js";
import { loadSecrets, readEnvFile } from "../env.js";
import { JobStore } from "../jobs.js";
import { silentLogger } from "../logger.js";
import { SkillRegistry } from "../registry.js";
import { tempHome, writeEnv } from "../test-support/helpers.js";
import { createCommandDispatcher, CommandError, type CommandDeps } from "./commands.js";
import type { CloudPolicy } from "./config.js";
import { CommandLedger } from "./outbox.js";
import type { Command } from "./protocol.js";

const VALUE = "placeholder-env-value-1234";

function deps(policy: CloudPolicy, control: CommandDeps["control"] = {}, uploads: { payloads?: boolean; artifacts?: boolean } = {}) {
  const paths = tempHome("skillhook-commands-");
  writeEnv(paths, { SOME_VALUE: VALUE });
  const config = loadConfig(paths);
  const ledger = new CommandLedger(paths.jobsDir);
  const d: CommandDeps = {
    paths,
    config,
    secrets: () => loadSecrets(paths, {}),
    fileSecrets: () => readEnvFile(paths.envFile),
    registry: new SkillRegistry(paths.skillsDir),
    store: new JobStore(paths.jobsDir, { maxJobs: 10, dedupeWindowSeconds: 60 }),
    logger: silentLogger,
    policy: () => policy,
    ledger,
    snapshot: () => ({ skills: [], skill_errors: [], projects: [], schedules: [], config: {} }),
    uploadPayloads: () => uploads.payloads ?? true,
    uploadArtifacts: () => uploads.artifacts ?? false,
    control,
  };
  return { d, ledger, dispatcher: createCommandDispatcher(d), store: d.store };
}

function command(partial: Partial<Command> & Pick<Command, "id" | "type">): Command {
  return { issued_at: new Date().toISOString(), ...partial };
}

describe("command dispatcher", () => {
  const control: CloudPolicy = { mode: "control", allow_commands: [], deny_commands: [] };

  it("scrubs results, keeps sensitive ones out of the retry cache and answers a repeated id without running again", async () => {
    let runs = 0;
    const { dispatcher, ledger } = deps(control, {
      "skill.run": () => {
        runs++;
        return { result: { note: `the run printed ${VALUE}`, command: ["claude", "-p"] } };
      },
      "secret.generate": () => ({ result: { value: "placeholder-generated" }, sensitive: true }),
    });
    const run = await dispatcher.run(command({ id: "r1", type: "skill.run", args: { name: "x" } }));
    expect(run).toMatchObject({ ok: true, result: { note: "the run printed [redacted]" } });
    expect((run.result as Record<string, unknown>).command).toBeUndefined();
    const again = await dispatcher.run(command({ id: "r1", type: "skill.run", args: { name: "x" } }));
    expect(again).toEqual(run);
    expect(runs).toBe(1);
    const secret = await dispatcher.run(command({ id: "s1", type: "secret.generate", args: { name: "admin" } }));
    expect(secret).toMatchObject({ ok: true, sensitive: true, result: { value: "placeholder-generated" } });
    expect(ledger.cachedResult("s1")).toBeUndefined();
    expect(await dispatcher.run(command({ id: "s1", type: "secret.generate", args: { name: "admin" } }))).toMatchObject({ ok: false, error: { code: "duplicate" } });
    expect(ledger.pendingResults(10).map((r) => r.command_id)).toEqual(["r1", "s1"]);
  });

  it("maps handler errors and timeouts, and refuses unknown or unimplemented commands", async () => {
    const { dispatcher } = deps(control, {
      "job.cancel": () => {
        throw new CommandError("conflict", "job j1 already finished");
      },
      "job.replay": () => {
        throw new Error(`unexpected: ${VALUE}`);
      },
      "schedule.run": () => new Promise((resolve) => setTimeout(() => resolve({ result: {} }), 500)),
    });
    expect(await dispatcher.run(command({ id: "a", type: "job.cancel", args: { id: "j1" } }))).toMatchObject({ ok: false, error: { code: "conflict", message: "job j1 already finished" } });
    expect(await dispatcher.run(command({ id: "b", type: "job.replay", args: { id: "j1" } }))).toMatchObject({ ok: false, error: { code: "internal", message: "unexpected: [redacted]" } });
    expect(await dispatcher.run(command({ id: "c", type: "schedule.run", args: { name: "n" }, timeout_ms: 50 }))).toMatchObject({ ok: false, error: { code: "timeout" } });
    expect(await dispatcher.run(command({ id: "d", type: "update.install", args: {} }))).toMatchObject({ ok: false, error: { code: "unsupported_command" } });
    expect(await dispatcher.run({ id: "e", type: "rm.rf" as Command["type"], issued_at: new Date().toISOString() })).toMatchObject({ ok: false, error: { code: "denied_by_policy" } });
    const artifacts = await dispatcher.run(command({ id: "f", type: "job.artifact", args: { id: "j1", name: "stdout" } }));
    expect(artifacts).toMatchObject({ ok: false, error: { code: "denied_by_policy", message: expect.stringContaining("upload_artifacts") } });
  });

  it("keeps the artifacts that hold the webhook body on the machine when payloads may not leave it", async () => {
    const { dispatcher, store } = deps({ mode: "observe", allow_commands: [], deny_commands: [] }, {}, { payloads: false, artifacts: true });
    const event = { id: "e1", skill: "hello", trigger: "webhook" as const, received_at: new Date().toISOString(), method: "POST", path: "/hooks/hello", query: {}, headers: {}, source_ip: "1", content_type: "application/json", content_length: 22, body_kind: "json" as const, payload: { card: "4242-private" } };
    const job = store.create({ skill: "hello", trigger: "webhook", runner: "claude", source: { ip: "1", method: "POST", path: "/hooks/hello", content_type: "application/json" }, event });
    writeFileSync(store.pathsFor(job.id).prompt, 'Payload:\n{"card":"4242-private"}\n');
    writeFileSync(store.pathsFor(job.id).stdout, "done\n");
    for (const name of ["payload", "event", "prompt"]) {
      const refused = await dispatcher.run(command({ id: `a-${name}`, type: "job.artifact", args: { id: job.id, name } }));
      expect(refused).toMatchObject({ ok: false, error: { code: "denied_by_policy", message: `${name} holds the webhook body, and cloud.upload_payloads is false on this machine` } });
    }
    expect(await dispatcher.run(command({ id: "a-stdout", type: "job.artifact", args: { id: job.id, name: "stdout" } }))).toMatchObject({ ok: true, result: { text: "done\n" } });
    const got = await dispatcher.run(command({ id: "g", type: "job.get", args: { id: job.id, include: ["stdout", "prompt", "payload"] } }));
    expect(got).toMatchObject({ ok: true, result: { artifacts: { stdout: "done\n" }, artifacts_withheld: "prompt, payload: cloud.upload_payloads is false on this machine" } });
    expect(JSON.stringify(got)).not.toContain("4242-private");
  });
});
