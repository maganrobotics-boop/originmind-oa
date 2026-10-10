export const QR_DESKTOP_COOKIE = "__Host-oa_qr_desktop";
export const QR_PHONE_COOKIE = "__Host-oa_qr_phone";
export const QR_LOGIN_MAX_AGE_SECONDS = 300;
export type QrProvider = "feishu" | "wecom";

export function validQrNonce(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{32,128}$/u.test(value);
}

export function qrLoginOrigin() {
  const url = new URL(process.env.OA_PUBLIC_ORIGIN || "");
  if (url.protocol !== "https:" || url.pathname !== "/" || url.username || url.password || url.search || url.hash) {
    throw new Error("OA QR login origin is not configured");
  }
  return url.origin;
}

export function sameOriginQrPost(request: Request, origin: string) {
  const site = request.headers.get("sec-fetch-site");
  return request.method === "POST" && new URL(request.url).origin === origin
    && request.headers.get("origin") === origin && (!site || site === "same-origin");
}

export function qrDesktopLabel(userAgent: string) {
  if (/Windows/iu.test(userAgent)) return "Windows 电脑";
  if (/Android|iPhone|iPad/iu.test(userAgent)) return "手机或平板浏览器";
  if (/Macintosh|Mac OS/iu.test(userAgent)) return "Mac 电脑";
  if (/Linux/iu.test(userAgent)) return "Linux 电脑";
  return "网页浏览器";
}
