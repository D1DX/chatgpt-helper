// ChatGPT Helper — popup (v4)
// One form, one Run button. Source × Fetch × Output matrix validated inline.
// ui_last_config persisted + restored. Legacy v3.x checkpoints surface as a
// non-resumable Discard banner.

const $ = (id) => document.getElementById(id);

const UI_LAST_CONFIG_KEY = 'ui_last_config';
const RUN_HISTORY_KEY = 'run_history';
const ATTACH_SOURCE_KEY = 'attach_source_v1';
const ATTACH_META_KEY = 'attach_source_meta_v1';

function log(text) {
  const container = $('log-container');
  const el = $('log');
  container.style.display = 'block';
  const ts = new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  el.textContent += `[${ts}] ${text}\n`;
  container.scrollTop = container.scrollHeight;
}

// --- Tab switching ---
let currentTab = 'conversations';
document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
    tab.classList.add('active');
    currentTab = tab.dataset.tab;
    $('conversations-tab').classList.toggle('hidden', currentTab !== 'conversations');
    $('memories-tab').classList.toggle('hidden', currentTab !== 'memories');
  });
});

// --- Source radio switching ---
function currentSourceKind() {
  const el = document.querySelector('input[name="source-kind"]:checked');
  return el ? el.value : 'fresh';
}
document.querySelectorAll('input[name="source-kind"]').forEach((r) => {
  r.addEventListener('change', () => {
    const kind = currentSourceKind();
    $('fresh-panel').classList.toggle('hidden', kind !== 'fresh');
    $('byids-panel').classList.toggle('hidden', kind !== 'byids');
    $('file-panel').classList.toggle('hidden', kind !== 'file');
    // File source is Attachments-only by strict matrix
    if (kind === 'file') {
      $('fetch-conv').checked = false;
      $('fetch-att').checked = true;
    } else if (kind === 'fresh' || kind === 'byids') {
      if (!$('fetch-conv').checked && !$('fetch-att').checked) $('fetch-conv').checked = true;
    }
    updateMatrixHint();
  });
});

// --- Output kind + format visibility ---
function currentOutputKind() {
  const el = document.querySelector('input[name="output-kind"]:checked');
  return el ? el.value : 'json';
}
document.querySelectorAll('input[name="output-kind"]').forEach((r) => {
  r.addEventListener('change', () => {
    $('format-field').classList.toggle('hidden', currentOutputKind() !== 'json');
    updateMatrixHint();
  });
});

$('fetch-conv').addEventListener('change', updateMatrixHint);
$('fetch-att').addEventListener('change', updateMatrixHint);

$('source').addEventListener('change', () => {
  const archived = $('source').value === 'archived';
  $('project-field').classList.toggle('hidden', archived);
});
$('export-all').addEventListener('change', () => {
  $('limit-field').classList.toggle('hidden', $('export-all').checked);
});

// --- Strict Source×Fetch validation (mirrors content.js validateConfig) ---
function validateMatrix() {
  const kind = currentSourceKind();
  const wantConv = $('fetch-conv').checked;
  const wantAtt = $('fetch-att').checked;
  if (!wantConv && !wantAtt) return 'Select at least one of Conversations / Attachments';
  if (kind === 'file' && wantConv) return 'File source does not re-fetch conversations — select Attachments only';
  if ((kind === 'fresh' || kind === 'byids') && !wantConv && wantAtt) {
    return 'Fresh/ByIds require Conversations (attachments are extracted from fetched convs)';
  }
  if (kind === 'byids') {
    const ids = parseByIdsText($('byids-text').value);
    if (ids.length === 0) return 'Paste at least one conversation ID';
  }
  if (kind === 'file') {
    const f = $('file-input').files[0];
    if (!f) return 'Pick a source JSON file';
    if (!filePickValid) return 'Picked file is not a valid ChatGPT export (missing conversations[])';
  }
  return null;
}
function updateMatrixHint() {
  const err = validateMatrix();
  $('matrix-hint').textContent = err || '';
  $('run-btn').disabled = !!err || isRunning;
}

