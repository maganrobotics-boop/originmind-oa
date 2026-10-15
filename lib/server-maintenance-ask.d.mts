export type ServerMaintenanceAnswer = {
  answer: string;
  mode: 'server_maintenance';
  operationConfirmed: boolean;
};
export function answerServerMaintenanceQuestion(request: Request, question: string): Promise<ServerMaintenanceAnswer | null>;
