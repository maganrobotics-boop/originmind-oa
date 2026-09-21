import { getD1Database, getDb } from "../../../db";
import { DEPARTMENT_REQUEST_BYTES, parseAssignDepartmentInput, parseCreateDepartmentInput } from "../../../lib/department-contract.mjs";
import { readBoundedJsonObject } from "../../../lib/bounded-json-request";
import { consumeWriteRateLimit } from "../../../lib/write-rate-limit";
import { getAuthorizedUser, isNdaAdmittedMember } from "../_lib/auth";

const headers = { "cache-control": "private, no-store, max-age=0", "x-content-type-options": "nosniff" };
const json = (body: unknown, status = 200, extraHeaders?: HeadersInit) => Response.json(body, { status, headers: { ...headers, ...extraHeaders } });
const sameOrigin = (request: Request) => {
  const origin = request.headers.get("origin");
  return (!origin || origin === new URL(request.url).origin) && request.headers.get("sec-fetch-site") !== "cross-site";
};
const isJson = (request: Request) => request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() === "application/json";

type DepartmentRow = {
  id: string;
  code: string;
  name: string;
  parent_id: string | null;
  sort_order: number;
  member_id: string | null;
};

async function memberActor(requireAdmin = false) {
  const authorized = await getAuthorizedUser();
  if (!authorized?.ndaCompleted || !authorized.memberId || !authorized.accountUserId || !authorized.memberMutationRevision) return null;
  if (requireAdmin && !authorized.isAdmin) return null;
  return authorized;
}

export async function GET() {
  const authorized = await memberActor();
  if (!authorized) return json({ error: "请先完成 OA 准入和保密协议。" }, 403);
  try {
    const result = await (await getD1Database()).prepare(`SELECT d.id,d.code,d.name,d.parent_id,d.sort_order,dm.member_id
      FROM departments d
      LEFT JOIN department_memberships dm ON dm.department_id=d.id AND dm.left_at IS NULL
      WHERE d.status='active'
      ORDER BY d.sort_order ASC,d.name ASC,d.id ASC,dm.member_id ASC`).all<DepartmentRow>();
    const departments = new Map<string, { id: string; code: string; name: string; parentId: string | null; sortOrder: number; memberIds: string[] }>();
    for (const row of result.results) {
      const department = departments.get(row.id) ?? { id: row.id, code: row.code, name: row.name, parentId: row.parent_id, sortOrder: row.sort_order, memberIds: [] };
      if (row.member_id && authorized.isAdmin) department.memberIds.push(row.member_id);
      departments.set(row.id, department);
    }
    return json({ departments: [...departments.values()], canManage: authorized.isAdmin });
  } catch {
    return json({ error: "部门目录暂不可用。" }, 503);
  }
}

async function writeRequest(request: Request) {
  const authorized = await memberActor(true);
  if (!authorized) return { response: json({ error: "只有系统管理员可以调整部门。" }, 403) } as const;
  if (!sameOrigin(request)) return { response: json({ error: "请在 OA 内调整部门。" }, 403) } as const;
  if (!isJson(request)) return { response: json({ error: "请求格式不正确。" }, 415) } as const;
  const parsedBody = await readBoundedJsonObject(request, DEPARTMENT_REQUEST_BYTES);
  if (!parsedBody.ok) return { response: json({ error: "部门请求内容不正确。" }, parsedBody.reason === "too_large" ? 413 : 400) } as const;
  const db = await getDb();
  if (!(await consumeWriteRateLimit(db, { actorSubject: authorized.accountUserId!, scope: "department_admin", limit: 60 }))) {
    return { response: json({ error: "部门调整过于频繁，请稍后再试。" }, 429, { "retry-after": "60" }) } as const;
  }
  return { authorized, value: parsedBody.value } as const;
}

