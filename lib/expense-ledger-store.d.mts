import type { AuthorizedUser } from '../app/api/_lib/auth';
export function loadLedger(db:D1Database,user:AuthorizedUser):Promise<Record<string,unknown>>;
export function mutateLedger(db:D1Database,user:AuthorizedUser,input:Record<string,unknown>):Promise<Record<string,unknown>>;
