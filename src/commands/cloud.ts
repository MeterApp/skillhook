import { readFileSync } from "node:fs";
import { adminRequest, findRunningServer, readServerState } from "../client.js";
import { API_KEY_RE, CloudApiError, fleetClient, JobDetailSchema, JobListSchema, machineNames, MachineListSchema, MeSchema, storedApiCredentials, type FleetClient, type FleetJob } from "../cloud/api.js";
import { assertSecureCloudUrl, CLOUD_API_KEY_ENV, CLOUD_API_URL_ENV, CLOUD_PRIVATE_KEY_ENV, CLOUD_TOKEN_ENV, cloudDisabledByEnv, resolveCloudUrl } from "../cloud/config.js";
import { CloudHttpError } from "../cloud/http.js";
import { cloudStatus, disconnectCloud, machineInfo, pairMachine, writeLinkCredentials } from "../cloud/pair.js";
import { ISSUE_KINDS, ISSUE_SEVERITIES, JOB_OUTCOMES, JOB_STATUSES, type IssueKind, type IssueSeverity } from "../cloud/protocol.js";
import { generateRemoteSecret, secretNameFor } from "../cloud/remote-secret.js";
import { buildIssueReport, IssueReportError, reportIssue, type IssueReportInput } from "../cloud/report.js";
import { machineKeyPair, publicKeyOf, SealError } from "../cloud/seal.js";
import { callTool, fetchCatalog, renderResult, toolInput, ToolInputError, toolName, toolUsage, type Catalog } from "../cloud/tools.js";
import { ensureSecretFileMode, readEnvFile, removeEnvVar, upsertEnvVar } from "../env.js";
import { printable } from "../util.js";
import { bool, CommandError, formatDuration, num, parseArgs, promptHidden, relativeTime, str, table, UsageError, type Ctx } from "./shared.js";

