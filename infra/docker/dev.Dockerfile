ARG NODE_IMAGE=public.ecr.aws/docker/library/node:24.22.2-bookworm-slim@sha256:c86ecead9e55a5210ac1727de38a4ca840bf03dcaf34dc9749addbf383b1920c
FROM ${NODE_IMAGE}

WORKDIR /workspace
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/contracts/package.json packages/contracts/package.json
RUN npm ci --no-audit --fund=false

COPY apps/api ./apps/api
COPY apps/web ./apps/web
COPY packages/contracts ./packages/contracts
COPY infra/dev/build-api.sh /usr/local/bin/ca-meta-build-api
RUN mkdir -p /workspace/apps/api/dist \
    && chmod 0755 /usr/local/bin/ca-meta-build-api \
    && chown -R node:node /workspace/apps/api /workspace/apps/web /workspace/packages/contracts

USER node
EXPOSE 3000 4200 8080
