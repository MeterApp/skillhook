// Runs before every test file (vitest `setupFiles`). The runners' environment copies credentials from the server's own
// environment (`PROCESS_CREDENTIAL_KEYS` in src/runners/env.ts), so a developer's ANTHROPIC_API_KEY, or a Claude Code
// session's CLAUDE_CONFIG_DIR, would decide readiness and what the fake CLIs see. Tests set what they need themselves.
const RUNNER_CREDENTIALS = /^(ANTHROPIC_|OPENAI_|CODEX_)|^(CLAUDE_CONFIG_DIR|CLAUDE_CODE_OAUTH_TOKEN)$/;

for (const key of Object.keys(process.env)) if (RUNNER_CREDENTIALS.test(key)) delete process.env[key];