export const CLOUD_USAGE = `Usage:
  skillhook cloud connect --code XXXX-XXXX [--url URL] [--control|--observe] [--force]   pair this machine with Skillhook Cloud (the dashboard shows the code)
  skillhook cloud connect --token TOKEN [--url URL] [--control|--observe] [--force]      pair with a machine token instead
  skillhook cloud disconnect [--keep-token]                                              stop the link, forget the pairing, revoke the token
  skillhook cloud status
  skillhook cloud report "<title>" [--body TEXT|--body-file PATH|--body -] [--kind ${ISSUE_KINDS.join("|")}] [--severity ${ISSUE_SEVERITIES.join("|")}] [--job ID] [--delivery ID] [--skill NAME] [--email ADDRESS] [--no-diagnostics] [--dry-run]   report a problem to the Skillhook team from this paired machine
  skillhook cloud login [--url URL] [--key shc_…|-]                                      check an organisation API key (Settings → API keys) and keep it in .env with its cloud; asks for it at a terminal
  skillhook cloud logout                                                                 forget that key

With the API key, the whole organisation (every command below reads or acts through Skillhook Cloud):
  skillhook cloud overview                                                               what needs a person now: waiting agents, alerts, failing checks, failures, the day's numbers
  skillhook cloud machines                                                               the organisation's machines
  skillhook cloud jobs [--machine M] [--skill S] [--status ${JOB_STATUSES.join("|")}] [--outcome ${JOB_OUTCOMES.join("|")}] [--waiting] [--limit N] [--before CURSOR]
  skillhook cloud job <id>                                                               one job: status, outcome, the question waiting for a person, the result
  skillhook cloud tools [tool]                                                           every tool the cloud offers this key (the dashboard's views and actions); one tool's parameters
  skillhook cloud <tool> [arguments] [--param value]…                                    run one, e.g. answer_job <job> "yes", get_stats --days 30, run_skill <machine> <skill> --payload @event.json
  skillhook cloud secret <machine> <skill|NAME> [--force]                                generate a skill's secret on a machine: shown here once, sealed so the cloud never sees it`;

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
      if (!code && !token) throw new UsageError("Give --code (from the dashboard's pairing page) or --token", CLOUD_USAGE);
      if (code && token) throw new UsageError("Give either --code or --token, not both", CLOUD_USAGE);
      if (bool(ctx.flags, "control") && bool(ctx.flags, "observe")) throw new UsageError("--control and --observe exclude each other", CLOUD_USAGE);
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
      ctx.print(printable(lines.join("\n")), { ok: true, url, machine_id: response.machine_id, mode: response.mode, dashboard_url: response.dashboard_url, account: response.account, server_running: Boolean(running) });
      return 0;
    }
    case "disconnect": {
      const keepToken = bool(ctx.flags, "keep-token");
      const done = await disconnectCloud(ctx.paths, env, { keepToken, notify: (baseUrl) => notifyReload(ctx, baseUrl) });
      ctx.print(printable(`${done.was_enabled ? "Disconnected from" : "Not connected to"} ${done.url}.${done.token_removed ? (done.revoked ? " Token revoked." : " The cloud could not be told; the token was removed here.") : keepToken ? " Token kept in .env." : ""} The running server stops the link within a few seconds.`), { ok: true, ...done });
      return 0;
    }
    case "status": {
      const data = await cloudStatus(ctx.paths, env);
      const link = data.link;
      const lines = [
        `${data.enabled ? "enabled" : "not connected"} · ${data.url}${data.machine_id ? ` · machine ${data.machine_id}` : ""} · mode ${data.mode} · token ${data.token_present ? "present" : "missing"}${data.env_disabled ? " · SKILLHOOK_NO_CLOUD set" : ""}`,
        ...(link ? [`link: ${link.state}${link.reason ? ` (${link.reason})` : ""}${link.last_sync_at ? `, last sync ${link.last_sync_at}` : ""}${link.outbox_depth ? `, ${link.outbox_depth} event(s) waiting` : ""}${link.last_error ? `, last error: ${link.last_error}` : ""}`] : data.server_running ? ["link: the running server reports no link state"] : ["link: no running server"]),
        ...(Object.keys(link?.ingress_urls ?? {}).length ? [`hosted URLs: ${Object.entries(link?.ingress_urls ?? {}).map(([skill, u]) => `${skill} ${u}`).join(", ")}`] : []),
        data.api_key.present
          ? `API key: ${data.api_key.url ? `present for ${data.api_key.url}` : `present, kept without its cloud: it goes to the machine's (${data.url}) until skillhook cloud login names one`} (${data.api_key.source === "environment" ? CLOUD_API_KEY_ENV : ctx.paths.envFile}): skillhook cloud overview, skillhook cloud tools`
          : "API key: none (skillhook cloud login reads the whole organisation)",
      ];
      ctx.print(printable(lines.join("\n")), data);
      return 0;
    }
    case "report": {
      const input = await reportInput(ctx);
      if (bool(ctx.flags, "dry-run")) {
        const built = await buildIssueReport(ctx.paths, env, input, { config });
        ctx.print(printable(`Would send to ${built.url}/api/agent/issues (nothing was sent):\n${JSON.stringify(built.request, null, 2)}`), { dry_run: true, ...built });
        return 0;
      }
      const { issue, request } = await reportIssue(ctx.paths, env, input, { config });
      const lines = [
        `Reported as #${issue.number}: ${issue.url}`,
        issue.acknowledged ? `A confirmation email was sent${request.contact_email ? ` to ${request.contact_email}` : ""}.` : "No confirmation email was sent.",
        ...(request.diagnostics ? ["Diagnostics went with it (--dry-run shows them; --no-diagnostics leaves them out)."] : []),
      ];
      ctx.print(printable(lines.join("\n")), issue);
      return 0;
    }
    case "login": {
      const url = str(ctx.flags, "url");
      if (ctx.flags.url === true) throw new UsageError("--url needs the cloud's address, like https://cloud.example.com", CLOUD_USAGE);
      let given = str(ctx.flags, "key");
      if (!given && ctx.io.isTTY) given = await promptHidden("Organisation API key (dashboard → Settings → API keys): ");
      if (!given) throw new UsageError("Give the organisation API key: --key shc_…, or --key - to read it from stdin (Settings → API keys on the dashboard); at a terminal, skillhook cloud login asks for it", CLOUD_USAGE);
      const key = (given === "-" ? await readStdin(ctx) : given).trim();
      if (!API_KEY_RE.test(key)) throw new UsageError("That is not an organisation API key: those are shc_ followed by letters, digits, - and _ (Settings → API keys on the dashboard)", CLOUD_USAGE);
      // The cloud named here (else the one logged in to before, else the machine's) is the one the key is checked against,
      // kept with it, and the only one it is ever sent to: changing cloud.url later moves neither the key nor this
      // machine's link.
      const before = env[CLOUD_API_URL_ENV]?.trim() || readEnvFile(ctx.paths.envFile)[CLOUD_API_URL_ENV] || undefined;
      const client = fleetClient(env, config.cloud, { key, url: undefined }, { url: url ?? before });
      const { data: me } = await client.get("/me", MeSchema);
      upsertEnvVar(ctx.paths.envFile, CLOUD_API_KEY_ENV, key);
      upsertEnvVar(ctx.paths.envFile, CLOUD_API_URL_ENV, client.url);
      ensureSecretFileMode(ctx.paths.envFile);
      const fromEnvironment = env[CLOUD_API_KEY_ENV]?.trim();
      const lines = [
        `Logged in to ${client.url} as ${me.organisation.name}: key "${me.key.name}" (${me.key.scopes.join(", ") || "no scopes"}), kept in ${ctx.paths.envFile} with its cloud (${CLOUD_API_KEY_ENV}, ${CLOUD_API_URL_ENV}).`,
        ...(fromEnvironment && fromEnvironment !== key ? [`${CLOUD_API_KEY_ENV} is also set in this environment, and wins over .env.`] : []),
        "Next: skillhook cloud overview (what needs attention), skillhook cloud tools (everything this key can do); agents get the same as the skillhook-cloud MCP server (skillhook mcp --cloud).",
      ];
      ctx.print(printable(lines.join("\n")), { ok: true, url: client.url, organisation: me.organisation, key: me.key, role: me.role, env_file: ctx.paths.envFile });
      return 0;
    }
    case "logout": {
      const removed = removeEnvVar(ctx.paths.envFile, CLOUD_API_KEY_ENV);
      removeEnvVar(ctx.paths.envFile, CLOUD_API_URL_ENV);
      const inEnvironment = Boolean(env[CLOUD_API_KEY_ENV]?.trim());
      ctx.print(printable(`${removed ? `Removed ${CLOUD_API_KEY_ENV} from ${ctx.paths.envFile}.` : `No API key was kept in ${ctx.paths.envFile}.`}${inEnvironment ? ` ${CLOUD_API_KEY_ENV} is still set in this environment.` : ""} The key itself works until it is revoked under Settings → API keys.`), { ok: true, removed, env_var_set: inEnvironment });
      return 0;
    }
    case "machines": {
      const client = apiClient(ctx);
      const { data, raw } = await client.get("/machines", MachineListSchema);
      const rows = data.machines.map((m) => [m.name, m.status ?? "", m.mode ?? "", m.skillhook_version ?? "", m.last_seen_at ? relativeTime(m.last_seen_at) : "never"]);
      ctx.print(printable(rows.length ? table(rows, ["machine", "status", "mode", "version", "last seen"]) : `No machine is paired with the organisation yet (${client.url})`), raw);
      return 0;
    }
    case "jobs": {
      const status = str(ctx.flags, "status");
      if (status && !(JOB_STATUSES as readonly string[]).includes(status)) throw new UsageError(`--status must be one of ${JOB_STATUSES.join(", ")}`, CLOUD_USAGE);
      const outcome = str(ctx.flags, "outcome");
      if (outcome && !(JOB_OUTCOMES as readonly string[]).includes(outcome)) throw new UsageError(`--outcome must be one of ${JOB_OUTCOMES.join(", ")}`, CLOUD_USAGE);
      const limit = num(ctx.flags, "limit");
      if (limit !== undefined && !(Number.isInteger(limit) && limit >= 1 && limit <= 100)) throw new UsageError("--limit must be a whole number from 1 to 100", CLOUD_USAGE);
      const waiting = bool(ctx.flags, "waiting");
      const query = new URLSearchParams();
      for (const [key, value] of Object.entries({ machine: str(ctx.flags, "machine"), skill: str(ctx.flags, "skill"), status, outcome, waiting: waiting ? "1" : undefined, limit: limit?.toString(), before: str(ctx.flags, "before") })) if (value) query.set(key, value);
      const client = apiClient(ctx);
      const { data, raw } = await client.get(`/jobs${query.size ? `?${query.toString()}` : ""}`, JobListSchema);
      if (ctx.json) {
        ctx.print("", raw);
        return 0;
      }
      const names = await machineNames(client);
      const rows = data.jobs.map((j) => [j.local_id ?? j.id, machineOf(j, names), j.skill, `${j.status}${j.failure ? ` (${j.failure.kind})` : ""}`, j.response?.outcome ?? j.outcome ?? "", j.waiting_for_human ? "waiting" : (j.progress?.state ?? ""), typeof j.duration_ms === "number" ? formatDuration(j.duration_ms) : "", relativeTime(j.created_at ?? undefined), firstLine(j.waiting_for_human && j.question ? `? ${j.question.text}` : (j.response?.summary ?? j.failure?.message ?? j.result ?? "")).slice(0, 60)]);
      const more = data.next_before && data.jobs.length >= (limit ?? 20) ? `\n(more: --before ${data.next_before})` : "";
      ctx.print(printable(rows.length ? `${table(rows, ["job", "machine", "skill", "status", "outcome", "human", "took", "when", "summary"])}${more}` : waiting ? "No job is waiting for a person" : "No jobs"), raw);
      return 0;
    }
    case "job": {
      const id = ctx.args[1];
      if (!id) throw new UsageError("Missing the job id (the machine's own, or the cloud's)", CLOUD_USAGE);
      const client = apiClient(ctx);
      const { data, raw } = await client.get(`/jobs/${encodeURIComponent(id)}`, JobDetailSchema);
      if (ctx.json) {
        ctx.print("", raw);
        return 0;
      }
      ctx.print(printable(describeJob(data.job, machineOf(data.job, await machineNames(client)))), raw);
      return 0;
    }
    case "overview": {
      const client = apiClient(ctx);
      const data = await callTool(client, "describe_cloud", {});
      ctx.print(printable(describeOverview(data)), data);
      return 0;
    }
    case "tools": {
      const client = apiClient(ctx);
      const catalog = await fetchCatalog(client);
      const name = ctx.args[1];
      if (name) {
        const tool = catalog.tools.find((t) => t.name === toolName(name));
        if (!tool) throw new UsageError(`${client.url} offers no tool "${name}"; skillhook cloud tools lists them`, CLOUD_USAGE);
        ctx.print(printable(toolUsage(tool)), tool);
        return 0;
      }
      ctx.print(printable(describeCatalog(catalog)), catalog);
      return 0;
    }
    case "secret": {
      const [, machine, given] = ctx.args;
      if (!machine || !given) throw new UsageError("Name the machine and the skill (or its secret's variable): skillhook cloud secret mac-mini hello", CLOUD_USAGE);
      const client = apiClient(ctx);
      const name = await secretNameFor(client, machine, given);
      const made = await generateRemoteSecret(client, { machine, name, force: bool(ctx.flags, "force") });
      if (made.secret === null) ctx.print(printable(`${made.machine} already has ${name}; --force replaces it (the sender then needs the new value).`), { ok: true, ...made });
      else ctx.print(printable(`${name}=${made.secret}\n\nGenerated on ${made.machine} and kept in its .env (shown once; sealed to this terminal, the cloud never saw it). Configure the sender with this value.`), { ok: true, ...made });
      return 0;
    }
    default:
      return callCloudTool(ctx, sub);
  }
}

