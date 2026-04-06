# ChatGPT Helper — Developer Notes

Chrome extension for exporting ChatGPT conversations and memories using ChatGPT's unofficial internal API.

## Architecture

```
chatgpt-export/
├── manifest.json      ← Chrome extension config (Manifest v3)
├── popup.html         ← Extension popup UI (2 tabs: Export, Memories)
├── popup.js           ← Popup logic, tab switching, status reconnect
├── content.js         ← Core logic — API calls, export, rate limiting (injected into chatgpt.com)
├── converters.js      ← Format converters (6 conversation formats + 2 memory formats)
├── icons/             ← Extension icons (16, 48, 128)
├── README.md          ← Public documentation
└── LICENSE            ← MIT
```

### How it works

1. `popup.js` injects `converters.js` + `content.js` into the active chatgpt.com tab
2. Popup sends action messages (`export`, `exportMemories`, `get-status`, `abort`) to content script
3. Content script authenticates via `/api/auth/session`, calls ChatGPT's `/backend-api/` endpoints
4. Progress updates flow back to popup via `chrome.runtime.sendMessage`
5. Content script tracks `running` state — popup can close/reopen and reconnect

### Popup ↔ Content Script Messages

| Action | Direction | Purpose |
|--------|-----------|---------|
| `list-projects` | popup → content | Load ChatGPT projects for filter dropdown |
| `export` | popup → content | Start conversation export |
| `exportMemories` | popup → content | Start memories export |
| `get-status` | popup → content | Check if a job is running (for reconnect) |
| `abort` | popup → content | Cancel running job |
| `progress` | content → popup | Progress update (text + percent) |
| `done` | content → popup | Job completed |
| `error` | content → popup | Job failed |

---

## ChatGPT Internal API Reference

All endpoints are under `https://chatgpt.com/backend-api/`. Authentication: `Authorization: Bearer {token}` + `chatgpt-account-id: {accountId}` headers. Token obtained from `GET /api/auth/session`.

### Conversations

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/conversations?offset=X&limit=100&order=updated&is_archived=false` | GET | List conversations (paginated) |
| `/conversation/{id}` | GET | Full conversation with all messages and mapping |
| `/gizmos/{gizmoId}/conversations?offset=X&limit=100` | GET | List conversations in a project |
| `/gizmos/snorlax/sidebar?owned_only=true&conversations_per_gizmo=0&limit=50` | GET | List projects (from sidebar) |

**Conversation object:** `{ id, title, create_time, gizmo_id, is_archived, mapping, current_node }`

**Message tree:** `mapping` is a tree of nodes. Walk from `current_node` backwards via `.parent` to get the linear message chain. Each node has `.message.author.role`, `.message.content.parts`, `.message.create_time`.

### Memories

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/memories?exclusive_to_gizmo=false&include_memory_entries=true` | GET | All user memories |

**Extra headers needed:** `oai-device-id` (from `oai-did` cookie), `oai-language: en-US`.

**Response shape:** Not fully confirmed yet — code handles multiple possible shapes (`data.memories`, `data.memory_entries`, `data.memory_tool_config.memory_entries`). Check browser console log for actual structure on first run.

### File Downloads (Attachments)

Two-step process:

1. `GET /files/download/{file_id}?post_id=&inline=false` → returns `{ status, download_url }`
2. `GET {download_url}` → returns the actual binary file

**`file_id` extraction:** Conversation messages contain `asset_pointer` values like `file-service://file_00000000cd4071fdb63fcc0db52ada88`. Strip `file-service://` to get the file ID.

**`download_url` format:** `/backend-api/estuary/content?id={file_id}&ts=...&sig=...` — signed URL, likely time-limited.

---

## Rate Limiting

ChatGPT's API is not officially documented. Rate limits are inferred from behavior.

### Observed limits

- **Per-minute window** — most common. `Retry-After` header typically 1-30 seconds.
- **Per-hour / sliding window** — suspected for sustained high volume (1000+ requests).
- **Cloudflare layer** — separate WAF rules on top of OpenAI's own limits.

### Adaptive backoff strategy

The extension uses adaptive rate limiting:

1. **Base delay:** 800ms between requests
2. **On 429:** Double `delayMs` (cap at 60s), retry the same request
3. **Escalating cooldowns:** After 5+ consecutive 429s on the same request, add extra wait:
   - 5-9 attempts: +60s cooldown
   - 10-14 attempts: +2 min cooldown
   - 15+ attempts: +5 min cooldown
4. **Recovery:** After each successful request, reduce delay by 25% (back toward 800ms)
5. **Never gives up:** 429 retries are unlimited. Only non-429 errors (404, 500) skip a conversation.

### Page size

`limit=100` per page for listing conversations. The ChatGPT web UI uses 28. 100 works and reduces the number of listing requests by ~3.5x.

### Practical timing for large exports

| Conversations | Estimated time |
|---------------|---------------|
| 100 | ~3-5 min |
| 500 | ~15-25 min |
| 1000 | ~30-60 min |
| 3000+ | ~2-6 hours (rate limits add variance) |

---

## Key Implementation Details

### Popup close/reopen (state reconnect)

The popup is destroyed when closed. Content script tracks:
- `running` (boolean) — is a job in progress
- `lastStatus` — last progress/done/error message

When popup opens, it sends `get-status`. If running, it restores the progress UI and disables buttons. New progress messages flow normally after reconnect.

### Abort / cancel

Content script checks `abortRequested` flag at every loop iteration and before every API call via `checkAbort()`. Throws `'Cancelled by user'` which propagates up to `runExport` / `runExportMemories` catch block.

### Double-injection guard

`window.__chatgptExportLoaded` prevents re-registering the message listener when the popup re-injects scripts.

### Attachment handling

- `file-service://` URLs → two-step download via `/files/download/{id}` → get `download_url` → fetch binary
- Direct HTTP URLs (CDN, DALL-E) → fetched directly with auth header
- Stored as base64 data URLs in the JSON export (future: ZIP export for better usability)

---

## Do NOT

- **Don't hardcode tokens or cookies** — the extension reads them from the browser session
- **Don't use `limit` > 100 for conversation listing** — untested, may get rejected
- **Don't remove the `DELAY_INITIAL` (800ms)** — going faster risks account-level throttling
- **Don't remove the double-injection guard** — causes duplicate message listeners
- **Don't send `chrome.runtime.sendMessage` synchronously in loops** — the popup may not be open, always wrap in try/catch
