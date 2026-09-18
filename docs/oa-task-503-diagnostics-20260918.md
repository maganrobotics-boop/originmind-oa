# OA task 503: preserve safe failure evidence

## Scope and production status

Based on main `a0d9fbfb4ca9455a07222d251ca20673ce8b2d0b` and the failed OA release run `35335492729` (#358). That run established only an HTTP 503 with `service_unavailable` at the private task probe. The deployed Chat version, historical D1 counter and underlying provider response have not been independently verified by this patch. This is a diagnostic repair, not proof that the original production outage is resolved.

No billing setting, daily allowance, secret, database, model/provider configuration, task flag, route or deployment workflow is changed. Do not merge or publish this PR automatically.

## Changes

- Retain only a numeric upstream HTTP status from failed Bailian requests; never read their error bodies. Keep the fixed endpoint, one attempt, manual redirects, request/response limits and deadline.
- Distinguish timeouts and network/response-stream failures from HTTP responses.
- Track the private task boundary: nonce claim, config read, provider selection, endpoint validation, key decryption, model configuration, application budget, model request and tool execution.
- Report `TASK_BUDGET_EXHAUSTED` only for the real `PublicError`/429 thrown by the application limiter. Storage failures remain `TASK_BUDGET_UNAVAILABLE`. Neither result asserts anything about GitHub billing or Bailian account balances.
- Preserve the existing 503/error response contract for older OA clients. Add a versioned, closed-vocabulary `diagnostic` only after valid service HMAC and payload validation. Emit the same sanitized object with the fixed log prefix `OA_TASK_FAILED`.
- Let the existing OA release probe preserve this object as `taskDiagnostic` in its failure log and private receipt, sanitizing it again before serialization. Older Chat responses without this field still fail safely.
- Preserve public/ordinary answer behavior, provider selection, replay protection, tool allowlist, artifact validation, activation gates and model-call count.

## Interpreting a subsequent authorized probe

`httpStatus` remains the status from the Chat bridge. `taskDiagnostic.upstreamStatus`, when present, is the actually observed provider HTTP status. Do not call a bridge 503 a Bailian 503 without that evidence.

`TASK_BUDGET_EXHAUSTED` is the application allowance; `TASK_MODEL_HTTP` plus 401/403 is an upstream rejection, plus 429 is upstream throttling or quota rejection, and a 5xx is an upstream server error. Numeric status alone does not establish a provider-specific subcause. `TASK_NO_ARTIFACT` means the model did not complete the required artifact tool path. `TASK_INTERNAL_ERROR` identifies only the captured boundary, not an invented root cause.

Raw exceptions, stacks, URLs, headers, credentials, source text, model output and provider response bodies are not diagnostic fields.

## Validation

Local Node v22.16.0: 49/49 new regression tests passed, zero failed/skipped. Tests use synthetic storage, credentials and upstream replies while executing the real HMAC/AES-GCM, task tool/Word construction, transport and release failure parser. Original local dependency/source bytes were checked against the repository Git blob hashes. Changed modules pass `node --check`.

Run: `node --test tests/ai-workbench-failure-diagnostics.test.mjs`.

The existing PR CI must still run its full checks. Local tests do not verify production services or authorize release.

## Release boundary

After review and explicit release authorization, the Chat Worker must receive the diagnostic producer; publishing only OA cannot change Chat's swallowed exceptions. The OA release script is the consumer of the new fields. Use existing protected manual workflows without skipping the task self-check, increasing budgets or replaying a paid task automatically. If the next probe fails, use the safe recorded boundary and status to select the smallest targeted fix. Do not claim success until the production task probe and final deployment have actually succeeded.
