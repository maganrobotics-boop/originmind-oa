import { cookies } from 'next/headers';
import { getDb } from '../../../../db';
import { callOaAdmin, OaAdminBridgeError, type OaAdminResult } from '../../../../lib/oa-admin-client';
import { consumeWriteRateLimit } from '../../../../lib/write-rate-limit';
import { getAuthorizedUser } from '../../_lib/auth';

const COOKIE = '__Host-oa-admin-console';
const SESSION_SECONDS = 43_200;
const responseHeaders = { 'cache-control': 'private, no-store, max-age=0', 'x-content-type-options': 'nosniff', vary: 'Cookie' };
const json = (data: object, status = 200) => Response.json(data, { status, headers: responseHeaders });

function sameOrigin(request: Request) {
  const origin = request.headers.get('origin');
  const site = request.headers.get('sec-fetch-site');
  return origin === new URL(request.url).origin && (!site || site === 'same-origin');
}

async function readBody(request: Request) {
  const length = Number(request.headers.get('content-length') || 0);
  if (Number.isFinite(length) && length > 2_500) throw new OaAdminBridgeError('请求内容过长。', 413);
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) throw new OaAdminBridgeError('请求格式不正确。', 415);
  if (!request.body) throw new OaAdminBridgeError('请求格式不正确。', 400);
  const reader = request.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read(); if (done) break;
      size += value.length;
      if (size > 2_500) { await reader.cancel(); throw new OaAdminBridgeError('请求内容过长。', 413); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  let value: unknown;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw new OaAdminBridgeError('请求格式不正确。', 400); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new OaAdminBridgeError('请求格式不正确。', 400);
  return value as Record<string, unknown>;
}

async function authorizedAdmin(readOnly = false) {
  const user = await getAuthorizedUser({ readOnly });
  if (!user) throw new OaAdminBridgeError('请先登录 OA。', 401);
  if (!user.isAdmin || !user.ndaCompleted || !user.memberId || !user.accountUserId || !user.memberMutationRevision) {
    throw new OaAdminBridgeError('仅已完成准入的 OA 管理员可以打开系统管理。', 403);
  }
  return user;
}

function publicResult(result: OaAdminResult) {
  const safe = { ...result };
  delete safe.sessionToken;
  return safe;
}

export async function GET() {
  try {
    await authorizedAdmin(true);
    const token = (await cookies()).get(COOKIE)?.value;
    return json(publicResult(await callOaAdmin({ operation: 'status', ...(token ? { sessionToken: token } : {}) })));
  } catch (error) {
    if (error instanceof OaAdminBridgeError) return json({ error: error.message }, error.status);
    return json({ error: '系统管理服务暂不可用，请稍后重试。' }, 503);
  }
}

export async function POST(request: Request) {
  try {
    if (!sameOrigin(request)) throw new OaAdminBridgeError('请从 OA 管理页面提交。', 403);
    const user = await authorizedAdmin();
    if (!await consumeWriteRateLimit(await getDb(), { actorSubject: user.accountUserId!, scope: 'admin_control', limit: 20 })) {
      throw new OaAdminBridgeError('操作过于频繁，请稍后再试。', 429);
    }
    const body = await readBody(request);
    const action = body.action;
    const token = (await cookies()).get(COOKIE)?.value || '';
    let payload: object;
    if (action === 'login' && typeof body.password === 'string') payload = { operation: 'login', password: body.password };
    else if (action === 'setPassword' && typeof body.password === 'string') payload = { operation: 'set_password', password: body.password, actor: user.accountUserId! };
    else if (action === 'logout') payload = { operation: 'logout', sessionToken: token };
    else if (action === 'saveConfig' && typeof body.baseUrl === 'string' && typeof body.model === 'string'
      && (body.apiKey === undefined || typeof body.apiKey === 'string')) payload = {
      operation: 'config_save', sessionToken: token, baseUrl: body.baseUrl, model: body.model,
      ...(body.apiKey === undefined ? {} : { apiKey: body.apiKey }),
    };
    else if (action === 'test') payload = { operation: 'test', sessionToken: token };
    else throw new OaAdminBridgeError('请求内容不正确。', 400);
    const result = await callOaAdmin(payload);
    const cookieStore = await cookies();
    if (result.sessionToken) cookieStore.set(COOKIE, result.sessionToken, { httpOnly: true, secure: true, sameSite: 'strict', path: '/', maxAge: SESSION_SECONDS });
    if (action === 'logout') cookieStore.set(COOKIE, '', { httpOnly: true, secure: true, sameSite: 'strict', path: '/', maxAge: 0 });
    return json(publicResult(result));
  } catch (error) {
    if (error instanceof OaAdminBridgeError) {
      if (error.status === 401) (await cookies()).set(COOKIE, '', { httpOnly: true, secure: true, sameSite: 'strict', path: '/', maxAge: 0 });
      return json({ error: error.message }, error.status);
    }
    return json({ error: '系统管理服务暂不可用，请稍后重试。' }, 503);
  }
}
