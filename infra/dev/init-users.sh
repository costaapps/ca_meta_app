#!/bin/sh
set -eu

read_secret() {
  secret_path="$1"
  if [ ! -r "$secret_path" ]; then
    echo 'A required local development secret is unavailable.' >&2
    exit 1
  fi
  cat "$secret_path"
}

api_password="$(read_secret /run/secrets/api_database_password)"
migration_password="$(read_secret /run/secrets/migration_database_password)"
root_password="$(read_secret /run/secrets/mariadb_root_password)"

# Restrict these synthetic dev passwords to hex so interpolation into SQL/config cannot alter statements.
for password in "$api_password" "$migration_password" "$root_password"; do
  case "$password" in
    *[!0-9a-f]*|'') echo 'Development database passwords must be generated lowercase hex.' >&2; exit 1 ;;
  esac
  if [ "${#password}" -lt 32 ]; then
    echo 'Development database passwords must contain at least 32 characters.' >&2
    exit 1
  fi
done

database_name="${MARIADB_DATABASE:?MARIADB_DATABASE must be set}"
case "$database_name" in
  *[!A-Za-z0-9_]*|'') echo 'Invalid development database name.' >&2; exit 1 ;;
esac

# A defaults file avoids putting the root password in mariadb's argv or output.
umask 077
defaults_file="$(mktemp /tmp/ca-meta-mariadb-init.XXXXXX)"
trap 'rm -f "$defaults_file"' EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
{
  printf '%s\n' '[client]' 'user=root' 'protocol=socket'
  printf 'password=%s\n' "$root_password"
} > "$defaults_file"
chmod 600 "$defaults_file"
unset root_password

mariadb --defaults-extra-file="$defaults_file" --protocol=socket --user=root <<SQL
CREATE USER IF NOT EXISTS 'ca_meta_api'@'%' IDENTIFIED BY '${api_password}';
ALTER USER 'ca_meta_api'@'%' IDENTIFIED BY '${api_password}';
GRANT SELECT, INSERT, UPDATE, DELETE ON \`${database_name}\`.* TO 'ca_meta_api'@'%';
CREATE USER IF NOT EXISTS 'ca_meta_migrator'@'%' IDENTIFIED BY '${migration_password}';
ALTER USER 'ca_meta_migrator'@'%' IDENTIFIED BY '${migration_password}';
GRANT SELECT, INSERT, UPDATE, CREATE, ALTER, INDEX, REFERENCES, TRIGGER ON \`${database_name}\`.* TO 'ca_meta_migrator'@'%';
SQL
unset api_password migration_password
