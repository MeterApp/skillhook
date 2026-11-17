#!/bin/sh
# Entrypoint of the skillhook image (docs/docker.md).
#
#   serve [flags]     first start: `skillhook init`; then the optional pairing; then `skillhook serve` on every interface
#   <command> […]     any other skillhook command: `docker compose exec skillhook skillhook doctor` needs no entrypoint,
#                     `docker run … skillhook-image doctor` comes through here
#   sh | bash | …     anything that is not a skillhook command runs as given
set -eu

log() { printf 'skillhook-entrypoint: %s\n' "$*" >&2; }

home="${SKILLHOOK_HOME:-/data/skillhook}"
port="${SKILLHOOK_PORT:-8787}"

if [ "${1:-serve}" != "serve" ]; then
  case "$1" in
    sh | bash | node | git | gh | claude | codex | skillhook | /*) exec "$@" ;;
    *) exec skillhook "$@" ;;
  esac
fi
[ "$#" -gt 0 ] && shift

if ! [ -w "$home" ] && ! mkdir -p "$home" 2>/dev/null; then
  log "$home is not writable by uid $(id -u). A bind mount keeps its owner: chown it to $(id -u), or use a named volume."
  exit 1
fi

if [ ! -f "$home/skillhook.json" ]; then
  skillhook init --runner "${SKILLHOOK_RUNNER:-claude}" --port "$port" --json > /dev/null
  log "initialized $home"
fi

# A Claude subscription token (`claude setup-token`) given to the container. skillhook hands runs only the credentials
# in its own .env, never a CLAUDE_CODE_* variable of the process that started it, so keep it there (mode 600).
if [ -n "${CLAUDE_CODE_OAUTH_TOKEN:-}" ]; then
  printf '%s' "$CLAUDE_CODE_OAUTH_TOKEN" | skillhook secret set CLAUDE_CODE_OAUTH_TOKEN --stdin --json > /dev/null
  unset CLAUDE_CODE_OAUTH_TOKEN
fi

# Pair with Skillhook Cloud once, only when the operator asked for it with a code. The machine token it gets is kept
# in .env on the volume, so a restart (with the used code still set) pairs nothing again.
if [ -n "${SKILLHOOK_CLOUD_CODE:-}" ]; then
  if skillhook cloud status --json 2> /dev/null | node -e 'let s="";process.stdin.on("data",(d)=>s+=d).on("end",()=>{try{const r=JSON.parse(s);process.exit(r.enabled&&r.token_present?0:1)}catch{process.exit(1)}})'; then
    log "already paired with Skillhook Cloud"
  elif skillhook cloud connect --code "$SKILLHOOK_CLOUD_CODE" ${SKILLHOOK_CLOUD_MODE:+--$SKILLHOOK_CLOUD_MODE} > /dev/null; then
    log "paired with Skillhook Cloud"
  else
    log "pairing with the code in SKILLHOOK_CLOUD_CODE failed (codes are single-use and expire); serving unpaired"
  fi
  unset SKILLHOOK_CLOUD_CODE
fi

# Inside a container the loopback address is the container's own: listen on every interface and let the port mapping
# (or no mapping at all, with Skillhook Cloud's hosted URLs) decide who can reach it. Admin routes then always need
# the admin token, since no request from outside arrives from loopback.
exec skillhook serve --host 0.0.0.0 --port "$port" "$@"
