// ChatGPT Export — content script
// Runs on chatgpt.com, handles API calls and export logic.

// Guard against double-injection
if (!window.__chatgptExportLoaded) {
  window.__chatgptExportLoaded = true;

  const LIMIT = 28;
  const DELAY_MS = 800;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function progress(text, percent) {
    try { chrome.runtime.sendMessage({ type: 'progress', text, percent }); } catch {}
  }

  function done(text) {
    try { chrome.runtime.sendMessage({ type: 'done', text }); } catch {}
  }

  function error(text) {
    try { chrome.runtime.sendMessage({ type: 'error', text }); } catch {}
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

  async function listConversations(archived, auth, maxItems = 0, gizmoId = null) {
    let offset = 0;
    let total = null;
    const items = [];
    const pageSize = maxItems > 0 ? Math.min(LIMIT, maxItems) : LIMIT;
    while (total === null || offset < total) {
      let url = `/conversations?offset=${offset}&limit=${pageSize}&order=updated&is_archived=${archived}&is_starred=false`;
      if (gizmoId) url += `&gizmo_id=${gizmoId}`;
      const data = await api(url, auth);
      total = data.total;
      items.push(...data.items);
      offset += pageSize;
      if (maxItems > 0 && items.length >= maxItems) break;
      if (offset < total) await sleep(DELAY_MS);
    }
    return maxItems > 0 ? items.slice(0, maxItems) : items;
  }

  function filterConversations(items, options) {
    let filtered = items;

    if (options.project && options.project !== 'all') {
      if (options.project === 'inbox') {
        filtered = filtered.filter((c) => !c.gizmo_id);
      } else {
        filtered = filtered.filter((c) => c.gizmo_id === options.project);
      }
    }

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

      const parts = msg.content?.parts || [];
      for (const part of parts) {
        if (typeof part === 'object' && part !== null) {
          if (part.asset_pointer) {
            files.push({
              type: 'image',
              url: part.asset_pointer,
              content_type: part.content_type || 'image/png',
              name: part.metadata?.dalle?.prompt?.slice(0, 50) || 'image',
            });
          }
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
        headers: { Authorization: `Bearer ${auth.token}` },
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

      // Server-side gizmo filter (project conversations are separate in the API)
      const gizmoId = (options.project && options.project !== 'all' && options.project !== 'inbox')
        ? options.project : null;

      // Early limit only when no client-side filters will reduce the set
      const hasClientFilters = options.keyword || options.dateFrom || options.dateTo
        || options.project === 'inbox';
      const earlyLimit = (!hasClientFilters && options.limit > 0) ? options.limit : 0;

      let all = [];
      if (options.source === 'active' || options.source === 'both') {
        progress('Listing active conversations…', 5);
        const active = await listConversations(false, auth, earlyLimit, gizmoId);
        all.push(...active.map((c) => ({ ...c, _source: 'active' })));
      }
      if (options.source === 'archived' || options.source === 'both') {
        if (earlyLimit > 0 && all.length >= earlyLimit) {
          // already have enough
        } else {
          progress('Listing archived conversations…', 10);
          await sleep(DELAY_MS);
          const remaining = earlyLimit > 0 ? earlyLimit - all.length : 0;
          const archived = await listConversations(true, auth, remaining, gizmoId);
          all.push(...archived.map((c) => ({ ...c, _source: 'archived' })));
        }
      }

      const seen = new Set();
      all = all.filter((c) => {
        if (seen.has(c.id)) return false;
        seen.add(c.id);
        return true;
      });

      const filtered = filterConversations(all, options);
      progress(`Found ${filtered.length} conversations`, 15);

      if (filtered.length === 0) {
        done('No conversations match your filters.');
        return;
      }

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

      progress('Building export…', 92);
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

      const fmt = options.format || 'json';
      const datestamp = new Date().toISOString().slice(0, 10);
      const formats = {
        json:     { ext: 'json',  mime: 'application/json',       fn: () => JSON.stringify(exportData, null, 2) },
        markdown: { ext: 'md',    mime: 'text/markdown',          fn: () => toMarkdown(exportData) },
        jsonl:    { ext: 'jsonl', mime: 'application/x-jsonlines', fn: () => toJSONL(exportData) },
        html:     { ext: 'html',  mime: 'text/html',              fn: () => toHTML(exportData) },
        csv:      { ext: 'csv',   mime: 'text/csv',               fn: () => toCSV(exportData) },
        txt:      { ext: 'txt',   mime: 'text/plain',             fn: () => toPlainText(exportData) },
      };

      const { ext, mime, fn } = formats[fmt];
      progress(`Generating ${ext.toUpperCase()}…`, 95);
      const content = fn();

      progress('Downloading…', 99);
      const blob = new Blob([content], { type: mime });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `chatgpt-export-${datestamp}.${ext}`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      done(
        `Exported ${conversations.length} conversations as ${ext.toUpperCase()}` +
          (errors.length ? `, ${errors.length} errors` : '')
      );
    } catch (e) {
      error(e.message);
    }
  }

  async function listProjects() {
    const auth = await getAuth();
    const data = await api(
      '/gizmos/snorlax/sidebar?owned_only=true&conversations_per_gizmo=0&limit=50',
      auth
    );
    return (data.items || []).map((item) => {
      const g = item.gizmo?.gizmo || {};
      const display = g.display || {};
      return {
        id: g.id,
        name: display.name || 'Untitled',
        emoji: display.emoji || '',
        interactions: g.num_interactions || 0,
      };
    });
  }

  // --- Archive / Unarchive ---
  let pendingConfirmResolve = null;

  async function setArchived(conversationId, archived, auth) {
    const res = await fetch(`/backend-api/conversation/${conversationId}`, {
      method: 'PATCH',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${auth.token}`,
        ...(auth.accountId ? { 'chatgpt-account-id': auth.accountId } : {}),
      },
      body: JSON.stringify({ is_archived: archived }),
    });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    return res.json();
  }

  async function runArchiveAction(options, archive) {
    const verb = archive ? 'Archive' : 'Unarchive';
    try {
      progress('Authenticating…', 0);
      const auth = await getAuth();

      // For archive: list active. For unarchive: list archived.
      const isArchived = !archive;
      const gizmoId = (options.project && options.project !== 'all' && options.project !== 'inbox')
        ? options.project : null;
      progress(`Listing ${archive ? 'active' : 'archived'} conversations…`, 5);
      const all = await listConversations(isArchived, auth, 0, gizmoId);
      const tagged = all.map((c) => ({ ...c, _source: isArchived ? 'archived' : 'active' }));

      const filtered = filterConversations(tagged, options);
      progress(`Found ${filtered.length} conversations to ${verb.toLowerCase()}`, 15);

      if (filtered.length === 0) {
        done(`No conversations match your filters.`);
        return;
      }

      // Ask for confirmation via popup
      try {
        chrome.runtime.sendMessage({
          type: 'confirm',
          text: `${verb} ${filtered.length} conversation${filtered.length > 1 ? 's' : ''}?`,
        });
      } catch {}

      // Wait for confirmation
      const confirmed = await new Promise((resolve) => {
        pendingConfirmResolve = resolve;
      });
      pendingConfirmResolve = null;

      if (!confirmed) return;

      // Execute
      let successCount = 0;
      const errors = [];
      for (let i = 0; i < filtered.length; i++) {
        const c = filtered[i];
        const pct = 15 + Math.round((i / filtered.length) * 80);
        progress(`[${i + 1}/${filtered.length}] ${c.title || 'untitled'}`, pct);
        try {
          await setArchived(c.id, archive, auth);
          successCount++;
        } catch (e) {
          errors.push({ id: c.id, title: c.title, error: e.message });
        }
        if (i < filtered.length - 1) await sleep(DELAY_MS);
      }

      done(
        `${verb}d ${successCount} conversations` +
          (errors.length ? `, ${errors.length} errors` : '')
      );
    } catch (e) {
      error(e.message);
    }
  }

  // Listen for messages from popup
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.action === 'list-projects') {
      listProjects()
        .then((projects) => sendResponse({ projects }))
        .catch(() => sendResponse({ projects: [] }));
      return true;
    }
    if (msg.action === 'export') {
      runExport(msg.options);
      sendResponse({ ok: true });
    }
    if (msg.action === 'archive') {
      runArchiveAction(msg.options, true);
      sendResponse({ ok: true });
    }
    if (msg.action === 'unarchive') {
      runArchiveAction(msg.options, false);
      sendResponse({ ok: true });
    }
    if (msg.action === 'confirm-response') {
      if (pendingConfirmResolve) pendingConfirmResolve(msg.confirmed);
    }
  });
}
