import { getD1Database } from "../../../../db";
import {
  buildMigrationPayload,
  assertMigrationAdministratorCanReenter,
  canonicalJson,
  encryptMigrationPayload,
  getMigrationExportConfig,
  isMigrationExportWindowOpen,
  MIGRATION_EXPORT_TABLES,
  migrationFreezeMarkerSelectSql,
  migrationArchiveActivitySelectSql,
  migrationExportSelectSql,
  migrationSchemaSelectSql,
} from "../../../../lib/migration-export.mjs";
import { migrationWriteFreezeId } from "../../../../lib/migration-freeze";
import { getAuthorizedUser } from "../../_lib/auth";
import { migrationSourceLedgerStatement } from "../../../../lib/migration-source-ledger.mjs";

function responseHeaders(contentType = "application/json; charset=utf-8") {
  return {
    "cache-control": "private, no-store, max-age=0",
    "content-type": contentType,
    "cross-origin-resource-policy": "same-origin",
    pragma: "no-cache",
    vary: "Cookie, Origin",
    "x-content-type-options": "nosniff",
  };
}

function jsonError(message: string, status: number) {
  return Response.json({ error: message }, { status, headers: responseHeaders() });
}

function requestIsSameOrigin(request: Request) {
  const requestOrigin = new URL(request.url).origin;
  const origin = request.headers.get("origin");
  const fetchSite = request.headers.get("sec-fetch-site");
  return origin === requestOrigin && (!fetchSite || fetchSite === "same-origin");
}

export async function POST(request: Request) {
  if (!isMigrationExportWindowOpen()) return jsonError("未找到。", 404);
  if (!requestIsSameOrigin(request)) return jsonError("迁移下载请求来源无效。", 403);
  const contentLength = Number(request.headers.get("content-length") || "0");
  if (!Number.isFinite(contentLength) || contentLength < 0 || contentLength > 1_024) return jsonError("迁移下载请求无效。", 413);

  const authorized = await getAuthorizedUser({ readOnly: true });
  if (!authorized?.isAdmin || !authorized.memberId || !authorized.accountUserId || !authorized.ndaCompleted) return jsonError("只有已完成保密准入的 OA 管理员可以下载迁移包。", 403);

  try {
    const config = getMigrationExportConfig();
    const requestOrigin = new URL(request.url).origin;
    if (!config || config.sourceOrigin !== requestOrigin) return jsonError("迁移下载源站配置不匹配。", 503);
    const database = await getD1Database();

    const freezeId = migrationWriteFreezeId(process.env);
    const statements = [
      await migrationSourceLedgerStatement(database),
      database.prepare(migrationSchemaSelectSql()),
      database.prepare(migrationFreezeMarkerSelectSql()).bind(freezeId),
      database.prepare(migrationArchiveActivitySelectSql()),
      ...MIGRATION_EXPORT_TABLES.map((table) => database.prepare(migrationExportSelectSql(table))),
    ];
    const batchResults = await database.batch(statements);
    const payload = await buildMigrationPayload({
      sourceOrigin: requestOrigin,
      authKey: config.authKey,
      freezeId: config.freezeId,
      notBefore: config.notBefore,
      notAfter: config.notAfter,
      expectedSchemaSha256: config.expectedSchemaSha256,
      batchResults,
    });
    assertMigrationAdministratorCanReenter(payload, authorized.memberId, authorized.accountUserId);
    const envelope = await encryptMigrationPayload(payload, config.publicKeyJwk);
    const body = canonicalJson(envelope);
    if (new URL(request.url).searchParams.get("delivery") === "connector") {
      // Temporary encrypted transport for browsers without file downloads.
      // This auxiliary table is not business data and has no public read route.
      const chunks: Array<[number, string]> = [];
      for (let offset = 0; offset < body.length; offset += 750) chunks.push([chunks.length, body.slice(offset, offset + 750)]);
      const writes = [
        database.prepare("CREATE TABLE IF NOT EXISTS migration_export_chunks (freeze_id TEXT NOT NULL, part INTEGER NOT NULL, encrypted_content TEXT NOT NULL, PRIMARY KEY (freeze_id, part))"),
        database.prepare("DELETE FROM migration_export_chunks WHERE freeze_id = ?").bind(config.freezeId),
      ];
      for (let offset = 0; offset < chunks.length; offset += 1000) {
        writes.push(database.prepare("INSERT INTO migration_export_chunks (freeze_id, part, encrypted_content) SELECT ?, json_extract(value, '$[0]'), json_extract(value, '$[1]') FROM json_each(?)").bind(config.freezeId, JSON.stringify(chunks.slice(offset, offset + 1000))));
      }
      await database.batch(writes);
      return new Response(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>加密迁移包已准备</title><h1>加密迁移包已准备</h1><p>已生成 ${chunks.length} 个加密片段，可通过站点所有者的数据连接读取。</p><p>OA 业务记录保持只读。</p></html>`, { headers: responseHeaders("text/html; charset=utf-8") });
    }
    const timestamp = payload.exportedAt.replace(/[-:]/gu, "").replace(/\.\d{3}Z$/u, "Z");
    const inline = new URL(request.url).searchParams.get("delivery") === "inline";
    const headers = new Headers(responseHeaders(inline ? "application/json; charset=utf-8" : "application/vnd.originmind.oa-migration+json"));
    headers.set("content-disposition", `${inline ? "inline" : "attachment"}; filename="originmind-oa-migration-${timestamp}.json.enc"`);
    return new Response(body, { status: 200, headers });
  } catch (error) {
    console.error("OA migration export validation failed", error instanceof Error ? error.message : "Unknown validation failure");
    return jsonError("迁移包生成失败，请保持页面开启并联系维护人员。", 500);
  }
}
