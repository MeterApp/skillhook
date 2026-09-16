import { readFileSync, writeFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { readEnvFile } from "./env.js";
import { setConfigValue } from "./config.js";
import { formatDoctor, runDoctor } from "./doctor.js";
import { listExamples } from "./examples.js";
import { JOB_ARTIFACTS, JOB_STATUSES, type JobArtifact, type JobStatus } from "./jobs.js";
import { addExampleSkill, createOps, createSkill, generateSecretFor, publicJob, resolveBaseUrl, runSkillLocally, sendSignedWebhook, setSecret, triggerViaServer, webhookUrl, type Ops } from "./ops.js";
import type { Paths } from "./paths.js";
import { skillSummary } from "./server.js";
import { installService, readServiceLog, restartService, serviceStatus, uninstallService } from "./service.js";
import { AUTH_TYPES, loadSkills, parseSkillDocument, type AuthType } from "./skills.js";
import { currentExposures, disableExposure, enableExposure, tailscaleStatus } from "./tailscale.js";
import { findRunningServer } from "./client.js";
import { updateStatusFromCache } from "./update.js";
import { errorMessage } from "./util.js";
import { VERSION } from "./version.js";

export const MCP_INSTRUCTIONS = `skillhook turns this machine into a webhook endpoint that runs Agent Skills (SKILL.md files) with Claude Code or Codex.
Typical flow: skillhook_status → create_skill (or add_example) → set_secret/generate_secret → run_skill to test locally → get_webhook_urls to hand the URL to the sender (Granola, Sentry, GitHub, Zapier…).
Skills live in <home>/skills/<name>/SKILL.md; the \`skillhook:\` frontmatter block sets runner, model, auth and filters. Secrets live in <home>/.env and are never returned by tools except right after generation.
Jobs are directories under <home>/jobs/<id> with payload.json, prompt.md, stdout.log and result.md.`;

type ToolResult = { content: { type: "text"; text: string }[]; structuredContent?: Record<string, unknown>; isError?: boolean };

function ok(data: Record<string, unknown>, summary?: string): ToolResult {
  const text = `${summary ? `${summary}\n\n` : ""}${JSON.stringify(data, null, 2)}`;
  return { content: [{ type: "text", text }], structuredContent: data };
}

function fail(error: unknown): ToolResult {
  return { content: [{ type: "text", text: `Error: ${errorMessage(error)}` }], isError: true };
}

function wrap<T>(fn: (input: T) => Promise<ToolResult> | ToolResult) {
  return async (input: T): Promise<ToolResult> => {
    try {
      return await fn(input);
    } catch (error) {
      return fail(error);
    }
  };
}

export function buildMcpServer(paths: Paths, env: NodeJS.ProcessEnv = process.env): McpServer {
  const server = new McpServer({ name: "skillhook", version: VERSION }, { capabilities: { tools: {} }, instructions: MCP_INSTRUCTIONS });
  const ops = (): Ops => createOps(paths, { env });
  const skillOf = (o: Ops, name: string) => {
    const skill = o.registry.get(name);
    if (!skill) throw new Error(`No skill named "${name}" in ${paths.skillsDir}`);
    return skill;
  };

  server.registerTool(
    "skillhook_status",
    { title: "skillhook status", description: "Overview: home directory, server state, public URL, skills and recent jobs. Call this first.", inputSchema: z.object({}) },
    wrap(async () => {
      const o = ops();
      const running = await findRunningServer(paths);
      const loaded = loadSkills(paths.skillsDir);
      const { baseUrl, source } = await resolveBaseUrl(o);
      const jobs = o.store.list({ limit: 10 });
      const update = updateStatusFromCache(paths);
      return ok(
        {
          version: VERSION,
          update: { latest: update.latest, available: update.available, checked_at: update.checked_at, hint: update.available ? "skillhook update --install" : null },
          home: paths.home,
          config_file: paths.configFile,
          server: running ? { running: true, base_url: running.baseUrl, version: running.health.version, queue: running.health.queue } : { running: false, hint: "skillhook serve  (or: skillhook service install)" },
          public_base_url: source === "local" ? null : baseUrl,
          public_url_source: source,
          skills: loaded.skills.map((s) => ({ name: s.name, runner: s.config.runner ?? o.config.defaults.runner, model: s.config.model ?? o.config.defaults.model ?? null, auth: s.auth.type, url: webhookUrl(baseUrl, s.name) })),
          skill_errors: loaded.errors,
          recent_jobs: jobs.map((j) => ({ id: j.id, skill: j.skill, status: j.status, created_at: j.created_at, error: j.error ?? null })),
          defaults: o.config.defaults,
        },
        `skillhook ${VERSION} at ${paths.home}; server ${running ? "running" : "not running"}; ${loaded.skills.length} skill(s).${update.available ? ` Update ${update.latest} is available (skillhook update --install).` : ""}`,
      );
    }),
  );

  server.registerTool(
    "list_skills",
    { title: "List skills", description: "Lists every skill with runner, model, auth type, whether its secret is configured, and its webhook URL.", inputSchema: z.object({}) },
    wrap(async () => {
      const o = ops();
      const loaded = loadSkills(paths.skillsDir);
      const secrets = o.secrets();
      const { baseUrl } = await resolveBaseUrl(o);
      return ok({ skills: loaded.skills.map((s) => ({ ...skillSummary(s, o.config, secrets), url: webhookUrl(baseUrl, s.name) })), errors: loaded.errors });
    }),
  );

  server.registerTool(
    "get_skill",
    { title: "Get skill", description: "Returns a skill's summary and the full SKILL.md content.", inputSchema: z.object({ name: z.string().describe("skill name (directory name)") }) },
    wrap(async ({ name }) => {
      const o = ops();
      const skill = skillOf(o, name);
      const { baseUrl } = await resolveBaseUrl(o);
      return ok({ ...skillSummary(skill, o.config, o.secrets()), url: webhookUrl(baseUrl, skill.name), content: readFileSync(skill.file, "utf8") });
    }),
  );

  server.registerTool(
    "create_skill",
    {
      title: "Create skill",
      description: "Creates <home>/skills/<name>/SKILL.md. Writes the instructions (markdown body) and the skillhook frontmatter (runner, model, auth, filters). For bearer/basic/hmac auth a secret is generated and returned once; for provider-signed auth (github, sentry, granola, stripe, slack, linear, svix, standard-webhooks) call set_secret with the provider's signing secret afterwards.",
      inputSchema: z.object({
        name: z.string().describe("lowercase letters, digits and hyphens"),
        description: z.string().describe("what the skill does and when it runs (1-1024 chars)"),
        instructions: z.string().describe("markdown body: what the agent should do with the payload. Use {{payload}} / {{payload.some.path}} placeholders or let skillhook append the event automatically."),
        runner: z.enum(["claude", "codex", "shell"]).optional(),
        model: z.string().optional().describe("e.g. opus, sonnet, haiku, claude-opus-5, gpt-5-codex"),
        effort: z.string().optional().describe("low|medium|high|xhigh|max"),
        auth_type: z.enum(AUTH_TYPES as [AuthType, ...AuthType[]]).optional().describe("default bearer"),
        secret_env: z.string().optional().describe("env var holding the secret; default SKILLHOOK_SECRET_<NAME>"),
        cwd: z.string().optional().describe("working directory for the agent, e.g. ~/dev/my-repo"),
        timeout_seconds: z.number().int().positive().optional(),
        when: z.array(z.record(z.string(), z.unknown())).optional().describe('filters, e.g. [{"path":"action","equals":"created"}]'),
        env: z.array(z.string()).optional().describe("env var names from .env to expose to the agent"),
        overwrite: z.boolean().optional(),
      }),
    },
    wrap(async (input) => {
      const o = ops();
      const result = createSkill(o, { name: input.name, description: input.description, instructions: input.instructions, runner: input.runner, model: input.model, effort: input.effort, authType: input.auth_type, secretEnv: input.secret_env, cwd: input.cwd, timeoutSeconds: input.timeout_seconds, when: input.when, env: input.env, overwrite: input.overwrite });
      const { baseUrl, source } = await resolveBaseUrl(o);
      return ok({ ok: true, name: result.skill.name, file: result.file, url: webhookUrl(baseUrl, result.skill.name), url_is_public: source !== "local", auth: result.skill.auth.type, secret_env: result.secret?.env ?? null, secret: result.secret?.generated ?? null, auth_note: result.authNote }, `Created ${result.file}. ${result.authNote}`);
    }),
  );

  server.registerTool(
    "update_skill_file",
    { title: "Update SKILL.md", description: "Replaces a skill's SKILL.md with new content after validating the frontmatter.", inputSchema: z.object({ name: z.string(), content: z.string().describe("complete SKILL.md text including frontmatter") }) },
    wrap(async ({ name, content }) => {
      const o = ops();
      const skill = skillOf(o, name);
      parseSkillDocument(content, skill.dir);
      writeFileSync(skill.file, content);
      return ok({ ok: true, file: skill.file, ...skillSummary(o.registry.get(name) ?? skill, o.config, o.secrets()) });
    }),
  );

  server.registerTool(
    "validate_skills",
    { title: "Validate skills", description: "Parses every SKILL.md (or one) and reports errors and missing secrets.", inputSchema: z.object({ name: z.string().optional() }) },
    wrap(async ({ name }) => {
      const o = ops();
      const loaded = loadSkills(paths.skillsDir);
      const secrets = o.secrets();
      const skills = name ? loaded.skills.filter((s) => s.name === name) : loaded.skills;
      const errors = name ? loaded.errors.filter((e) => e.name === name) : loaded.errors;
      const warnings = skills.flatMap((s) => (s.auth.type === "none" ? [`${s.name}: auth none`] : !secrets[s.auth.secret_env] ? [`${s.name}: secret ${s.auth.secret_env} not set`] : []));
      return ok({ ok: errors.length === 0, valid: skills.map((s) => s.name), errors, warnings });
    }),
  );

  server.registerTool(
    "run_skill",
    {
      title: "Run skill",
      description: "Runs a skill with a payload through the same prompt, runner and job pipeline as a webhook, skipping HTTP auth, the skill's when filters and de-duplication. Uses the running server when there is one (job visible in its queue), otherwise runs in-process. Set wait_seconds to block for the result; otherwise poll get_job. Use send_test_webhook to exercise auth and filters too.",
      inputSchema: z.object({
        name: z.string(),
        payload: z.unknown().optional().describe("JSON payload the skill receives (object, array, string…)"),
        headers: z.record(z.string(), z.string()).optional().describe("extra request headers to simulate, e.g. {\"x-github-event\":\"issues\"}"),
        runner: z.enum(["claude", "codex", "shell"]).optional(),
        model: z.string().optional(),
        effort: z.string().optional(),
        wait_seconds: z.number().int().min(0).max(1800).optional().describe("default 120"),
      }),
    },
    wrap(async (input) => {
      const o = ops();
      const skill = skillOf(o, input.name);
      const wait = input.wait_seconds ?? 120;
      const overrides = { runner: input.runner, model: input.model, effort: input.effort };
      const viaServer = await triggerViaServer(o, { skill, payload: input.payload ?? {}, headers: input.headers, overrides, waitSeconds: wait });
      if (viaServer) {
        const body = viaServer.body as Record<string, unknown>;
        return ok({ via: "server", base_url: viaServer.baseUrl, http_status: viaServer.status, ...body }, body.status === "succeeded" ? `Job ${body.job_id} succeeded.` : `Job ${body.job_id ?? "?"}: ${body.status ?? body.error}`);
      }
      const job = await runSkillLocally(o, { skill, payload: input.payload ?? {}, headers: input.headers, trigger: "mcp", overrides, waitMs: wait * 1000 });
      return ok({ via: "local", job: publicJob(job), job_dir: o.store.pathsFor(job.id).dir }, `Job ${job.id}: ${job.status}${job.error ? ` (${job.error})` : ""}`);
    }),
  );

  server.registerTool(
    "send_test_webhook",
    {
      title: "Send signed test webhook",
      description: "Signs a payload the way the skill's auth expects and POSTs it to /hooks/<name>, proving the HTTP path (auth, filters, queue) works. Defaults to the local server; set public=true to go through the public URL.",
      inputSchema: z.object({ name: z.string(), payload: z.unknown().optional(), public: z.boolean().optional(), base_url: z.string().optional(), wait_seconds: z.number().int().min(0).max(600).optional() }),
    },
    wrap(async (input) => {
      const o = ops();
      const skill = skillOf(o, input.name);
      const baseUrl = input.base_url ?? (await resolveBaseUrl(o, { prefer: input.public ? "public" : "local" })).baseUrl;
      const result = await sendSignedWebhook(o, { skill, payload: input.payload ?? {}, baseUrl, waitSeconds: input.wait_seconds });
      return ok({ ok: result.status < 300, url: result.url, status: result.status, signed_headers: result.signedHeaders, response: result.body }, `POST ${result.url} → ${result.status}`);
    }),
  );

  server.registerTool(
    "list_jobs",
    { title: "List jobs", description: "Recent jobs, newest first.", inputSchema: z.object({ skill: z.string().optional(), status: z.enum(JOB_STATUSES as [JobStatus, ...JobStatus[]]).optional(), limit: z.number().int().min(1).max(200).optional() }) },
    wrap(async ({ skill, status, limit }) => {
      const o = ops();
      return ok({ jobs: o.store.list({ skill, status, limit: limit ?? 20 }).map(publicJob) });
    }),
  );

  server.registerTool(
    "get_job",
    { title: "Get job", description: "Job record plus optional artifacts (result, prompt, stdout, stderr, payload, event).", inputSchema: z.object({ id: z.string(), include: z.array(z.enum(JOB_ARTIFACTS as [JobArtifact, ...JobArtifact[]])).optional() }) },
    wrap(async ({ id, include }) => {
      const o = ops();
      const job = o.store.get(id);
      if (!job) throw new Error(`Unknown job ${id}`);
      const artifacts: Record<string, string | undefined> = {};
      for (const a of include ?? ["result"]) artifacts[a] = o.store.readArtifact(id, a, 64 * 1024);
      return ok({ job: publicJob(job), dir: o.store.pathsFor(id).dir, artifacts });
    }),
  );

  server.registerTool(
    "cancel_job",
    { title: "Cancel job", description: "Cancels a queued or running job on the running server.", inputSchema: z.object({ id: z.string() }) },
    wrap(async ({ id }) => {
      const o = ops();
      const running = await findRunningServer(paths);
      if (!running) throw new Error("No running server; jobs started by `skillhook run` must be stopped by killing that process.");
      const { adminRequest } = await import("./client.js");
      const response = await adminRequest<Record<string, unknown>>(running.baseUrl, o.secrets(), `/jobs/${id}/cancel`, { method: "POST" });
      return ok({ http_status: response.status, ...response.body });
    }),
  );

  server.registerTool(
    "set_secret",
    { title: "Set secret", description: "Stores a secret in <home>/.env (mode 600). `name` is an ENV_VAR_NAME, a skill name (its secret_env) or \"admin\". Use it for provider signing secrets (Granola whsec_…, Sentry client secret, GitHub webhook secret) and for API keys a skill needs via `env:`.", inputSchema: z.object({ name: z.string(), value: z.string() }) },
    wrap(async ({ name, value }) => ok({ ok: true, ...setSecret(ops(), name, value) })),
  );

  server.registerTool(
    "generate_secret",
    { title: "Generate secret", description: "Generates a random secret for a skill (or \"admin\") and returns it once. Existing secrets are kept unless force=true.", inputSchema: z.object({ name: z.string(), force: z.boolean().optional() }) },
    wrap(async ({ name, force }) => {
      const result = generateSecretFor(ops(), name, { force });
      return ok({ ok: true, env: result.env, secret: result.generated ?? null, existed: result.existed }, result.generated ? `Generated ${result.env} (shown once).` : `${result.env} already exists; pass force=true to rotate.`);
    }),
  );

  server.registerTool(
    "list_secrets",
    { title: "List secret names", description: "Names of secrets in <home>/.env (values are never returned).", inputSchema: z.object({}) },
    wrap(async () => ok({ file: paths.envFile, names: Object.keys(readEnvFile(paths.envFile)) })),
  );

  server.registerTool(
    "get_webhook_urls",
    { title: "Webhook URLs", description: "Webhook URL per skill, using the public URL (Tailscale/config) when one exists.", inputSchema: z.object({ skill: z.string().optional() }) },
    wrap(async ({ skill }) => {
      const o = ops();
      const { baseUrl, source } = await resolveBaseUrl(o);
      const names = skill ? [skillOf(o, skill).name] : loadSkills(paths.skillsDir).skills.map((s) => s.name);
      return ok({ base_url: baseUrl, source, public: source !== "local", urls: Object.fromEntries(names.map((n) => [n, webhookUrl(baseUrl, n)])) }, source === "local" ? "No public URL yet: call expose with mode funnel." : undefined);
    }),
  );

  server.registerTool(
    "expose",
    { title: "Expose via Tailscale", description: "mode=funnel: public HTTPS URL (internet). mode=serve: tailnet-only URL. mode=off: disable. mode=status: current exposure. The URL is permanent (your Tailscale node name) and survives reboots.", inputSchema: z.object({ mode: z.enum(["funnel", "serve", "off", "status"]) }) },
    wrap(async ({ mode }) => {
      const o = ops();
      if (mode === "status") return ok({ tailscale: (await tailscaleStatus()) ?? null, exposures: await currentExposures(), public_url: o.config.public_url ?? null });
      if (mode === "off") {
        const funnel = await disableExposure("funnel");
        const serve = await disableExposure("serve");
        if (funnel.ok || serve.ok) setConfigValue(paths, "public_url", undefined);
        return ok({ ok: funnel.ok || serve.ok, output: [funnel.output, serve.output].filter(Boolean).join("\n") });
      }
      const result = await enableExposure(mode, o.config.port);
      if (result.ok && result.url) setConfigValue(paths, "public_url", result.url);
      const skills = loadSkills(paths.skillsDir).skills.map((s) => s.name);
      return ok({ ok: result.ok, mode, url: result.url ?? null, approval_url: result.approvalUrl ?? null, output: result.output, webhooks: result.url ? Object.fromEntries(skills.map((n) => [n, webhookUrl(result.url as string, n)])) : {} }, result.ok ? `Exposed at ${result.url}` : result.approvalUrl ? `Funnel needs approval: ${result.approvalUrl}` : "Failed");
    }),
  );

  server.registerTool(
    "service",
    { title: "Background service", description: "install: run the server at login (launchd/systemd) and keep it alive. status/restart/uninstall/logs.", inputSchema: z.object({ action: z.enum(["install", "uninstall", "status", "restart", "logs"]), lines: z.number().int().optional() }) },
    wrap(async ({ action, lines }) => {
      switch (action) {
        case "install":
          return ok({ ...(await installService(paths)), status: await serviceStatus(paths) });
        case "uninstall":
          return ok({ ...(await uninstallService()) });
        case "restart":
          return ok({ ...(await restartService()) });
        case "logs":
          return ok({ log: readServiceLog(paths, lines ?? 100) });
        default:
          return ok({ ...(await serviceStatus(paths)) });
      }
    }),
  );

  server.registerTool(
    "doctor",
    { title: "Doctor", description: "Checks Node, config, secrets, skills, Claude/Codex login, Tailscale exposure, server and service.", inputSchema: z.object({}) },
    wrap(async () => {
      const report = await runDoctor(paths);
      return ok({ ...report }, formatDoctor(report));
    }),
  );

  server.registerTool(
    "list_examples",
    { title: "List example skills", description: "Bundled example skills (hello, granola-meeting-actions, sentry-triage, …) that add_example can copy.", inputSchema: z.object({}) },
    wrap(async () => ok({ examples: listExamples().map((e) => ({ name: e.name, description: e.description, runner: e.skill?.config.runner ?? null, auth: e.skill?.auth.type ?? null })) })),
  );

  server.registerTool(
    "add_example",
    { title: "Add example skill", description: "Copies a bundled example into <home>/skills (optionally under another name) and generates its secret when skillhook manages it.", inputSchema: z.object({ name: z.string(), as: z.string().optional() }) },
    wrap(async ({ name, as }) => {
      const o = ops();
      const result = addExampleSkill(o, name, as ?? name);
      const { baseUrl } = await resolveBaseUrl(o);
      return ok({ ok: true, name: result.skill.name, file: result.file, url: webhookUrl(baseUrl, result.skill.name), secret_env: result.secret?.env ?? null, secret: result.secret?.generated ?? null, auth_note: result.authNote });
    }),
  );

  return server;
}

export async function serveMcp(paths: Paths): Promise<void> {
  const { serveStdio } = await import("@modelcontextprotocol/server/stdio");
  serveStdio(() => buildMcpServer(paths), { onerror: (error) => console.error(`[skillhook mcp] ${error.message}`) });
}
