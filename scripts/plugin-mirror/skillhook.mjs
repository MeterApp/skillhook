#!/usr/bin/env node
// Starts skillhook's MCP servers for Claude Code from the plugin's own copy of the @meterapp/skillhook npm package.
//
// The plugin ships package.json and package-lock.json at its root. Claude Code installs exactly the versions in that
// lockfile, checked against their registry integrity hashes, into the plugin's node_modules when it installs or
// updates the plugin. This file only runs that installed command line with the arguments .mcp.json gives
// ("mcp" or "mcp --cloud"); it downloads and installs nothing itself.
import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

const cli = fileURLToPath(new URL("../node_modules/@meterapp/skillhook/dist/cli.js", import.meta.url));
if (!existsSync(cli)) {
  process.stderr.write(
    "skillhook: the plugin's npm dependencies are not installed. Claude Code installs them from the plugin's " +
      "package-lock.json when it installs or updates the plugin; reinstall the skillhook plugin, or check /plugin for the install error.\n",
  );
  process.exit(1);
}
await import(pathToFileURL(cli).href);
