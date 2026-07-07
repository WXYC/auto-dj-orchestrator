# syntax=docker/dockerfile:1
# check=skip=SecretsUsedInArgOrEnv
# Multi-stage build for the auto-dj-orchestrator service.
#
# @wxyc/shared is served from GitHub Packages (see .npmrc), which requires a
# Bearer token for every download — even the tarball pinned in package-lock.json.
# .npmrc (git-tracked, carries only the ${NPM_TOKEN} placeholder) is copied so npm
# knows the scoped registry + auth mapping and keeps legacy-peer-deps=true.
#
# NPM_TOKEN is used ONLY in the `deps` stage, which is intermediate and discarded
# from the final image. It is resolved from a BuildKit secret mount when present
# (local/CI: `docker build --secret id=NPM_TOKEN,env=NPM_TOKEN .`), else from a
# build ARG for platforms without build-secret support (e.g. Railway, which
# injects build variables as ARG/env, not BuildKit secrets).
#
# A build ARG's value IS recorded in that stage's `docker history` / layer
# metadata, so the token-bearing stage must never be the final one: the `runtime`
# stage below copies the already-resolved node_modules from `deps` and prunes dev
# deps offline, so it needs no token and the shipped image carries no secret (only
# the placeholder-only `.npmrc`, which `npm prune` needs for legacy-peer-deps).
# Containing the token to a discarded stage is why the
# SecretsUsedInArgOrEnv lint is skipped. The build fails loudly if neither source
# provides a token; an empty secret file falls through to the ARG.
FROM node:24-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
ARG NPM_TOKEN
RUN --mount=type=secret,id=NPM_TOKEN \
    TOKEN="$(cat /run/secrets/NPM_TOKEN 2>/dev/null)"; \
    [ -n "$TOKEN" ] || TOKEN="$(printf '%s' "$NPM_TOKEN")"; \
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
# .npmrc (placeholder-only, no secret) is needed for `npm prune` to honour
# legacy-peer-deps and the scoped-registry mapping; it carries no token.
COPY package.json package-lock.json .npmrc ./
# No NPM_TOKEN here: reuse the deps stage's already-authenticated install and
# prune devDependencies offline, so the final image never touches GitHub Packages
# and no build ARG or secret can reach a shipped layer or `docker history`.
COPY --from=deps /app/node_modules ./node_modules
RUN npm prune --omit=dev
COPY --from=build /app/dist ./dist
EXPOSE 8090
HEALTHCHECK --interval=15s --timeout=5s --retries=5 \
  CMD wget -q --spider http://localhost:8090/healthcheck || exit 1
CMD ["node", "dist/index.js"]
