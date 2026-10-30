#!/bin/sh
set -eu

# The public runtime schema accepts only known same-origin API base paths.
# Never interpolate arbitrary environment values into JavaScript or expose the full env.
api_base_url="${WEB_PUBLIC_META_API_BASE_URL:-/api}"
case "$api_base_url" in
  /api|/api/v1) ;;
  *) printf '%s\n' 'Invalid public web runtime configuration.' >&2; exit 1 ;;
esac

validate_exact_https_origins() {
  value="$1"
  [ -z "$value" ] && return 0
  case "$value" in ,*|*,|*,,*) return 1 ;; esac
  case "$value" in *[!A-Za-z0-9:.,-]*) return 1 ;; esac
  rest="$value"
  seen=' '
  while [ -n "$rest" ]; do
    case "$rest" in *,*) origin=${rest%%,*}; rest=${rest#*,} ;; *) origin=$rest; rest='' ;; esac
    case "$origin" in https://*) authority=${origin#https://} ;; *) return 1 ;; esac
    [ -n "$authority" ] || return 1
    case "$authority" in *:*:*) return 1 ;; esac
    host=${authority%%:*}
    port=''
    if [ "$host" != "$authority" ]; then port=${authority#*:}; fi
    [ -n "$host" ] || return 1
    case "$host" in *[A-Z]*|.*|*.|*..*|*[!a-z0-9.-]*) return 1 ;; esac
    printf '%s\n' "$host" | awk -F. 'length($0) > 253 { exit 1 } { for (i = 1; i <= NF; i++) if (length($i) == 0 || length($i) > 63 || $i !~ /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/) exit 1 }' || return 1
    if [ -n "$port" ]; then
      case "$port" in 0*|*[!0-9]*) return 1 ;; esac
      [ "${#port}" -le 5 ] || return 1
      [ "$port" = 443 ] && return 1
      awk -v port="$port" 'BEGIN { if (port < 1 || port > 65535) exit 1 }' || return 1
    fi
    case "$seen" in *" $origin "*) return 1 ;; esac
    seen="$seen$origin "
  done
}

suite4_origins="${WEB_SUITE4_EMBED_ORIGINS:-}"
provider_origins="${WEB_PUBLIC_META_AUTHORIZATION_ORIGINS:-}"
validate_exact_https_origins "$suite4_origins" || { printf '%s\n' 'Invalid public embed origin configuration.' >&2; exit 1; }
validate_exact_https_origins "$provider_origins" || { printf '%s\n' 'Invalid public provider origin configuration.' >&2; exit 1; }

csv_to_json_array() {
  value="$1"
  if [ -z "$value" ]; then printf '[]'; return; fi
  printf '%s' "$value" | awk -F, '{ printf "["; for (i = 1; i <= NF; i++) printf "%s\"%s\"", (i == 1 ? "" : ","), $i; printf "]" }'
}

frame_ancestors="'none'"
if [ -n "$suite4_origins" ]; then frame_ancestors=$(printf '%s' "$suite4_origins" | tr ',' ' '); fi

umask 077
suite4_origins_json=$(csv_to_json_array "$suite4_origins")
provider_origins_json=$(csv_to_json_array "$provider_origins")
printf 'window.__CA_META_PUBLIC_CONFIG__ = {"version":1,"metaApiBaseUrl":"%s","suite4EmbedOrigins":%s,"providerAuthorizationOrigins":%s};\n' \
  "$api_base_url" "$suite4_origins_json" "$provider_origins_json" > /tmp/runtime-config.js
printf "add_header Content-Security-Policy \"default-src 'self'; base-uri 'self'; object-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; frame-ancestors %s; form-action 'self'\" always;\n" \
  "$frame_ancestors" > /tmp/embed-policy.conf
exec "$@"
