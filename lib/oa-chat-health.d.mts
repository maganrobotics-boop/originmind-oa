export type ChatOutcome = { state: 'idle' | 'asking' | 'answered' | 'degraded' | 'no_evidence' | 'failed' | 'stopped'; at: number; received?: boolean; httpStatus?: number };
export type HealthSnapshot = { kind: 'idle' | 'ready' | 'network' | 'http' | 'invalid'; at: number; httpStatus?: number; data?: Record<string, unknown> };
export type HealthLight = { label: string; state: 'unknown' | 'ready' | 'unavailable' | 'attention'; detail: string };
export function replyOutcome(reply: { mode?: string; fallbackReason?: string }, at?: number): ChatOutcome;
export function chatHealthLights(snapshot: HealthSnapshot, outcome: ChatOutcome): HealthLight[];
