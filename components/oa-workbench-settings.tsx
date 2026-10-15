'use client';

import { Settings2 } from 'lucide-react';
import './oa-workbench-settings.css';

export function OaAdminSettingsButton({ isAdmin = false }: { isAdmin?: boolean }) {
  if (!isAdmin) return null;
  return <a className="oa-admin-settings-button" href="/admin"><Settings2 aria-hidden="true" /><span>管理员设置</span></a>;
}
