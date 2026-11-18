// Cloud-managed skills: the skills Skillhook Cloud assigns to this machine, served from `<home>/cloud-skills` and kept
// equal to the cloud's copy (docs/cloud.md#cloud-managed-skills). The cloud is the source of truth; this machine pulls:
// on connect and every snapshot interval (`reconcile`), when the cloud says something changed (`skills.sync`), and right
// before a job of such a skill runs (`freshen`: one conditional request, so what runs is what the cloud holds now, or
// the copy on disk when the cloud cannot be asked). Nothing is pulled unless `cloud.managed_skills` is on and the
// machine's policy allows `skills.sync` (control mode or an allow entry): accepting a definition from the cloud is
// accepting code to run. Every definition is checked (hashes, paths, the SKILL.md itself) before a file is written,
// written completely before the state file points at it, and `auth: none` needs a person's say-so, as with `skill.put`.
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync, cpSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import type { Config } from "../config.js";
import { collectDefinition, definitionDigest, sha256Hex, type SkillDefinition } from "../definitions.js";
import type { Secrets } from "../env.js";
import type { Events } from "../events.js";
import type { Logger } from "../logger.js";
import { managedSkillDir, readManagedState, writeManagedState, type ManagedEntry, type ManagedState } from "../managed-state.js";
import type { Paths } from "../paths.js";
import type { SkillRegistry } from "../registry.js";
import { parseSkillDocument, SkillError } from "../skills.js";
import { errorMessage, isValidSkillName, nowIso } from "../util.js";
import { CLOUD_TOKEN_ENV, cloudDisabledByEnv, commandAllowed, resolveCloudUrl } from "./config.js";
import { CloudHttpError, cloudRequest } from "./http.js";
import { AssignedSkillResponseSchema, AssignedSkillsResponseSchema, DefinitionSchema, LIMITS, type AssignedSkill, type CommandErrorCode, type Definition } from "./protocol.js";

/** Why an install was refused, with the command error code it maps to. */
export class ManagedError extends Error {
  constructor(
    public readonly code: CommandErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ManagedError";
  }
}

export type SyncReason = "connect" | "interval" | "command" | "cli";

/** What one reconciliation did (the `skills.synced` event and the `skills.sync` result). */
export interface SkillsSyncReport {
  at: string;
  reason: SyncReason;
  /** Names newly served. */
  installed: string[];
  /** Names whose definition changed. */
  updated: string[];
  /** Names no longer assigned, removed here. */
  removed: string[];
  unchanged: number;
  errors: { name: string; error: string }[];
}

/** The answer of the pre-run check. */
export interface FreshenResult {
  /** The cloud confirmed (or replaced) the definition just now. */
  fresh: boolean;
  /** A new definition was installed and the job should resolve the skill again. */
  changed: boolean;
  /** The definition that will run. */
  sha256?: string;
  /** The cloud no longer assigns this skill to the machine; it was removed. */
  unassigned?: boolean;
  /** Why the cloud could not be asked (the copy on disk runs). */
  error?: string;
}

export interface ManagedSkillsDeps {
  paths: Paths;
  /** The live config: `cloud.*` is read at use time. */
  config: Config;
  secrets: () => Secrets;
  logger: Logger;
  events?: Events;
  /** For `adopt`: the registry that knows the home skill. */
  registry?: SkillRegistry;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  /** The pre-run check's timeout (default 5 s) and the reconciliation's (default 20 s). */
  timing?: { freshenMs?: number; syncMs?: number };
}

/** How many earlier definitions of a skill stay on disk. */
const KEEP_PREVIOUS = 2;
const SHA256_RE = /^[0-9a-f]{64}$/;

export interface InstallOptions {
  by?: string;
  allowUnauthenticated?: boolean;
  /** Where the home directory of an adopted skill was moved. */
  adoptedFrom?: string;
}

export interface InstallResult {
  name: string;
  sha256: string;
  /** False when the same definition was already current. */
  changed: boolean;
  previous?: string;
  created: boolean;
}

/**
 * Checks a definition before anything is written: a `skill` with every file's text present, every hash right, the
 * digest right, a SKILL.md at the root that parses with `name`, and `auth: none` only when a person allowed it.
 */
