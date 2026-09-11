import { desc } from "drizzle-orm";
import { getDb } from "../../../db";
import { members } from "../../../db/schema";
import { getAuthorizedUser, parseMemberPermissions } from "../_lib/auth";

export async function GET() {
  const authorized = await getAuthorizedUser();
  if (!authorized?.isAdmin) return Response.json({ error: "只有 OA 管理员本人可以审核成员注册。" }, { status: 403 });
  if (!authorized.ndaCompleted) return Response.json({ error: "请先签署并归档《项目负责人保密承诺书》。" }, { status: 403 });
  const rows = await (await getDb()).select().from(members).orderBy(desc(members.createdAt));
  return Response.json({
    pendingCount: rows.filter((row) => row.status === "pending").length,
    members: rows.map((row) => ({
      id: row.id,
      fullName: row.accountBindingPreviousStatus ? row.pendingFullName || row.fullName : row.fullName,
      identityNumber: (row.accountBindingPreviousStatus ? row.pendingIdentityNumber : row.identityNumber) || "",
      chatgptAccount: row.chatgptAccount,
      status: row.status,
      createdAt: row.createdAt,
      departmentCode: row.departmentCode,
      permissions: parseMemberPermissions(row.role, row.permissionsJson),
    })),
  });
}
