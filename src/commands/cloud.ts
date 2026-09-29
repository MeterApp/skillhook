import { readFileSync } from "node:fs";
import { adminRequest, findRunningServer, readServerState } from "../client.js";
import { API_KEY_PREFIX, CloudApiError, fleetClient, JobDetailSchema, JobListSchema, machineNames, MachineListSchema, MeSchema, storedApiKey, type FleetJob } from "../cloud/api.js";
import { assertSecureCloudUrl, CLOUD_API_KEY_ENV, CLOUD_PRIVATE_KEY_ENV, CLOUD_TOKEN_ENV, cloudDisabledByEnv, resolveCloudUrl } from "../cloud/config.js";
import { CloudHttpError } from "../cloud/http.js";
import { cloudStatus, disconnectCloud, machineInfo, pairMachine, writeLinkCredentials } from "../cloud/pair.js";
import { ISSUE_KINDS, ISSUE_SEVERITIES, JOB_OUTCOMES, JOB_STATUSES, type IssueKind, type IssueSeverity } from "../cloud/protocol.js";
import { buildIssueReport, IssueReportError, reportIssue, type IssueReportInput } from "../cloud/report.js";
import { machineKeyPair, publicKeyOf, SealError } from "../cloud/seal.js";
import { ensureSecretFileMode, readEnvFile, removeEnvVar, upsertEnvVar } from "../env.js";
import { bool, CommandError, formatDuration, num, relativeTime, str, table, UsageError, type Ctx } from "./shared.js";

const USAGE = `Usage:
  skillhook cloud connect --code XXXX-XXXX [--url URL] [--control|--observe] [--force]   pair this machine with Skillhook Cloud (the dashboard shows the code)
  skillhook cloud connect --token TOKEN [--url URL] [--control|--observe] [--force]      pair with a machine token instead
  skillhook cloud disconnect [--keep-token]                                              stop the link, forget the pairing, revoke the token
  skillhook cloud status
  skillhook cloud report "<title>" [--body TEXT|--body-file PATH|--body -] [--kind ${ISSUE_KINDS.join("|")}] [--severity ${ISSUE_SEVERITIES.join("|")}] [--job ID] [--delivery ID] [--skill NAME] [--email ADDRESS] [--no-diagnostics] [--dry-run]   report a problem to the Skillhook team from this paired machine
  skillhook cloud login --key shc_…|-                                                    check an organisation API key (Settings → API keys) and keep it in .env
  skillhook cloud logout                                                                 forget that key
  skillhook cloud machines                                                               the organisation's machines (with the API key, like the two below)
  skillhook cloud jobs [--machine M] [--skill S] [--status ${JOB_STATUSES.join("|")}] [--outcome ${JOB_OUTCOMES.join("|")}] [--waiting] [--limit N] [--before CURSOR]
  skillhook cloud job <id>                                                               one job: status, outcome, the question waiting for a person, the result`;

/** The running server re-reads skillhook.json now (it would notice within a few seconds anyway). */
async function notifyReload(ctx: Ctx, baseUrl: string): Promise<void> {
  try {
    await adminRequest(baseUrl, ctx.secrets(), "/config/reload", { method: "POST", timeoutMs: 5_000 });
  } catch {
    /* the file watcher picks it up */
  }
}

export async function cloudCommand(ctx: Ctx): Promise<number> {
  try {
    return await cloudSubcommand(ctx);
  } catch (error) {
    // What the cloud refused, or what this machine lacks for it, is the command's failure (JSON with --json).
    if (error instanceof IssueReportError || error instanceof CloudApiError) throw new CommandError(error.message);
    throw error;
  }
}

