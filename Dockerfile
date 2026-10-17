# Security posture:
# - Runs as the unprivileged `node` user (USER node), not root.
# - Only /app/data is writable (discovered hosts, switches, users, session
#   secret); servers.json and certs are mounted read-only by compose.
# - npm ci --omit=dev keeps dev/test dependencies out of the image; the
#   dependency set is pinned by package-lock.json.
# - No secrets are baked into the image: iDRAC credentials arrive via .env
#   at runtime, TLS certs via the read-only certs mount.
FROM node:20-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY server.js ./
COPY lib ./lib
COPY public ./public

RUN mkdir -p /app/data && chown node:node /app/data

EXPOSE 8080
USER node
CMD ["node", "server.js"]