/** A client with the organisation API key kept here (or in the environment), for the cloud it was checked against. */
function apiClient(ctx: Ctx): FleetClient {
  return fleetClient(ctx.io.env, ctx.config().cloud, storedApiCredentials(ctx.paths, ctx.io.env));
}

/**
 * `skillhook cloud <tool> …`: any tool of the cloud's catalogue, its input from the words around its name, read with its
 * schema (a switch never takes the next word, a text parameter does) rather than as the flags of every command.
 */
async function callCloudTool(ctx: Ctx, given: string): Promise<number> {
  if (!/^[a-z][a-z0-9_-]*$/i.test(given)) throw new UsageError(`Unknown cloud subcommand "${given}"`, CLOUD_USAGE);
  let client: FleetClient;
  try {
    client = apiClient(ctx);
  } catch (error) {
    // Without a key a mistyped subcommand is still most likely; anything else (the kill switch, the URL) says itself.
    if (error instanceof CloudApiError && error.code === "no_key") throw new UsageError(`Unknown cloud subcommand "${given}" (the cloud's tools, skillhook cloud tools, need an organisation API key: skillhook cloud login)`, CLOUD_USAGE);
    throw error;
  }
  const catalog = await fetchCatalog(client);
  const tool = catalog.tools.find((t) => t.name === toolName(given));
  if (!tool) throw new UsageError(`Unknown cloud subcommand or tool "${given}"; skillhook cloud tools lists the tools`, CLOUD_USAGE);
  const at = parseArgs(ctx.rawArgs).positionalIndexes[0] ?? ctx.rawArgs.length;
  let input: Record<string, unknown>;
  try {
    input = await toolInput(tool, [...ctx.rawArgs.slice(0, at), ...ctx.rawArgs.slice(at + 1)], {
      stdin: () => readStdin(ctx),
      file: (path: string) => {
        try {
          return readFileSync(path, "utf8");
        } catch (error) {
          throw new ToolInputError(`Cannot read ${path}: ${(error as Error).message}`);
        }
      },
    });
  } catch (error) {
    if (error instanceof ToolInputError) throw new UsageError(error.message, toolUsage(tool));
    throw error;
  }
  if (tool.allowed === false) throw new CommandError(`${tool.name} needs a key with the ${tool.scope ?? "?"} scope; this one has ${catalog.key?.scopes?.join(", ") || "?"}. Create one under Settings → API keys, then: skillhook cloud login`);
  const result = await callTool(client, tool.name, input);
  ctx.print(renderResult(result), result);
  return 0;
}

