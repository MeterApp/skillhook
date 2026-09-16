import { readFileSync } from "node:fs";
import { RunnerNameSchema } from "../config.js";
import { listExamples } from "../examples.js";
import { addExampleSkill, createOps, createSkill, resolveBaseUrl, webhookUrl } from "../ops.js";
import { skillSummary } from "../server.js";
import { AUTH_TYPES, describeAuth, loadSkills, type AuthType } from "../skills.js";
import { bool, CommandError, list, num, str, table, UsageError, type Ctx } from "./shared.js";

const USAGE = `Usage:
  skillhook skills list
  skillhook skills show <name>
  skillhook skills new <name> [--description TEXT] [--runner claude|codex|shell] [--model M] [--effort E]
                              [--auth ${AUTH_TYPES.join("|")}] [--secret-env NAME] [--cwd DIR]
                              [--timeout SECONDS] [--env NAME]... [--no-secret] [--force]
  skillhook skills add <example> [--as NAME]      copy a bundled example (see: skills examples)
  skillhook skills examples
  skillhook skills validate [name]
  skillhook skills path <name>`;

export async function skillsCommand(ctx: Ctx): Promise<number> {
  const [sub = "list", name] = ctx.args;
  switch (sub) {
    case "list":
    case "ls":
      return listSkills(ctx);
    case "show":
    case "get":
      return showSkill(ctx, requireName(name));
    case "new":
    case "create":
      return newSkill(ctx, requireName(name));
    case "add":
      return addExample(ctx, requireName(name));
    case "examples":
      return examples(ctx);
    case "validate":
    case "check":
      return validate(ctx, name);
    case "path":
    case "dir":
      return skillPath(ctx, requireName(name));
    default:
      throw new UsageError(`Unknown skills subcommand "${sub}"`, USAGE);
  }
}

function requireName(name: string | undefined): string {
  if (!name) throw new UsageError("Missing skill name", USAGE);
  return name;
}

async function listSkills(ctx: Ctx): Promise<number> {
  const ops = createOps(ctx.paths, { env: ctx.io.env });
  const loaded = loadSkills(ctx.paths.skillsDir);
  const secrets = ops.secrets();
  const summaries = loaded.skills.map((s) => skillSummary(s, ops.config, secrets));
  const { baseUrl, source } = await resolveBaseUrl(ops);
  const rows = summaries.map((s) => {
    const auth = s.auth as { type: string; configured: boolean };
    return [String(s.name), s.enabled ? String(s.runner) : "(disabled)", String(s.model ?? "default"), `${auth.type}${auth.configured ? "" : " (secret missing)"}`, webhookUrl(baseUrl, String(s.name))];
  });
  const lines: string[] = [];
  if (rows.length) lines.push(table(rows, ["skill", "runner", "model", "auth", `url (${source})`]));
  else lines.push(`No skills in ${ctx.paths.skillsDir}. Create one with: skillhook skills new <name>`);
  for (const error of loaded.errors) lines.push(`✗ ${error.name}: ${error.error.split("\n")[0]}`);
  ctx.print(lines.join("\n"), { skills: summaries.map((s) => ({ ...s, url: webhookUrl(baseUrl, String(s.name)) })), errors: loaded.errors, base_url: baseUrl, base_url_source: source });
  return loaded.errors.length ? 1 : 0;
}

async function showSkill(ctx: Ctx, name: string): Promise<number> {
  const ops = createOps(ctx.paths, { env: ctx.io.env });
  const skill = ops.registry.get(name);
  if (!skill) throw new CommandError(`No skill named "${name}" in ${ctx.paths.skillsDir}`);
  const summary = skillSummary(skill, ops.config, ops.secrets());
  const { baseUrl } = await resolveBaseUrl(ops);
  const content = readFileSync(skill.file, "utf8");
  const human = [
    `${skill.name} — ${skill.description}`,
    `  file:    ${skill.file}`,
    `  url:     ${webhookUrl(baseUrl, skill.name)}`,
    `  runner:  ${summary.runner}${summary.model ? ` (${summary.model})` : ""}${summary.effort ? ` effort=${summary.effort}` : ""}`,
    `  cwd:     ${summary.cwd}`,
    `  auth:    ${describeAuth(skill.auth)}${(summary.auth as { configured: boolean }).configured ? "" : "  ← secret missing"}`,
    ...(skill.config.when?.length ? [`  when:    ${(summary.when as string[]).join("; ")}`] : []),
    "",
    content,
  ].join("\n");
  ctx.print(human, { ...summary, url: webhookUrl(baseUrl, skill.name), content });
  return 0;
}

