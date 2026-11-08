#!/usr/bin/env node
// Publish only the plugin folder (plugins/skillhook/), not the CLI's source, docs, tests, or package-manager configuration.
// The mirror is a single-plugin repository: the folder's contents go to its root, with marketplaces pointing at "./".
// Run from main after merging changes:
// node scripts/publish-plugins.mjs [--dry-run]. --output=<directory> stages and validates a local snapshot without publishing.
//
// The mirror is what Anthropic's plugin directory installs, and the directory refuses local MCP servers, scripts and
// package manager files from organizations that are not Verified. So the mirror carries the skills and the hosted
// Skillhook Cloud server only (mirrorServers below); this repository's own marketplace keeps the two local servers.
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repo = 'MeterApp/skillhook-plugins';
const pluginDir = join(root, 'plugins/skillhook');
const dryRun = process.argv.includes('--dry-run');
const output = process.argv.find((arg) => arg.startsWith('--output='))?.slice(9);
const mirrorReadme = join(root, 'scripts/plugin-mirror/README.md');
const mirrorServers = { 'skillhook-cloud': { type: 'http', url: 'https://skillhook.dev/api/mcp' } };
const mirrorDescription = 'Turn this machine into a permanent, secure webhook endpoint that runs Agent Skills with Claude Code or Codex, and run your whole Skillhook Cloud organisation from the agent. Three skills teach the agent to install and expose skillhook, to write good webhook skills and to operate the fleet; the hosted Skillhook Cloud MCP server works every machine as the dashboard does (what needs a person, failures, stats, answers, replays, runs, hosted URLs).';
const run = (command, args, cwd = root) => execFileSync(command, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const version = JSON.parse(readFileSync(join(pluginDir, '.claude-plugin/plugin.json'), 'utf8')).version;
const checkout = output ? resolve(output) : mkdtempSync(join(tmpdir(), 'skillhook-plugins-'));

try {
  if (!output && !dryRun) {
    if (run('git', ['branch', '--show-current']) !== 'main' || run('git', ['status', '--porcelain'])) {
      throw new Error('Publish from a clean main checkout after merging. Use --output or --dry-run for validation.');
    }
    let exists = true;
    try { run('gh', ['repo', 'view', repo, '--json', 'name']); } catch { exists = false; }
    if (exists) run('gh', ['repo', 'clone', repo, checkout, '--', '--depth', '1']);
    else {
      run('gh', ['repo', 'create', repo, '--public', '--description', 'Skillhook plugin for Claude Code, Codex and Cursor: webhook skills and Skillhook Cloud MCP', '--homepage', 'https://skillhook.dev/?ref=plugin']);
      run('git', ['init', '-b', 'main'], checkout);
      run('git', ['remote', 'add', 'origin', `https://github.com/${repo}.git`], checkout);
    }
    for (const entry of readdirSync(checkout)) {
      if (entry !== '.git') rmSync(join(checkout, entry), { recursive: true, force: true });
    }
  }
  if (output && existsSync(checkout) && readdirSync(checkout).length) throw new Error('--output must be an empty directory');
  cpSync(pluginDir, checkout, { recursive: true });
  const marketplace = JSON.parse(readFileSync(join(root, '.claude-plugin/marketplace.json'), 'utf8'));
  for (const plugin of marketplace.plugins) plugin.source = './';
  writeFileSync(join(checkout, '.claude-plugin/marketplace.json'), `${JSON.stringify(marketplace, null, 2)}\n`);
  const codexMarketplace = JSON.parse(readFileSync(join(root, '.agents/plugins/marketplace.json'), 'utf8'));
  for (const plugin of codexMarketplace.plugins) plugin.source = { source: 'local', path: './' };
  mkdirSync(join(checkout, '.agents/plugins'), { recursive: true });
  writeFileSync(join(checkout, '.agents/plugins/marketplace.json'), `${JSON.stringify(codexMarketplace, null, 2)}\n`);
  writeFileSync(join(checkout, '.mcp.json'), `${JSON.stringify({ mcpServers: mirrorServers }, null, 2)}\n`);
  for (const directory of ['.claude-plugin', '.codex-plugin', '.cursor-plugin']) {
    const file = join(checkout, directory, 'plugin.json');
    const manifest = JSON.parse(readFileSync(file, 'utf8'));
    manifest.repository = `https://github.com/${repo}`;
    manifest.description = mirrorDescription;
    writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
  }
  const readme = readFileSync(mirrorReadme, 'utf8');
  writeFileSync(join(checkout, 'README.md'), `${readme}\nThis repository is generated from [MeterApp/skillhook](https://github.com/MeterApp/skillhook) (\`plugins/skillhook/\`) with \`scripts/publish-plugins.mjs\`. Make changes there and republish; do not edit this mirror.\n`);
  rmSync(join(checkout, 'CHANGELOG.md'), { force: true });
  checkDirectoryPolicy(checkout);
  console.log(run(process.env.CLAUDE_BIN || 'claude', ['plugin', 'validate', checkout, '--strict', '--profile', 'directory']));
  if (output || dryRun) console.log(`Validated skillhook ${version}: ${checkout}`);
  else {
    if (run('git', ['status', '--porcelain'], checkout)) {
      run('git', ['add', '-A'], checkout);
      run('git', ['commit', '-m', `Publish skillhook plugin ${version}`], checkout);
      run('git', ['push', '-u', 'origin', 'HEAD:main'], checkout);
    }
    console.log(`Published https://github.com/${repo} at ${run('git', ['rev-parse', 'HEAD'], checkout)}`);
  }
} finally {
  if (!output) rmSync(checkout, { recursive: true, force: true });
}

/** What the directory refuses from an organization that is not Verified: fail here, not after a rescan. */
function checkDirectoryPolicy(dir) {
  const allowed = new Set(['.md', '.txt', '.json', '.yaml', '.yml', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico']);
  const walk = (at) => {
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      if (entry.name === '.git') continue;
      const path = join(at, entry.name);
      if (entry.isDirectory()) { walk(path); continue; }
      const dot = entry.name.lastIndexOf('.');
      const ext = dot > 0 ? entry.name.slice(dot).toLowerCase() : '';
      if (['package.json', 'package-lock.json', 'pnpm-workspace.yaml'].includes(entry.name)) throw new Error(`${path}: the directory refuses package manager files`);
      if (!allowed.has(ext) && !['LICENSE', '.gitignore'].includes(entry.name)) throw new Error(`${path}: the directory refuses this file type`);
      if (readFileSync(path).subarray(0, 2).toString() === '#!') throw new Error(`${path}: the directory refuses files starting with #!`);
    }
  };
  walk(dir);
  for (const [name, server] of Object.entries(JSON.parse(readFileSync(join(dir, '.mcp.json'), 'utf8')).mcpServers)) {
    if (server.command || !server.url) throw new Error(`.mcp.json server "${name}": the directory refuses local MCP servers`);
  }
}