function describeCatalog(catalog: Catalog): string {
  const firstSentence = (text: string) => (text.split(/(?<=\.)\s/)[0] ?? text).slice(0, 100);
  const rows = catalog.tools.map((t) => [t.name, t.scope ?? "", t.allowed === false ? "no" : "yes", firstSentence(t.title ?? t.description)]);
  return [`${catalog.organisation?.name ?? "?"} · key "${catalog.key?.name ?? "?"}" (${catalog.key?.scopes?.join(", ") ?? "?"})`, "", table(rows, ["tool", "scope", "allowed", "what"]), "", "skillhook cloud tools <tool> shows a tool's parameters; skillhook cloud <tool> … runs it (--json for the answer as it came)."].join("\n");
}

type Brief = { id?: string; local_id?: string | null; machine?: string | null; skill?: string; status?: string; outcome?: string | null; question?: { text?: string; options?: string[] | null } | null; failure?: { kind?: string } | null; code?: string | null; reason?: string | null; created_at?: string; received_at?: string; waiting_since?: string | null };

/** `skillhook cloud overview`: describe_cloud as a page, the most pressing things first. */
function describeOverview(data: Record<string, unknown>): string {
  const o = data as {
    organisation?: { name?: string };
    key?: { name?: string; scopes?: string[] };
    machines?: { total?: number; online?: number; list?: { name?: string; status?: string; mode?: string; skillhook_version?: string | null; last_seen_at?: string | null; runners_not_ready?: { runner?: string | null; detail?: string | null }[] }[] };
    waiting_for_a_person?: number;
    needs_attention?: { waiting_jobs?: Brief[]; open_alerts?: { count?: number; recent?: { type?: string; title?: string; opened_at?: string }[] }; failing_checks?: { machine?: string | null; name?: string; status?: string; detail?: string | null; hint?: string | null }[]; failed_jobs_24h?: { count?: number; recent?: Brief[] }; rejected_deliveries_24h?: { count?: number; recent?: Brief[] } };
    last_24h?: { jobs?: { total?: number; succeeded?: number; failed?: number; running?: number; needs_human?: number; cost_usd?: number }; deliveries?: { total?: number; accepted?: number; rejected?: number } };
    next_steps?: string[];
  };
  if (!o.machines || !o.needs_attention) return renderResult(data);
  const attention = o.needs_attention;
  const id = (b: Brief) => b.local_id ?? b.id ?? "?";
  const lines = [`${o.organisation?.name ?? "?"} · key "${o.key?.name ?? "?"}" (${o.key?.scopes?.join(", ") ?? "?"}) · ${o.machines.online ?? 0}/${o.machines.total ?? 0} machines online`];
  const section = (title: string, rows: string[]) => {
    if (rows.length) lines.push("", title, ...rows.map((row) => `  ${row}`));
  };
  section(
    `Waiting for a person (${o.waiting_for_a_person ?? 0})`,
    (attention.waiting_jobs ?? []).map((j) => `${id(j)}  ${j.skill ?? "?"} on ${j.machine ?? "?"}: ${firstLine(j.question?.text ?? "finished needing a person")}${j.question?.options?.length ? ` [${j.question.options.join(" | ")}]` : ""}`),
  );
  section(`Open alerts (${attention.open_alerts?.count ?? 0})`, (attention.open_alerts?.recent ?? []).map((a) => `${a.type ?? "?"}: ${firstLine(a.title ?? "")}  ${relativeTime(a.opened_at)}`));
  section("Failing health checks", (attention.failing_checks ?? []).map((c) => `${c.machine ?? "?"}  ${c.name ?? "?"} (${c.status ?? "?"})${c.detail ? `: ${firstLine(c.detail)}` : ""}${c.hint ? `  fix: ${firstLine(c.hint)}` : ""}`));
  section(`Failed jobs, 24 h (${attention.failed_jobs_24h?.count ?? 0})`, (attention.failed_jobs_24h?.recent ?? []).map((j) => `${id(j)}  ${j.skill ?? "?"} on ${j.machine ?? "?"}: ${j.status ?? "?"}${j.failure?.kind ? ` (${j.failure.kind})` : ""}  ${relativeTime(j.created_at)}`));
  section(`Rejected webhooks, 24 h (${attention.rejected_deliveries_24h?.count ?? 0})`, (attention.rejected_deliveries_24h?.recent ?? []).map((d) => `${id(d)}  ${d.skill ?? "?"} on ${d.machine ?? "?"}: ${d.code ?? ""}${d.reason ? ` ${firstLine(d.reason)}` : ""}  ${relativeTime(d.received_at)}`));
  const jobs = o.last_24h?.jobs;
  const deliveries = o.last_24h?.deliveries;
  if (jobs || deliveries) lines.push("", `Last 24 h: ${jobs?.total ?? 0} jobs (${jobs?.succeeded ?? 0} succeeded, ${jobs?.failed ?? 0} failed, ${jobs?.running ?? 0} running)${typeof jobs?.cost_usd === "number" ? `, $${jobs.cost_usd.toFixed(2)}` : ""}; ${deliveries?.total ?? 0} webhooks (${deliveries?.accepted ?? 0} accepted, ${deliveries?.rejected ?? 0} rejected)`);
  const machines = (o.machines.list ?? []).map((m) => [m.name ?? "?", m.status ?? "", m.mode ?? "", m.skillhook_version ?? "", m.last_seen_at ? relativeTime(m.last_seen_at) : "never", (m.runners_not_ready ?? []).map((r) => `${r.runner ?? "?"} not ready`).join(", ")]);
  if (machines.length) lines.push("", table(machines, ["machine", "status", "mode", "version", "last seen", "runners"]));
  section("Next steps", (o.next_steps ?? []).map((step) => `- ${step}`));
  return lines.join("\n");
}

