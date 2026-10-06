import { getAuthorizedUser } from '../_lib/auth';
import { getD1Database, getDb } from '../../../db';
import { readBoundedJsonObject } from '../../../lib/bounded-json-request';
import { isMigrationWriteFrozen } from '../../../lib/migration-freeze';
import { consumeWriteRateLimit } from '../../../lib/write-rate-limit';
import { LedgerError } from '../../../lib/expense-ledger.mjs';
import { loadLedger, mutateLedger } from '../../../lib/expense-ledger-store.mjs';

import { POST as createApproval } from '../approvals/route';

export const dynamic='force-dynamic';
const headers={'cache-control':'private, no-store, max-age=0','x-content-type-options':'nosniff',vary:'Cookie'};
const json=(data:unknown,status=200)=>Response.json(data,{status,headers});
async function authorize(){const user=await getAuthorizedUser({readOnly:true});if(!user)throw new LedgerError('请先登录 OA。',401);if(!user.ndaCompleted||!user.memberId||!user.accountUserId||!user.memberMutationRevision)throw new LedgerError('请先完成 OA 成员准入。',403);return user;}
const failure=(error:unknown)=>error instanceof LedgerError?json({error:error.message},error.status):json({error:'消费账单暂时不可用，请稍后重试。'},503);
export async function GET(){try {const user=await authorize();return json(await loadLedger(await getD1Database(),user));}catch(error){return failure(error);}}
export async function POST(request:Request){try {
  const site=request.headers.get('sec-fetch-site');if(request.headers.get('origin')!==new URL(request.url).origin||(site&&site!=='same-origin'))throw new LedgerError('请从 OA 消费账单页面操作。',403);
  const user=await authorize();if(isMigrationWriteFrozen(process.env))throw new LedgerError('系统维护期间暂停修改。',503);
  if(!await consumeWriteRateLimit(await getDb(),{actorSubject:user.accountUserId!,scope:'approval_write',limit:30}))throw new LedgerError('操作较多，请稍后重试。',429);
  const body=await readBoundedJsonObject(request,6_000_000);if(!body.ok)throw new LedgerError('请求过大或格式不正确。',body.reason==='too_large'?413:400);
  const result=await mutateLedger(await getD1Database(),user,body.value);
  if(result.nativeApproval){const response=await createApproval(new Request(new URL('/api/approvals',request.url),{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(result.nativeApproval)}));const approval=await response.json() as {error?:string;approval?:{id?:string}};if(!response.ok)return json({error:(approval.error||'OA 提交暂未完成')+'；工作内容已保留，可刷新后重试。'},response.status);return json({saved:true,approvalId:approval.approval?.id});}
  return json(result);
}catch(error){return failure(error);}}