async function newSkill(ctx: Ctx, name: string): Promise<number> {
  const ops = createOps(ctx.paths, { env: ctx.io.env });
  const runner = str(ctx.flags, "runner");
  if (runner && !RunnerNameSchema.safeParse(runner).success) throw new UsageError("--runner must be claude, codex or shell", USAGE);
  const authType = str(ctx.flags, "auth") as AuthType | undefined;
  if (authType && !AUTH_TYPES.includes(authType)) throw new UsageError(`--auth must be one of ${AUTH_TYPES.join(", ")}`, USAGE);
  const result = createSkill(ops, {
    name,
    description: str(ctx.flags, "description", "d") ?? `${name} skill (edit the description in SKILL.md)`,
    runner: runner as "claude" | "codex" | "shell" | undefined,
    model: str(ctx.flags, "model"),
    effort: str(ctx.flags, "effort"),
    authType,
    secretEnv: str(ctx.flags, "secret-env"),
    cwd: str(ctx.flags, "cwd"),
    timeoutSeconds: num(ctx.flags, "timeout"),
    env: list(ctx.flags, "env"),
    overwrite: bool(ctx.flags, "force", "overwrite"),
    noSecret: bool(ctx.flags, "no-secret"),
  });
  return printCreated(ctx, ops, result);
}

async function addExample(ctx: Ctx, example: string): Promise<number> {
  const ops = createOps(ctx.paths, { env: ctx.io.env });
  const result = addExampleSkill(ops, example, str(ctx.flags, "as") ?? example);
  return printCreated(ctx, ops, result);
}

async function printCreated(ctx: Ctx, ops: ReturnType<typeof createOps>, result: ReturnType<typeof createSkill>): Promise<number> {
  const { baseUrl } = await resolveBaseUrl(ops);
  const url = webhookUrl(baseUrl, result.skill.name);
  const lines = [`Created ${result.file}`, `  webhook URL: ${url}`, `  auth: ${result.authNote}`];
  if (result.secret?.generated) lines.push("", `  ${result.secret.env}=${result.secret.generated}`, "  (shown once; stored in .env)");
  lines.push("", `Edit the instructions, then test with: skillhook run ${result.skill.name} --payload '{"example":true}'`);
  ctx.print(lines.join("\n"), { ok: true, name: result.skill.name, file: result.file, url, auth: result.skill.auth.type, secret_env: result.secret?.env ?? null, secret: result.secret?.generated ?? null, auth_note: result.authNote });
  return 0;
}

function examples(ctx: Ctx): number {
  const items = listExamples();
  const rows = items.map((e) => [e.name, e.error ? `(invalid: ${e.error.split("\n")[0]})` : e.description]);
  ctx.print(items.length ? `${table(rows, ["example", "description"])}\n\nAdd one with: skillhook skills add <example>` : "No bundled examples found.", { examples: items.map((e) => ({ name: e.name, description: e.description, dir: e.dir, runner: e.skill?.config.runner ?? null, auth: e.skill?.auth.type ?? null })) });
  return 0;
}

function validate(ctx: Ctx, name?: string): number {
  const loaded = loadSkills(ctx.paths.skillsDir);
  const skills = name ? loaded.skills.filter((s) => s.name === name) : loaded.skills;
  const errors = name ? loaded.errors.filter((e) => e.name === name) : loaded.errors;
  if (name && !skills.length && !errors.length) throw new CommandError(`No skill named "${name}"`);
  const secrets = ctx.secrets();
  const warnings: string[] = [];
  for (const skill of skills) {
    if (skill.auth.type === "none") warnings.push(`${skill.name}: auth none (anyone with the URL can trigger it)`);
    else if (!secrets[skill.auth.secret_env]) warnings.push(`${skill.name}: secret ${skill.auth.secret_env} not set`);
  }
  const lines = [...skills.map((s) => `✓ ${s.name}`), ...errors.map((e) => `✗ ${e.name}: ${e.error}`), ...warnings.map((w) => `! ${w}`)];
  ctx.print(lines.join("\n") || "nothing to validate", { ok: errors.length === 0, valid: skills.map((s) => s.name), errors, warnings });
  return errors.length ? 1 : 0;
}

function skillPath(ctx: Ctx, name: string): number {
  const skill = ctx.registry().get(name);
  if (!skill) throw new CommandError(`No skill named "${name}"`);
  ctx.print(skill.dir, { name, dir: skill.dir, file: skill.file });
  return 0;
}
