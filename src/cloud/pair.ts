// Pairing a machine with Skillhook Cloud (`skillhook cloud connect`) and undoing it (`cloud disconnect`): one request
// to the cloud, then the token into `.env` and the `cloud.*` keys into skillhook.json, `cloud.enabled` last.
import { hostname } from "node:os";
import { rmSync } from "node:fs";
import { updateConfig } from "../config.js";
import { ensureSecretFileMode, removeEnvVar, upsertEnvVar } from "../env.js";
import type { Paths } from "../paths.js";
import type { ServerState } from "../server.js";
import { nowIso } from "../util.js";
import { VERSION } from "../version.js";
import { CLOUD_API_KEY_ENV, CLOUD_PRIVATE_KEY_ENV, CLOUD_TOKEN_ENV } from "./config.js";
import { cloudRequest } from "./http.js";
import { cloudStateDir } from "./outbox.js";
import { PairResponseSchema, PROTOCOL_VERSION, type MachineInfo, type MachineMode, type PairRequest, type PairResponse } from "./protocol.js";

/** What a machine says about itself; `started_at` is the running server's when there is one. */
export function machineInfo(state?: Pick<ServerState, "started_at" | "public_url">, publicUrl?: string): Omit<MachineInfo, "id"> {
  const url = state?.public_url ?? publicUrl;
  return { hostname: hostname(), os: process.platform, arch: process.arch, skillhook_version: VERSION, node_version: process.versions.node, started_at: state?.started_at ?? nowIso(), ...(url ? { public_url: url } : {}) };
}

export interface PairInput {
  url: string;
  code?: string;
  token?: string;
  mode: MachineMode;
  machine: Omit<MachineInfo, "id">;
  previousMachineId?: string;
  publicKey?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/** `POST /api/agent/pair`: a pairing code (from the dashboard) or a token becomes a machine id and a machine token. */
export async function pairMachine(input: PairInput): Promise<PairResponse> {
  const request: PairRequest = {
    protocol_version: PROTOCOL_VERSION,
    ...(input.code ? { code: input.code.trim().toUpperCase() } : {}),
    ...(input.token ? { token: input.token } : {}),
    machine: { ...input.machine, ...(input.previousMachineId ? { previous_machine_id: input.previousMachineId } : {}) },
    requested_mode: input.mode,
    ...(input.publicKey ? { public_key: input.publicKey } : {}),
  };
  const response = await cloudRequest(input.url, "/api/agent/pair", { body: request, fetchImpl: input.fetchImpl, timeoutMs: input.timeoutMs ?? 20_000 });
  const parsed = PairResponseSchema.safeParse(response.body);
  if (!parsed.success) throw new Error(`the cloud answered pairing with something this version does not understand (protocol ${PROTOCOL_VERSION})`);
  return parsed.data;
}

export interface LinkCredentials {
  token: string;
  machineId: string;
  url: string;
  mode: MachineMode;
  /** The machine's X25519 private key (values the cloud seals to this machine open with it). */
  privateKey?: string;
}

/** Token first (in `.env`, mode 600), then the addressing keys, then `cloud.enabled: true`, so a crash in between never leaves an enabled link without a token. */
export function writeLinkCredentials(paths: Paths, credentials: LinkCredentials): void {
  upsertEnvVar(paths.envFile, CLOUD_TOKEN_ENV, credentials.token);
  if (credentials.privateKey) upsertEnvVar(paths.envFile, CLOUD_PRIVATE_KEY_ENV, credentials.privateKey);
  ensureSecretFileMode(paths.envFile);
  updateConfig(paths, { set: { "cloud.url": credentials.url, "cloud.machine_id": credentials.machineId, "cloud.mode": credentials.mode } });
  updateConfig(paths, { set: { "cloud.enabled": true } });
}

/** The reverse order: the link is disabled first; the spool is deleted; the token goes unless asked to keep it. */
export function clearLinkCredentials(paths: Paths, options: { keepToken?: boolean } = {}): void {
  updateConfig(paths, { set: { "cloud.enabled": false }, unset: ["cloud.machine_id"] });
  if (!options.keepToken) {
    removeEnvVar(paths.envFile, CLOUD_TOKEN_ENV);
    removeEnvVar(paths.envFile, CLOUD_PRIVATE_KEY_ENV);
  }
  rmSync(cloudStateDir(paths.jobsDir), { recursive: true, force: true });
}

export interface CloudStatusView {
  enabled: boolean;
  env_disabled: boolean;
  url: string;
  machine_id: string | null;
  mode: MachineMode;
  token_present: boolean;
  server_running: boolean;
  /** The running server's link state, when a server runs. */
  link: import("./link.js").LinkStatusView | null;
  /** Whether an organisation API key (`skillhook cloud login`) is kept here for the fleet commands and `skillhook mcp --cloud`; never the key. */
  api_key: { present: boolean; source: "environment" | "env_file" | null };
}

/** What `skillhook cloud status` and the MCP tool `cloud_status` report; never the token itself. */
export async function cloudStatus(paths: Paths, env: NodeJS.ProcessEnv): Promise<CloudStatusView> {
  const { loadConfig } = await import("../config.js");
  const { readEnvFile } = await import("../env.js");
  const { findRunningServer } = await import("../client.js");
  const { cloudDisabledByEnv, resolveCloudUrl } = await import("./config.js");
  const config = loadConfig(paths);
  const running = await findRunningServer(paths);
  const file = readEnvFile(paths.envFile);
  const apiKeySource = env[CLOUD_API_KEY_ENV]?.trim() ? "environment" : file[CLOUD_API_KEY_ENV] ? "env_file" : null;
  return { enabled: config.cloud.enabled, env_disabled: cloudDisabledByEnv(env), url: resolveCloudUrl(env, config.cloud), machine_id: config.cloud.machine_id ?? null, mode: config.cloud.mode, token_present: Boolean(file[CLOUD_TOKEN_ENV]), server_running: Boolean(running), link: running?.health.cloud ?? null, api_key: { present: apiKeySource !== null, source: apiKeySource } };
}

/** `skillhook cloud disconnect` / MCP `cloud_disconnect`: revoke (best effort), clear the local pairing, tell a running server. */
export async function disconnectCloud(paths: Paths, env: NodeJS.ProcessEnv, options: { keepToken?: boolean; notify?: (baseUrl: string) => Promise<void> } = {}): Promise<{ url: string; was_enabled: boolean; token_removed: boolean; revoked: boolean }> {
  const { loadConfig } = await import("../config.js");
  const { readEnvFile } = await import("../env.js");
  const { findRunningServer } = await import("../client.js");
  const { resolveCloudUrl } = await import("./config.js");
  const config = loadConfig(paths);
  const token = readEnvFile(paths.envFile)[CLOUD_TOKEN_ENV];
  const url = resolveCloudUrl(env, config.cloud);
  let revoked = false;
  if (token && !options.keepToken) revoked = await revokeToken(url, token);
  clearLinkCredentials(paths, { keepToken: options.keepToken });
  const running = await findRunningServer(paths);
  if (running && options.notify) await options.notify(running.baseUrl);
  return { url, was_enabled: config.cloud.enabled, token_removed: Boolean(token) && !options.keepToken, revoked };
}

/** Tells the cloud the token is no longer used. Best effort: never throws. */
export async function revokeToken(url: string, token: string, fetchImpl?: typeof fetch): Promise<boolean> {
  try {
    await cloudRequest(url, "/api/agent/disconnect", { token, body: {}, fetchImpl, timeoutMs: 10_000 });
    return true;
  } catch {
    return false;
  }
}
