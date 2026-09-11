import { createHash } from "node:crypto";

import { requiredStandaloneSecrets } from "./standalone-config.mjs";

export const PRODUCTION_MIGRATION_NAME = "0027_careless_winter_soldier.sql";
export const PRODUCTION_MIGRATION_SHA256 = "a5648c380df4bafff324bdd088861e561baf6ed61cfc4c5f5ff0706951f5beaa";
export const REVIEWED_KNOWLEDGE_MIGRATIONS = Object.freeze({
  "0026_rich_jocasta.sql": "51878069d3f62b3d291002bfe1fb8f0b129ee58493109bfb8c57befb99fb2194",
  [PRODUCTION_MIGRATION_NAME]: PRODUCTION_MIGRATION_SHA256,
});

function exactObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value;
}

function exactArray(value, label) {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value;
}

export function d1QueryRows(payload, label) {
  const results = exactArray(payload, label);
  if (results.length !== 1) throw new Error(`${label} must contain exactly one query result`);
  const result = exactObject(results[0], `${label} result`);
  if (result.success !== true || !Array.isArray(result.results)) throw new Error(`${label} query did not succeed`);
  return result.results.map((row) => exactObject(row, `${label} row`));
}

function normalizeCount(value, label) {
  const count = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(count) || count < 0) throw new Error(`${label} must be a non-negative integer`);
  return count;
}

function migrationNames(ledgerPayload) {
  return d1QueryRows(ledgerPayload, "Production migration ledger").map((row, index) => {
    if (normalizeCount(row.id, "Migration id") !== index + 1 || typeof row.name !== "string" || !row.name) {
      throw new Error("Production migration ledger is malformed");
    }
    return row.name;
  });
}

function activeFreezeCount(freezePayload) {
  const rows = d1QueryRows(freezePayload, "Production migration freeze query");
  if (rows.length !== 1 || Object.keys(rows[0]).length !== 1 || !("active_freezes" in rows[0])) {
    throw new Error("Production migration freeze result is malformed");
  }
  return normalizeCount(rows[0].active_freezes, "Active migration freeze count");
}

function sameStrings(actual, expected) {
  return JSON.stringify(actual) === JSON.stringify(expected);
}

function normalizeSchemaSql(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} is missing SQL`);
  return value.trim().replace(/;\s*$/u, "").replace(/\s+/gu, " ");
}

function validateReviewedMigrationSql(migrationSqlByName) {
  const sqlByName = exactObject(migrationSqlByName, "Reviewed production migration SQL");
  for (const [name, expectedDigest] of Object.entries(REVIEWED_KNOWLEDGE_MIGRATIONS)) {
    const sql = sqlByName[name];
    if (typeof sql !== "string") throw new Error(`${name} is missing`);
    const digest = createHash("sha256").update(sql).digest("hex");
    if (digest !== expectedDigest) throw new Error(`${name} does not match the reviewed SHA-256`);
  }
  return sqlByName;
}

export function validateProductionMigrationManifest({ migrationNames: names, migrationSqlByName }) {
  const migrationFiles = exactArray(names, "Production migration files");
  if (
    migrationFiles.length !== 28
    || migrationFiles.at(-1) !== PRODUCTION_MIGRATION_NAME
    || new Set(migrationFiles).size !== migrationFiles.length
    || migrationFiles.some((name, index) => (
      typeof name !== "string"
      || !/^\d{4}_[A-Za-z0-9_]+\.sql$/u.test(name)
      || !name.startsWith(`${String(index).padStart(4, "0")}_`)
    ))
  ) throw new Error(`The release must contain only the exact migrations 0000 through ${PRODUCTION_MIGRATION_NAME}`);
  validateReviewedMigrationSql(migrationSqlByName);
  return [...migrationFiles];
}

export function productionKnowledgeDefinitions(migrationSqlByName, names = Object.keys(REVIEWED_KNOWLEDGE_MIGRATIONS)) {
  const sqlByName = validateReviewedMigrationSql(migrationSqlByName);
  const definitions = {};
  for (const name of names) {
    if (!(name in REVIEWED_KNOWLEDGE_MIGRATIONS)) throw new Error(`Unreviewed knowledge migration ${name}`);
    for (const statement of sqlByName[name].split(/--> statement-breakpoint\s*/u).map((value) => value.trim()).filter(Boolean)) {
      const match = statement.match(/^CREATE\s+(?:UNIQUE\s+)?(TABLE|INDEX|TRIGGER)\s+`(knowledge_[^`]+)`/iu);
      if (!match) continue;
      const key = `${match[1].toLowerCase()}:${match[2]}`;
      if (definitions[key]) throw new Error(`Duplicate knowledge schema definition ${key}`);
      definitions[key] = normalizeSchemaSql(statement, key);
    }
  }
  const expectedCount = names.includes(PRODUCTION_MIGRATION_NAME) ? 39 : 27;
  if (Object.keys(definitions).length !== expectedCount) throw new Error("Knowledge migrations must contain the exact reviewed schema definitions");
  return definitions;
}

