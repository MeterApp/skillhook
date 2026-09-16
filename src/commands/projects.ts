import { PROJECT_FILE_NAMES, type LoadedProject } from "../projects.js";
import { createOps, describeProject, initProject, linkProject, listProjects, resolveBaseUrl, webhookUrl, type LinkResult, type Ops } from "../ops.js";
import { skillSummary } from "../server.js";
import { displayPath } from "../util.js";
import { bool, CommandError, UsageError, type Ctx } from "./shared.js";

const USAGE = `Usage:
  skillhook link [dir] [--no-secret]        register a repository's ${PROJECT_FILE_NAMES[0]} (or the file itself) with this server; default: .
  skillhook unlink <dir>                    stop serving its hooks (the repository is not touched)
  skillhook projects [list]                 linked projects and their hooks
  skillhook projects init [dir] [--force]   write a starter ${PROJECT_FILE_NAMES[0]} into dir (default: .) and link it
  skillhook projects add|remove <dir>       the same as link / unlink

A project's ${PROJECT_FILE_NAMES[0]} maps webhook names to what runs: a shell command (run:), a SKILL.md in the
repository (skill:) or inline instructions (prompt:). It is version-controlled with the repository; the hooks
go live on the running server without a restart. Docs: docs/projects.md`;

export async function projectsCommand(ctx: Ctx): Promise<number> {
  const [sub = "list", target] = ctx.args;
  switch (sub) {
    case "list":
    case "ls":
      return listCommand(ctx);
    case "add":
    case "link":
      return link(ctx, target);
    case "remove":
    case "rm":
    case "unlink":
      return unlink(ctx, target);
    case "init":
      return init(ctx, target);
    default:
      throw new UsageError(`Unknown projects subcommand "${sub}"`, USAGE);
  }
}

/** `skillhook link [dir]` */
export async function linkCommand(ctx: Ctx): Promise<number> {
  return link(ctx, ctx.args[0]);
}

/** `skillhook unlink <dir>` */
export async function unlinkCommand(ctx: Ctx): Promise<number> {
  return unlink(ctx, ctx.args[0]);
}

function projectJson(ops: Ops, project: LoadedProject, baseUrl: string): Record<string, unknown> {
  const secrets = ops.secrets();
  return {
    dir: project.dir,
    file: project.file,
    error: project.error ?? null,
    hooks: project.hooks.map((hook) => ({ ...skillSummary(hook, ops.config, secrets), url: webhookUrl(baseUrl, hook.name) })),
    errors: project.errors,
  };
}

function hookLines(ops: Ops, project: LoadedProject, baseUrl: string): string[] {
  const secrets = ops.secrets();
  const lines = project.hooks.map((hook) => {
    const summary = skillSummary(hook, ops.config, secrets);
    const auth = summary.auth as { type: string; configured: boolean; how: string };
    const kind = hook.source.type === "project" ? hook.source.kind : "skill";
    return `  ${hook.name.padEnd(24)} ${String(summary.runner).padEnd(6)} ${kind.padEnd(6)} ${`${auth.type}${auth.configured ? "" : " (secret missing)"}`.padEnd(22)} ${webhookUrl(baseUrl, hook.name)}`;
  });
  for (const error of project.errors) lines.push(`  ✗ ${error.name}: ${error.error.split("\n")[0]}`);
  return lines;
}

async function listCommand(ctx: Ctx): Promise<number> {
  const ops = createOps(ctx.paths, { env: ctx.io.env });
  const projects = listProjects(ops);
  const { baseUrl, source } = await resolveBaseUrl(ops);
  const lines: string[] = [];
  if (!projects.length) lines.push(`No linked projects. Register a repository's ${PROJECT_FILE_NAMES[0]} with: skillhook link <dir>   (or create one: skillhook projects init <dir>)`);
  for (const project of projects) {
    if (lines.length) lines.push("");
    lines.push(`${describeProject(project)}${project.error ? `  ✗ ${project.error}` : `  ${project.hooks.length} hook(s)${project.errors.length ? `, ${project.errors.length} invalid` : ""}`}`);
    lines.push(...hookLines(ops, project, baseUrl));
  }
  if (projects.length) lines.push("", `URLs use the ${source} base URL ${baseUrl}`);
  ctx.print(lines.join("\n"), { projects: projects.map((p) => projectJson(ops, p, baseUrl)), base_url: baseUrl, base_url_source: source });
  return projects.some((p) => p.error || p.errors.length) ? 1 : 0;
}

