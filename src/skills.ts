import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { parseFrontmatter } from "./frontmatter.js";
import { ClaudePermissionModeSchema, CodexSandboxSchema, CommandSpecSchema, RunnerNameSchema, type RunnerName } from "./config.js";
import { defaultSecretEnvFor } from "./env.js";
import { isValidTimeZone, parseCron, type CronSpec } from "./schedule.js";
import { errorMessage, isDirectory, isValidSkillName } from "./util.js";

// ---------------------------------------------------------------------------
// Frontmatter schema: the standard Agent Skills fields plus a `skillhook:` block.
// ---------------------------------------------------------------------------

export const ConditionSchema = z
  .object({
    /** Dotted path into the parsed payload, e.g. `data.issue.level`. */
    path: z.string().optional(),
    /** Request header name (case-insensitive). */
    header: z.string().optional(),
    /** Query-string parameter. */
    query: z.string().optional(),
    equals: z.unknown().optional(),
    not_equals: z.unknown().optional(),
    in: z.array(z.unknown()).optional(),
    /** Regular expression tested against the stringified value. */
    matches: z.string().optional(),
    exists: z.boolean().optional(),
    contains: z.string().optional(),
  })
  .strict()
  .refine((c) => [c.path, c.header, c.query].filter((v) => v !== undefined).length === 1, {
    message: "A condition needs exactly one of `path`, `header` or `query`",
  });
export type Condition = z.infer<typeof ConditionSchema>;

const secretEnv = z.string().regex(/^[A-Z_][A-Z0-9_]*$/, "secret_env must be an ENV_VAR_NAME").optional();
const allowIps = z.array(z.string()).optional();
const tolerance = z.number().int().positive().optional();

export const AuthSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("none"), allow_ips: allowIps }).strict(),
  z
    .object({
      type: z.literal("bearer"),
      secret_env: secretEnv,
      /** Header carrying the token. `authorization` (default) expects `Bearer <token>`; any other header is compared raw. */
      header: z.string().optional(),
      /** Also accept `?token=` for senders that cannot set headers. Tokens in URLs end up in logs; prefer headers. */
      allow_query_token: z.boolean().optional(),
      allow_ips: allowIps,
    })
    .strict(),
  z.object({ type: z.literal("basic"), secret_env: secretEnv, allow_ips: allowIps }).strict(),
  z
    .object({
      type: z.literal("hmac"),
      secret_env: secretEnv,
      header: z.string().optional(),
      /** Prefix to strip from the header value, e.g. `sha256=`. */
      prefix: z.string().optional(),
      encoding: z.enum(["hex", "base64"]).optional(),
      algorithm: z.enum(["sha256", "sha1", "sha512"]).optional(),
      /** Header whose value uniquely identifies a delivery (used for replay de-duplication). */
      delivery_id_header: z.string().optional(),
      /** When set, the signed string is `<timestamp>.<body>` and the timestamp must be fresh. */
      timestamp_header: z.string().optional(),
      tolerance_seconds: tolerance,
      allow_ips: allowIps,
    })
    .strict(),
  z.object({ type: z.literal("github"), secret_env: secretEnv, allow_ips: allowIps }).strict(),
  z.object({ type: z.literal("sentry"), secret_env: secretEnv, allow_ips: allowIps }).strict(),
  z.object({ type: z.literal("linear"), secret_env: secretEnv, allow_ips: allowIps }).strict(),
  z.object({ type: z.literal("standard-webhooks"), secret_env: secretEnv, tolerance_seconds: tolerance, allow_ips: allowIps }).strict(),
  z.object({ type: z.literal("granola"), secret_env: secretEnv, tolerance_seconds: tolerance, allow_ips: allowIps }).strict(),
  z.object({ type: z.literal("svix"), secret_env: secretEnv, tolerance_seconds: tolerance, allow_ips: allowIps }).strict(),
  z.object({ type: z.literal("stripe"), secret_env: secretEnv, tolerance_seconds: tolerance, allow_ips: allowIps }).strict(),
  z.object({ type: z.literal("slack"), secret_env: secretEnv, tolerance_seconds: tolerance, allow_ips: allowIps }).strict(),
]);
export type AuthConfig = z.infer<typeof AuthSchema>;
export type AuthType = AuthConfig["type"];
export const AUTH_TYPES = AuthSchema.options.map((o) => o.shape.type.value) as AuthType[];

