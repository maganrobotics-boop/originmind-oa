#!/usr/bin/env bash
set +x
set -euo pipefail

# This is a post-release step, not a second deployment entry point or an API.
if [[ "${OA_ENABLE_AI_WORKBENCH:-}" != "true" || "${GITHUB_ACTIONS:-}" != "true" || "${GITHUB_EVENT_NAME:-}" != "workflow_dispatch" || "${GITHUB_REF:-}" != "refs/heads/main" ]]; then
  echo "Workbench activation requires an explicit manual main release." >&2; exit 64
fi
if [[ ! "${GITHUB_SHA:-}" =~ ^[0-9a-f]{40}$ || ! "${GITHUB_RUN_ID:-}" =~ ^[0-9]+$ || ! "${GITHUB_RUN_ATTEMPT:-}" =~ ^[0-9]+$ ]]; then
  echo "Missing activation provenance." >&2; exit 64
fi
required=(OA_PRODUCTION_CLOUDFLARE_ACCOUNT_ID OA_PRODUCTION_WORKER_NAME OA_PRODUCTION_D1_DATABASE_NAME OA_PRODUCTION_D1_DATABASE_ID OA_PRODUCTION_WEBSITE_D1_DATABASE_NAME OA_PRODUCTION_WEBSITE_D1_DATABASE_ID OA_PRODUCTION_KNOWLEDGE_ASSETS_BUCKET_NAME OA_PRODUCTION_PUBLIC_ORIGIN OA_PRODUCTION_CRON CLOUDFLARE_API_TOKEN)
for key in "${required[@]}"; do
  if [[ -z "${!key:-}" ]]; then echo "Missing protected production configuration: ${key}" >&2; exit 64; fi
