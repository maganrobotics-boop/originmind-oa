#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/originmind-chat-email-webhook}"
ENV_FILE="${ENV_FILE:-/etc/originmind-chat-email-webhook.env}"
SERVICE_FILE="/etc/systemd/system/originmind-chat-email-webhook.service"
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run as root: sudo APP_DIR=${APP_DIR} ENV_FILE=${ENV_FILE} $0" >&2
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is required on this server." >&2
  exit 1
fi

install -d -m 0755 "${APP_DIR}"
install -m 0644 "${SCRIPT_DIR}/server.mjs" "${APP_DIR}/server.mjs"
install -m 0644 "${SCRIPT_DIR}/originmind-chat-email-webhook.service" "${SERVICE_FILE}"

if [[ ! -f "${ENV_FILE}" ]]; then
  umask 077
  cat >"${ENV_FILE}" <<'ENV'
PORT=8789
EMAIL_CODE_WEBHOOK_TOKEN=
SMTP_HOST=smtp.exmail.qq.com
SMTP_PORT=465
SMTP_USER=magan@sztu.edu.cn
SMTP_PASS=
SMTP_FROM=magan@sztu.edu.cn
ENV
  echo "Created ${ENV_FILE}. Fill EMAIL_CODE_WEBHOOK_TOKEN and SMTP_PASS before starting."
else
  chmod 0600 "${ENV_FILE}"
fi

systemctl daemon-reload
systemctl enable originmind-chat-email-webhook.service

if grep -q '^EMAIL_CODE_WEBHOOK_TOKEN=$' "${ENV_FILE}" || grep -q '^SMTP_PASS=$' "${ENV_FILE}"; then
  echo "Service installed but not started because ${ENV_FILE} still has empty secrets."
  exit 0
fi

systemctl restart originmind-chat-email-webhook.service
systemctl --no-pager --full status originmind-chat-email-webhook.service