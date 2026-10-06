export const STAGES: Record<string,string>;
export class LedgerError extends Error {status:number;constructor(message:string,status?:number)}
export function cents(value:unknown):number;
export function csvRows(text:string):string[][];
export function core(t:Record<string, unknown>):string;
export function parseAlipay(text:string,people:Record<string, unknown>[]):{transactions:Record<string, unknown>[];sourceCount:number;ignoredCount:number};
export function assemble(people:Record<string, unknown>[],transactions:Record<string, unknown>[],claims?:Record<string, unknown>[],today?:string):{people:Record<string, unknown>[];records:Record<string, unknown>[];unmatchedRefunds:Record<string, unknown>[]};
export function validateClaim(input:unknown,netCents:number,today?:string):Record<string,Record<string, unknown>>;
