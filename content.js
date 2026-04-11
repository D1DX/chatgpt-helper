// ChatGPT Helper — content script
// Runs on chatgpt.com, handles API calls and export logic.

// Guard against double-injection
if (!window.__chatgptExportLoaded) {
  window.__chatgptExportLoaded = true;

  const LIMIT = 100;
  const DELAY_INITIAL = 800;
  const DELAY_MAX = 60000;
  const CHECKPOINT_KEY = 'export_checkpoint';

  let delayMs = DELAY_INITIAL;
  let abortRequested = false;
  let pauseRequested = false;
  let running = false;
  let lastStatus = null;
  let currentCheckpoint = null;  // in-memory mirror of chrome.storage.local[CHECKPOINT_KEY]

  // --- Checkpoint persistence ---
  async function loadCheckpoint() {
    try {
      const result = await chrome.storage.local.get(CHECKPOINT_KEY);
      return result[CHECKPOINT_KEY] || null;
    } catch (e) {
      D('loadCheckpoint: error', e.message);
      return null;
    }
  }

  async function saveCheckpoint(cp) {
    try {
      cp.lastUpdate = new Date().toISOString();
      currentCheckpoint = cp;
      await chrome.storage.local.set({ [CHECKPOINT_KEY]: cp });
    } catch (e) {
      D('saveCheckpoint: error', e.message);
    }
  }

  async function clearCheckpoint() {
    try {
      await chrome.storage.local.remove(CHECKPOINT_KEY);
      currentCheckpoint = null;
    } catch (e) {
      D('clearCheckpoint: error', e.message);
    }
  }

  function optionsMatch(a, b) {
    if (!a || !b) return false;
    // Mode guard: list-mode options must not match retry-mode options
    const aIsRetry = Array.isArray(a._retryIds) && a._retryIds.length > 0;
    const bIsRetry = Array.isArray(b._retryIds) && b._retryIds.length > 0;
    if (aIsRetry !== bIsRetry) return false;
    if (aIsRetry) {
      // For retry mode, the ID list defines identity
      if (a._retryIds.length !== b._retryIds.length) return false;
      const as = new Set(a._retryIds);
      for (const id of b._retryIds) if (!as.has(id)) return false;
      return (a.format ?? null) === (b.format ?? null);
    }
    const keys = ['project', 'source', 'dateFrom', 'dateTo', 'keyword', 'limit', 'attachments', 'format'];
    return keys.every((k) => (a[k] ?? null) === (b[k] ?? null));
  }

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
    if (pauseRequested) throw new Error('Paused by user');
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

  // --- Build target list from filters (list + filter phase) ---
  async function buildTargetList(options, auth) {
    const isProjectFilter = options.project && options.project !== 'all' && options.project !== 'inbox';
    let all = [];

    if (isProjectFilter) {
      D('buildTargetList: project filter', options.project);
      progress('Listing project conversations…', 5);
      const projectConvs = await listProjectConversations(options.project, auth);
      all.push(...projectConvs.map((c) => ({ ...c, _source: 'active' })));
    } else {
      const hasClientFilters = options.keyword || options.dateFrom || options.dateTo
        || options.project === 'inbox';
      const earlyLimit = (!hasClientFilters && options.limit > 0) ? options.limit : 0;
      D('buildTargetList: hasClientFilters =', hasClientFilters, 'earlyLimit =', earlyLimit);

      if (options.source === 'active' || options.source === 'both') {
        checkAbort();
        progress('Listing active conversations…', 5);
        const active = await listConversations(false, auth, earlyLimit);
        all.push(...active.map((c) => ({ ...c, _source: 'active' })));
      }
      if (options.source === 'archived' || options.source === 'both') {
        if (earlyLimit > 0 && all.length >= earlyLimit) {
          D('buildTargetList: skipping archived — earlyLimit satisfied');
        } else {
          checkAbort();
          progress('Listing archived conversations…', 10);
          await sleep(delayMs);
          const remaining = earlyLimit > 0 ? earlyLimit - all.length : 0;
          const archived = await listConversations(true, auth, remaining);
          all.push(...archived.map((c) => ({ ...c, _source: 'archived' })));
        }
      }
    }

    const seen = new Set();
    all = all.filter((c) => {
      if (seen.has(c.id)) return false;
      seen.add(c.id);
      return true;
    });

    return filterConversations(all, options);
  }

  // --- Build export data object from a checkpoint ---
  function buildExportData(cp, auth) {
    const conversations = Object.values(cp.fetched);
    const errors = cp.failed || [];
    const attachmentMap = cp.attachments || {};
    return {
      exported_at: new Date().toISOString(),
      account: (auth && auth.accountId) || cp.account || 'unknown',
      filters: cp.options,
      stats: {
        total_listed: cp.targetIds.length,
        after_filters: cp.targetIds.length,
        fetched: conversations.length,
        errors: errors.length,
        attachments: Object.keys(attachmentMap).length,
        mode: cp.mode,
      },
      errors,
      conversations,
      ...(Object.keys(attachmentMap).length > 0 ? { attachments: attachmentMap } : {}),
    };
  }

  // --- Download export data as a file (format depends on options.format) ---
  function downloadExport(exportData, fmt) {
    const datestamp = new Date().toISOString().slice(0, 10);
    const formats = {
      json:     { ext: 'json',  mime: 'application/json',        fn: () => JSON.stringify(exportData, null, 2) },
      markdown: { ext: 'md',    mime: 'text/markdown',           fn: () => toMarkdown(exportData) },
      jsonl:    { ext: 'jsonl', mime: 'application/x-jsonlines', fn: () => toJSONL(exportData) },
      html:     { ext: 'html',  mime: 'text/html',               fn: () => toHTML(exportData) },
      csv:      { ext: 'csv',   mime: 'text/csv',                fn: () => toCSV(exportData) },
      txt:      { ext: 'txt',   mime: 'text/plain',              fn: () => toPlainText(exportData) },
    };
    const { ext, mime, fn } = formats[fmt] || formats.json;
    const content = fn();
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `chatgpt-export-${datestamp}.${ext}`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    return { ext, size: content.length };
  }

  // --- Run fetch loop over a target list, writing checkpoint after every item ---
  async function fetchLoop(cp, auth) {
    const remaining = cp.targetIds.filter((id) => !cp.fetched[id]);
    D('fetchLoop: total =', cp.targetIds.length, 'already fetched =', Object.keys(cp.fetched).length, 'remaining =', remaining.length);

    if (remaining.length === 0) {
      progress('All target conversations already fetched', 90);
      return;
    }

    for (let i = 0; i < remaining.length; i++) {
      checkAbort();
      const id = remaining[i];
      const alreadyDone = Object.keys(cp.fetched).length;
      const totalTarget = cp.targetIds.length;
      const pct = 15 + Math.round(((alreadyDone + 1) / totalTarget) * 75);
      progress(`[${alreadyDone + 1}/${totalTarget}] ${id.slice(0, 8)}…`, pct);

      let data = null;
      let attachmentsFetched = null;
      try {
        D('fetchLoop: fetching', id);
        data = await api(`/conversation/${id}`, auth);

        if (cp.options.attachments) {
          const files = extractFileRefs(data);
          if (files.length > 0) {
            D('fetchLoop: fetching', files.length, 'attachments for', id);
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
            attachmentsFetched = fetched;
          }
        }

        // Only mark as fetched after conv + attachments both succeeded
        cp.fetched[id] = data;
        if (attachmentsFetched) {
          cp.attachments = cp.attachments || {};
          cp.attachments[id] = attachmentsFetched;
        }
        // Clear any prior failure entry for this id on success
        if (cp.failed && cp.failed.length) {
          cp.failed = cp.failed.filter((f) => f.id !== id);
        }
      } catch (e) {
        if (e.message === 'Cancelled by user' || e.message === 'Paused by user') throw e;
        D('fetchLoop: ERROR fetching', id, ':', e.message);
        cp.failed = cp.failed || [];
        cp.failed = cp.failed.filter((f) => f.id !== id);
        cp.failed.push({ id, title: id.slice(0, 8), error: e.message });
      }

      // Checkpoint after every fetch — this is the whole point
      await saveCheckpoint(cp);

      if (i < remaining.length - 1) await sleep(delayMs);
    }
  }

  // --- Main export entry point ---
  async function runExport(options) {
    D('========== runExport START ==========');
    D('runExport: options =', JSON.stringify(options, null, 2));
    try {
      progress('Authenticating…', 0);
      const auth = await getAuth();
      D('runExport: auth OK, accountId =', auth.accountId);

      // Resume mode: options include _resume flag and we have a matching checkpoint
      let cp = await loadCheckpoint();

      if (options._resume && cp && optionsMatch(cp.options, options)) {
        D('runExport: RESUMING from existing checkpoint');
        cp.paused = false;
        progress(`Resuming — ${Object.keys(cp.fetched).length}/${cp.targetIds.length} already fetched`, 15);
        await saveCheckpoint(cp);
      } else if (options._retryIds && Array.isArray(options._retryIds) && options._retryIds.length > 0) {
        D('runExport: RETRY-BY-ID mode with', options._retryIds.length, 'ids');
        cp = {
          runId: Date.now().toString(),
          mode: 'retry',
          options,
          startedAt: new Date().toISOString(),
          account: auth.accountId,
          targetIds: options._retryIds.slice(),
          fetched: {},
          failed: [],
          attachments: {},
          paused: false,
        };
        progress(`Retry-by-ID: ${cp.targetIds.length} conversations queued`, 15);
        await saveCheckpoint(cp);
      } else {
        // Fresh list-based run — build target list, then create new checkpoint
        D('runExport: FRESH run — building target list');
        const filtered = await buildTargetList(options, auth);
        progress(`Found ${filtered.length} conversations`, 15);
        if (filtered.length === 0) {
          await clearCheckpoint();
          done('No conversations match your filters.');
          return;
        }
        cp = {
          runId: Date.now().toString(),
          mode: 'list',
          options,
          startedAt: new Date().toISOString(),
          account: auth.accountId,
          targetIds: filtered.map((c) => c.id),
          // Preserve source labels from the listing phase for later use
          targetMeta: Object.fromEntries(filtered.map((c) => [c.id, { title: c.title, _source: c._source }])),
          fetched: {},
          failed: [],
          attachments: {},
          paused: false,
        };
        await saveCheckpoint(cp);
      }

      await fetchLoop(cp, auth);

      checkAbort();
      progress('Building export…', 92);
      const exportData = buildExportData(cp, auth);

      const fmt = options.format || 'json';
      progress(`Generating ${fmt.toUpperCase()}…`, 95);
      const { ext } = downloadExport(exportData, fmt);
      D('runExport: download triggered —', ext);

      // Completed — clear checkpoint
      await clearCheckpoint();

      const errCount = (cp.failed || []).length;
      done(
        `Exported ${Object.keys(cp.fetched).length} conversations as ${ext.toUpperCase()}` +
          (errCount ? `, ${errCount} errors` : '')
      );
      D('========== runExport END ==========');
    } catch (e) {
      if (e.message === 'Paused by user') {
        D('runExport: PAUSED — checkpoint preserved');
        if (currentCheckpoint) {
          currentCheckpoint.paused = true;
          await saveCheckpoint(currentCheckpoint);
        }
        const fetchedCount = currentCheckpoint ? Object.keys(currentCheckpoint.fetched).length : 0;
        const totalCount = currentCheckpoint ? currentCheckpoint.targetIds.length : 0;
        const text = `Paused — ${fetchedCount}/${totalCount} fetched. Open popup to resume or download partial.`;
        running = false;
        setStatus('done', text, Math.round((fetchedCount / (totalCount || 1)) * 100));
        try { chrome.runtime.sendMessage({ type: 'done', text }); } catch {}
        return;
      }
      D('runExport: FATAL ERROR:', e.message, e.stack);
      error(e.message);
    }
  }

  // --- Download partial export from current checkpoint without waiting for completion ---
  async function runDownloadPartial() {
    D('========== runDownloadPartial ==========');
    try {
      const cp = await loadCheckpoint();
      if (!cp || Object.keys(cp.fetched).length === 0) {
        error('No checkpoint with fetched conversations found.');
        return;
      }
      progress('Building partial export…', 50);
      const auth = { accountId: cp.account };
      const exportData = buildExportData(cp, auth);
      exportData.stats.partial = true;
      const fmt = cp.options.format || 'json';
      const { ext } = downloadExport(exportData, fmt);
      done(`Partial export: ${Object.keys(cp.fetched).length}/${cp.targetIds.length} conversations as ${ext.toUpperCase()}`);
    } catch (e) {
      D('runDownloadPartial: error', e.message);
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

    if (msg.action === 'get-checkpoint') {
      loadCheckpoint().then((cp) => {
        if (!cp) {
          sendResponse({ hasCheckpoint: false });
          return;
        }
        sendResponse({
          hasCheckpoint: true,
          checkpoint: {
            runId: cp.runId,
            mode: cp.mode,
            startedAt: cp.startedAt,
            lastUpdate: cp.lastUpdate,
            paused: cp.paused,
            total: cp.targetIds.length,
            fetched: Object.keys(cp.fetched).length,
            failed: (cp.failed || []).length,
            options: cp.options,
          },
        });
      });
      return true;
    }

    if (msg.action === 'clear-checkpoint') {
      clearCheckpoint().then(() => sendResponse({ ok: true }));
      return true;
    }

    if (msg.action === 'download-partial') {
      if (running) {
        sendResponse({ ok: false, reason: 'Cannot download while export is running — pause first' });
        return;
      }
      runDownloadPartial();
      sendResponse({ ok: true });
      return;
    }

    if (msg.action === 'abort') {
      D('Abort requested');
      abortRequested = true;
      // Also clear the checkpoint on abort — user wants it gone
      clearCheckpoint();
      sendResponse({ ok: true });
      return;
    }

    if (msg.action === 'pause') {
      D('Pause requested');
      pauseRequested = true;
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
      pauseRequested = false;
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
      pauseRequested = false;
      delayMs = DELAY_INITIAL;
      runExportMemories(msg.options);
      sendResponse({ ok: true });
    }
  });
}
