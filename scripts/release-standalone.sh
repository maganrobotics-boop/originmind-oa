#!/usr/bin/env bash
set -euo pipefail

target="${1:-}"
if [[ "${target}" != "staging" ]]; then
  echo "Only the isolated staging target may be released." >&2
  exit 64
fi
staging_worker_name="${OA_STAGING_WORKER_NAME:-}"
staging_database_name="${OA_STAGING_D1_DATABASE_NAME:-}"
if [[ -z "${staging_worker_name}" || "${staging_worker_name}" != *-staging ]]; then
  echo "Set OA_STAGING_WORKER_NAME to a dedicated name ending in -staging." >&2
  exit 64
fi
if [[ -z "${staging_database_name}" || "${staging_database_name}" != *-staging ]]; then
  echo "Set OA_STAGING_D1_DATABASE_NAME to a dedicated name ending in -staging." >&2
  exit 64
fi
if [[ "${OA_STAGING_RELEASE_CONFIRM:-}" != "${staging_worker_name}" ]]; then
  echo "Set OA_STAGING_RELEASE_CONFIRM to the exact OA_STAGING_WORKER_NAME for an intentional staging release." >&2
  exit 64
fi

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
project_root="$(cd "${script_dir}/.." && pwd)"
wrangler="${project_root}/node_modules/.bin/wrangler"
release_base="${project_root}/.wrangler/releases"
secrets_file=""
secrets_args=()
if [[ -n "${OA_STAGING_SECRETS_FILE:-}" ]]; then
  secrets_file="$(node "${script_dir}/validate-staging-secrets-file.mjs" "${OA_STAGING_SECRETS_FILE}")"
  secrets_args=(--secrets-file "${secrets_file}")
fi
mkdir -p "${release_base}"

exec 9>"${release_base}/staging.lock"
if ! flock -n 9; then
  echo "Another staging release is already running." >&2
  exit 75
fi

cd "${project_root}"
npm run typecheck
npm run lint
npm test

# This must be the final build: npm test intentionally produces the Sites artifact.
npm run build:standalone:staging
npm run check:standalone:staging

release_root="$(mktemp -d "${release_base}/staging.XXXXXX")"
cp -a "${project_root}/drizzle" "${release_root}/drizzle"
mv "${project_root}/dist" "${release_root}/dist"
config_path="${release_root}/dist/server/wrangler.json"

node "${script_dir}/check-standalone-output.mjs" staging "${config_path}"
"${wrangler}" d1 info "${staging_database_name}" --json --config "${config_path}" >/dev/null

# A locked bootstrap Worker may receive its OAuth secret through the Cloudflare
# dashboard. Verify the exact name before any D1 mutation; the value remains
# unreadable to this release process. A first deploy may instead provide the
# same value through the validated private secrets file.
if [[ -z "${secrets_file}" ]]; then
  "${wrangler}" secret list --format json --config "${config_path}" \
    | node "${script_dir}/validate-staging-secret-list.mjs"
fi

# Validate the immutable artifact before mutating the staging schema.
"${wrangler}" deploy --dry-run --strict --config "${config_path}" "${secrets_args[@]}"
CI=1 "${wrangler}" d1 migrations apply DB --remote --config "${config_path}"
"${wrangler}" d1 migrations list DB --remote --config "${config_path}"
node "${script_dir}/check-standalone-output.mjs" staging "${config_path}"

"${wrangler}" deploy --strict --config "${config_path}" \
  "${secrets_args[@]}" \
  --message "staging $(git rev-parse --short HEAD)"

"${wrangler}" secret list --format json --config "${config_path}" \
  | node "${script_dir}/validate-staging-secret-list.mjs"