// --- ByIds parsing (newline-separated, # comments, UUID-ish) ---
const UUID_TEST = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function parseByIdsText(text) {
  if (!text) return [];
  const ids = [];
  const seen = new Set();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    if (!UUID_TEST.test(line)) continue;
    const norm = line.toLowerCase();
    if (seen.has(norm)) continue;
    seen.add(norm);
    ids.push(norm);
  }
  return ids;
}
$('byids-text').addEventListener('input', () => {
  const ids = parseByIdsText($('byids-text').value);
  $('byids-count').textContent = `${ids.length} IDs parsed`;
  updateMatrixHint();
});

// --- File pick + validation (header parse before staging) ---
let filePickValid = false;
let filePickMeta = null;
function readFileAsText(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error || new Error('file read failed'));
    r.readAsText(file);
  });
}
$('file-input').addEventListener('change', async () => {
  filePickValid = false;
  filePickMeta = null;
  const f = $('file-input').files[0];
  const info = $('file-info');
  if (!f) { info.textContent = 'Select a previously exported chatgpt-export-*.json'; updateMatrixHint(); return; }
  const sizeMB = (f.size / 1024 / 1024).toFixed(1);
  info.textContent = `${f.name} — ${sizeMB} MB · validating…`;
  try {
    const text = await readFileAsText(f);
    const parsed = JSON.parse(text);
    if (!parsed || !Array.isArray(parsed.conversations)) throw new Error('missing conversations[]');
    filePickValid = true;
    filePickMeta = {
      exportedAt: parsed.exported_at || null,
      unified: parsed.unified === true,
      fileName: f.name,
      bytes: f.size,
      convCount: parsed.conversations.length,
      _text: text,
    };
    info.textContent = `${f.name} — ${sizeMB} MB · ${parsed.conversations.length} conversations${parsed.unified ? ' · unified' : ''}`;
  } catch (e) {
    info.textContent = `${f.name} — invalid: ${e.message}`;
  }
  updateMatrixHint();
});

// --- UI state: running vs idle ---
let isRunning = false;
const ACTION_BTNS = ['run-btn', 'memories-btn', 'cp-resume-btn', 'cp-download-btn', 'cp-discard-btn', 'legacy-discard-btn'];
function setRunningUI(running) {
  isRunning = running;
  ACTION_BTNS.forEach((id) => { const el = $(id); if (el) el.disabled = running; });
  $('cancel-btn').classList.toggle('hidden', !running);
  $('pause-btn').classList.toggle('hidden', !running);
  if (!running) updateMatrixHint(); // re-enable run-btn based on matrix
}

function applyStatus(status) {
  if (!status) return;
  $('progress').textContent = status.text || '';
  $('progress').className = status.type === 'error' ? 'error' : '';
  $('progress-bar-container').style.display = 'block';
  if (status.percent !== undefined) $('progress-bar').style.width = status.percent + '%';
  log(status.text);
}

// --- Tab injection ---
async function injectAndGetTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.url?.startsWith('https://chatgpt.com')) return null;
  await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    files: ['vendor/jszip.min.js', 'converters.js', 'content.js'],
  });
  await new Promise((r) => setTimeout(r, 100));
  return tab;
}

// --- Checkpoint banner (unified + legacy) ---
let currentCheckpoint = null;
const LEGACY_MODES = new Set(['list', 'retry', 'attachments-only']);

function renderCheckpointBanner(cp) {
  currentCheckpoint = cp;
  const unified = $('checkpoint-banner');
  const legacy = $('legacy-banner');
  unified.classList.remove('active');
  legacy.classList.remove('active');
  if (!cp) return;
  if (cp.mode === 'unified') {
    unified.classList.add('active');
    const when = cp.lastUpdate ? new Date(cp.lastUpdate).toLocaleString() : '';
    const label = cp.paused ? 'Paused run' : 'Checkpoint found';
    $('cp-title').textContent = label;
    $('cp-summary').innerHTML =
      `<strong>${cp.convs}</strong> convs, <strong>${cp.files}</strong> files fetched` +
      (cp.failed ? ` · ${cp.failed} failed` : '') +
      `<br>Last update: ${when}`;
  } else if (LEGACY_MODES.has(cp.mode)) {
    legacy.classList.add('active');
    $('legacy-summary').innerHTML =
      `Found a v3.x checkpoint (mode: <code>${cp.mode}</code>). v4 cannot resume legacy runs — discard to continue.`;
  }
}

