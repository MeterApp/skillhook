# skillhook in a container: the server, Claude Code, Codex, git and gh, as one unprivileged user.
# Everything that must survive a restart lives under /data (one volume). See docs/docker.md.
#
#   docker build -t skillhook .
#   docker build -t skillhook --build-arg CLAUDE_CODE_VERSION=2.1.0 --build-arg CODEX_VERSION=0.50.0 .

ARG NODE_VERSION=24

# --- build: the package exactly as `npm pack` would publish it ---------------------------------------------------
FROM node:${NODE_VERSION}-bookworm-slim AS build
WORKDIR /src
RUN npm install -g pnpm@12.14.0
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm run build && mkdir /out && npm pack --pack-destination /out && mv /out/*.tgz /out/skillhook.tgz

# --- runtime -----------------------------------------------------------------------------------------------------
FROM node:${NODE_VERSION}-bookworm-slim

# The agents' CLIs. "latest" follows each vendor's current release; pin both for a reproducible image.
ARG CLAUDE_CODE_VERSION=latest
ARG CODEX_VERSION=latest

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl git gnupg jq less openssh-client procps ripgrep tini \
 && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
 && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends gh \
 && rm -rf /var/lib/apt/lists/*

COPY --from=build /out/skillhook.tgz /tmp/skillhook.tgz
RUN npm install -g /tmp/skillhook.tgz "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" "@openai/codex@${CODEX_VERSION}" \
 && rm /tmp/skillhook.tgz \
 && npm cache clean --force

# The node image's own unprivileged user (uid 1000). Agents run as it: Claude Code refuses to skip permission
# prompts as root, and nothing here needs root after the build.
RUN mkdir -p /data/home /data/skillhook /data/workspace && chown -R node:node /data

COPY --chmod=755 docker/entrypoint.sh /usr/local/bin/skillhook-entrypoint

ENV HOME=/data/home \
    SKILLHOOK_HOME=/data/skillhook \
    # The image is the version: update by pulling a newer image, never by reinstalling inside a running container.
    SKILLHOOK_NO_UPDATE_CHECK=1 \
    SKILLHOOK_CONTAINER=1 \
    DISABLE_AUTOUPDATER=1 \
    NODE_ENV=production

USER node
WORKDIR /data/workspace
VOLUME /data
EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.SKILLHOOK_PORT || 8787) + '/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"

ENTRYPOINT ["tini", "--", "skillhook-entrypoint"]
CMD ["serve"]
