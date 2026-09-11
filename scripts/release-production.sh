#!/usr/bin/env bash
set +x
set -euo pipefail

target="${1:-}"

# These checks intentionally use only Bash builtins and run before any command
# that could access Cloudflare or mutate local release output.
if [[ "${target}" != "production" ]]; then
  echo "Only the production target may use this release entrypoint." >&2
  exit 64
fi
if [[ "${GITHUB_ACTIONS:-}" != "true" || "${GITHUB_EVENT_NAME:-}" != "workflow_dispatch" || "${GITHUB_REF:-}" != "refs/heads/main" ]]; then
  echo "Production release is allowed only from a manual GitHub Actions dispatch on main." >&2
  exit 64
fi
if [[ ! "${GITHUB_SHA:-}" =~ ^[0-9a-f]{40}$ || ! "${GITHUB_RUN_ID:-}" =~ ^[0-9]+$ || ! "${GITHUB_RUN_ATTEMPT:-}" =~ ^[0-9]+$ ]]; then
  echo "GitHub release provenance is incomplete." >&2
  exit 64
fi
required_variables=(
  OA_PRODUCTION_CLOUDFLARE_ACCOUNT_ID
  OA_PRODUCTION_WORKER_NAME
  OA_PRODUCTION_D1_DATABASE_NAME
  OA_PRODUCTION_D1_DATABASE_ID
  OA_PRODUCTION_WEBSITE_D1_DATABASE_NAME
  OA_PRODUCTION_WEBSITE_D1_DATABASE_ID
  OA_PRODUCTION_PUBLIC_ORIGIN
  OA_PRODUCTION_CRON
)
for variable_name in "${required_variables[@]}"; do
  if [[ -z "${!variable_name:-}" ]]; then
    echo "${variable_name} is required from the protected GitHub production environment." >&2
    exit 64
  fi
