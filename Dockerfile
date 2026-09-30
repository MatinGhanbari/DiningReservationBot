# syntax=docker/dockerfile:1.7

# ─────────────────────────────────────────────────────────────────────────────
#  Dining reservation bot — production image
#
#  Four stages, so the final image carries only what it needs to run: the
#  compiled code and the runtime dependencies. The compiler, the tests and the
#  build tooling stay behind in the intermediate layers.
#
#  Node 24 rather than the newest release: it is the Active LTS line, which is
#  what a service that has to be patched without surprises should be on. The
#  previous pin to 22 existed only because better-sqlite3 publishes no prebuilt
#  binary for the newer ABIs — with that module gone, the pin is free to move.
#
#  `slim` and not `alpine`: nothing here is a native module any more — the
#  storage driver is a pure-JavaScript Redis client — so either would build. The
#  glibc image is kept because it is the base the deployment has been running,
#  and because `tini` comes from apt, so moving to musl would trade a known-good
#  base for a slightly smaller one and no benefit.
#
#  There is no build toolchain in the dependency stage for the same reason: with
#  no module to compile from source, python3, make and g++ had nothing to do.
# ─────────────────────────────────────────────────────────────────────────────

# ── Stage 1: dependencies ───────────────────────────────────────────────────
FROM node:24-slim AS dependencies

WORKDIR /app

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
FROM node:24-slim AS runtime

# tini as PID 1: it forwards signals to Node and reaps orphaned processes.
# Without it SIGTERM may never reach the process, and the container is killed
# with SIGKILL without the in-flight updates being drained.
RUN apt-get update
RUN apt-get install -y --no-install-recommends tini
RUN rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
ENV PORT=3000
# Where the operator-editable text catalog lives. The data itself is in Redis,
# reached through REDIS_URL.
ENV DATA_DIR=/app/data

WORKDIR /app

# Copy order runs from least to most volatile, so the layer cache is used as
# much as possible.
COPY --from=production-dependencies --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json ./

# The catalog directory is created owned by the node user. In practice a volume
# is mounted over it, and Docker inherits the image's ownership for a fresh
# volume.
RUN mkdir -p /app/data && chown -R node:node /app/data

# Run as a non-root user. If an attacker finds a way into the process, they have
# no root access inside the container.
USER node

EXPOSE 3000

# No curl or wget: Node itself is the probe, so the image carries no extra
# binary. start-period gives the bot time to reach Redis and answer once.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# SIGTERM is what the shutdown handler in main.ts waits for.
STOPSIGNAL SIGTERM

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/main.js"]
