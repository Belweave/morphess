# HTTP API

Run `morphess serve`. Send JSON with `Content-Type: application/json` and, when configured, `Authorization: Bearer <server token>`. IDs are numeric Pi IDs; `root` aliases the root conversation.

## Native sessions

| Method | Path | Behavior |
| --- | --- | --- |
| GET | `/health` | Minimal unauthenticated liveness |
| GET | `/v1/models` | OpenAI-shaped model list with context/modality metadata |
| GET | `/v1/sessions?limit=100&cursor=...` | Paginated conversation records |
| POST | `/v1/sessions` | Create conversation; `{instructions?}` |
| POST | `/v1/sessions/:id/inputs` | `{content,requestId?,whenBusy?}`; 202 `{id,conversationId}` |
| GET | `/v1/submissions/:id` | Durable submission status |
| GET | `/v1/submissions/:id?wait=true` | Settlement, final text, answer entry |
| GET | `/v1/sessions/:id/entries?limit=100&cursor=...` | Ascending history and opaque `next` cursor |
| GET | `/v1/sessions/:id/events` | SSE committed events, control snapshot first |
| GET | `/v1/sessions/:id/context` | Approximate context budget |
| GET | `/v1/sessions/:id/questions` | `{items}` containing live durable user questions |
| POST | `/v1/sessions/:id/questions/:questionId/answer` | `{answer}`; return the answered question |
| POST | `/v1/sessions/:id/abort` | Abort ownership subtree, including background |
| POST | `/v1/sessions/:id/compact` | `{instructions?}`; 202 `{taskId}` |
| POST | `/v1/sessions/:id/fork` | `{at:entryId}`; 201 `{id}` |
| GET | `/v1/tasks` | Pi task/submission inspection |
| GET | `/v1/usage` | Full reported session usage |

History limits are 1–500; pass `next` unchanged as cursor. Input content is a string or an array of `{type:"text",text}` / `{type:"image",mimeType,data}` with base64 data. `whenBusy`: `steer`, `followUp`, `reject`. Retrying a per-conversation `requestId` returns the original submission; keep its payload consistent.

```sh
curl http://127.0.0.1:8787/v1/sessions/root/inputs \
  -H 'Content-Type: application/json' \
  -d '{"content":"Inspect the project","requestId":"task-1"}'
curl 'http://127.0.0.1:8787/v1/submissions/123?wait=true'
curl -N http://127.0.0.1:8787/v1/sessions/root/events
```

Disconnect cancels the wait, not accepted work. Event subscribers reconnect to a new committed control snapshot and page history separately. Tool details identify child conversations. Native event types follow Pi's experimental vocabulary.

An `ask_user` tool waits for a real answer, potentially across host restarts. Read pending questions and submit a freeform answer through the native routes above. Suggestions are optional; sending the same answer again is idempotent. A different second answer, an expired question, or a cancelled owning task returns 409. Missing records return 404; invalid input returns 400. These endpoints authorize no extra tool permissions. Child questions belong to their child conversation ID. A Chat Completions request can remain open while a separate native API client answers its question; the OpenAI wire format has no added question event.

## OpenAI-compatible chat gateway

`POST /v1/chat/completions` runs the coding agent and returns an OpenAI-shaped completion or SSE chunks. The host owns and executes its tools internally.

```json
{
  "model": "your-model-id",
  "messages": [{ "role": "user", "content": "Explain the project" }],
  "stream": true,
  "stream_options": { "include_usage": true }
}
```

`model` must match the configured ID. Roles: system, developer, user, assistant; last message must be user. System/developer messages must precede dialogue; their content and historical assistant content must be text. Users can send standard text/image_url blocks. Images require inline PNG/JPEG/GIF/WebP data URLs; remote URLs are never fetched.

Ordinary requests create a durable conversation and import history. Responses include `X-Morphess-Conversation`, with `conversation_id` also in nonstreaming JSON. To continue without resending history, send the optional `conversation_id` and exactly one new user message.

For effectful requests, use `Idempotency-Key` (1–256 characters). A durable session-level reservation binds it to the conversation and request fingerprint before importing history/dispatching. Retries reuse the submission across restarts; different content with the same key returns 409. Stream retries can replay the final committed answer without reproducing every earlier narration.

SSE includes assistant role/content deltas, terminal finish reason, optional usage, `[DONE]`. Provider truncation preserves `length`. Streaming can include narration around internal tools; nonstreaming content is the final answer. Gateway usage describes the final response; `/v1/usage` contains full internal accounting.

This is an explicit subset. Caller tools/tool results, arbitrary sampling/response-format options, logprobs, audio/video, a downstream Responses endpoint, and other unknown fields are rejected. Configure host tools/model controls instead; this is not a transparent proxy for every OpenAI option.