done
expected_account_id="${OA_PRODUCTION_CLOUDFLARE_ACCOUNT_ID}"
expected_worker_name="${OA_PRODUCTION_WORKER_NAME}"
expected_database_name="${OA_PRODUCTION_D1_DATABASE_NAME}"
expected_website_database_name="${OA_PRODUCTION_WEBSITE_D1_DATABASE_NAME}"
if [[ "${OA_PRODUCTION_PUBLIC_ORIGIN}" != https://* ]]; then
  echo "OA_PRODUCTION_PUBLIC_ORIGIN must be an HTTPS origin." >&2
  exit 64
fi
expected_origin_host="${OA_PRODUCTION_PUBLIC_ORIGIN#https://}"
if [[ -z "${expected_origin_host}" || "${expected_origin_host}" == */* || "${expected_origin_host}" == *:* || "${expected_origin_host}" == *\?* || "${expected_origin_host}" == *#* ]]; then
  echo "OA_PRODUCTION_PUBLIC_ORIGIN must not contain a port, path, query, or fragment." >&2
  exit 64
fi
expected_confirmation="${expected_worker_name}:${OA_PRODUCTION_D1_DATABASE_ID}:${expected_origin_host}"
if [[ "${OA_PRODUCTION_RELEASE_CONFIRM:-}" != "${expected_confirmation}" ]]; then
  echo "The exact environment-derived OA production release confirmation is required." >&2
  exit 64
fi
if [[ "${CLOUDFLARE_ACCOUNT_ID:-}" != "${expected_account_id}" ]]; then
  echo "Cloudflare account does not match the authorized OA production account." >&2
  exit 64
fi
if [[ -z "${CLOUDFLARE_API_TOKEN:-}" ]]; then
  echo "CLOUDFLARE_API_TOKEN is required from GitHub Actions Secrets." >&2
  exit 64
fi
if [[ ! "${PUBLIC_LAB_AI_SERVICE_TOKEN:-}" =~ ^[A-Za-z0-9_-]{43}$ ]]; then
  echo "PUBLIC_LAB_AI_SERVICE_TOKEN must be exactly 43 unpadded base64url characters." >&2
  exit 64
fi
cloudflare_api_token="${CLOUDFLARE_API_TOKEN}"
public_lab_ai_service_token="${PUBLIC_LAB_AI_SERVICE_TOKEN}"
unset CLOUDFLARE_API_TOKEN
unset PUBLIC_LAB_AI_SERVICE_TOKEN

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
project_root="$(cd "${script_dir}/.." && pwd)"
wrangler="${project_root}/node_modules/.bin/wrangler"
release_base="${project_root}/.wrangler/releases"
run_wrangler() {
  CI=1 CLOUDFLARE_API_TOKEN="${cloudflare_api_token}" "${wrangler}" "$@"
}
mkdir -p "${release_base}"

exec 9>"${release_base}/production.lock"
if ! flock -n 9; then
  echo "Another OA production release is already running." >&2
  exit 75
fi

cd "${project_root}"
npm run typecheck
npm run lint
npm test

# This is the final build. npm test intentionally produces the Sites artifact.
npm run build:standalone:production
npm run check:standalone:production

release_root="$(mktemp -d "${release_base}/production-${GITHUB_SHA:0:12}-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}.XXXXXX")"
cp -a "${project_root}/drizzle" "${release_root}/drizzle"
mv "${project_root}/dist" "${release_root}/dist"
config_path="${release_root}/dist/server/wrangler.json"

node "${script_dir}/check-standalone-output.mjs" production "${config_path}"
if [[ -n "$(find "${release_root}/dist" "${release_root}/drizzle" -type l -print -quit)" ]]; then
  echo "The immutable production artifact must not contain symlinks." >&2
  exit 65
fi
(
  cd "${release_root}"
  find dist drizzle -type f -print0 | sort -z | xargs -0 sha256sum > artifact-sha256.txt
)

private_root="$(mktemp -d "${project_root}/.wrangler/production-preflight.XXXXXX")"
identity_path="${private_root}/identity.json"
database_path="${private_root}/database.json"
website_database_path="${private_root}/website-database.json"
secrets_path="${private_root}/secret-names.json"
deployments_path="${private_root}/deployments.json"
versions_path="${private_root}/versions.json"
bookmark_path="${private_root}/d1-bookmark.json"
cleanup_private_files() {
  unset CLOUDFLARE_API_TOKEN PUBLIC_LAB_AI_SERVICE_TOKEN
  cloudflare_api_token=""
  public_lab_ai_service_token=""
  rm -f "${identity_path}" "${database_path}" "${website_database_path}" "${secrets_path}" "${deployments_path}" "${versions_path}" "${bookmark_path}"
  rmdir "${private_root}" 2>/dev/null || true
}
trap cleanup_private_files EXIT

# Read-only provider checks. The secret-list API returns names and types only;
# every response is redirected so provider details stay out of release logs.
run_wrangler whoami --json > "${identity_path}"
run_wrangler d1 info "${expected_database_name}" --json --config "${config_path}" > "${database_path}"
run_wrangler d1 info "${expected_website_database_name}" --json --config "${config_path}" > "${website_database_path}"
run_wrangler secret list --format json --config "${config_path}" > "${secrets_path}"
run_wrangler deployments list --json --config "${config_path}" > "${deployments_path}"
run_wrangler versions list --json --config "${config_path}" > "${versions_path}"
node "${script_dir}/check-production-cloudflare-target.mjs" \
  --identity "${identity_path}" \
  --database "${database_path}" \
  --website-database "${website_database_path}" \
  --secrets "${secrets_path}" \
  --deployments "${deployments_path}" \
  --versions "${versions_path}" \
  --receipt "${release_root}/target-before.json" \
  --allow-missing-public-lab-ai-service-token true

ledger_query="SELECT id, name FROM d1_migrations ORDER BY id"
freeze_query="SELECT COUNT(*) AS active_freezes FROM migration_control WHERE deactivated_at IS NULL"
schema_query="SELECT type, name, sql FROM sqlite_master WHERE name GLOB 'knowledge_*' OR name IN ('notification_control', 'notification_outbox', 'notification_outbox_due') ORDER BY type, name"

run_wrangler d1 execute DB --remote --json --config "${config_path}" --command "${ledger_query}" > "${release_root}/migration-ledger-before.json"
run_wrangler d1 execute DB --remote --json --config "${config_path}" --command "${freeze_query}" > "${release_root}/migration-freeze-before.json"
run_wrangler d1 execute DB --remote --json --config "${config_path}" --command "${schema_query}" > "${release_root}/schema-before.json"
migration_state="$(node "${script_dir}/check-production-migration-state.mjs" before \
  --ledger "${release_root}/migration-ledger-before.json" \
  --freeze "${release_root}/migration-freeze-before.json" \
  --schema "${release_root}/schema-before.json" \
  --migrations-dir "${release_root}/drizzle")"

# stdin keeps the protected value out of argv and logs. The first target check
# captures the rollback point, and the migration check verifies the database
# ledger, freeze and schema state before this provider mutation.
printf '%s' "${public_lab_ai_service_token}" \
  | run_wrangler secret put PUBLIC_LAB_AI_SERVICE_TOKEN --config "${config_path}"
public_lab_ai_service_token=""

# Cloudflare never returns the secret value. Verify only that the required name
# is now bound before any production D1 mutation can run.
run_wrangler secret list --format json --config "${config_path}" > "${secrets_path}"
run_wrangler deployments list --json --config "${config_path}" > "${deployments_path}"
run_wrangler versions list --json --config "${config_path}" > "${versions_path}"
node "${script_dir}/check-production-cloudflare-target.mjs" \
  --identity "${identity_path}" \
  --database "${database_path}" \
  --website-database "${website_database_path}" \
  --secrets "${secrets_path}" \
  --deployments "${deployments_path}" \
  --versions "${versions_path}" \
  --receipt "${release_root}/target-secret-configured.json"

# Validate this exact immutable artifact before changing production schema.
run_wrangler deploy --dry-run --strict --keep-vars --config "${config_path}"
(
  cd "${release_root}"
  sha256sum --check artifact-sha256.txt
)

# Record the recovery bookmark immediately before the only possible database
# mutation. It is evidence for manual recovery, never an automatic rollback.
run_wrangler d1 time-travel info DB --json --config "${config_path}" > "${bookmark_path}"
node "${script_dir}/check-production-d1-bookmark.mjs" "${bookmark_path}" "${release_root}/d1-bookmark-before.json"

if [[ "${migration_state}" == pending-* ]]; then
  run_wrangler d1 migrations apply DB --remote --config "${config_path}"
elif [[ "${migration_state}" != "applied" ]]; then
  echo "Production migration state is not safe to release." >&2
  exit 65
fi

run_wrangler d1 execute DB --remote --json --config "${config_path}" --command "${ledger_query}" > "${release_root}/migration-ledger-after.json"
run_wrangler d1 execute DB --remote --json --config "${config_path}" --command "${freeze_query}" > "${release_root}/migration-freeze-after.json"
run_wrangler d1 execute DB --remote --json --config "${config_path}" --command "${schema_query}" > "${release_root}/schema-after.json"
node "${script_dir}/check-production-migration-state.mjs" after \
  --ledger "${release_root}/migration-ledger-after.json" \
  --freeze "${release_root}/migration-freeze-after.json" \
  --schema "${release_root}/schema-after.json" \
  --migrations-dir "${release_root}/drizzle"

(
  cd "${release_root}"
  sha256sum --check artifact-sha256.txt
)

# There is deliberately no automatic Worker or D1 rollback. A failed smoke
# check leaves the captured rollback point and D1 bookmark for manual review.
release_message="production ${GITHUB_SHA} run ${GITHUB_RUN_ID}.${GITHUB_RUN_ATTEMPT}"
run_wrangler deploy --strict --keep-vars --config "${config_path}" \
  --message "${release_message}"

run_wrangler secret list --format json --config "${config_path}" > "${secrets_path}"
run_wrangler deployments list --json --config "${config_path}" > "${deployments_path}"
run_wrangler versions list --json --config "${config_path}" > "${versions_path}"
node "${script_dir}/check-production-cloudflare-target.mjs" \
  --identity "${identity_path}" \
  --database "${database_path}" \
  --website-database "${website_database_path}" \
  --secrets "${secrets_path}" \
  --deployments "${deployments_path}" \
  --versions "${versions_path}" \
  --receipt "${release_root}/target-after.json" \
  --expected-version-message "${release_message}"

unset CLOUDFLARE_API_TOKEN
cloudflare_api_token=""
node "${script_dir}/verify-production-live.mjs" --receipt "${release_root}/live-smoke.json"

if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
  {
    echo "### OA production release"
    echo
    echo "- Commit: \`${GITHUB_SHA}\`"
    echo "- Worker: \`${expected_worker_name}\`"
    echo "- D1 migration state before release: \`${migration_state}\`"
    echo "- Target and public smoke checks: passed"
    echo "- Automatic rollback: disabled"
  } >> "${GITHUB_STEP_SUMMARY}"
fi

echo "OA production release and public read-only smoke checks passed."
