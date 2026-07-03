# syntax=docker/dockerfile:1
# Multi-stage build for the auto-dj-orchestrator service.
#
# @wxyc/shared is served from GitHub Packages (see .npmrc), which requires a
# Bearer token for every download — even the tarball pinned in package-lock.json.
# The token is supplied as a BuildKit secret so it never lands in an image layer;
# .npmrc (git-tracked, carries only the ${NPM_TOKEN} placeholder) is copied so npm
# knows the scoped registry + auth mapping and keeps legacy-peer-deps=true.
#   Build:   docker build --secret id=NPM_TOKEN,env=NPM_TOKEN .
#   Railway: expose NPM_TOKEN as a build-time variable/secret.
FROM node:24-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
RUN --mount=type=secret,id=NPM_TOKEN \
    NPM_TOKEN="$(cat /run/secrets/NPM_TOKEN)" npm ci

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
RUN --mount=type=secret,id=NPM_TOKEN \
    NPM_TOKEN="$(cat /run/secrets/NPM_TOKEN)" npm ci --omit=dev
COPY --from=build /app/dist ./dist
EXPOSE 8090
HEALTHCHECK --interval=15s --timeout=5s --retries=5 \
  CMD wget -q --spider http://localhost:8090/healthcheck || exit 1
CMD ["node", "dist/index.js"]
