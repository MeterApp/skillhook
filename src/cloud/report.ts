// `skillhook cloud report` and the MCP tool `cloud_report_issue`: a person on a paired machine tells the Skillhook team
// about a problem. One request, `POST /api/agent/issues` with the machine token, and only when someone asks for it: the
// person's own words and, unless they say no, what the machine already knows about itself (versions, platform, the
// link's state, runner readiness, the checks that fail), scrubbed of every `.env` value like everything the link sends.
// Never payloads, logs, prompts or job output. See docs/cloud.md.
import { z } from "zod";
import { adminRequest, findRunningServer } from "../client.js";
import { loadConfig, type Config } from "../config.js";
import { loadSecrets, readEnvFile } from "../env.js";
import { runHealth, type HealthOptions, type HealthReport } from "../health.js";
import type { Paths } from "../paths.js";
import { checkReadiness, RUNNER_NAMES, type RunnerReadiness } from "../readiness.js";
import { baseRunEnv } from "../runners/env.js";
import { VERSION } from "../version.js";
import { CLOUD_TOKEN_ENV, cloudDisabledByEnv, InsecureCloudUrlError, isSecureCloudUrl, resolveCloudUrl } from "./config.js";
import { CloudHttpError, cloudRequest } from "./http.js";
import { IssueDiagnosticsSchema, IssueReportRequestSchema, IssueReportResponseSchema, LIMITS, type IssueDiagnostics, type IssueReportRequest, type IssueReportResponse } from "./protocol.js";
import { scrubSecrets, secretValues } from "./redact.js";

/** What a person gives; `diagnostics: false` sends their words only. */
export type IssueReportInput = Omit<IssueReportRequest, "diagnostics"> & { diagnostics?: boolean };

export class IssueReportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IssueReportError";
  }
}

const MAX_TITLE = 200;
const MAX_BODY = 20_000;
/** Failing and warning checks that travel, and how much of each line. */
const MAX_FAILING = 50;
const MAX_LINE = 500;

export interface DiagnosticsOptions {
  config?: Config;
  /** Options of the quick local health check when no server runs (tests turn the Tailscale and service probes off). */
  health?: HealthOptions;
}

/**
 * The versions, the platform and the cloud mode; then, from the running server's cached answers (or a quick local check
 * when none runs), the link's state, whether each runner is ready and the health summary with the checks that fail or
 * warn. Scrubbed of every `.env` value, then cut to the protocol's bounds; what cannot be read is left out.
 */
export async function gatherDiagnostics(paths: Paths, env: NodeJS.ProcessEnv, options: DiagnosticsOptions = {}): Promise<IssueDiagnostics> {
  const config = options.config ?? loadConfig(paths);
  const secrets = loadSecrets(paths, env);
  const fileSecrets = readEnvFile(paths.envFile);
  const running = await findRunningServer(paths);
  let report: HealthReport | undefined;
  let runners: RunnerReadiness[] | undefined;
  if (running) {
    [report, runners] = await Promise.all([
      adminRequest<HealthReport>(running.baseUrl, secrets, "/health/checks?deep=0&network=0", { timeoutMs: 60_000 }).then((r) => (r.status < 400 ? r.body : undefined), () => undefined),
      adminRequest<{ runners: RunnerReadiness[] }>(running.baseUrl, secrets, "/runners", { timeoutMs: 60_000 }).then((r) => (r.status < 400 ? r.body.runners : undefined), () => undefined),
    ]);
  } else {
    const runEnv = baseRunEnv({ secrets, fileSecrets, processEnv: env });
    [report, runners] = await Promise.all([runHealth(paths, { env, deep: false, network: false, ...options.health }).catch(() => undefined), Promise.all(RUNNER_NAMES.map((runner) => checkReadiness(runner, config, runEnv))).catch(() => undefined)]);
  }
  const link = running?.health.cloud ?? undefined;
  const failing = (report?.checks ?? []).filter((c) => c.status === "fail" || c.status === "warn").sort((a, b) => Number(b.status === "fail") - Number(a.status === "fail"));
  // Scrubbed before being cut: a replacement may make a line longer.
  const facts = scrubSecrets({ last_error: link?.last_error ?? "", failing: failing.slice(0, MAX_FAILING).map((c) => ({ id: c.name, status: c.status, message: c.detail })) }, secretValues(fileSecrets));
  const basics: IssueDiagnostics = { skillhook_version: VERSION, node_version: process.versions.node, os: process.platform, arch: process.arch, mode: config.cloud.mode };
  const diagnostics: IssueDiagnostics = {
    ...basics,
    ...(link ? { link: { state: link.state, ...(link.reason ? { reason: link.reason } : {}), ...(facts.last_error ? { last_error: facts.last_error.slice(0, MAX_LINE) } : {}) } } : {}),
    ...(runners?.length ? { runners: runners.slice(0, RUNNER_NAMES.length).map((r) => ({ runner: r.runner, ready: r.ready })) } : {}),
    ...(report ? { health: { ok: report.ok, summary: { ok: report.summary.ok, warn: report.summary.warn, fail: report.summary.fail, skip: report.summary.skip }, ...(facts.failing.length ? { failing: facts.failing.map((c) => ({ id: c.id.slice(0, 200), status: c.status, ...(c.message ? { message: c.message.slice(0, MAX_LINE) } : {}) })) } : {}) } } : {}),
  };
  // A server of another version may say something this protocol cannot carry: then only the basics travel.
  return IssueDiagnosticsSchema.safeParse(diagnostics).success ? diagnostics : basics;
}

