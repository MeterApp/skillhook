import { formatDoctor, runDoctor } from "../doctor.js";
import type { Ctx } from "./shared.js";

export const DOCTOR_USAGE = `Usage: skillhook doctor

Checks Node, disk, the config, secrets, skills, the claude/codex logins, Tailscale, the public URL, the server and the
service, with what to do about each problem. Exits 1 when a check fails; skillhook health adds the deep probes.`;

export async function doctorCommand(ctx: Ctx): Promise<number> {
  const report = await runDoctor(ctx.paths, { env: ctx.io.env });
  ctx.print(formatDoctor(report), report);
  return report.ok ? 0 : 1;
}
