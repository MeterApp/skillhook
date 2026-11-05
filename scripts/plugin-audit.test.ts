import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { auditPlugin, PLUGIN_DIR, scanManifest, scanText } from "./plugin-audit.js";

// The patterns are assembled from pieces so that this file itself does not read like a credential read.
const VAR = ["$", "GRANOLA_API_", "KEY"].join("");
const PROC = ["process", ".env.", "SKILLHOOK_ADMIN_", "TOKEN"].join("");
const EXPORT = ["export ", "NPM_", "TOKEN=abc"].join("");
const DOT_ENV = ["values stay in ", ".env"].join("");

function fakePlugin(files: Record<string, string> = {}): string {
  const root = mkdtempSync(path.join(tmpdir(), "skillhook-plugin-audit-"));
  const all: Record<string, string> = {
    ".claude-plugin/plugin.json": JSON.stringify({ name: "skillhook", version: "0.1.0" }),
    ".mcp.json": JSON.stringify({ mcpServers: { local: { command: "npx", args: ["-y", "skillhook@0.1.0", "mcp"] } } }),
    "skills/a/SKILL.md": "---\nname: a\n---\nSave it with `skillhook secret set NAME`.\n",
    ...files,
  };
  for (const [file, text] of Object.entries(all)) {
    const p = path.join(root, PLUGIN_DIR, file);
    mkdirSync(path.dirname(p), { recursive: true });
    writeFileSync(p, text);
  }
  return root;
}

describe("plugin audit", () => {
  it("passes a clean plugin folder", () => {
    expect(auditPlugin(fakePlugin())).toEqual([]);
  });

  it("finds credential reads, real-looking secrets and the wording the directory check matches", () => {
    expect(scanText(`one\nuse ${VAR} here`, "x.md")).toEqual([`x.md:2 shell variable holding a credential (${VAR})`]);
    expect(scanText(PROC, "x.ts")[0]).toContain("process.env credential read");
    expect(scanText(EXPORT, "x.sh")[0]).toContain("export of a credential variable");
    expect(scanText(DOT_ENV, "x.md")[0]).toContain("mentions a .env file");
    expect(scanText(["set an environment", " variable"].join(""), "x.md")[0]).toContain("mentions environment variables");
    expect(scanText(["gh", "p_", "a".repeat(36)].join(""), "x.md")[0]).toContain("a GitHub token");
    const root = fakePlugin({ "README.md": `Run with ${VAR}.\n` });
    expect(auditPlugin(root)).toEqual([`${PLUGIN_DIR}/README.md:1 shell variable holding a credential (${VAR})`]);
  });

  it("refuses plugin options, headers, env blocks and expansions in the manifests", () => {
    const problems = scanManifest(
      {
        userConfig: { api_key: { type: "string" } },
        mcpServers: {
          a: { type: "http", url: "https://example.com/${API_HOST}", headers: { "X-Integration": "plugin" } },
          b: { command: "npx", args: ["${CLAUDE_PLUGIN_ROOT}/x"], env: { SOMETHING: "1" } },
        },
      },
      "m.json",
    );
    expect(problems).toEqual([
      "m.json declares userConfig (api_key)",
      "m.json expands ${API_HOST} at mcpServers.a.url",
      "m.json sends headers at mcpServers.a",
      "m.json passes an env block at mcpServers.b (SOMETHING)",
    ]);
  });

  it("refuses a manifest at the repository root and symbolic links in the plugin folder", () => {
    const root = fakePlugin();
    mkdirSync(path.join(root, ".claude-plugin"));
    writeFileSync(path.join(root, ".claude-plugin/plugin.json"), "{}");
    symlinkSync(path.join(root, "README.md"), path.join(root, PLUGIN_DIR, "README.md"));
    expect(auditPlugin(root)).toEqual([
      `.claude-plugin/plugin.json at the repository root: the plugin lives in ${PLUGIN_DIR}`,
      `${PLUGIN_DIR}/README.md is a symbolic link: the plugin folder must hold its own files (copy it instead)`,
    ]);
  });

  it("passes this repository's plugin", () => {
    const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    expect(auditPlugin(repo)).toEqual([]);
  });
});