export function checkDefinition(definition: Definition | SkillDefinition, name: string, options: { allowUnauthenticated?: boolean; dir: string }): { files: { path: string; text: string }[]; webhookUnauthenticated: boolean } {
  if (definition.kind !== "skill") throw new ManagedError("invalid_args", `"${name}" is a ${definition.kind} definition; this machine serves skill definitions (a SKILL.md directory) from the cloud`);
  if (definition.name !== name) throw new ManagedError("invalid_args", `the definition is named "${definition.name}", not "${name}"`);
  if (definition.files.length > LIMITS.max_definition_files) throw new ManagedError("too_large", `${definition.files.length} files; at most ${LIMITS.max_definition_files}`);
  const files: { path: string; text: string }[] = [];
  const seen = new Set<string>();
  let total = 0;
  for (const file of definition.files) {
    if (seen.has(file.path)) throw new ManagedError("invalid_args", `${file.path} is listed twice`);
    seen.add(file.path);
    // A skill directory from the cloud holds no dotfiles: nothing a tool in that directory would read behind the skill's back (.mcp.json, .env).
    if (file.path.split("/").some((segment) => segment.startsWith("."))) throw new ManagedError("invalid_args", `${file.path}: a cloud-managed skill carries no dotfiles`);
    if (file.text === undefined) throw new ManagedError("invalid_args", `${file.path} comes without its text (${file.text_omitted ?? "omitted"}); the definition cannot be installed as it is`);
    const bytes = Buffer.from(file.text, "utf8");
    if (bytes.length !== file.bytes || sha256Hex(bytes) !== file.sha256) throw new ManagedError("invalid_args", `${file.path} does not match its hash`);
    total += bytes.length;
    if (total > LIMITS.max_definition_bytes) throw new ManagedError("too_large", `the definition is larger than ${LIMITS.max_definition_bytes} bytes`);
    files.push({ path: file.path, text: file.text });
  }
  if (definitionDigest(definition.kind, definition.name, definition.files) !== definition.sha256) throw new ManagedError("invalid_args", "the definition's digest does not match its files");
  const skillMd = files.find((f) => f.path === "SKILL.md");
  if (!skillMd) throw new ManagedError("invalid_args", "the definition has no SKILL.md at its root");
  let parsed;
  try {
    parsed = parseSkillDocument(skillMd.text, options.dir);
  } catch (error) {
    if (error instanceof SkillError) throw new ManagedError("invalid_args", error.message);
    throw error;
  }
  const webhookUnauthenticated = parsed.auth.type === "none" && parsed.webhook;
  if (webhookUnauthenticated && !options.allowUnauthenticated) throw new ManagedError("denied_by_policy", `"${name}" has auth: none (anyone with the URL could run it); a person must allow it on the assignment (allow_unauthenticated)`);
  return { files, webhookUnauthenticated };
}

export class ManagedSkills {
  private lastSyncAt: string | null = null;
  /** One reconciliation at a time; a second call joins the one in flight. */
  private syncing?: Promise<SkillsSyncReport | undefined>;

  constructor(private readonly deps: ManagedSkillsDeps) {}

  private get dir(): string {
    return this.deps.paths.cloudSkillsDir;
  }

  private env(): NodeJS.ProcessEnv {
    return this.deps.env ?? process.env;
  }

  /** Whether this machine pulls at all, and why not. */
  gate(): { ok: true } | { ok: false; reason: string } {
    const cloud = this.deps.config.cloud;
    if (!cloud.enabled) return { ok: false, reason: "cloud.enabled is false" };
    if (cloudDisabledByEnv(this.env())) return { ok: false, reason: "SKILLHOOK_NO_CLOUD is set" };
    if (!cloud.managed_skills) return { ok: false, reason: "cloud.managed_skills is false" };
    if (!this.deps.secrets()[CLOUD_TOKEN_ENV]) return { ok: false, reason: `no ${CLOUD_TOKEN_ENV} in .env` };
    const policy = commandAllowed("skills.sync", { mode: cloud.mode, allow_commands: cloud.allow_commands, deny_commands: cloud.deny_commands });
    if (!policy.allowed) return { ok: false, reason: policy.reason ?? "skills.sync is not allowed by this machine's policy" };
    return { ok: true };
  }

  state(): ManagedState {
    return readManagedState(this.dir);
  }