done
host="${OA_PRODUCTION_PUBLIC_ORIGIN#https://}"
if [[ "${OA_PRODUCTION_PUBLIC_ORIGIN}" != https://* || -z "${host}" || "${host}" == *[/\?:#]* || "${CLOUDFLARE_ACCOUNT_ID:-}" != "${OA_PRODUCTION_CLOUDFLARE_ACCOUNT_ID}" || "${OA_PRODUCTION_RELEASE_CONFIRM:-}" != "${OA_PRODUCTION_WORKER_NAME}:${OA_PRODUCTION_D1_DATABASE_ID}:${host}" ]]; then
  echo "Workbench activation target is not authorized." >&2; exit 64
fi
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
wrangler="${root}/node_modules/.bin/wrangler"
releases="${root}/.wrangler/releases"
# A successful release from this exact workflow attempt must already exist.
mapfile -d '' matches < <(find "${releases}" -maxdepth 1 -type d -name "production-${GITHUB_SHA:0:12}-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}.*" -print0)
if [[ "${#matches[@]}" != 1 ]]; then echo "Exactly one successful same-run OA release is required." >&2; exit 65; fi
release_root="${matches[0]}"
if [[ ! -s "${release_root}/target-after.json" || ! -s "${release_root}/live-smoke.json" || -L "${release_root}" ]]; then
  echo "The preceding OA production release is incomplete." >&2; exit 65
fi
exec 9>"${releases}/production.lock"
flock -n 9 || exit 75
(cd "${release_root}" && sha256sum --check artifact-sha256.txt)
config="${release_root}/dist/server/wrangler.json"
node "${root}/scripts/check-standalone-output.mjs" production "${config}"
activation="$(mktemp -d "${release_root}/workbench-activation.XXXXXX")"
private="$(mktemp -d "${root}/.wrangler/workbench-preflight.XXXXXX")"
token="${CLOUDFLARE_API_TOKEN}"
unset CLOUDFLARE_API_TOKEN
cleanup() { token=""; rm -rf -- "${private}"; }
trap cleanup EXIT
run_wrangler() { CI=1 CLOUDFLARE_API_TOKEN="${token}" "${wrangler}" "$@"; }

# Immutable copies contain only the two previously reviewed, additive task DDLs.
mkdir "${activation}/migrations"
for name in 0002_ai_workbench.sql 0003_ai_workbench_artifacts.sql; do
  if [[ -L "${root}/migrations/oa/${name}" ]]; then echo "Task migrations must not be symlinks." >&2; exit 65; fi
  cp "${root}/migrations/oa/${name}" "${activation}/migrations/${name}"
done
(cd "${activation}" && sha256sum migrations/*.sql > migrations-sha256.txt)

run_wrangler whoami --json > "${private}/identity.json"
run_wrangler d1 info "${OA_PRODUCTION_D1_DATABASE_NAME}" --json --config "${config}" > "${private}/database.json"
run_wrangler d1 info "${OA_PRODUCTION_WEBSITE_D1_DATABASE_NAME}" --json --config "${config}" > "${private}/website.json"
check_target() {
  local receipt="$1" message="$2"
  run_wrangler secret list --format json --config "${config}" > "${private}/secrets.json"
  run_wrangler deployments list --json --config "${config}" > "${private}/deployments.json"
  run_wrangler versions list --json --config "${config}" > "${private}/versions.json"
  node "${root}/scripts/check-production-cloudflare-target.mjs" \
    --identity "${private}/identity.json" --database "${private}/database.json" \
    --website-database "${private}/website.json" --secrets "${private}/secrets.json" \
    --deployments "${private}/deployments.json" --versions "${private}/versions.json" \
    --receipt "${receipt}" --expected-version-message "${message}"
}
base_message="production ${GITHUB_SHA} run ${GITHUB_RUN_ID}.${GITHUB_RUN_ATTEMPT}"
check_target "${activation}/target-before.json" "${base_message}"

# No business rows are read or exported. Unknown pre-existing schema fails closed.
query="SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name GLOB 'ai_workbench_*' AND sql IS NOT NULL ORDER BY type,name"
run_wrangler d1 execute DB --remote --json --config "${config}" --command "${query}" > "${activation}/schema-before.json"
state="$(node "${root}/scripts/check-ai-workbench-schema.mjs" before --schema "${activation}/schema-before.json" --migrations-dir "${activation}/migrations" --receipt "${activation}/plan.json")"
# Exercise the very same activation flag during dry-run and final deployment.
run_wrangler deploy --dry-run --strict --keep-vars --var OA_AI_TASKS_ENABLED:true --config "${config}"
run_wrangler d1 execute DB --remote --json --config "${config}" --command "SELECT COUNT(*) AS active_freezes FROM migration_control WHERE deactivated_at IS NULL" > "${private}/freeze.json"
node --input-type=module - "${private}/freeze.json" <<'JS'
import {readFileSync} from 'node:fs';
const data=JSON.parse(readFileSync(process.argv[2],'utf8'));
if (!Array.isArray(data)||data.length!==1||data[0].success!==true||data[0].results?.length!==1||data[0].results[0].active_freezes!==0) throw new Error('OA is frozen or freeze state is unavailable');
JS
# Whole-database Time Travel recovery point, including all task extension tables.
run_wrangler d1 time-travel info DB --json --config "${config}" > "${private}/bookmark.json"
node "${root}/scripts/check-production-d1-bookmark.mjs" "${private}/bookmark.json" "${activation}/d1-bookmark-before.json"
(cd "${activation}" && sha256sum --check migrations-sha256.txt)
if [[ "${state}" == pending ]]; then
  for name in 0002_ai_workbench.sql 0003_ai_workbench_artifacts.sql; do
    run_wrangler d1 execute DB --remote --json --config "${config}" --file "${activation}/migrations/${name}" > "${activation}/${name}.result.json"
  done
elif [[ "${state}" != applied ]]; then
  echo "Unexpected task initialization state." >&2; exit 65
fi
run_wrangler d1 execute DB --remote --json --config "${config}" --command "${query}" > "${activation}/schema-after.json"
node "${root}/scripts/check-ai-workbench-schema.mjs" after --schema "${activation}/schema-after.json" --migrations-dir "${activation}/migrations" --receipt "${activation}/schema-verified.json"
(cd "${release_root}" && sha256sum --check artifact-sha256.txt)
message="${base_message} workbench enabled"
run_wrangler deploy --strict --keep-vars --var OA_AI_TASKS_ENABLED:true --config "${config}" --message "${message}"
check_target "${activation}/target-after.json" "${message}"
# Read only the live plaintext activation binding. Never log provider responses.
CLOUDFLARE_API_TOKEN="${token}" node --input-type=module - "${activation}/activation-verified.json" <<'JS'
import {writeFileSync} from 'node:fs';
const account=encodeURIComponent(process.env.OA_PRODUCTION_CLOUDFLARE_ACCOUNT_ID);
const worker=encodeURIComponent(process.env.OA_PRODUCTION_WORKER_NAME);
const response=await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/workers/scripts/${worker}/settings`, {headers:{authorization:`Bearer ${process.env.CLOUDFLARE_API_TOKEN}`},signal:AbortSignal.timeout(20000),redirect:'error'});
if(!response.ok) throw new Error('Unable to verify the workbench activation binding');
const body=await response.json();
const bindings=body?.result?.bindings;
if(body.success!==true||!Array.isArray(bindings)) throw new Error('Invalid activation verification response');
const found=bindings.filter(binding=>binding.name==='OA_AI_TASKS_ENABLED');
if(found.length!==1||found[0].type!=='plain_text'||found[0].text!=='true') throw new Error('Workbench activation was not confirmed');
writeFileSync(process.argv[2],JSON.stringify({enabled:true,verifiedAt:new Date().toISOString(),commit:process.env.GITHUB_SHA})+'\n',{flag:'wx',mode:0o600});
JS
token=""
node "${root}/scripts/verify-production-live.mjs" --receipt "${activation}/live-smoke.json"
if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
  printf '\n### OA AI workbench activation\n- Task schema: verified\n- OA_AI_TASKS_ENABLED: verified true\n- Private task data: retained\n- Real member/model/file end-to-end acceptance: still required\n' >> "${GITHUB_STEP_SUMMARY}"
fi
echo "Workbench schema and activation verified. Real member task acceptance is still required."
