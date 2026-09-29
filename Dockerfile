# syntax=docker/dockerfile:1.7

# ─────────────────────────────────────────────────────────────────────────────
#  Dining reservation bot — production image
#
#  Four stages, so the final image carries only what it needs to run: the
#  compiled code and the runtime dependencies. The compiler, the tests and the
#  build tooling stay behind in the intermediate layers.
#
#  Why `slim` and not `alpine`: better-sqlite3 is a native module. On glibc an
#  official prebuilt binary is published for linux-x64 and the install finishes
#  in seconds; on musl no such binary exists and node-gyp has to compile the
#  whole module from scratch. In practice that compile takes more than fifteen
#  minutes on Alpine, and on a restricted network — one that blocks the Node
#  header download — it can stall entirely.
#
#  The build toolchain is installed anyway: if GitHub is unreachable and the
#  prebuilt binary cannot be fetched, npm falls back to compiling from source
#  and has to succeed.
#
#  All four stages share one base, so the native module compiled in the build
#  stage matches the Node version and libc of the runtime stage.
# ─────────────────────────────────────────────────────────────────────────────

# ── Stage 1: dependencies ───────────────────────────────────────────────────
FROM node:22-slim AS dependencies

WORKDIR /app

# Only needed for the fallback path (compiling from source). Normally unused.
RUN apt-get update
RUN apt-get install -y --no-install-recommends python3 make g++
RUN rm -rf /var/lib/apt/lists/*

# Only the manifests are copied, so the dependency layer stays cached while the
# dependencies themselves are unchanged. Copying the whole source here would
# mean every edit to a single file needlessly re-runs a full install.
COPY package.json package-lock.json ./

# `npm ci` rather than `npm install`: it builds exactly the package-lock tree,
# and fails the build if the manifest and the lockfile disagree.
RUN npm ci


# ── Stage 2: build ──────────────────────────────────────────────────────────
FROM dependencies AS build

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src

RUN npm run build


# ── Stage 3: production dependencies ────────────────────────────────────────
# Drop devDependencies from this same tree instead of installing again from
# scratch.
FROM dependencies AS production-dependencies

RUN npm prune --omit=dev


# ── Stage 4: runtime ────────────────────────────────────────────────────────
FROM node:22-slim AS runtime

# tini as PID 1: it forwards signals to Node and reaps orphaned processes.
# Without it SIGTERM may never reach the process, and the container is killed
# with SIGKILL without the final WAL checkpoint.
RUN apt-get update
RUN apt-get install -y --no-install-recommends tini
RUN rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
ENV PORT=3000
ENV DATABASE_PATH=/app/data/bot.db

WORKDIR /app

# Copy order runs from least to most volatile, so the layer cache is used as
# much as possible.
COPY --from=production-dependencies --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json ./

# The database directory is created owned by the node user. In practice a volume
# is mounted over it, and Docker inherits the image's ownership for a fresh
# volume.
RUN mkdir -p /app/data && chown -R node:node /app/data

# Run as a non-root user. If an attacker finds a way into the process, they have
# no root access inside the container.
USER node

EXPOSE 3000

# No curl or wget: Node itself is the probe, so the image carries no extra
# binary. start-period gives the bot time to open the database.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# SIGTERM is what the shutdown handler in main.ts waits for.
STOPSIGNAL SIGTERM

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/main.js"]
