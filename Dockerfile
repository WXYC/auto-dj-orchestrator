# Multi-stage build for the auto-dj-orchestrator service.
FROM node:24-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM node:24-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

FROM node:24-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
EXPOSE 8090
HEALTHCHECK --interval=15s --timeout=5s --retries=5 \
  CMD wget -q --spider http://localhost:8090/healthcheck || exit 1
CMD ["node", "dist/index.js"]
