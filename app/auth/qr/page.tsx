"use client";

/* Server-confirmed authorization state drives the mobile screen. */
/* eslint-disable react-hooks/set-state-in-effect */

import { useCallback, useEffect, useRef, useState } from "react";
import "./qr-mobile.css";

type Provider = "feishu" | "wecom";
type MobilePhase = "choose" | "confirm" | "approved" | "denied" | "expired";
type MobileChallenge = {
  phase: MobilePhase;
  providers: Provider[];
  verificationCode: string;
  desktopLabel: string;
  createdAt: string;
  action: "login" | "link";
  displayName?: string;
  linkTargetName?: string;
  linkTargetAccountHint?: string;
  error?: string;
};

function providerName(provider: Provider) {
  return provider === "feishu" ? "飞书" : "企业微信";
}

function detectedProvider() {
  if (/wxwork/iu.test(navigator.userAgent)) return "wecom" as const;
  if (/(?:feishu|lark)/iu.test(navigator.userAgent)) return "feishu" as const;
  return null;
}

function safeAuthorizeUrl(value: string, provider: Provider) {
  const url = new URL(value);
  const origins = provider === "wecom"
    ? ["https://open.weixin.qq.com"]
    : ["https://accounts.feishu.cn", "https://passport.feishu.cn"];
  if (!origins.includes(url.origin) || url.username || url.password) throw new Error("授权地址无效，请联系管理员检查登录配置。");
  return url.href;
}

