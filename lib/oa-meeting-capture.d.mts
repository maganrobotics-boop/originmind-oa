export type MeetingEntry = { key: string; kind: string; actor: { id: string; name: string; userType: number }; time: number; revision: number; text: string };
export const CAPTURE_LIMIT: number;
export const MEETING_INSTRUCTION: string;
export function validMeetingId(value: unknown): value is string;
export function isMeetingCommand(value: string): boolean;
export function normalizeMeetingEvents(events: unknown): { entries: MeetingEntry[]; unsupported: number };
export function mergeCapture(previous: Map<string, MeetingEntry>, incoming: MeetingEntry[], limit?: number): Map<string, MeetingEntry>;
export function captureText(entries: Map<string, MeetingEntry>, title?: string): string;
export function meetingParts(text: string, max?: number): string[];
