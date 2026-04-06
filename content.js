// ChatGPT Helper — content script
// Runs on chatgpt.com, handles API calls and export logic.

// Guard against double-injection
if (!window.__chatgptExportLoaded) {
  window.__chatgptExportLoaded = true;

  const LIMIT = 100;
  const DELAY_INITIAL = 800;
  const DELAY_MAX = 60000;

  let delayMs = DELAY_INITIAL;
  let abortRequested = false;
  let running = false;
  let lastStatus = null;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const D = (...args) => console.log('[ChatGPT Helper]', ...args);

  function setStatus(type, text, percent) {
    lastStatus = { type, text, percent, ts: Date.now() };
  }

  function progress(text, percent) {
    D('PROGRESS:', text, percent !== undefined ? `${percent}%` : '');
    setStatus('progress', text, percent);
    try { chrome.runtime.sendMessage({ type: 'progress', text, percent }); } catch {}
  }

  function done(text) {
    D('DONE:', text);
    running = false;
    setStatus('done', text, 100);
    try { chrome.runtime.sendMessage({ type: 'done', text }); } catch {}
  }

  function error(text) {
    D('ERROR:', text);
    running = false;
    setStatus('error', text, undefined);
    try { chrome.runtime.sendMessage({ type: 'error', text }); } catch {}
  }

  function checkAbort() {
    if (abortRequested) throw new Error('Cancelled by user');
  }

  async function getAuth() {
    D('getAuth: reading _account cookie...');
    const acct = document.cookie
      .split(';')
      .map((c) => c.trim())
      .find((c) => c.startsWith('_account='));
    const accountId = acct ? acct.split('=')[1] : null;
    D('getAuth: accountId =', accountId);

    D('getAuth: fetching /api/auth/session...');
    const res = await fetch('/api/auth/session', { credentials: 'include' });
    D('getAuth: session response status =', res.status);
    const sess = await res.json();
    const token = sess.accessToken;
    D('getAuth: token present =', !!token, ', length =', token?.length);

    if (!token) throw new Error('No access token — are you logged in?');
    return { token, accountId };
  }

  async function api(path, auth) {
    let attempt = 0;
    while (true) {
      attempt++;
      checkAbort();
      const fullUrl = `/backend-api${path}`;
      D('API REQUEST:', fullUrl, attempt > 1 ? `(attempt ${attempt})` : '');
      const res = await fetch(fullUrl, {
        credentials: 'include',
        headers: {
          Authorization: `Bearer ${auth.token}`,
          ...(auth.accountId ? { 'chatgpt-account-id': auth.accountId } : {}),
        },
      });
      D('API RESPONSE:', fullUrl, '→ status:', res.status, res.statusText);

      if (res.status === 429) {
        delayMs = Math.min(delayMs * 2, DELAY_MAX);
        const retryAfter = parseInt(res.headers.get('Retry-After')) || Math.ceil(delayMs / 1000);
        // Escalating cooldowns: 0 → 60s → 2min → 5min
        const cooldown = attempt >= 15 ? 300000 : attempt >= 10 ? 120000 : attempt >= 5 ? 60000 : 0;
        const waitMs = Math.max(retryAfter * 1000, delayMs) + cooldown;
        const waitSec = Math.round(waitMs / 1000);
        const waitMin = waitSec >= 60 ? `${(waitSec / 60).toFixed(1)}min` : `${waitSec}s`;
        D('API 429: waiting', waitMs, 'ms, delayMs =', delayMs, ', cooldown =', cooldown, ', attempt =', attempt);
        progress(`Rate limited — waiting ${waitMin}… (attempt ${attempt})`);
        await sleep(waitMs);
        continue;
      }

      if (!res.ok) {
        const body = await res.text();
        D('API ERROR BODY:', body.slice(0, 500));
        throw new Error(`${res.status} ${res.statusText} — ${path}`);
      }

      // Success — gradually recover speed
      if (delayMs > DELAY_INITIAL) {
        delayMs = Math.max(DELAY_INITIAL, Math.round(delayMs * 0.75));
        D('API success: delay recovering to', delayMs, 'ms');
      }

      const data = await res.json();
      D('API RESPONSE DATA keys:', Object.keys(data), ', total:', data.total, ', items:', data.items?.length);
      return data;
    }
  }

  async function listConversations(archived, auth, maxItems = 0) {
    D('listConversations: archived =', archived, ', maxItems =', maxItems);
    let offset = 0;
    let total = null;
    const items = [];
    const pageSize = maxItems > 0 ? Math.min(LIMIT, maxItems) : LIMIT;
    D('listConversations: pageSize =', pageSize);
    while (total === null || offset < total) {
      checkAbort();
      const url = `/conversations?offset=${offset}&limit=${pageSize}&order=updated&is_archived=${archived}&is_starred=false`;
      D('listConversations: fetching url =', url);
      const data = await api(url, auth);
      total = data.total;
      D('listConversations: page result — total:', total, ', items in page:', data.items?.length, ', accumulated:', items.length + (data.items?.length || 0));
      if (data.items) {
        for (const item of data.items) {
          D('  conversation:', item.id, '|', item.title, '| gizmo_id:', item.gizmo_id, '| archived:', item.is_archived);
        }
      }
      items.push(...(data.items || []));
      offset += pageSize;
      if (maxItems > 0 && items.length >= maxItems) {
        D('listConversations: early stop — have', items.length, '>= maxItems', maxItems);
        break;
      }
      if (offset < total) await sleep(delayMs);
    }
    const result = maxItems > 0 ? items.slice(0, maxItems) : items;
    D('listConversations: returning', result.length, 'items');
    return result;
  }

  function filterConversations(items, options) {
    D('filterConversations: input count =', items.length);
    D('filterConversations: options =', JSON.stringify(options));
    let filtered = items;

    if (options.project && options.project !== 'all') {
      const before = filtered.length;
      if (options.project === 'inbox') {
        filtered = filtered.filter((c) => !c.gizmo_id);
        D('filterConversations: inbox filter — before:', before, ', after:', filtered.length);
      } else {
        D('filterConversations: project filter — looking for gizmo_id ===', JSON.stringify(options.project));
        filtered.forEach((c) => {
          D('  checking:', c.id, '| gizmo_id:', JSON.stringify(c.gizmo_id), '| match:', c.gizmo_id === options.project);
        });
        filtered = filtered.filter((c) => c.gizmo_id === options.project);
        D('filterConversations: project filter — before:', before, ', after:', filtered.length);
      }
    }

    if (options.keyword) {
      const before = filtered.length;
      const kw = options.keyword.toLowerCase();
      filtered = filtered.filter(
        (c) => c.title && c.title.toLowerCase().includes(kw)
      );
      D('filterConversations: keyword filter "' + kw + '" — before:', before, ', after:', filtered.length);
    }

    if (options.dateFrom) {
      const before = filtered.length;
      const from = new Date(options.dateFrom).getTime() / 1000;
      filtered = filtered.filter((c) => {
        const t =
          typeof c.create_time === 'string'
            ? new Date(c.create_time).getTime() / 1000
            : c.create_time;
        return t >= from;
      });
      D('filterConversations: dateFrom filter — before:', before, ', after:', filtered.length);
    }

    if (options.dateTo) {
      const before = filtered.length;
      const to = new Date(options.dateTo + 'T23:59:59').getTime() / 1000;
      filtered = filtered.filter((c) => {
        const t =
          typeof c.create_time === 'string'
            ? new Date(c.create_time).getTime() / 1000
            : c.create_time;
        return t <= to;
      });
      D('filterConversations: dateTo filter — before:', before, ', after:', filtered.length);
    }

    if (options.limit > 0) {
      const before = filtered.length;
      filtered = filtered.slice(0, options.limit);
      D('filterConversations: limit', options.limit, '— before:', before, ', after:', filtered.length);
    }

    D('filterConversations: final count =', filtered.length);
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
    D('extractFileRefs:', files.length, 'files found');
    return files;
  }

  async function fetchAttachment(url, auth) {
    D('fetchAttachment:', url);
    try {
      let resolvedUrl = url;

      // file-service:// URLs need two-step resolution
      if (url && url.startsWith('file-service://')) {
        const fileId = url.replace('file-service://', '');
        D('fetchAttachment: resolving file-service URL, fileId =', fileId);
        const meta = await api(`/files/download/${fileId}?post_id=&inline=false`, auth);
        if (!meta.download_url) {
          D('fetchAttachment: no download_url in response:', JSON.stringify(meta));
          return null;
        }
        resolvedUrl = meta.download_url;
        D('fetchAttachment: resolved to', resolvedUrl);
      }

      if (!resolvedUrl) return null;

      let attempt = 0;
      while (true) {
        attempt++;
        const fetchUrl = resolvedUrl.startsWith('http') ? resolvedUrl : `https://chatgpt.com${resolvedUrl}`;
        D('fetchAttachment: fetching', fetchUrl, attempt > 1 ? `(attempt ${attempt})` : '');
        const res = await fetch(fetchUrl, {
          credentials: 'include',
          headers: { Authorization: `Bearer ${auth.token}` },
        });
        D('fetchAttachment: status =', res.status);

        if (res.status === 429) {
          delayMs = Math.min(delayMs * 2, DELAY_MAX);
          const retryAfter = parseInt(res.headers.get('Retry-After')) || Math.ceil(delayMs / 1000);
          const cooldown = attempt >= 15 ? 300000 : attempt >= 10 ? 120000 : attempt >= 5 ? 60000 : 0;
          const waitMs = Math.max(retryAfter * 1000, delayMs) + cooldown;
          const waitSec = Math.round(waitMs / 1000);
          const waitMin = waitSec >= 60 ? `${(waitSec / 60).toFixed(1)}min` : `${waitSec}s`;
          D('fetchAttachment 429: waiting', waitMs, 'ms, attempt =', attempt);
          progress(`Rate limited on attachment — waiting ${waitMin}… (attempt ${attempt})`);
          await sleep(waitMs);
          continue;
        }

        if (!res.ok) {
          D('fetchAttachment: failed with', res.status);
          return null;
        }

        if (delayMs > DELAY_INITIAL) {
          delayMs = Math.max(DELAY_INITIAL, Math.round(delayMs * 0.75));
        }

        const blob = await res.blob();
        return new Promise((resolve) => {
          const reader = new FileReader();
          reader.onloadend = () => resolve(reader.result);
          reader.readAsDataURL(blob);
        });
      }
    } catch (e) {
      D('fetchAttachment: error =', e.message);
      return null;
    }
  }

  async function runExport(options) {
    D('========== runExport START ==========');
    D('runExport: options =', JSON.stringify(options, null, 2));
    try {
      progress('Authenticating…', 0);
      const auth = await getAuth();
      D('runExport: auth OK, accountId =', auth.accountId);

      const isProjectFilter = options.project && options.project !== 'all' && options.project !== 'inbox';
      D('runExport: isProjectFilter =', isProjectFilter, ', project =', options.project);

      let all = [];

      if (isProjectFilter) {
        D('runExport: fetching project conversations for', options.project);
        progress('Listing project conversations…', 5);
        const projectConvs = await listProjectConversations(options.project, auth);
        all.push(...projectConvs.map((c) => ({ ...c, _source: 'active' })));
        D('runExport: project conversations count =', all.length);
      } else {
        const hasClientFilters = options.keyword || options.dateFrom || options.dateTo
          || options.project === 'inbox';
        const earlyLimit = (!hasClientFilters && options.limit > 0) ? options.limit : 0;
        D('runExport: hasClientFilters =', hasClientFilters, ', earlyLimit =', earlyLimit);

        if (options.source === 'active' || options.source === 'both') {
          checkAbort();
          D('runExport: listing ACTIVE conversations, earlyLimit =', earlyLimit);
          progress('Listing active conversations…', 5);
          const active = await listConversations(false, auth, earlyLimit);
          D('runExport: active result count =', active.length);
          all.push(...active.map((c) => ({ ...c, _source: 'active' })));
        }
        if (options.source === 'archived' || options.source === 'both') {
          if (earlyLimit > 0 && all.length >= earlyLimit) {
            D('runExport: skipping archived — earlyLimit already satisfied');
          } else {
            checkAbort();
            D('runExport: listing ARCHIVED conversations');
            progress('Listing archived conversations…', 10);
            await sleep(delayMs);
            const remaining = earlyLimit > 0 ? earlyLimit - all.length : 0;
            const archived = await listConversations(true, auth, remaining);
            D('runExport: archived result count =', archived.length);
            all.push(...archived.map((c) => ({ ...c, _source: 'archived' })));
          }
        }
      }

      D('runExport: total before dedup =', all.length);
      const seen = new Set();
      all = all.filter((c) => {
        if (seen.has(c.id)) return false;
        seen.add(c.id);
        return true;
      });
      D('runExport: total after dedup =', all.length);

      D('runExport: calling filterConversations...');
      const filtered = filterConversations(all, options);
      progress(`Found ${filtered.length} conversations`, 15);

      if (filtered.length === 0) {
        D('runExport: 0 results after filter — returning');
        done('No conversations match your filters.');
        return;
      }

      const conversations = [];
      const errors = [];
      const attachmentMap = {};

      for (let i = 0; i < filtered.length; i++) {
        checkAbort();
        const c = filtered[i];
        const pct = 15 + Math.round((i / filtered.length) * 75);
        progress(`[${i + 1}/${filtered.length}] ${c.title || 'untitled'}`, pct);

        try {
          D('runExport: fetching full conversation', c.id, c.title);
          const data = await api(`/conversation/${c.id}`, auth);
          data._source = c._source;
          conversations.push(data);

          if (options.attachments) {
            const files = extractFileRefs(data);
            if (files.length > 0) {
              D('runExport: fetching', files.length, 'attachments for', c.id);
              const fetched = [];
              for (const f of files) {
                checkAbort();
                if (f.url) {
                  const dataUrl = await fetchAttachment(f.url, auth);
                  fetched.push({ ...f, data: dataUrl });
                } else {
                  fetched.push(f);
                }
                await sleep(delayMs);
              }
              attachmentMap[c.id] = fetched;
            }
          }
        } catch (e) {
          if (e.message === 'Cancelled by user') throw e;
          D('runExport: ERROR fetching conversation', c.id, ':', e.message);
          errors.push({ id: c.id, title: c.title, error: e.message });
        }

        if (i < filtered.length - 1) await sleep(delayMs);
      }

      checkAbort();
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
      D('runExport: generated', ext, '— size:', content.length);

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
      D('========== runExport END ==========');
    } catch (e) {
      D('runExport: FATAL ERROR:', e.message, e.stack);
      error(e.message);
    }
  }

  async function listProjects() {
    D('listProjects: fetching sidebar...');
    const auth = await getAuth();
    const data = await api(
      '/gizmos/snorlax/sidebar?owned_only=true&conversations_per_gizmo=0&limit=50',
      auth
    );
    const projects = (data.items || []).map((item) => {
      const g = item.gizmo?.gizmo || {};
      const display = g.display || {};
      return {
        id: g.id,
        name: display.name || 'Untitled',
        emoji: display.emoji || '',
        interactions: g.num_interactions || 0,
      };
    });
    D('listProjects: found', projects.length, 'projects:', projects.map((p) => `${p.id} = ${p.name}`));
    return projects;
  }

  async function listProjectConversations(gizmoId, auth) {
    D('listProjectConversations: gizmoId =', gizmoId);

    try {
      D('listProjectConversations: trying /gizmos endpoint...');
      let offset = 0;
      let total = null;
      const items = [];
      while (total === null || offset < total) {
        checkAbort();
        const url = `/gizmos/${gizmoId}/conversations?offset=${offset}&limit=${LIMIT}`;
        const data = await api(url, auth);
        total = data.total;
        items.push(...(data.items || data.conversations || []));
        D('listProjectConversations: page — total:', total, ', accumulated:', items.length);
        offset += LIMIT;
        if (offset < total) await sleep(delayMs);
      }
      D('listProjectConversations: gizmo endpoint returned', items.length, 'conversations');
      if (items.length > 0) return items;
    } catch (e) {
      if (e.message === 'Cancelled by user') throw e;
      D('listProjectConversations: gizmo endpoint failed:', e.message);
    }

    D('listProjectConversations: falling back to sidebar approach...');
    const sidebarData = await api(
      `/gizmos/snorlax/sidebar?owned_only=true&conversations_per_gizmo=200&limit=50`,
      auth
    );
    const match = (sidebarData.items || []).find((item) => {
      const id = item.gizmo?.gizmo?.id;
      return id === gizmoId;
    });
    const convs = match?.conversations || [];
    D('listProjectConversations: sidebar returned', convs.length, 'conversations for', gizmoId);
    for (const c of convs) {
      D('  sidebar conv:', c.id, '|', c.title);
    }
    return convs;
  }

  async function runExportMemories(options) {
    D('========== runExportMemories START ==========');
    try {
      progress('Authenticating…', 0);
      const auth = await getAuth();

      const didCookie = document.cookie.split(';').map((c) => c.trim()).find((c) => c.startsWith('oai-did='));
      const deviceId = didCookie ? didCookie.split('=')[1] : null;
      D('runExportMemories: deviceId =', deviceId);

      checkAbort();
      progress('Fetching memories…', 20);
      const res = await fetch('/backend-api/memories?exclusive_to_gizmo=false&include_memory_entries=true', {
        credentials: 'include',
        headers: {
          Authorization: `Bearer ${auth.token}`,
          ...(auth.accountId ? { 'chatgpt-account-id': auth.accountId } : {}),
          ...(deviceId ? { 'oai-device-id': deviceId } : {}),
          'oai-language': 'en-US',
        },
      });

      D('runExportMemories: status =', res.status);
      if (!res.ok) {
        const body = await res.text();
        D('runExportMemories: error body =', body.slice(0, 500));
        throw new Error(`${res.status} ${res.statusText} — /backend-api/memories`);
      }

      const data = await res.json();
      D('runExportMemories: response keys =', Object.keys(data));
      D('runExportMemories: raw =', JSON.stringify(data).slice(0, 1000));

      let memories = [];
      if (Array.isArray(data.memories)) {
        memories = data.memories;
      } else if (Array.isArray(data.memory_entries)) {
        memories = data.memory_entries;
      } else if (data.memory_tool_config?.memory_entries) {
        memories = data.memory_tool_config.memory_entries;
      } else {
        D('runExportMemories: unknown response shape — full data:', JSON.stringify(data));
      }

      D('runExportMemories: extracted', memories.length, 'memories');
      progress(`Found ${memories.length} memories`, 60);

      if (memories.length === 0) {
        done('No memories found.');
        return;
      }

      checkAbort();
      const exportData = {
        exported_at: new Date().toISOString(),
        account: auth.accountId || 'unknown',
        count: memories.length,
        memories,
      };

      const fmt = options.format || 'json';
      const datestamp = new Date().toISOString().slice(0, 10);
      const formats = {
        json:     { ext: 'json', mime: 'application/json',  fn: () => JSON.stringify(exportData, null, 2) },
        markdown: { ext: 'md',   mime: 'text/markdown',     fn: () => memoriesToMarkdown(exportData) },
        txt:      { ext: 'txt',  mime: 'text/plain',        fn: () => memoriesToText(exportData) },
      };

      const { ext, mime, fn } = formats[fmt] || formats.json;
      progress(`Generating ${ext.toUpperCase()}…`, 90);
      const content = fn();

      progress('Downloading…', 99);
      const blob = new Blob([content], { type: mime });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `chatgpt-memories-${datestamp}.${ext}`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      done(`Exported ${memories.length} memories as ${ext.toUpperCase()}`);
      D('========== runExportMemories END ==========');
    } catch (e) {
      D('runExportMemories: FATAL ERROR:', e.message, e.stack);
      error(e.message);
    }
  }

  // Listen for messages from popup
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    D('MESSAGE RECEIVED:', msg.action);

    if (msg.action === 'get-status') {
      sendResponse({ running, lastStatus });
      return;
    }

    if (msg.action === 'abort') {
      D('Abort requested');
      abortRequested = true;
      sendResponse({ ok: true });
      return;
    }

    if (msg.action === 'list-projects') {
      listProjects()
        .then((projects) => sendResponse({ projects }))
        .catch((e) => {
          D('list-projects error:', e.message);
          sendResponse({ projects: [] });
        });
      return true;
    }

    if (msg.action === 'export') {
      if (running) {
        sendResponse({ ok: false, reason: 'Export already in progress' });
        return;
      }
      running = true;
      abortRequested = false;
      delayMs = DELAY_INITIAL;
      runExport(msg.options);
      sendResponse({ ok: true });
    }

    if (msg.action === 'exportMemories') {
      if (running) {
        sendResponse({ ok: false, reason: 'Export already in progress' });
        return;
      }
      running = true;
      abortRequested = false;
      delayMs = DELAY_INITIAL;
      runExportMemories(msg.options);
      sendResponse({ ok: true });
    }
  });
}
