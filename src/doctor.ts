// `skillhook doctor`: the quick flavour of the health report (src/health.ts), printed flat. Kept as its own module so
// the CLI, the MCP `doctor` tool and the setup skill keep their entry point; the checks live in health.ts.
import type { Secrets } from "./env.js";
import { formatUptime, macSleepMinutes, runHealth, type Check, type CheckStatus, type HealthOptions, type HealthReport } from "./health.js";
import type { Paths } from "./paths.js";
import type { Skill } from "./skills.js";

export type { Check, CheckStatus } from "./health.js";
export { macSleepMinutes, formatUptime };

export type DoctorReport = HealthReport;

export interface DoctorOptions {
  /** Environment consulted for the update check (`SKILLHOOK_NO_UPDATE_CHECK`, `CI`, `SKILLHOOK_NPM_REGISTRY`). */
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  /** Ask the npm registry and probe the public URL (default true). */
  network?: boolean;
  live?: HealthOptions["live"];
}

/** Everything but the slow probes: no MCP server listing, no plugins, no `codex doctor`, no last runs. */
export async function runDoctor(paths: Paths, options: DoctorOptions = {}): Promise<DoctorReport> {
  return runHealth(paths, { env: options.env, fetchImpl: options.fetchImpl, deep: false, network: options.network ?? true, live: options.live });
}

export function formatDoctor(report: DoctorReport): string {
  const icon: Record<CheckStatus, string> = { ok: "✓", warn: "!", fail: "✗", skip: "-" };
  const lines = report.checks.map((c) => `${icon[c.status]} ${c.name.padEnd(22)} ${c.detail}${c.hint ? `\n    → ${c.hint}` : ""}`);
  lines.push("", `${report.summary.ok} ok, ${report.summary.warn} warnings, ${report.summary.fail} failures`);
  if (report.public_url) lines.push(`public URL: ${report.public_url}`);
  return lines.join("\n");
}

export function skillsNeedingSecrets(skills: Skill[], secrets: Secrets): Skill[] {
  return skills.filter((s) => s.auth.type !== "none" && !secrets[s.auth.secret_env]);
}
