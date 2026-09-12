import { desc, eq, sql } from "drizzle-orm";
import { getDb } from "../../../db";
import { accountProfiles, members } from "../../../db/schema";
import { getAuthorizedUser, getReviewerDirectory, isAdministrator, isNdaAdmittedMember, parseAccountProfile, parseMemberPermissions } from "../_lib/auth";
import { memberDepartmentLabel } from "../../../lib/member-attributes";

const ONLINE_WINDOW_MS = 5 * 60 * 1000;

function isOnline(lastSeenAt: string) {
  const timestamp = Date.parse(lastSeenAt);
  return Number.isFinite(timestamp) && Date.now() - timestamp <= ONLINE_WINDOW_MS;
}

function profileForViewer(profile: ReturnType<typeof parseAccountProfile>, isSelf: boolean, departmentCode = "") {
  const officialProfile = {
    ...profile,
    department: memberDepartmentLabel(departmentCode),
  };
  if (isSelf) return officialProfile;
  return {
    ...officialProfile,
    department: officialProfile.visibility.department ? officialProfile.department : "",
    position: officialProfile.visibility.position ? officialProfile.position : "",
    phone: officialProfile.visibility.phone ? officialProfile.phone : "",
    bio: officialProfile.visibility.bio ? officialProfile.bio : "",
  };
}

export async function GET(request: Request) {
  const authorized = await getAuthorizedUser();
  if (!authorized) return Response.json({ error: "请先完成成员注册。" }, { status: 401 });
  if (!authorized.ndaCompleted) return Response.json({ error: "请先完成保密协议签署与归档，之后才能查看内部成员目录。" }, { status: 403 });
  const includeAwaitingConfidentiality = new URL(request.url).searchParams.get("scope") === "directory";
  try {
    const db = await getDb();
    const [memberRows, profileRows] = await Promise.all([
      db.select({ id: members.id, fullName: members.fullName, chatgptAccount: members.chatgptAccount, accountUserId: members.accountUserId, role: members.role, permissionsJson: members.permissionsJson, departmentCode: members.departmentCode, ndaAcceptedAt: members.ndaAcceptedAt, ndaAgreementVersion: members.ndaAgreementVersion, lastSeenAt: members.lastSeenAt }).from(members).where(eq(members.status, "active")).orderBy(desc(members.lastSeenAt)),
      db.select({
        chatgptAccount: accountProfiles.chatgptAccount,
        avatarDataUrl: sql<string>`CASE WHEN length(${accountProfiles.avatarDataUrl}) <= 100000 THEN ${accountProfiles.avatarDataUrl} ELSE '' END`.as("avatar_data_url"),
        profileJson: accountProfiles.profileJson,
        lastSeenAt: accountProfiles.lastSeenAt,
      }).from(accountProfiles),
    ]);
    const profiles = new Map(profileRows.map((row) => [row.chatgptAccount, row]));
    const reviewerDirectory = await getReviewerDirectory({ ...authorized.user, accountUserId: authorized.accountUserId });
    const owners = new Map<string, { email: string; displayName: string; isAdmin: boolean }>(reviewerDirectory
      .filter((reviewer) => reviewer.ndaCompleted && reviewer.permissions.includes("project_owner"))
      .map((owner): [string, { email: string; displayName: string; isAdmin: boolean }] => [owner.email, { email: owner.email, displayName: owner.displayName, isAdmin: owner.isAdmin }]));
    const currentEmail = authorized.user.email.trim().toLowerCase();
    if (!owners.has(currentEmail) && authorized.role === "project_owner") owners.set(currentEmail, { email: currentEmail, displayName: authorized.user.displayName, isAdmin: authorized.isAdmin });
    const people = new Map<string, {
      id: string;
      fullName: string;
      email: string;
      role: string;
      permissions: string[];
      isAdmin: boolean;
      avatarDataUrl: string;
      profile: ReturnType<typeof parseAccountProfile>;
      lastSeenAt: string;
      online: boolean;
      ndaCompleted: boolean;
    }>();
    for (const row of memberRows) {
      const confidentialityCompleted = isNdaAdmittedMember(row);
      if (!confidentialityCompleted && !includeAwaitingConfidentiality) continue;
      const email = row.chatgptAccount.toLowerCase();
      const profileRow = profiles.get(email);
      const profile = parseAccountProfile(profileRow?.profileJson);
      const permissions = parseMemberPermissions(row.role, row.permissionsJson);
      const lastSeenAt = profileRow?.lastSeenAt || row.lastSeenAt;
      people.set(email, { id: row.id, fullName: owners.get(email)?.displayName || row.fullName, email, role: permissions.includes("project_owner") ? "project_owner" : permissions.includes("technical_advisor") ? "technical_advisor" : "member", permissions, isAdmin: isAdministrator(row.chatgptAccount, row.accountUserId ?? undefined), avatarDataUrl: profileRow?.avatarDataUrl || "", profile: profileForViewer(profile, email === currentEmail, row.departmentCode), lastSeenAt, online: confidentialityCompleted && isOnline(lastSeenAt), ndaCompleted: confidentialityCompleted });
    }
    for (const owner of owners.values()) {
      if (people.has(owner.email)) continue;
      const profileRow = profiles.get(owner.email);
      const profile = parseAccountProfile(profileRow?.profileJson);
      const lastSeenAt = profileRow?.lastSeenAt || "";
      people.set(owner.email, { id: `account:${owner.email}`, fullName: owner.displayName, email: owner.email, role: "project_owner", permissions: ["technical_advisor", "project_owner"], isAdmin: owner.isAdmin, avatarDataUrl: profileRow?.avatarDataUrl || "", profile: profileForViewer(profile, owner.email === currentEmail), lastSeenAt, online: isOnline(lastSeenAt), ndaCompleted: true });
    }
    return Response.json({ people: Array.from(people.values()).sort((left, right) => Number(right.online) - Number(left.online) || left.fullName.localeCompare(right.fullName, "zh-CN")), currentUserEmail: authorized.user.email });
  } catch {
    return Response.json({ error: "成员目录暂不可用，请稍后重试。" }, { status: 500 });
  }
}
