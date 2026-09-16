import { readEnvFile, redactValue, removeEnvVar } from "../env.js";
import { createOps, generateSecretFor, resolveSecretName, setSecret } from "../ops.js";
import { bool, CommandError, num, str, table, UsageError, type Ctx } from "./shared.js";

const USAGE = `Usage:
  skillhook secret set <NAME|skill|admin> [--value VALUE | --stdin]   store a provider's signing secret
  skillhook secret generate <NAME|skill|admin> [--force] [--bytes N]  create a random secret (printed once)
  skillhook secret list
  skillhook secret unset <NAME>

<NAME> is an ENV_VAR_NAME, a skill name (resolves to its secret_env) or "admin" (the admin API token).`;

export async function secretCommand(ctx: Ctx): Promise<number> {
  const [sub = "list", name] = ctx.args;
  const ops = createOps(ctx.paths, { env: ctx.io.env });
  switch (sub) {
    case "list":
    case "ls": {
      const vars = readEnvFile(ctx.paths.envFile);
      const rows = Object.entries(vars).map(([k, v]) => [k, redactValue(v)]);
      ctx.print(rows.length ? `${table(rows, ["name", "value"])}\n\n(${ctx.paths.envFile})` : `No secrets in ${ctx.paths.envFile}`, { file: ctx.paths.envFile, names: Object.keys(vars) });
      return 0;
    }
    case "set": {
      if (!name) throw new UsageError("Missing name", USAGE);
      let value = str(ctx.flags, "value");
      if (value === undefined) {
        if (bool(ctx.flags, "stdin") || !ctx.io.isTTY) value = (ctx.io.stdin ? await ctx.io.stdin() : (await import("node:fs")).readFileSync(0, "utf8")).replace(/\r?\n$/, "");
        else value = await promptHidden(`Value for ${resolveSecretName(ops, name).env}: `);
      }
      if (!value) throw new CommandError("Refusing to store an empty secret");
      const { env } = setSecret(ops, name, value);
      ctx.print(`Stored ${env} in ${ctx.paths.envFile}`, { ok: true, env });
      return 0;
    }
    case "generate":
    case "gen":
    case "rotate": {
      if (!name) throw new UsageError("Missing name", USAGE);
      const result = generateSecretFor(ops, name, { force: bool(ctx.flags, "force") || sub === "rotate", bytes: num(ctx.flags, "bytes") });
      if (!result.generated) {
        ctx.print(`${result.env} already exists; pass --force to replace it.`, { ok: true, env: result.env, existed: true });
        return 0;
      }
      ctx.print(`${result.env}=${result.generated}\n\nStored in ${ctx.paths.envFile} (shown once). Configure the sender with this value.`, { ok: true, env: result.env, secret: result.generated, replaced: result.existed });
      return 0;
    }
    case "unset":
    case "rm":
    case "remove": {
      if (!name) throw new UsageError("Missing name", USAGE);
      const { env } = resolveSecretName(ops, name);
      const removed = removeEnvVar(ctx.paths.envFile, env);
      ctx.print(removed ? `Removed ${env}` : `${env} was not set`, { ok: true, env, removed });
      return 0;
    }
    default:
      throw new UsageError(`Unknown secret subcommand "${sub}"`, USAGE);
  }
}

async function promptHidden(question: string): Promise<string> {
  const readline = await import("node:readline");
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr, terminal: true });
    process.stderr.write(question);
    // Suppress echo so the secret never shows on screen or in scrollback.
    (rl as unknown as { _writeToOutput: (text: string) => void })._writeToOutput = () => {};
    rl.question("", (answer) => {
      rl.close();
      process.stderr.write("\n");
      resolve(answer.trim());
    });
  });
}
