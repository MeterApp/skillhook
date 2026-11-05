// The plugin credential audit, run by `pnpm run release --check` (and so by CI) over plugins/skillhook/.
//
// The Anthropic Directory's automatic check `MCP_FORWARDS_CREDENTIAL_ENV` ("Uses a credential from the user's machine")
// reads every file in a plugin's folder and holds the plugin for review when any of them looks like it reads a
// credential, whether it is code, an example or a sentence that denies it. The plugin therefore lives in its own folder
// (the rest of this repository, with its docs, examples and tests, is not part of it) and nothing in that folder may
// match. The patterns are the fleet's (`bin/lib/plugin-audit.mjs` in the Meter saas repository, rule in
// `docs/plugin-auth.md` there); keep them in step. This file stays outside the plugin folder because its own patterns
// would match.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

/** The plugin's folder, relative to the repository root. `.claude-plugin/marketplace.json` points at it. */
export const PLUGIN_DIR = "plugins/skillhook";
/** The plugin's manifests, relative to PLUGIN_DIR. */
export const PLUGIN_MANIFESTS = [".claude-plugin/plugin.json", ".codex-plugin/plugin.json", ".cursor-plugin/plugin.json"];
/** The plugin's MCP servers, relative to PLUGIN_DIR. */
export const PLUGIN_MCP_CONFIG = ".mcp.json";

const TEXT_EXT = new Set([".md", ".json", ".yaml", ".yml", ".txt", ".mjs", ".js", ".ts", ".py", ".sh", ".toml"]);

type Rule = [RegExp, string];

