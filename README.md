# ChatGPT Export

A Chrome extension that exports your ChatGPT conversations to JSON. Filter by date, keyword, or source. Optionally includes file attachments.

Built by [D1DX](https://d1dx.com) — operations automation studio.

---

### What It Does

- Exports **all conversations** from your ChatGPT account (active, archived, or both)
- Downloads a single structured JSON file with full message history
- Filters by **date range**, **keyword** (title match), and **item limit**
- Optionally fetches **attachments and images** embedded in conversations

### How It Works

1. The extension runs on `chatgpt.com` and authenticates using your active browser session
2. It calls ChatGPT's internal API to list and fetch conversations
3. Applies your filters, then downloads the result as JSON
4. No data leaves your browser. No external servers. No telemetry.

---

### Install

> Chrome Web Store listing is not available yet. Install manually in developer mode.

1. Download or clone this repo:
   ```
   git clone https://github.com/d1dx/chatgpt-export.git
   ```
2. Open Chrome and go to `chrome://extensions`
3. Enable **Developer mode** (toggle in the top-right corner)
4. Click **Load unpacked** and select the `chatgpt-export` folder
5. The extension icon appears in your toolbar

### Use

1. Go to [chatgpt.com](https://chatgpt.com) and make sure you're logged in
2. Click the extension icon in the toolbar
3. Choose your filters:
   - **Source** — active conversations, archived, or both
   - **Date range** — only conversations created within this window
   - **Keyword** — filter by conversation title
   - **Limit** — max number of conversations to export (0 = all)
   - **Attachments** — include uploaded files and generated images
4. Click **Export**
5. A JSON file downloads automatically

---

### Export Format

```json
{
  "exported_at": "2026-03-28T12:00:00.000Z",
  "account": "your-account-id",
  "filters": { "source": "both", "keyword": null, "limit": 0 },
  "stats": {
    "total_listed": 142,
    "after_filters": 142,
    "fetched": 142,
    "errors": 0,
    "attachments": 8
  },
  "conversations": [ ... ],
  "attachments": { "conversation-id": [ { "name": "file.pdf", "data": "base64..." } ] }
}
```

Each conversation object contains the full message tree as returned by ChatGPT's API — including all user messages, assistant responses, system prompts, and metadata.

---

### Permissions

| Permission | Why |
|------------|-----|
| `activeTab` | Access the current ChatGPT tab to run the export |
| `scripting` | Inject the export logic into the page |
| `host_permissions: chatgpt.com` | Make API calls to ChatGPT's backend |

No other permissions. No background processes. No data collection.

### Privacy

- All processing happens locally in your browser
- Your conversations are never sent to any external server
- Authentication uses your existing ChatGPT session — no passwords or API keys required
- The extension has no analytics, tracking, or telemetry

---

### Stack

| | |
|---|---|
| **Platform** | Chrome Extension (Manifest V3) |
| **Languages** | JavaScript, HTML, CSS |
| **API** | ChatGPT internal backend API |
| **Auth** | Session-based (browser cookies + JWT from `/api/auth/session`) |

---

### License

MIT — see [LICENSE](LICENSE).

### Credits

Built by [D1DX](https://d1dx.com). Open source under the [d1dx](https://github.com/d1dx) GitHub organization.
