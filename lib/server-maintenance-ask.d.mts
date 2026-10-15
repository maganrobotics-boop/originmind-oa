export type ServerMaintenanceAnswer = {
  answer: string;
  mode: 'server_maintenance';
  operationConfirmed: boolean;
  conversationId?: string;
  steps?: Array<{server: string; action: string; ok: boolean; summary?: string}>;
};
export function answerServerMaintenanceQuestion(request: Request, question: string, options?: {dedicated?: boolean; general?: boolean; conversationId?: string}): Promise<ServerMaintenanceAnswer | null>;
