# OriginMind × ARTS Robotics 联合研发 OA

This repository contains the standalone OA application source. Deployment
receipts, live service identifiers, database identifiers, and production state
are intentionally kept outside source control.

A clean full-stack starter running on
[vinext](https://github.com/cloudflare/vinext), with optional Cloudflare D1 and
Drizzle support.

## Prerequisites

- Node.js `>=22.13.0`
- Linux with `flock`, `curl`, and GNU `timeout`

## Sites Lifecycle

The Sites lifecycle CLI runs the locked dependency install before returning this checkout. Edit the source under `app/`, then checkpoint when a coherent milestone is ready to inspect or share. The remote Sites builder runs `npm run build` against the pushed commit. Do not repeat install or build as a normal pre-checkpoint step.

This starter does not use `wrangler.jsonc`.

`install:ci` is intentionally a single, non-retrying `npm ci`. It refuses a concurrent install for the same project, consumes a matching image-seeded npm cache with `--prefer-offline` while retaining registry fallback for a missing cache object, otherwise downloads and verifies the complete vinext tarball recorded in `package-lock.json`, limits npm to one socket, and terminates a stalled install. `build` applies a short timeout. These helpers target Linux and use GNU `timeout`; they are not native macOS scripts.

Scripts that need writable project-scoped home, npm, XDG, and temporary paths use `scripts/sites-env.sh`. The `dev` and `start` scripts honor the caller's runtime environment and keep Wrangler logs inside the checkout. The generated `.sites-runtime/` directory is disposable and ignored by Git.

## Included Shape

- edit site code under `app/`
- `app/chatgpt-auth.ts` provides optional dispatch-owned ChatGPT sign-in helpers
- `.openai/hosting.json` declares optional Sites D1 and R2 bindings
- `vite.config.ts` simulates declared bindings for local development
- `db/index.ts` reads the D1 binding from the Cloudflare Worker environment
- `db/schema.ts` starts intentionally empty
- `examples/d1/` contains an optional D1 example surface
- `drizzle.config.ts` supports local migration generation when needed

## Workspace Auth Headers

OpenAI workspace sites can read the current user's email from
`oai-authenticated-user-email`.

SIWC-authenticated workspace sites may also receive
`oai-authenticated-user-full-name` when the user's SIWC profile has a non-empty
`name` claim. The full-name value is percent-encoded UTF-8 and is accompanied by
`oai-authenticated-user-full-name-encoding: percent-encoded-utf-8`.

Treat the full name as optional and fall back to email when it is absent:

```tsx
import { headers } from "next/headers";

export default async function Home() {
  const requestHeaders = await headers();
  const email = requestHeaders.get("oai-authenticated-user-email");
  const encodedFullName = requestHeaders.get("oai-authenticated-user-full-name");
  const fullName =
    encodedFullName &&
    requestHeaders.get("oai-authenticated-user-full-name-encoding") ===
      "percent-encoded-utf-8"
      ? decodeURIComponent(encodedFullName)
      : null;

  const displayName = fullName ?? email;
  // ...
}
```

### Supported account identity

Sites documents `oai-authenticated-user-email` as the server-side identity header after Sign in with ChatGPT. The OA normalizes that authenticated email and derives a canonical `email:<lowercase-email>` account subject for member binding, signatures, rate limits, and audit evidence. It deliberately ignores undocumented identity headers.

Protected business APIs still fail closed when the Sites-authenticated email is absent, malformed, or does not match the reviewed member record. A legacy OA cookie alone cannot authorize a business write. If a person's authenticated email changes, the new subject cannot inherit the previous member's name, permissions, NDA admission, or approval ownership without administrator review.

## Feishu and GitHub OAuth login

In the Sites deployment, Feishu and GitHub are optional providers alongside Sign in with ChatGPT. In the standalone deployment, Feishu QR is the primary login and GitHub is available under the secondary account choices. Both implementations use Authorization Code flow, one-time `state`, PKCE `S256`, an exact HTTPS callback, a stable provider subject, and an OA-owned opaque server session. Feishu is restricted to one app and tenant and requests no email; GitHub requests only `user:email`. Provider access tokens are never persisted.

Existing members can sign in through their original ChatGPT or GitHub identity and explicitly bind Feishu from **个人设置**. When an unbound Feishu user first enters, the OA performs an exact normalized-name lookup: no match creates an active enterprise member automatically; one or more matches are shown to the user for explicit confirmation, and declining the candidates creates an independent member. A name match is never silently merged and does not inherit prior permissions without the user's confirmation.

Removing an identity from `OA_ADMIN_*` revokes administrator capability but intentionally retains its ordinary active-member access. To revoke all OA access, remove the administrator configuration and then mark the canonical member as departed in member management; that operation also revokes the member's OAuth sessions.

A member who still has the original ChatGPT identity can unlink GitHub from **个人设置**. Unlinking revokes that member's GitHub OA sessions but preserves the member record, roles, NDA, approvals, and audit trail; the same GitHub numeric ID may only be relinked to its original member.

Runtime configuration:

- `OA_PUBLIC_ORIGIN=<exact HTTPS deployment origin>`
- `GITHUB_OAUTH_CLIENT_ID=<OAuth App client ID>`
- `GITHUB_OAUTH_CLIENT_SECRET=<Cloudflare Secret>`
- `GITHUB_LOGIN_ENABLED=false|true`
- `FEISHU_LOGIN_APP_ID=<飞书应用 App ID>`
- `FEISHU_LOGIN_APP_SECRET=<Cloudflare Secret>`
- `FEISHU_LOGIN_TENANT_KEY=<允许登录的企业 tenant key>`
- `FEISHU_LOGIN_ENABLED=false|true`
- `FEISHU_PDF_ARCHIVE_ENABLED=false|true`
- `OA_WEBMAIL_URL=<optional exact HTTPS Roundcube/Webmail URL>`

Register exact GitHub and Feishu callbacks for each origin; wildcard callback matching is not supported. Keep both flags `false` until the complete `0000`–`0034` chain and compatible application version are deployed. Disabling either flag rejects that provider's existing OAuth sessions. Feishu login validates the configured app, tenant key, OAuth state, browser nonce, PKCE transaction and explicit member binding; it does not request email and never merges members by name or email. `OA_WEBMAIL_URL` is an ordinary runtime variable (not a password). Production can set it to the reviewed tenant Webmail endpoint only through the explicit `enable_feishu_webmail` manual-release input; leaving that input unchecked preserves the current provider-managed value.

Public address plan:

- Website: `https://omindos.ai`
- OA: `https://oa.omindos.ai`
- Documentation: `https://docs.omindos.ai`
- API: `https://api.omindos.ai`

The OA deployment owns only `oa.omindos.ai`. The website, documentation, and API hostnames remain independent deployment targets and must not be pointed at the OA Worker as placeholders.

See [GitHub 登录与 Cloudflare 发布流程](docs/github-cloudflare-deployment.md) for the full setup, staged rollout, verification, and rollback checklist.

## Standalone Cloudflare Workers staging

Generate only the isolated staging target. It has no production route or custom domain, disables ChatGPT login, uses Feishu QR as the primary login, and keeps GitHub as a secondary external login provider.

Required non-secret release environment:

- `OA_STAGING_CLOUDFLARE_ACCOUNT_ID`
- `OA_STAGING_WORKER_NAME=<dedicated-name-ending-in-staging>`
- `OA_STAGING_D1_DATABASE_NAME=<dedicated-name-ending-in-staging>`
- `OA_STAGING_D1_DATABASE_ID`
- `OA_STAGING_PUBLIC_ORIGIN=https://<OA_STAGING_WORKER_NAME>.<account-subdomain>.workers.dev`
- `GITHUB_OAUTH_CLIENT_ID`
- `FEISHU_LOGIN_APP_ID`, `FEISHU_LOGIN_TENANT_KEY`
- `OA_ADMIN_EMAILS`, `OA_ADMIN_NAMES`
- any optional project-owner or finance-owner email/name pairs

Store `GITHUB_OAUTH_CLIENT_SECRET` and `FEISHU_LOGIN_APP_SECRET` as Cloudflare Worker secrets, never as ordinary vars or tracked files. The guarded release command is the only supported staging deployment entrypoint:

```bash
OA_STAGING_RELEASE_CONFIRM="$OA_STAGING_WORKER_NAME" \
OA_STAGING_SECRETS_FILE=/private/path/staging-oauth-secrets.json \
npm run release:standalone:staging
```

The secrets file must be a regular private JSON file outside the Git worktree containing exactly `FEISHU_LOGIN_APP_SECRET` and `GITHUB_OAUTH_CLIENT_SECRET` (`0600` on POSIX). Wrangler uploads it with the same first deployment. The command runs all checks before the final standalone build, validates the exact account/D1/origin and secret names, performs a Wrangler dry run, applies D1 migrations, and deploys the same immutable snapshot with an explicit config path. Do not run a bare `wrangler deploy`: ordinary `npm test` intentionally rebuilds the Sites artifact in `dist`.

If a dedicated locked bootstrap Worker already exists, add exactly those two secrets through Cloudflare **Workers & Pages → the staging Worker → Settings → Variables and Secrets**. Then omit `OA_STAGING_SECRETS_FILE` from the guarded release command. Before touching D1, the release verifies that the Worker exposes only the required secret names; Cloudflare never returns their values.

For a data-only migration, first apply the complete schema to an empty target D1, then import persistent business tables with explicit columns. Do not migrate member/OAuth sessions, pending OAuth transactions, rate-limit buckets, or the source migration gate. Before any production-domain cutover, verify the source and target row counts and hashes, approval revision chains, NDA evidence, references, and that the administrator performing the export has an active GitHub or current-app Feishu identity.

The source export is intentionally disabled by default. A controlled migration uses a new one-time RSA/HMAC credential set and UUID freeze generation outside the worktree, a database-enforced write gate, a minimum 15-minute drain period, and a maximum one-hour authenticated export window. The local staging importer decrypts only in memory, binds only to `127.0.0.1`, uses an explicit remote staging D1 binding, and writes a private recovery receipt containing the pre-import Time Travel bookmark before it attempts any D1 mutation. Pass the receipt explicitly:

```bash
OA_STAGING_IMPORT_CONFIRM="$OA_STAGING_WORKER_NAME" \
OA_STAGING_CLOUDFLARE_ACCOUNT_ID=<authorized-account-id> \
OA_STAGING_D1_DATABASE_ID=<authorized-staging-d1-id> \
npm run migration:import:staging -- \
  --input /private/path/migration.enc.json \
  --private-key /private/path/private-key.jwk \
  --auth-key-file /private/path/auth-key.txt \
  --freeze-id-file /private/path/freeze-id.txt \
  --receipt /private/path/staging-recovery.json \
  --expected-origin "$OA_MIGRATION_SOURCE_ORIGIN"
```

Every input and the new receipt must be outside the Git worktree; secret-bearing inputs must be regular `0600` files. A non-empty target is never merged. Replaying the exact package performs only a full read comparison and recovery cleanup, while a different package is rejected. If the source migration is abandoned, wait until the package expiry plus five-minute clock tolerance before enabling the guarded unfreeze action; destroy the package and entire credential set afterward, then use a new freeze UUID and new keys for any later attempt.

## Optional Dispatch-Owned ChatGPT Sign-In

Import the ready-to-use helpers from `app/chatgpt-auth.ts` when the site needs
optional or required ChatGPT sign-in:

- Use `getChatGPTUser()` for optional signed-in UI.
- Use `requireChatGPTUser(returnTo)` for server-rendered pages that should send
  anonymous visitors through Sign in with ChatGPT.
- In a Server Component, start sign-in with
  `<a href={chatGPTSignInPath(returnTo)} target="_top">`. The auth helper
  module is server-only; do not import it into a Client Component.
- Do not use `fetch`, XHR, a client-side router, or a framework link that can
  prefetch the sign-in route. SIWC must start as a top-level navigation.
- Never request the AuthAPI authorization endpoint directly. The dispatch-owned
  `/signin-with-chatgpt` route must start the SIWC flow.
- Use `chatGPTSignOutPath(returnTo)` for browser sign-out links or actions.
- Pass a same-origin relative `returnTo` path for the destination after sign-in
  or sign-out. The helper validates and safely encodes it.
- Mark protected pages with `export const dynamic = "force-dynamic"` because
  they depend on per-request identity headers.

Dispatch owns `/signin-with-chatgpt`, `/signout-with-chatgpt`, `/callback`, the
OAuth cookies, and identity header injection. Do not implement app routes for
those reserved paths. Routes that do not import and call the helper remain
anonymous-compatible.

SIWC establishes identity only; it does not prove workspace membership. Use the
Sites hosting platform's access policy controls for workspace-wide restrictions,
or enforce explicit server-side membership or allowlist checks.

Use SIWC for account pages, user-specific dashboards, saved records, and write
actions tied to the current ChatGPT user. Leave public content anonymous.

## Diagnostic Commands

- `npm run install:ci`: perform the one bounded lockfile install
- `npm run dev`: start the Vite/Vinext development server
- `npm run build`: build the deployable Sites artifact
- `npm run start`: start the built Vinext application
- `npm test`: run a production build and the complete business, revision-chain, archive, metadata, and UI-component test suite
- `npm run db:generate`: generate Drizzle migrations after schema changes

Use build commands for targeted diagnosis after a remote failure, not as part of the normal checkpoint path.

## OA Runtime Configuration

Role assignments are read only on the server. Configure comma-separated values in the hosting environment; do not place production credentials in the repository:

- `OA_ADMIN_EMAILS`, `OA_ADMIN_NAMES`
- `OA_PROJECT_OWNER_EMAILS`, `OA_PROJECT_OWNER_NAMES`
- `OA_FINANCE_OWNER_EMAILS`, `OA_FINANCE_OWNER_NAMES`

Each privileged-role tuple is strict: email and reviewed real name must be present one-to-one, with no duplicate email. A partially configured tuple fails closed. The canonical account subject is derived on the server from the configured email. Cross-role reuse is allowed only when the email and real name are identical. Administrator configuration is mandatory and has no source-code fallback; unset project-owner and finance-owner groups are empty, while administrators inherently retain those capabilities. Configured project and finance roles still require an active, administrator-approved member record whose account subject matches the configured email. Technical-adviser and project-owner permissions for ordinary members are granted in the member-management screen by the administrator.

### Laboratory AI and reviewed knowledge

The **实验室 AI** workspace is an internal, text-only V1. Active OA members who have completed the applicable NDA may submit a title, category, summary, source label/link, and up to 20,000 characters of knowledge text. An administrator or `project_owner` must review it, and the submitter cannot review or revoke their own entry. Returned material is resubmitted as a new immutable revision. Only the current `active` revision is split into searchable chunks; returned, rejected, superseded, or revoked material is excluded from question answering. Every answer returns the exact knowledge citations used, and the version and audit history remain preserved.

An external model endpoint is optional and is called only from the server. Configure it in the Sites runtime with:

- `OA_LAB_AI_ENABLED=true` (the model call stays disabled unless this is explicitly `true`)
- `OA_LAB_AI_ENDPOINT=<HTTPS chat endpoint>`
- `OA_LAB_AI_API_KEY=<server-side secret>`
- `OA_LAB_AI_MODEL=<model name>` (defaults to `qwen3:1.7b`)
- `OA_LAB_AI_FORMAT=openai|simple` (defaults to OpenAI-compatible chat JSON)
- `OA_LAB_AI_TIMEOUT_MS=1000..20000` (defaults to 5000 ms)

The browser never receives the key. The request marks retrieved knowledge as untrusted reference data, sets `store: false`, and, for OpenAI-compatible requests, explicitly sets `enable_thinking: false` and `stream: false`; it also limits context and response size and rejects redirects. When the endpoint is absent, disabled, slow, malformed, or unavailable, the OA falls back to an extractive answer with the same reviewed citations rather than generating unsupported claims. PDF, Word, image/OCR, R2, and vector indexing are outside V1.

The guarded standalone staging release still accepts exactly the two documented OAuth secrets. Do not add `OA_LAB_AI_API_KEY` to that release path until its standalone secret contract and validation gates are extended deliberately.

The complete database migration chain under `drizzle/` must be applied in order before a release that uses the matching application code. Migrations `0007`–`0024` add:

- current-version NDA admission, bounded/revocable sessions, labor-period and labor-source uniqueness, direct-message indexes, active-member-only identity-number claims, and structured external-archive leases;
- canonical timestamps, workflow guards, idempotent client creation keys, NDA business keys, immutable approval revision chains, and archive source-revision pointers;
- authenticated member account subjects with partial uniqueness, staged legacy rebind events, NDA cache clearing for unbound legacy accounts, and separate proposed rebind identity fields so a rejected rebind cannot overwrite or lock the historical identity;
- actor-and-time indexes plus an independent atomic minute-bucket ledger used by bounded approval, draft-deletion, creation, and direct-message write-rate controls. Deleting a draft or message cannot erase this quota evidence.
- controlled department assignments plus provider-pinned one-time PKCE transactions, GitHub and Feishu identities, hashed and revocable OA sessions, and provider-subject uniqueness. OAuth tokens are not stored.
- a permanent, generation-scoped migration-control table and database triggers that reject inserts, updates, and deletes on all fourteen persistent business tables while a controlled snapshot is active.
- a retirement fence for the former Feishu directory and Markdown Drive archive connector. Migration `0024` ends that integration state and refuses to run while any old remote upload is pending; `0025` restores Feishu OAuth login. The new `feishu_drive_pdf` destination is independent, idempotent, revision-bound, and never rewrites the retired archive records.
- migration `0026` adds immutable knowledge items/revisions, canonical searchable chunks, append-only lifecycle evidence, and freeze triggers for all four knowledge tables. The encrypted export/import path validates content hashes, canonical chunk reconstruction, revision pointers, self-review exclusion with an explicit system-administrator self-action audit marker, and matching submit/review/revoke events before any target write.
- migration `0027` adds the active-chunk lookup index and database-level immutability, lifecycle-transition, and append-only guards for knowledge items, revisions, chunks, and events.
- migration `0028` adds an explicit `internal`/`public` visibility decision at approval time. Legacy approved knowledge remains internal, and only active public knowledge is available to the service-authenticated public Chat retriever.
- migration `0029` permits project owners and OA administrators to reclassify an active knowledge entry without changing its revision or chunks. Each change advances the optimistic concurrency revision and appends an immutable `visibility_changed_internal` or `visibility_changed_public` event; publishing still requires the exact second confirmation.
- migration `0030` adds immutable revision-part storage for large knowledge documents while retaining one logical item, one revision, and one OA review decision.

Legacy email-keyed NDAs remain historical evidence only. Current admission is keyed by the signer’s authenticated account subject and the current agreement version; an account rebind clears cached NDA admission and requires a new subject-bound signature. Migration `0019` binds existing members to the documented Sites email subject so the production rollout does not force unnecessary re-registration. A legacy active/departed member rebind is pending until an administrator verifies identity continuity. The proposed name/identity number do not replace the historical record before approval, and rejection clears the proposed subject so the original account can retry.

Technical and procurement flows enforce distinct real-name accounts for the applicant, technical adviser, and project owner. Procurement additionally requires a fourth distinct account for the final purchaser. Signer summaries are stored by immutable account/member identity, so different people with the same name are not collapsed; exact actions, emails, member IDs, and timestamps remain in the approval evidence chain.

Recommended rollout order: database backup → private authenticated-email canary → bind known historical accounts or confirm exact-name candidates → drain former Feishu Drive uploads and verify their pending count is zero → apply `0000`–`0030` to an empty staging D1 → freeze and download one encrypted business-data package → local staging import and integrity verification → Feishu-login, GitHub fallback, PDF and Drive archive canaries → explicit production authorization → repeat against a fresh production D1 and cut the domain. Migration `0024` aborts if an old upload is pending or a full-database freeze is active. Never clear or rewrite pending evidence merely to pass the gate.

### Internal archive output

Every approval detail can be generated as a server-side PDF. Archived PDFs include the full authorized approval content, real-name accounts, exact timestamps, handwritten signature evidence, revision hashes and archive hashes. When `FEISHU_PDF_ARCHIVE_ENABLED=true`, each final archive is uploaded once to `OriginMind OA 归档 / YYYY年 / MM月 / 审批类型`; filenames begin with the Shanghai archive timestamp so each folder remains chronological. The app-owned root folder is granted to the configured, Feishu-bound OA administrator with `full_access`. The Feishu application needs tenant scopes `drive:drive`, `drive:file:upload`, `docs:permission.member:create`, and `docs:permission.member:readonly`. Failed uploads remain in `external_archives` and retry safely when an authorized list or detail view is loaded; an uploaded manifest is never uploaded twice.

The timeout defaults can be overridden for a controlled canary with `SITES_INSTALL_TIMEOUT`, `SITES_INSTALL_KILL_AFTER`, `SITES_BUILD_TIMEOUT`, and `SITES_BUILD_KILL_AFTER`. A timeout fails the command; the helpers never retry an unchanged install or build.

## Learn More

- [vinext Documentation](https://github.com/cloudflare/vinext)
- [Drizzle D1 Guide](https://orm.drizzle.team/docs/get-started/d1-new)
