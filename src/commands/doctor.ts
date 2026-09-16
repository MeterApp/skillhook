import { formatDoctor, runDoctor } from "../doctor.js";
import type { Ctx } from "./shared.js";

export async function doctorCommand(ctx: Ctx): Promise<number> {
  const report = await runDoctor(ctx.paths);
  ctx.print(formatDoctor(report), report);
  return report.ok ? 0 : 1;
}
