import { and, eq, exists, isNull, sql } from "drizzle-orm";
import { getDb } from "../../../db";
import { accountProfiles, authIdentities, memberEvents, members } from "../../../db/schema";
import { authorizedMemberGuard, getAuthorizedUser, parseAccountProfile, type AccountProfile, type ProfileVisibility } from "../_lib/auth";
import { isChatGPTLoginEnabled } from "../../../lib/auth-capabilities";
import { FEISHU_PROVIDER, isFeishuLoginEnabled } from "../../../lib/feishu-oauth";
import { GITHUB_PROVIDER, isGitHubLoginEnabled } from "../../../lib/github-oauth";
import { isAllowedAvatarDataUrl } from "../../../lib/image-data-url";
import { readBoundedJsonObject } from "../../../lib/bounded-json-request";
import { memberDepartmentLabel } from "../../../lib/member-attributes";

type ProfileField = Exclude<keyof AccountProfile, "visibility">;
type EditableProfileField = Exclude<ProfileField, "department">;
const PROFILE_LIMITS: Record<EditableProfileField, number> = { position: 80, phone: 40, bio: 240 };
const PROFILE_VISIBILITY_KEYS: Array<keyof ProfileVisibility> = ["department", "position", "phone", "bio"];
const MAX_PROFILE_REQUEST_BYTES = 150_000;
const MAX_AVATAR_DATA_URL_LENGTH = 100_000;

function profileJson(body: object, init: ResponseInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("cache-control", "private, no-store, max-age=0");
  return Response.json(body, { ...init, headers });
}

export async function GET() {
  const authorized = await getAuthorizedUser();
  if (!authorized) return Response.json({ error: "请先完成成员注册。" }, { status: 401 });
  try {
    const db = await getDb();
    const [[profile], [member], linkedIdentityRows] = await Promise.all([
      db.select().from(accountProfiles).where(eq(accountProfiles.chatgptAccount, authorized.user.email.toLowerCase())).limit(1),
      db.select({ fullName: members.fullName, status: members.status, departmentCode: members.departmentCode, accountUserId: members.accountUserId }).from(members).where(eq(members.chatgptAccount, authorized.user.email.toLowerCase())).limit(1),
      authorized.memberId ? db.select({ provider: authIdentities.provider }).from(authIdentities).where(and(eq(authIdentities.memberId, authorized.memberId), isNull(authIdentities.unlinkedAt))) : Promise.resolve([]),
    ]);
    const parsedProfile = parseAccountProfile(profile?.profileJson);
    parsedProfile.department = memberDepartmentLabel(member?.departmentCode);
    const implicitProviders = member?.accountUserId?.startsWith("email:") ? ["chatgpt"] : [];
    const linkedProviders = Array.from(new Set([...implicitProviders, ...linkedIdentityRows.map((row) => row.provider).filter((provider) => provider === GITHUB_PROVIDER || provider === FEISHU_PROVIDER)]));
    return profileJson({ user: authorized.user, officialName: member?.status === "active" ? member.fullName : authorized.user.displayName, profile: { avatarDataUrl: profile?.avatarDataUrl || "", ...parsedProfile, lastSeenAt: profile?.lastSeenAt || "" }, linkedProviders, chatgptLoginEnabled: isChatGPTLoginEnabled(), githubLoginEnabled: isGitHubLoginEnabled(), feishuLoginEnabled: isFeishuLoginEnabled(), chatgptLinked: linkedProviders.includes("chatgpt"), githubLinked: linkedProviders.includes(GITHUB_PROVIDER), feishuLinked: linkedProviders.includes(FEISHU_PROVIDER) });
  } catch {
    return profileJson({ error: "个人资料暂不可用，请稍后重试。" }, { status: 500 });
  }
}