  /** What the snapshot says about the managed skills. */
  status(): { enabled: boolean; allowed: boolean; last_sync_at: string | null; skills: { name: string; sha256: string; installed_at: string; by?: string }[] } {
    const gate = this.gate();
    const state = this.state();
    return {
      enabled: this.deps.config.cloud.managed_skills,
      allowed: gate.ok,
      last_sync_at: this.lastSyncAt,
      skills: Object.entries(state.skills)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([name, entry]) => ({ name, sha256: entry.sha256, installed_at: entry.installed_at, ...(entry.by ? { by: entry.by } : {}) })),
    };
  }

  /** Installs a definition as the current version of `name`: files first, the state pointer last; old versions beyond two are pruned. */
  install(name: string, definition: Definition | SkillDefinition, options: InstallOptions = {}): InstallResult {
    if (!isValidSkillName(name) || name === "__proto__") throw new ManagedError("invalid_args", `"${name}" is not a valid skill name`);
    if (!SHA256_RE.test(definition.sha256)) throw new ManagedError("invalid_args", "not a sha256");
    const state = this.state();
    const current = state.skills[name];
    const allow = options.allowUnauthenticated ?? current?.allow_unauthenticated ?? false;
    const target = managedSkillDir(this.dir, name, definition.sha256);
    const { files } = checkDefinition(definition, name, { allowUnauthenticated: allow, dir: target });
    if (current?.sha256 === definition.sha256 && existsSync(path.join(target, "SKILL.md"))) return { name, sha256: definition.sha256, changed: false, created: false };
    if (!existsSync(path.join(target, "SKILL.md"))) {
      const versionDir = path.dirname(target);
      const tmp = path.join(path.dirname(versionDir), `.tmp-${randomUUID()}`);
      mkdirSync(path.join(tmp, name), { recursive: true });
      for (const file of files) {
        const absolute = path.join(tmp, name, ...file.path.split("/"));
        mkdirSync(path.dirname(absolute), { recursive: true });
        writeFileSync(absolute, file.text);
      }
      rmSync(versionDir, { recursive: true, force: true });
      renameSync(tmp, versionDir);
    }
    const previous = current ? [current.sha256, ...(current.previous ?? [])].filter((sha, index, all) => sha !== definition.sha256 && all.indexOf(sha) === index).slice(0, KEEP_PREVIOUS) : [];
    const entry: ManagedEntry = {
      sha256: definition.sha256,
      installed_at: nowIso(),
      ...(options.by ? { by: options.by } : {}),
      ...(allow ? { allow_unauthenticated: true } : {}),
      ...(previous.length ? { previous } : {}),
      ...(options.adoptedFrom ? { adopted_from: options.adoptedFrom } : current?.adopted_from ? { adopted_from: current.adopted_from } : {}),
    };
    state.skills[name] = entry;
    writeManagedState(this.dir, state);
    this.prune(name, [definition.sha256, ...previous]);
    this.poke(name);
    this.deps.logger.info("cloud-managed skill installed", { skill: name, sha256: definition.sha256, previous: current?.sha256, by: options.by });
    return { name, sha256: definition.sha256, changed: true, created: !current, ...(current ? { previous: current.sha256 } : {}) };
  }

  /** Removes version directories of `name` that are neither current nor kept, and leftover temporary directories. */
  private prune(name: string, keep: string[]): void {
    const dir = path.join(this.dir, name);
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (keep.includes(entry)) continue;
      if (SHA256_RE.test(entry) || entry.startsWith(".tmp-")) rmSync(path.join(dir, entry), { recursive: true, force: true });
    }
  }

  /** Stops serving `name`: the pointer goes, the files move under `jobs/.removed-skills/` where a person can find them. */
  remove(name: string, options: { by?: string } = {}): { removed: boolean; kept_at?: string } {
    const state = this.state();
    if (!state.skills[name]) return { removed: false };
    delete state.skills[name];
    writeManagedState(this.dir, state);
    const dir = path.join(this.dir, name);
    let keptAt: string | undefined;
    if (existsSync(dir)) {
      keptAt = path.join(this.deps.paths.jobsDir, ".removed-skills", `${name}-cloud-${nowIso().replace(/[:.]/g, "-")}`);
      moveDir(dir, keptAt);
    }
    this.poke(name);
    this.deps.logger.warn("cloud-managed skill removed", { skill: name, kept_at: keptAt, by: options.by });
    return { removed: true, ...(keptAt ? { kept_at: keptAt } : {}) };
  }

  /** Has the registry look the skill up now, so its `skill.changed` (added, changed, removed) goes out at once rather than at the next listing. */
  private poke(name: string): void {
    try {
      this.deps.registry?.get(name);
    } catch {
      // An unusable definition is reported by the next listing; installing never throws for the registry's sake.
    }
  }

  /**
   * Makes a skill of `<home>/skills` cloud-managed: its definition must hash to what the cloud holds (`sha256`), the
   * files become the first cloud version and the home directory moves under `jobs/.removed-skills/`, so it no longer
   * shadows the cloud copy. The cloud marks the skill as its own before it asks.
   */
  adopt(name: string, sha256: string, options: { by?: string } = {}): InstallResult & { kept_at: string } {
    if (!this.deps.registry) throw new ManagedError("unavailable", "this server cannot adopt skills");
    const skill = this.deps.registry.get(name);
    if (!skill) throw new ManagedError("not_found", `no skill named "${name}"`);
    if (skill.source.type === "cloud") throw new ManagedError("conflict", `"${name}" is already cloud-managed`);
    if (skill.source.type !== "home") throw new ManagedError("conflict", `"${name}" comes from a linked repository; publish the repository instead`);
    const definition = collectDefinition(skill);
    if (!definition) throw new ManagedError("conflict", `"${name}" has no definition to adopt`);
    if (definition.sha256 !== sha256) throw new ManagedError("conflict", `the cloud holds ${sha256.slice(0, 12)}… for "${name}", this machine has ${definition.sha256.slice(0, 12)}…; let the cloud mirror the current file first`);
    const homeDir = path.dirname(skill.file);
    if (path.dirname(homeDir) !== path.resolve(this.deps.paths.skillsDir)) throw new ManagedError("conflict", `"${name}" is not a directory of ${this.deps.paths.skillsDir}`);
    const keptAt = path.join(this.deps.paths.jobsDir, ".removed-skills", `${name}-adopted-${nowIso().replace(/[:.]/g, "-")}`);
    const result = this.install(name, definition, { by: options.by, allowUnauthenticated: true, adoptedFrom: keptAt });
    moveDir(homeDir, keptAt);
    this.deps.logger.info("skill adopted by the cloud", { skill: name, sha256, kept_at: keptAt, by: options.by });
    return { ...result, kept_at: keptAt };
  }

  private request<T>(pathname: string, schema: { safeParse(v: unknown): { success: true; data: T } | { success: false } }, options: { timeoutMs: number; headers?: Record<string, string> }): Promise<{ status: number; data: T }> {
    const cloud = this.deps.config.cloud;
    const url = resolveCloudUrl(this.env(), cloud);
    const token = this.deps.secrets()[CLOUD_TOKEN_ENV] as string;
    return cloudRequest(url, pathname, { method: "GET", token, timeoutMs: options.timeoutMs, headers: options.headers, fetchImpl: this.deps.fetchImpl, maxResponseBytes: LIMITS.max_definition_bytes * 4 }).then((answer) => {
      const parsed = schema.safeParse(answer.body);
      if (!parsed.success) throw new CloudHttpError(answer.status, "protocol_error", `${pathname}: the cloud answered with something this version does not understand`);
      return { status: answer.status, data: parsed.data };
    });
  }

  /** Fetches and installs one assigned skill; errors become a line of the report. */
  private async pull(assigned: AssignedSkill, by: string, timeoutMs: number): Promise<InstallResult> {
    const { data } = await this.request(`/api/agent/skills/${encodeURIComponent(assigned.name)}`, AssignedSkillResponseSchema, { timeoutMs });
    if (data.skill.name !== assigned.name) throw new ManagedError("invalid_args", `the cloud answered with "${data.skill.name}" for "${assigned.name}"`);
    return this.install(assigned.name, data.definition, { by, allowUnauthenticated: data.skill.allow_unauthenticated ?? assigned.allow_unauthenticated });
  }

  /**
   * Makes the served set equal to what the cloud assigns: installs what is new or changed, removes what is no longer
   * listed, leaves the rest. Undefined when the gate says no. Never throws: a cloud that cannot be reached is a report
   * with one error and nothing changed.
   */
  reconcile(reason: SyncReason, options: { by?: string } = {}): Promise<SkillsSyncReport | undefined> {
    if (this.syncing) return this.syncing;
    this.syncing = this.reconcileNow(reason, options).finally(() => {
      this.syncing = undefined;
    });
    return this.syncing;
  }

  private async reconcileNow(reason: SyncReason, options: { by?: string }): Promise<SkillsSyncReport | undefined> {
    const gate = this.gate();
    if (!gate.ok) {
      this.deps.logger.debug("cloud-managed skills: not pulling", { reason: gate.reason });
      return undefined;
    }
    const report: SkillsSyncReport = { at: nowIso(), reason, installed: [], updated: [], removed: [], unchanged: 0, errors: [] };
    const timeoutMs = this.deps.timing?.syncMs ?? 20_000;
    const by = options.by ?? `sync (${reason})`;
    let assigned: AssignedSkill[];
    try {
      assigned = (await this.request("/api/agent/skills", AssignedSkillsResponseSchema, { timeoutMs })).data.skills;
    } catch (error) {
      report.errors.push({ name: "*", error: `could not list the assigned skills: ${errorMessage(error)}` });
      this.finish(report);
      return report;
    }
    const state = this.state();
    const names = new Set<string>();
    for (const skill of assigned) {
      names.add(skill.name);
      const current = state.skills[skill.name];
      if (current?.sha256 === skill.sha256 && existsSync(managedSkillDir(this.dir, skill.name, skill.sha256))) {
        report.unchanged++;
        continue;
      }
      try {
        const result = await this.pull(skill, by, timeoutMs);
        (result.created ? report.installed : report.updated).push(skill.name);
      } catch (error) {
        report.errors.push({ name: skill.name, error: errorMessage(error) });
      }
    }
    for (const name of Object.keys(state.skills)) {
      if (names.has(name)) continue;
      try {
        if (this.remove(name, { by }).removed) report.removed.push(name);
      } catch (error) {
        report.errors.push({ name, error: errorMessage(error) });
      }
    }
    this.finish(report);
    return report;
  }

  private finish(report: SkillsSyncReport): void {
    this.lastSyncAt = report.at;
    const level = report.errors.length ? "warn" : report.installed.length || report.updated.length || report.removed.length ? "info" : "debug";
    this.deps.logger[level]("cloud-managed skills synced", { reason: report.reason, installed: report.installed, updated: report.updated, removed: report.removed, unchanged: report.unchanged, errors: report.errors.length });
    this.deps.events?.emit("skills.synced", report);
  }

  /**
   * Right before a job of a cloud-managed skill runs: asks the cloud whether the installed definition is still the one
   * it assigns (`If-None-Match`), installs the new one when not, and says whether the answer came. A cloud that cannot be
   * reached leaves the copy on disk, flagged `fresh: false`; a `404` means the skill is no longer assigned here.
   */
  async freshen(name: string): Promise<FreshenResult> {
    const gate = this.gate();
    const current = this.state().skills[name];
    if (!current) return { fresh: false, changed: false, error: `"${name}" is not a cloud-managed skill on this machine` };
    if (!gate.ok) return { fresh: false, changed: false, sha256: current.sha256, error: gate.reason };
    const timeoutMs = this.deps.timing?.freshenMs ?? 5_000;
    try {
      const { data } = await this.request(`/api/agent/skills/${encodeURIComponent(name)}`, AssignedSkillResponseSchema, { timeoutMs, headers: { "if-none-match": `"${current.sha256}"` } });
      if (data.skill.name !== name) throw new ManagedError("invalid_args", `the cloud answered with "${data.skill.name}" for "${name}"`);
      const result = this.install(name, data.definition, { by: "pre-run check", allowUnauthenticated: data.skill.allow_unauthenticated });
      return { fresh: true, changed: result.changed, sha256: result.sha256 };
    } catch (error) {
      if (error instanceof CloudHttpError && error.status === 304) return { fresh: true, changed: false, sha256: current.sha256 };
      if (error instanceof CloudHttpError && error.status === 404) {
        this.remove(name, { by: "pre-run check" });
        return { fresh: true, changed: true, unassigned: true };
      }
      if (error instanceof ManagedError) {
        // The cloud sent something this machine refuses (a bad hash, auth: none without consent): the copy on disk runs, and the log says why.
        this.deps.logger.warn("cloud-managed skill: refused the cloud's definition before the run", { skill: name, error: error.message });
        return { fresh: false, changed: false, sha256: current.sha256, error: error.message };
      }
      const message = errorMessage(error);
      this.deps.logger.warn("cloud-managed skill: could not ask the cloud before the run; running the copy on disk", { skill: name, error: message });
      return { fresh: false, changed: false, sha256: current.sha256, error: message };
    }
  }
}

/** Validates a definition the way an install would, for callers that want the error without writing anything. */
export function validateDefinition(value: unknown): Definition {
  const parsed = DefinitionSchema.safeParse(value);
  if (!parsed.success) throw new ManagedError("invalid_args", "not a definition");
  return parsed.data;
}

/** Moves a directory, across file systems if it must. */
function moveDir(from: string, to: string): void {
  mkdirSync(path.dirname(to), { recursive: true });
  try {
    renameSync(from, to);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
    cpSync(from, to, { recursive: true });
    rmSync(from, { recursive: true, force: true });
  }
}
