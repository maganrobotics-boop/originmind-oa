import type { AuthorizedUser } from '../app/api/_lib/auth';
export type PersonnelAnswer = {answer:string;mode:'personnel';sourceType:'oa_personnel_records';citations:[];images:[];personnelLinks:{name:string;href:string}[]};
export function answerPersonnelQuestion(db:unknown,user:Pick<AuthorizedUser,'memberId'|'accountUserId'|'memberMutationRevision'|'ndaCompleted'|'isAdmin'|'isFinanceOwner'> & {user:{email:string;displayName:string}},question:string,history?:{role:string;content:string}[]):Promise<PersonnelAnswer|null>;