async function cloudSubcommand(ctx: Ctx): Promise<number> {
  const [sub = "status"] = ctx.args;
  const config = ctx.config();
  const env = ctx.io.env;
  switch (sub) {
    case "connect": {
      const code = str(ctx.flags, "code");
      const token = str(ctx.flags, "token");
      if (!code && !token) throw new UsageError("Give --code (from the dashboard's pairing page) or --token", USAGE);
      if (code && token) throw new UsageError("Give either --code or --token, not both", USAGE);
      if (bool(ctx.flags, "control") && bool(ctx.flags, "observe")) throw new UsageError("--control and --observe exclude each other", USAGE);
      const url = resolveCloudUrl(env, config.cloud, str(ctx.flags, "url"));
      try {
        assertSecureCloudUrl(url, env);
      } catch (error) {
        throw new CommandError((error as Error).message);
      }
      const existingToken = readEnvFile(ctx.paths.envFile)[CLOUD_TOKEN_ENV];
      if (config.cloud.enabled && config.cloud.machine_id && existingToken && !bool(ctx.flags, "force")) throw new CommandError(`Already connected to ${resolveCloudUrl(env, config.cloud)} as machine ${config.cloud.machine_id}. Use --force to pair again, or: skillhook cloud disconnect`);
      const mode = bool(ctx.flags, "control") ? "control" : "observe";
      const state = readServerState(ctx.paths);
      // The machine's own key pair (kept across re-pairing): the cloud seals values for this machine to its public half.
      const storedKey = readEnvFile(ctx.paths.envFile)[CLOUD_PRIVATE_KEY_ENV];
      let keys: { publicKey: string; privateKey: string };
      try {
        keys = storedKey ? { publicKey: publicKeyOf(storedKey), privateKey: storedKey } : machineKeyPair();
      } catch (error) {
        if (!(error instanceof SealError)) throw error;
        keys = machineKeyPair();
      }
      let response;
      try {
        response = await pairMachine({ url, code, token, mode, machine: machineInfo(state, config.public_url), previousMachineId: config.cloud.machine_id, publicKey: keys.publicKey });
      } catch (error) {
        if (error instanceof CloudHttpError) throw new CommandError(`Pairing with ${url} failed: ${error.code}: ${error.message}`);
        throw error;
      }
      writeLinkCredentials(ctx.paths, { token: response.machine_token, machineId: response.machine_id, url, mode: response.mode, privateKey: keys.privateKey });
      const running = await findRunningServer(ctx.paths);
      if (running) await notifyReload(ctx, running.baseUrl);
      const lines = [
        `Connected to ${url} as machine ${response.machine_id} (mode ${response.mode}${response.mode === "observe" ? ": the cloud can look, not act; --control at pairing or cloud.mode: control changes that" : ""}).`,
        `Dashboard: ${response.dashboard_url}`,
        running ? "The running server picks the link up within a few seconds." : "Start the server (skillhook serve, or skillhook service install) to bring the link up.",
        ...(cloudDisabledByEnv(env) ? ["SKILLHOOK_NO_CLOUD is set in this environment: the link will not start until it is unset."] : []),
      ];
      ctx.print(lines.join("\n"), { ok: true, url, machine_id: response.machine_id, mode: response.mode, dashboard_url: response.dashboard_url, account: response.account, server_running: Boolean(running) });
      return 0;
    }
    case "disconnect": {
      const keepToken = bool(ctx.flags, "keep-token");
      const done = await disconnectCloud(ctx.paths, env, { keepToken, notify: (baseUrl) => notifyReload(ctx, baseUrl) });
      ctx.print(`${done.was_enabled ? "Disconnected from" : "Not connected to"} ${done.url}.${done.token_removed ? (done.revoked ? " Token revoked." : " The cloud could not be told; the token was removed here.") : keepToken ? " Token kept in .env." : ""} The running server stops the link within a few seconds.`, { ok: true, ...done });
      return 0;
    }
    case "status": {
      const data = await cloudStatus(ctx.paths, env);
      const link = data.link;
      const lines = [
        `${data.enabled ? "enabled" : "not connected"} · ${data.url}${data.machine_id ? ` · machine ${data.machine_id}` : ""} · mode ${data.mode} · token ${data.token_present ? "present" : "missing"}${data.env_disabled ? " · SKILLHOOK_NO_CLOUD set" : ""}`,
        ...(link ? [`link: ${link.state}${link.reason ? ` (${link.reason})` : ""}${link.last_sync_at ? `, last sync ${link.last_sync_at}` : ""}${link.outbox_depth ? `, ${link.outbox_depth} event(s) waiting` : ""}${link.last_error ? `, last error: ${link.last_error}` : ""}`] : data.server_running ? ["link: the running server reports no link state"] : ["link: no running server"]),
        ...(Object.keys(link?.ingress_urls ?? {}).length ? [`hosted URLs: ${Object.entries(link?.ingress_urls ?? {}).map(([skill, u]) => `${skill} ${u}`).join(", ")}`] : []),
      ];
      ctx.print(lines.join("\n"), data);
      return 0;
    }
    case "report": {
      const input = await reportInput(ctx);
      if (bool(ctx.flags, "dry-run")) {
        const built = await buildIssueReport(ctx.paths, env, input, { config });
        ctx.print(`Would send to ${built.url}/api/agent/issues (nothing was sent):\n${JSON.stringify(built.request, null, 2)}`, { dry_run: true, ...built });
        return 0;
      }
      const { issue, request } = await reportIssue(ctx.paths, env, input, { config });
      const lines = [
        `Reported as #${issue.number}: ${issue.url}`,
        issue.acknowledged ? `A confirmation email was sent${request.contact_email ? ` to ${request.contact_email}` : ""}.` : "No confirmation email was sent.",
        ...(request.diagnostics ? ["Diagnostics went with it (--dry-run shows them; --no-diagnostics leaves them out)."] : []),
      ];
      ctx.print(lines.join("\n"), issue);
      return 0;
    }
    case "login": {
      const given = str(ctx.flags, "key");
      if (!given) throw new UsageError("Give the organisation API key: --key shc_…, or --key - to read it from stdin (Settings → API keys on the dashboard)", USAGE);
      const key = (given === "-" ? await readStdin(ctx) : given).trim();
      if (!key.startsWith(API_KEY_PREFIX)) throw new UsageError(`That is not an organisation API key: those start with ${API_KEY_PREFIX} (Settings → API keys on the dashboard)`, USAGE);
      const client = fleetClient(env, config.cloud, key);
      const { data: me } = await client.get("/me", MeSchema);
      upsertEnvVar(ctx.paths.envFile, CLOUD_API_KEY_ENV, key);
      ensureSecretFileMode(ctx.paths.envFile);
      const fromEnvironment = env[CLOUD_API_KEY_ENV]?.trim();
      const lines = [
        `Logged in to ${client.url} as ${me.organisation.name}: key "${me.key.name}" (${me.key.scopes.join(", ") || "no scopes"}), kept in ${ctx.paths.envFile} as ${CLOUD_API_KEY_ENV}.`,
        ...(fromEnvironment && fromEnvironment !== key ? [`${CLOUD_API_KEY_ENV} is also set in this environment, and wins over .env.`] : []),
      ];
      ctx.print(lines.join("\n"), { ok: true, url: client.url, organisation: me.organisation, key: me.key, role: me.role, env_file: ctx.paths.envFile });
      return 0;
    }
    case "logout": {
      const removed = removeEnvVar(ctx.paths.envFile, CLOUD_API_KEY_ENV);
      const inEnvironment = Boolean(env[CLOUD_API_KEY_ENV]?.trim());
      ctx.print(`${removed ? `Removed ${CLOUD_API_KEY_ENV} from ${ctx.paths.envFile}.` : `No API key was kept in ${ctx.paths.envFile}.`}${inEnvironment ? ` ${CLOUD_API_KEY_ENV} is still set in this environment.` : ""} The key itself works until it is revoked under Settings → API keys.`, { ok: true, removed, env_var_set: inEnvironment });
      return 0;
    }
    case "machines": {
      const client = fleetClient(env, config.cloud, storedApiKey(ctx.paths, env));
      const { data, raw } = await client.get("/machines", MachineListSchema);
      const rows = data.machines.map((m) => [m.name, m.status ?? "", m.mode ?? "", m.skillhook_version ?? "", m.last_seen_at ? relativeTime(m.last_seen_at) : "never"]);
      ctx.print(rows.length ? table(rows, ["machine", "status", "mode", "version", "last seen"]) : `No machine is paired with the organisation yet (${client.url})`, raw);
      return 0;
    }
    case "jobs": {
      const status = str(ctx.flags, "status");
      if (status && !(JOB_STATUSES as readonly string[]).includes(status)) throw new UsageError(`--status must be one of ${JOB_STATUSES.join(", ")}`, USAGE);
      const outcome = str(ctx.flags, "outcome");
      if (outcome && !(JOB_OUTCOMES as readonly string[]).includes(outcome)) throw new UsageError(`--outcome must be one of ${JOB_OUTCOMES.join(", ")}`, USAGE);
      const limit = num(ctx.flags, "limit");
      if (limit !== undefined && !(Number.isInteger(limit) && limit >= 1 && limit <= 100)) throw new UsageError("--limit must be a whole number from 1 to 100", USAGE);
      const waiting = bool(ctx.flags, "waiting");
      const query = new URLSearchParams();
      for (const [key, value] of Object.entries({ machine: str(ctx.flags, "machine"), skill: str(ctx.flags, "skill"), status, outcome, waiting: waiting ? "1" : undefined, limit: limit?.toString(), before: str(ctx.flags, "before") })) if (value) query.set(key, value);
      const client = fleetClient(env, config.cloud, storedApiKey(ctx.paths, env));
      const { data, raw } = await client.get(`/jobs${query.size ? `?${query.toString()}` : ""}`, JobListSchema);
      if (ctx.json) {
        ctx.print("", raw);
        return 0;
      }
      const names = await machineNames(client);
      const rows = data.jobs.map((j) => [j.local_id ?? j.id, machineOf(j, names), j.skill, `${j.status}${j.failure ? ` (${j.failure.kind})` : ""}`, j.response?.outcome ?? j.outcome ?? "", j.waiting_for_human ? "waiting" : (j.progress?.state ?? ""), typeof j.duration_ms === "number" ? formatDuration(j.duration_ms) : "", relativeTime(j.created_at ?? undefined), firstLine(j.waiting_for_human && j.question ? `? ${j.question.text}` : (j.response?.summary ?? j.failure?.message ?? j.result ?? "")).slice(0, 60)]);
      const more = data.next_before && data.jobs.length >= (limit ?? 20) ? `\n(more: --before ${data.next_before})` : "";
      ctx.print(rows.length ? `${table(rows, ["job", "machine", "skill", "status", "outcome", "human", "took", "when", "summary"])}${more}` : waiting ? "No job is waiting for a person" : "No jobs", raw);
      return 0;
    }
    case "job": {
      const id = ctx.args[1];
      if (!id) throw new UsageError("Missing the job id (the machine's own, or the cloud's)", USAGE);
      const client = fleetClient(env, config.cloud, storedApiKey(ctx.paths, env));
      const { data, raw } = await client.get(`/jobs/${encodeURIComponent(id)}`, JobDetailSchema);
      if (ctx.json) {
        ctx.print("", raw);
        return 0;
      }
      ctx.print(describeJob(data.job, machineOf(data.job, await machineNames(client))), raw);
      return 0;
    }
    default:
      throw new UsageError(`Unknown cloud subcommand "${sub}"`, USAGE);
  }
}

