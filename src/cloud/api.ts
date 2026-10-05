// The organisation's fleet from the CLI and the `skillhook-cloud` MCP server (`skillhook cloud login|machines|jobs|job|
// overview|tools|secret|<tool>`, `skillhook mcp --cloud`): Skillhook Cloud's public API (`/api/v1`) with an
// organisation API key (`shc_…`, Settings → API keys on the dashboard), never the machine token, so a paired machine
// cannot read the rest of its organisation; only a person holding a key can. Requests go to the machine's cloud URL over
// HTTPS, only when a person runs one of these commands or their agent calls one of those tools. The answers are the
// cloud's own records, parsed loosely: a newer cloud may say more.
import { z } from "zod";
import { readEnvFile } from "../env.js";
import type { Paths } from "../paths.js";
import { CLOUD_API_KEY_ENV, CLOUD_API_URL_ENV, cloudDisabledByEnv, DEFAULT_CLOUD_URL, InsecureCloudUrlError, isSecureCloudUrl, resolveCloudUrl } from "./config.js";
import { CloudHttpError, cloudRequest } from "./http.js";

/** What an organisation API key looks like; machine tokens (`shm_…`) never do. One line, so it can only ever travel as a header. */
export const API_KEY_RE = /^shc_[A-Za-z0-9_-]+$/;

export class CloudApiError extends Error {
  constructor(
    message: string,
    /** The HTTP status the cloud answered (0: it was not reached), when it answered at all. */
    public readonly status?: number,
    /** The problem's `code` (`unknown_tool`, `forbidden`, `unknown_machine`, …). */
    public readonly code?: string,
  ) {
    super(message);
    this.name = "CloudApiError";
  }
}

const text = z.string().nullish();

/** `GET /api/v1/me`: whose key it is. */
export const MeSchema = z.object({ organisation: z.object({ id: z.string(), slug: text, name: z.string() }).loose(), key: z.object({ id: z.string(), name: z.string(), scopes: z.array(z.string()) }).loose(), role: z.string() }).loose();
export type Me = z.infer<typeof MeSchema>;

export const FleetMachineSchema = z.object({ id: z.string(), name: z.string(), status: text, mode: text, skillhook_version: text, link_state: text, last_seen_at: text }).loose();
export type FleetMachine = z.infer<typeof FleetMachineSchema>;
export const MachineListSchema = z.object({ machines: z.array(FleetMachineSchema) }).loose();

export const FleetJobSchema = z
  .object({
    id: z.string(),
    /** The machine's own job id. */
    local_id: text,
    machine_id: text,
    skill: z.string(),
    status: z.string(),
    outcome: text,
    trigger: text,
    runner: text,
    model: text,
    created_at: text,
    duration_ms: z.number().nullish(),
    cost_usd: z.number().nullish(),
    waiting_for_human: z.boolean().nullish(),
    question: z.object({ text: z.string(), options: z.array(z.string()).nullish() }).loose().nullish(),
    answer: z.object({ text: z.string(), option: text, by: text }).loose().nullish(),
    progress: z.object({ state: z.string(), message: text, percent: z.number().nullish() }).loose().nullish(),
    response: z.object({ outcome: text, summary: text }).loose().nullish(),
    failure: z.object({ kind: z.string(), message: text }).loose().nullish(),
    /** An excerpt of the job's result. */
    result: text,
    dashboard_url: text,
  })
  .loose();
export type FleetJob = z.infer<typeof FleetJobSchema>;
export const JobListSchema = z.object({ jobs: z.array(FleetJobSchema), next_before: text }).loose();
export const JobDetailSchema = z.object({ job: FleetJobSchema }).loose();

export interface ApiCredentials {
  key: string | undefined;
  /** The cloud the key was checked against at login; unset for a key kept by skillhook 0.6 or given without one. */
  url: string | undefined;
}

/**
 * `SKILLHOOK_CLOUD_API_KEY` and its cloud: from the environment (CI) with `SKILLHOOK_CLOUD_API_URL` there, or the cloud
 * login kept with the same key; else both from `.env`, where login keeps them. A key without a cloud of its own (kept by
 * skillhook 0.6, or set in the environment alone) goes to the machine's cloud, `SKILLHOOK_CLOUD_URL` or `cloud.url`.
 */
export function storedApiCredentials(paths: Paths, env: NodeJS.ProcessEnv): ApiCredentials {
  const file = readEnvFile(paths.envFile);
  const kept = { key: file[CLOUD_API_KEY_ENV] || undefined, url: file[CLOUD_API_URL_ENV] || undefined };
  const fromEnvironment = env[CLOUD_API_KEY_ENV]?.trim();
  if (!fromEnvironment) return kept;
  return { key: fromEnvironment, url: env[CLOUD_API_URL_ENV]?.trim() || (fromEnvironment === kept.key ? kept.url : undefined) };
}