async function printLinked(ctx: Ctx, ops: Ops, result: LinkResult, intro: string[], extra: Record<string, unknown> = {}): Promise<number> {
  const { baseUrl } = await resolveBaseUrl(ops);
  const lines = [...intro, `${result.added ? "Linked" : "Already linked:"} ${describeProject(result.project)} → ${displayPath(ops.paths.configFile)}`, "", ...hookLines(ops, result.project, baseUrl)];
  for (const error of result.errors.filter((e) => !result.project.errors.some((p) => p.name === e.name))) lines.push(`  ✗ ${error.name}: ${error.error.split("\n")[0]}`);
  const generated = result.secrets.filter((s) => s.generated);
  if (generated.length) lines.push("", "Secrets generated (shown once; stored in .env):", ...generated.map((s) => `  ${s.env}=${s.generated}`));
  const secrets = ops.secrets();
  const provider: { name: string; env: string }[] = [];
  for (const hook of result.project.hooks) {
    const auth = hook.auth;
    if (auth.type !== "none" && !result.secrets.some((s) => s.hook === hook.name) && !secrets[auth.secret_env]) provider.push({ name: hook.name, env: auth.secret_env });
  }
  if (provider.length) lines.push("", "Provider secrets to paste:", ...provider.map((p) => `  skillhook secret set ${p.env}        # ${p.name}`));
  const first = result.project.hooks[0];
  lines.push("", "Hooks are live on the running server without a restart. Commit the file with the repository.", ...(first ? [`Test one: skillhook run ${first.name} --payload '{}' --dry-run`] : []));
  ctx.print(lines.join("\n"), {
    ok: result.errors.length === 0,
    ...extra,
    entry: result.entry,
    added: result.added,
    project: projectJson(ops, result.project, baseUrl),
    secrets: result.secrets.map((s) => ({ hook: s.hook, env: s.env, secret: s.generated ?? null, existed: s.existed })),
    errors: result.errors,
  });
  return result.errors.length ? 1 : 0;
}

async function link(ctx: Ctx, target: string | undefined): Promise<number> {
  const ops = createOps(ctx.paths, { env: ctx.io.env });
  let result: LinkResult;
  try {
    result = linkProject(ops, target ?? ".", { noSecret: bool(ctx.flags, "no-secret") });
  } catch (error) {
    throw new CommandError((error as Error).message);
  }
  return printLinked(ctx, ops, result, []);
}

async function unlink(ctx: Ctx, target: string | undefined): Promise<number> {
  if (!target) throw new UsageError("Missing project directory", USAGE);
  const ops = createOps(ctx.paths, { env: ctx.io.env });
  const { unlinkProject } = await import("../ops.js");
  const result = unlinkProject(ops, target);
  ctx.print(result.removed ? `Unlinked ${displayPath(result.entry)}; its hooks now answer 404. The repository was not touched.` : `${displayPath(result.entry)} was not linked`, { ok: result.removed, entry: result.entry, removed: result.removed });
  return result.removed ? 0 : 1;
}

async function init(ctx: Ctx, target: string | undefined): Promise<number> {
  const ops = createOps(ctx.paths, { env: ctx.io.env });
  let result: ReturnType<typeof initProject>;
  try {
    result = initProject(ops, target ?? ".", { force: bool(ctx.flags, "force"), noSecret: bool(ctx.flags, "no-secret") });
  } catch (error) {
    throw new CommandError((error as Error).message);
  }
  const intro = result.written ? [`Wrote ${displayPath(result.file)} with a starter hook; edit it, then commit it with the repository.`] : [`${displayPath(result.file)} already exists (pass --force to overwrite it).`];
  return printLinked(ctx, ops, result.link, intro, { file: result.file, written: result.written });
}