async function readStdin(ctx: Ctx): Promise<string> {
  return ctx.io.stdin ? await ctx.io.stdin() : readFileSync(0, "utf8");
}

/** The title (the argument or --title), the body (--body TEXT, --body - for stdin, or --body-file), the rest as given. */
async function reportInput(ctx: Ctx): Promise<IssueReportInput> {
  const argument = ctx.args.slice(1).join(" ").trim();
  const flagged = str(ctx.flags, "title")?.trim();
  if (argument && flagged) throw new UsageError("Give the title once: as the argument or with --title", USAGE);
  const title = flagged || argument;
  if (!title) throw new UsageError('Missing the title: skillhook cloud report "what went wrong"', USAGE);
  const kind = str(ctx.flags, "kind");
  if (kind && !(ISSUE_KINDS as readonly string[]).includes(kind)) throw new UsageError(`--kind must be one of ${ISSUE_KINDS.join(", ")}`, USAGE);
  const severity = str(ctx.flags, "severity");
  if (severity && !(ISSUE_SEVERITIES as readonly string[]).includes(severity)) throw new UsageError(`--severity must be one of ${ISSUE_SEVERITIES.join(", ")}`, USAGE);
  if (ctx.flags.body === true) throw new UsageError("--body needs the text, or - to read it from stdin", USAGE);
  if (ctx.flags["body-file"] === true) throw new UsageError("--body-file needs a path", USAGE);
  const inline = str(ctx.flags, "body");
  const file = str(ctx.flags, "body-file");
  if (inline !== undefined && file !== undefined) throw new UsageError("Give --body or --body-file, not both", USAGE);
  let body = inline === "-" ? await readStdin(ctx) : inline;
  if (file !== undefined) {
    try {
      body = readFileSync(file, "utf8");
    } catch (error) {
      throw new CommandError(`Cannot read ${file}: ${(error as Error).message}`);
    }
  }
  const email = str(ctx.flags, "email");
  const job = str(ctx.flags, "job");
  const delivery = str(ctx.flags, "delivery");
  const skill = str(ctx.flags, "skill");
  return {
    title,
    ...(body ? { body } : {}),
    ...(kind ? { kind: kind as IssueKind } : {}),
    ...(severity ? { severity: severity as IssueSeverity } : {}),
    ...(email ? { contact_email: email } : {}),
    ...(job ? { job_id: job } : {}),
    ...(delivery ? { delivery_id: delivery } : {}),
    ...(skill ? { skill } : {}),
    diagnostics: ctx.flags.diagnostics !== false,
  };
}

