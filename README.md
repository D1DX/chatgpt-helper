# ChatGPT Helper

[![Author](https://img.shields.io/badge/Author-Daniel_Rudaev-000000?style=flat)](https://github.com/daniel-rudaev)
[![Studio](https://img.shields.io/badge/Studio-D1DX-000000?style=flat)](https://d1dx.com)
[![Chrome](https://img.shields.io/badge/Chrome-Extension-4285F4?style=flat&logo=googlechrome&logoColor=white)](https://github.com/D1DX/chatgpt-helper)
[![License](https://img.shields.io/badge/License-MIT-green?style=flat)](./LICENSE)

Chrome extension for exporting ChatGPT conversations and memories. Export in 6 formats with filters, attachments, and adaptive rate limiting.

## What It Does

| Action | Description |
| ------ | ----------- |
| **Export Conversations** | Download conversations as JSON, Markdown, JSONL, HTML, CSV, or plain text |
| **Export Memories** | Download all ChatGPT memories as JSON, Markdown, or plain text |

## How It Works

1. Authenticates using your active ChatGPT browser session
2. Calls ChatGPT's internal API to list and fetch conversations or memories
3. Applies your filters client-side
4. No data leaves your browser. No external servers. No telemetry.

## Install

```
git clone https://github.com/D1DX/chatgpt-helper.git
```

1. Open Chrome → `chrome://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked** → select the cloned folder
4. The extension icon appears in your toolbar

## Use

1. Open [chatgpt.com](https://chatgpt.com) and log in
2. Click the extension icon
3. Choose a tab: **Export** (conversations) or **Memories**
4. Set filters/format and click the action button

### Long exports

For large accounts (1000+ conversations), the export can take hours due to API rate limits. To run overnight:

1. Run `caffeinate -d -i -s` in Terminal (prevents Mac sleep)
2. Leave Chrome open with the chatgpt.com tab visible (not minimized)
3. Start the export and close the popup — it runs in the background
4. Reopen the popup anytime to check progress or cancel

## Export Formats

| Format | Extension | Best for |
| ------ | --------- | -------- |
| JSON | `.json` | Full backup, programmatic use, attachments |
| Markdown | `.md` | Reading, AI context windows, RAG |
| JSONL | `.jsonl` | Fine-tuning, embeddings, batch processing |
| HTML | `.html` | Browsable archive, sharing |
| CSV | `.csv` | Spreadsheet analysis |
| Plain text | `.txt` | Grep-friendly, simplest |

Memories export supports JSON, Markdown, and plain text.

## Filters

| Filter | Scope | Notes |
| ------ | ----- | ----- |
| Project | Conversations | Select a ChatGPT project or inbox |
| Source | Conversations | Active, archived, or both |
| Date range | Conversations | Filter by conversation creation date |
| Keyword | Conversations | Matches conversation title |
| Limit | Conversations | Cap the number of conversations processed |
| Attachments | JSON export only | Include uploaded files and generated images |

## Permissions

| Permission | Why |
| ---------- | --- |
| `activeTab` | Access the current ChatGPT tab |
| `scripting` | Inject the extension logic into the page |
| `host_permissions: chatgpt.com` | Make API calls to ChatGPT's backend |

No other permissions. No background processes. No data collection.

## Privacy

All processing happens locally in your browser. Conversations are never sent to any external server. Authentication uses your existing ChatGPT session. No analytics, tracking, or telemetry.

## Disclaimer

This extension is not affiliated with, endorsed by, or associated with OpenAI. It uses ChatGPT's internal web API, which is undocumented and may change without notice. Use at your own risk. The authors are not responsible for any consequences of using this tool, including but not limited to account restrictions or data loss. Always comply with OpenAI's Terms of Service.

## License

MIT License — Copyright (c) 2026 Daniel Rudaev @ D1DX