export interface BuiltIssueReport {
  /** The cloud it goes to. */
  url: string;
  /** Exactly what is sent. */
  request: IssueReportRequest;
}

/** The request, scrubbed and validated: what `reportIssue` sends and `skillhook cloud report --dry-run` prints. */
export async function buildIssueReport(paths: Paths, env: NodeJS.ProcessEnv, input: IssueReportInput, options: DiagnosticsOptions = {}): Promise<BuiltIssueReport> {
  const config = options.config ?? loadConfig(paths);
  const text = scrubSecrets({ title: input.title.trim(), body: input.body?.trim() ?? "" }, secretValues(readEnvFile(paths.envFile)));
  if (!text.title) throw new IssueReportError("The report needs a title: one line that says what went wrong");
  if (text.title.length > MAX_TITLE) throw new IssueReportError(`The title is ${text.title.length} characters; at most ${MAX_TITLE} (put the rest in the body)`);
  if (text.body.length > MAX_BODY) throw new IssueReportError(`The body is ${text.body.length} characters; at most ${MAX_BODY} (refer to the job instead of pasting its output)`);
  const request: IssueReportRequest = {
    title: text.title,
    ...(text.body ? { body: text.body } : {}),
    ...(input.kind ? { kind: input.kind } : {}),
    ...(input.severity ? { severity: input.severity } : {}),
    ...(input.contact_email ? { contact_email: input.contact_email.trim() } : {}),
    ...(input.job_id ? { job_id: input.job_id } : {}),
    ...(input.delivery_id ? { delivery_id: input.delivery_id } : {}),
    ...(input.skill ? { skill: input.skill } : {}),
    ...(input.diagnostics === false ? {} : { diagnostics: await gatherDiagnostics(paths, env, { ...options, config }) }),
  };
  const parsed = IssueReportRequestSchema.safeParse(request);
  if (!parsed.success) throw new IssueReportError(`The report is not valid:\n${z.prettifyError(parsed.error)}`);
  const bytes = Buffer.byteLength(JSON.stringify(parsed.data));
  if (bytes > LIMITS.max_issue_report_bytes) throw new IssueReportError(`The report is ${bytes} bytes; at most ${LIMITS.max_issue_report_bytes} (shorten the body)`);
  return { url: resolveCloudUrl(env, config.cloud), request: parsed.data };
}

export interface IssueReportResult extends BuiltIssueReport {
  /** The cloud's answer: the issue's id, number and URL, and whether a confirmation email went out. */
  issue: IssueReportResponse;
}

/** Sends a report from this machine: needs the pairing, refused under `SKILLHOOK_NO_CLOUD` and to a URL that is not https. */
export async function reportIssue(paths: Paths, env: NodeJS.ProcessEnv, input: IssueReportInput, options: DiagnosticsOptions & { fetchImpl?: typeof fetch } = {}): Promise<IssueReportResult> {
  if (cloudDisabledByEnv(env)) throw new IssueReportError("SKILLHOOK_NO_CLOUD is set: nothing goes to Skillhook Cloud from this environment. Unset it to send the report.");
  const config = options.config ?? loadConfig(paths);
  const token = loadSecrets(paths, env)[CLOUD_TOKEN_ENV];
  if (!config.cloud.enabled || !token) throw new IssueReportError(`This machine is not paired with Skillhook Cloud${config.cloud.enabled ? ` (${CLOUD_TOKEN_ENV} is missing from .env)` : ""}. Pair it with the code from the dashboard's pairing page (skillhook cloud connect --code XXXX-XXXX), or report the problem on the dashboard or through its hosted MCP server.`);
  const url = resolveCloudUrl(env, config.cloud);
  if (!isSecureCloudUrl(url, env)) throw new IssueReportError(new InsecureCloudUrlError(url).message);
  const built = await buildIssueReport(paths, env, input, { ...options, config });
  let answer;
  try {
    answer = await cloudRequest(url, "/api/agent/issues", { token, body: built.request, fetchImpl: options.fetchImpl, timeoutMs: 20_000 });
  } catch (error) {
    if (error instanceof CloudHttpError) throw new IssueReportError(describeFailure(error, url));
    throw error;
  }
  const parsed = IssueReportResponseSchema.safeParse(answer.body);
  if (!parsed.success) throw new IssueReportError(`${url} answered the report with something this version does not understand; it may have arrived all the same (look on the dashboard)`);
  return { ...built, issue: parsed.data };
}

function describeFailure(error: CloudHttpError, url: string): string {
  const said = `${error.code}: ${error.message}`;
  switch (error.status) {
    case 0:
      return `Could not reach ${url}: ${error.message}`;
    case 401:
      return `${url} refused this machine's token (${said}); pair it again: skillhook cloud connect --code XXXX-XXXX --force`;
    case 403:
      return `${url} takes no reports from this machine (${said}); it may be disabled on the dashboard`;
    case 404:
      return `${url} does not take issue reports yet (${said}); report the problem on the dashboard or at https://github.com/MeterApp/skillhook/issues`;
    case 413:
      return `The report is too large for ${url} (${said}); shorten the body`;
    case 429:
      return `Too many reports from this machine (${said}); try again in ${Math.ceil((error.retryAfterMs ?? 60_000) / 1000)} s`;
    default:
      return `${url} could not take the report (${said})`;
  }
}
