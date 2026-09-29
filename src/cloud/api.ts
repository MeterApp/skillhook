// The organisation's fleet from the CLI (`skillhook cloud login|machines|jobs|job`): Skillhook Cloud's public API
// (`/api/v1`) with an organisation API key (`shc_…`, Settings → API keys on the dashboard), never the machine token, so
// a paired machine cannot read the rest of its organisation; only a person holding a key can. Requests go to the
// machine's cloud URL over HTTPS, only when a person runs one of these commands. The answers are the cloud's own
// records, parsed loosely: a newer cloud may say more.
import { z } from "zod";
import { readEnvFile } from "../env.js";
import type { Paths } from "../paths.js";
import { CLOUD_API_KEY_ENV, cloudDisabledByEnv, DEFAULT_CLOUD_URL, InsecureCloudUrlError, isSecureCloudUrl, resolveCloudUrl } from "./config.js";
import { CloudHttpError, cloudRequest } from "./http.js";

/** What an organisation API key looks like; machine tokens (`shm_…`) never do. One line, so it can only ever travel as a header. */
export const API_KEY_RE = /^shc_[A-Za-z0-9_-]+$/;

export class CloudApiError extends Error {
  constructor(message: string) {
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

/** `SKILLHOOK_CLOUD_API_KEY` from the environment (CI), else from `.env`. */
export function storedApiKey(paths: Paths, env: NodeJS.ProcessEnv): string | undefined {
  return env[CLOUD_API_KEY_ENV]?.trim() || readEnvFile(paths.envFile)[CLOUD_API_KEY_ENV] || undefined;
}

export interface FleetClient {
  /** The cloud the requests go to. */
  url: string;
  /** `GET /api/v1<path>`: the parsed answer and the answer as the cloud sent it (what `--json` prints). */
  get<T>(path: string, schema: z.ZodType<T>): Promise<{ data: T; raw: unknown }>;
}

/** A client for the machine's cloud with `key`; refused under `SKILLHOOK_NO_CLOUD`, without a well-formed key, to the placeholder URL, or to a URL that is not https. */
export function fleetClient(env: NodeJS.ProcessEnv, cloud: { url?: string }, key: string | undefined, options: { fetchImpl?: typeof fetch } = {}): FleetClient {
  if (cloudDisabledByEnv(env)) throw new CloudApiError("SKILLHOOK_NO_CLOUD is set: nothing goes to Skillhook Cloud from this environment. Unset it to read the fleet.");
  if (!key) throw new CloudApiError(`No organisation API key. Create one on the dashboard (Settings → API keys; fleet:read is enough), then: skillhook cloud login --key -   (or set ${CLOUD_API_KEY_ENV})`);
  if (!API_KEY_RE.test(key)) throw new CloudApiError(`${CLOUD_API_KEY_ENV} does not hold an organisation API key (shc_ followed by letters, digits, - and _); run: skillhook cloud login --key -`);
  const url = resolveCloudUrl(env, cloud);
  // While the built-in URL is a placeholder (src/cloud/config.ts), a key only goes to a cloud someone named.
  if (url === DEFAULT_CLOUD_URL) throw new CloudApiError("This machine has no cloud URL, and an API key only goes to a cloud you named: skillhook config set cloud.url https://…   (pairing sets it; SKILLHOOK_CLOUD_URL works too)");
  if (!isSecureCloudUrl(url, env)) throw new CloudApiError(new InsecureCloudUrlError(url).message);
  return {
    url,
    async get(path, schema) {
      let response;
      try {
        response = await cloudRequest(url, `/api/v1${path}`, { method: "GET", token: key, fetchImpl: options.fetchImpl, timeoutMs: 20_000 });
      } catch (error) {
        if (error instanceof CloudHttpError) throw new CloudApiError(describeApiFailure(error, url));
        throw error;
      }
      const parsed = schema.safeParse(response.body);
      if (!parsed.success) throw new CloudApiError(`${url} answered GET /api/v1${path} with something this version does not understand`);
      return { data: parsed.data, raw: response.body };
    },
  };
}

/** A refused key says to log in again, a missing scope says which, an unreachable cloud where it was looked for. */
export function describeApiFailure(error: CloudHttpError, url: string): string {
  const said = `${error.code}: ${error.message}${error.requestId ? ` (request ${error.requestId})` : ""}`;
  if (error.status === 0) return `Could not reach ${url} (${error.message}); the machine's cloud URL is cloud.url or SKILLHOOK_CLOUD_URL (skillhook config set cloud.url https://…)`;
  if (error.status === 401) return `${url} refused the API key (${said}). Log in with a valid one: skillhook cloud login --key -   (keys: Settings → API keys on the dashboard)`;
  if (error.status === 403) return `The API key is not allowed to read this (${said}); it needs the fleet:read scope. Create a key with it under Settings → API keys, then: skillhook cloud login --key -`;
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
