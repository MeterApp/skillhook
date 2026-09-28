import { readFileSync, writeFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { loadSecrets, readEnvFile } from "./env.js";
import { setConfigValue } from "./config.js";
import { DELIVERY_OUTCOMES, readDeliveryBody, type DeliveryOutcome } from "./delivery-log.js";
import { formatDoctor, runDoctor } from "./doctor.js";
import { formatHealth, runHealth, type HealthReport } from "./health.js";
import { listExamples } from "./examples.js";
import { JOB_ARTIFACTS, JOB_STATUSES, type JobArtifact, type JobStatus } from "./jobs.js";
import { TRIGGERS, type Trigger } from "./payload.js";
import { JOB_OUTCOMES, type JobOutcome } from "./response.js";
import { addExampleSkill, AnswerError, answerJob, createOps, createSkill, generateSecretFor, initProject, linkProject, listProjects, planReplay, postToServer, publicJob, resolveBaseUrl, runAdhocLocally, runJobLocally, runSkillLocally, sendSignedWebhook, setSecret, triggerViaServer, unlinkProject, webhookUrl, type LinkResult, type Ops } from "./ops.js";
import { readProgress } from "./progress.js";
import { resolveRunSettings } from "./run.js";
import type { Paths } from "./paths.js";
import { listSchedules, scheduleStatus } from "./scheduler.js";
import { skillSummary } from "./server.js";
import { installService, readServiceLog, restartService, serviceStatus, uninstallService } from "./service.js";
import { AUTH_TYPES, parseSkillDocument, type AuthType } from "./skills.js";
import { currentExposures, disableExposure, enableExposure, tailscaleStatus } from "./tailscale.js";
import { adminRequest, findRunningServer } from "./client.js";
import { updateStatusFromCache } from "./update.js";
import { errorMessage } from "./util.js";
import { VERSION } from "./version.js";

export const MCP_INSTRUCTIONS = `skillhook turns this machine into a webhook endpoint that runs Agent Skills (SKILL.md files) with Claude Code or Codex.
Typical flow: skillhook_status → create_skill (or add_example) → set_secret/generate_secret → run_skill to test locally → get_webhook_urls to hand the URL to the sender (Granola, Sentry, GitHub, Zapier…).
Skills live in <home>/skills/<name>/SKILL.md; the \`skillhook:\` frontmatter block sets runner, model, auth and filters. Secrets live in <home>/.env and are never returned by tools except right after generation.
A repository can declare its own hooks in a version-controlled skillhook.yaml (webhook name → run: shell command | skill: SKILL.md directory | prompt: inline instructions); link_project registers it so the hooks are served, list_projects shows what runs from which webhook.
A \`schedule:\` key (cron expression, optional timezone/catch_up/overlap) on any skill or hook makes the running server fire it on time without a webhook; \`webhook: false\` makes it schedule-only. list_schedules shows the next and last runs.
Jobs are directories under <home>/jobs/<id> with payload.json, prompt.md, stdout.log, result.md and, when the agent reported one, response.json. A job's \`status\` says how the process ended; its \`outcome\` (completed, partial, needs_human, nothing_to_do, failed, unknown) says whether the task was done, as reported by the agent through response.json or a structured answer (\`response: { mode: structured }\` in the skill).
Every webhook the server received, including rejected, filtered and duplicate ones, is in the delivery log: list_deliveries and get_delivery show what arrived and why it did not run; replay_delivery (or replay_job) runs it again through the skill as it is now.
While it runs, an agent reports progress and can ask a person a question through the job API (the job_* tools of \`skillhook mcp --job\`, or \`skillhook job …\`); such jobs show \`progress\`, \`question\` and \`answer\`. list_jobs with waiting: true lists what waits for a person (an open question, or a finished job with outcome needs_human); answer_job delivers the answer to the waiting agent, or starts a new job (trigger \`resume\`) that continues the agent's session with it.`;

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
      const loaded = o.registry.list();
      const { baseUrl, source } = await resolveBaseUrl(o);
      const jobs = o.store.list({ limit: 10 });
      const deliveries = o.deliveryLog.list({ limit: 5 }).deliveries;
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
          skills: loaded.skills.map((s) => ({ name: s.name, runner: s.config.runner ?? o.config.defaults.runner, model: s.config.model ?? o.config.defaults.model ?? null, auth: s.auth.type, source: s.source, url: webhookUrl(baseUrl, s.name) })),
          skill_errors: loaded.errors,
          projects: loaded.projects.map((p) => ({ dir: p.dir, file: p.file, hooks: p.hooks.map((h) => h.name), error: p.error ?? null, errors: p.errors })),
          recent_jobs: jobs.map((j) => ({ id: j.id, skill: j.skill, status: j.status, outcome: j.outcome ?? null, created_at: j.created_at, error: j.error ?? null })),
          recent_deliveries: deliveries.map((d) => ({ id: d.id, skill: d.skill, outcome: d.outcome, http_status: d.http_status, code: d.code ?? null, received_at: d.received_at, job_id: d.job_id ?? null })),
          defaults: o.config.defaults,
        },
        `skillhook ${VERSION} at ${paths.home}; server ${running ? "running" : "not running"}; ${loaded.skills.length} skill(s), ${loaded.projects.length} linked project(s).${update.available ? ` Update ${update.latest} is available (skillhook update --install).` : ""}`,
      );
    }),
  );

  server.registerTool(
    "list_skills",
    { title: "List skills", description: "Lists every skill with runner, model, auth type, whether its secret is configured, and its webhook URL.", inputSchema: z.object({}) },
    wrap(async () => {
      const o = ops();
      const loaded = o.registry.list();
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
      if (skill.source.type === "project" && skill.source.kind !== "skill") throw new Error(`"${name}" is a ${skill.source.kind === "run" ? "shell command" : "prompt"} hook defined in ${skill.source.file}; edit that file (it is version-controlled with the project)`);
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
      const loaded = o.registry.list();
      const secrets = o.secrets();
      const skills = name ? loaded.skills.filter((s) => s.name === name) : loaded.skills;
      const errors = name ? loaded.errors.filter((e) => e.name === name) : loaded.errors;
      const warnings = skills.flatMap((s) => (!s.webhook ? [] : s.auth.type === "none" ? [`${s.name}: auth none`] : !secrets[s.auth.secret_env] ? [`${s.name}: secret ${s.auth.secret_env} not set`] : []));
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
    "test_skill",
    {
      title: "Test a SKILL.md that is not installed",
      description: "Runs the complete text of a SKILL.md (frontmatter included) with a payload, exactly like run_skill, without installing it: the file is kept in the job directory (jobs/<id>/skill/<name>/SKILL.md) and the job has trigger `test`. Use it to try a draft before create_skill, or to see how a change would behave. Through the running server when there is one, otherwise in-process.",
      inputSchema: z.object({
        skill_md: z.string().describe("the whole SKILL.md text, frontmatter included; `name` must be a valid skill name"),
        payload: z.unknown().optional(),
        headers: z.record(z.string(), z.string()).optional(),
        runner: z.enum(["claude", "codex", "shell"]).optional(),
        model: z.string().optional(),
        effort: z.string().optional(),
        cwd: z.string().optional().describe("working directory for the run (default: the skill's `cwd`, else the copy's own directory inside the job)"),
        wait_seconds: z.number().int().min(0).max(1800).optional().describe("default 120"),
      }),
    },
    wrap(async (input) => {
      const o = ops();
      const wait = input.wait_seconds ?? 120;
      const overrides = { runner: input.runner, model: input.model, effort: input.effort, cwd: input.cwd };
      const viaServer = await postToServer(o, "/skills/test", { skill_md: input.skill_md, payload: input.payload ?? {}, headers: input.headers, ...overrides, wait });
      if (viaServer) {
        const body = viaServer.body as Record<string, unknown>;
        if (viaServer.status >= 400) throw new Error(`${String(body.error)}: ${String(body.message)}`);
        return ok({ via: "server", base_url: viaServer.baseUrl, http_status: viaServer.status, ...body }, body.status === "succeeded" ? `Job ${String(body.job_id)} succeeded${body.outcome ? ` (${String(body.outcome)})` : ""}.` : `Job ${String(body.job_id ?? "?")}: ${String(body.status ?? body.error)}`);
      }
      const job = await runAdhocLocally(o, { skillMd: input.skill_md, payload: input.payload ?? {}, headers: input.headers, overrides, waitMs: wait * 1000 });
      return ok({ via: "local", job: publicJob(job), job_dir: o.store.pathsFor(job.id).dir, skill_file: job.skill_file }, `Job ${job.id}: ${job.status}${job.outcome ? ` (${job.outcome})` : ""}${job.error ? ` (${job.error})` : ""}`);
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
    { title: "List jobs", description: "Recent jobs, newest first. `status` is how the process ended, `outcome` whether the task was done. `waiting: true` lists only the jobs waiting for a person (an unanswered question, or outcome needs_human not yet resumed): answer them with answer_job. `after` (the `next_after` of the previous call) pages further back; `since` is an ISO-8601 instant.", inputSchema: z.object({ skill: z.string().optional(), status: z.enum(JOB_STATUSES as [JobStatus, ...JobStatus[]]).optional(), outcome: z.enum(JOB_OUTCOMES as [JobOutcome, ...JobOutcome[]]).optional(), trigger: z.enum(TRIGGERS as [Trigger, ...Trigger[]]).optional(), waiting: z.boolean().optional(), since: z.string().optional(), after: z.string().optional(), limit: z.number().int().min(1).max(200).optional() }) },
    wrap(async ({ skill, status, outcome, trigger, waiting, since, after, limit }) => {
      const o = ops();
      const page = o.store.listPage({ skill, status, outcome, trigger, waiting: waiting || undefined, since, after, limit: limit ?? 20 });
      return ok({ jobs: page.jobs.map(publicJob), next_after: page.next_after });
    }),
  );

  server.registerTool(
    "list_deliveries",
    { title: "List deliveries", description: "Every request to /hooks/<skill> the server received, newest first, with its outcome: accepted (a job was created), duplicate, in_flight, skipped (a when filter), rejected (401, 404, 413, 503, …), challenge, error. Use it to see why a webhook did not run. `after` pages further back.", inputSchema: z.object({ skill: z.string().optional(), outcome: z.enum(DELIVERY_OUTCOMES as [DeliveryOutcome, ...DeliveryOutcome[]]).optional(), since: z.string().optional(), after: z.string().optional(), limit: z.number().int().min(1).max(200).optional() }) },
    wrap(async ({ skill, outcome, since, after, limit }) => {
      const o = ops();
      const page = o.deliveryLog.list({ skill, outcome, since, after, limit: limit ?? 20 });
      return ok({ deliveries: page.deliveries, next_after: page.next_after });
    }),
  );

  const replayInput = { id: z.string(), skip_filters: z.boolean().optional().describe("run even when the skill's `when` conditions do not match the original request"), runner: z.enum(["claude", "codex", "shell"]).optional(), model: z.string().optional(), effort: z.string().optional(), wait_seconds: z.number().int().min(0).max(1800).optional().describe("default 120") };
  const replayTool = async (source: "delivery" | "job", input: { id: string; force?: boolean; skip_filters?: boolean; runner?: "claude" | "codex" | "shell"; model?: string; effort?: string; wait_seconds?: number }): Promise<ToolResult> => {
    const o = ops();
    const wait = input.wait_seconds ?? 120;
    const overrides = { runner: input.runner, model: input.model, effort: input.effort };
    const viaServer = await postToServer(o, `/${source === "delivery" ? "deliveries" : "jobs"}/${input.id}/replay`, { force: input.force, skip_filters: input.skip_filters, ...overrides, wait });
    if (viaServer) {
      const body = viaServer.body as Record<string, unknown>;
      if (viaServer.status >= 400) throw new Error(`${String(body.error)}: ${String(body.message)}`);
      return ok({ via: "server", base_url: viaServer.baseUrl, http_status: viaServer.status, ...body }, body.skipped ? `Not replayed: ${String(body.reason)} (skip_filters runs it anyway)` : `Job ${String(body.job_id)}: ${String(body.status)}${body.outcome ? ` (${String(body.outcome)})` : ""}`);
    }
    const plan = planReplay(o, { source, id: input.id, skipFilters: input.skip_filters, force: input.force, overrides });
    if (!plan.ok) return ok({ via: "local", ok: true, skipped: true, reason: plan.reason }, `Not replayed: ${plan.reason} (skip_filters runs it anyway)`);
    const job = await runSkillLocally(o, { ...plan.input, waitMs: wait * 1000 });
    return ok({ via: "local", job: publicJob(job), job_dir: o.store.pathsFor(job.id).dir }, `Job ${job.id}: ${job.status}${job.outcome ? ` (${job.outcome})` : ""}${job.error ? ` (${job.error})` : ""}`);
  };

  server.registerTool(
    "replay_delivery",
    { title: "Replay delivery", description: "Runs a recorded delivery again through the skill as it is now, as a new job with trigger `replay`: the original payload, headers and query, no signature check, `when` filters applied unless skip_filters, never de-duplicated. A delivery that was rejected needs `force` (its body was never verified). Uses the running server when there is one, otherwise runs in-process.", inputSchema: z.object({ ...replayInput, force: z.boolean().optional().describe("replay a delivery that was rejected or errored") }) },
    wrap((input) => replayTool("delivery", input)),
  );

  server.registerTool(
    "replay_job",
    { title: "Replay job", description: "Runs the request an earlier job received again, as a new job with trigger `replay` and `replay_of` pointing at the original (same payload, headers and query; `when` filters applied unless skip_filters; runner/model/effort may be overridden).", inputSchema: z.object(replayInput) },
    wrap((input) => replayTool("job", input)),
  );

  server.registerTool(
    "get_delivery",
    { title: "Get delivery", description: "One delivery record; `include_body` adds the request body when the log kept it (rejected and filtered deliveries) or the payload of the job an accepted delivery created.", inputSchema: z.object({ id: z.string(), include_body: z.boolean().optional() }) },
    wrap(async ({ id, include_body }) => {
      const o = ops();
      const delivery = o.deliveryLog.get(id);
      if (!delivery) throw new Error(`Unknown delivery ${id}`);
      return ok({ delivery, ...(include_body ? { body: readDeliveryBody(o.deliveryLog, o.store, delivery) ?? null } : {}) });
    }),
  );

  server.registerTool(
    "get_job",
    { title: "Get job", description: "Job record plus optional artifacts (result, response, prompt, stdout, stderr, payload, event) and, when the agent reported any, its progress timeline, pending question and answer.", inputSchema: z.object({ id: z.string(), include: z.array(z.enum(JOB_ARTIFACTS as [JobArtifact, ...JobArtifact[]])).optional() }) },
    wrap(async ({ id, include }) => {
      const o = ops();
      const job = o.store.get(id);
      if (!job) throw new Error(`Unknown job ${id}`);
      const artifacts: Record<string, string | undefined> = {};
      for (const a of include ?? ["result"]) artifacts[a] = o.store.readArtifact(id, a, 64 * 1024);
      const progress = readProgress(o.store.pathsFor(id).dir, { timelineLimit: 100 });
      return ok({ job: publicJob(job), dir: o.store.pathsFor(id).dir, artifacts, ...(progress.timeline.length || progress.question ? { progress } : {}) });
    }),
  );

  server.registerTool(
    "answer_job",
    { title: "Answer a job", description: "A person's answer to a job that is waiting: delivered live to the agent's pending job_ask_human call when the job is still running (`delivered: live`); otherwise recorded and, unless resume is `never`, a new job with trigger `resume` continues the agent's session with it (`claude --resume` / `codex exec resume`; `delivered: resumed`, `resume_job_id`). Use list_jobs with waiting: true to find such jobs; pass `option` when the question had options, `by` to say who answered.", inputSchema: z.object({ id: z.string(), answer: z.string().min(1), option: z.string().optional(), by: z.string().optional(), resume: z.enum(["auto", "never"]).optional(), wait_seconds: z.number().int().min(0).max(1800).optional().describe("how long to wait for the resume job (default 120; 0 returns at once)") }) },
    wrap(async ({ id, answer, option, by, resume, wait_seconds }) => {
      const o = ops();
      const wait = wait_seconds ?? 120;
      const viaServer = await postToServer(o, `/jobs/${id}/answer`, { answer, option, by, resume, wait });
      if (viaServer) {
        const body = viaServer.body as Record<string, unknown>;
        if (viaServer.status >= 400) throw new Error(`${String(body.error)}: ${String(body.message)}`);
        const resumeJob = body.resume_job as { id: string; status: string; outcome?: string } | undefined;
        return ok({ via: "server", base_url: viaServer.baseUrl, ...body }, body.delivered === "live" ? `Delivered to the running job ${id}` : resumeJob ? `Job ${resumeJob.id} continues ${id}: ${resumeJob.status}${resumeJob.outcome ? ` (${resumeJob.outcome})` : ""}` : `Recorded on job ${id}`);
      }
      let result: ReturnType<typeof answerJob>;
      try {
        result = answerJob(o, { jobId: id, text: answer, option, by, resume });
      } catch (error) {
        if (error instanceof AnswerError) throw new Error(error.message);
        throw error;
      }
      if (result.delivered === "resumed" && result.resumeJob && result.skill) {
        const finished = await runJobLocally(o, result.resumeJob, { waitMs: wait * 1000, timeoutSeconds: resolveRunSettings(result.skill, o.config).timeoutSeconds });
        return ok({ via: "local", ok: finished.status === "succeeded", job_id: id, delivered: "resumed", answer: result.answer, resume_job_id: finished.id, resume_job: publicJob(finished), job: publicJob(result.job) }, `Job ${finished.id} continues ${id}: ${finished.status}${finished.outcome ? ` (${finished.outcome})` : ""}${finished.error ? ` (${finished.error})` : ""}`);
      }
      return ok({ via: "local", ok: true, job_id: id, delivered: result.delivered, answer: result.answer, resume_job_id: null, job: publicJob(result.job) }, result.delivered === "live" ? `Delivered to the running job ${id}` : `Recorded on job ${id}`);
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
      const names = skill ? [skillOf(o, skill).name] : o.registry.list().skills.map((s) => s.name);
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
      const skills = o.registry.list().skills.map((s) => s.name);
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
    "get_health",
    { title: "Health report", description: "Everything doctor checks plus, with deep (default), every MCP server Claude Code and Codex know (connected, needs authentication, failed), installed plugins, `codex doctor`, disk space and each skill's last run, grouped (system, skillhook, runners, tools, skills, exposure). Through the running server's cached report when there is one (`refresh` probes again); otherwise probed now.", inputSchema: z.object({ deep: z.boolean().optional(), refresh: z.boolean().optional(), network: z.boolean().optional().describe("ask the npm registry and probe the public URL (default false through the server, true locally)") }) },
    wrap(async ({ deep, refresh, network }) => {
      const running = await findRunningServer(paths);
      if (running) {
        const params = new URLSearchParams({ deep: deep === false ? "0" : "1", network: network ? "1" : "0", ...(refresh ? { refresh: "1" } : {}) });
        const response = await adminRequest<HealthReport & { cached?: boolean; error?: string; message?: string }>(running.baseUrl, loadSecrets(paths, env), `/health/checks?${params.toString()}`, { timeoutMs: 180_000 });
        if (response.status >= 400) throw new Error(`${String(response.body.error)}: ${String(response.body.message)}`);
        return ok({ via: "server", base_url: running.baseUrl, ...response.body }, formatHealth(response.body));
      }
      const report = await runHealth(paths, { env, deep: deep ?? true, network: network ?? true });
      return ok({ via: "local", ...report }, formatHealth(report));
    }),
  );

  const linkResult = (o: Ops, result: LinkResult, baseUrl: string) => ({
    ok: result.errors.length === 0,
    entry: result.entry,
    added: result.added,
    project: { dir: result.project.dir, file: result.project.file, hooks: result.project.hooks.map((h) => ({ ...skillSummary(h, o.config, o.secrets()), url: webhookUrl(baseUrl, h.name) })), errors: result.project.errors },
    secrets: result.secrets.map((s) => ({ hook: s.hook, env: s.env, secret: s.generated ?? null, existed: s.existed })),
    errors: result.errors,
  });

  server.registerTool(
    "list_projects",
    { title: "List linked projects", description: "Repositories whose skillhook.yaml is served by this machine: directory, file, and each hook with its runner, kind (run/skill/prompt), auth, cwd and webhook URL. This is the version-controlled answer to 'which skill runs from which webhook'.", inputSchema: z.object({}) },
    wrap(async () => {
      const o = ops();
      const { baseUrl } = await resolveBaseUrl(o);
      const secrets = o.secrets();
      return ok({ projects: listProjects(o).map((p) => ({ dir: p.dir, file: p.file, error: p.error ?? null, hooks: p.hooks.map((h) => ({ ...skillSummary(h, o.config, secrets), url: webhookUrl(baseUrl, h.name) })), errors: p.errors })) });
    }),
  );

  server.registerTool(
    "link_project",
    {
      title: "Link project",
      description: "Registers a repository's skillhook.yaml (dir, or the YAML file itself) in skillhook.json so its hooks are served at /hooks/<name>; the running server picks them up without a restart. With init=true a starter skillhook.yaml is written first when none exists (a `run: git pull --ff-only` hook for merged GitHub pull requests). Secrets skillhook manages (bearer/basic/hmac) are generated and returned once; provider-signed hooks need set_secret afterwards.",
      inputSchema: z.object({ dir: z.string().describe("repository directory (or path to its skillhook.yaml)"), init: z.boolean().optional().describe("write a starter skillhook.yaml when the directory has none"), no_secret: z.boolean().optional() }),
    },
    wrap(async ({ dir, init, no_secret }) => {
      const o = ops();
      const { baseUrl } = await resolveBaseUrl(o);
      if (init) {
        const result = initProject(o, dir, { noSecret: no_secret });
        return ok({ file: result.file, written: result.written, ...linkResult(o, result.link, baseUrl) }, `${result.written ? `Wrote ${result.file} and linked` : "Linked"} ${result.link.project.dir} (${result.link.project.hooks.length} hook(s)).`);
      }
      const result = linkProject(o, dir, { noSecret: no_secret });
      return ok(linkResult(o, result, baseUrl), `${result.added ? "Linked" : "Already linked"} ${result.project.dir}: ${result.project.hooks.map((h) => h.name).join(", ") || "no hooks"}.`);
    }),
  );

  server.registerTool(
    "unlink_project",
    { title: "Unlink project", description: "Stops serving a repository's hooks (they answer 404 at once). The repository and its skillhook.yaml are not touched.", inputSchema: z.object({ dir: z.string() }) },
    wrap(async ({ dir }) => {
      const result = unlinkProject(ops(), dir);
      return ok({ ok: result.removed, ...result }, result.removed ? `Unlinked ${result.entry}.` : `${result.entry} was not linked.`);
    }),
  );

  server.registerTool(
    "list_schedules",
    { title: "List schedules", description: "Every skill or hook with a `schedule:`: cron, time zone, catch_up and overlap policy, whether it is enabled and also has a webhook, the next due time, and the last slot, job and status (live from the running server when there is one). A hook with `webhook: false` runs only on its schedule.", inputSchema: z.object({}) },
    wrap(async () => {
      const o = ops();
      const running = await findRunningServer(paths);
      if (running?.health.schedules) return ok({ via: "server", schedules: running.health.schedules }, `${running.health.schedules.length} schedule(s) on the running server.`);
      const schedules = listSchedules({ registry: o.registry, jobsDir: o.store.jobsDir });
      return ok({ via: running ? "server-without-scheduler" : "local", schedules }, `${schedules.length} schedule(s); ${running ? "the running server predates the scheduler" : "no server is running, so nothing fires until `skillhook serve`"}.`);
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
