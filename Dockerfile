# Si Paling Hermes app image. Runs on the friend's VPS alongside their fairshare
# stack — everything in this repo's deploy is mizan- prefixed and self-contained.
FROM node:22-bookworm-slim

WORKDIR /app

# better-sqlite3@13 ships linux prebuilds in the npm tarball — no toolchain needed.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts

COPY server.mjs ./
COPY agent-runtime.mjs ./agent-runtime.mjs
COPY app.js ./app.js
COPY styles.css ./styles.css
COPY posthog-init.js ./posthog-init.js
COPY index.html ./index.html
COPY assets ./assets
COPY public ./public
COPY auth ./auth
COPY dashboard ./dashboard
COPY admin ./admin
COPY lead-magnet ./lead-magnet
COPY dist ./dist

# SQLite data dir must be writable by the node user; it lives on a volume in compose.
RUN mkdir -p /app/data && chown node:node /app/data

# Run as the non-root `node` user shipped with the base image.
USER node

ENV PORT=5173
# POSTHOG_API_KEY is injected via environment only (compose `environment:`), never baked in.
EXPOSE 5173

CMD ["node", "server.mjs"]
