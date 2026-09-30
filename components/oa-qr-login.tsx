"use client";

import { useEffect, useRef, useState } from "react";
import "./oa-qr-login.css";

type Provider = "feishu" | "wecom";
type QrStatus = "loading" | "pending" | "verified" | "approved" | "consumed" | "denied" | "expired" | "error";
type QrChallenge = {
  id: string;
  scanUrl: string;
  qrSvg: string;
  expiresIn: number;
  verificationCode: string;
  providers: Provider[];
};
type StatusResponse = {
  status: Exclude<QrStatus, "loading" | "error">;
  verificationCode?: string;
  redirectTo?: string;
  linked?: boolean;
  error?: string;
};

export type OaQrLoginProps = {
  feishuEnabled: boolean;
  wecomEnabled: boolean;
  action?: "login" | "link";
  onLinked?: () => void;
};

const providerName = (provider: Provider) => provider === "feishu" ? "飞书" : "企业微信";
const isFinished = (status: QrStatus) => ["consumed", "denied", "expired", "error"].includes(status);

export function OaQrLogin({ feishuEnabled, wecomEnabled, action = "login", onLinked }: OaQrLoginProps) {
  const [challenge, setChallenge] = useState<QrChallenge | null>(null);
  const [status, setStatus] = useState<QrStatus>("loading");
  const [error, setError] = useState("");
  const [remaining, setRemaining] = useState(0);
  const [retryKey, setRetryKey] = useState(0);
  const onLinkedRef = useRef(onLinked);
  const enabled = action === "link" ? wecomEnabled : feishuEnabled || wecomEnabled;

  useEffect(() => { onLinkedRef.current = onLinked; }, [onLinked]);

  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    let active = true;
    let currentId = "";
    let completed = false;
    let pollTimer: ReturnType<typeof setTimeout> | undefined;
    let countdownTimer: ReturnType<typeof setInterval> | undefined;
    let expiresAt = 0;
    let failedPolls = 0;

    const stopTimers = () => {
      if (pollTimer !== undefined) clearTimeout(pollTimer);
      if (countdownTimer !== undefined) clearInterval(countdownTimer);
    };
    const fail = (message: string) => {
      stopTimers();
      if (!active) return;
      setError(message);
      setStatus("error");
    };
    const post = async <T,>(endpoint: string, body: unknown): Promise<T> => {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/json" },
        credentials: "same-origin",
        cache: "no-store",
        body: JSON.stringify(body),
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(12_000)]),
      });
      const payload = await response.json() as T & { error?: string };
      if (!response.ok) throw new Error(payload.error || "登录请求失败，请稍后重试。");
      return payload;
    };
    const poll = async () => {
      if (!active || completed || controller.signal.aborted) return;
      try {
        const payload = await post<StatusResponse>("/api/auth/qr/status", { id: currentId });
        if (!active) return;
        if (!["pending", "verified", "approved", "consumed", "denied", "expired"].includes(payload.status)) {
          throw new Error("登录状态无效，请重新生成二维码。");
        }
        failedPolls = 0;
        setStatus(payload.status);
        if (payload.linked === true && action === "link") {
          completed = true;
          stopTimers();
          setStatus("consumed");
          onLinkedRef.current?.();
          return;
        }
        if (action === "login" && (payload.status === "consumed" || payload.redirectTo === "/")) {
          completed = true;
          stopTimers();
          setStatus("consumed");
          // Reload the document so OA reads the newly issued HttpOnly session.
          // eslint-disable-next-line @next/next/no-location-assign-relative-destination
          window.location.assign("/");
          return;
        }
        if (isFinished(payload.status)) {
          completed = true;
          stopTimers();
          return;
        }
      } catch (cause) {
        if (!active || controller.signal.aborted) return;
        failedPolls += 1;
        if (failedPolls >= 3) {
          fail(cause instanceof Error ? cause.message : "暂时无法查询登录状态，请重新生成二维码。");
          return;
        }
      }
      if (active && !completed) pollTimer = setTimeout(() => { void poll(); }, 2_000);
    };

    const initialize = async () => {
      setChallenge(null);
      setError("");
      setStatus("loading");
      setRemaining(0);
      if (window.location.protocol !== "https:" && !["localhost", "127.0.0.1"].includes(window.location.hostname)) {
        throw new Error("请从已配置的 HTTPS OA 地址进入后扫码登录。");
      }
      const payload = await post<QrChallenge>("/api/auth/qr/start", { action });
      if (!active) return;
      const providers = Array.isArray(payload.providers)
        ? payload.providers.filter((provider): provider is Provider => provider === "wecom" || (provider === "feishu" && action === "login"))
        : [];
      const scanUrl = new URL(payload.scanUrl, window.location.origin);
      if (!payload.id || !payload.verificationCode || !payload.qrSvg?.trim().startsWith("<svg") ||
          scanUrl.origin !== window.location.origin || scanUrl.pathname !== "/auth/qr" ||
          !Number.isFinite(payload.expiresIn) || payload.expiresIn <= 0 || providers.length === 0) {
        throw new Error("二维码生成结果无效，请联系管理员检查登录配置。");
      }
      currentId = payload.id;
      expiresAt = Date.now() + Math.min(payload.expiresIn, 600) * 1_000;
      setChallenge({ ...payload, providers });
      setRemaining(Math.ceil((expiresAt - Date.now()) / 1_000));
      setStatus("pending");
      countdownTimer = setInterval(() => {
        if (!active || completed) return;
        const seconds = Math.max(0, Math.ceil((expiresAt - Date.now()) / 1_000));
        setRemaining(seconds);
        if (seconds === 0) {
          completed = true;
          stopTimers();
          controller.abort();
          setStatus("expired");
        }
      }, 1_000);
      pollTimer = setTimeout(() => { void poll(); }, 2_000);
    };
    void initialize().catch((cause: unknown) => {
      if (!active || controller.signal.aborted) return;
      fail(cause instanceof Error ? cause.message : "二维码加载失败，请重试。");
    });

    return () => {
      active = false;
      controller.abort();
      stopTimers();
      if (currentId && !completed) {
        void fetch("/api/auth/qr/cancel", {
          method: "POST",
          headers: { "content-type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify({ id: currentId }),
          keepalive: true,
        }).catch(() => {});
      }
    };
  }, [action, enabled, feishuEnabled, retryKey, wecomEnabled]);

  if (!enabled) {
    return <div className="oa-qr-login oa-qr-unavailable" role="status">{action === "link" ? "企业微信登录尚未配置，暂时无法绑定。请联系管理员完成配置。" : "此 OA 尚未配置扫码登录。请联系管理员完成飞书或企业微信配置。"}</div>;
  }

  const providers: Provider[] = challenge?.providers ?? (action === "link" ? ["wecom"] : [feishuEnabled ? "feishu" : null, wecomEnabled ? "wecom" : null].filter((provider): provider is Provider => provider !== null));
  const providerText = providers.map(providerName).join("或");
  const finished = isFinished(status);
  const statusText = status === "loading" ? "正在生成二维码…"
    : status === "verified" ? "身份已验证，请在手机上核对验证码并确认。"
    : status === "approved" ? action === "link" ? "手机已确认，正在完成绑定…" : "手机已确认，正在登录…"
    : status === "consumed" ? action === "link" ? "企业微信已绑定到当前 OA 账号。" : "登录成功，正在进入 OA…"
    : status === "denied" ? "本次请求已取消。"
    : status === "expired" ? "二维码已过期，请刷新后扫码。"
    : status === "error" ? error || "二维码暂时无法显示。"
    : action === "link" ? "使用企业微信扫码，将身份绑定到当前 OA 账号。" : `打开手机${providerText}，扫码并确认登录。`;

  return <section className="oa-qr-login" aria-label={action === "link" ? "绑定企业微信" : "OA 统一扫码登录"}>
    <div className="oa-qr-frame">
      {challenge && !finished && <img className="oa-qr-image" src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(challenge.qrSvg)}`} alt={`OA ${action === "link" ? "绑定" : "登录"}二维码，使用${providerText}扫码`} />}
      {(status === "loading" || finished) && <div className={`oa-qr-state ${status === "error" ? "oa-qr-state-error" : ""}`} role={status === "error" ? "alert" : "status"}>
        <span>{statusText}</span>
        {finished && status !== "consumed" && <button className="oa-qr-button" type="button" onClick={() => setRetryKey((value) => value + 1)}>重新生成二维码</button>}
      </div>}
    </div>
    <strong className="oa-qr-title">{action === "link" ? "绑定企业微信" : `使用${providerText}扫码登录`}</strong>
    {!finished && status !== "loading" && <>
      <p className="oa-qr-status" role="status" aria-live="polite">{statusText}</p>
      <div className="oa-qr-verification"><span>核对验证码</span><output aria-label={`验证码 ${challenge?.verificationCode || ""}`}>{challenge?.verificationCode}</output></div>
      <span className="oa-qr-expiry">{remaining} 秒内有效 · 仅限本次使用</span>
      <button className="oa-qr-text-button" type="button" onClick={() => setRetryKey((value) => value + 1)}>刷新二维码</button>
    </>}
    {action === "login" && !wecomEnabled && <small className="oa-qr-help">企业微信暂未配置，当前可使用飞书扫码。</small>}
    {action === "login" && feishuEnabled && <a className="oa-qr-device-login" href="/api/auth/feishu/start" target="_top">在本机打开飞书登录</a>}
    {action === "link" && <small className="oa-qr-help">绑定后，两种扫码方式进入同一账号，继续使用原有资料和权限。</small>}
  </section>;
}