export function validateD1Bookmark(payload) {
  const bookmark = exactObject(payload, "D1 Time Travel response").bookmark;
  if (typeof bookmark !== "string" || !/^[A-Za-z0-9._~+/:=-]{1,1024}$/u.test(bookmark)) {
    throw new Error("D1 Time Travel response is missing a safe recovery bookmark");
  }
  return bookmark;
}

export function validateProductionMigrationState({
  phase,
  ledgerPayload,
  freezePayload,
  schemaPayload,
  expectedMigrationNames,
  expectedSchemaObjects,
  expectedKnowledgeDefinitions,
  previousKnowledgeDefinitions,
}) {
  if (phase !== "before" && phase !== "after") throw new Error("Migration validation phase must be before or after");
  const expectedNames = exactArray(expectedMigrationNames, "Expected migration names");
  if (
    expectedNames.length !== 28
    || expectedNames.at(-1) !== PRODUCTION_MIGRATION_NAME
    || new Set(expectedNames).size !== expectedNames.length
    || expectedNames.some((name, index) => (
      typeof name !== "string"
      || !/^\d{4}_[A-Za-z0-9_]+\.sql$/u.test(name)
      || !name.startsWith(`${String(index).padStart(4, "0")}_`)
    ))
  ) throw new Error(`The release must contain exactly migrations 0000 through ${PRODUCTION_MIGRATION_NAME}`);

  if (activeFreezeCount(freezePayload) !== 0) throw new Error("Production database has an active migration freeze");

  const appliedNames = migrationNames(ledgerPayload);
  if (new Set(appliedNames).size !== appliedNames.length) throw new Error("Production migration ledger contains duplicate names");
  const expectedObjects = [...new Set(exactArray(expectedSchemaObjects, "Expected schema objects"))].sort();
  const schemaRows = d1QueryRows(schemaPayload, "Production schema query");
  const actualObjects = schemaRows.map((row) => {
    if (!["index", "table", "trigger"].includes(row.type) || typeof row.name !== "string" || !row.name) {
      throw new Error("Production schema query contains an invalid object");
    }
    return `${row.type}:${row.name}`;
  }).sort();
  if (new Set(actualObjects).size !== actualObjects.length) throw new Error("Production schema query contains duplicate objects");
  const notificationObjects = [
    "index:notification_outbox_due",
    "table:notification_control",
    "table:notification_outbox",
  ];
  for (const objectName of notificationObjects) {
    if (!actualObjects.includes(objectName)) throw new Error(`Production notification schema is missing ${objectName}`);
  }
  const assertDefinitions = (definitionsValue, expectedObjectsValue, label) => {
    const definitions = exactObject(definitionsValue, `${label} definitions`);
    const knowledgeObjects = actualObjects.filter((name) => name.includes(":knowledge_"));
    if (!sameStrings(actualObjects, expectedObjectsValue)) throw new Error(`Production ${label} schema does not match the release`);
    if (!sameStrings(Object.keys(definitions).sort(), knowledgeObjects)) {
      throw new Error(`Expected knowledge schema definitions do not match ${label}`);
    }
    for (const row of schemaRows) {
      const key = `${row.type}:${row.name}`;
      if (!knowledgeObjects.includes(key)) continue;
      if (normalizeSchemaSql(row.sql, key) !== definitions[key]) {
        throw new Error(`Production schema SQL does not match ${label} for ${key}`);
      }
    }
  };

  if (phase === "before" && sameStrings(appliedNames, expectedNames.slice(0, -2))) {
    if (!sameStrings(actualObjects, [...notificationObjects].sort())) {
      throw new Error("Production pre-migration schema contains unexpected or missing objects");
    }
    return "pending-0026-0027";
  }

  if (phase === "before" && sameStrings(appliedNames, expectedNames.slice(0, -1))) {
    const previousDefinitions = exactObject(previousKnowledgeDefinitions, "Migration 0026 knowledge schema definitions");
    const previousObjects = [...notificationObjects, ...Object.keys(previousDefinitions)].sort();
    assertDefinitions(previousDefinitions, previousObjects, "migration 0026");
    return "pending-0027";
  }

  if (!sameStrings(appliedNames, expectedNames)) {
    throw new Error(`Production migration ledger must end exactly at ${phase === "before" ? "0025, 0026, or 0027" : "0027"}`);
  }
  assertDefinitions(expectedKnowledgeDefinitions, expectedObjects, "migration 0027");
  return "applied";
}

function accountIds(identity) {
  return Array.isArray(identity.accounts)
    ? identity.accounts.flatMap((account) => typeof account?.id === "string" ? [account.id] : [])
    : [];
}

