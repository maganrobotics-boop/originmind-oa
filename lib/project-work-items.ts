export const OA_PROJECT = 'OriginMind × ARTS Robotics 联合研发项目';

export type WorkItemKind = 'task' | 'meeting_action' | 'risk' | 'milestone';
export type WorkItemStatus = 'open' | 'in_progress' | 'done' | 'cancelled';
export type WorkItem = {
  id: string; project: string; title: string; detail: string; kind: WorkItemKind; status: WorkItemStatus;
  priority: 'low' | 'normal' | 'high'; assigneeName: string; assigneeEmail: string; dueAt: string | null;
  sourceType: 'manual' | 'meeting' | 'approval'; sourceId: string; createdByName: string; createdByEmail: string;
  completedAt: string | null; createdAt: string; updatedAt: string;
};

export type WorkItemRow = {
  id: string; project: string; title: string; detail: string; kind: WorkItemKind; status: WorkItemStatus;
  priority: 'low' | 'normal' | 'high'; assignee_name: string; assignee_email: string; due_at: string | null;
  source_type: 'manual' | 'meeting' | 'approval'; source_id: string; created_by_name: string; created_by_email: string;
  completed_at: string | null; created_at: string; updated_at: string;
};

export const serializeWorkItem = (row: WorkItemRow): WorkItem => ({
  id: row.id, project: row.project, title: row.title, detail: row.detail, kind: row.kind, status: row.status,
  priority: row.priority, assigneeName: row.assignee_name, assigneeEmail: row.assignee_email, dueAt: row.due_at,
  sourceType: row.source_type, sourceId: row.source_id, createdByName: row.created_by_name,
  createdByEmail: row.created_by_email, completedAt: row.completed_at, createdAt: row.created_at, updatedAt: row.updated_at,
});

const cleanLine = (value: string) => value.replace(/^\s*(?:[-*•]|\d+[.)、])\s*/u, '').replace(/\s+/gu, ' ').trim();

export function extractMeetingActions(markdown: string) {
  const lines = markdown.split(/\r?\n/u);
  let inActions = false;
  const actions: string[] = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (/^#{1,4}\s*(?:行动项|待办|行动计划)/u.test(line)) { inActions = true; continue; }
    if (inActions && /^#{1,4}\s+/u.test(line)) break;
    if (!inActions || !/^\s*(?:[-*•]|\d+[.)、])\s+/u.test(raw)) continue;
    const title = cleanLine(raw);
    if (title && !/^(?:暂无|无|待补充)[。.!！]?$/u.test(title) && title.length <= 240) actions.push(title);
  }
  return [...new Set(actions)].slice(0, 30);
}
