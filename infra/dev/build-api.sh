#!/bin/sh
set -eu

workspace_root=/workspace
output_dir=/workspace/apps/api/dist

if [ "$(pwd -P)" != "$workspace_root" ]; then
  echo 'Refusing to build API outside /workspace.' >&2
  exit 1
fi
if [ ! -d "$output_dir" ] || [ -L "$output_dir" ]; then
  echo 'Refusing to clean API output: expected a real dist directory.' >&2
  exit 1
fi
if ! awk -v expected="$output_dir" '$5 == expected { found = 1 } END { exit(found ? 0 : 1) }' /proc/self/mountinfo; then
  echo 'Refusing to clean API output: dist must be its dedicated mounted volume.' >&2
  exit 1
fi

# Keep the named-volume mountpoint itself in place; Nest's default deleteOutDir
# cannot remove that mountpoint. Remove only its existing children before build.
find "$output_dir" -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +
exec npm run build --workspace=@ca-meta/api -- --config nest-cli.dev.json