async function refreshCheckpointBanner(tab) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tab.id, { action: 'get-checkpoint' }, (response) => {
      if (chrome.runtime.lastError || !response) { renderCheckpointBanner(null); resolve(null); return; }
      renderCheckpointBanner(response.hasCheckpoint ? response.checkpoint : null);
      resolve(response.hasCheckpoint ? response.checkpoint : null);
    });
  });
}

// --- ui_last_config persistence ---
async function restoreLastConfig() {
  try {
    const r = await chrome.storage.local.get(UI_LAST_CONFIG_KEY);
    const cfg = r[UI_LAST_CONFIG_KEY];
    if (!cfg) return;
    // Source kind
    const kindInput = document.querySelector(`input[name="source-kind"][value="${cfg.source?.kind}"]`);
    if (kindInput) { kindInput.checked = true; kindInput.dispatchEvent(new Event('change')); }
    // Fresh filters
    if (cfg.source?.kind === 'fresh' && cfg.source.filters) {
      const f = cfg.source.filters;
      if (f.source) $('source').value = f.source;
      if (f.project) $('project').value = f.project;
      if (f.dateFrom) $('date-from').value = f.dateFrom;
      if (f.dateTo) $('date-to').value = f.dateTo;
      if (f.keyword) $('keyword').value = f.keyword;
      $('export-all').checked = !(f.limit > 0);
      $('limit-field').classList.toggle('hidden', $('export-all').checked);
      if (f.limit > 0) $('limit').value = f.limit;
    }
    // ByIds text
    if (cfg.source?.kind === 'byids' && Array.isArray(cfg.source.ids)) {
      $('byids-text').value = cfg.source.ids.join('\n');
      $('byids-count').textContent = `${cfg.source.ids.length} IDs parsed`;
    }
    // Fetch flags (strict matrix enforced)
    if (cfg.fetch) {
      $('fetch-conv').checked = !!cfg.fetch.conversations;
      $('fetch-att').checked = !!cfg.fetch.attachments;
    }
    // Output kind
    const okInput = document.querySelector(`input[name="output-kind"][value="${cfg.output?.kind}"]`);
    if (okInput) { okInput.checked = true; okInput.dispatchEvent(new Event('change')); }
    if (cfg.output?.format) $('format').value = cfg.output.format;
    if (cfg.tag) $('tag').value = cfg.tag;
  } catch (e) { log('restore config failed: ' + e.message); }
}

async function persistLastConfig(cfg) {
  try {
    // Strip _text from file source before persisting
    const clean = JSON.parse(JSON.stringify(cfg, (k, v) => (k === '_text' ? undefined : v)));
    await chrome.storage.local.set({ [UI_LAST_CONFIG_KEY]: clean });
  } catch (e) { log('persist config failed: ' + e.message); }
}

// --- Build config from form ---
function buildConfig() {
  const kind = currentSourceKind();
  const cfg = {
    source: { kind },
    fetch: { conversations: $('fetch-conv').checked, attachments: $('fetch-att').checked },
    output: { kind: currentOutputKind(), format: $('format').value || 'json' },
    tag: $('tag').value.trim() || null,
  };
  if (kind === 'fresh') {
    cfg.source.filters = {
      project: $('project').value,
      source: $('source').value,
      dateFrom: $('date-from').value || null,
      dateTo: $('date-to').value || null,
      keyword: $('keyword').value.trim() || null,
      limit: $('export-all').checked ? 0 : (parseInt($('limit').value) || 0),
    };
  } else if (kind === 'byids') {
    cfg.source.ids = parseByIdsText($('byids-text').value);
  } else if (kind === 'file') {
    cfg.source.sourceKey = ATTACH_SOURCE_KEY;
    cfg.source.sourceMetaKey = ATTACH_META_KEY;
    cfg.source.exportedAt = filePickMeta?.exportedAt || null;
    cfg.source.ref = filePickMeta?.fileName || null;
  }
  return cfg;
}

