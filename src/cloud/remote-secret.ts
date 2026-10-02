// A secret generated on another machine of the organisation and opened only here (`skillhook cloud secret`, the
// `generate_secret` tool of `skillhook mcp --cloud`): a key pair made for this one request, the machine seals the value
// to its public half (`secret.generate`), the cloud keeps the sealed value for two minutes and hands it to this API key
// once (`POST /api/v1/commands/<id>/claim`). Only this process holds the private half, so the value never travels or
// rests in the clear, not even in the cloud.
import { z } from "zod";
import { defaultSecretEnvFor, isSkillhookCredential } from "../env.js";
import { CloudApiError, type FleetClient } from "./api.js";
import { machineKeyPair, openSealed } from "./seal.js";
import { callTool } from "./tools.js";

/** The variable a skill's secret lives in on its machine: `SKILLHOOK_SECRET_<NAME>`. */
export const SECRET_ENV_RE = /^[A-Z_][A-Z0-9_]{0,99}$/;

const RequestedSchema = z.object({ command_id: z.string().min(1), machine: z.string().nullish() }).loose();
const ClaimSchema = z
  .object({
    state: z.enum(["pending", "sealed", "exists", "claimed", "expired", "failed"]),
    sealed: z.object({ ephemeral_public_key: z.string(), nonce: z.string(), ciphertext: z.string() }).loose().nullish(),
    error: z.string().nullish(),
  })
  .loose();

type SkillSecret = { name?: string; secret_env?: string | null };

/** Skills' own secrets look like this; any other variable must be one a skill on the machine names as its secret. */
const SKILL_SECRET_PREFIX = "SKILLHOOK_SECRET_";

function ownCredential(name: string, machine: string): CloudApiError {
  return new CloudApiError(`${name} is ${machine}'s own credential, not a skill's secret: it is never generated from here`);
}

/**
 * The variable to generate: the secret of the machine's skill named `given` (as the machine reports it), or `given`
 * itself when it is a skill's secret (`SKILLHOOK_SECRET_*`, or a variable a skill there names). Never another variable
 * of the machine (its admin token, the cloud link's, a runner's API key): those are set on the machine itself.
 */
export async function secretNameFor(client: FleetClient, machine: string, given: string): Promise<string> {
  if (isSkillhookCredential(given)) throw ownCredential(given, machine);
  if (SECRET_ENV_RE.test(given) && given.startsWith(SKILL_SECRET_PREFIX)) return given;
  const { skills } = (await callTool(client, "list_skills", { machine })) as { skills?: SkillSecret[] };
  if (SECRET_ENV_RE.test(given)) {
    if (skills?.some((s) => s.secret_env === given)) return given;
    throw new CloudApiError(`${given} is not a skill's secret on ${machine}: name the skill (or its SKILLHOOK_SECRET_… variable); other variables are set on the machine itself (skillhook secret set)`);
  }
  // A skill saved a moment ago is in no snapshot yet: the machine itself describes it.
  const skill = skills?.find((s) => s.name === given) ?? ((await callTool(client, "get_skill", { machine, skill: given })) as { skill?: SkillSecret | null }).skill;
  if (!skill) throw new CloudApiError(`${machine} has no skill named ${given} (skillhook cloud list_skills --machine ${machine} lists them)`);
  const name = skill.secret_env ?? defaultSecretEnvFor(given);
  // An older machine may still have a skill that names one of its own credentials as its secret.
  if (isSkillhookCredential(name)) throw ownCredential(name, machine);
  return name;
}

export interface RemoteSecret {
  machine: string;
  name: string;
  /** The value, shown once; null when the machine kept the secret it already had (`force` replaces it). */
  secret: string | null;
  existed: boolean;
}

export async function generateRemoteSecret(client: FleetClient, input: { machine: string; name: string; force?: boolean }, options: { timeoutMs?: number; pollMs?: number } = {}): Promise<RemoteSecret> {
  if (!SECRET_ENV_RE.test(input.name)) throw new CloudApiError(`${input.name} is not a secret's variable name (like SKILLHOOK_SECRET_HELLO)`);
  if (isSkillhookCredential(input.name)) throw ownCredential(input.name, input.machine);
  const keys = machineKeyPair();
  const { data: requested } = await client.post(`/machines/${encodeURIComponent(input.machine)}/secrets`, { name: input.name, recipient_key: keys.publicKey, ...(input.force ? { force: true } : {}) }, RequestedSchema);
  const machine = requested.machine ?? input.machine;
  const deadline = Date.now() + (options.timeoutMs ?? 90_000);
  for (;;) {
    const { data: claim } = await client.post(`/commands/${encodeURIComponent(requested.command_id)}/claim`, {}, ClaimSchema);
    if (claim.state === "sealed" && claim.sealed) return { machine, name: input.name, secret: openSealed(claim.sealed, keys.privateKey), existed: false };
    if (claim.state === "exists") return { machine, name: input.name, secret: null, existed: true };
    if (claim.state === "failed") throw new CloudApiError(`${machine} did not generate ${input.name}: ${claim.error ?? "the command failed"}`);
    // This request's value went elsewhere or is gone; the machine has a new secret nobody here saw.
    if (claim.state === "claimed" || claim.state === "expired") throw new CloudApiError(`The sealed ${input.name} from ${machine} was ${claim.state === "claimed" ? "already collected" : "not collected within two minutes"}; generate it again with force (the sender then needs the new value)`);
    if (Date.now() >= deadline) throw new CloudApiError(`${machine} did not answer within ${Math.round((options.timeoutMs ?? 90_000) / 1000)} s (is it online? skillhook cloud machines); the request expires two minutes after it was made`);
    await new Promise((resolve) => setTimeout(resolve, options.pollMs ?? 1_000));
  }
}
