import { and, desc, eq, exists, gt, isNotNull, isNull, lt, ne, or, sql } from "drizzle-orm";
import { cookies } from "next/headers";
import { getDb } from "../../../../../db";
import { authIdentities, members, memberEvents, oauthSessions, qrLoginChallenges, qrOAuthAttempts } from "../../../../../db/schema";
import { accountEmailForFeishu } from "../../../../../lib/account-subject";
import { readBoundedJsonObject } from "../../../../../lib/bounded-json-request";
import { buildFeishuAuthorizeUrl, exchangeFeishuCode, getFeishuOAuthConfig, isFeishuLoginEnabled } from "../../../../../lib/feishu-oauth";
import { randomBase64Url, sha256Base64Url, sha256Hex } from "../../../../../lib/github-oauth";
import { isMigrationWriteFrozen } from "../../../../../lib/migration-freeze";
import { OAUTH_SESSION_COOKIE, OAUTH_SESSION_MAX_AGE_SECONDS } from "../../../../../lib/oauth-session";
import { QR_DESKTOP_COOKIE, QR_PHONE_COOKIE, QR_LOGIN_MAX_AGE_SECONDS, qrDesktopLabel, qrLoginOrigin, sameOriginQrPost, validQrNonce, type QrProvider } from "../../../../../lib/qr-login";
import { generateQrSvg } from "../../../../../lib/qr-svg";
import { buildWecomAuthorizeUrl, exchangeWecomCode, getWecomOAuthConfig, isWecomLoginEnabled } from "../../../../../lib/wecom-oauth";
import { consumeWriteRateLimit } from "../../../../../lib/write-rate-limit";
import { getAuthorizedUser, type AuthorizedUser } from "../../../_lib/auth";

type Database = Awaited<ReturnType<typeof getDb>>;
type Challenge = typeof qrLoginChallenges.$inferSelect;
const cookieOptions = { httpOnly: true, secure: true, sameSite: "lax" as const, path: "/", maxAge: QR_LOGIN_MAX_AGE_SECONDS };
const noStoreHeaders = { "cache-control": "private, no-store, max-age=0", "referrer-policy": "no-referrer", "x-content-type-options": "nosniff" };

function json(body: object, status = 200) {
  return Response.json(body, { status, headers: noStoreHeaders });
}

function failure(error: string, status = 400) { return json({ error }, status); }

function enabledProviders(action = "login"): QrProvider[] {
  if (process.env.OA_UNIFIED_QR_LOGIN_ENABLED?.trim().toLowerCase() === "false") return [];
  return [action !== "link" && isFeishuLoginEnabled() ? "feishu" : null, isWecomLoginEnabled() ? "wecom" : null]
    .filter((value): value is QrProvider => value !== null);
}

async function bodyForPost(request: Request) {
  const origin = qrLoginOrigin();
  if (!sameOriginQrPost(request, origin)) return failure("扫码请求来源无效，请从 OA 页面重试。", 403);
  if (request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "application/json") return failure("请求格式必须为 JSON。", 415);
  const parsed = await readBoundedJsonObject(request, 2048);
  if (!parsed.ok) return failure("扫码请求格式无效。", parsed.reason === "too_large" ? 413 : 400);
  return parsed.value;
}

function canLink(authorized: AuthorizedUser | null): authorized is AuthorizedUser & { memberId: string; accountUserId: string; memberMutationRevision: string } {
  return Boolean(authorized?.memberId && authorized.accountUserId && authorized.memberMutationRevision && (authorized.isAdmin || authorized.ndaCompleted));
}

function linkMemberGuard(challenge: Challenge, authorized: AuthorizedUser) {
  const conditions = [eq(members.id, challenge.linkMemberId || ""), eq(members.status, "active"),
    eq(members.accountUserId, challenge.linkAccountUserId || ""), eq(members.mutationRevision, challenge.linkMemberRevision || "")];
  if (!authorized.isAdmin) {
    conditions.push(eq(members.ndaAcceptedAt, authorized.ndaAcceptedAt || ""), eq(members.ndaApprovalId, authorized.ndaApprovalId || ""), eq(members.ndaAgreementVersion, authorized.ndaAgreementVersion || ""));
  }
  return and(...conditions);
}

