#!/usr/bin/env bash
set +x
set -euo pipefail

target="${1:-}"

# These checks run before any command that could access Cloudflare or mutate
# local release output.
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
# Default releases preserve the provider-managed flag. Only an explicit manual
# input may initialize task storage, probe the paid model, and turn tasks on.
workbench_enabled="${OA_PRODUCTION_ENABLE_AI_WORKBENCH:-false}"
if [[ "${workbench_enabled}" != "true" && "${workbench_enabled}" != "false" ]]; then
  echo "OA_PRODUCTION_ENABLE_AI_WORKBENCH must be true or false." >&2
  exit 64
fi
workbench_deploy_args=()
if [[ "${workbench_enabled}" == "true" ]]; then
  workbench_deploy_args=(--var OA_AI_TASKS_ENABLED:true)
fi
# The meeting bot is also opt-in. An unchecked input preserves the existing
# provider-managed value; an explicit true asserts only this non-secret flag.
meeting_bot_enabled="${OA_PRODUCTION_ENABLE_MEETING_BOT:-false}"
if [[ "${meeting_bot_enabled}" != "true" && "${meeting_bot_enabled}" != "false" ]]; then
  echo "OA_PRODUCTION_ENABLE_MEETING_BOT must be true or false." >&2
  exit 64
fi
meeting_bot_deploy_args=()
if [[ "${meeting_bot_enabled}" == "true" ]]; then
  meeting_bot_deploy_args=(--var OA_MEETING_BOT_ENABLED:true)
