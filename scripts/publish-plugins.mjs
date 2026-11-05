#!/usr/bin/env node
// Publish only the plugin folder (plugins/skillhook/), not the CLI's source, docs, tests, or package-manager configuration.
// The mirror is a single-plugin repository: the folder's contents go to its root, with marketplaces pointing at "./".
// Run from main after merging changes and after Publish has put that version on npm:
// node scripts/publish-plugins.mjs [--dry-run]. --output=<directory> stages and validates a local snapshot without publishing.
//
// In the mirror, Claude Code runs the MCP servers from a locked install, not from an npx launcher: the mirror gets a
// package.json that depends on exactly this @meterapp/skillhook version and the package-lock.json npm writes for it
// (registry sources and integrity hashes for the whole tree), which Claude Code installs into the plugin's
// node_modules; .mcp.json starts server/skillhook.mjs (scripts/plugin-mirror/) with node. Codex and Cursor install no
// lockfile, so their manifests point at .mcp.npx.json, the repository's own npx launchers.
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
const launcher = join(root, 'scripts/plugin-mirror/skillhook.mjs');
const packageName = '@meterapp/skillhook';
const registry = 'https://registry.npmjs.org/';
const run = (command, args, cwd = root) => execFileSync(command, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const version = JSON.parse(readFileSync(join(pluginDir, '.claude-plugin/plugin.json'), 'utf8')).version;
const checkout = output ? resolve(output) : mkdtempSync(join(tmpdir(), 'skillhook-plugins-'));

try {
  if (!output && !dryRun) {
    if (run('git', ['branch', '--show-current']) !== 'main' || run('git', ['status', '--porcelain'])) {
      throw new Error('Publish from a clean main checkout after merging. Use --output or --dry-run for validation.');
    }
    run('npm', ['view', `@meterapp/skillhook@${version}`, 'version']);
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
  lockServers();
  for (const directory of ['.claude-plugin', '.codex-plugin', '.cursor-plugin']) {
    const file = join(checkout, directory, 'plugin.json');
    const manifest = JSON.parse(readFileSync(file, 'utf8'));
    manifest.repository = `https://github.com/${repo}`;
    if (directory !== '.claude-plugin') manifest.mcpServers = './.mcp.npx.json';
    writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
  }
  const readme = readFileSync(join(pluginDir, 'README.md'), 'utf8').replaceAll('/plugin marketplace add MeterApp/skillhook', `/plugin marketplace add ${repo}`).replaceAll('codex plugin marketplace add MeterApp/skillhook', `codex plugin marketplace add ${repo}`);
  writeFileSync(join(checkout, 'README.md'), `${readme}\nThis repository is generated from [MeterApp/skillhook](https://github.com/MeterApp/skillhook) (\`plugins/skillhook/\`) with \`scripts/publish-plugins.mjs\`. Make changes there and republish; do not edit this mirror.\n`);
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

/**
 * The runtime dependency tree CI tested (pnpm-lock.yaml), as exact versions. They are listed as direct dependencies
 * (Claude Code's install does not apply `overrides`), so npm dedupes the package's own ranges onto them and the lock
 * holds those versions, not newer ones.
 */
function testedVersions() {
  const versions = {};
  const walk = (deps = {}) => {
    for (const [name, dep] of Object.entries(deps)) {
      if (versions[name] && versions[name] !== dep.version) throw new Error(`pnpm-lock.yaml has ${name} at ${versions[name]} and ${dep.version}; extend testedVersions() to nest overrides`);
      versions[name] = dep.version;
      walk(dep.dependencies);
    }
  };
  walk(JSON.parse(run('pnpm', ['ls', '--prod', '--depth', 'Infinity', '--json']))[0].dependencies);
  return Object.fromEntries(Object.entries(versions).sort(([a], [b]) => a.localeCompare(b)));
}

/** Claude Code's servers: the locked install (package.json + package-lock.json) and node on server/skillhook.mjs. */
function lockServers() {
  const npxConfig = readFileSync(join(pluginDir, '.mcp.json'), 'utf8');
  writeFileSync(join(checkout, '.mcp.npx.json'), npxConfig);
  const servers = JSON.parse(npxConfig).mcpServers;
  for (const [name, server] of Object.entries(servers)) {
    const at = server.args.indexOf(`${packageName}@${version}`);
    if (server.command !== 'npx' || at < 0) throw new Error(`.mcp.json server "${name}" must launch ${packageName}@${version} with npx`);
    servers[name] = { command: 'node', args: ['${CLAUDE_PLUGIN_ROOT}/server/skillhook.mjs', ...server.args.slice(at + 1)] };
  }
  writeFileSync(join(checkout, '.mcp.json'), `${JSON.stringify({ mcpServers: servers }, null, 2)}\n`);
  mkdirSync(join(checkout, 'server'), { recursive: true });
  cpSync(launcher, join(checkout, 'server/skillhook.mjs'));
  const pkg = { name: 'skillhook-plugin', version, private: true, description: `The ${packageName} release this plugin's MCP servers run, installed by Claude Code from package-lock.json.`, license: 'MIT', dependencies: { [packageName]: version, ...testedVersions() } };
  writeFileSync(join(checkout, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`);
  run('npm', ['install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund', `--registry=${registry}`], checkout);
  const lock = JSON.parse(readFileSync(join(checkout, 'package-lock.json'), 'utf8'));
  const entries = Object.entries(lock.packages).filter(([path]) => path !== '');
  for (const [name, exact] of Object.entries(pkg.dependencies)) {
    if (lock.packages[`node_modules/${name}`]?.version !== exact) throw new Error(`package-lock.json does not lock ${name}@${exact}`);
  }
  const nested = entries.filter(([path]) => path.split('node_modules/').length > 2).map(([path]) => path);
  if (nested.length) throw new Error(`package-lock.json installs other versions under ${nested.join(', ')}; the tested tree should dedupe`);
  for (const [path, entry] of entries) {
    if (!entry.resolved?.startsWith(registry) || !/^sha512-/.test(entry.integrity ?? '')) throw new Error(`package-lock.json: ${path} has no registry source and sha512 integrity`);
  }
  console.log(`Locked ${packageName}@${version} and ${entries.length - 1} dependencies in package-lock.json`);
}
