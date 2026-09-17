# Chat image and answer repair — 2026-09-17

This is a release candidate, not evidence of a successful production deployment.
The changes require OA and Chat to be released together after their checks pass.
No production data, approval state, secrets, DNS or Cloudflare resources are
changed by the repair workflow. The actual uploaded thesis must still be checked
on the deployed site; local fixtures do not establish that its original ZIP
manifest, active revision or R2 objects are complete.

## Implemented contract

Public retrieval keeps text-first ranking and its existing bounded public IDs.
A symbol-keyed internal context survives ranking but is excluded from JSON. The
retrieval service checks the matched chunk and immediately adjacent chunks in the
same section for Markdown image references, then selects only ready assets of
an active, approved public revision (two per chunk, four per response).

Each optional `assets` entry is exactly `{ token, mimeType, alt }`. Tokens use
AES-GCM with a domain-separated key derived from the existing service credential,
random IVs and seven-day expiry. They hide item/revision identifiers and storage
keys; rotation of the service credential invalidates outstanding tokens.
The D1 table in the implementation is `knowledge_assets`, and its storage key
format is `knowledge/<item-id>/<revision-id>/<asset-path-without-assets-prefix>`;
the earlier design document's alternate names are not the implementation.

OA serves `/api/public/lab-ai/assets/<token>` only to the authenticated service.
Every read rechecks the active revision, public visibility, ready upload and
migration freeze before reading R2. Chat exposes a same-origin
`/api/knowledge/assets/<token>` proxy with no-store caching, bounded bodies,
MIME/signature validation and no redirects. User cookies/auth headers, upstream
cookies, raw keys and private OA paths never pass through the proxy.

The browser renders only structured, allowlisted same-origin image descriptors.
Arbitrary Markdown image URLs remain inert. Images are preserved in bounded
conversation history, revalidated on reload, and show an explicit unavailable
message after expiry, withdrawal or a failed read. Already delivered public
images cannot be clawed back from screenshots or user downloads.

The text model receives the approved text and image captions, not the capability
tokens. **Pixel-level multimodal image interpretation is not enabled by this
repair.** The prompt explicitly forbids claiming to have seen unprovided pixels,
colors or values. Image display and visual understanding are separate acceptance
criteria.

## Answer completion

Default output budget is 2,400 tokens for both configured providers, with a
60-second shared model deadline. An explicit provider `finish_reason=length`
permits one bounded continuation with the original instructions and partial
answer, charged against the existing daily model budget. Completed answers and
short health probes are not continued. Failed/exhausted continuations retain the
partial grounded answer with an explicit incomplete notice. Final combined text
still passes the same factual/unsafe-output validation. The 12,000-character
safety ceiling remains; this is not an unlimited-output promise.

## Deployment acceptance (still required)

Use an existing approved public item with an `index.md` reference and ready PNG,
JPEG or WebP asset. Query the text beside the figure, verify its returned token
and rendered original image, refresh and reopen the conversation. Withdraw or
make the item internal and verify the old image URL stops working. Check an old
revision and an unapproved item never appear. Then test a real long answer from
the selected model. Do not re-upload private thesis material or change its
visibility merely to make this test pass.
