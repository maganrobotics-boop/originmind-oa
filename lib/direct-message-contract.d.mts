export const DIRECT_MESSAGE_MAX_LENGTH: number;
export const DIRECT_MESSAGE_REQUEST_BYTES: number;
export const DIRECT_MESSAGE_ID: RegExp;
export function parseDirectMessageInput(record: unknown): { recipientEmail: string; messageBody: string; clientMessageId?: string } | null;
export function sameDirectMessage(row: unknown, senderEmail: string, recipientEmail: string, body: string): boolean;