async function desktopChallenge(id: unknown) {
  if (!validQrNonce(id)) return null;
  const nonce = (await cookies()).get(QR_DESKTOP_COOKIE)?.value;
  if (!validQrNonce(nonce)) return null;
  const db = await getDb();
  const [challenge] = await db.select().from(qrLoginChallenges).where(and(eq(qrLoginChallenges.id, id), eq(qrLoginChallenges.browserNonceHash, await sha256Hex(nonce)))).limit(1);
  return challenge ? { db, challenge } : null;
}

async function phoneHash() {
  const nonce = (await cookies()).get(QR_PHONE_COOKIE)?.value;
  return validQrNonce(nonce) ? sha256Hex(nonce) : null;
}

function expired(challenge: Challenge) { return Date.now() >= Date.parse(challenge.expiresAt); }
function liveChallenge(id: string, now: string) { return and(eq(qrLoginChallenges.id, id), gt(qrLoginChallenges.expiresAt, now)); }

async function guarded(handler: () => Promise<Response>) {
  try { return await handler(); }
  catch { return failure("统一扫码暂不可用，请使用飞书备用入口，或稍后重试。", 503); }
}

export async function startQrLogin(request: Request) { return guarded(async () => {
  const body = await bodyForPost(request); if (body instanceof Response) return body;
  if (body.action !== "login" && body.action !== "link") return failure("登录用途无效。");
  if (isMigrationWriteFrozen(process.env)) return failure("系统维护中，请稍后重试。", 503);
  const providers = enabledProviders(body.action);
  if (!providers.length) return failure(body.action === "link" ? "企业微信登录尚未配置。" : "扫码登录尚未启用。", 503);
  const authorized = body.action === "link" ? await getAuthorizedUser({ readOnly: true }) : null;
  if (body.action === "link" && !canLink(authorized)) return failure("请先使用已有 OA 账号登录并完成准入，再绑定企业微信。", 401);
  const db = await getDb(); const now = new Date(); const nowText = now.toISOString();
  const actor = await sha256Hex(request.headers.get("cf-connecting-ip") || request.headers.get("x-real-ip") || "unknown");
  if (!(await consumeWriteRateLimit(db, { actorSubject: actor, scope: "qr_login_start", limit: 12, now }))) return failure("生成二维码过于频繁，请稍后重试。", 429);
  const cookieStore = await cookies(); const previous = cookieStore.get(QR_DESKTOP_COOKIE)?.value;
  const nonce = validQrNonce(previous) ? previous : randomBase64Url(32); const browserNonceHash = await sha256Hex(nonce);
  const id = randomBase64Url(32); const verificationCode = String(crypto.getRandomValues(new Uint32Array(1))[0] % 1_000_000).padStart(6, "0");
  const expiresAt = new Date(now.getTime() + QR_LOGIN_MAX_AGE_SECONDS * 1000).toISOString();
  const previousChallenge = db.select({ id: qrLoginChallenges.id }).from(qrLoginChallenges).where(eq(qrLoginChallenges.browserNonceHash, browserNonceHash));
  await db.batch([
    db.delete(qrOAuthAttempts).where(or(lt(qrOAuthAttempts.expiresAt, nowText), sql`${qrOAuthAttempts.challengeId} IN (${previousChallenge})`)),
    db.delete(qrLoginChallenges).where(or(lt(qrLoginChallenges.expiresAt, nowText), eq(qrLoginChallenges.browserNonceHash, browserNonceHash))),
    db.insert(qrLoginChallenges).values({ id, browserNonceHash, action: body.action,
      linkMemberId: authorized?.memberId || null, linkAccountUserId: authorized?.accountUserId || null,
      linkMemberRevision: authorized?.memberMutationRevision || null, verificationCode,
      desktopLabel: qrDesktopLabel(request.headers.get("user-agent") || ""), createdAt: nowText, expiresAt }),
  ]);
  cookieStore.set(QR_DESKTOP_COOKIE, nonce, cookieOptions);
  const scanUrl = new URL("/auth/qr", qrLoginOrigin()); scanUrl.searchParams.set("id", id);
  return json({ id, scanUrl: scanUrl.href, qrSvg: generateQrSvg(scanUrl.href), expiresIn: QR_LOGIN_MAX_AGE_SECONDS, verificationCode, providers });
}); }

