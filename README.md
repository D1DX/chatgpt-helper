# ChatGPT Helper

A Chrome extension for managing your ChatGPT conversations. Export in 6 formats, bulk archive, and bulk unarchive — all with filters.

Built by [D1DX](https://d1dx.com) — operations automation studio.

---

### What It Does

**Export** — Download conversations as JSON, Markdown, JSONL, HTML, CSV, or plain text. Optionally includes file attachments (JSON format).

**Archive** — Bulk archive active conversations matching your filters. Clean up your inbox in one click.

**Unarchive** — Bulk unarchive conversations by date, keyword, or project. Undo accidental archives or retrieve old conversations.

### How It Works

1. The extension runs on `chatgpt.com` and authenticates using your active browser session
2. It calls ChatGPT's internal API to list, fetch, archive, or unarchive conversations
3. All filters (project, date range, keyword, limit) apply to every action
4. No data leaves your browser. No external servers. No telemetry.

---

### Install

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
3. Choose a tab: **Export**, **Archive**, or **Unarchive**
4. Set your filters:
   - **Project** — all conversations, inbox only, or a specific project
   - **Source** — active, archived, or both (auto-set for archive/unarchive)
   - **Date range** — only conversations created within this window
   - **Keyword** — filter by conversation title
   - **Limit** — all matching, or a specific count
5. Click the action button
6. Archive and unarchive ask for confirmation before proceeding

---

### Export Formats

| Format | Extension | Best for |
| ------ | --------- | -------- |
| JSON | `.json` | Full backup, programmatic use, attachments |
| Markdown | `.md` | Reading, AI context windows, RAG |
| JSONL | `.jsonl` | Fine-tuning, embeddings, batch processing |
| HTML | `.html` | Browsable archive, sharing |
| CSV | `.csv` | Spreadsheet analysis, searching |
| Plain text | `.txt` | Simplest, grep-friendly |

---

### Permissions

| Permission | Why |
| ---------- | --- |
| `activeTab` | Access the current ChatGPT tab |
| `scripting` | Inject the extension logic into the page |
| `host_permissions: chatgpt.com` | Make API calls to ChatGPT's backend |

No other permissions. No background processes. No data collection.

### Privacy

- All processing happens locally in your browser
- Your conversations are never sent to any external server
- Authentication uses your existing ChatGPT session
- The extension has no analytics, tracking, or telemetry

### Disclaimer

This extension is not affiliated with, endorsed by, or associated with OpenAI. It uses ChatGPT's internal web API, which is undocumented and may change without notice. Use at your own risk. The authors are not responsible for any consequences of using this tool, including but not limited to account restrictions or data loss. Always comply with OpenAI's Terms of Service.

### License

MIT — see [LICENSE](LICENSE).

### Credits

Built by [D1DX](https://d1dx.com). Open source under the [d1dx](https://github.com/d1dx) GitHub organization.
