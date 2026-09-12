# ARTS Robotics AI assistant — Cloudflare release

This project serves the public `chat.omindos.ai` assistant from one Cloudflare
Worker. Static Assets serve the verified production frontend, D1 stores
inquiries and operational state, Workers AI is the default model provider, and
the OA public endpoint contributes only knowledge explicitly approved for
public visibility.

The dependency-free browser source is maintained under `frontend/`. A small
deterministic builder writes content-hashed JavaScript and CSS plus the resolved
HTML shell under `public/`; those generated release assets are checked in.

## Isolation and visibility

- This Worker and its D1 database are separate from the internal OA Worker and
  OA D1 database.
- The public Chat application never receives OA sessions or internal-only
  knowledge.
- Chat-local document writes remain drafts and never reach the public model.
  Only knowledge returned by the OA approved-public endpoint may reach a model.
- The public path works before an administrator password is provisioned.
  Management login is deliberately fail-closed until a controlled password
  record is inserted into D1.

## Runtime bindings

| Kind | Name | Purpose |
| --- | --- | --- |
| D1 | `DB` | Inquiries, sessions, drafts, settings, exact budgets |
| Workers AI | `AI` | Default `@cf/qwen/qwen3-30b-a3b-fp8` provider |
| Static Assets | `ASSETS` | Public and management frontend |
| Secret | `APP_ENCRYPTION_KEY` | Optional Bailian credential encryption |
| Secret | `RATE_LIMIT_HMAC_KEY` | Pseudonymous abuse-control identifiers |
| Secret | `PUBLIC_LAB_AI_SERVICE_TOKEN` | OA public retrieval authentication |

`APP_ORIGIN` is strict: preview and production deployments must generate their
own configuration with the exact public origin. Production disables both
`workers.dev` and preview URLs and is attached using the route
`chat.omindos.ai/*` only after a successful preview smoke test.

## Verification

```sh
npm ci
npm run build:frontend
npm run check
npm run check:wrangler
```

Use `npm run check:frontend` when verifying that committed public assets still
match their source without changing any files. Content-hashed files under
`/assets/` are cached immutably; `/` and `/manage` always serve the same
non-cacheable HTML shell.

The production workflow additionally applies the D1 migration, writes secrets
without logging them, validates the exact release ID and a real Workers AI
response backed exclusively by OA-public sources, verifies the generated
frontend source hashes and static responses, and
only then enables Cloudflare proxying for the existing DNS record. A failed
live smoke test restores the previous proxy state so the Tencent origin remains
the fallback.

See `MIGRATION.md` for the audited Tencent-to-Workers mapping.