export default function OaQrMobilePage() {
  const [id, setId] = useState("");
  const [challenge, setChallenge] = useState<MobileChallenge | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [checked, setChecked] = useState(false);
  const [origin, setOrigin] = useState("");
  const [retryKey, setRetryKey] = useState(0);
  const requestRef = useRef<AbortController | null>(null);
  const busyRef = useRef(false);

  const authorize = useCallback(async (challengeId: string, provider: Provider) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError("");
    requestRef.current?.abort();
    const controller = new AbortController();
    requestRef.current = controller;
    try {
      const response = await fetch("/api/auth/qr/scan", {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/json" },
        credentials: "same-origin",
        cache: "no-store",
        body: JSON.stringify({ id: challengeId, provider }),
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]),
      });
      const payload = await response.json() as { authorizeUrl?: string; error?: string };
      if (!response.ok || !payload.authorizeUrl) throw new Error(payload.error || "暂时无法打开身份验证，请重试。");
      if (controller.signal.aborted) return;
      window.location.assign(safeAuthorizeUrl(payload.authorizeUrl, provider));
    } catch (cause) {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "身份验证请求失败，请重试。");
    } finally {
      if (!controller.signal.aborted) {
        busyRef.current = false;
        setBusy(false);
      }
    }
  }, []);

  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    const challengeId = new URLSearchParams(window.location.search).get("id") || "";
    setOrigin(window.location.origin);
    setId(challengeId);
    setLoading(true);
    setError("");
    setChecked(false);
    const load = async () => {
      if (!/^[A-Za-z0-9_-]{16,256}$/u.test(challengeId)) throw new Error("扫码链接无效，请在电脑上刷新二维码后重新扫描。");
      const response = await fetch(`/api/auth/qr/mobile?id=${encodeURIComponent(challengeId)}`, {
        headers: { accept: "application/json" },
        credentials: "same-origin",
        cache: "no-store",
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]),
      });
      const payload = await response.json() as MobileChallenge;
      if (!response.ok) throw new Error(payload.error || "扫码请求已失效，请重新扫描。");
      if (!["choose", "confirm", "approved", "denied", "expired"].includes(payload.phase)) throw new Error("扫码状态无效，请重新扫描。");
      if (!active) return;
      const providers = Array.isArray(payload.providers) ? payload.providers.filter((provider): provider is Provider => provider === "feishu" || provider === "wecom") : [];
      const nextChallenge = { ...payload, providers };
      setChallenge(nextChallenge);
      setLoading(false);
      if (payload.error) setError(payload.error);
      // Client detection only chooses a convenience route; server OAuth validates identity.
      // Remember the attempt across the OAuth round trip to avoid automatic redirect loops.
      const provider = detectedProvider();
      if (payload.phase !== "choose" || payload.error || !provider || !providers.includes(provider)) return;
      try {
        const key = `oa-qr-auto:${challengeId}`;
        if (sessionStorage.getItem(key)) return;
        sessionStorage.setItem(key, "attempted");
      } catch {
        // If storage is unavailable, let the user choose explicitly.
        return;
      }
      void authorize(challengeId, provider);
    };
    void load().catch((cause: unknown) => {
      if (!active || controller.signal.aborted) return;
      setChallenge(null);
      setError(cause instanceof Error ? cause.message : "扫码页面加载失败，请重试。");
      setLoading(false);
    });
    return () => { active = false; controller.abort(); };
  }, [authorize, retryKey]);

  useEffect(() => () => { requestRef.current?.abort(); }, []);

  const confirm = async (approve: boolean) => {
    if (busyRef.current || !challenge || challenge.phase !== "confirm" || (approve && !checked)) return;
    busyRef.current = true;
    setBusy(true);
    setError("");
    requestRef.current?.abort();
    const controller = new AbortController();
    requestRef.current = controller;
    try {
      const response = await fetch("/api/auth/qr/confirm", {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/json" },
        credentials: "same-origin",
        cache: "no-store",
        body: JSON.stringify({ id, approve }),
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]),
      });
      const payload = await response.json() as { error?: string };
      if (!response.ok) throw new Error(payload.error || "确认失败，请重试。");
      if (!controller.signal.aborted) setChallenge((current) => current ? { ...current, phase: approve ? "approved" : "denied" } : current);
    } catch (cause) {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "确认请求失败，请重试。");
    } finally {
      if (!controller.signal.aborted) {
        busyRef.current = false;
        setBusy(false);
      }
    }
  };

  const isLink = challenge?.action === "link";
  const created = challenge?.createdAt ? new Date(challenge.createdAt) : null;
  const createdLabel = created && !Number.isNaN(created.getTime()) ? created.toLocaleString("zh-CN", { hour12: false }) : "";
  const title = isLink ? "绑定企业微信" : "OA 扫码登录";

  return <main className="oa-qr-mobile">
    <section className="oa-qr-mobile-card" aria-labelledby="oa-qr-mobile-title">
      <div className="oa-qr-mobile-brand">OriginMind × ARTS Robotics</div>
      <h1 id="oa-qr-mobile-title">{title}</h1>
      <p className="oa-qr-mobile-domain">{origin || "OA 身份验证"}</p>
      {loading && <p className="oa-qr-mobile-message" role="status">正在读取扫码请求…</p>}
      {error && <p className="oa-qr-mobile-error" role="alert">{error}</p>}
      {!loading && !challenge && <button className="oa-qr-mobile-secondary" type="button" onClick={() => setRetryKey((value) => value + 1)}>重新加载</button>}
      {!loading && challenge?.phase === "choose" && <>
        <p className="oa-qr-mobile-message">请选择扫码所用的平台完成身份验证。</p>
        <div className="oa-qr-mobile-provider-buttons">
          {challenge.providers.map((provider) => <button className="oa-qr-mobile-primary" type="button" key={provider} disabled={busy} onClick={() => { void authorize(id, provider); }}>{busy ? "正在打开身份验证…" : `使用${providerName(provider)}验证身份`}</button>)}
        </div>
        {challenge.providers.length === 0 && <p className="oa-qr-mobile-message">此 OA 暂未开通可用的扫码平台，请联系管理员。</p>}
        <p className="oa-qr-mobile-help">如无法打开授权页面，请回到飞书或企业微信，使用应用内的“扫一扫”重新扫描电脑二维码。</p>
      </>}
      {!loading && challenge?.phase === "confirm" && <>
        <p className="oa-qr-mobile-message">{isLink ? "请核对以下企业微信身份和 OA 成员账号，确认两者都属于你本人。" : "请核对电脑上的验证码，仅确认你本人发起的登录。"}</p>
        <div className="oa-qr-mobile-code"><span>核对验证码</span><output aria-label={`验证码 ${challenge.verificationCode}`}>{challenge.verificationCode}</output></div>
        <dl className="oa-qr-mobile-details">
          {challenge.displayName && <div><dt>{isLink ? "企业微信身份" : "验证身份"}</dt><dd>{challenge.displayName}</dd></div>}
          {isLink && challenge.linkTargetName && <div><dt>绑定到 OA 成员</dt><dd>{challenge.linkTargetName}</dd></div>}
          {isLink && challenge.linkTargetAccountHint && <div><dt>OA 账号提示</dt><dd>{challenge.linkTargetAccountHint}</dd></div>}
          <div><dt>请求设备</dt><dd>{challenge.desktopLabel || "扫码前打开的 OA 浏览器"}</dd></div>
          {createdLabel && <div><dt>发起时间</dt><dd>{createdLabel}</dd></div>}
        </dl>
        <label className="oa-qr-mobile-check"><input type="checkbox" checked={checked} onChange={(event) => setChecked(event.target.checked)} disabled={busy} /><span>{isLink ? "两个账号都属于我本人，电脑端验证码相同。" : "电脑端验证码相同，这是我本人发起的请求。"}</span></label>
        <div className="oa-qr-mobile-actions">
          <button className="oa-qr-mobile-primary" type="button" disabled={busy || !checked || !challenge.verificationCode || (isLink && (!challenge.linkTargetName || !challenge.linkTargetAccountHint))} onClick={() => { void confirm(true); }}>{busy ? "正在处理…" : isLink ? "确认绑定" : "确认登录这台电脑"}</button>
          <button className="oa-qr-mobile-secondary" type="button" disabled={busy} onClick={() => { void confirm(false); }}>取消本次请求</button>
        </div>
      </>}
      {!loading && challenge?.phase === "approved" && <p className="oa-qr-mobile-message oa-qr-mobile-success" role="status">{isLink ? "已确认绑定，请回到电脑继续使用 OA。" : "已确认登录，请回到电脑继续使用 OA。"}</p>}
      {!loading && challenge?.phase === "denied" && <p className="oa-qr-mobile-message" role="status">本次请求已取消。</p>}
      {!loading && challenge?.phase === "expired" && <p className="oa-qr-mobile-message" role="status">二维码已过期，请在电脑上刷新后重新扫描。</p>}
    </section>
  </main>;
}