/** A credential being read from the installer's machine. */
export const CREDENTIAL_READS: Rule[] = [
  [/\$\{?[A-Z][A-Z0-9_]*(?:KEY|SECRET|TOKEN|PASSWORD)\b/g, "shell variable holding a credential"],
  [/process\.env(?:\.|\[\s*['"])[A-Z0-9_]*(?:KEY|SECRET|TOKEN|PASSWORD)\b/g, "process.env credential read"],
  [/\bos\.(?:environ|getenv)\b/g, "os.environ credential read"],
  [/Deno\.env\.get\(/g, "Deno.env credential read"],
  [/import\.meta\.env\.[A-Z0-9_]*(?:KEY|SECRET|TOKEN|PASSWORD)\b/g, "import.meta.env credential read"],
  [/\$\{user_config\./g, "plugin option forwarded as a credential"],
  [/\bexport\s+[A-Z][A-Z0-9_]*(?:KEY|SECRET|TOKEN|PASSWORD)=/g, "export of a credential variable"],
];

/** Anything shaped like a real credential. */
export const SECRET_PATTERNS: Rule[] = [
  [/Authorization: Bearer ey/g, "something shaped like a real token"],
  [/\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}/g, "a JWT"],
  [/\bsb_(?:secret|publishable)_[A-Za-z0-9_-]{10,}/g, "a Supabase API key"],
  [/\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}/g, "a Stripe key"],
  [/\bgh[pousr]_[A-Za-z0-9]{30,}/g, "a GitHub token"],
  [/\bAKIA[0-9A-Z]{16}\b/g, "an AWS access key"],
  [/\bAIza[0-9A-Za-z_-]{35}\b/g, "a Google API key"],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, "a Slack token"],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/g, "a private key"],
  [/\b(?:api[_-]?key|secret|password|token)\s*[:=]\s*["'][A-Za-z0-9_\-./+]{16,}["']/gi, "an assigned credential"],
];

/** Wording the check reads as "reads a credential from your machine", even in a denial. The fleet warns; we fail. */
export const SUSPICIOUS_PROSE: Rule[] = [
  [/environment variables?/gi, "mentions environment variables"],
  [/credential store|keychain/gi, "mentions a credential store"],
  [/(^|[\s`'"(])~?\/?\.env\b/g, "mentions a .env file"],
  [/\bplugin(?:'s)? options?\b/gi, "mentions plugin options"],
];

function lineOf(text: string, index: number): number {
  return text.slice(0, index).split("\n").length;
}

/** Every match of the three rule sets in one file, as `file:line label (match)`. */
export function scanText(text: string, file: string): string[] {
  const found: string[] = [];
  for (const [pattern, label] of [...CREDENTIAL_READS, ...SECRET_PATTERNS, ...SUSPICIOUS_PROSE]) {
    for (const match of text.matchAll(new RegExp(pattern.source, pattern.flags))) {
      found.push(`${file}:${lineOf(text, match.index)} ${label} (${match[0].trim()})`);
    }
  }
  return found;
}

/** A manifest or `.mcp.json`: no plugin option, no headers, no `env` block, no `${…}` but the plugin's own paths. */
export function scanManifest(manifest: Record<string, unknown>, file: string): string[] {
  const found: string[] = [];
  const userConfig = manifest.userConfig;
  if (userConfig && typeof userConfig === "object" && Object.keys(userConfig).length) found.push(`${file} declares userConfig (${Object.keys(userConfig).join(", ")})`);
  const walk = (node: unknown, where: string): void => {
    if (typeof node === "string") {
      for (const match of node.matchAll(/\$\{([A-Za-z_][\w.:-]*)[^}]*\}/g)) {
        if (!/^CLAUDE_(PLUGIN_ROOT|PLUGIN_DATA|PROJECT_DIR)$/.test(match[1] as string)) found.push(`${file} expands ${match[0]} at ${where}`);
      }
      return;
    }
    if (Array.isArray(node)) return node.forEach((item, i) => walk(item, `${where}[${i}]`));
    if (!node || typeof node !== "object") return;
    for (const [key, value] of Object.entries(node)) {
      if (key === "headers") found.push(`${file} sends headers at ${where}`);
      if (key === "env" && value && typeof value === "object" && Object.keys(value).length) found.push(`${file} passes an env block at ${where} (${Object.keys(value).join(", ")})`);
      walk(value, `${where}.${key}`);
    }
  };
  walk(manifest.mcpServers ?? {}, "mcpServers");
  return found;
}

function* walkFiles(dir: string, rel = ""): Generator<{ rel: string; symlink: boolean }> {
  for (const entry of readdirSync(path.join(dir, rel), { withFileTypes: true })) {
    const r = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) yield { rel: r, symlink: true };
    else if (entry.isDirectory()) yield* walkFiles(dir, r);
    else if (entry.isFile() && (TEXT_EXT.has(path.extname(entry.name)) || entry.name === "LICENSE")) yield { rel: r, symlink: false };
  }
}

/** The problems that would hold the plugin in the directory; empty when it is clean. Paths are relative to `root`. */
export function auditPlugin(root: string): string[] {
  const problems: string[] = [];
  const dir = path.join(root, PLUGIN_DIR);
  if (!existsSync(path.join(dir, ".claude-plugin/plugin.json"))) return [`${PLUGIN_DIR}/.claude-plugin/plugin.json is missing`];
  // A plugin manifest at the root would make the whole repository a plugin again, docs and tests included.
  if (existsSync(path.join(root, ".claude-plugin/plugin.json"))) problems.push(".claude-plugin/plugin.json at the repository root: the plugin lives in " + PLUGIN_DIR);
  for (const file of [...PLUGIN_MANIFESTS, PLUGIN_MCP_CONFIG]) {
    const p = path.join(dir, file);
    if (!existsSync(p)) continue;
    try {
      problems.push(...scanManifest(JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>, `${PLUGIN_DIR}/${file}`));
    } catch (error) {
      problems.push(`${PLUGIN_DIR}/${file} does not parse: ${(error as Error).message}`);
    }
  }
  for (const { rel, symlink } of walkFiles(dir)) {
    const file = `${PLUGIN_DIR}/${rel}`;
    if (symlink) {
      problems.push(`${file} is a symbolic link: the plugin folder must hold its own files (copy it instead)`);
      continue;
    }
    problems.push(...scanText(readFileSync(path.join(dir, rel), "utf8"), file));
  }
  return problems;
}
