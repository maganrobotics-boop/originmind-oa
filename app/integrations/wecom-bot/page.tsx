"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";

type Pairing = { id: string; expiresAt: string; state: "pending" | "candidate"; userIdHint?: string };
type BotState = { enabled: boolean; memberName?: string; linked: null | { userIdHint: string; linkedAt: string }; pairing: Pairing | null };
const endpoint = "/api/integrations/wecom-bot/link";

export default function WecomBotBindingPage() {
  const [state, setState] = useState<BotState | null>(null);
  const [command, setCommand] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    const response = await fetch(endpoint, { credentials: "same-origin", cache: "no-store" });
    const data = await response.json() as BotState & { error?: string };
    if (!response.ok) throw new Error(data.error || "绑定信息暂不可用。");
    setState(data);
    if (!data.pairing) setCommand("");
  }, []);
  const pairingId = state?.pairing?.id;
  const pairingExpiry = state?.pairing?.expiresAt;
  useEffect(() => {
    const timer = setTimeout(() => { void refresh().catch(cause => setError(cause instanceof Error ? cause.message : "请稍后重试。")); }, 0);
    return () => clearTimeout(timer);
  }, [refresh]);
  useEffect(() => {
    if (!pairingId || !pairingExpiry) return;
    const deadline = Date.parse(pairingExpiry);
    const timer = setInterval(() => {
      if (Date.now() >= deadline) { clearInterval(timer); setCommand(""); }
      void refresh().catch(() => setError("绑定状态读取失败，请刷新页面。"));
    }, 3000);
    return () => clearInterval(timer);
  }, [pairingId, pairingExpiry, refresh]);

  async function act(action: "create" | "confirm" | "cancel" | "unlink") {
    setBusy(true); setError(""); setNotice("");
    try {
      const response = await fetch(endpoint, {
        method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" },
        body: JSON.stringify({ action, ...(action === "confirm" || action === "cancel" ? { pairingId: state?.pairing?.id } : {}) }),
      });
      const data = await response.json() as { error?: string; command?: string; code?: string };
      if (!response.ok) throw new Error(data.error || "操作未完成，请重试。");
      if (action === "create") setCommand(data.command || `/绑定 ${data.code}`);
      else setCommand("");
      await refresh();
      if (action === "confirm") setNotice("已绑定。可以回企微私聊助研，发送“我的待办”或提问。");
      if (action === "unlink") setNotice("已解除机器人绑定。");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "操作未完成，请重试。"); }
    finally { setBusy(false); }
  }

  return <main style={{ maxWidth: 620, margin: "0 auto", padding: "32px 20px", lineHeight: 1.7, fontFamily: "system-ui, sans-serif" }}>
    <Link href="/">← 返回 OA</Link>
    <h1 style={{ fontSize: 26, marginTop: 24 }}>绑定企微助研</h1>
    <p>绑定后，企微助研可以按你的 OA 权限回答问题，并查询你自己的待办。</p>
    {error && <p role="alert" style={{ color: "#b42318" }}>{error}</p>}
    {notice && <p role="status" style={{ color: "#067647" }}>{notice}</p>}
    {!state && !error && <p role="status">正在读取绑定信息…</p>}
    {state && !state.enabled && <p>企微助研尚未启用，配置完成后可在这里绑定。</p>}
    {state?.enabled && <>
      {state.memberName && <p>当前 OA 成员：<strong>{state.memberName}</strong></p>}
      {state.linked ? <section>
        <p>已绑定的企微账号标识：<strong>{state.linked.userIdHint}</strong></p>
        <p>打开企微与助研私聊，发送“我的待办”或直接提问。</p>
        <button disabled={busy} onClick={() => void act("unlink")}>解除绑定</button>
      </section> : <section>
        {!state.pairing && <button disabled={busy} onClick={() => void act("create")}>生成绑定码</button>}
        {state.pairing && <>
          <p>请在 <strong>与企微助研的私聊</strong> 中发送下方指令。绑定码有效期为 5 分钟。</p>
          {command ? <><pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", background: "#f2f4f7", padding: 16, borderRadius: 8 }}>{command}</pre>
            <button disabled={busy} onClick={() => void navigator.clipboard.writeText(command).then(() => setNotice("已复制绑定指令。")).catch(() => setError("请手动选中并复制绑定指令。"))}>复制指令</button></>
            : <p>绑定码只在生成时显示。若已刷新页面，请取消后重新生成。</p>}
          {state.pairing.state === "candidate" ? <div style={{ marginTop: 20, padding: 16, border: "1px solid #d0d5dd", borderRadius: 8 }}>
            <p>收到企微账号标识：<strong>{state.pairing.userIdHint}</strong></p>
            <p>请确认刚才是你本人在私聊中发送绑定码，再将它关联到当前 OA 账号。</p>
            <button disabled={busy} onClick={() => void act("confirm")}>确认绑定到我的 OA 账号</button>
          </div> : <p role="status">等待你在企微私聊发送绑定指令…</p>}
          <p><button disabled={busy} onClick={() => void act("cancel")}>取消这次绑定</button></p>
        </>}
      </section>}
    </>}
  </main>;
}
