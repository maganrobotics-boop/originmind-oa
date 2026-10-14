'use client';

import type { ReactNode } from 'react';
import { Bot, Mic, Settings2, Video } from 'lucide-react';
import './oa-workbench-settings.css';

const entries = [
  { label: '模型设置', href: '/admin#model-settings', icon: Bot },
  { label: '实时字幕', href: '/admin#subtitle-settings', icon: Mic },
  { label: '会议设置', href: '/admin/meeting-bot', icon: Video },
  { label: '系统管理', href: '/admin#security-settings', icon: Settings2 },
] as const;

export function OaWorkbenchSettings({ isAdmin = false, children }: { isAdmin?: boolean; children: ReactNode }) {
  if (!isAdmin) return <>{children}</>;
  return <div className="oa-workbench-settings">
    {children}
    <nav className="oa-workbench-settings-links" aria-label="管理设置快捷入口">
      {entries.map(({ label, href, icon: Icon }) => <a key={href} href={href}><Icon aria-hidden="true" /><span>{label}</span></a>)}
    </nav>
  </div>;
}
