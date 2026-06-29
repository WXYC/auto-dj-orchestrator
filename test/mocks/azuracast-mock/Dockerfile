# Drivable AzuraCast now-playing mock for the staging integration environment.
FROM node:24-alpine
WORKDIR /app
COPY server.mjs ./
EXPOSE 8095
HEALTHCHECK --interval=10s --timeout=3s --retries=5 \
  CMD wget -q --spider http://localhost:8095/healthcheck || exit 1
CMD ["node", "server.mjs"]
