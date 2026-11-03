ARG NODE_IMAGE=public.ecr.aws/docker/library/node:24.22.2-alpine3.24@sha256:8a32c8cf649a49915a66e81e7a609223c708d0adabf288ee3f4077d765542f85
ARG NGINX_IMAGE=public.ecr.aws/nginx/nginx-unprivileged:stable-alpine3.24@sha256:2daef144b574804198caccc4041819fa1801ecd5df2252a39646bfa2b1ff3bea

FROM ${NODE_IMAGE} AS build
WORKDIR /workspace
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/contracts/package.json packages/contracts/package.json
RUN npm ci --no-audit --fund=false

COPY apps/web ./apps/web
COPY packages/contracts ./packages/contracts
RUN npm run build --workspace=@ca-meta/web -- --configuration=production --source-map=false --base-href=/ \
    && find apps/web/dist/meta-integration/browser -type f -name '*.map' -delete

FROM ${NGINX_IMAGE} AS runtime
ARG OCI_VERSION
ARG OCI_REVISION
USER root
RUN apk add --no-cache libexpat=2.10.0-r0
RUN test -n "${OCI_VERSION}" && test -n "${OCI_REVISION}"
LABEL org.opencontainers.image.title="CA Meta Web" \
      org.opencontainers.image.source="https://github.com/costaapps/ca_meta_app" \
      org.opencontainers.image.version="${OCI_VERSION}" \
      org.opencontainers.image.revision="${OCI_REVISION}"

COPY --from=build --chown=101:101 /workspace/apps/web/dist/meta-integration/browser/ /usr/share/nginx/html/
COPY infra/docker/nginx.conf /etc/nginx/nginx.conf
COPY infra/docker/web-entrypoint.sh /usr/local/bin/web-entrypoint.sh
RUN chmod 0555 /usr/local/bin/web-entrypoint.sh

ENV WEB_PUBLIC_META_API_BASE_URL=/api
USER 101:101
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD ["wget", "-q", "-O", "/dev/null", "http://127.0.0.1:8080/healthz"]
ENTRYPOINT ["/usr/local/bin/web-entrypoint.sh"]
CMD ["nginx", "-g", "daemon off;"]
