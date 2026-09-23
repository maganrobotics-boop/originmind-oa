import http from "node:http";
import tls from "node:tls";
import { Buffer } from "node:buffer";

const PORT = Number.parseInt(process.env.PORT || "8789", 10);
const WEBHOOK_TOKEN = required("EMAIL_CODE_WEBHOOK_TOKEN");
const SMTP_HOST = process.env.SMTP_HOST || "smtp.exmail.qq.com";
const SMTP_PORT = Number.parseInt(process.env.SMTP_PORT || "465", 10);
const SMTP_USER = required("SMTP_USER");
const SMTP_PASS = required("SMTP_PASS");
const SMTP_FROM = process.env.SMTP_FROM || SMTP_USER;
const MAX_BODY_BYTES = 4096;

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function json(response, status, body) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(JSON.stringify(body));
}

function cleanAddress(value, fallback = "") {
  const address = typeof value === "string" ? value.trim() : fallback;
  if (!/^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/u.test(address) || address.length > 254) {
    throw new Error("INVALID_EMAIL");
  }
  return address;
}

function cleanText(value, maximum, fallback = "") {
  const text = typeof value === "string" ? value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, "").trim() : fallback;
  if (!text || text.length > maximum) throw new Error("INVALID_TEXT");
  return text;
}

function smtpLine(socket) {
  let buffer = "";
  return () => new Promise((resolve, reject) => {
    const onData = (chunk) => {
      buffer += chunk.toString("utf8");
      const lines = buffer.split(/\r\n/u);
      buffer = lines.pop() || "";
      if (!lines.length) return;
      const last = lines.at(-1);
      if (/^\d{3} /u.test(last)) {
        socket.off("data", onData);
        socket.off("error", onError);
        resolve(lines.join("\n"));
      }
    };
    const onError = (error) => {
      socket.off("data", onData);
      reject(error);
    };
    socket.on("data", onData);
    socket.once("error", onError);
  });
}

function expect(reply, codes) {
  const code = Number.parseInt(String(reply).slice(0, 3), 10);
  if (!codes.includes(code)) throw new Error(`SMTP_${code || "BAD_REPLY"}`);
}

async function smtpSend({ from, to, subject, text }) {
  const socket = tls.connect({ host: SMTP_HOST, port: SMTP_PORT, servername: SMTP_HOST });
  socket.setTimeout(12_000);
  const read = smtpLine(socket);
  const send = async (command, codes = [250]) => {
    socket.write(`${command}\r\n`);
    expect(await read(), codes);
  };
  try {
    expect(await read(), [220]);
    await send(`EHLO ${SMTP_HOST}`);
    await send("AUTH LOGIN", [334]);
    await send(Buffer.from(SMTP_USER).toString("base64"), [334]);
    await send(Buffer.from(SMTP_PASS).toString("base64"), [235]);
    await send(`MAIL FROM:<${from}>`);
    await send(`RCPT TO:<${to}>`, [250, 251]);
    await send("DATA", [354]);
    const message = [
      `From: OriginMind Chat <${from}>`,
      `To: <${to}>`,
      `Subject: =?UTF-8?B?${Buffer.from(subject, "utf8").toString("base64")}?=`,
      "MIME-Version: 1.0",
      "Content-Type: text/plain; charset=UTF-8",
      "Content-Transfer-Encoding: 8bit",
      "",
      text.replace(/^\./gmu, ".."),
      ".",
    ].join("\r\n");
    socket.write(`${message}\r\n`);
    expect(await read(), [250]);
    await send("QUIT", [221]);
  } finally {
    socket.end();
  }
}

async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error("BODY_TOO_LARGE");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

const server = http.createServer(async (request, response) => {
  try {
    if (request.method !== "POST" || request.url !== "/send") return json(response, 404, { error: "not_found" });
    if (request.headers.authorization !== `Bearer ${WEBHOOK_TOKEN}`) return json(response, 401, { error: "unauthorized" });
    if (!String(request.headers["content-type"] || "").toLowerCase().startsWith("application/json")) {
      return json(response, 415, { error: "unsupported_media_type" });
    }
    const payload = await readJson(request);
    const from = cleanAddress(payload.from, SMTP_FROM);
    if (from.toLowerCase() !== SMTP_FROM.toLowerCase()) return json(response, 400, { error: "invalid_sender" });
    const to = cleanAddress(payload.to);
    const subject = cleanText(payload.subject, 120);
    const text = cleanText(payload.text, 1000);
    await smtpSend({ from, to, subject, text });
    return json(response, 200, { ok: true });
  } catch (error) {
    console.error("MAIL_WEBHOOK_FAILED", error instanceof Error ? error.message : "unknown");
    return json(response, 400, { error: "send_failed" });
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`email webhook listening on 127.0.0.1:${PORT}`);
});
