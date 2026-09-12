# Frontend release provenance

The original React/Vite source project was not present in the recovered Tencent
release. The checked-in JavaScript and CSS are therefore reviewed production
artifacts, protected by exact SHA-256 assertions in
`test/public-assets.test.mjs`.

For this release, the reviewed JavaScript artifact was changed only to:

- use the `ARTS Robotics AI assistant` name and model-context tool name;
- make Chat-local document submissions draft-only (`published: 0`);
- remove the direct-publication checkbox and all wording that claims Chat can
  publish outside OA review; and
- direct users to OA for public-knowledge approval.

The backend independently enforces these controls. A future UI redesign should
replace the artifact with a reconstructed source project and a reproducible
frontend build.