function assertDatabase(details, expectedName, expectedId, label) {
  const database = exactObject(details, label);
  if (database.name !== expectedName || database.uuid !== expectedId) {
    throw new Error(`${label} does not match the authorized production target`);
  }
}

function requiredString(value, label) {
  if (typeof value !== "string" || !value.trim() || value.length > 512) throw new Error(`${label} must be a non-empty string`);
  return value;
}

function sanitizeDeployment(value) {
  const deployment = exactObject(value, "Cloudflare deployment");
  const versions = exactArray(deployment.versions, "Cloudflare deployment versions").map((entry) => {
    const version = exactObject(entry, "Cloudflare deployment version");
    const percentage = Number(version.percentage);
    if (!Number.isFinite(percentage) || percentage < 0 || percentage > 100) {
      throw new Error("Cloudflare deployment version percentage is invalid");
    }
    return { versionId: requiredString(version.version_id, "Cloudflare deployment version id"), percentage };
  });
  if (!versions.length) throw new Error("Cloudflare deployment has no versions");
  return {
    id: requiredString(deployment.id, "Cloudflare deployment id"),
    createdOn: requiredString(deployment.created_on, "Cloudflare deployment creation time"),
    versions,
  };
}

function sanitizeVersion(value) {
  const version = exactObject(value, "Cloudflare Worker version");
  const metadata = exactObject(version.metadata, "Cloudflare Worker version metadata");
  const annotations = version.annotations && typeof version.annotations === "object" && !Array.isArray(version.annotations)
    ? version.annotations
    : {};
  const message = annotations["workers/message"];
  if (message !== undefined && typeof message !== "string") throw new Error("Cloudflare Worker version message is invalid");
  return {
    id: requiredString(version.id, "Cloudflare Worker version id"),
    createdOn: requiredString(metadata.created_on, "Cloudflare Worker version creation time"),
    ...(message ? { message } : {}),
  };
}

export function validateProductionCloudflareSnapshot({
  target,
  identity,
  primaryDatabase,
  websiteDatabase,
  secrets,
  deployments,
  versions,
  expectedVersionMessage,
}) {
  const production = exactObject(target, "Expected production target");
  const identityObject = exactObject(identity, "Cloudflare identity");
  if (identityObject.loggedIn !== true || !accountIds(identityObject).includes(production.accountId)) {
    throw new Error("Cloudflare token is not authorized for the configured production account");
  }
  assertDatabase(primaryDatabase, production.databaseName, production.databaseId, "Primary D1");
  assertDatabase(websiteDatabase, production.websiteDatabaseName, production.websiteDatabaseId, "Website D1");

  const secretNames = exactArray(secrets, "Cloudflare secret list").map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry) || typeof entry.name !== "string") {
      throw new Error("Cloudflare secret list contains an invalid entry");
    }
    return entry.name;
  }).sort();
  if (new Set(secretNames).size !== secretNames.length) throw new Error("Cloudflare secret list contains duplicate names");
  for (const required of requiredStandaloneSecrets) {
    if (!secretNames.includes(required)) throw new Error(`Cloudflare Worker is missing required secret ${required}`);
  }
  const deploymentList = exactArray(deployments, "Cloudflare deployment list").map(sanitizeDeployment)
    .sort((left, right) => left.createdOn.localeCompare(right.createdOn));
  const versionList = exactArray(versions, "Cloudflare version list").map(sanitizeVersion)
    .sort((left, right) => left.createdOn.localeCompare(right.createdOn));
  if (!deploymentList.length || !versionList.length) throw new Error("The production Worker has no rollback point");
  let releasedVersionId;
  if (expectedVersionMessage !== undefined) {
    requiredString(expectedVersionMessage, "Expected production version message");
    const releasedVersions = versionList.filter((version) => version.message === expectedVersionMessage);
    const releasedVersion = releasedVersions[0];
    if (releasedVersions.length !== 1 || versionList.at(-1)?.id !== releasedVersion?.id) {
      throw new Error("The newest production version does not uniquely identify the released run");
    }
    const latestDeployment = deploymentList.at(-1);
    if (
      latestDeployment.versions.length !== 1
      || latestDeployment.versions[0].versionId !== releasedVersion.id
      || latestDeployment.versions[0].percentage !== 100
    ) {
      throw new Error("The released Worker version is not the newest 100% production deployment");
    }
    releasedVersionId = releasedVersion.id;
  }

  return {
    accountId: production.accountId,
    workerName: production.workerName,
    primaryDatabaseId: production.databaseId,
    websiteDatabaseId: production.websiteDatabaseId,
    publicOrigin: production.publicOrigin,
    secretNames,
    deploymentCount: deploymentList.length,
    versionCount: versionList.length,
    deployments: deploymentList,
    versions: versionList,
    ...(releasedVersionId ? { releasedVersionId } : {}),
  };
}