async function readStdin(ctx: Ctx): Promise<string> {
  return ctx.io.stdin ? await ctx.io.stdin() : readFileSync(0, "utf8");
}

/** The title (the argument or --title), the body (--body TEXT, --body - for stdin, or --body-file), the rest as given. */
async function reportInput(ctx: Ctx): Promise<IssueReportInput> {
  const argument = ctx.args.slice(1).join(" ").trim();
  const flagged = str(ctx.flags, "title")?.trim();
  if (argument && flagged) throw new UsageError("Give the title once: as the argument or with --title", CLOUD_USAGE);
  const title = flagged || argument;
  if (!title) throw new UsageError('Missing the title: skillhook cloud report "what went wrong"', CLOUD_USAGE);
  const kind = str(ctx.flags, "kind");
  if (kind && !(ISSUE_KINDS as readonly string[]).includes(kind)) throw new UsageError(`--kind must be one of ${ISSUE_KINDS.join(", ")}`, CLOUD_USAGE);
  const severity = str(ctx.flags, "severity");
  if (severity && !(ISSUE_SEVERITIES as readonly string[]).includes(severity)) throw new UsageError(`--severity must be one of ${ISSUE_SEVERITIES.join(", ")}`, CLOUD_USAGE);
  if (ctx.flags.body === true) throw new UsageError("--body needs the text, or - to read it from stdin", CLOUD_USAGE);
  if (ctx.flags["body-file"] === true) throw new UsageError("--body-file needs a path", CLOUD_USAGE);
  const inline = str(ctx.flags, "body");
  const file = str(ctx.flags, "body-file");
  if (inline !== undefined && file !== undefined) throw new UsageError("Give --body or --body-file, not both", CLOUD_USAGE);
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
    diagnostics: !(ctx.flags.diagnostics === false || ["false", "0", "no", "off"].includes(str(ctx.flags, "diagnostics")?.toLowerCase() ?? "")),
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