fi
required_variables=(
  OA_PRODUCTION_CLOUDFLARE_ACCOUNT_ID
  OA_PRODUCTION_WORKER_NAME
  OA_PRODUCTION_D1_DATABASE_NAME
  OA_PRODUCTION_D1_DATABASE_ID
  OA_PRODUCTION_WEBSITE_D1_DATABASE_NAME
  OA_PRODUCTION_WEBSITE_D1_DATABASE_ID
  OA_PRODUCTION_KNOWLEDGE_ASSETS_BUCKET_NAME
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
cloudflare_api_token="${CLOUDFLARE_API_TOKEN}"
script_path="${BASH_SOURCE[0]}"
script_directory="${script_path%/*}"
if [[ "${script_directory}" == "${script_path}" ]]; then
  script_directory="."
fi
script_dir="$(cd "${script_directory}" && pwd)"
project_root="$(cd "${script_dir}/.." && pwd)"
unset script_path script_directory
public_lab_ai_service_token="$(node "${script_dir}/normalize-public-lab-ai-service-token.mjs")"
if [[ ! "${public_lab_ai_service_token}" =~ ^[A-Za-z0-9_-]{43}$ ]]; then
  echo "Unable to normalize PUBLIC_LAB_AI_SERVICE_TOKEN." >&2
  exit 64
fi
unset CLOUDFLARE_API_TOKEN
unset PUBLIC_LAB_AI_SERVICE_TOKEN

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
mkdir "${release_root}/workbench"
if [[ "${workbench_enabled}" == "true" ]]; then
  cp -a "${project_root}/migrations/oa/0002_ai_workbench.sql" "${project_root}/migrations/oa/0003_ai_workbench_artifacts.sql" "${project_root}/migrations/oa/0004_ai_workbench_retention.sql" "${project_root}/migrations/oa/0005_project_work_items.sql" "${release_root}/workbench/"
  node "${script_dir}/oa-workbench-release.mjs" manifest "${release_root}/workbench" "${release_root}/workbench/activation-plan.json"
fi

node "${script_dir}/check-standalone-output.mjs" production "${config_path}"
if [[ -n "$(find "${release_root}/dist" "${release_root}/drizzle" "${release_root}/workbench" -type l -print -quit)" ]]; then
  echo "The immutable production artifact must not contain symlinks." >&2
  exit 65
fi
(
  cd "${release_root}"
  find dist drizzle workbench -type f -print0 | sort -z | xargs -0 sha256sum > artifact-sha256.txt
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
# The R2 bucket is validated by the Worker deploy/dry-run binding; this release
# does not require R2 bucket-management API permissions.
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
CI=1 CLOUDFLARE_API_TOKEN="${cloudflare_api_token}" node "${script_dir}/repair-production-d1-asset-migration.mjs" \
  --ledger "${release_root}/migration-ledger-before.json" \
  --freeze "${release_root}/migration-freeze-before.json" \
  --schema "${release_root}/schema-before.json" \
  --config "${config_path}" \
  --wrangler "${wrangler}"
run_wrangler d1 execute DB --remote --json --config "${config_path}" --command "${ledger_query}" > "${release_root}/migration-ledger-before.json"
run_wrangler d1 execute DB --remote --json --config "${config_path}" --command "${freeze_query}" > "${release_root}/migration-freeze-before.json"
run_wrangler d1 execute DB --remote --json --config "${config_path}" --command "${schema_query}" > "${release_root}/schema-before.json"
migration_state="$(node "${script_dir}/check-production-migration-state.mjs" before \
  --ledger "${release_root}/migration-ledger-before.json" \
  --freeze "${release_root}/migration-freeze-before.json" \
  --schema "${release_root}/schema-before.json" \
  --migrations-dir "${release_root}/drizzle")"

if [[ "${workbench_enabled}" == "true" ]]; then
  # LIMIT 0 validates the admission columns without reading any member records.
  run_wrangler d1 execute DB --remote --json --config "${config_path}" --command "SELECT id,account_user_id,mutation_revision,status,nda_accepted_at,nda_agreement_version,nda_approval_id,chatgpt_account FROM members LIMIT 0; SELECT id,type,status,requester_email,payload_json FROM approvals LIMIT 0" > "${release_root}/workbench-prerequisites.json"
  task_schema_query="SELECT type,name,sql FROM sqlite_master WHERE (name GLOB 'ai_workbench_*' OR tbl_name GLOB 'ai_workbench_*' OR name GLOB 'project_work_items*' OR tbl_name='project_work_items') AND name NOT GLOB 'sqlite_*' ORDER BY type,name"
  run_wrangler d1 execute DB --remote --json --config "${config_path}" --command "${task_schema_query}" > "${release_root}/workbench-schema-before.json"
  node "${script_dir}/oa-workbench-release.mjs" before "${release_root}/workbench" "${release_root}/workbench-schema-before.json" "${release_root}/workbench-schema-before-verified.json"
fi

# stdin keeps the protected value out of argv and logs. The first target check
# captures the rollback point, and the migration check verifies the database
# ledger, freeze and schema state before this provider mutation.
printf '%s' "${public_lab_ai_service_token}" \
  | run_wrangler secret put PUBLIC_LAB_AI_SERVICE_TOKEN --config "${config_path}"
if [[ "${workbench_enabled}" == "true" ]]; then
  # One synthetic real task, charged only against the existing model budget.
  # A failed probe prevents task-schema writes and enabling the feature.
  PUBLIC_LAB_AI_SERVICE_TOKEN="${public_lab_ai_service_token}" node "${script_dir}/oa-workbench-release.mjs" probe "${release_root}/workbench-model-probe.json"
fi
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

# Validate this exact immutable artifact and the explicitly recorded flag before
# changing production schema. No arbitrary CLI vars or target overrides exist.
run_wrangler deploy --dry-run --strict --keep-vars --config "${config_path}" "${workbench_deploy_args[@]}" "${meeting_bot_deploy_args[@]}"
(
  cd "${release_root}"
  sha256sum --check artifact-sha256.txt
)

# Record the recovery bookmark immediately before the possible database
# mutations. It is evidence for manual recovery, never an automatic rollback.
run_wrangler d1 time-travel info DB --json --config "${config_path}" > "${bookmark_path}"
node "${script_dir}/check-production-d1-bookmark.mjs" "${bookmark_path}" "${release_root}/d1-bookmark-before.json"

if [[ "${migration_state}" == pending-* ]]; then
  CI=1 CLOUDFLARE_API_TOKEN="${cloudflare_api_token}" node "${script_dir}/apply-production-d1-migrations.mjs" \
    --state "${migration_state}" \
    --migrations-dir "${release_root}/drizzle" \
    --config "${config_path}" \
    --wrangler "${wrangler}"
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

if [[ "${workbench_enabled}" == "true" ]]; then
  # These immutable, hash-reviewed CREATE IF NOT EXISTS files are additive.
  # Never apply migrations/oa as the Drizzle ledger or change WEBSITE_DB.
  for task_migration in 0002_ai_workbench.sql 0003_ai_workbench_artifacts.sql 0004_ai_workbench_retention.sql 0005_project_work_items.sql; do
    run_wrangler d1 execute DB --remote --json --config "${config_path}" --file "${release_root}/workbench/${task_migration}" > "${release_root}/workbench-${task_migration%.sql}-applied.json"
  done
  run_wrangler d1 execute DB --remote --json --config "${config_path}" --command "${task_schema_query}" > "${release_root}/workbench-schema-after.json"
  node "${script_dir}/oa-workbench-release.mjs" after "${release_root}/workbench" "${release_root}/workbench-schema-after.json" "${release_root}/workbench-schema-after-verified.json"
fi

(
  cd "${release_root}"
  sha256sum --check artifact-sha256.txt
)

# There is deliberately no automatic Worker or D1 rollback. A failed smoke
# check leaves the captured rollback point and D1 bookmark for manual review.
release_message="production ${GITHUB_SHA} run ${GITHUB_RUN_ID}.${GITHUB_RUN_ATTEMPT}"
run_wrangler deploy --strict --keep-vars --config "${config_path}" \
  --message "${release_message}" "${workbench_deploy_args[@]}" "${meeting_bot_deploy_args[@]}"

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
    echo "- Workbench activation requested: \`${workbench_enabled}\`"
    echo "- Meeting bot activation requested: \`${meeting_bot_enabled}\`"
    echo "- Member-session task submission/download: still requires authenticated acceptance"
    echo "- Automatic rollback: disabled"
  } >> "${GITHUB_STEP_SUMMARY}"
fi

echo "OA production release and public read-only smoke checks passed."
