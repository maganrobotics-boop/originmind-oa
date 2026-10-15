import Link from 'next/link';

export function ServerAssistantEntry({ isAdmin }: { isAdmin: boolean }) {
  if (!isAdmin) return null;
  return <><Link className="secondary-action oa-server-assistant-entry" href="/server-assistant">服务器助手</Link><Link className="secondary-action oa-general-assistant-entry" href="/ai-assistant">通用 AI 助手</Link></>;
}
