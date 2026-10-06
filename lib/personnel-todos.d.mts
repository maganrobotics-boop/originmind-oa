import type { AuthorizedUser } from '../app/api/_lib/auth';
import type { WorkItem } from './project-work-items';
export function getOwnPersonnelTodos(db:D1Database,user:AuthorizedUser):Promise<WorkItem[]>;
export function personnelTodoItems(ledger:Record<string,unknown>,user:AuthorizedUser):WorkItem[];
