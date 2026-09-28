import { adminRequest, findRunningServer, readServerState } from "../client.js";
import { assertSecureCloudUrl, CLOUD_TOKEN_ENV, cloudDisabledByEnv, resolveCloudUrl } from "../cloud/config.js";
import { CloudHttpError } from "../cloud/http.js";
import { clearLinkCredentials, machineInfo, pairMachine, revokeToken, writeLinkCredentials } from "../cloud/pair.js";
import { readEnvFile } from "../env.js";
import { bool, CommandError, str, UsageError, type Ctx } from "./shared.js";

const USAGE = `Usage:
  skillhook cloud connect --code XXXX-XXXX [--url URL] [--control|--observe] [--force]   pair this machine with Skillhook Cloud (the dashboard shows the code)
  skillhook cloud connect --token TOKEN [--url URL] [--control|--observe] [--force]      pair with a machine token instead
  skillhook cloud disconnect [--keep-token]                                              stop the link, forget the pairing, revoke the token
  skillhook cloud status`;

/** The running server re-reads skillhook.json now (it would notice within a few seconds anyway). */
async function notifyReload(ctx: Ctx, baseUrl: string): Promise<void> {
  try {
    await adminRequest(baseUrl, ctx.secrets(), "/config/reload", { method: "POST", timeoutMs: 5_000 });
  } catch {
    /* the file watcher picks it up */
  }
}

export async function cloudCommand(ctx: Ctx): Promise<number> {
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
      let response;
      try {
        response = await pairMachine({ url, code, token, mode, machine: machineInfo(state, config.public_url), previousMachineId: config.cloud.machine_id });
      } catch (error) {
        if (error instanceof CloudHttpError) throw new CommandError(`Pairing with ${url} failed: ${error.code}: ${error.message}`);
        throw error;
      }
      writeLinkCredentials(ctx.paths, { token: response.machine_token, machineId: response.machine_id, url, mode: response.mode });
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
      const token = readEnvFile(ctx.paths.envFile)[CLOUD_TOKEN_ENV];
      const url = resolveCloudUrl(env, config.cloud);
      const wasEnabled = config.cloud.enabled;
      let revoked = false;
      if (token && !keepToken) revoked = await revokeToken(url, token);
      clearLinkCredentials(ctx.paths, { keepToken });
      const running = await findRunningServer(ctx.paths);
      if (running) await notifyReload(ctx, running.baseUrl);
      ctx.print(`${wasEnabled ? "Disconnected from" : "Not connected to"} ${url}.${token && !keepToken ? revoked ? " Token revoked." : " The cloud could not be told; the token was removed here." : keepToken ? " Token kept in .env." : ""} The running server stops the link within a few seconds.`, { ok: true, url, was_enabled: wasEnabled, token_removed: Boolean(token) && !keepToken, revoked });
      return 0;
    }
    case "status": {
      const token = Boolean(readEnvFile(ctx.paths.envFile)[CLOUD_TOKEN_ENV]);
      const url = resolveCloudUrl(env, config.cloud);
      const running = await findRunningServer(ctx.paths);
      const link = running?.health.cloud ?? null;
      const data = { enabled: config.cloud.enabled, env_disabled: cloudDisabledByEnv(env), url, machine_id: config.cloud.machine_id ?? null, mode: config.cloud.mode, token_present: token, server_running: Boolean(running), link };
      const lines = [
        `${config.cloud.enabled ? "enabled" : "not connected"} · ${url}${config.cloud.machine_id ? ` · machine ${config.cloud.machine_id}` : ""} · mode ${config.cloud.mode} · token ${token ? "present" : "missing"}${cloudDisabledByEnv(env) ? " · SKILLHOOK_NO_CLOUD set" : ""}`,
        ...(link ? [`link: ${link.state}${link.reason ? ` (${link.reason})` : ""}${link.last_sync_at ? `, last sync ${link.last_sync_at}` : ""}${link.outbox_depth ? `, ${link.outbox_depth} event(s) waiting` : ""}${link.last_error ? `, last error: ${link.last_error}` : ""}`] : running ? ["link: the running server reports no link state"] : ["link: no running server"]),
        ...(Object.keys(link?.ingress_urls ?? {}).length ? [`hosted URLs: ${Object.entries(link?.ingress_urls ?? {}).map(([skill, u]) => `${skill} ${u}`).join(", ")}`] : []),
      ];
      ctx.print(lines.join("\n"), data);
      return 0;
    }
    default:
      throw new UsageError(`Unknown cloud subcommand "${sub}"`, USAGE);
  }
}
