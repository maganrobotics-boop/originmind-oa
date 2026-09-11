const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const ACCOUNT_ID_PATTERN = /^[0-9a-f]{32}$/iu;
const ZERO_UUID = "00000000-0000-4000-8000-000000000000";
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/u;
const CLOUDFLARE_NAME_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;
const CRON_PATTERN = /^[0-9*,/\- ]{9,128}$/u;

const PUBLIC_LAB_AI_SERVICE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/u;

const REQUIRED_WORKER_SECRETS = Object.freeze([
  "GITHUB_OAUTH_CLIENT_SECRET",
  "FEISHU_LOGIN_APP_SECRET",
  "PUBLIC_LAB_AI_SERVICE_TOKEN",
]);

export function validatePublicLabAiServiceToken(value) {
  if (typeof value !== "string" || !PUBLIC_LAB_AI_SERVICE_TOKEN_PATTERN.test(value)) {
    throw new Error("PUBLIC_LAB_AI_SERVICE_TOKEN must be exactly 43 unpadded base64url characters");
  }
  return value;
}

function requiredText(environment, key, maximumLength = 4_096) {
  const value = typeof environment[key] === "string" ? environment[key].trim() : "";
  if (!value || value.length > maximumLength || CONTROL_CHARACTER_PATTERN.test(value)) {
    throw new Error(`${key} is required and must contain safe text`);
  }
  return value;
}

function requiredCloudflareName(environment, key, suffix) {
  const value = requiredText(environment, key, 63).toLowerCase();
  if (!CLOUDFLARE_NAME_PATTERN.test(value) || (suffix && !value.endsWith(suffix))) {
    throw new Error(`${key} must be a safe Cloudflare name${suffix ? ` ending in ${suffix}` : ""}`);
  }
  return value;
}

function requiredDatabaseId(environment, key) {
  const value = requiredText(environment, key, 64).toLowerCase();
  if (!UUID_PATTERN.test(value) || value === ZERO_UUID) {
    throw new Error(`${key} must be a real non-zero D1 UUID`);
  }
  return value;
}

function requiredAccountId(environment, key) {
  const value = requiredText(environment, key, 64).toLowerCase();
  if (!ACCOUNT_ID_PATTERN.test(value)) throw new Error(`${key} must be a 32-character Cloudflare account ID`);
  return value;
}

function requiredOrigin(environment, key, { workersDev }) {
  const value = requiredText(environment, key, 2_048);
  try {
    const parsed = new URL(value);
    if (
      parsed.protocol !== "https:"
      || parsed.port
      || parsed.pathname !== "/"
      || parsed.search
      || parsed.hash
      || parsed.username
      || parsed.password
      || parsed.hostname.endsWith(".workers.dev") !== workersDev
    ) throw new Error();
    return parsed.origin;
  } catch {
    throw new Error(`${key} must be an exact HTTPS ${workersDev ? "workers.dev" : "custom-domain"} origin`);
  }
}

function requiredStagingOrigin(environment, staging) {
  const publicOrigin = requiredOrigin(environment, "OA_STAGING_PUBLIC_ORIGIN", { workersDev: true });
  const hostname = new URL(publicOrigin).hostname;
  if (!hostname.startsWith(`${staging.workerName}.`)) {
    throw new Error(`OA_STAGING_PUBLIC_ORIGIN must belong to ${staging.workerName}`);
  }
  return publicOrigin;
}

function optionalRolePair(environment, emailKey, nameKey) {
  const emailValue = typeof environment[emailKey] === "string" ? environment[emailKey].trim() : "";
  const nameValue = typeof environment[nameKey] === "string" ? environment[nameKey].trim() : "";
  if (!emailValue && !nameValue) return {};
  if (!emailValue || !nameValue || CONTROL_CHARACTER_PATTERN.test(emailValue) || CONTROL_CHARACTER_PATTERN.test(nameValue)) {
    throw new Error(`${emailKey} and ${nameKey} must be configured together`);
  }
  const emails = emailValue.split(",").map((value) => value.trim()).filter(Boolean);
  const names = nameValue.split(",").map((value) => value.trim()).filter(Boolean);
  if (!emails.length || emails.length !== names.length) {
    throw new Error(`${emailKey} and ${nameKey} must contain matching entries`);
  }
  return { [emailKey]: emails.join(","), [nameKey]: names.join(",") };
}

export function deploymentTarget(target, environment = process.env) {
  if (target !== "staging" && target !== "production") throw new Error("Deployment target must be staging or production");
  const prefix = target === "staging" ? "OA_STAGING" : "OA_PRODUCTION";
  return Object.freeze({
    workerName: requiredCloudflareName(environment, `${prefix}_WORKER_NAME`, target === "staging" ? "-staging" : ""),
    databaseName: requiredCloudflareName(environment, `${prefix}_D1_DATABASE_NAME`, `-${target}`),
  });
}

