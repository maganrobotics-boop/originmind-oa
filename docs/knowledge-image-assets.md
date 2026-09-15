# Knowledge image assets

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

Search chunks remain text-first. Each returned chunk may include referenced assets discovered from Markdown image links in or near that chunk:

```json
{
  "id": "chunk-id",
  "excerpt": "...",
  "assets": [
    {
      "path": "assets/fig_001.webp",
      "url": "/api/knowledge/assets/<opaque-token>",
      "mimeType": "image/webp"
    }
  ]
}
```

Only assets from the active revision may be returned to public Chat. Internal OA retrieval may return assets according to existing knowledge visibility rules.

## Asset serving

Do not expose raw R2 keys. Serve images through an OA endpoint that validates item status, active revision, visibility, and caller context, then streams the R2 object with the stored MIME type and private/no-store cache policy unless a dedicated public asset policy is added later.

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
