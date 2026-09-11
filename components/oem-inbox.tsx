"use client";

import { useEffect, useState } from "react";
import { Button } from "./ui/button";

type Application = { id: string; language: string; createdAt: number; fields: Record<string, string> };
const labels: Record<string, string> = { company: "公司", contact: "联系人", email: "联系邮箱", phone: "电话 / 微信", robot: "机器人型号", stack: "系统与接口", start: "希望启动时间", quantity: "预计部署数量", test_unit: "样机和资料", capabilities: "现有与目标能力", summary: "补充说明" };

export function OemInbox() {
  const [applications, setApplications] = useState<Application[]>([]);
  const [cursor, setCursor] = useState("");
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    fetch(`/api/admin/oem-applications${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`, { credentials: "same-origin", signal: controller.signal })
      .then(async (response) => { const body = await response.json() as { applications: Application[]; nextCursor: string | null; error?: string }; if (!response.ok) throw new Error(body.error || "申请读取失败"); if (!Array.isArray(body.applications)) throw new Error("申请数据格式异常"); return body; })
      .then((body) => { setApplications(body.applications); setNextCursor(body.nextCursor); })
      .catch((error: unknown) => { if (!controller.signal.aborted) setError(error instanceof Error ? error.message : "申请读取失败"); })
      .finally(() => { if (!controller.signal.aborted) setBusy(false); });
    return () => controller.abort();
  }, [cursor, reload]);
  const navigate = (next: string) => { setBusy(true); setError(""); setCursor(next); setReload((value) => value + 1); };
  return <section aria-label="官网 OEM 申请" aria-busy={busy} className="space-y-5">
    <div className="flex flex-wrap items-center justify-between gap-3"><div><h1 className="text-xl font-semibold">官网 OEM 申请</h1><p className="text-sm text-muted-foreground">仅管理员可查看。请通过申请人填写的邮箱沟通，回执编号可用于核对。</p></div><Button variant="outline" disabled={busy} onClick={() => navigate("")}>刷新最新申请</Button></div>
    <p role="status">{busy ? "正在读取…" : error || (!applications.length ? "暂无官网申请。" : "")}</p>
    {!busy && !error && applications.map((item) => <article key={item.id} className="rounded-xl border bg-white p-5 space-y-3">
      <h2 className="font-semibold">{item.fields.company} · {item.fields.contact}</h2>
      <p className="break-all text-sm text-muted-foreground">{item.id} · {new Date(item.createdAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })}（北京时间）· {item.language}</p>
      <p>意向方向：{item.fields.track === "foundation" ? "基础版" : "升级版"}</p>
      <dl className="grid gap-3 sm:grid-cols-2">{Object.entries(labels).map(([key, label]) => <div key={key}><dt className="text-sm text-muted-foreground">{label}</dt><dd className="whitespace-pre-wrap break-words">{item.fields[key] || "—"}</dd></div>)}</dl>
      <a className="text-blue-700 underline" href={`mailto:${encodeURIComponent(item.fields.email)}`}>联系申请人</a>
    </article>)}
    {!error && <div className="flex gap-3"><Button variant="outline" disabled={busy || !cursor} onClick={() => navigate("")}>回到最新</Button><Button variant="outline" disabled={busy || !nextCursor} onClick={() => navigate(nextCursor || "")}>更早的申请</Button></div>}
  </section>;
}