export function productionTarget(environment = process.env) {
  const names = deploymentTarget("production", environment);
  const databaseId = requiredDatabaseId(environment, "OA_PRODUCTION_D1_DATABASE_ID");
  const websiteDatabaseName = requiredCloudflareName(environment, "OA_PRODUCTION_WEBSITE_D1_DATABASE_NAME", "");
  const websiteDatabaseId = requiredDatabaseId(environment, "OA_PRODUCTION_WEBSITE_D1_DATABASE_ID");
  if (databaseId === websiteDatabaseId || names.databaseName === websiteDatabaseName) {
    throw new Error("Production OA and website D1 targets must be distinct");
  }
  const cron = requiredText(environment, "OA_PRODUCTION_CRON", 128).replace(/\s+/gu, " ");
  if (!CRON_PATTERN.test(cron) || cron.split(" ").length !== 5) {
    throw new Error("OA_PRODUCTION_CRON must be a five-field Cloudflare cron expression");
  }
  return Object.freeze({
    ...names,
    accountId: requiredAccountId(environment, "OA_PRODUCTION_CLOUDFLARE_ACCOUNT_ID"),
    databaseId,
    websiteDatabaseName,
    websiteDatabaseId,
    publicOrigin: requiredOrigin(environment, "OA_PRODUCTION_PUBLIC_ORIGIN", { workersDev: false }),
    cron,
  });
}

function commonConfig(target) {
  return {
    $schema: "../../node_modules/wrangler/config-schema.json",
    name: target.workerName,
    main: "../../worker/standalone.ts",
    compatibility_date: "2026-05-15",
    compatibility_flags: ["nodejs_compat"],
    preview_urls: false,
    assets: {
      binding: "ASSETS",
      not_found_handling: "none",
      run_worker_first: ["/api/*", "/_vinext/*", "/__vinext/*"],
    },
    images: { binding: "IMAGES" },
    secrets: { required: [...REQUIRED_WORKER_SECRETS] },
    observability: { enabled: true },
  };
}

export function buildStandaloneConfig(target, environment = process.env) {
  if (target === "production") {
    const production = productionTarget(environment);
    return {
      ...commonConfig(production),
      account_id: production.accountId,
      workers_dev: false,
      keep_vars: true,
      // The existing custom domain remains provider-managed; route/routes are
      // deliberately absent so this deploy cannot replace that attachment.
      d1_databases: [
        {
          binding: "DB",
          database_name: production.databaseName,
          database_id: production.databaseId,
          migrations_dir: "../../drizzle",
        },
        {
          binding: "WEBSITE_DB",
          database_name: production.websiteDatabaseName,
          database_id: production.websiteDatabaseId,
        },
      ],
      // --keep-vars preserves every provider-managed value. This one canonical
      // non-secret is intentionally asserted from the protected GitHub variable.
      vars: { OA_PUBLIC_ORIGIN: production.publicOrigin },
      triggers: { crons: [production.cron] },
    };
  }
  if (target !== "staging") throw new Error("Only staging or production standalone targets may be generated");

  const staging = deploymentTarget("staging", environment);
  const databaseId = requiredDatabaseId(environment, "OA_STAGING_D1_DATABASE_ID");
  const accountId = requiredAccountId(environment, "OA_STAGING_CLOUDFLARE_ACCOUNT_ID");
  const publicOrigin = requiredStagingOrigin(environment, staging);

  const githubClientId = requiredText(environment, "GITHUB_OAUTH_CLIENT_ID", 128);
  if (!/^[A-Za-z0-9_-]{12,128}$/u.test(githubClientId)) throw new Error("GITHUB_OAUTH_CLIENT_ID has an invalid format");
  const feishuAppId = requiredText(environment, "FEISHU_LOGIN_APP_ID", 128);
  const feishuTenantKey = requiredText(environment, "FEISHU_LOGIN_TENANT_KEY", 128);
  if (!/^[A-Za-z0-9_-]{4,128}$/u.test(feishuAppId) || !/^[A-Za-z0-9_-]{4,128}$/u.test(feishuTenantKey)) {
    throw new Error("Feishu staging identifiers have an invalid format");
  }
  const privilegedRoleVars = {
    ...optionalRolePair(environment, "OA_ADMIN_EMAILS", "OA_ADMIN_NAMES"),
    ...optionalRolePair(environment, "OA_PROJECT_OWNER_EMAILS", "OA_PROJECT_OWNER_NAMES"),
    ...optionalRolePair(environment, "OA_FINANCE_OWNER_EMAILS", "OA_FINANCE_OWNER_NAMES"),
  };
  if (!privilegedRoleVars.OA_ADMIN_EMAILS) throw new Error("OA_ADMIN_EMAILS and OA_ADMIN_NAMES are required for staging bootstrap");

  return {
    ...commonConfig(staging),
    account_id: accountId,
    workers_dev: true,
    d1_databases: [{
      binding: "DB",
      database_name: staging.databaseName,
      database_id: databaseId,
      migrations_dir: "../../drizzle",
    }],
    vars: {
      OA_PUBLIC_ORIGIN: publicOrigin,
      CHATGPT_LOGIN_ENABLED: "false",
      GITHUB_LOGIN_ENABLED: "true",
      GITHUB_OAUTH_CLIENT_ID: githubClientId,
      FEISHU_LOGIN_ENABLED: "true",
      FEISHU_LOGIN_APP_ID: feishuAppId,
      FEISHU_LOGIN_TENANT_KEY: feishuTenantKey,
      FEISHU_PDF_ARCHIVE_ENABLED: "true",
      OA_MIGRATION_EXPORT_ENABLED: "false",
      OA_MIGRATION_WRITE_FROZEN: "false",
      OA_MIGRATION_UNFREEZE_ENABLED: "false",
      ...privilegedRoleVars,
    },
  };
}

export const requiredStandaloneSecrets = REQUIRED_WORKER_SECRETS;
