import { existsSync, readFileSync, statSync } from "node:fs";
import { spawn } from "node:child_process";
import { adminRequest, findRunningServer } from "../client.js";
import { isTerminal, JOB_STATUSES, type JobArtifact, type JobStatus } from "../jobs.js";
import { publicJob } from "../server.js";
import { sleep } from "../util.js";
import { bool, CommandError, formatDuration, num, relativeTime, str, table, UsageError, type Ctx } from "./shared.js";

const USAGE = `Usage:
  skillhook jobs list [--skill NAME] [--status ${JOB_STATUSES.join("|")}] [--limit N]
  skillhook jobs show <id> [--result] [--prompt] [--stdout] [--stderr]
  skillhook jobs logs <id> [--follow|-f] [--stderr]
  skillhook jobs cancel <id>
  skillhook jobs resume <id> [--exec]      print (or run) the command that reopens the agent session
  skillhook jobs path <id>
  skillhook jobs prune [--keep N]`;

export async function jobsCommand(ctx: Ctx): Promise<number> {
  const [sub = "list", id] = ctx.args;
  const store = ctx.store();
  switch (sub) {
    case "list":
    case "ls": {
      const status = str(ctx.flags, "status") as JobStatus | undefined;
      if (status && !JOB_STATUSES.includes(status)) throw new UsageError(`--status must be one of ${JOB_STATUSES.join(", ")}`, USAGE);
      const jobs = store.list({ skill: str(ctx.flags, "skill"), status, limit: num(ctx.flags, "limit") ?? 30 });
      const rows = jobs.map((j) => [j.id, j.skill, j.status, j.runner + (j.model ? `/${j.model}` : ""), formatDuration(j.duration_ms), relativeTime(j.created_at), (j.error ?? j.result ?? "").split("\n")[0]?.slice(0, 60) ?? ""]);
      ctx.print(rows.length ? table(rows, ["job", "skill", "status", "runner", "took", "when", "summary"]) : `No jobs in ${store.jobsDir}`, { jobs: jobs.map(publicJob) });
      return 0;
    }
    case "show":
    case "get": {
      const job = store.get(requireId(id));
      if (!job) throw new CommandError(`Unknown job ${id}`);
      const wanted: JobArtifact[] = (["result", "prompt", "stdout", "stderr"] as const).filter((a) => bool(ctx.flags, a));
      const artifacts: Record<string, string | undefined> = {};
      for (const a of wanted) artifacts[a] = store.readArtifact(job.id, a);
      const lines = [
        `${job.id}  ${job.skill}  ${job.status}`,
        `  runner:   ${job.runner}${job.model ? ` (${job.model})` : ""}${job.effort ? ` effort=${job.effort}` : ""}`,
        `  trigger:  ${job.trigger} from ${job.source.ip}${job.source.user_agent ? ` (${job.source.user_agent})` : ""}`,
        `  created:  ${job.created_at}${job.duration_ms !== undefined ? `  took ${formatDuration(job.duration_ms)}` : ""}`,
        ...(job.cwd ? [`  cwd:      ${job.cwd}`] : []),
        ...(job.cost_usd !== undefined ? [`  cost:     $${job.cost_usd.toFixed(4)}`] : []),
        ...(job.session_id ? [`  session:  ${job.session_id}`] : []),
        ...(job.resume_command ? [`  resume:   ${job.resume_command}`] : []),
        ...(job.error ? [`  error:    ${job.error}`] : []),
        `  dir:      ${store.pathsFor(job.id).dir}`,
        ...(job.result && !wanted.includes("result") ? ["", "result:", job.result] : []),
        ...wanted.flatMap((a) => ["", `--- ${a} ---`, artifacts[a] ?? "(missing)"]),
      ];
      ctx.print(lines.join("\n"), { job, dir: store.pathsFor(job.id).dir, artifacts });
      return 0;
    }
    case "logs":
    case "log":
    case "tail": {
      const job = store.get(requireId(id));
      if (!job) throw new CommandError(`Unknown job ${id}`);
      const file = bool(ctx.flags, "stderr") ? store.pathsFor(job.id).stderr : store.pathsFor(job.id).stdout;
      const follow = bool(ctx.flags, "follow", "f");
      let offset = 0;
      const emit = () => {
        if (!existsSync(file)) return;
        const size = statSync(file).size;
        if (size > offset) {
          const text = readFileSync(file, "utf8").slice(offset);
          offset = size;
          ctx.io.stdout(text.endsWith("\n") ? text : `${text}\n`);
        }
      };
      emit();
      if (follow) {
        while (true) {
          const current = store.get(job.id);
          if (!current) break;
          await sleep(500);
          emit();
          if (isTerminal(current.status)) {
            emit();
            ctx.warn(`— job ${current.status}${current.error ? `: ${current.error}` : ""}`);
            break;
          }
        }
      }
      return 0;
    }
    case "cancel":
    case "stop": {
      const job = store.get(requireId(id));
      if (!job) throw new CommandError(`Unknown job ${id}`);
      if (isTerminal(job.status)) {
        ctx.print(`Job ${job.id} is already ${job.status}`, { ok: false, job });
        return 1;
      }
      const running = await findRunningServer(ctx.paths);
      if (!running) throw new CommandError("No running server owns this job (it may belong to a `skillhook run` process). Kill that process instead.");
      const response = await adminRequest<{ ok: boolean; status?: string }>(running.baseUrl, ctx.secrets(), `/jobs/${job.id}/cancel`, { method: "POST" });
      ctx.print(response.body.ok ? `Cancelling ${job.id}` : `Could not cancel ${job.id}: ${JSON.stringify(response.body)}`, { ...response.body, http_status: response.status });
      return response.body.ok ? 0 : 1;
    }
    case "resume": {
      const job = store.get(requireId(id));
      if (!job) throw new CommandError(`Unknown job ${id}`);
      if (!job.resume_command) throw new CommandError(`Job ${job.id} has no resumable session (runner ${job.runner}, status ${job.status})`);
      if (bool(ctx.flags, "exec")) {
        const child = spawn(job.resume_command, { shell: true, stdio: "inherit" });
        return await new Promise<number>((resolve) => child.on("close", (code) => resolve(code ?? 0)));
      }
      ctx.print(job.resume_command, { job_id: job.id, resume_command: job.resume_command, session_id: job.session_id, cwd: job.cwd });
      return 0;
    }
    case "path":
    case "dir": {
      const job = store.get(requireId(id));
      if (!job) throw new CommandError(`Unknown job ${id}`);
      ctx.print(store.pathsFor(job.id).dir, store.pathsFor(job.id));
      return 0;
    }
    case "prune": {
      const removed = store.prune(num(ctx.flags, "keep") ?? ctx.config().jobs.max_jobs);
      ctx.print(`Removed ${removed} old job(s)`, { ok: true, removed });
      return 0;
    }
    default:
      throw new UsageError(`Unknown jobs subcommand "${sub}"`, USAGE);
  }
}

function requireId(id: string | undefined): string {
  if (!id) throw new UsageError("Missing job id", USAGE);
  return id;
}
