# Knowledge image assets

## Release status — 2026-09-16

This document describes the target acceptance contract. The ZIP image feature
has **not** passed end-to-end acceptance and is not ready for production release.

At GitHub main `ae2af6a67317530d2a3c48a67c4899e950ea1241`, Chat CI passed but OA CI
failed 12 tests (four import API fixtures and eight migration/metadata checks).
The repair branch fixes those checks and the asset persistence/finalization
defects without rewriting migrations 0031 or 0032. An additive 0033 migration is
required to permit only guarded staged-to-ready transitions; advancing the old
0030 release gate to 0032 alone cannot make uploads work.

The following acceptance gaps remain separate release blockers:

- Chat's ZIP importer returns only `index.md` text and discards the parsed image
  files. Its OA submission path does not consume `assetUpload`, upload images,
  or finalize the manifest before marking the draft submitted.
- Import receipts issue a new upload token each time. Resuming a partial upload
  must preserve or recover its original session; helper retries with the same
  token do not establish resumability across a fresh import receipt.
- The standalone production configuration does not bind `KNOWLEDGE_ASSETS` to
  an R2 bucket. The intended production bucket must be identified and validated.
- This follow-up implements public image serving, retrieval asset references
  and Chat image display. OA review and approval-time completeness still need
  integration acceptance. Text-model input includes approved image captions
  and URLs; it does not perform pixel-level image interpretation.
- The actual production D1 ledger/schema and recovery bookmark have not been
  inspected by this repair. Release must retain exact target confirmation,
  reviewed migration hashes, before/after schema checks, and recovery evidence.

The legacy database relocation export/import contract remains pinned to 0030
and rejects newer ledgers. It must not be used as an image-aware backup; it does
not export R2 objects. This repair does not broaden that separate migration tool.

Before release, validate a two-image ZIP through the acceptance sequence below,
including an interrupted upload/retry, same-item receipt, incomplete-upload
approval rejection, revision isolation, and internal/public visibility checks.
Green unit tests alone are insufficient. Merge and deployment require explicit
user approval.

### Follow-up: draft visibility and illustrated answers

The Chat management list now contains only unsubmitted or unresolved drafts.
Confirmed OA submissions disappear immediately and on refresh while their
database records and receipts remain available for idempotency and recovery.

Answers no longer have a fixed word/paragraph limit or a 12,000-character display
cutoff. Bailian uses the configured model's default maximum output; Workers AI
uses a 16,384-token output budget. Both retain a bounded 120-second wait and
resource guards. Model-length exhaustion is explicitly indicated. Full replies
and approved image metadata survive refresh within the browser history budget.
Inquiry attachments are separately excerpted to fit the existing API envelope.

After release authorization and completion of the outstanding integration and
production-migration gates, deploy the updated Chat consumer before the OA
producer: Chat accepts old text-only responses, whereas the previous Chat
consumer rejects the new optional assets field. Do not deploy this follow-up
alone as proof that ZIP upload or production migration acceptance is complete.

## Goal

A ZIP knowledge package remains one OA knowledge item:

```text
index.md
assets/
  fig_001.webp
  fig_002.webp
```

`index.md` is the searchable body. Files under `assets/` are immutable revision assets stored in Cloudflare R2 and linked to the exact knowledge revision in D1.

## Storage

R2 binding: `KNOWLEDGE_ASSETS`

Object key format:

```text
knowledge/<item-id>/<revision-id>/<sha256>.<ext>
```

The object key is content-addressed within a revision. The original Markdown path is stored separately as `asset_path`, for example `assets/fig_001.webp`.

D1 table: `knowledge_revision_assets`

Required fields:

- `id`
- `item_id`
- `revision_id`
- `asset_path`
- `storage_key`
- `mime_type`
- `byte_size`
- `sha256`
- `created_at`

Only JPEG, PNG, and WebP are accepted. Asset paths must remain under `assets/`. A revision asset is immutable once created.

## Upload contract

Chat ZIP parsing must return two independent outputs:

1. Full UTF-8 `index.md` text as `document.body`.
2. Image assets as binary parts with path, MIME type, byte size, and SHA-256.

The OA import endpoint must create/resolve the knowledge item and revision first, then persist each asset to R2 and insert the corresponding D1 asset row. If asset persistence fails, the submission must not be reported as fully received.

Recommended limits:

- ZIP compressed size: 50 MB.
- Total uncompressed package size: 100 MB.
- `index.md`: 5 MB UTF-8.
- Individual image: 10 MB.
- Maximum images per ZIP: 200.

## Review lifecycle

Assets belong to a revision, not to the knowledge item globally. Approval activates the revision and therefore the associated image set. Resubmission creates a new revision and a new immutable asset set; old revision assets remain addressable for audit but are not returned by active retrieval.

## Retrieval

Search chunks remain text-first. Each returned public chunk may include referenced assets discovered from Markdown image links in that chunk:

```json
{
  "id": "chunk-id",
  "excerpt": "...",
  "assets": [
    {
      "url": "https://oa.omindos.ai/api/public/lab-ai/assets/<asset-uuid>",
      "alt": "实验配图",
      "mimeType": "image/webp"
    }
  ]
}
```

Only ready assets from the active, approved, public revision may be returned to public Chat. The response allows at most two images per chunk and six distinct images in total, with alternative text limited to 200 characters. The optional `assets` field is omitted for text-only chunks; the full JSON response is bounded to 32 KiB. Internal item IDs, revision IDs and R2 keys are never part of the public response.

## Asset serving

`GET /api/public/lab-ai/assets/<asset-uuid>` streams an approved public image directly to the Chat browser. Every request rechecks the item's active status, public visibility, exact active revision, revision status and ready upload state. Pending, internal, rejected, revoked and superseded assets return 404 without reading R2. Raw R2 keys are not exposed. Responses use the stored image MIME type, `nosniff`, `Cross-Origin-Resource-Policy: cross-origin` and a private/no-store cache policy so permission changes are checked again on the next request. No OA session or service token is needed for these approved public images.

## Chat behavior

When a retrieved chunk references an asset:

- The Chat UI may display the image.
- The model request should receive the original image when multimodal input is available.
- The answer must not claim the original image is unavailable if the asset was returned successfully.
- If no asset is available, the model must say that the original image was not retrieved and must not infer visual details from prose alone.

## Acceptance test

1. Upload a ZIP containing `index.md` and at least two images.
2. Chat admin preview shows the full Markdown body and recognizes the asset count.
3. Submit once; OA creates one pending knowledge item.
4. OA review page shows the body and linked images for the same revision.
5. Approve the item.
6. A Chat query matching a paragraph beside `fig_001.webp` returns the chunk plus that asset.
7. Chat displays/reads the original image and answers about visible details.
8. A returned-and-resubmitted revision does not accidentally reuse stale assets from the prior revision.
