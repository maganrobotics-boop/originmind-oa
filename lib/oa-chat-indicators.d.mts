export type ChatIndicator = { label: string; state: 'unknown' | 'pending' | 'ready' | 'unavailable' | 'warning'; detail: string };
export type ChatIndicatorSnapshot = { source: 'probe' | 'question'; summary: string; checkedAt: number; items: ChatIndicator[] };
export function initialChatIndicators(): ChatIndicatorSnapshot;
export function probeChatIndicators(status: number | null, payload?: unknown): ChatIndicatorSnapshot;
export function pendingChatIndicators(): ChatIndicatorSnapshot;
export function replyChatIndicators(payload: unknown): ChatIndicatorSnapshot;
export function failedChatIndicators(status?: number | null, stopped?: boolean): ChatIndicatorSnapshot;
