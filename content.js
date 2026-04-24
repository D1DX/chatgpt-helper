// ChatGPT Helper — content script (v4 unified engine)
// Runs on chatgpt.com. One runUnified(config) engine covers fresh/byids/file sources
// and conversation/attachment payloads; emits a run folder with run-manifest.json.
// runExportMemories is preserved separately.

// Guard against double-injection
if (!window.__chatgptExportLoaded) {
  window.__chatgptExportLoaded = true;

  // --- Constants ---
  const LIMIT = 100;
  const DELAY_INITIAL = 800;
  const DELAY_MAX = 60000;
  const CHECKPOINT_KEY = 'export_checkpoint';
  const VOLUME_TARGET_BYTES = 100 * 1024 * 1024; // ~100 MB uncompressed per ZIP volume
  const RUN_HISTORY_KEY = 'run_history';
  const RUN_HISTORY_MAX = 20;
  const ATTACH_SOURCE_KEY_DEFAULT = 'attach_source_v1';
  const ATTACH_META_KEY_DEFAULT = 'attach_source_meta_v1';
  const MANIFEST_VERSION = 1;

  // --- State ---
  let delayMs = DELAY_INITIAL;
  let abortRequested = false;
  let pauseRequested = false;
  let running = false;
  let lastStatus = null;
  let currentCheckpoint = null;

  // --- Logging + status ---
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

  // --- Auth + raw API ---
  async function getAuth() {
    D('getAuth: reading _account cookie...');
    const acct = document.cookie.split(';').map((c) => c.trim()).find((c) => c.startsWith('_account='));
    const accountId = acct ? acct.split('=')[1] : null;
    const res = await fetch('/api/auth/session', { credentials: 'include' });
    const sess = await res.json();
    const token = sess.accessToken;
    if (!token) throw new Error('No access token — are you logged in?');
    return { token, accountId };
  }

  async function api(path, auth) {
    let attempt = 0;
    while (true) {
      attempt++;
      checkAbort();
      const fullUrl = `/backend-api${path}`;
      const res = await fetch(fullUrl, {
        credentials: 'include',
        headers: {
          Authorization: `Bearer ${auth.token}`,
          ...(auth.accountId ? { 'chatgpt-account-id': auth.accountId } : {}),
        },
      });
      if (res.status === 429) {
        delayMs = Math.min(delayMs * 2, DELAY_MAX);
        const retryAfter = parseInt(res.headers.get('Retry-After')) || Math.ceil(delayMs / 1000);
        const cooldown = attempt >= 15 ? 300000 : attempt >= 10 ? 120000 : attempt >= 5 ? 60000 : 0;
        const waitMs = Math.max(retryAfter * 1000, delayMs) + cooldown;
        const waitSec = Math.round(waitMs / 1000);
        const waitLabel = waitSec >= 60 ? `${(waitSec / 60).toFixed(1)}min` : `${waitSec}s`;
        progress(`Rate limited — waiting ${waitLabel}… (attempt ${attempt})`);
        await sleep(waitMs);
        continue;
      }
      if (!res.ok) {
        const body = await res.text();
        D('API ERROR BODY:', body.slice(0, 500));
        throw new Error(`${res.status} ${res.statusText} — ${path}`);
      }
      if (delayMs > DELAY_INITIAL) delayMs = Math.max(DELAY_INITIAL, Math.round(delayMs * 0.75));
      return await res.json();
    }
  }

  // --- Listing + filtering ---
  async function listConversations(archived, auth, maxItems = 0) {
    let offset = 0;
    let total = null;
    const items = [];
    const pageSize = maxItems > 0 ? Math.min(LIMIT, maxItems) : LIMIT;
    while (total === null || offset < total) {
      checkAbort();
      const url = `/conversations?offset=${offset}&limit=${pageSize}&order=updated&is_archived=${archived}&is_starred=false`;
      const data = await api(url, auth);
      total = data.total;
      items.push(...(data.items || []));
      offset += pageSize;
      if (maxItems > 0 && items.length >= maxItems) break;
      if (offset < total) await sleep(delayMs);
    }
    return maxItems > 0 ? items.slice(0, maxItems) : items;
  }

  function filterConversations(items, filters) {
    let filtered = items;
    if (filters.project && filters.project !== 'all') {
      if (filters.project === 'inbox') filtered = filtered.filter((c) => !c.gizmo_id);
      else filtered = filtered.filter((c) => c.gizmo_id === filters.project);
    }
    if (filters.keyword) {
      const kw = filters.keyword.toLowerCase();
      filtered = filtered.filter((c) => c.title && c.title.toLowerCase().includes(kw));
    }
    if (filters.dateFrom) {
      const from = new Date(filters.dateFrom).getTime() / 1000;
      filtered = filtered.filter((c) => {
        const t = typeof c.create_time === 'string' ? new Date(c.create_time).getTime() / 1000 : c.create_time;
        return t >= from;
      });
    }
    if (filters.dateTo) {
      const to = new Date(filters.dateTo + 'T23:59:59').getTime() / 1000;
      filtered = filtered.filter((c) => {
        const t = typeof c.create_time === 'string' ? new Date(c.create_time).getTime() / 1000 : c.create_time;
        return t <= to;
      });
    }
    if (filters.limit > 0) filtered = filtered.slice(0, filters.limit);
    return filtered;
  }

  async function listProjects() {
    const auth = await getAuth();
    const data = await api('/gizmos/snorlax/sidebar?owned_only=true&conversations_per_gizmo=0&limit=50', auth);
    return (data.items || []).map((item) => {
      const g = item.gizmo?.gizmo || {};
      const display = g.display || {};
      return { id: g.id, name: display.name || 'Untitled', emoji: display.emoji || '', interactions: g.num_interactions || 0 };
    });
  }

  async function listProjectConversations(gizmoId, auth) {
    try {
      let offset = 0, total = null;
      const items = [];
      while (total === null || offset < total) {
        checkAbort();
        const url = `/gizmos/${gizmoId}/conversations?offset=${offset}&limit=${LIMIT}`;
        const data = await api(url, auth);
        total = data.total;
        items.push(...(data.items || data.conversations || []));
        offset += LIMIT;
        if (offset < total) await sleep(delayMs);
      }
      if (items.length > 0) return items;
    } catch (e) {
      if (e.message === 'Cancelled by user') throw e;
      D('listProjectConversations: gizmo endpoint failed, falling back', e.message);
    }
    const sidebar = await api(`/gizmos/snorlax/sidebar?owned_only=true&conversations_per_gizmo=200&limit=50`, auth);
    const match = (sidebar.items || []).find((item) => item.gizmo?.gizmo?.id === gizmoId);
    return match?.conversations || [];
  }

  async function buildTargetList(filters, auth) {
    const isProjectFilter = filters.project && filters.project !== 'all' && filters.project !== 'inbox';
    let all = [];
    if (isProjectFilter) {
      progress('Listing project conversations…', 5);
      const pc = await listProjectConversations(filters.project, auth);
      all.push(...pc.map((c) => ({ ...c, _source: 'active' })));
    } else {
      const hasClientFilters = filters.keyword || filters.dateFrom || filters.dateTo || filters.project === 'inbox';
      const earlyLimit = (!hasClientFilters && filters.limit > 0) ? filters.limit : 0;
      if (filters.source === 'active' || filters.source === 'both') {
        checkAbort();
        progress('Listing active conversations…', 5);
        const active = await listConversations(false, auth, earlyLimit);
        all.push(...active.map((c) => ({ ...c, _source: 'active' })));
      }
      if (filters.source === 'archived' || filters.source === 'both') {
        if (!(earlyLimit > 0 && all.length >= earlyLimit)) {
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
    all = all.filter((c) => (seen.has(c.id) ? false : (seen.add(c.id), true)));
    return filterConversations(all, filters);
  }

  // --- Attachment extraction + fetching ---
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
            files.push({ type: 'image', url: part.asset_pointer, content_type: part.content_type || 'image/png', name: part.metadata?.dalle?.prompt?.slice(0, 50) || 'image' });
          }
          if (part.name && part.download_url) {
            files.push({ type: 'file', url: part.download_url, content_type: part.content_type || 'application/octet-stream', name: part.name });
          }
        }
      }
      const attachments = msg.metadata?.attachments || [];
      for (const att of attachments) {
        if (att.download_url || att.id) {
          files.push({ type: 'attachment', url: att.download_url || null, id: att.id, content_type: att.mimeType || 'application/octet-stream', name: att.name || att.id });
        }
      }
    }
    return files;
  }

  async function fetchAttachmentDetailed(url, auth) {
    try {
      let resolvedUrl = url;
      if (url && url.startsWith('file-service://')) {
        const fileId = url.replace('file-service://', '');
        try {
          const meta = await api(`/files/download/${fileId}?post_id=&inline=false`, auth);
          if (!meta.download_url) return { ok: false, status: 0, reason: 'no-download-url' };
          resolvedUrl = meta.download_url;
        } catch (e) {
          const m = /^(\d{3})\s/.exec(e.message || '');
          return { ok: false, status: m ? parseInt(m[1]) : 0, reason: 'resolve-failed' };
        }
      }
      if (!resolvedUrl) return { ok: false, status: 0, reason: 'no-url' };

      let attempt = 0;
      while (true) {
        attempt++;
        const fetchUrl = resolvedUrl.startsWith('http') ? resolvedUrl : `https://chatgpt.com${resolvedUrl}`;
        const res = await fetch(fetchUrl, { credentials: 'include', headers: { Authorization: `Bearer ${auth.token}` } });
        if (res.status === 429) {
          delayMs = Math.min(delayMs * 2, DELAY_MAX);
          const retryAfter = parseInt(res.headers.get('Retry-After')) || Math.ceil(delayMs / 1000);
          const cooldown = attempt >= 15 ? 300000 : attempt >= 10 ? 120000 : attempt >= 5 ? 60000 : 0;
          const waitMs = Math.max(retryAfter * 1000, delayMs) + cooldown;
          const waitSec = Math.round(waitMs / 1000);
          const waitLabel = waitSec >= 60 ? `${(waitSec / 60).toFixed(1)}min` : `${waitSec}s`;
          progress(`Rate limited on attachment — waiting ${waitLabel}… (attempt ${attempt})`);
          await sleep(waitMs);
          continue;
        }
        if (!res.ok) return { ok: false, status: res.status, reason: 'http-error' };
        if (delayMs > DELAY_INITIAL) delayMs = Math.max(DELAY_INITIAL, Math.round(delayMs * 0.75));
        const blob = await res.blob();
        const dataUrl = await new Promise((resolve) => {
          const reader = new FileReader();
          reader.onloadend = () => resolve(reader.result);
          reader.readAsDataURL(blob);
        });
        return { ok: true, status: res.status, data: dataUrl };
      }
    } catch (e) {
      return { ok: false, status: 0, reason: e.message };
    }
  }

  // Back-compat wrapper
  async function fetchAttachment(url, auth) {
    const r = await fetchAttachmentDetailed(url, auth);
    return r.ok ? r.data : null;
  }

  // --- File helpers ---
  function pad2(n) { return String(n).padStart(2, '0'); }
  function safeExtFromContentType(ct) {
    if (!ct) return '';
    if (ct.includes('png')) return '.png';
    if (ct.includes('webp')) return '.webp';
    if (ct.includes('jpeg') || ct.includes('jpg')) return '.jpg';
    if (ct.includes('gif')) return '.gif';
    if (ct.includes('pdf')) return '.pdf';
    if (ct.includes('svg')) return '.svg';
    if (ct.includes('text/plain')) return '.txt';
    if (ct.includes('json')) return '.json';
    return '';
  }
  function sanitizeName(name) {
    if (!name) return '';
    return String(name).replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').slice(0, 120);
  }
  function sanitizeTag(tag) {
    if (!tag) return '';
    return String(tag).toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
  }
  function base64FromDataUrl(dataUrl) {
    if (!dataUrl || typeof dataUrl !== 'string') return null;
    const i = dataUrl.indexOf(',');
    return i < 0 ? null : dataUrl.slice(i + 1);
  }
  function approxBytesFromB64(b64) {
    if (!b64) return 0;
    const pad = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
    return Math.floor((b64.length * 3) / 4) - pad;
  }

  // --- Source-file staging (file-source path) ---
  async function readSourceJsonFromStorage(config) {
    const srcKey = config.source.sourceKey || ATTACH_SOURCE_KEY_DEFAULT;
    const metaKey = config.source.sourceMetaKey || ATTACH_META_KEY_DEFAULT;
    const result = await chrome.storage.local.get([srcKey, metaKey]);
    const text = result[srcKey];
    if (!text || typeof text !== 'string') {
      throw new Error(`Source JSON not found in chrome.storage.local (key=${srcKey}). Re-select the file.`);
    }
    let parsed;
    try { parsed = JSON.parse(text); }
    catch (e) { throw new Error(`Source JSON parse failed: ${e.message}`); }
    if (!parsed || !Array.isArray(parsed.conversations)) {
      throw new Error('Source JSON missing conversations[] array');
    }
    return { text, parsed, meta: result[metaKey] || {} };
  }

  async function clearStagedSource(config) {
    const srcKey = config.source.sourceKey || ATTACH_SOURCE_KEY_DEFAULT;
    const metaKey = config.source.sourceMetaKey || ATTACH_META_KEY_DEFAULT;
    try { await chrome.storage.local.remove([srcKey, metaKey]); }
    catch (e) { D('clearStagedSource:', e.message); }
  }

  // --- Download primitives (all take a path with optional "folder/" prefix) ---
  function triggerBlobDownload(blob, path) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = path;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
  }
  function triggerTextDownload(text, mime, path) {
    triggerBlobDownload(new Blob([text], { type: mime }), path);
  }
  function triggerJsonDownload(obj, path) {
    triggerTextDownload(JSON.stringify(obj, null, 2), 'application/json', path);
  }

  // --- v4 run folder + tag + hash ---
  function randomHash(n) {
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    let s = '';
    for (let i = 0; i < n; i++) s += chars[Math.floor(Math.random() * chars.length)];
    return s;
  }
  function timestampForFolder() {
    const d = new Date();
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}${pad2(d.getMinutes())}`;
  }
  function deriveTag(config, sourceMeta) {
    if (config.tag) return sanitizeTag(config.tag);
    const kind = config.source.kind;
    if (kind === 'fresh') return 'fresh';
    if (kind === 'byids') return `byids-${(config.source.ids || []).length}`;
    if (kind === 'file') {
      const name = (sourceMeta && sourceMeta.fileName) || config.source.ref || 'file';
      const base = String(name).replace(/\.json$/i, '');
      return `file-${sanitizeTag(base)}`;
    }
    return 'run';
  }
  function runFolderName(config, sourceMeta, partial) {
    const ts = timestampForFolder();
    const hash = randomHash(4);
    const tag = deriveTag(config, sourceMeta) + (partial ? '-partial' : '');
    return `chatgpt-run-${ts}-${hash}-${tag}`;
  }

  // --- Config identity (for resume matching) ---
  function configMatch(a, b) {
    if (!a || !b) return false;
    if (a.source?.kind !== b.source?.kind) return false;
    if (a.source.kind === 'byids') {
      const aIds = (a.source.ids || []).slice().sort();
      const bIds = (b.source.ids || []).slice().sort();
      if (aIds.length !== bIds.length) return false;
      for (let i = 0; i < aIds.length; i++) if (aIds[i] !== bIds[i]) return false;
    }
    if (a.source.kind === 'file') {
      if ((a.source.exportedAt ?? null) !== (b.source.exportedAt ?? null)) return false;
      if ((a.source.sourceKey ?? null) !== (b.source.sourceKey ?? null)) return false;
    }
    if (a.source.kind === 'fresh') {
      const f = a.source.filters || {}, g = b.source.filters || {};
      const keys = ['project', 'source', 'dateFrom', 'dateTo', 'keyword', 'limit'];
      for (const k of keys) if ((f[k] ?? null) !== (g[k] ?? null)) return false;
    }
    if (!!a.fetch?.conversations !== !!b.fetch?.conversations) return false;
    if (!!a.fetch?.attachments !== !!b.fetch?.attachments) return false;
    if ((a.output?.kind ?? null) !== (b.output?.kind ?? null)) return false;
    if ((a.output?.format ?? null) !== (b.output?.format ?? null)) return false;
    return true;
  }

  // --- Plan: convIds + fileTargets + source metadata ---
  async function buildPlan(config, auth, sourceBundle) {
    const kind = config.source.kind;
    if (kind === 'fresh') {
      progress('Building target list from filters…', 5);
      const filtered = await buildTargetList(config.source.filters || {}, auth);
      return {
        convIds: filtered.map((c) => c.id),
        convMeta: Object.fromEntries(filtered.map((c) => [c.id, { title: c.title, _source: c._source }])),
        fileTargets: [],
        sourceConvs: null,
        sourceMeta: null,
      };
    }
    if (kind === 'byids') {
      const ids = (config.source.ids || []).slice();
      return {
        convIds: ids,
        convMeta: Object.fromEntries(ids.map((id) => [id, { title: id.slice(0, 8) }])),
        fileTargets: [],
        sourceConvs: null,
        sourceMeta: null,
      };
    }
    if (kind === 'file') {
      progress('Scanning source JSON for attachments…', 5);
      const convs = sourceBundle.parsed.conversations || [];
      const sourceConvs = {};
      const fileTargets = [];
      for (const conv of convs) {
        const convId = conv && (conv.conversation_id || conv.id);
        if (!convId) continue;
        sourceConvs[convId] = conv;
        const files = extractFileRefs(conv);
        for (let i = 0; i < files.length; i++) {
          fileTargets.push({ convId, fileIndex: i, file: files[i], convTitle: conv.title || '' });
        }
      }
      return {
        convIds: [],
        convMeta: {},
        fileTargets,
        sourceConvs,
        sourceMeta: {
          exportedAt: sourceBundle.parsed.exported_at || null,
          unified: sourceBundle.parsed.unified === true,
          ref: sourceBundle.meta.fileName || null,
          bytes: sourceBundle.meta.bytes || null,
        },
      };
    }
    throw new Error(`Unknown source kind: ${kind}`);
  }

  // --- Strict Source×Fetch validation (matches popup matrix) ---
  function validateConfig(config) {
    const kind = config.source?.kind;
    const wantConv = !!config.fetch?.conversations;
    const wantAtt = !!config.fetch?.attachments;
    if (!['fresh', 'byids', 'file'].includes(kind)) throw new Error(`Invalid source.kind: ${kind}`);
    if (!wantConv && !wantAtt) throw new Error('Select at least one of Conversations / Attachments');
    if (kind === 'file' && wantConv) throw new Error('File source does not re-fetch conversations — select Attachments only');
    if ((kind === 'fresh' || kind === 'byids') && !wantConv && wantAtt) {
      throw new Error('Fresh/ByIds require Fetch=Conversations; attachments are derived from fetched conversations');
    }
    if (kind === 'byids' && (!Array.isArray(config.source.ids) || config.source.ids.length === 0)) {
      throw new Error('ByIds source requires a non-empty ids list');
    }
    if (!config.output?.kind || !['json', 'zip'].includes(config.output.kind)) throw new Error('Invalid output.kind');
  }

  // --- Unified engine ---
  async function runUnified(config) {
    D('========== runUnified START ==========');
    D('config =', JSON.stringify(config, (k, v) => (typeof v === 'string' && v.length > 200 ? v.slice(0, 80) + '…' : v)));
    try {
      validateConfig(config);
      progress('Authenticating…', 0);
      const auth = await getAuth();

      // File source: load staged JSON once
      let sourceBundle = null;
      if (config.source.kind === 'file') {
        progress('Loading source JSON from storage…', 2);
        sourceBundle = await readSourceJsonFromStorage(config);
      }

      // Resume or fresh checkpoint
      let cp = await loadCheckpoint();
      const resumeable = cp && cp.mode === 'unified' && configMatch(cp.config, config);
      if (config._resume && resumeable) {
        cp.paused = false;
        const haveConvs = Object.keys(cp.fetchedConvs || {}).length;
        const haveFiles = Object.keys(cp.fetchedFiles || {}).length;
        progress(`Resuming — ${haveConvs} convs, ${haveFiles} files already fetched`, 12);
        await saveCheckpoint(cp);
      } else {
        const plan = await buildPlan(config, auth, sourceBundle);
        if (plan.convIds.length === 0 && plan.fileTargets.length === 0) {
          await clearCheckpoint();
          if (config.source.kind === 'file') await clearStagedSource(config);
          done('Nothing to fetch — empty plan.');
          return;
        }
        cp = {
          runId: Date.now().toString(),
          mode: 'unified',
          config,
          startedAt: new Date().toISOString(),
          account: auth.accountId,
          convIds: plan.convIds,
          convMeta: plan.convMeta,
          fileTargets: plan.fileTargets,
          sourceConvs: plan.sourceConvs,
          sourceMeta: plan.sourceMeta,
          fetchedConvs: {},
          fetchedFiles: {},
          skipped: [],
          failed: [],
          earlyAttempts: 0,
          earlyFails: 0,
          paused: false,
        };
        await saveCheckpoint(cp);
      }

      // Phase 1: fetch conversations (fresh + byids paths)
      if (config.fetch.conversations && cp.convIds.length > 0) {
        const remaining = cp.convIds.filter((id) => !cp.fetchedConvs[id]);
        for (let i = 0; i < remaining.length; i++) {
          checkAbort();
          const id = remaining[i];
          const doneCount = Object.keys(cp.fetchedConvs).length;
          const pct = 15 + Math.round(((doneCount + 1) / cp.convIds.length) * 60);
          progress(`[${doneCount + 1}/${cp.convIds.length}] ${id.slice(0, 8)}…`, pct);
          try {
            const data = await api(`/conversation/${id}`, auth);
            cp.fetchedConvs[id] = data;

            // Inline attachment fetch per conv if requested
            if (config.fetch.attachments) {
              const files = extractFileRefs(data);
              for (let j = 0; j < files.length; j++) {
                checkAbort();
                const f = files[j];
                const key = `${id}:${j}`;
                if (cp.fetchedFiles[key] || (cp.skipped || []).some((s) => s.key === key)) continue;
                await fetchOneFile(cp, key, { convId: id, fileIndex: j, file: f, convTitle: data.title || '' }, auth);
              }
            }
            if (cp.failed && cp.failed.length) cp.failed = cp.failed.filter((f) => f.id !== id);
          } catch (e) {
            if (e.message === 'Cancelled by user' || e.message === 'Paused by user') throw e;
            cp.failed = cp.failed || [];
            cp.failed = cp.failed.filter((f) => f.id !== id);
            cp.failed.push({ id, title: id.slice(0, 8), error: e.message });
          }
          await saveCheckpoint(cp);
          if (i < remaining.length - 1) await sleep(delayMs);
        }
      }

      // Phase 2: fetch attachments for file-source runs
      if (config.source.kind === 'file' && config.fetch.attachments) {
        const total = cp.fileTargets.length;
        for (let i = 0; i < cp.fileTargets.length; i++) {
          checkAbort();
          const t = cp.fileTargets[i];
          const key = `${t.convId}:${t.fileIndex}`;
          if (cp.fetchedFiles[key] || (cp.skipped || []).some((s) => s.key === key)) continue;
          const doneCount = Object.keys(cp.fetchedFiles).length + (cp.skipped || []).length;
          const pct = 15 + Math.round(((doneCount + 1) / total) * 75);
          progress(`[${doneCount + 1}/${total}] ${t.convId.slice(0, 8)}… ${t.file?.name || ''}`.trim(), pct);
          await fetchOneFile(cp, key, t, auth);
          await saveCheckpoint(cp);
          if (i < cp.fileTargets.length - 1) await sleep(delayMs);
        }
      }

      // Write run folder
      checkAbort();
      progress('Writing run folder…', 92);
      await writeOutput(cp, config, { partial: false });

      await clearCheckpoint();
      if (config.source.kind === 'file') await clearStagedSource(config);

      const convs = Object.keys(cp.fetchedConvs).length + (config.source.kind === 'file' ? Object.keys(cp.sourceConvs || {}).length : 0);
      const files = Object.keys(cp.fetchedFiles).length;
      const skipped = (cp.skipped || []).length;
      const failed = (cp.failed || []).length;
      done(`Done — ${convs} convs, ${files} files${skipped ? `, ${skipped} skipped (404)` : ''}${failed ? `, ${failed} failed` : ''}`);
      D('========== runUnified END ==========');
    } catch (e) {
      if (e.message === 'Paused by user') {
        if (currentCheckpoint) { currentCheckpoint.paused = true; await saveCheckpoint(currentCheckpoint); }
        const cv = currentCheckpoint ? Object.keys(currentCheckpoint.fetchedConvs || {}).length : 0;
        const fi = currentCheckpoint ? Object.keys(currentCheckpoint.fetchedFiles || {}).length : 0;
        const text = `Paused — ${cv} convs, ${fi} files fetched. Open popup to resume or download partial.`;
        running = false;
        setStatus('done', text, 50);
        try { chrome.runtime.sendMessage({ type: 'done', text }); } catch {}
        return;
      }
      D('runUnified: FATAL ERROR:', e.message, e.stack);
      error(e.message);
    }
  }

  // --- One-file fetch with early-abort guard ---
  async function fetchOneFile(cp, key, target, auth) {
    if (!target.file?.url) {
      cp.fetchedFiles[key] = { ...target.file, data: null, _note: 'no-url-in-source' };
      return;
    }
    let result;
    try { result = await fetchAttachmentDetailed(target.file.url, auth); }
    catch (e) {
      if (e.message === 'Cancelled by user' || e.message === 'Paused by user') throw e;
      result = { ok: false, status: 0, reason: e.message };
    }
    if (result.ok) {
      cp.fetchedFiles[key] = { ...target.file, data: result.data };
      cp.earlyAttempts = 0;
      cp.earlyFails = 0;
      return;
    }
    if (result.status === 404) {
      cp.earlyAttempts++;
      cp.earlyFails++;
      if (cp.earlyAttempts > 5 && cp.earlyFails === cp.earlyAttempts) {
        await saveCheckpoint(cp);
        throw new Error(`Aborted: first ${cp.earlyAttempts} attempts all returned 404. Session expired or URL format changed — re-login to chatgpt.com and retry.`);
      }
      cp.skipped = cp.skipped || [];
      cp.skipped.push({ key, convId: target.convId, name: target.file?.name || null, url: target.file?.url, status: 404 });
    } else {
      cp.earlyAttempts++;
      cp.failed = cp.failed || [];
      cp.failed.push({ key, convId: target.convId, name: target.file?.name || null, url: target.file?.url, status: result.status, reason: result.reason });
    }
  }

  // --- Build the conversations payload in legacy v3.x schema ---
  function buildConversationsDoc(cp, config, auth) {
    // Conversations come from fetchedConvs (fresh/byids) or sourceConvs (file)
    const src = config.source.kind === 'file' ? (cp.sourceConvs || {}) : cp.fetchedConvs;
    const conversations = Object.values(src);
    // Attachments map per v3.x schema: { [convId]: [{...file, data}, ...] }
    const attachmentsMap = {};
    for (const [key, f] of Object.entries(cp.fetchedFiles || {})) {
      const [convId] = key.split(':');
      attachmentsMap[convId] = attachmentsMap[convId] || [];
      attachmentsMap[convId].push(f);
    }
    return {
      exported_at: new Date().toISOString(),
      account: auth?.accountId || cp.account || 'unknown',
      source: { kind: config.source.kind },
      filters: config.source.kind === 'fresh' ? (config.source.filters || {}) : null,
      stats: {
        conversations: conversations.length,
        attachments: Object.keys(cp.fetchedFiles || {}).length,
        skipped_404: (cp.skipped || []).length,
        failed: (cp.failed || []).length,
      },
      errors: cp.failed || [],
      conversations,
      ...(Object.keys(attachmentsMap).length > 0 ? { attachments: attachmentsMap } : {}),
    };
  }

  // --- Run manifest (lean handoff schema v1) ---
  function buildRunManifest(cp, config, folderName, filesList, partial) {
    return {
      manifest_version: MANIFEST_VERSION,
      run_id: cp.runId,
      generated_at: new Date().toISOString(),
      folder: folderName,
      tag: deriveTag(config, cp.sourceMeta),
      source: {
        kind: config.source.kind,
        ref: cp.sourceMeta?.ref || (config.source.kind === 'byids' ? `ids-${(config.source.ids || []).length}` : null),
        exported_at: cp.sourceMeta?.exportedAt || null,
        unified: cp.sourceMeta?.unified === true,
      },
      fetch: {
        conversations: !!config.fetch.conversations,
        attachments: !!config.fetch.attachments,
      },
      output: {
        kind: config.output.kind,
        format: config.output.format || 'json',
      },
      stats: {
        convs: (config.source.kind === 'file' ? Object.keys(cp.sourceConvs || {}).length : Object.keys(cp.fetchedConvs || {}).length),
        attachments: Object.keys(cp.fetchedFiles || {}).length,
        skipped_404: (cp.skipped || []).length,
        failed: (cp.failed || []).length,
        ...(partial ? { partial: true } : {}),
      },
      files: filesList,
      attachments_index_ref: filesList.includes('attachments-index.json') ? 'attachments-index.json' : null,
    };
  }

  // --- Write run folder ---
  async function writeOutput(cp, config, { partial }) {
    const folder = runFolderName(config, cp.sourceMeta, partial);
    const fmt = (config.output.format || 'json').toLowerCase();
    const hasAtt = Object.keys(cp.fetchedFiles || {}).length > 0;
    const filesList = [];

    const auth = { accountId: cp.account };
    const doc = buildConversationsDoc(cp, config, auth);
    if (partial) doc.stats.partial = true;

    if (config.output.kind === 'json') {
      // Single-document output. Attachments inline when format=json; otherwise sidecar attachments.json.
      if (fmt === 'json') {
        triggerJsonDownload(doc, `${folder}/conversations.json`);
        filesList.push('conversations.json');
      } else {
        // Converter formats drop the attachments map — emit it as a sidecar.
        const formats = {
          markdown: { ext: 'md', mime: 'text/markdown', fn: () => toMarkdown(doc) },
          jsonl:    { ext: 'jsonl', mime: 'application/x-jsonlines', fn: () => toJSONL(doc) },
          html:     { ext: 'html', mime: 'text/html', fn: () => toHTML(doc) },
          csv:      { ext: 'csv', mime: 'text/csv', fn: () => toCSV(doc) },
          txt:      { ext: 'txt', mime: 'text/plain', fn: () => toPlainText(doc) },
        };
        const f = formats[fmt];
        if (!f) throw new Error(`Unknown format: ${fmt}`);
        triggerTextDownload(f.fn(), f.mime, `${folder}/conversations.${f.ext}`);
        filesList.push(`conversations.${f.ext}`);
        if (hasAtt) {
          // Legacy-shape map for downstream agents
          const attMap = doc.attachments || {};
          triggerJsonDownload({ exported_at: doc.exported_at, attachments: attMap }, `${folder}/attachments.json`);
          filesList.push('attachments.json');
        }
      }
    } else if (config.output.kind === 'zip') {
      // Loose conversations.json + attachments-index.json + volumed binaries
      // Emit conversations.json with the legacy schema but WITHOUT the inline attachments map
      // (binaries live in the zip volumes; the index points to them).
      const convsOnly = { ...doc };
      delete convsOnly.attachments;
      triggerJsonDownload(convsOnly, `${folder}/conversations.json`);
      filesList.push('conversations.json');

      if (hasAtt) {
        if (typeof JSZip === 'undefined') {
          throw new Error('JSZip not loaded — the extension must include vendor/jszip.min.js in content_scripts');
        }
        const index = {
          source_exported_at: cp.sourceMeta?.exportedAt || null,
          generated_at: new Date().toISOString(),
          stats: {
            plan: (config.source.kind === 'file' ? (cp.fileTargets || []).length : Object.keys(cp.fetchedFiles).length + (cp.skipped || []).length + (cp.failed || []).length),
            fetched: Object.keys(cp.fetchedFiles).length,
            skipped_404: (cp.skipped || []).length,
            failed: (cp.failed || []).length,
          },
          volume_target_bytes: VOLUME_TARGET_BYTES,
          attachments: {},
          skipped_404: cp.skipped || [],
          failed: cp.failed || [],
        };

        // Iterate all files, pack into volumes, track each in index
        let currentZip = new JSZip();
        let currentBytes = 0;
        let currentCount = 0;
        let volNum = 1;
        const volumeFileNames = [];

        async function flushVolume() {
          if (currentCount === 0) return;
          const volName = `attachments-vol${pad2(volNum)}.zip`;
          progress(`Packing ${volName} (${currentCount} files, ~${(currentBytes/1024/1024).toFixed(1)} MB)…`, 92 + Math.min(volNum, 5));
          const blob = await currentZip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 1 } });
          triggerBlobDownload(blob, `${folder}/${volName}`);
          volumeFileNames.push(volName);
          volNum++;
          currentZip = new JSZip();
          currentBytes = 0;
          currentCount = 0;
        }

        // Deterministic ordering: iterate fileTargets (file source) or flatten fetchedFiles keys (conv source)
        const ordered = (config.source.kind === 'file' && cp.fileTargets?.length)
          ? cp.fileTargets.map((t) => ({ key: `${t.convId}:${t.fileIndex}`, convId: t.convId, fileIndex: t.fileIndex, convTitle: t.convTitle }))
          : Object.keys(cp.fetchedFiles).map((key) => {
              const [convId, idxStr] = key.split(':');
              return { key, convId, fileIndex: parseInt(idxStr, 10), convTitle: cp.convMeta?.[convId]?.title || '' };
            });

        for (const row of ordered) {
          checkAbort();
          const got = cp.fetchedFiles[row.key];
          if (!got || !got.data) continue;
          const b64 = base64FromDataUrl(got.data);
          if (!b64) continue;
          const bytes = approxBytesFromB64(b64);
          const ext = safeExtFromContentType(got.content_type) || '';
          const safeName = sanitizeName(got.name) || `attachment-${row.fileIndex}`;
          const baseFileName = safeName.includes('.') ? safeName : `${safeName}${ext}`;
          const pathInZip = `attachments/${row.convId}/part${row.fileIndex}-${baseFileName}`;
          currentZip.file(pathInZip, b64, { base64: true });
          currentBytes += bytes;
          currentCount++;
          const indexKey = got.url || row.key;
          index.attachments[indexKey] = {
            path: pathInZip,
            volume: `vol${pad2(volNum)}`,
            convId: row.convId,
            convTitle: row.convTitle || '',
            name: got.name || null,
            content_type: got.content_type || null,
            bytes,
          };
          if (currentBytes >= VOLUME_TARGET_BYTES) await flushVolume();
        }
        await flushVolume();
        index.stats.volumes = volumeFileNames;
        triggerJsonDownload(index, `${folder}/attachments-index.json`);
        filesList.push('attachments-index.json', ...volumeFileNames);
      }
    } else {
      throw new Error(`Unknown output.kind: ${config.output.kind}`);
    }

    // Run manifest always last so downstream agents can poll for it
    const manifest = buildRunManifest(cp, config, folder, ['run-manifest.json', ...filesList], partial);
    triggerJsonDownload(manifest, `${folder}/run-manifest.json`);

    // Append to run_history (lean summary)
    await appendRunHistory({
      runId: cp.runId,
      completed_at: manifest.generated_at,
      tag: manifest.tag,
      source: { kind: config.source.kind },
      fetch: manifest.fetch,
      output: manifest.output,
      stats: manifest.stats,
      files: manifest.files,
    });
  }

  async function appendRunHistory(entry) {
    try {
      const r = await chrome.storage.local.get(RUN_HISTORY_KEY);
      const arr = Array.isArray(r[RUN_HISTORY_KEY]) ? r[RUN_HISTORY_KEY] : [];
      arr.push(entry);
      while (arr.length > RUN_HISTORY_MAX) arr.shift();
      await chrome.storage.local.set({ [RUN_HISTORY_KEY]: arr });
    } catch (e) { D('appendRunHistory:', e.message); }
  }

  // --- Partial download (user-invoked while paused/running) ---
  async function runDownloadPartial() {
    try {
      const cp = await loadCheckpoint();
      if (!cp || cp.mode !== 'unified') {
        error('No unified run checkpoint available to download.');
        return;
      }
      progress('Writing partial run folder…', 50);
      await writeOutput(cp, cp.config, { partial: true });
      const cv = Object.keys(cp.fetchedConvs || {}).length;
      const fi = Object.keys(cp.fetchedFiles || {}).length;
      done(`Partial: ${cv} convs, ${fi} files written (checkpoint preserved)`);
    } catch (e) {
      error(e.message);
    }
  }

  // --- Memories (preserved) ---
  async function runExportMemories(options) {
    D('========== runExportMemories START ==========');
    try {
      progress('Authenticating…', 0);
      const auth = await getAuth();
      const didCookie = document.cookie.split(';').map((c) => c.trim()).find((c) => c.startsWith('oai-did='));
      const deviceId = didCookie ? didCookie.split('=')[1] : null;

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
      if (!res.ok) {
        const body = await res.text();
        D('runExportMemories: error body =', body.slice(0, 500));
        throw new Error(`${res.status} ${res.statusText} — /backend-api/memories`);
      }
      const data = await res.json();

      let memories = [];
      if (Array.isArray(data.memories)) memories = data.memories;
      else if (Array.isArray(data.memory_entries)) memories = data.memory_entries;
      else if (data.memory_tool_config?.memory_entries) memories = data.memory_tool_config.memory_entries;

      progress(`Found ${memories.length} memories`, 60);
      if (memories.length === 0) { done('No memories found.'); return; }

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
      triggerTextDownload(fn(), mime, `chatgpt-memories-${datestamp}.${ext}`);
      done(`Exported ${memories.length} memories as ${ext.toUpperCase()}`);
    } catch (e) {
      D('runExportMemories: FATAL ERROR:', e.message, e.stack);
      error(e.message);
    }
  }

  // --- Message router ---
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    D('MESSAGE RECEIVED:', msg.action);

    if (msg.action === 'get-status') {
      sendResponse({ running, lastStatus });
      return;
    }

    if (msg.action === 'get-checkpoint') {
      loadCheckpoint().then((cp) => {
        if (!cp) { sendResponse({ hasCheckpoint: false }); return; }
        const isLegacy = cp.mode !== 'unified';
        const convs = Object.keys(cp.fetchedConvs || cp.fetched || {}).length;
        const files = Object.keys(cp.fetchedFiles || {}).length;
        const total = (cp.convIds?.length || 0) + (cp.fileTargets?.length || 0) || (cp.targetIds?.length || 0);
        sendResponse({
          hasCheckpoint: true,
          checkpoint: {
            runId: cp.runId,
            mode: cp.mode,
            isLegacy,
            startedAt: cp.startedAt,
            lastUpdate: cp.lastUpdate,
            paused: cp.paused,
            total,
            convs,
            files,
            failed: (cp.failed || []).length,
            config: cp.config || null,
          },
        });
      });
      return true;
    }

    if (msg.action === 'clear-checkpoint') {
      // Also wipe any staged v3.x source keys (legacy-discard path)
      Promise.all([
        clearCheckpoint(),
        chrome.storage.local.remove([ATTACH_SOURCE_KEY_DEFAULT, ATTACH_META_KEY_DEFAULT]).catch(() => {}),
      ]).then(() => sendResponse({ ok: true }));
      return true;
    }

    if (msg.action === 'download-partial') {
      if (running) { sendResponse({ ok: false, reason: 'Cannot download partial while a run is active — pause first' }); return; }
      runDownloadPartial();
      sendResponse({ ok: true });
      return;
    }

    if (msg.action === 'abort') {
      abortRequested = true;
      clearCheckpoint();
      sendResponse({ ok: true });
      return;
    }

    if (msg.action === 'pause') {
      pauseRequested = true;
      sendResponse({ ok: true });
      return;
    }

    if (msg.action === 'list-projects') {
      listProjects()
        .then((projects) => sendResponse({ projects }))
        .catch((e) => { D('list-projects error:', e.message); sendResponse({ projects: [] }); });
      return true;
    }

    if (msg.action === 'run-unified') {
      if (running) { sendResponse({ ok: false, reason: 'Run already in progress' }); return; }
      running = true;
      abortRequested = false;
      pauseRequested = false;
      delayMs = DELAY_INITIAL;
      runUnified(msg.config);
      sendResponse({ ok: true });
      return;
    }

    if (msg.action === 'exportMemories') {
      if (running) { sendResponse({ ok: false, reason: 'Run already in progress' }); return; }
      running = true;
      abortRequested = false;
      pauseRequested = false;
      delayMs = DELAY_INITIAL;
      runExportMemories(msg.options);
      sendResponse({ ok: true });
      return;
    }
  });
}