export const ScheduleObjectSchema = z
  .object({
    /** Five-field cron expression (`minute hour day-of-month month day-of-week`) or an alias: `@hourly`, `@daily`, `@midnight`, `@weekly`, `@monthly`, `@yearly`. */
    cron: z.string().min(1),
    /** IANA time zone the expression is read in (default `UTC`). */
    timezone: z.string().optional(),
    /** Slots missed while the server was stopped or the machine asleep: run the most recent one (`latest`, default), every one up to 24 (`all`), or none. */
    catch_up: z.enum(["latest", "all", "none"]).optional(),
    /** When the previous run of this skill is still queued or running at the next slot: skip that slot (default) or queue behind it. */
    overlap: z.enum(["skip", "queue"]).optional(),
    /** Static object merged into the payload of every scheduled run (under the `scheduled_for` and `schedule` fields skillhook adds). */
    payload: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();
/** A cron expression (read in UTC), a full object, or `false` to cancel a schedule a hook would inherit from its SKILL.md. */
export const ScheduleSchema = z.union([z.string().min(1), z.literal(false), ScheduleObjectSchema]);
export type ScheduleConfig = z.infer<typeof ScheduleSchema>;

export const SkillhookBlockSchema = z
  .object({
    runner: RunnerNameSchema.optional(),
    /** Passed to `claude --model` / `codex -m`. Aliases (`opus`, `sonnet`, `haiku`) or full ids. */
    model: z.string().optional(),
    /** `claude --effort` / codex `model_reasoning_effort`. */
    effort: z.string().optional(),
    /** Working directory for the agent (supports `~`). Defaults to the skill directory. */
    cwd: z.string().optional(),
    timeout_seconds: z.number().int().positive().optional(),
    auth: AuthSchema.optional(),
    /** All conditions must hold or the delivery is acknowledged and skipped. */
    when: z.array(ConditionSchema).optional(),
    /** Env var names (from `.env` or the server environment) exposed to the agent. */
    env: z.array(z.string()).optional(),
    /** How many jobs of this skill may run at once (default 1). */
    concurrency: z.number().int().min(1).optional(),
    dedupe: z
      .object({
        /** Dotted path into the payload whose value identifies the delivery (wins over `header` and the provider header). */
        path: z.string().optional(),
        /** Request header whose value identifies the delivery. */
        header: z.string().optional(),
        /** Ignore a delivery whose payload and query string equal those of a job that is still queued or running (default: `jobs.dedupe_in_flight`, true). */
        in_flight: z.boolean().optional(),
      })
      .strict()
      .optional(),
    claude: z
      .object({
        permission_mode: ClaudePermissionModeSchema.optional(),
        allowed_tools: z.array(z.string()).optional(),
        disallowed_tools: z.array(z.string()).optional(),
        add_dirs: z.array(z.string()).optional(),
        max_budget_usd: z.number().positive().optional(),
        append_system_prompt: z.string().optional(),
        args: z.array(z.string()).optional(),
      })
      .strict()
      .optional(),
    codex: z
      .object({
        sandbox: CodexSandboxSchema.optional(),
        network_access: z.boolean().optional(),
        profile: z.string().optional(),
        add_dirs: z.array(z.string()).optional(),
        args: z.array(z.string()).optional(),
      })
      .strict()
      .optional(),
    shell: z.object({ command: CommandSpecSchema }).strict().optional(),
    enabled: z.boolean().optional(),
    /** Also run this skill on a cron schedule, without a webhook delivery: `"5 * * * *"` (UTC) or `{ cron, timezone, catch_up, overlap, payload }`. See docs/schedules.md. */
    schedule: ScheduleSchema.optional(),
    /** `false` makes a scheduled skill schedule-only: `POST /hooks/<name>` answers `404 schedule_only` and no secret is required. */
    webhook: z.boolean().optional(),
  })
  .strict();
export type SkillhookBlock = z.infer<typeof SkillhookBlockSchema>;

export const SkillFrontmatterSchema = z
  .object({
    name: z.string(),
    description: z.string().min(1).max(1024),
    license: z.string().optional(),
    compatibility: z.string().max(500).optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
    "allowed-tools": z.string().optional(),
    skillhook: SkillhookBlockSchema.optional(),
  })
  .passthrough();

// ---------------------------------------------------------------------------
// Normalized auth (presets expanded, defaults applied)
// ---------------------------------------------------------------------------

export type NormalizedAuth =
  | { type: "none"; allow_ips?: string[] }
  | { type: "bearer"; secret_env: string; header: string; allow_query_token: boolean; allow_ips?: string[] }
  | { type: "basic"; secret_env: string; allow_ips?: string[] }
  | {
      type: "hmac";
      secret_env: string;
      header: string;
      prefix: string;
      encoding: "hex" | "base64";
      algorithm: "sha256" | "sha1" | "sha512";
      delivery_id_header?: string;
      timestamp_header?: string;
      tolerance_seconds: number;
      preset?: "github" | "sentry" | "linear";
      allow_ips?: string[];
    }
  | { type: "standard-webhooks"; secret_env: string; tolerance_seconds: number; preset?: "granola" | "svix"; allow_ips?: string[] }
  | { type: "stripe"; secret_env: string; tolerance_seconds: number; allow_ips?: string[] }
  | { type: "slack"; secret_env: string; tolerance_seconds: number; allow_ips?: string[] };

export const DEFAULT_TOLERANCE_SECONDS = 300;

export function normalizeAuth(skillName: string, auth: AuthConfig | undefined): NormalizedAuth {
  const fallbackEnv = defaultSecretEnvFor(skillName);
  const a = auth ?? { type: "bearer" as const };
  const secret_env = "secret_env" in a && a.secret_env ? a.secret_env : fallbackEnv;
  const allow_ips = a.allow_ips;
  switch (a.type) {
    case "none":
      return { type: "none", allow_ips };
    case "bearer":
      return { type: "bearer", secret_env, header: (a.header ?? "authorization").toLowerCase(), allow_query_token: a.allow_query_token ?? false, allow_ips };
    case "basic":
      return { type: "basic", secret_env, allow_ips };
    case "hmac":
      return {
        type: "hmac",
        secret_env,
        header: (a.header ?? "x-signature-256").toLowerCase(),
        prefix: a.prefix ?? "",
        encoding: a.encoding ?? "hex",
        algorithm: a.algorithm ?? "sha256",
        delivery_id_header: a.delivery_id_header?.toLowerCase(),
        timestamp_header: a.timestamp_header?.toLowerCase(),
        tolerance_seconds: a.tolerance_seconds ?? DEFAULT_TOLERANCE_SECONDS,
        allow_ips,
      };
    case "github":
      return { type: "hmac", secret_env, header: "x-hub-signature-256", prefix: "sha256=", encoding: "hex", algorithm: "sha256", delivery_id_header: "x-github-delivery", tolerance_seconds: DEFAULT_TOLERANCE_SECONDS, preset: "github", allow_ips };
    case "sentry":
      return { type: "hmac", secret_env, header: "sentry-hook-signature", prefix: "", encoding: "hex", algorithm: "sha256", delivery_id_header: "request-id", tolerance_seconds: DEFAULT_TOLERANCE_SECONDS, preset: "sentry", allow_ips };
    case "linear":
      return { type: "hmac", secret_env, header: "linear-signature", prefix: "", encoding: "hex", algorithm: "sha256", delivery_id_header: "linear-delivery", tolerance_seconds: DEFAULT_TOLERANCE_SECONDS, preset: "linear", allow_ips };
    case "standard-webhooks":
      return { type: "standard-webhooks", secret_env, tolerance_seconds: a.tolerance_seconds ?? DEFAULT_TOLERANCE_SECONDS, allow_ips };
    case "granola":
      return { type: "standard-webhooks", secret_env, tolerance_seconds: a.tolerance_seconds ?? DEFAULT_TOLERANCE_SECONDS, preset: "granola", allow_ips };
    case "svix":
      return { type: "standard-webhooks", secret_env, tolerance_seconds: a.tolerance_seconds ?? DEFAULT_TOLERANCE_SECONDS, preset: "svix", allow_ips };
    case "stripe":
      return { type: "stripe", secret_env, tolerance_seconds: a.tolerance_seconds ?? DEFAULT_TOLERANCE_SECONDS, allow_ips };
    case "slack":
      return { type: "slack", secret_env, tolerance_seconds: a.tolerance_seconds ?? DEFAULT_TOLERANCE_SECONDS, allow_ips };
  }
}

// ---------------------------------------------------------------------------
// Normalized schedule (cron parsed, defaults applied)
// ---------------------------------------------------------------------------

export interface NormalizedSchedule {
  /** The expression as written (aliases expanded). */
  cron: string;
  timezone: string;
  catch_up: "latest" | "all" | "none";
  overlap: "skip" | "queue";
  payload?: Record<string, unknown>;
  spec: CronSpec;
}

/** Parses and validates a `schedule:` value; throws `SkillError` so an unusable schedule stops the skill from loading rather than silently never firing. */
export function normalizeSchedule(skillName: string, schedule: ScheduleConfig | undefined, dir: string): NormalizedSchedule | undefined {
  if (schedule === undefined || schedule === false) return undefined;
  const object = typeof schedule === "string" ? { cron: schedule } : schedule;
  let spec: CronSpec;
  try {
    spec = parseCron(object.cron);
  } catch (error) {
    throw new SkillError(`Skill "${skillName}": invalid schedule: ${errorMessage(error)}`, dir);
  }
  const timezone = object.timezone ?? "UTC";
  if (!isValidTimeZone(timezone)) throw new SkillError(`Skill "${skillName}": unknown time zone "${timezone}" in schedule (use an IANA name such as Europe/Berlin)`, dir);
  return { cron: spec.text, timezone, catch_up: object.catch_up ?? "latest", overlap: object.overlap ?? "skip", payload: object.payload, spec };
}

/** The `schedule` and `webhook` fields of a `Skill`, validated together: a hook that is neither reachable nor scheduled can never run. */
export function resolveSchedule(skillName: string, config: SkillhookBlock, dir: string): { schedule?: NormalizedSchedule; webhook: boolean } {
  const schedule = normalizeSchedule(skillName, config.schedule, dir);
  const webhook = config.webhook !== false;
  if (!webhook && !schedule) throw new SkillError(`Skill "${skillName}": \`webhook: false\` needs a \`schedule\`; without either the skill could never run`, dir);
  return schedule ? { schedule, webhook } : { webhook };
}

/** Human-readable description of what a sender must do to authenticate. */
export function describeAuth(auth: NormalizedAuth): string {
  switch (auth.type) {
    case "none":
      return "no authentication (anyone who knows the URL can trigger this skill)";
    case "bearer":
      return auth.header === "authorization" ? `Authorization: Bearer <$${auth.secret_env}>` : `${auth.header}: <$${auth.secret_env}>`;
    case "basic":
      return `HTTP Basic auth, user:password from $${auth.secret_env}`;
    case "hmac":
      return `${auth.preset ? `${auth.preset} ` : ""}HMAC-${auth.algorithm.toUpperCase()} of the body in ${auth.header}${auth.prefix ? ` (prefix ${auth.prefix})` : ""}, secret $${auth.secret_env}`;
    case "standard-webhooks":
      return `${auth.preset ? `${auth.preset} ` : ""}Standard Webhooks signature (webhook-id/-timestamp/-signature), secret $${auth.secret_env}`;
    case "stripe":
      return `Stripe-Signature (t=,v1=), signing secret $${auth.secret_env}`;
    case "slack":
      return `Slack signing secret (X-Slack-Signature / X-Slack-Request-Timestamp), $${auth.secret_env}`;
  }
}

// ---------------------------------------------------------------------------
// Skill loading
// ---------------------------------------------------------------------------

/** Where a skill came from: its own directory under `<home>/skills`, or a hook in a linked project's `skillhook.yaml`. */
export type SkillSource =
  | { type: "home" }
  | {
      type: "project";
      /** The project (repository) directory. */
      dir: string;
      /** The `skillhook.yaml` that defines the hook. */
      file: string;
      /** How the hook is implemented: a `SKILL.md` in the project, an inline `prompt`, or a shell command (`run`). */
      kind: "skill" | "prompt" | "run";
    };

export interface Skill {
  name: string;
  description: string;
  /** Directory whose files the agent may use (`--add-dir`, `{{skill_dir}}`): the skill directory, or the project directory for `run`/`prompt` hooks. */
  dir: string;
  /** The file that defines the skill: `SKILL.md`, or the project's `skillhook.yaml` for `run`/`prompt` hooks. */
  file: string;
  /** Markdown instructions (frontmatter removed). */
  body: string;
  frontmatter: Record<string, unknown>;
  config: SkillhookBlock;
  auth: NormalizedAuth;
  /** The cron schedule this skill runs on, when it has one (`schedule:` in the block). */
  schedule?: NormalizedSchedule;
  /** False for schedule-only skills (`webhook: false`): `POST /hooks/<name>` answers 404 and no secret is required. */
  webhook: boolean;
  /** From the standard `allowed-tools` frontmatter field, mapped to `claude --allowedTools`. */
  allowedTools: string[];
  enabled: boolean;
  /** Set when the file exists but is invalid; the skill is then not routable. */
  error?: string;
  mtimeMs: number;
  source: SkillSource;
}

export class SkillError extends Error {
  constructor(
    message: string,
    public readonly dir: string,
  ) {
    super(message);
    this.name = "SkillError";
  }
}

export function skillFile(dir: string): string {
  return path.join(dir, "SKILL.md");
}

export function parseSkillDocument(text: string, dir: string): Skill {
  const fm = parseFrontmatter(text);
  if (!fm.present) throw new SkillError(`SKILL.md has no frontmatter; it needs at least name and description`, dir);
  const parsed = SkillFrontmatterSchema.safeParse(fm.data);
  if (!parsed.success) throw new SkillError(`Invalid SKILL.md frontmatter:\n${z.prettifyError(parsed.error)}`, dir);
  const data = parsed.data;
  const dirName = path.basename(dir);
  if (!isValidSkillName(data.name)) {
    throw new SkillError(`Invalid skill name "${data.name}": use 1-64 lowercase letters, digits and single hyphens`, dir);
  }
  if (data.name !== dirName) {
    throw new SkillError(`Skill name "${data.name}" must match its directory name "${dirName}"`, dir);
  }
  const config = data.skillhook ?? {};
  const { schedule, webhook } = resolveSchedule(data.name, config, dir);
  const allowedTools = (data["allowed-tools"] ?? "")
    .split(/\s+/)
    .map((t) => t.trim())
    .filter(Boolean);
  return {
    name: data.name,
    description: data.description,
    dir,
    file: skillFile(dir),
    body: fm.body.trim(),
    frontmatter: fm.data,
    config,
    auth: normalizeAuth(data.name, config.auth),
    schedule,
    webhook,
    allowedTools,
    enabled: config.enabled !== false,
    mtimeMs: 0,
    source: { type: "home" },
  };
}

export function loadSkill(dir: string): Skill {
  const file = skillFile(dir);
  let text: string;
  let mtimeMs = 0;
  try {
    text = readFileSync(file, "utf8");
    mtimeMs = statSync(file).mtimeMs;
  } catch {
    throw new SkillError(`No SKILL.md in ${dir}`, dir);
  }
  const skill = parseSkillDocument(text, dir);
  skill.mtimeMs = mtimeMs;
  return skill;
}

export interface SkillLoadResult {
  skills: Skill[];
  errors: { dir: string; name: string; error: string }[];
}

export function loadSkills(skillsDir: string): SkillLoadResult {
  const result: SkillLoadResult = { skills: [], errors: [] };
  if (!isDirectory(skillsDir)) return result;
  const entries = readdirSync(skillsDir, { withFileTypes: true })
    .filter((e) => (e.isDirectory() || e.isSymbolicLink()) && !e.name.startsWith(".") && !e.name.startsWith("_"))
    .map((e) => e.name)
    .sort();
  for (const name of entries) {
    const dir = path.join(skillsDir, name);
    if (!isDirectory(dir)) continue;
    try {
      result.skills.push(loadSkill(dir));
    } catch (error) {
      result.errors.push({ dir, name, error: (error as Error).message });
    }
  }
  return result;
}

/** Frontmatter + body for a freshly scaffolded skill. */
export function renderSkillTemplate(options: {
  name: string;
  description: string;
  runner?: RunnerName;
  model?: string;
  authType?: AuthType;
  cwd?: string;
  instructions?: string;
}): string {
  const auth = options.authType ?? "bearer";
  const lines = [
    "---",
    `name: ${options.name}`,
    `description: ${JSON.stringify(options.description)}`,
    "skillhook:",
    ...(options.runner ? [`  runner: ${options.runner}`] : ["  # runner: claude   # claude | codex | shell (default: server default)"]),
    ...(options.model ? [`  model: ${options.model}`] : ["  # model: opus     # any model your runner accepts (opus, sonnet, haiku, gpt-…)"]),
    ...(options.cwd ? [`  cwd: ${options.cwd}`] : ["  # cwd: ~/dev/your-repo   # where the agent works (default: this folder)"]),
    "  timeout_seconds: 900",
    "  auth:",
    `    type: ${auth}`,
    `    # secret_env: ${defaultSecretEnvFor(options.name)}   # default; set it with: skillhook secret generate ${options.name}`,
    "  # when:                       # only run when the payload matches",
    "  #   - path: action",
    "  #     equals: created",
    "  # env: [GITHUB_TOKEN]         # secrets from .env to expose to the agent",
    "---",
    "",
    options.instructions?.trim() ||
      [
        `# ${options.name}`,
        "",
        "You were triggered by a webhook. The payload is appended below as JSON.",
        "",
        "1. Read the payload and decide what needs to happen.",
        "2. Do the work.",
        "3. Finish with a short summary of what you did and anything a human must follow up on.",
      ].join("\n"),
    "",
  ];
  return lines.join("\n");
}
