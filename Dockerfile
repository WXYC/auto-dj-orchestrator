# syntax=docker/dockerfile:1
# check=skip=SecretsUsedInArgOrEnv
# Multi-stage build for the auto-dj-orchestrator service.
#
# @wxyc/shared is served from GitHub Packages (see .npmrc), which requires a
# Bearer token for every download — even the tarball pinned in package-lock.json.
# .npmrc (git-tracked, carries only the ${NPM_TOKEN} placeholder) is copied so npm
# knows the scoped registry + auth mapping and keeps legacy-peer-deps=true.
#
# NPM_TOKEN reaches npm one of two ways, tried in that order:
#   1. A BuildKit secret mount — never lands in an image layer. Local/CI:
#        docker build --secret id=NPM_TOKEN,env=NPM_TOKEN .
#   2. A build ARG — for platforms without build-secret support (e.g. Railway,
#      which injects build variables as ARG/env, not BuildKit secrets). The token
#      is referenced only through a shell variable, so it is not recorded in the
#      image config or `docker history` (this is why the SecretsUsedInArgOrEnv
#      lint rule is skipped above — the ARG is a deliberate, contained concession).
#   Railway: set NPM_TOKEN as a service build variable; it arrives as the ARG.
# The build fails loudly if neither source provides a token.
FROM node:24-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
ARG NPM_TOKEN
RUN --mount=type=secret,id=NPM_TOKEN \
    TOKEN="$(cat /run/secrets/NPM_TOKEN 2>/dev/null || printf '%s' "$NPM_TOKEN")"; \
    [ -n "$TOKEN" ] || { echo 'NPM_TOKEN not provided: pass a BuildKit --secret or a build ARG'; exit 1; }; \
    NPM_TOKEN="$TOKEN" npm ci

FROM node:24-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

FROM node:24-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json .npmrc ./
ARG NPM_TOKEN
RUN --mount=type=secret,id=NPM_TOKEN \
    TOKEN="$(cat /run/secrets/NPM_TOKEN 2>/dev/null || printf '%s' "$NPM_TOKEN")"; \
    [ -n "$TOKEN" ] || { echo 'NPM_TOKEN not provided: pass a BuildKit --secret or a build ARG'; exit 1; }; \
    NPM_TOKEN="$TOKEN" npm ci --omit=dev
COPY --from=build /app/dist ./dist
EXPOSE 8090
HEALTHCHECK --interval=15s --timeout=5s --retries=5 \
  CMD wget -q --spider http://localhost:8090/healthcheck || exit 1
CMD ["node", "dist/index.js"]
