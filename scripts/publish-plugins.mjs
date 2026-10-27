#!/usr/bin/env node
// Publish only plugin assets, not the CLI's source, tests, or package-manager configuration.
// Run from main after merging changes: node scripts/publish-plugins.mjs [--dry-run].
// --output=<directory> stages and validates a local snapshot without publishing.
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repo = 'MeterApp/skillhook-plugins';
const assets = ['.claude-plugin', '.codex-plugin', '.cursor-plugin', '.mcp.json', 'skills', 'docs', 'LICENSE'];
const dryRun = process.argv.includes('--dry-run');
const output = process.argv.find((arg) => arg.startsWith('--output='))?.slice(9);
const run = (command, args, cwd = root) => execFileSync(command, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const version = JSON.parse(readFileSync(join(root, '.claude-plugin/plugin.json'), 'utf8')).version;
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
      run('gh', ['repo', 'create', repo, '--public', '--description', 'Skillhook plugin for Claude Code, Codex and Cursor: webhook skills and Skillhook Cloud MCP', '--homepage', 'https://skillhook.dev']);
      run('git', ['init', '-b', 'main'], checkout);
      run('git', ['remote', 'add', 'origin', `https://github.com/${repo}.git`], checkout);
    }
    for (const entry of readdirSync(checkout)) {
      if (entry !== '.git') rmSync(join(checkout, entry), { recursive: true, force: true });
    }
  }
  if (output && existsSync(checkout) && readdirSync(checkout).length) throw new Error('--output must be an empty directory');
  for (const asset of assets) cpSync(join(root, asset), join(checkout, asset), { recursive: true });
  for (const directory of ['.claude-plugin', '.codex-plugin', '.cursor-plugin']) {
    const file = join(checkout, directory, 'plugin.json');
    const manifest = JSON.parse(readFileSync(file, 'utf8'));
    manifest.repository = `https://github.com/${repo}`;
    writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
  }
  writeFileSync(join(checkout, 'README.md'), `# Skillhook plugin\n\nWebhook in, agent out. Set up secure webhooks on your own machine, write Agent Skills, and operate your Skillhook Cloud organisation.\n\n## Install\n\n\`\`\`text\n/plugin marketplace add ${repo}\n/plugin install skillhook@meterapp-skillhook\n\`\`\`\n\nThe plugin launches the pinned npm package \`@meterapp/skillhook@${version}\` with npx and includes three skills and two MCP servers (local and cloud). Node.js 22 or later is required. Cloud access is optional; run \`skillhook cloud login\` to sign in.\n\n[Website](https://skillhook.dev) · [Documentation](https://skillhook.dev/docs) · [Source and support](https://github.com/MeterApp/skillhook) · [Privacy](https://skillhook.dev/privacy) · [Terms](https://skillhook.dev/terms)\n\nThis repository is generated from [MeterApp/skillhook](https://github.com/MeterApp/skillhook) with \`scripts/publish-plugins.mjs\`. Make changes there and republish; do not edit this mirror. Only plugin assets and supporting documentation are published here.\n`);
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