export async function scanQrLogin(request: Request) { return guarded(async () => {
  const body = await bodyForPost(request); if (body instanceof Response) return body;
  if (!validQrNonce(body.id) || (body.provider !== "feishu" && body.provider !== "wecom")) return failure("二维码或登录方式无效。");
  const db = await getDb(); const [challenge] = await db.select().from(qrLoginChallenges).where(eq(qrLoginChallenges.id, body.id)).limit(1);
  if (!challenge || expired(challenge) || challenge.status !== "pending") return failure("二维码已使用或过期，请刷新电脑上的二维码。", 410);
  const provider = body.provider;
  if (!enabledProviders(challenge.action).includes(provider)) return failure("此登录方式暂未启用。", 503);
  const now = new Date(); const scannerCookies = await cookies(); const previous = scannerCookies.get(QR_PHONE_COOKIE)?.value;
  const nonce = validQrNonce(previous) ? previous : randomBase64Url(32); const scannerNonceHash = await sha256Hex(nonce);
  if (!(await consumeWriteRateLimit(db, { actorSubject: challenge.id, scope: "qr_login_scan", limit: 8, now }))) return failure("扫码验证过于频繁，请重新生成二维码。", 429);
  const state = randomBase64Url(32); const verifier = provider === "feishu" ? randomBase64Url(64) : "";
  await db.insert(qrOAuthAttempts).values({ stateHash: await sha256Hex(state), challengeId: challenge.id, provider,
    scannerNonceHash, pkceVerifier: verifier, createdAt: now.toISOString(), expiresAt: challenge.expiresAt });
  scannerCookies.set(QR_PHONE_COOKIE, nonce, cookieOptions);
  const authorizeUrl = provider === "feishu"
    ? buildFeishuAuthorizeUrl({ ...getFeishuOAuthConfig(), callbackUrl: `${qrLoginOrigin()}/api/auth/qr/callback/feishu` }, state, await sha256Base64Url(verifier))
    : buildWecomAuthorizeUrl(getWecomOAuthConfig(), state);
  return json({ authorizeUrl: authorizeUrl.toString() });
}); }

function mobileRedirect(id?: string) {
  const url = new URL("/auth/qr", qrLoginOrigin()); if (id) url.searchParams.set("id", id); else url.searchParams.set("error", "failed");
  return new Response(null, { status: 303, headers: { ...noStoreHeaders, location: url.href } });
}

async function denyAttempt(db: Database, stateHash: string, reason: string) {
  await db.update(qrOAuthAttempts).set({ failureReason: reason }).where(eq(qrOAuthAttempts.stateHash, stateHash));
}

