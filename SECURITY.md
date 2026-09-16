# Security policy

skillhook exposes an HTTP endpoint that runs coding agents with real credentials on
your machine, so we take reports seriously.

- **Report privately** to hello@meterapp.co with steps to reproduce. Do not open a
  public issue for vulnerabilities. We aim to acknowledge within 3 business days.
- **Supported versions**: the latest minor release on npm.

## What skillhook does to protect you

- Binds to `127.0.0.1`; TLS and public exposure are delegated to Tailscale Funnel/Serve
  (or your own tunnel).
- Every skill requires authentication by default (per-skill bearer token) and supports
  provider signatures (GitHub, Sentry, Linear, Standard Webhooks/Granola/Svix, Stripe,
  Slack) with timing-safe comparison and replay windows.
- Secrets live in `~/.skillhook/.env` (mode 600), are never logged, and are only handed
  to the agent when a skill lists them explicitly.
- Webhook payloads are passed to the agent as clearly delimited untrusted data with
  guardrails; rate limits, body-size limits, per-skill filters and delivery
  de-duplication apply before anything runs.

See `docs/security.md` for the full model and recommendations.
