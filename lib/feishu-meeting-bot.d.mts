export const BOT_SCOPE: string;
export type BotActor = { isAdmin: boolean; memberId: string; accountId: string; revision: string };
export type BotConfig = { origin: string; clientId: string; clientSecret: string; tenantKey: string; binding: string };
export function resolveMeetingBotConfig(env: Record<string, unknown>): BotConfig | null;
export function meetingNumber(value: unknown): string;
export class MeetingBotError extends Error { code: string; status: number; uncertain: boolean; trace: string; }
export function createMeetingBotStore(db: unknown, admissionGuard: string): unknown;
export function handleMeetingBotRequest(request: Request, ctx: { config: BotConfig | null; actor: BotActor; store: unknown; fetcher?: typeof fetch }): Promise<Response>;