// --- Stage file to chrome.storage.local (only for file source) ---
async function stageFileIfNeeded(kind) {
  if (kind !== 'file') return true;
  if (!filePickMeta || !filePickMeta._text) { log('No validated file to stage'); return false; }
  await chrome.storage.local.set({
    [ATTACH_SOURCE_KEY]: filePickMeta._text,
    [ATTACH_META_KEY]: {
      exportedAt: filePickMeta.exportedAt,
      fileName: filePickMeta.fileName,
      bytes: filePickMeta.bytes,
      unified: filePickMeta.unified,
      stagedAt: new Date().toISOString(),
    },
  });
  log(`Staged ${(filePickMeta.bytes / 1024 / 1024).toFixed(1)} MB to chrome.storage.local`);
  return true;
}

// --- Send run-unified action ---
async function runNow(configOverride) {
  const cfg = configOverride || buildConfig();
  const err = configOverride ? null : validateMatrix();
  if (err) { log('Blocked: ' + err); return; }

  setRunningUI(true);
  $('progress').textContent = 'Starting…';
  $('progress').className = '';
  $('progress-bar-container').style.display = 'block';
  $('progress-bar').style.width = '0%';
  $('log').textContent = '';
  log('run-unified started');

  try {
    const tab = await injectAndGetTab();
    if (!tab) throw new Error('Open chatgpt.com first');

    if (!cfg._resume) {
      const ok = await stageFileIfNeeded(cfg.source.kind);
      if (!ok) { $('progress').textContent = 'Could not stage source file'; $('progress').className = 'error'; setRunningUI(false); return; }
      await persistLastConfig(cfg);
    }

    chrome.tabs.sendMessage(tab.id, { action: 'run-unified', config: cfg }, (response) => {
      if (chrome.runtime.lastError) {
        $('progress').textContent = 'Failed to connect. Refresh chatgpt.com and retry.';
        $('progress').className = 'error';
        setRunningUI(false);
        return;
      }
      if (response && !response.ok && response.reason) {
        $('progress').textContent = response.reason;
        $('progress').className = 'error';
        log(response.reason);
        setRunningUI(false);
      }
    });
  } catch (e) {
    $('progress').textContent = e.message;
    $('progress').className = 'error';
    setRunningUI(false);
  }
}

// --- Run button: handle existing checkpoint collision ---
$('run-btn').addEventListener('click', async () => {
  const err = validateMatrix();
  if (err) { $('progress').textContent = err; $('progress').className = 'error'; return; }

  const tab = await injectAndGetTab();
  if (!tab) { runNow(); return; }
  const cp = await refreshCheckpointBanner(tab);
  if (cp) {
    const what = cp.mode === 'unified' ? `${cp.convs}/${cp.total || '?'} fetched` : `legacy (mode=${cp.mode})`;
    const msg = `A previous checkpoint exists — ${what}.\n\nOK = discard it and start a new run.\nCancel = use the Resume/Discard buttons in the banner instead.`;
    if (!confirm(msg)) return;
    chrome.tabs.sendMessage(tab.id, { action: 'clear-checkpoint' }, () => {
      renderCheckpointBanner(null);
      runNow();
    });
    return;
  }
  runNow();
});

// --- Memories button ---
$('memories-btn').addEventListener('click', async () => {
  setRunningUI(true);
  $('progress').textContent = 'Starting memories export…';
  $('progress').className = '';
  $('log').textContent = '';
  try {
    const tab = await injectAndGetTab();
    if (!tab) throw new Error('Open chatgpt.com first');
    chrome.tabs.sendMessage(tab.id, { action: 'exportMemories', options: { format: $('memories-format').value } }, (response) => {
      if (chrome.runtime.lastError) {
        $('progress').textContent = 'Failed to connect. Refresh chatgpt.com and retry.';
        $('progress').className = 'error';
        setRunningUI(false);
        return;
      }
      if (response && !response.ok && response.reason) {
        $('progress').textContent = response.reason;
        $('progress').className = 'error';
        setRunningUI(false);
      }
    });
  } catch (e) {
    $('progress').textContent = e.message;
    $('progress').className = 'error';
    setRunningUI(false);
  }
});