export interface FleetClient {
  /** The cloud the requests go to. */
  url: string;
  /** `GET /api/v1<path>`: the parsed answer and the answer as the cloud sent it (what `--json` prints); `timeoutMs` defaults to 20 s. */
  get<T>(path: string, schema: z.ZodType<T>, options?: { timeoutMs?: number }): Promise<{ data: T; raw: unknown }>;
  /** `POST /api/v1<path>` with a JSON body; `timeoutMs` for calls that wait for a machine (default 20 s). */
  post<T>(path: string, body: unknown, schema: z.ZodType<T>, options?: { timeoutMs?: number }): Promise<{ data: T; raw: unknown; status: number }>;
}

/**
 * A client with the key for the cloud it was checked against (`credentials.url`; `options.url` at login), else the
 * machine's cloud (`SKILLHOOK_CLOUD_URL`, `cloud.url`, else Skillhook Cloud's own) for a key that has none; refused under
 * `SKILLHOOK_NO_CLOUD`, without a well-formed key, or to a URL that is not https. A key login kept never follows a
 * `cloud.url` changed after it.
 */
export function fleetClient(env: NodeJS.ProcessEnv, cloud: { url?: string }, credentials: ApiCredentials, options: { fetchImpl?: typeof fetch; url?: string } = {}): FleetClient {
  const { key } = credentials;
  if (cloudDisabledByEnv(env)) throw new CloudApiError("SKILLHOOK_NO_CLOUD is set: nothing goes to Skillhook Cloud from this environment. Unset it to use the fleet.", undefined, "disabled");
  const url = resolveCloudUrl(env, cloud, options.url ?? credentials.url);
  if (!key) throw new CloudApiError(`No organisation API key. Create one on ${url} (Settings → API keys), then: ${loginCommand(url)}   (or set ${CLOUD_API_KEY_ENV})`, undefined, "no_key");
  if (!API_KEY_RE.test(key)) throw new CloudApiError(`${CLOUD_API_KEY_ENV} does not hold an organisation API key (shc_ followed by letters, digits, - and _); run: skillhook cloud login`, undefined, "invalid_key");
  if (!isSecureCloudUrl(url, env)) throw new CloudApiError(new InsecureCloudUrlError(url).message, undefined, "insecure_url");
  const send = async <T,>(method: "GET" | "POST", path: string, schema: z.ZodType<T>, body: unknown, timeoutMs: number) => {
    let response;
    try {
      response = await cloudRequest(url, `/api/v1${path}`, { method, token: key, body, fetchImpl: options.fetchImpl, timeoutMs });
    } catch (error) {
      if (error instanceof CloudHttpError) throw new CloudApiError(describeApiFailure(error, url, method), error.status, error.code);
      throw error;
    }
    const parsed = schema.safeParse(response.body);
    if (!parsed.success) throw new CloudApiError(`${url} answered ${method} /api/v1${path} with something this version does not understand`);
    return { data: parsed.data, raw: response.body, status: response.status };
  };
  return {
    url,
    get: (path, schema, getOptions = {}) => send("GET", path, schema, undefined, getOptions.timeoutMs ?? 20_000),
    post: (path, body, schema, postOptions = {}) => send("POST", path, schema, body ?? {}, postOptions.timeoutMs ?? 20_000),
  };
}

/** What a person runs to keep a key for `url`: `--url` only for a cloud other than Skillhook Cloud's own. */
export function loginCommand(url: string): string {
  return url === DEFAULT_CLOUD_URL ? "skillhook cloud login" : `skillhook cloud login --url ${url}`;
}

/** A refused key says to log in again, a missing scope says which, an unreachable cloud where it was looked for. */
export function describeApiFailure(error: CloudHttpError, url: string, method: "GET" | "POST" = "GET"): string {
  const said = `${error.code}: ${error.message}${error.requestId ? ` (request ${error.requestId})` : ""}`;
  if (error.status === 0) return `Could not reach ${url} (${error.message}). If the cloud moved: skillhook cloud login --url https://<its address>`;
  if (error.status === 401) return `${url} refused the API key (${said}). Log in with a valid one: skillhook cloud login --url ${url} --key -   (keys: Settings → API keys on that cloud's dashboard)`;
  // A read needs fleet:read; a tool the cloud refused names the scope it needs (and what the key has).
  if (error.status === 403 && method === "GET") return `The API key is not allowed to read this (${said}); it needs the fleet:read scope. Create a key with it under Settings → API keys, then: skillhook cloud login --key -`;
  if (error.status === 403) return `The API key is not allowed to do this (${said}). Reading needs the fleet:read scope, acting fleet:run, changing fleet:admin: create a key with the one it needs under Settings → API keys, then: skillhook cloud login`;
  return `${url}: ${said}`;
}

/** Machine names by id, for tables; ids stay ids when the list cannot be read. */
export async function machineNames(client: FleetClient): Promise<Map<string, string>> {
  try {
    const { data } = await client.get("/machines", MachineListSchema);
    return new Map(data.machines.map((m) => [m.id, m.name]));
  } catch {
    return new Map();
  }
}
