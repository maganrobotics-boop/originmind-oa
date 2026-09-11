"use client";
import { useEffect, useState } from "react";
import { Button } from "./ui/button";
type Data = { enabled: boolean; counts: { status: string; count: number }[]; failures: { id: string; status: string; failure_code: string }[]; latestTest: { status: string; failure_code: string | null; sent_at: number | null } | null };
const labels: Record<string, string> = { pending: "等待发送或重试", sending: "正在发送", sent: "飞书已接收", skipped: "已处理，无需再提醒", failed: "需要检查成员飞书绑定", needs_review: "需要管理员检查" };
export function NotificationStatus() {
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [refresh, setRefresh] = useState(0);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    const load = () => fetch("/api/admin/notifications", { credentials: "same-origin", signal: controller.signal }).then(async (response) => {
      const result = await response.json() as Data & { error?: string };
      if (!response.ok) throw new Error(result.error || "提醒状态读取失败");
      setData(result); setError("");
    }).catch((error: unknown) => { if (!controller.signal.aborted) setError(error instanceof Error ? error.message : "提醒状态读取失败"); });
    void load();
    const timer = window.setInterval(load, 15000);
    return () => { controller.abort(); window.clearInterval(timer); };
  }, [refresh]);
  const testSelf = async () => {
    setBusy(true); setMessage("");
    try {
      const response = await fetch("/api/admin/notifications", { method: "POST", credentials: "same-origin" });
      const result = await response.json() as { error?: string; message?: string };
      if (!response.ok) throw new Error(result.error || "测试提交失败");
      setMessage(result.message || "已加入发送队列。"); setRefresh((value) => value + 1);
    } catch (error) { setMessage(error instanceof Error ? error.message : "测试提交失败"); }
    finally { setBusy(false); }
  };
  return <section className="space-y-5" aria-label="飞书提醒状态">
    <div><h1 className="text-xl font-semibold">飞书提醒</h1><p className="text-sm text-muted-foreground">当前处理人收到待办提醒；退回时通知申请人。消息仅含节点和 OA 链接，正文需登录查看。</p></div>
    <p role="status">{error || (data ? data.enabled ? "自动提醒已启用，每分钟检查失败重试。" : "自动提醒尚未启用。" : "正在读取…")}</p>
    <div className="flex flex-wrap gap-3"><Button disabled={busy || !data?.enabled} onClick={() => void testSelf()}>给我本人发送测试提醒</Button><Button variant="outline" onClick={() => setRefresh((value) => value + 1)}>刷新状态</Button></div>
    <p role="status">{message}</p>
    {data?.latestTest && <p>最近一次测试：{labels[data.latestTest.status] || data.latestTest.status}{data.latestTest.failure_code ? `（${data.latestTest.failure_code}）` : ""}</p>}
    <div className="grid gap-3 sm:grid-cols-2">{data?.counts.map((item) => <div key={item.status} className="rounded-xl border bg-white p-4"><strong>{item.count}</strong><p>{labels[item.status] || item.status}</p></div>)}</div>
    {Boolean(data?.failures.length) && <div className="rounded-xl border bg-white p-4 space-y-2"><h2 className="font-semibold">待检查记录</h2><p>原审批仍保留在 OA 待办中。检查飞书应用的机器人能力、发送消息权限及成员可见范围。</p>{data?.failures.map((failure) => <p key={failure.id}>{labels[failure.status]} · {failure.failure_code}</p>)}</div>}
  </section>;
}
