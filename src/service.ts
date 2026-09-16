import { existsSync, mkdirSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Paths } from "./paths.js";
import { mergedPath } from "./runners/env.js";
import { run } from "./tailscale.js";
import { sleep } from "./util.js";

export const SERVICE_LABEL = "co.meterapp.skillhook";

/** Absolute path to the compiled CLI (`dist/cli.js`), which services must point at. */
export function cliEntrypoint(): { path: string; exists: boolean } {
  const here = fileURLToPath(import.meta.url); // dist/service.js or src/service.ts
  const root = path.resolve(path.dirname(here), "..");
  const candidate = path.join(root, "dist", "cli.js");
  return { path: candidate, exists: existsSync(candidate) };
}

export interface ServiceSpec {
  label: string;
  node: string;
  cli: string;
  home: string;
  logFile: string;
  pathVar: string;
  user: string;
}

export function serviceSpec(paths: Paths, label = SERVICE_LABEL): ServiceSpec {
  const cli = cliEntrypoint();
  return {
    label,
    node: stableNodePath(),
    cli: cli.path,
    home: paths.home,
    logFile: path.join(paths.logsDir, "service.log"),
    pathVar: mergedPath(process.env.PATH),
    user: userInfo().username,
  };
}

function xml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function renderLaunchdPlist(spec: ServiceSpec): string {
  const args = [spec.node, spec.cli, "serve", "--dir", spec.home];
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xml(spec.label)}</string>
  <key>ProgramArguments</key>
  <array>
${args.map((a) => `    <string>${xml(a)}</string>`).join("\n")}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${xml(spec.pathVar)}</string>
    <key>HOME</key>
    <string>${xml(homedir())}</string>
    <key>SKILLHOOK_HOME</key>
    <string>${xml(spec.home)}</string>
    <key>LANG</key>
    <string>en_US.UTF-8</string>
  </dict>
  <key>WorkingDirectory</key>
  <string>${xml(spec.home)}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>5</integer>
  <key>StandardOutPath</key>
  <string>${xml(spec.logFile)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(spec.logFile)}</string>
</dict>
</plist>
`;
}

export function renderSystemdUnit(spec: ServiceSpec): string {
  return `[Unit]
Description=skillhook - webhook-triggered agent skills
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=${spec.node} ${spec.cli} serve --dir ${spec.home}
WorkingDirectory=${spec.home}
Restart=always
RestartSec=5
Environment=PATH=${spec.pathVar}
Environment=HOME=${homedir()}
Environment=SKILLHOOK_HOME=${spec.home}
StandardOutput=append:${spec.logFile}
StandardError=append:${spec.logFile}

[Install]
WantedBy=default.target
`;
}

export function launchdPlistPath(label = SERVICE_LABEL): string {
  return path.join(homedir(), "Library", "LaunchAgents", `${label}.plist`);
}

export function systemdUnitPath(label = SERVICE_LABEL): string {
  return path.join(process.env.XDG_CONFIG_HOME ?? path.join(homedir(), ".config"), "systemd", "user", `${label}.service`);
}

export interface ServiceStatus {
  platform: "launchd" | "systemd" | "unsupported";
  installed: boolean;
  running: boolean;
  pid?: number;
  file: string;
  detail?: string;
  logFile: string;
}

function uid(): number {
  return typeof process.getuid === "function" ? process.getuid() : 0;
}

export async function installService(paths: Paths, label = SERVICE_LABEL): Promise<{ ok: boolean; file: string; output: string }> {
  const spec = serviceSpec(paths, label);
  const cli = cliEntrypoint();
  if (!cli.exists) return { ok: false, file: cli.path, output: `Compiled CLI not found at ${cli.path}. Run \`npm run build\` (or install skillhook from npm) before installing the service.` };
  mkdirSync(paths.logsDir, { recursive: true });
  if (process.platform === "darwin") {
    const file = launchdPlistPath(label);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, renderLaunchdPlist(spec), { mode: 0o644 });
    const domain = `gui/${uid()}`;
    const target = `${domain}/${label}`;
    await run("launchctl", ["bootout", target]); // ignore failure: not loaded yet
    // launchd tears the old instance down asynchronously; bootstrap fails with "Input/output error" while it is still registered.
    for (let i = 0; i < 40 && (await run("launchctl", ["print", target])).code === 0; i++) await sleep(250);
    let bootstrap = await run("launchctl", ["bootstrap", domain, file]);
    for (let attempt = 0; bootstrap.code !== 0 && attempt < 5; attempt++) {
      await sleep(1000);
      bootstrap = await run("launchctl", ["bootstrap", domain, file]);
    }
    if (bootstrap.code !== 0) return { ok: false, file, output: `${bootstrap.stdout}${bootstrap.stderr}`.trim() || `launchctl bootstrap exited with ${bootstrap.code}` };
    const kick = await run("launchctl", ["kickstart", "-k", `${domain}/${label}`]);
    return { ok: true, file, output: `${bootstrap.stdout}${kick.stdout}${kick.stderr}`.trim() };
  }
  if (process.platform === "linux") {
    const file = systemdUnitPath(label);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, renderSystemdUnit(spec), { mode: 0o644 });
    const reload = await run("systemctl", ["--user", "daemon-reload"]);
    const enable = await run("systemctl", ["--user", "enable", "--now", label]);
    const output = `${reload.stderr}${enable.stdout}${enable.stderr}`.trim();
    return { ok: enable.code === 0, file, output: enable.code === 0 ? `${output}\nTip: run \`loginctl enable-linger ${spec.user}\` so the service starts without a login session.`.trim() : output };
  }
  return { ok: false, file: "", output: `Unsupported platform ${process.platform}; run \`skillhook serve\` under your own supervisor.` };
}

