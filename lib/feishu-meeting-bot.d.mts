export type BotEnv = {
  OA_PUBLIC_ORIGIN?: string;
  OA_MEETING_BOT_ENABLED?: string;
  FEISHU_LOGIN_APP_ID?: string;
  FEISHU_LOGIN_APP_SECRET?: string;
  FEISHU_LOGIN_TENANT_KEY?: string;
};
export function normalizeMeetingNumber(value: unknown): string | null;
export function botConfiguration(env: BotEnv): { origin: string; missing: string[]; configured: boolean; enabled: boolean };
export type MeetingEventTranscript = { id: string; speaker: string; text: string; time: string };
export function sanitizeMeetingEvents(value: unknown): {
  transcript: MeetingEventTranscript[];
  participants: string[];
  meeting: { topic: string; startTime: string; endTime: string };
  meetingEnded: boolean;
  hasMore: boolean;
  pageToken: string | null;
  contentTruncated: boolean;
};
export function handleBotRequest(request: Request, options: {
  env: BotEnv;
  actorKey: string;
  checkAdmission: () => Promise<boolean>;
  claimWrite: (action: string) => Promise<boolean>;
  fetchImpl?: typeof fetch;
}): Promise<Response>;
