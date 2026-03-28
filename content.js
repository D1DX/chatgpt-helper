// ChatGPT Export — content script
// Runs on chatgpt.com, handles API calls and export logic.

const LIMIT = 28;
const DELAY_MS = 800;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function progress(text, percent) {
  chrome.runtime.sendMessage({ type: 'progress', text, percent });
}

function done(text) {
  chrome.runtime.sendMessage({ type: 'done', text });
}

function error(text) {
  chrome.runtime.sendMessage({ type: 'error', text });
}

async function getAuth() {
  const acct = document.cookie
    .split(';')
    .map((c) => c.trim())
    .find((c) => c.startsWith('_account='));
  const accountId = acct ? acct.split('=')[1] : null;

  const res = await fetch('/api/auth/session', { credentials: 'include' });
  const sess = await res.json();
  const token = sess.accessToken;

  if (!token) throw new Error('No access token — are you logged in?');
  return { token, accountId };
}

async function api(path, auth) {
  const res = await fetch(`/backend-api${path}`, {
    credentials: 'include',
    headers: {
      Authorization: `Bearer ${auth.token}`,
      ...(auth.accountId ? { 'chatgpt-account-id': auth.accountId } : {}),
    },
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} — ${path}`);
  return res.json();
}

async function listConversations(archived, auth) {
  let offset = 0;
  let total = null;
  const items = [];
  while (total === null || offset < total) {
    const data = await api(
      `/conversations?offset=${offset}&limit=${LIMIT}&order=updated&is_archived=${archived}&is_starred=false`,
      auth
    );
    total = data.total;
    items.push(...data.items);
    offset += LIMIT;
    if (offset < total) await sleep(DELAY_MS);
  }
  return items;
}

function filterConversations(items, options) {
  let filtered = items;

  if (options.keyword) {
    const kw = options.keyword.toLowerCase();
    filtered = filtered.filter(
      (c) => c.title && c.title.toLowerCase().includes(kw)
    );
  }

  if (options.dateFrom) {
    const from = new Date(options.dateFrom).getTime() / 1000;
    filtered = filtered.filter((c) => {
      const t =
        typeof c.create_time === 'string'
          ? new Date(c.create_time).getTime() / 1000
          : c.create_time;
      return t >= from;
    });
  }

  if (options.dateTo) {
    const to = new Date(options.dateTo + 'T23:59:59').getTime() / 1000;
    filtered = filtered.filter((c) => {
      const t =
        typeof c.create_time === 'string'
          ? new Date(c.create_time).getTime() / 1000
          : c.create_time;
      return t <= to;
    });
  }

  if (options.limit > 0) {
    filtered = filtered.slice(0, options.limit);
  }

  return filtered;
}

function extractFileRefs(conversation) {
  const files = [];
  const mapping = conversation.mapping || {};
  for (const node of Object.values(mapping)) {
    const msg = node.message;
    if (!msg) continue;

    // Check content parts for file references
    const parts = msg.content?.parts || [];
    for (const part of parts) {
      if (typeof part === 'object' && part !== null) {
        // Image asset pointer
        if (part.asset_pointer) {
          files.push({
            type: 'image',
            url: part.asset_pointer,
            content_type: part.content_type || 'image/png',
            name: part.metadata?.dalle?.prompt?.slice(0, 50) || 'image',
          });
        }
        // File attachment
        if (part.name && part.download_url) {
          files.push({
            type: 'file',
            url: part.download_url,
            content_type: part.content_type || 'application/octet-stream',
            name: part.name,
          });
        }
      }
    }

    // Check metadata for attachments
    const attachments = msg.metadata?.attachments || [];
    for (const att of attachments) {
      if (att.download_url || att.id) {
        files.push({
          type: 'attachment',
          url: att.download_url || null,
          id: att.id,
          content_type: att.mimeType || 'application/octet-stream',
          name: att.name || att.id,
        });
      }
    }
  }
  return files;
}

async function fetchAttachment(url, auth) {
  try {
    const res = await fetch(url.startsWith('http') ? url : `https://chatgpt.com${url}`, {
      credentials: 'include',
      headers: {
        Authorization: `Bearer ${auth.token}`,
      },
    });
    if (!res.ok) return null;
    const blob = await res.blob();
    return new Promise((resolve) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(reader.result);
      reader.readAsDataURL(blob);
    });
  } catch {
    return null;
  }
}

async function runExport(options) {
  try {
    progress('Authenticating…', 0);
    const auth = await getAuth();

    // List conversations
    let all = [];
    if (options.source === 'active' || options.source === 'both') {
      progress('Listing active conversations…', 5);
      const active = await listConversations(false, auth);
      all.push(...active.map((c) => ({ ...c, _source: 'active' })));
    }
    if (options.source === 'archived' || options.source === 'both') {
      progress('Listing archived conversations…', 10);
      await sleep(DELAY_MS);
      const archived = await listConversations(true, auth);
      all.push(...archived.map((c) => ({ ...c, _source: 'archived' })));
    }

    // Deduplicate
    const seen = new Set();
    all = all.filter((c) => {
      if (seen.has(c.id)) return false;
      seen.add(c.id);
      return true;
    });

    // Apply filters
    const filtered = filterConversations(all, options);
    progress(`Found ${filtered.length} conversations`, 15);

    if (filtered.length === 0) {
      done('No conversations match your filters.');
      return;
    }

    // Fetch full conversations
    const conversations = [];
    const errors = [];
    const attachmentMap = {};

    for (let i = 0; i < filtered.length; i++) {
      const c = filtered[i];
      const pct = 15 + Math.round((i / filtered.length) * 75);
      progress(`[${i + 1}/${filtered.length}] ${c.title || 'untitled'}`, pct);

      try {
        const data = await api(`/conversation/${c.id}`, auth);
        data._source = c._source;
        conversations.push(data);

        // Extract and fetch attachments
        if (options.attachments) {
          const files = extractFileRefs(data);
          if (files.length > 0) {
            const fetched = [];
            for (const f of files) {
              if (f.url) {
                const dataUrl = await fetchAttachment(f.url, auth);
                fetched.push({ ...f, data: dataUrl });
              } else {
                fetched.push(f);
              }
            }
            attachmentMap[c.id] = fetched;
          }
        }
      } catch (e) {
        errors.push({ id: c.id, title: c.title, error: e.message });
      }

      if (i < filtered.length - 1) await sleep(DELAY_MS);
    }

    // Build export
    progress('Building export file…', 92);
    const exportData = {
      exported_at: new Date().toISOString(),
      account: auth.accountId || 'unknown',
      filters: options,
      stats: {
        total_listed: all.length,
        after_filters: filtered.length,
        fetched: conversations.length,
        errors: errors.length,
        attachments: Object.keys(attachmentMap).length,
      },
      errors,
      conversations,
      ...(options.attachments && Object.keys(attachmentMap).length > 0
        ? { attachments: attachmentMap }
        : {}),
    };

    // Download
    progress('Downloading…', 98);
    const blob = new Blob([JSON.stringify(exportData, null, 2)], {
      type: 'application/json',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `chatgpt-export-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    done(
      `Exported ${conversations.length} conversations` +
        (errors.length ? `, ${errors.length} errors` : '') +
        (Object.keys(attachmentMap).length
          ? `, ${Object.keys(attachmentMap).length} with attachments`
          : '')
    );
  } catch (e) {
    error(e.message);
  }
}

// Listen for messages from popup
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === 'export') {
    runExport(msg.options);
  }
});