function firstLine(text: string): string {
  return text.split("\n")[0] ?? "";
}

function machineOf(job: FleetJob, names: Map<string, string>): string {
  return (job.machine_id && names.get(job.machine_id)) || job.machine_id || "?";
}

function describeJob(job: FleetJob, machine: string): string {
  const outcome = job.response?.outcome ?? job.outcome;
  const waiting = job.waiting_for_human === true;
  return [
    `${job.local_id ?? job.id}  ${job.skill}  ${job.status}${outcome ? `  (${outcome})` : ""}${waiting ? "  WAITING FOR A PERSON" : ""}`,
    `  machine:   ${machine}`,
    ...(job.question ? [`  question:  ${firstLine(job.question.text)}${job.question.options?.length ? ` [${job.question.options.join(" | ")}]` : ""}${waiting ? "  (answer it on the dashboard)" : ""}`] : []),
    ...(job.answer ? [`  answer:    ${job.answer.option ? `${job.answer.option}: ` : ""}${firstLine(job.answer.text)}${job.answer.by ? ` (${job.answer.by})` : ""}`] : []),
    ...(job.progress ? [`  progress:  ${job.progress.state}${job.progress.message ? `: ${firstLine(job.progress.message)}` : ""}${typeof job.progress.percent === "number" ? ` (${job.progress.percent}%)` : ""}`] : []),
    ...(job.response?.summary ? [`  outcome:   ${outcome ?? "?"}: ${firstLine(job.response.summary)}`] : []),
    ...(job.failure ? [`  failure:   ${job.failure.kind}${job.failure.message ? `: ${firstLine(job.failure.message)}` : ""}`] : []),
    `  runner:    ${job.runner ?? "?"}${job.model ? ` (${job.model})` : ""}${job.trigger ? `, trigger ${job.trigger}` : ""}`,
    `  created:   ${job.created_at ?? "?"}${typeof job.duration_ms === "number" ? `  took ${formatDuration(job.duration_ms)}` : ""}${typeof job.cost_usd === "number" ? `  $${job.cost_usd.toFixed(4)}` : ""}`,
    `  ids:       ${job.id} (cloud)${job.local_id ? `, ${job.local_id} (machine)` : ""}`,
    ...(job.dashboard_url ? [`  dashboard: ${job.dashboard_url}`] : []),
    ...(job.result ? ["", "result:", job.result] : []),
  ].join("\n");
}
