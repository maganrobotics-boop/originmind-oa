import { safeWebmailUrl } from "../../../lib/integration-contract.mjs";
import { getAuthorizedUser } from "../_lib/auth";

const headers = { "cache-control": "private, no-store, max-age=0", "x-content-type-options": "nosniff" };

export async function GET() {
  const authorized = await getAuthorizedUser();
  if (!authorized?.ndaCompleted) return Response.json({ error: "请先完成 OA 准入和保密协议。" }, { status: 403, headers });
  const webmailUrl = safeWebmailUrl(process.env.OA_WEBMAIL_URL);
  return Response.json({ webmail: { configured: Boolean(webmailUrl), url: webmailUrl } }, { headers });
}
