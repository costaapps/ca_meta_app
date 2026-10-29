FROM node@sha256:c86ecead9e55a5210ac1727de38a4ca840bf03dcaf34dc9749addbf383b1920c

ENV NODE_ENV=development \
    TZ=UTC
WORKDIR /workspace

COPY package.json package-lock.json ./
COPY packages/web-toolchain/package.json packages/web-toolchain/package.json
COPY packages/api/package.json packages/api/package.json
RUN npm ci --no-audit --fund=false

COPY . .
RUN npm run check:toolchains

CMD ["npm", "test"]