export async function uninstallService(label = SERVICE_LABEL): Promise<{ ok: boolean; output: string }> {
  if (process.platform === "darwin") {
    const file = launchdPlistPath(label);
    const result = await run("launchctl", ["bootout", `gui/${uid()}/${label}`]);
    if (existsSync(file)) unlinkSync(file);
    return { ok: true, output: `${result.stdout}${result.stderr}`.trim() };
  }
  if (process.platform === "linux") {
    const file = systemdUnitPath(label);
    const result = await run("systemctl", ["--user", "disable", "--now", label]);
    if (existsSync(file)) unlinkSync(file);
    await run("systemctl", ["--user", "daemon-reload"]);
    return { ok: true, output: `${result.stdout}${result.stderr}`.trim() };
  }
  return { ok: false, output: `Unsupported platform ${process.platform}` };
}

export async function restartService(label = SERVICE_LABEL): Promise<{ ok: boolean; output: string }> {
  if (process.platform === "darwin") {
    const result = await run("launchctl", ["kickstart", "-k", `gui/${uid()}/${label}`]);
    return { ok: result.code === 0, output: `${result.stdout}${result.stderr}`.trim() };
  }
  if (process.platform === "linux") {
    const result = await run("systemctl", ["--user", "restart", label]);
    return { ok: result.code === 0, output: `${result.stdout}${result.stderr}`.trim() };
  }
  return { ok: false, output: `Unsupported platform ${process.platform}` };
}

export async function serviceStatus(paths: Paths, label = SERVICE_LABEL): Promise<ServiceStatus> {
  const logFile = path.join(paths.logsDir, "service.log");
  if (process.platform === "darwin") {
    const file = launchdPlistPath(label);
    const installed = existsSync(file);
    const result = await run("launchctl", ["print", `gui/${uid()}/${label}`]);
    const running = result.code === 0 && /state = running/.test(result.stdout);
    const pid = Number(/pid = (\d+)/.exec(result.stdout)?.[1]) || undefined;
    return { platform: "launchd", installed, running, pid, file, logFile, detail: result.code === 0 ? undefined : "not loaded" };
  }
  if (process.platform === "linux") {
    const file = systemdUnitPath(label);
    const installed = existsSync(file);
    const result = await run("systemctl", ["--user", "is-active", label]);
    const pidResult = await run("systemctl", ["--user", "show", "-p", "MainPID", "--value", label]);
    return { platform: "systemd", installed, running: result.stdout.trim() === "active", pid: Number(pidResult.stdout.trim()) || undefined, file, logFile, detail: result.stdout.trim() };
  }
  return { platform: "unsupported", installed: false, running: false, file: "", logFile };
}

export function readServiceLog(paths: Paths, lines = 100): string {
  const file = path.join(paths.logsDir, "service.log");
  if (!existsSync(file)) return "";
  const text = readFileSync(file, "utf8");
  return text.split("\n").slice(-lines).join("\n");
}

/**
 * The node binary the service should run. Homebrew's `Cellar/node/<version>/bin/node` breaks on
 * every `brew upgrade node`, so prefer the stable `/opt/homebrew/bin/node` (or `/usr/local/bin/node`)
 * symlink when it resolves to the same binary.
 */
export function stableNodePath(execPath = process.execPath): string {
  if (!/\/Cellar\/node(@\d+)?\//.test(execPath)) return execPath;
  for (const candidate of ["/opt/homebrew/bin/node", "/usr/local/bin/node"]) {
    try {
      if (realpathSync(candidate) === realpathSync(execPath)) return candidate;
    } catch {
      /* candidate absent */
    }
  }
  return execPath;
}