export async function PATCH(request: Request) {
  const authorized = await getAuthorizedUser();
  if (!authorized) return profileJson({ error: "请先完成成员注册。" }, { status: 401 });
  if (request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "application/json") return profileJson({ error: "个人资料必须使用 JSON 格式提交。" }, { status: 415 });
  const parsedBody = await readBoundedJsonObject(request, MAX_PROFILE_REQUEST_BYTES);
  if (!parsedBody.ok) return profileJson({ error: parsedBody.reason === "too_large" ? "个人资料数据过大。" : "个人资料格式不正确。" }, { status: parsedBody.reason === "too_large" ? 413 : 400 });
  const body: { avatarDataUrl?: unknown; fullName?: unknown; profile?: unknown } = parsedBody.value;
  const profileInput = body.profile && typeof body.profile === "object" && !Array.isArray(body.profile) ? body.profile as Record<string, unknown> : {};
  const nextProfile: AccountProfile = { department: "", position: "", phone: "", bio: "", visibility: { department: false, position: false, phone: false, bio: false } };
  try {
    const db = await getDb();
    const normalizedEmail = authorized.user.email.toLowerCase();
    const [[existing], [member]] = await Promise.all([
      db.select().from(accountProfiles).where(eq(accountProfiles.chatgptAccount, normalizedEmail)).limit(1),
      db.select({ id: members.id, fullName: members.fullName, accountUserId: members.accountUserId, mutationRevision: members.mutationRevision, status: members.status, departmentCode: members.departmentCode }).from(members).where(eq(members.chatgptAccount, normalizedEmail)).limit(1),
    ]);
    if (!member || !authorized.memberId || !authorized.accountUserId || !authorized.memberMutationRevision
      || member.id !== authorized.memberId || member.status !== "active"
      || member.accountUserId !== authorized.accountUserId || member.mutationRevision !== authorized.memberMutationRevision) {
      return profileJson({ error: "成员状态或身份刚刚发生变化，请刷新后重试。" }, { status: 409 });
    }
    const fullName = body.fullName === undefined ? member.fullName : typeof body.fullName === "string" ? body.fullName.trim() : "";
    if (fullName.length < 2 || fullName.length > 40 || /[\u0000-\u001f\u007f]/u.test(fullName)) {
      return profileJson({ error: "请填写有效姓名（2 至 40 个字符）。" }, { status: 400 });
    }
    Object.assign(nextProfile, parseAccountProfile(existing?.profileJson));
    for (const key of Object.keys(PROFILE_LIMITS) as Array<EditableProfileField>) {
      if (profileInput[key] === undefined) continue;
      if (typeof profileInput[key] !== "string" || profileInput[key].trim().length > PROFILE_LIMITS[key]) return profileJson({ error: "个人资料内容过长或格式不正确。" }, { status: 400 });
      nextProfile[key] = profileInput[key].trim();
    }
    if (profileInput.visibility !== undefined) {
      if (!profileInput.visibility || typeof profileInput.visibility !== "object" || Array.isArray(profileInput.visibility)) return profileJson({ error: "公开设置格式不正确。" }, { status: 400 });
      const visibilityInput = profileInput.visibility as Record<string, unknown>;
      for (const key of PROFILE_VISIBILITY_KEYS) {
        if (visibilityInput[key] === undefined) continue;
        if (typeof visibilityInput[key] !== "boolean") return profileJson({ error: "公开设置格式不正确。" }, { status: 400 });
        nextProfile.visibility[key] = visibilityInput[key];
      }
    }
    nextProfile.department = memberDepartmentLabel(member?.departmentCode);
    const avatarDataUrl = body.avatarDataUrl === undefined ? existing?.avatarDataUrl || "" : body.avatarDataUrl;
    if (typeof avatarDataUrl !== "string" || !isAllowedAvatarDataUrl(avatarDataUrl) || avatarDataUrl.length > MAX_AVATAR_DATA_URL_LENGTH) return profileJson({ error: "头像格式或尺寸不符合要求，请选择 70KB 以内的静态 PNG、JPEG 或 WebP 图片；最长边不超过 2048 像素，总像素不超过 400 万。" }, { status: 400 });
    const now = new Date().toISOString();
    const nameChanged = fullName !== member.fullName;
    const nextMutationRevision = nameChanged ? crypto.randomUUID() : member.mutationRevision;
    const currentMemberGuard = and(
      eq(members.id, member.id),
      eq(members.chatgptAccount, normalizedEmail),
      eq(members.accountUserId, authorized.accountUserId),
      eq(members.status, "active"),
      eq(members.mutationRevision, member.mutationRevision),
      authorizedMemberGuard(authorized),
    );
    const persistedMemberExists = exists(db.select({ id: members.id }).from(members).where(and(
      eq(members.id, member.id),
      eq(members.chatgptAccount, normalizedEmail),
      eq(members.accountUserId, authorized.accountUserId),
      eq(members.status, "active"),
      eq(members.mutationRevision, nextMutationRevision),
      eq(members.fullName, fullName),
    )));
    const profileWrite = existing
      ? db.update(accountProfiles).set({ avatarDataUrl, profileJson: JSON.stringify(nextProfile), lastSeenAt: now }).where(and(eq(accountProfiles.chatgptAccount, normalizedEmail), persistedMemberExists)).returning({ email: accountProfiles.chatgptAccount })
      : db.insert(accountProfiles).select(db.select({
        chatgptAccount: sql<string>`${normalizedEmail}`.as("chatgpt_account"),
        avatarDataUrl: sql<string>`${avatarDataUrl}`.as("avatar_data_url"),
        profileJson: sql<string>`${JSON.stringify(nextProfile)}`.as("profile_json"),
        lastSeenAt: sql<string>`${now}`.as("last_seen_at"),
      }).from(sql`(SELECT 1) AS authorization_source`).where(persistedMemberExists)).returning({ email: accountProfiles.chatgptAccount });
    if (nameChanged) {
      const [memberRows, eventRows, profileRows] = await db.batch([
        db.update(members).set({ fullName, mutationRevision: nextMutationRevision, lastSeenAt: now }).where(currentMemberGuard).returning({ id: members.id }),
        db.insert(memberEvents).select(db.select({
          id: sql<number>`NULL`.as("id"),
          memberId: members.id,
          actorName: sql<string>`${fullName}`.as("actor_name"),
          actorEmail: sql<string>`${normalizedEmail}`.as("actor_email"),
          action: sql<string>`'profile_name_changed'`.as("action"),
          note: sql<string>`${`成员本人在个人设置中将姓名由“${member.fullName}”修改为“${fullName}”；历史审批和签署快照保持不变`}`.as("note"),
          createdAt: sql<string>`${now}`.as("created_at"),
        }).from(members).where(and(eq(members.id, member.id), eq(members.mutationRevision, nextMutationRevision), eq(members.fullName, fullName)))).returning({ id: memberEvents.id }),
        profileWrite,
      ]);
      if (!memberRows[0] || !eventRows[0] || !profileRows[0]) return profileJson({ error: "成员状态或权限刚刚发生变化，个人资料未保存，请刷新后重试。" }, { status: 409 });
    } else {
      const persistedRows = await profileWrite;
      if (!persistedRows[0]) return profileJson({ error: "成员状态或权限刚刚发生变化，个人资料未保存，请刷新后重试。" }, { status: 409 });
    }
    return profileJson({ user: { ...authorized.user, displayName: fullName }, officialName: fullName, profile: { avatarDataUrl, ...nextProfile, lastSeenAt: now } });
  } catch {
    return profileJson({ error: "个人资料保存失败，请稍后重试。" }, { status: 500 });
  }
}