// --- Pause / Cancel ---
$('pause-btn').addEventListener('click', async () => {
  try {
    const tab = await injectAndGetTab();
    if (tab) chrome.tabs.sendMessage(tab.id, { action: 'pause' });
  } catch {}
  log('Pause requested — checkpoint will be preserved');
});
$('cancel-btn').addEventListener('click', async () => {
  if (!confirm('Cancel and discard all progress? Use Pause to keep progress instead.')) return;
  try {
    const tab = await injectAndGetTab();
    if (tab) chrome.tabs.sendMessage(tab.id, { action: 'abort' });
  } catch {}
  $('cancel-btn').classList.add('hidden');
  $('pause-btn').classList.add('hidden');
  renderCheckpointBanner(null);
  log('Cancel requested — progress discarded');
});

// --- Unified checkpoint banner actions ---
$('cp-resume-btn').addEventListener('click', async () => {
  if (!currentCheckpoint || !currentCheckpoint.config) return;
  runNow({ ...currentCheckpoint.config, _resume: true });
});
$('cp-download-btn').addEventListener('click', async () => {
  try {
    const tab = await injectAndGetTab();
    if (!tab) return;
    chrome.tabs.sendMessage(tab.id, { action: 'download-partial' }, (response) => {
      if (response && !response.ok) {
        $('progress').textContent = response.reason || 'Download failed';
        $('progress').className = 'error';
      }
    });
  } catch (e) { log('Download partial failed: ' + e.message); }
});
$('cp-discard-btn').addEventListener('click', async () => {
  if (!confirm('Discard the checkpoint? This cannot be undone.')) return;
  try {
    const tab = await injectAndGetTab();
    if (!tab) return;
    chrome.tabs.sendMessage(tab.id, { action: 'clear-checkpoint' }, () => {
      renderCheckpointBanner(null);
      log('Checkpoint discarded');
    });
  } catch (e) { log('Discard failed: ' + e.message); }
});

// --- Legacy checkpoint banner actions ---
$('legacy-discard-btn').addEventListener('click', async () => {
  if (!confirm('Discard the legacy v3.x checkpoint and any staged source JSON?')) return;
  try {
    const tab = await injectAndGetTab();
    if (!tab) return;
    chrome.tabs.sendMessage(tab.id, { action: 'clear-checkpoint' }, () => {
      renderCheckpointBanner(null);
      log('Legacy checkpoint + staged source discarded');
    });
  } catch (e) { log('Legacy discard failed: ' + e.message); }
});

// --- Progress messages from content.js ---
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'progress') {
    $('progress').textContent = msg.text;
    log(msg.text);
    if (msg.percent !== undefined) $('progress-bar').style.width = msg.percent + '%';
  } else if (msg.type === 'done') {
    $('progress').textContent = msg.text;
    $('progress-bar').style.width = '100%';
    log(msg.text);
    setRunningUI(false);
    injectAndGetTab().then((tab) => tab && refreshCheckpointBanner(tab)).catch(() => {});
  } else if (msg.type === 'error') {
    $('progress').textContent = msg.text;
    $('progress').className = 'error';
    log('ERROR: ' + msg.text);
    setRunningUI(false);
    injectAndGetTab().then((tab) => tab && refreshCheckpointBanner(tab)).catch(() => {});
  }
});

// --- Boot ---
(async () => {
  try {
    await restoreLastConfig();
    updateMatrixHint();

    const tab = await injectAndGetTab();
    if (!tab) { $('project-loading').textContent = 'Open chatgpt.com to load projects'; return; }

    chrome.tabs.sendMessage(tab.id, { action: 'get-status' }, (response) => {
      if (chrome.runtime.lastError || !response) return;
      if (response.running) {
        setRunningUI(true);
        if (response.lastStatus) applyStatus(response.lastStatus);
        log('Reconnected to running export');
      } else if (response.lastStatus) {
        applyStatus(response.lastStatus);
      }
    });

    await refreshCheckpointBanner(tab);

    chrome.tabs.sendMessage(tab.id, { action: 'list-projects' }, (response) => {
      const el = $('project');
      const loading = $('project-loading');
      if (chrome.runtime.lastError || !response?.projects) {
        loading.textContent = 'Could not load projects';
        return;
      }
      for (const p of response.projects) {
        const opt = document.createElement('option');
        opt.value = p.id;
        opt.textContent = p.name;
        el.appendChild(opt);
      }
      loading.style.display = 'none';
    });
  } catch {
    $('project-loading').textContent = 'Could not load projects';
  }
})();