export async function qrCallback(request: Request, provider: QrProvider) { return guarded(async () => {
  const url = new URL(request.url); if (url.origin !== qrLoginOrigin()) return failure("授权回调域名无效。", 400);
  const state = url.searchParams.get("state"); const scannerNonceHash = await phoneHash(); const code = url.searchParams.get("code") || "";
  if (!validQrNonce(state) || !scannerNonceHash || code.length > 1024 || (!code && !url.searchParams.get("error"))) return mobileRedirect();
  const db = await getDb(); const now = new Date().toISOString();
  const [attempt] = await db.update(qrOAuthAttempts).set({ consumedAt: now }).where(and(eq(qrOAuthAttempts.stateHash, await sha256Hex(state)),
    eq(qrOAuthAttempts.provider, provider), eq(qrOAuthAttempts.scannerNonceHash, scannerNonceHash), isNull(qrOAuthAttempts.consumedAt), gt(qrOAuthAttempts.expiresAt, now)))
    .returning();
  if (!attempt) return mobileRedirect();
  const [challenge] = await db.select().from(qrLoginChallenges).where(liveChallenge(attempt.challengeId, now)).limit(1);
  if (!challenge || challenge.status !== "pending") return mobileRedirect(attempt.challengeId);
  if (url.searchParams.get("error") || !enabledProviders(challenge.action).includes(provider)) {
    await denyAttempt(db, attempt.stateHash, "authorization-denied"); return mobileRedirect(challenge.id);
  }
  let subject: string, login: string, displayName: string;
  try {
    if (provider === "feishu") {
      const config = { ...getFeishuOAuthConfig(), callbackUrl: `${qrLoginOrigin()}/api/auth/qr/callback/feishu` };
      const identity = await exchangeFeishuCode(config, code, attempt.pkceVerifier, "modern");
      if (identity.tenantKey !== config.tenantKey) throw new Error("Foreign Feishu tenant");
      subject = identity.providerSubject; login = identity.openId; displayName = identity.displayName;
    } else {
      const identity = await exchangeWecomCode(getWecomOAuthConfig(), code);
      subject = identity.providerSubject; login = identity.userId; displayName = identity.displayName;
    }
  } catch {
    await denyAttempt(db, attempt.stateHash, "verification-failed"); return mobileRedirect(challenge.id);
  }
  const [identity] = await db.select().from(authIdentities).where(and(eq(authIdentities.provider, provider), eq(authIdentities.providerSubject, subject))).limit(1);
  let memberId: string | null = null;
  if (challenge.action === "link") {
    if (provider !== "wecom" || !challenge.linkMemberId || (identity && identity.memberId !== challenge.linkMemberId)) {
      await denyAttempt(db, attempt.stateHash, "identity-conflict"); return mobileRedirect(challenge.id);
    }
    memberId = challenge.linkMemberId;
  } else {
    if (identity?.unlinkedAt || (provider === "wecom" && !identity)) {
      await denyAttempt(db, attempt.stateHash, provider === "wecom" && !identity ? "wecom-not-linked" : "identity-conflict"); return mobileRedirect(challenge.id);
    }
    if (identity) {
      const [member] = await db.select().from(members).where(eq(members.id, identity.memberId)).limit(1);
      if (!member || (member.status !== "active" && !(provider === "feishu" && member.status === "pending")) || !member.accountUserId) {
        await denyAttempt(db, attempt.stateHash, "member-disabled"); return mobileRedirect(challenge.id);
      }
      memberId = member.id; displayName = member.fullName;
    }
  }
  await db.update(qrLoginChallenges).set({ status: "verified", provider, providerSubject: subject, loginSnapshot: login,
    displayNameSnapshot: displayName, memberId, scannerNonceHash }).where(and(liveChallenge(challenge.id, new Date().toISOString()), eq(qrLoginChallenges.status, "pending")));
  return mobileRedirect(challenge.id);
}); }

export async function mobileQrInfo(request: Request) { return guarded(async () => {
  const url = new URL(request.url); if (url.origin !== qrLoginOrigin()) return failure("扫码地址无效。", 400);
  const id = url.searchParams.get("id"); if (!validQrNonce(id)) return failure("请扫描电脑 OA 登录页上的二维码。", 400);
  const db = await getDb(); const [challenge] = await db.select().from(qrLoginChallenges).where(eq(qrLoginChallenges.id, id)).limit(1);
  if (!challenge || expired(challenge)) return json({ phase: "expired", providers: [] });
  const scannerNonceHash = await phoneHash();
  const base = { verificationCode: challenge.verificationCode, desktopLabel: challenge.desktopLabel, createdAt: challenge.createdAt, action: challenge.action };
  if (challenge.status === "pending") {
    const [failed] = scannerNonceHash ? await db.select({ reason: qrOAuthAttempts.failureReason }).from(qrOAuthAttempts).where(and(
      eq(qrOAuthAttempts.challengeId, challenge.id), eq(qrOAuthAttempts.scannerNonceHash, scannerNonceHash), isNotNull(qrOAuthAttempts.failureReason)))
      .orderBy(desc(qrOAuthAttempts.createdAt)).limit(1) : [];
    const error = failed?.reason === "wecom-not-linked"
      ? "该企微身份尚未绑定 OA。请先用已有登录方式进入 OA，在“我的”中绑定企业微信，再重新扫码。"
      : failed ? "本次手机验证未完成，可重试或使用另一种登录方式。" : undefined;
    return json({ phase: "choose", providers: enabledProviders(challenge.action), error, ...base });
  }
  if (!scannerNonceHash || scannerNonceHash !== challenge.scannerNonceHash) return json({ phase: "denied", error: "二维码已在另一台手机使用，请刷新电脑二维码。", providers: [] });
  if (challenge.status === "verified") return json({ phase: "confirm", displayName: challenge.displayNameSnapshot, providers: [], ...base });
  if (challenge.status === "approved" || challenge.status === "consumed") return json({ phase: "approved", providers: [], ...base });
  return json({ phase: "denied", error: challenge.denialReason === "wecom-not-linked"
    ? "该企微身份尚未绑定 OA。请先用已有登录方式进入 OA，在“我的”中绑定企业微信，再重新扫码。"
    : "本次扫码未完成，请刷新电脑上的二维码重试。", providers: [], ...base });
}); }

