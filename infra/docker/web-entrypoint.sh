#!/bin/sh
set -eu

# The public runtime schema accepts only known same-origin API base paths.
# Never interpolate arbitrary environment values into JavaScript or expose the full env.
api_base_url="${WEB_PUBLIC_META_API_BASE_URL:-/api}"
case "$api_base_url" in
  /api|/api/v1) ;;
  *) printf '%s\n' 'Invalid public web runtime configuration.' >&2; exit 1 ;;
esac

umask 077
printf 'window.__CA_META_PUBLIC_CONFIG__ = {"version":1,"metaApiBaseUrl":"%s"};\n' "$api_base_url" > /tmp/runtime-config.js
exec "$@"
