import { and, eq, exists } from "drizzle-orm";
import { getDb } from "../../../../db";
import { memberSessions, members, oauthSessions } from "../../../../db/schema";
import { conditionalMemberEvent } from "../../../../lib/workflow-write-store";
import { readBoundedJsonObject } from "../../../../lib/bounded-json-request";
import { administratorApprovalNeedsDepartment, memberDepartmentLabel, shouldResetConfidentialityForProjectOwnerPromotion, validateMemberDepartmentInput } from "../../../../lib/member-attributes";
import { authorizedMemberGuard, getAuthorizedUser, isAdministrator, parseMemberPermissions, type MemberPermission } from "../../_lib/auth";

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const authorized = await getAuthorizedUser();
  if (!authorized?.isAdmin) return Response.json({ error: "只有 OA 管理员本人可以审核成员注册。" }, { status: 403 });
  if (!authorized.ndaCompleted) return Response.json({ error: "请先签署并归档《项目负责人保密承诺书》。" }, { status: 403 });
  if (request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "application/json") return Response.json({ error: "成员处理数据必须使用 JSON 格式。" }, { status: 415 });
  const parsedBody = await readBoundedJsonObject(request, 16_384);
  if (!parsedBody.ok) return Response.json({ error: parsedBody.reason === "too_large" ? "成员处理数据过大。" : "成员处理数据格式不正确。" }, { status: parsedBody.reason === "too_large" ? 413 : 400 });
  const body: { action?: string; permissions?: unknown; departmentCode?: unknown } = parsedBody.value;
  if (!body.action || !["approve", "reject", "update_permissions"].includes(body.action)) return Response.json({ error: "不支持的成员处理动作。" }, { status: 400 });
  const rawPermissions = body.permissions as unknown;
  const permissionsProvided = rawPermissions !== undefined;
  const departmentInput = validateMemberDepartmentInput(body.departmentCode, authorized.canGrantMemberPermissions);
  if (rawPermissions !== undefined && !Array.isArray(rawPermissions)) return Response.json({ error: "成员权限选项无效。" }, { status: 400 });
  if (!authorized.canGrantMemberPermissions && body.action === "update_permissions") return Response.json({ error: "只有管理员本人可以修改成员权限。" }, { status: 403 });
  if (!authorized.canGrantMemberPermissions && body.action === "approve" && Array.isArray(rawPermissions) && rawPermissions.length > 0) return Response.json({ error: "只有管理员本人可以授予成员权限。" }, { status: 403 });
  if (!departmentInput.ok) return Response.json({ error: departmentInput.reason === "forbidden" ? "只有管理员本人可以设置成员部门。" : "成员部门选项无效。" }, { status: departmentInput.reason === "forbidden" ? 403 : 400 });
  const permissions = Array.from(new Set((Array.isArray(rawPermissions) ? rawPermissions : []).filter((permission): permission is MemberPermission => permission === "technical_advisor" || permission === "project_owner")));
  if (Array.isArray(rawPermissions) && permissions.length !== rawPermissions.length) return Response.json({ error: "成员权限选项无效。" }, { status: 400 });
  const { id } = await params;
  const db = await getDb();
  const [member] = await db.select().from(members).where(eq(members.id, id)).limit(1);
  if (!member) return Response.json({ error: "成员申请不存在。" }, { status: 404 });
  if (member.id === authorized.memberId || member.accountUserId === authorized.accountUserId || member.chatgptAccount.trim().toLowerCase() === authorized.user.email.trim().toLowerCase()) return Response.json({ error: "审核人与申请成员必须是不同的实名账号，不能审核或修改自己的成员资格。" }, { status: 403 });
  if (administratorApprovalNeedsDepartment(body.action, authorized.canGrantMemberPermissions, departmentInput.provided, member.departmentCode)) return Response.json({ error: "管理员通过成员申请前必须选择所属部门。" }, { status: 400 });
  if (body.action === "approve" && !member.accountUserId) return Response.json({ error: "该成员尚未绑定受支持的认证账户主体，请让成员重新登录并提交账户绑定申请。" }, { status: 409 });
  const accountRebindReviewRequired = member.status === "pending" && (member.accountBindingPreviousStatus === "active" || member.accountBindingPreviousStatus === "departed");
  if (accountRebindReviewRequired && (body.action === "approve" || body.action === "reject") && !authorized.isAdmin) return Response.json({ error: "历史成员的认证账户主体重新绑定只能由管理员核验；原权限和保密协议准入不会自动继承。" }, { status: 403 });

  const reviewedIdentityNumber = accountRebindReviewRequired ? member.pendingIdentityNumber || member.identityNumber : member.identityNumber;
  if (body.action === "approve" && reviewedIdentityNumber) {
    const [claimedIdentity] = await db.select({ id: members.id }).from(members).where(and(eq(members.identityNumber, reviewedIdentityNumber), eq(members.status, "active"))).limit(1);
    if (claimedIdentity && claimedIdentity.id !== member.id) return Response.json({ error: "该学号/工号已由另一名有效成员使用，请由管理员核验身份后处理。" }, { status: 409 });
  }

  if ((body.action === "approve" || body.action === "reject") && member.status !== "pending" && !authorized.isAdmin) {
    return Response.json({ error: "非管理员只能处理待审核的成员申请。" }, { status: 403 });
  }
  if (body.action === "approve" && member.status === "active") return Response.json({ error: "该成员已经处于正常状态。" }, { status: 409 });
  if (body.action === "approve" && !["pending", "rejected", "departed"].includes(member.status)) return Response.json({ error: "当前成员状态不能恢复。" }, { status: 409 });
  if (body.action === "reject" && member.status !== "pending") return Response.json({ error: "只有待审核申请可以拒绝；停用正式成员请使用管理员停用操作。" }, { status: 409 });
  if (body.action === "update_permissions" && member.status !== "active") return Response.json({ error: "只有已通过成员可以调整可选权限。" }, { status: 409 });
  if ((member.status === "rejected" || member.status === "departed") && body.action === "approve" && !authorized.isAdmin) return Response.json({ error: "只有管理员可以恢复已拒绝或已离职成员。" }, { status: 403 });

  const existingPermissions = parseMemberPermissions(member.role, member.permissionsJson);
  if (body.action === "approve" && !authorized.isAdmin && existingPermissions.length > 0) return Response.json({ error: "该申请含预设权限，必须由管理员本人审核。" }, { status: 403 });
  const nextPermissions = body.action === "reject"
    ? []
    : permissionsProvided && authorized.canGrantMemberPermissions
      ? permissions
      : existingPermissions;
  const nextDepartmentCode = body.action === "reject"
    ? ""
    : departmentInput.provided
      ? departmentInput.value
      : member.departmentCode;
  const status = body.action === "approve" ? "active" : body.action === "reject" ? accountRebindReviewRequired ? member.accountBindingPreviousStatus! : "rejected" : member.status;
  const now = new Date().toISOString();
  const mutationRevision = crypto.randomUUID();
  const reviewedFullName = accountRebindReviewRequired && member.pendingFullName ? member.pendingFullName : member.fullName;
  const resetConfidentiality = shouldResetConfidentialityForProjectOwnerPromotion(existingPermissions, nextPermissions, member.ndaAgreementVersion);
  const update = db
    .update(members)
    .set({
      fullName: body.action === "approve" ? reviewedFullName : member.fullName,
      identityNumber: body.action === "approve" ? reviewedIdentityNumber : member.identityNumber,
      accountUserId: body.action === "reject" && accountRebindReviewRequired ? null : member.accountUserId,
      pendingFullName: accountRebindReviewRequired ? null : member.pendingFullName,
      pendingIdentityNumber: accountRebindReviewRequired ? null : member.pendingIdentityNumber,
      accountBindingPreviousStatus: accountRebindReviewRequired ? null : member.accountBindingPreviousStatus,
      status,
      role: "member",
      permissionsJson: JSON.stringify(nextPermissions),
      departmentCode: nextDepartmentCode,
      ...(resetConfidentiality ? { ndaAcceptedAt: null, ndaApprovalId: null, ndaAgreementVersion: null } : {}),
      mutationRevision,
      lastSeenAt: now,
    })
    .where(and(eq(members.id, id), eq(members.status, member.status), eq(members.mutationRevision, member.mutationRevision), authorizedMemberGuard(authorized)))
    .returning();
  const permissionNote = nextPermissions.length ? `；权限：${nextPermissions.map((permission) => permission === "technical_advisor" ? "技术顾问" : "项目负责人").join("、")}` : "；权限：普通成员";
  const departmentNote = `；部门：${memberDepartmentLabel(nextDepartmentCode) || "未设置"}`;
  const actorLabel = authorized.isAdmin ? "管理员" : "审核人";
  const confidentialityNote = resetConfidentiality ? "；已转为项目负责人，须签署《项目负责人保密承诺书》后重新准入" : "";
  const actionNote = body.action === "approve"
    ? member.status === "pending" ? accountRebindReviewRequired ? "管理员核验认证账户主体重新绑定并恢复成员资格；原权限与保密协议准入保持清除" : `${actorLabel}通过成员注册` : "管理员恢复成员资格"
    : body.action === "reject" ? accountRebindReviewRequired ? `管理员拒绝认证账户主体重新绑定并恢复历史${status === "active" ? "有效" : "离职"}状态；待绑定账户主体已清除` : `${actorLabel}拒绝成员注册` : "管理员更新成员部门与权限";
  const event = conditionalMemberEvent(db, id, mutationRevision, now, { actorName: authorized.user.displayName, actorEmail: authorized.user.email, action: body.action, note: `${actionNote}${departmentNote}${permissionNote}${confidentialityNote}` });
  try {
    const [updatedRows, eventRows] = body.action === "reject"
      ? await db.batch([
        update,
        event,
        db.delete(memberSessions).where(and(eq(memberSessions.memberId, id), exists(db.select({ id: members.id }).from(members).where(and(eq(members.id, id), eq(members.mutationRevision, mutationRevision)))))),
        db.delete(oauthSessions).where(and(eq(oauthSessions.memberId, id), exists(db.select({ id: members.id }).from(members).where(and(eq(members.id, id), eq(members.mutationRevision, mutationRevision)))))),
      ])
      : await db.batch([update, event]);
    const updated = updatedRows[0];
    if (!updated) return Response.json({ error: "成员状态刚刚已被其他操作更新，请刷新后重试。" }, { status: 409 });
    if (!eventRows[0]) return Response.json({ error: "成员状态已更新，但审核记录未写入，请联系管理员核查。" }, { status: 500 });
    return Response.json({ member: authorized.isAdmin ? updated : { id: updated.id, fullName: updated.fullName, chatgptAccount: updated.chatgptAccount, status: updated.status, createdAt: updated.createdAt, permissions: nextPermissions } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (/identity_number|members_identity_number_active_unique/i.test(message)) return Response.json({ error: "该学号/工号已由另一名有效成员使用，请由管理员核验身份后处理。" }, { status: 409 });
    return Response.json({ error: "成员处理保存失败，请稍后重试。" }, { status: 500 });
  }
}

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const authorized = await getAuthorizedUser();
  if (!authorized?.isAdmin) return Response.json({ error: "只有 OA 管理员本人可以停用成员。" }, { status: 403 });
  if (!authorized.ndaCompleted) return Response.json({ error: "请先签署并归档《项目负责人保密承诺书》。" }, { status: 403 });

  const { id } = await params;
  const db = await getDb();
  const [member] = await db.select().from(members).where(eq(members.id, id)).limit(1);
  if (!member) return Response.json({ error: "成员不存在或已经删除。" }, { status: 404 });

  const memberEmail = member.chatgptAccount.trim().toLowerCase();
  if (memberEmail === authorized.user.email.trim().toLowerCase()) {
    return Response.json({ error: "不能删除当前登录的管理员账号。" }, { status: 400 });
  }
  if (isAdministrator(memberEmail, member.accountUserId || undefined)) {
    return Response.json({ error: "该账号仍在管理员配置中；请先由运维人员移除管理员配置，再停用成员。" }, { status: 409 });
  }
  if (member.status === "pending") return Response.json({ error: "待审核申请请使用“拒绝”，不能直接删除。" }, { status: 400 });
  if (!["active", "rejected"].includes(member.status)) return Response.json({ error: "该成员已经处于离职状态。" }, { status: 409 });

  const mutationRevision = crypto.randomUUID();
  const now = new Date().toISOString();
  const update = db.update(members).set({ status: "departed", role: "member", permissionsJson: "[]", mutationRevision, lastSeenAt: now }).where(and(eq(members.id, id), eq(members.status, member.status), eq(members.mutationRevision, member.mutationRevision))).returning({ id: members.id });
  const event = conditionalMemberEvent(db, id, mutationRevision, now, {
    actorName: authorized.user.displayName,
    actorEmail: authorized.user.email,
    action: "delete",
    note: `管理员停用成员：${member.fullName}（${memberEmail}）。登录资格已撤销，历史记录保留。`,
  });
  const revokeSessions = db.delete(memberSessions).where(and(
    eq(memberSessions.memberId, id),
    exists(db.select({ id: members.id }).from(members).where(and(
      eq(members.id, id),
      eq(members.mutationRevision, mutationRevision),
    ))),
  ));
  const revokeOAuthSessions = db.delete(oauthSessions).where(and(
    eq(oauthSessions.memberId, id),
    exists(db.select({ id: members.id }).from(members).where(and(
      eq(members.id, id),
      eq(members.mutationRevision, mutationRevision),
    ))),
  ));
  const [updatedRows, eventRows] = await db.batch([update, event, revokeSessions, revokeOAuthSessions]);
  if (!updatedRows[0]) return Response.json({ error: "成员状态刚刚已被其他操作更新，请刷新后重试。" }, { status: 409 });
  if (!eventRows[0]) return Response.json({ error: "成员已停用，但审核记录未写入，请联系管理员核查。" }, { status: 500 });

  return Response.json({ ok: true, member: { id: member.id, fullName: member.fullName, chatgptAccount: memberEmail, status: "departed" } });
}
