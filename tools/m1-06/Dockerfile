FROM node:24.22.2-bookworm-slim@sha256:c86ecead9e55a5210ac1727de38a4ca840bf03dcaf34dc9749addbf383b1920c

ENV NODE_ENV=development \
    TZ=UTC
WORKDIR /workspace
RUN mkdir -p /workspace/input

COPY package.json package-lock.json ./
RUN npm ci --no-audit --fund=false

COPY src ./src
COPY sql ./sql

CMD ["sh", "-c", "node --version && npm --version && npm test"]
