# OriginMind Chat Email Code Webhook

Small dependency-free Node.js webhook for sending chat login verification codes through Tencent Enterprise Mail SMTP.

## Environment

```bash
PORT=8789
EMAIL_CODE_WEBHOOK_TOKEN=<long-random-token>
SMTP_HOST=smtp.exmail.qq.com
SMTP_PORT=465
SMTP_USER=magan@sztu.edu.cn
SMTP_PASS=<Tencent enterprise mailbox client password>
SMTP_FROM=magan@sztu.edu.cn
```

Keep `SMTP_PASS` and `EMAIL_CODE_WEBHOOK_TOKEN` only on the server. Do not commit them.

## Run

```bash
node server.mjs
```

The service listens on `127.0.0.1` only. Put Nginx or another HTTPS reverse proxy in front of it and expose only:

```text
POST /send
Authorization: Bearer <EMAIL_CODE_WEBHOOK_TOKEN>
Content-Type: application/json
```

Expected JSON body:

```json
{
  "from": "magan@sztu.edu.cn",
  "to": "student@stu.sztu.edu.cn",
  "subject": "OriginMind Chat 登录验证码",
  "text": "你的 OriginMind Chat 登录验证码是 123456，10 分钟内有效。"
}
```

Configure the Cloudflare Worker with:

```bash
EMAIL_CODE_FROM=magan@sztu.edu.cn
EMAIL_CODE_WEBHOOK_URL=https://<your-mail-webhook-domain>/send
EMAIL_CODE_WEBHOOK_TOKEN=<same-long-random-token>
```
