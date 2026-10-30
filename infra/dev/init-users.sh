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

# Restrict these synthetic dev passwords to hex so interpolation into SQL cannot alter the statements.
for password in "$api_password" "$migration_password"; do
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

mariadb --protocol=socket --user=root <<SQL
CREATE USER IF NOT EXISTS 'ca_meta_api'@'%' IDENTIFIED BY '${api_password}';
ALTER USER 'ca_meta_api'@'%' IDENTIFIED BY '${api_password}';
GRANT SELECT, INSERT, UPDATE, DELETE ON \`${database_name}\`.* TO 'ca_meta_api'@'%';
CREATE USER IF NOT EXISTS 'ca_meta_migrator'@'%' IDENTIFIED BY '${migration_password}';
ALTER USER 'ca_meta_migrator'@'%' IDENTIFIED BY '${migration_password}';
GRANT SELECT, INSERT, UPDATE, CREATE, ALTER, INDEX, REFERENCES, TRIGGER ON \`${database_name}\`.* TO 'ca_meta_migrator'@'%';
SQL
