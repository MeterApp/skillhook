import { cpSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { ConfigSchema, RunnerNameSchema, writeConfig } from "../config.js";
import { ADMIN_TOKEN_ENV, defaultSecretEnvFor, readEnvFile, upsertEnvVar } from "../env.js";
import { findExample } from "../examples.js";
import { generateSecret } from "../ids.js";
import { ensureDir } from "../util.js";
import { bool, num, str, UsageError, type Ctx } from "./shared.js";

export const INIT_USAGE = "Usage: skillhook init [--dir PATH] [--runner claude|codex] [--model MODEL] [--port N] [--force]";

export async function initCommand(ctx: Ctx): Promise<number> {
  const { paths } = ctx;
  const created: string[] = [];
  const skipped: string[] = [];
  const force = bool(ctx.flags, "force");
  const runnerFlag = str(ctx.flags, "runner");
  if (runnerFlag && !RunnerNameSchema.safeParse(runnerFlag).success) throw new UsageError(`--runner must be claude, codex or shell`, INIT_USAGE);

  for (const dir of [paths.home, paths.skillsDir, paths.jobsDir, paths.logsDir]) {
    if (!existsSync(dir)) {
      ensureDir(dir);
      created.push(dir);
    }
  }

  if (!existsSync(paths.configFile) || force) {
    const config: Record<string, unknown> = {
      $schema: "https://raw.githubusercontent.com/MeterApp/skillhook/main/schema/skillhook.schema.json",
      port: num(ctx.flags, "port") ?? 8787,
      host: "127.0.0.1",
      defaults: { runner: runnerFlag ?? "claude", ...(str(ctx.flags, "model") ? { model: str(ctx.flags, "model") } : {}) },
      concurrency: 2,
    };
    ConfigSchema.parse(config);
    writeConfig(paths, config);
    created.push(paths.configFile);
  } else skipped.push(paths.configFile);

  const env = readEnvFile(paths.envFile);
  const generatedSecrets: Record<string, string> = {};
  if (!env[ADMIN_TOKEN_ENV]) {
    const token = generateSecret();
    upsertEnvVar(paths.envFile, ADMIN_TOKEN_ENV, token);
    generatedSecrets[ADMIN_TOKEN_ENV] = token;
    created.push(`${paths.envFile} (${ADMIN_TOKEN_ENV})`);
  }

  const helloDir = path.join(paths.skillsDir, "hello");
  if (!existsSync(helloDir)) {
    const example = findExample("hello");
    if (example) {
      mkdirSync(helloDir, { recursive: true });
      cpSync(example.dir, helloDir, { recursive: true });
      created.push(helloDir);
    }
  } else skipped.push(helloDir);
  const helloSecretEnv = defaultSecretEnvFor("hello");
  if (!env[helloSecretEnv]) {
    const secret = generateSecret();
    upsertEnvVar(paths.envFile, helloSecretEnv, secret);
    generatedSecrets[helloSecretEnv] = secret;
  }

  const next = [
    "skillhook doctor                      # check claude/codex login, Tailscale, secrets",
    "skillhook run hello --payload '{\"name\":\"world\"}'   # run a skill locally (no HTTP)",
    "skillhook serve                       # start the webhook server (or: skillhook service install)",
    "skillhook expose tailscale            # permanent public HTTPS URL via Tailscale Funnel",
    "skillhook send hello --wait 60        # POST a signed test webhook to the running server",
    "skillhook skills new my-skill         # add your own skill",
  ];
  const human = [
    `Initialized skillhook in ${paths.home}`,
    ...(created.length ? ["", "Created:", ...created.map((c) => `  ${c}`)] : []),
    ...(skipped.length ? ["", "Kept (already existed):", ...skipped.map((c) => `  ${c}`)] : []),
    ...(Object.keys(generatedSecrets).length ? ["", "Secrets written to .env (mode 600):", ...Object.keys(generatedSecrets).map((k) => `  ${k}`)] : []),
    "",
    "Next:",
    ...next.map((n) => `  ${n}`),
  ].join("\n");
  ctx.print(human, { ok: true, home: paths.home, created, skipped, secrets: Object.keys(generatedSecrets), next });
  return 0;
}
