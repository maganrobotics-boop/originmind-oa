export const MEETING_SCOPE: string;
export const MEETING_PATH: string;
export const GRANT_COOKIE: string;
export const STATE_COOKIE: string;
export type MeetingConfig = { origin: string; clientId: string; clientSecret: string; tenantKey: string };
export function validTokenKey(value: unknown): boolean;
export function handleMeetingRequest(request: Request, ctx: { actor: string[]; config: MeetingConfig; key: string; fetcher?: typeof fetch }): Promise<Response>;