export async function POST(request: Request) {
  const context = await writeRequest(request);
  if ("response" in context) return context.response;
  const input = parseCreateDepartmentInput(context.value);
  if (!input) return json({ error: "部门名称、编码或上级部门不正确。" }, 400);
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  try {
    const created = await (await getD1Database()).prepare(`INSERT INTO departments(id,code,name,parent_id,status,sort_order,created_by_member_id,created_at,updated_at)
      SELECT ?,?,?,?,'active',COALESCE((SELECT MAX(sort_order)+10 FROM departments),10),?,?,?
      FROM members actor
      WHERE actor.id=? AND actor.account_user_id=? AND actor.mutation_revision=? AND actor.status='active'
        AND (? IS NULL OR EXISTS (SELECT 1 FROM departments parent WHERE parent.id=? AND parent.status='active'))
      RETURNING id,code,name,parent_id,sort_order`)
      .bind(id, input.code, input.name, input.parentId, context.authorized.memberId!, now, now,
        context.authorized.memberId!, context.authorized.accountUserId!, context.authorized.memberMutationRevision!, input.parentId, input.parentId)
      .first<{ id: string; code: string; name: string; parent_id: string | null; sort_order: number }>();
    if (!created) return json({ error: "管理员状态或上级部门刚刚发生变化，请刷新后重试。" }, 409);
    return json({ department: { id: created.id, code: created.code, name: created.name, parentId: created.parent_id, sortOrder: created.sort_order, memberIds: [] } }, 201);
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    return /UNIQUE constraint failed/iu.test(message)
      ? json({ error: "部门编码已存在。" }, 409)
      : json({ error: "部门创建失败。" }, 503);
  }
}

export async function PATCH(request: Request) {
  const context = await writeRequest(request);
  if ("response" in context) return context.response;
  const input = parseAssignDepartmentInput(context.value);
  if (!input) return json({ error: "部门归属请求不正确。" }, 400);
  const d1 = await getD1Database();
  const target = await d1.prepare(`SELECT id,chatgpt_account,account_user_id,role,permissions_json,nda_accepted_at,nda_agreement_version,mutation_revision,status
    FROM members WHERE id=? LIMIT 1`).bind(input.memberId).first<{
      id: string; chatgpt_account: string; account_user_id: string | null; role: string; permissions_json: string;
      nda_accepted_at: string | null; nda_agreement_version: string | null; mutation_revision: string; status: string;
    }>();
  if (!target || target.status !== "active" || !isNdaAdmittedMember({
    chatgptAccount: target.chatgpt_account,
    accountUserId: target.account_user_id,
    role: target.role,
    permissionsJson: target.permissions_json,
    ndaAcceptedAt: target.nda_accepted_at,
    ndaAgreementVersion: target.nda_agreement_version,
  })) return json({ error: "成员不存在、未完成准入或状态已变化。" }, 409);

  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  try {
    const results = await d1.batch([
      d1.prepare("UPDATE department_memberships SET left_at=? WHERE member_id=? AND membership_type='primary' AND left_at IS NULL")
        .bind(now, input.memberId),
      d1.prepare(`INSERT INTO department_memberships(id,department_id,member_id,membership_type,title,joined_at,left_at,created_by_member_id)
        SELECT ?,?,?,'primary',?,?,NULL,
          CASE WHEN EXISTS (
            SELECT 1 FROM departments d,members target,members actor
            WHERE d.id=? AND d.status='active'
              AND target.id=? AND target.status='active' AND target.mutation_revision=?
              AND target.account_user_id=? AND target.nda_accepted_at=? AND target.nda_agreement_version=?
              AND actor.id=? AND actor.status='active' AND actor.account_user_id=? AND actor.mutation_revision=?
          ) THEN ? ELSE NULL END
        RETURNING id,department_id,member_id,membership_type,title,joined_at`)
        .bind(id, input.departmentId, input.memberId, input.title, now,
          input.departmentId, target.id, target.mutation_revision, target.account_user_id, target.nda_accepted_at, target.nda_agreement_version,
          context.authorized.memberId!, context.authorized.accountUserId!, context.authorized.memberMutationRevision!, context.authorized.memberId!),
    ]);
    const assigned = results[1]?.results?.[0] as Record<string, unknown> | undefined;
    if (!assigned) return json({ error: "部门、成员或管理员状态刚刚发生变化，请刷新后重试。" }, 409);
    return json({ membership: {
      id: assigned.id,
      departmentId: assigned.department_id,
      memberId: assigned.member_id,
      membershipType: assigned.membership_type,
      title: assigned.title,
      joinedAt: assigned.joined_at,
    } });
  } catch {
    return json({ error: "部门归属保存失败，请刷新后重试。" }, 409);
  }
}
