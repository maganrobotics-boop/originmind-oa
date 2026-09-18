"use client";

import { useEffect, useState } from 'react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { chatHealthLights, type HealthSnapshot } from '@/lib/oa-chat-health.mjs';
import { useOaConversation } from './oa-conversation-context';

export function OaChatStatus() {
  const { outcome } = useOaConversation();
  const [snapshot, setSnapshot] = useState<HealthSnapshot>({ kind: 'idle', at: 0 });
  useEffect(() => {
    let disposed = false;
    let controller: AbortController | undefined;
    let sequence = 0;
    const load = async () => {
      if (document.visibilityState === 'hidden') return;
      controller?.abort();
      const local = new AbortController(); controller = local;
      const run = ++sequence, at = Date.now();
      const update = (value: HealthSnapshot) => { if (!disposed && !local.signal.aborted && run === sequence) setSnapshot(value); };
      let received = false;
      try {
        const response = await fetch('/api/lab-ai/status', { credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.any([local.signal, AbortSignal.timeout(15000)]) });
        received = true;
        if (!response.ok) { update({ kind: 'http', at, httpStatus: response.status }); return; }
        const data: unknown = await response.json();
        if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Invalid status');
        update({ kind: 'ready', at, data: data as Record<string, unknown> });
      } catch { update({ kind: received ? 'invalid' : 'network', at }); }
    };
    void load();
    const interval = window.setInterval(load, 60000);
    document.addEventListener('visibilitychange', load);
    return () => { disposed = true; sequence++; controller?.abort(); window.clearInterval(interval); document.removeEventListener('visibilitychange', load); };
  }, []);
  const lights = chatHealthLights(snapshot, outcome);
  return <div className="oa-chat-title"><strong>AI 助手</strong><Popover><PopoverTrigger asChild>
    <button type="button" className="oa-chat-status-button" aria-label="查看系统连接状态">
      <span className="oa-chat-status" aria-hidden="true">{lights.map(light => <span key={light.label} className={light.state} title={`${light.label}：${light.detail}`} />)}</span>
    </button>
  </PopoverTrigger><PopoverContent className="oa-chat-status-details" align="center" aria-label="系统连接状态">
    <strong>从左到右依次对应</strong>
    {lights.map((light, index) => <div className="oa-chat-status-detail" key={light.label}><span className={`oa-status-dot ${light.state}`} aria-hidden="true" /><div><b>{index + 1}. {light.label}</b><p>{light.detail}</p></div></div>)}
    <small>绿色：检查通过；黄色：进行中或资料不足；红色：对应检查失败；灰色：尚未确认。</small>
  </PopoverContent></Popover></div>;
}
