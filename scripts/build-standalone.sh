#!/usr/bin/env bash
set -euo pipefail

target="${1:-}"
if [[ "${target}" != "staging" && "${target}" != "production" ]]; then
  echo "Only the staging or production standalone target may be built." >&2
  exit 64
fi

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
project_root="$(cd "${script_dir}/.." && pwd)"
config_path="$(node "${script_dir}/generate-standalone-config.mjs" "${target}")"

export CLOUDFLARE_VITE_WRANGLER_CONFIG_PATH="${config_path}"
bash "${script_dir}/build-verified.sh"
node "${script_dir}/check-standalone-output.mjs" "${target}"