export async function confirmQrLogin(request: Request) { return guarded(async () => {
  const body = await bodyForPost(request); if (body instanceof Response) return body;
  if (!validQrNonce(body.id) || typeof body.approve !== "boolean") return failure("确认请求无效。");
  const scannerNonceHash = await phoneHash(); if (!scannerNonceHash) return failure("手机验证已失效，请重新扫码。", 403);
  const now = new Date().toISOString(); const db = await getDb();
  const [row] = await db.update(qrLoginChallenges).set({ status: body.approve ? "approved" : "denied", denialReason: body.approve ? null : "phone-cancelled" })
    .where(and(liveChallenge(body.id, now), eq(qrLoginChallenges.scannerNonceHash, scannerNonceHash), eq(qrLoginChallenges.status, "verified"))).returning({ id: qrLoginChallenges.id });
  return row ? json({ ok: true, approved: body.approve }) : failure("二维码已失效或已确认，请重新扫码。", 409);
}); }

async function consumeLogin(db: Database, challenge: Challenge) {
  const provider = challenge.provider as QrProvider;
  if (!enabledProviders().includes(provider) || !challenge.providerSubject || !challenge.loginSnapshot) return failure("登录方式已停用。", 403);
  let emailSnapshot: string; let displayNameSnapshot = challenge.displayNameSnapshot || "已验证成员";
  let guard = sql`1 = 1`;
  if (challenge.memberId) {
    const [member] = await db.select().from(members).where(eq(members.id, challenge.memberId)).limit(1);
    if (!member || !member.accountUserId || (member.status !== "active" && !(provider === "feishu" && member.status === "pending"))) return failure("成员状态已变更，请重新登录。", 403);
    emailSnapshot = member.chatgptAccount; displayNameSnapshot = member.fullName;
    guard = exists(db.select({ id: members.id }).from(members).innerJoin(authIdentities, eq(authIdentities.memberId, members.id)).where(and(
      eq(members.id, member.id), eq(members.accountUserId, member.accountUserId), eq(members.mutationRevision, member.mutationRevision), eq(members.status, member.status),
      eq(authIdentities.provider, provider), eq(authIdentities.providerSubject, challenge.providerSubject), isNull(authIdentities.unlinkedAt))));
  } else {
    if (provider !== "feishu") return failure("企业微信身份尚未绑定 OA。", 403);
    emailSnapshot = await accountEmailForFeishu(challenge.providerSubject);
    // An identity linked or explicitly revoked after phone verification cannot
    // be consumed as an unregistered identity.
    guard = sql`NOT EXISTS (SELECT 1 FROM auth_identities WHERE provider = ${provider} AND provider_subject = ${challenge.providerSubject})`;
  }
  const sessionToken = `${crypto.randomUUID()}-${crypto.randomUUID()}`; const receiptHash = await sha256Hex(sessionToken);
  const now = new Date().toISOString(); const expiresAt = new Date(Date.now() + OAUTH_SESSION_MAX_AGE_SECONDS * 1000).toISOString();
  const claimed = and(eq(qrLoginChallenges.id, challenge.id), eq(qrLoginChallenges.status, "consumed"), eq(qrLoginChallenges.receiptHash, receiptHash), guard);
  const [claimedRows, sessionRows] = await db.batch([
    db.update(qrLoginChallenges).set({ status: "consumed", consumedAt: now, receiptHash }).where(and(liveChallenge(challenge.id, now),
      eq(qrLoginChallenges.browserNonceHash, challenge.browserNonceHash), eq(qrLoginChallenges.status, "approved"), guard)).returning({ id: qrLoginChallenges.id }),
    db.insert(oauthSessions).select(db.select({
      tokenHash: sql<string>`${receiptHash}`.as("token_hash"), provider: sql<string>`${provider}`.as("provider"), providerSubject: sql<string>`${challenge.providerSubject}`.as("provider_subject"),
      memberId: sql<string | null>`${challenge.memberId}`.as("member_id"), loginSnapshot: sql<string>`${challenge.loginSnapshot}`.as("login_snapshot"),
      emailSnapshot: sql<string>`${emailSnapshot}`.as("email_snapshot"), displayNameSnapshot: sql<string>`${displayNameSnapshot}`.as("display_name_snapshot"),
      createdAt: sql<string>`${now}`.as("created_at"), lastSeenAt: sql<string>`${now}`.as("last_seen_at"), expiresAt: sql<string>`${expiresAt}`.as("expires_at"), revokedAt: sql<string | null>`NULL`.as("revoked_at"),
    }).from(qrLoginChallenges).where(claimed)).returning({ tokenHash: oauthSessions.tokenHash }),
  ]);
  if (!claimedRows[0] || !sessionRows[0]) return failure("登录状态已变化，请刷新二维码重试。", 409);
  (await cookies()).set(OAUTH_SESSION_COOKIE, sessionToken, { ...cookieOptions, maxAge: OAUTH_SESSION_MAX_AGE_SECONDS });
  return json({ status: "consumed", redirectTo: "/" });
}

