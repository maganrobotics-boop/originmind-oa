'use client';

import Link from 'next/link';
import { FormEvent, useEffect, useState } from 'react';
import { ArrowLeft, Bot, CheckCircle2, ExternalLink, KeyRound, LockKeyhole, LogOut, RefreshCw, Save, Settings2, ShieldCheck, Video } from 'lucide-react';
import './admin.css';

type AdminState = {
  initialized: boolean;
  signedIn: boolean;
  baseUrl?: string;
  model?: string;
  keyConfigured?: boolean;
  encryptionReady?: boolean;
  activeProvider?: string | null;
  workersAiReady?: boolean;
  verifiedAt?: string | null;
};

type ApiResult = Partial<AdminState> & { error?: string; saved?: boolean; connected?: boolean };
const endpoint = '/api/admin/control';

async function post(body: object): Promise<ApiResult> {
  const response = await fetch(endpoint, {
    method: 'POST', credentials: 'same-origin', cache: 'no-store',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(body), signal: AbortSignal.timeout(75000),
  });
  const data = await response.json().catch(() => ({})) as ApiResult;
  if (!response.ok) throw new Error(data.error || '操作失败，请稍后重试。');
  return data;
}

export default function AdminPage() {
  const [state, setState] = useState<AdminState | null>(null);
  const [loadError, setLoadError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [resetOpen, setResetOpen] = useState(false);
  const [baseUrl, setBaseUrl] = useState('https://dashscope.aliyuncs.com/compatible-mode/v1');
  const [model, setModel] = useState('qwen-plus');
  const [apiKey, setApiKey] = useState('');

  const apply = (data: ApiResult) => {
    if (typeof data.initialized === 'boolean' && typeof data.signedIn === 'boolean') {
      setState(current => ({ ...(current || { initialized: false, signedIn: false }), ...data } as AdminState));
    } else if (state) setState({ ...state, ...data });
    if (typeof data.baseUrl === 'string' && data.baseUrl) setBaseUrl(data.baseUrl);
    if (typeof data.model === 'string' && data.model) setModel(data.model);
  };

  useEffect(() => {
    let active = true;
    void fetch(endpoint, { credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(15000) })
      .then(async response => {
        const data = await response.json().catch(() => ({})) as ApiResult;
        if (!active) return;
        if (!response.ok) throw new Error(data.error || '无法读取管理状态。');
        apply(data);
      })
      .catch(error => { if (active) setLoadError(error instanceof Error ? error.message : '无法读取管理状态。'); });
    return () => { active = false; };
    // State is intentionally initialized once from the authenticated endpoint.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const run = async (body: object, success: string) => {
    if (busy) return;
    setBusy(true); setNotice(''); setLoadError('');
    try { const result = await post(body); apply(result); setNotice(success); return result; }
    catch (error) { setLoadError(error instanceof Error ? error.message : '操作失败，请稍后重试。'); return null; }
    finally { setBusy(false); }
  };

  const login = async (event: FormEvent) => {
    event.preventDefault();
    const result = await run({ action: 'login', password }, '管理员身份已验证。');
    if (result) setPassword('');
  };

  const setAdminPassword = async (event: FormEvent) => {
    event.preventDefault();
    if (password.length < 12) { setLoadError('管理员密码至少需要 12 个字符。'); return; }
    if (password !== confirmation) { setLoadError('两次输入的密码不一致。'); return; }
    const result = await run({ action: 'setPassword', password }, state?.initialized ? '管理员密码已重设，其他管理会话已退出。' : '管理员密码已设置。');
    if (result) { setPassword(''); setConfirmation(''); setResetOpen(false); }
  };

  const save = async (event: FormEvent) => {
    event.preventDefault();
    const result = await run({ action: 'saveConfig', baseUrl, model, ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}) }, '阿里云百炼连接已验证并保存。');
    if (result) setApiKey('');
  };

  const logout = async () => {
    const result = await run({ action: 'logout' }, '管理会话已退出。');
    if (result) setState(current => current ? { ...current, signedIn: false } : current);
  };

  return <main className="admin-console">
    <header className="admin-topbar"><Link href="/"><ArrowLeft size={18} />返回 OA</Link><div><ShieldCheck size={19} /><strong>系统管理</strong></div></header>
    <section className="admin-hero"><span className="admin-kicker">ORIGINMIND OA CONTROL CENTER</span><h1>管理员控制台</h1><p>集中管理 OA 的模型连接与系统入口。API Key 加密保存，保存前会先验证连接，页面不会回显完整密钥。</p></section>

    {loadError && <div className="admin-alert error" role="alert">{loadError}</div>}
    {notice && <div className="admin-alert success" role="status"><CheckCircle2 size={18} />{notice}</div>}

    {!state && !loadError && <section className="admin-card admin-loading"><RefreshCw className="spin" />正在验证 OA 管理员权限…</section>}

    {state && (!state.initialized || resetOpen) && <section className="admin-card">
      <div className="admin-card-heading"><span className="admin-icon"><KeyRound /></span><div><h2>{state.initialized ? '重设管理员密码' : '设置管理员密码'}</h2><p>{state.initialized ? '重设后，现有 Chat 与 OA 管理会话会全部退出。' : '此密码同时用于 OA 控制台和 Chat 管理，只有密码摘要会保存。'}</p></div></div>
      <form className="admin-form" onSubmit={setAdminPassword}>
        <label><span>新密码</span><input type="password" value={password} minLength={12} maxLength={256} autoComplete="new-password" onChange={event => setPassword(event.target.value)} placeholder="至少 12 个字符" required /></label>
        <label><span>确认新密码</span><input type="password" value={confirmation} minLength={12} maxLength={256} autoComplete="new-password" onChange={event => setConfirmation(event.target.value)} required /></label>
        <div className="admin-actions"><button className="primary" type="submit" disabled={busy}>{busy ? '正在设置…' : state.initialized ? '确认重设密码' : '设置密码并登录'}</button>{state.initialized && <button type="button" onClick={() => { setResetOpen(false); setPassword(''); setConfirmation(''); }}>取消</button>}</div>
      </form>
    </section>}

    {state?.initialized && !state.signedIn && !resetOpen && <section className="admin-card admin-auth-card">
      <div className="admin-card-heading"><span className="admin-icon"><LockKeyhole /></span><div><h2>验证管理员密码</h2><p>OA 账号权限已通过，再输入独立管理密码进入敏感配置区。</p></div></div>
      <form className="admin-form" onSubmit={login}><label><span>管理员密码</span><input type="password" value={password} maxLength={256} autoComplete="current-password" onChange={event => setPassword(event.target.value)} required /></label><div className="admin-actions"><button className="primary" type="submit" disabled={busy}>{busy ? '正在验证…' : '进入控制台'}</button><button type="button" onClick={() => { setResetOpen(true); setLoadError(''); }}>由 OA 管理员重设密码</button></div></form>
    </section>}

    {state?.signedIn && !resetOpen && <div className="admin-grid">
      <section className="admin-card admin-model-card">
        <div className="admin-card-heading"><span className="admin-icon"><Bot /></span><div><h2>阿里云百炼模型</h2><p>用于 OA 大模型问答、任务生成和 Chat 回答。</p></div><span className={`admin-status ${state.activeProvider === 'bailian' ? 'ready' : ''}`}>{state.activeProvider === 'bailian' ? '已连接' : '待配置'}</span></div>
        <form className="admin-form" onSubmit={save}>
          <label><span>API Base URL</span><input type="url" value={baseUrl} maxLength={300} onChange={event => setBaseUrl(event.target.value)} required /></label>
          <label><span>模型名称</span><input value={model} pattern="qwen[a-zA-Z0-9_.-]{1,100}" maxLength={104} onChange={event => setModel(event.target.value)} placeholder="qwen-plus" required /></label>
          <label><span>API Key</span><input type="password" value={apiKey} maxLength={400} autoComplete="off" onChange={event => setApiKey(event.target.value)} placeholder={state.keyConfigured ? '已安全保存；留空则保持不变' : 'sk-…'} /><small>{state.keyConfigured ? '密钥已配置，系统不会回显原值。' : '首次保存必须填写 API Key。'}</small></label>
          <div className="admin-metadata"><span>加密存储：{state.encryptionReady ? '就绪' : '不可用'}</span><span>上次验证：{state.verifiedAt ? new Date(state.verifiedAt).toLocaleString('zh-CN') : '尚未验证'}</span></div>
          <div className="admin-actions"><button className="primary" type="submit" disabled={busy || !state.encryptionReady}><Save size={17} />{busy ? '正在验证…' : '验证并保存'}</button><button type="button" disabled={busy || !state.keyConfigured} onClick={() => void run({ action: 'test' }, '当前模型配置连接正常。')}><RefreshCw size={17} />检测当前连接</button><a href="https://bailian.console.aliyun.com/" target="_blank" rel="noreferrer">打开百炼控制台 <ExternalLink size={14} /></a></div>
        </form>
      </section>

      <aside className="admin-side">
        <section className="admin-card"><div className="admin-card-heading"><span className="admin-icon"><Settings2 /></span><div><h2>管理入口</h2><p>更多实验室 OA 管理工具。</p></div></div><nav className="admin-links"><Link href="/admin/meeting-bot"><Video />飞书会议机器人</Link><Link href="/admin/meeting-minutes"><Settings2 />会议纪要管理</Link></nav></section>
        <section className="admin-card admin-security"><h2>安全状态</h2><ul><li><CheckCircle2 />仅 OA 系统管理员可访问</li><li><CheckCircle2 />管理密码独立校验</li><li><CheckCircle2 />API Key 使用 AES-GCM 加密</li><li><CheckCircle2 />候选配置验证成功后才替换</li></ul><div className="admin-actions vertical"><button type="button" onClick={() => setResetOpen(true)}><KeyRound size={16} />重设管理员密码</button><button type="button" onClick={() => void logout()}><LogOut size={16} />退出管理会话</button></div></section>
      </aside>
    </div>}
  </main>;
}
