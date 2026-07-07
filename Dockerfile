# =============================================================================
# Builder stage — full Node image so we have git/python/make available if any
# transitive dependency needs to compile native add-ons (rare for discord.js
# but defensive against future deps).
# =============================================================================
FROM node:18 AS builder

WORKDIR /app

# Copy only manifests first to maximise Docker layer cache hits.
# `package*.json` will pick up package.json + (optional) package-lock.json.
COPY package*.json ./

# `npm install` (not `npm ci`) so we generate a package-lock.json if one is
# missing. Pinned versions in package.json guarantee reproducibility.
RUN npm install --omit=dev --no-audit --no-fund

# Copy application source.
COPY . .

# =============================================================================
# Runner stage — tiny Alpine image with no build toolchain.
# =============================================================================
FROM node:18-alpine AS runner

WORKDIR /app

# Mark the environment as production so Node applies production optimisations
# and Discord.js gates out verbose internal dev logs.
ENV NODE_ENV=production \
    # Alpine ships with a very small ICU by default; force the full ICU so
    # any future date / locale formatting behaves identically to dev.
    NODE_ICU_DATA=/usr/local/lib/node_modules/full-icu \
    # Unset npm config that could otherwise pull in devDependencies at runtime.
    NPM_CONFIG_PRODUCTION=true

# Create a non-root user. The official node:18-alpine image already ships
# a `node` user (uid 1000) — we just make sure /app is owned by it.
RUN chown -R node:node /app

USER node

# Copy ONLY the runtime essentials from the builder. No source maps, no
# package metadata beyond what `node` needs to resolve deps, no test files.
COPY --from=builder --chown=node:node /app/node_modules ./node_modules
COPY --from=builder --chown=node:node /app/package.json ./package.json
COPY --from=builder --chown=node:node /app/src ./src

# Railway injects PORT automatically; we don't listen on any port (the bot
# is a WebSocket client to Discord's gateway) but the EXPOSE is documentary.
EXPOSE 3000

# Run with a small heap — Railway containers typically have 512MB RAM.
# `--enable-source-maps` is harmless in prod (we ship no .map files) and
# helpful if we ever do.
CMD ["node", "--enable-source-maps", "src/index.js"]
