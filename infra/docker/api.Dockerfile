ARG NODE_IMAGE=public.ecr.aws/docker/library/node:24.22.2-bookworm-slim@sha256:c86ecead9e55a5210ac1727de38a4ca840bf03dcaf34dc9749addbf383b1920c

FROM ${NODE_IMAGE} AS build
WORKDIR /workspace

# Copy every workspace manifest before npm ci so installs are lockfile-only and cacheable.
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/contracts/package.json packages/contracts/package.json
RUN npm ci --no-audit --fund=false

COPY apps/api ./apps/api
COPY packages/contracts ./packages/contracts
RUN npm run build --workspace=@ca-meta/api \
    && find apps/api/dist -type f -name '*.map' -delete

FROM ${NODE_IMAGE} AS production-dependencies
WORKDIR /workspace
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/contracts/package.json packages/contracts/package.json
RUN npm ci --omit=dev --workspace=@ca-meta/api --include-workspace-root=false --no-audit --fund=false

FROM ${NODE_IMAGE} AS runtime
ARG OCI_VERSION
ARG OCI_REVISION
RUN test -n "${OCI_VERSION}" && test -n "${OCI_REVISION}"
LABEL org.opencontainers.image.title="CA Meta API" \
      org.opencontainers.image.source="https://github.com/costaapps/ca_meta_app" \
      org.opencontainers.image.version="${OCI_VERSION}" \
      org.opencontainers.image.revision="${OCI_REVISION}"

ENV NODE_ENV=production \
    API_PORT=3000 \
    API_BIND_ADDRESS=0.0.0.0 \
    API_TRUSTED_PROXIES=none \
    TMPDIR=/tmp
WORKDIR /workspace/apps/api
COPY --from=production-dependencies --chown=node:node /workspace/node_modules /workspace/node_modules
COPY --from=production-dependencies --chown=node:node /workspace/apps/api/package.json ./package.json
COPY --from=build --chown=node:node /workspace/apps/api/dist ./dist
COPY --from=production-dependencies --chown=node:node /workspace/packages/contracts/package.json /workspace/packages/contracts/package.json
COPY --from=build --chown=node:node /workspace/packages/contracts/src /workspace/packages/contracts/src
COPY --from=build --chown=node:node /workspace/packages/contracts/events /workspace/packages/contracts/events

USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.API_PORT||'3000')+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["node", "dist/main.js"]