async function consumeLink(db: Database, challenge: Challenge) {
  if (isMigrationWriteFrozen(process.env)) return failure("系统维护中，暂不能绑定账号。", 503);
  const authorized = await getAuthorizedUser({ readOnly: true });
  if (!canLink(authorized) || authorized.memberId !== challenge.linkMemberId || authorized.accountUserId !== challenge.linkAccountUserId
    || authorized.memberMutationRevision !== challenge.linkMemberRevision || challenge.provider !== "wecom" || !challenge.providerSubject || !isWecomLoginEnabled()) return failure("原 OA 登录状态已变化，请重新发起绑定。", 401);
  const [[existing], [active]] = await Promise.all([
    db.select().from(authIdentities).where(and(eq(authIdentities.provider, "wecom"), eq(authIdentities.providerSubject, challenge.providerSubject))).limit(1),
    db.select().from(authIdentities).where(and(eq(authIdentities.provider, "wecom"), eq(authIdentities.memberId, authorized.memberId), isNull(authIdentities.unlinkedAt))).limit(1),
  ]);
  if ((existing && existing.memberId !== authorized.memberId) || (active && active.providerSubject !== challenge.providerSubject)) return failure("该企微身份已绑定其他账号，请联系管理员核实。", 409);
  const now = new Date().toISOString(); const receiptHash = await sha256Hex(randomBase64Url(32));
  const memberGuard = linkMemberGuard(challenge, authorized);
  const memberExists = exists(db.select({ id: members.id }).from(members).where(memberGuard));
  const claimed = and(eq(qrLoginChallenges.id, challenge.id), eq(qrLoginChallenges.status, "consumed"), eq(qrLoginChallenges.receiptHash, receiptHash), memberExists);
  const operations: [Parameters<Database["batch"]>[0][number], ...Parameters<Database["batch"]>[0][number][]] = [db.update(qrLoginChallenges).set({ status: "consumed", consumedAt: now, receiptHash }).where(and(
    liveChallenge(challenge.id, now), eq(qrLoginChallenges.browserNonceHash, challenge.browserNonceHash), eq(qrLoginChallenges.status, "approved"), memberExists)).returning({ id: qrLoginChallenges.id })];
  if (!existing) {
    operations.push(db.insert(authIdentities).select(db.select({ id: sql<string>`${crypto.randomUUID()}`.as("id"), memberId: sql<string>`${authorized.memberId}`.as("member_id"),
      provider: sql<string>`'wecom'`.as("provider"), providerSubject: sql<string>`${challenge.providerSubject}`.as("provider_subject"),
      loginSnapshot: sql<string>`${challenge.loginSnapshot || ""}`.as("login_snapshot"), verifiedEmailSnapshot: sql<string>`''`.as("verified_email_snapshot"),
      linkedAt: sql<string>`${now}`.as("linked_at"), lastSeenAt: sql<string>`${now}`.as("last_seen_at"), unlinkedAt: sql<string | null>`NULL`.as("unlinked_at"),
    }).from(qrLoginChallenges).where(claimed)).returning({ id: authIdentities.id }));
  } else if (existing.unlinkedAt) {
    operations.push(db.update(authIdentities).set({ unlinkedAt: null, linkedAt: now, lastSeenAt: now, loginSnapshot: challenge.loginSnapshot || "" }).where(and(
      eq(authIdentities.id, existing.id), eq(authIdentities.memberId, authorized.memberId), eq(authIdentities.unlinkedAt, existing.unlinkedAt), exists(db.select({ id: qrLoginChallenges.id }).from(qrLoginChallenges).where(claimed)))).returning({ id: authIdentities.id }));
  }
  if (!existing || existing.unlinkedAt) {
    const identityChanged = exists(db.select({ id: authIdentities.id }).from(authIdentities).where(and(eq(authIdentities.provider, "wecom"),
      eq(authIdentities.providerSubject, challenge.providerSubject), eq(authIdentities.memberId, authorized.memberId), eq(authIdentities.linkedAt, now), isNull(authIdentities.unlinkedAt))));
    operations.push(db.insert(memberEvents).select(db.select({ id: sql<number>`NULL`.as("id"), memberId: sql<string>`${authorized.memberId}`.as("member_id"),
      actorName: sql<string>`${authorized.user.displayName}`.as("actor_name"), actorEmail: sql<string>`${authorized.user.email}`.as("actor_email"),
      action: sql<string>`'wecom_identity_linked'`.as("action"), note: sql<string>`'成员本人在已准入 OA 账号与手机企微验证后显式绑定；按稳定企业成员 ID 关联，未按姓名或邮箱合并，未保存企微访问令牌。'`.as("note"), createdAt: sql<string>`${now}`.as("created_at"),
    }).from(qrLoginChallenges).where(and(claimed, identityChanged))).returning({ id: memberEvents.id }));
  }
  const result = await db.batch(operations);
  if (!result[0][0] || (operations.length > 1 && !result[1][0])) return failure("成员或绑定状态已变化，请重新发起。", 409);
  return json({ status: "consumed", linked: true });
}

export async function qrStatus(request: Request) { return guarded(async () => {
  const body = await bodyForPost(request); if (body instanceof Response) return body;
  const context = await desktopChallenge(body.id); if (!context) return failure("电脑登录请求已失效，请刷新二维码。", 403);
  const { db, challenge } = context;
  if (expired(challenge)) return json({ status: "expired" });
  if (challenge.status !== "approved") return json({ status: challenge.status, verificationCode: challenge.verificationCode });
  return challenge.action === "link" ? consumeLink(db, challenge) : consumeLogin(db, challenge);
}); }

export async function cancelQrLogin(request: Request) { return guarded(async () => {
  const body = await bodyForPost(request); if (body instanceof Response) return body;
  const context = await desktopChallenge(body.id); if (!context) return failure("电脑登录请求已失效。", 403);
  await context.db.update(qrLoginChallenges).set({ status: "denied", denialReason: "desktop-cancelled" }).where(and(
    eq(qrLoginChallenges.id, context.challenge.id), ne(qrLoginChallenges.status, "consumed")));
  return json({ ok: true });
}); }
