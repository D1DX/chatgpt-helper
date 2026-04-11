const $ = (id) => document.getElementById(id);

function log(text) {
  const container = $('log-container');
  const el = $('log');
  container.style.display = 'block';
  const ts = new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  el.textContent += `[${ts}] ${text}\n`;
  container.scrollTop = container.scrollHeight;
}

// --- Tab switching ---
let currentTab = 'export';

document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
    tab.classList.add('active');
    currentTab = tab.dataset.tab;
    updateUI();
  });
});

function updateUI() {
  const isMemories = currentTab === 'memories';
  const isRetry = currentTab === 'retry';
  const isExport = currentTab === 'export';

  $('export-filters').classList.toggle('hidden', !isExport);
  $('retry-panel').classList.toggle('hidden', !isRetry);
  $('memories-options').classList.toggle('hidden', !isMemories);
  $('export-btn').classList.toggle('hidden', !isExport);
  $('retry-btn').classList.toggle('hidden', !isRetry);
  $('memories-btn').classList.toggle('hidden', !isMemories);

  if (isExport) {
    const sourceArchived = $('source').value === 'archived';
    $('project-field').classList.toggle('hidden', sourceArchived);
    updateAttachmentsVisibility();
  }
}

$('source').addEventListener('change', updateUI);

function updateAttachmentsVisibility() {
  $('attachments-field').classList.toggle('hidden', $('format').value !== 'json');
}

$('format').addEventListener('change', updateAttachmentsVisibility);

// --- Export all toggle ---
$('export-all').addEventListener('change', () => {
  $('limit-field').classList.toggle('hidden', $('export-all').checked);
});

// --- UI state for running/idle ---
const ACTION_BTNS = ['export-btn', 'retry-btn', 'memories-btn', 'cp-resume-btn', 'cp-download-btn', 'cp-discard-btn'];

function setRunningUI(isRunning) {
  ACTION_BTNS.forEach((id) => {
    const el = $(id);
    if (el) el.disabled = isRunning;
  });
  $('cancel-btn').classList.toggle('hidden', !isRunning);
  $('pause-btn').classList.toggle('hidden', !isRunning);
}

function applyStatus(status) {
  if (!status) return;
  $('progress').textContent = status.text || '';
  $('progress').className = status.type === 'error' ? 'error' : '';
  $('progress-bar-container').style.display = 'block';
  if (status.percent !== undefined) {
    $('progress-bar').style.width = status.percent + '%';
  }
  log(status.text);
}

// --- Load projects + check running status on popup open ---
async function injectAndGetTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.url?.startsWith('https://chatgpt.com')) return null;

  await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    files: ['converters.js', 'content.js'],
  });
  await new Promise((r) => setTimeout(r, 100));
  return tab;
}

// --- Checkpoint banner ---
let currentCheckpoint = null; // cached from get-checkpoint

function renderCheckpointBanner(cp) {
  currentCheckpoint = cp;
  const banner = $('checkpoint-banner');
  if (!cp) {
    banner.classList.remove('active');
    return;
  }
  banner.classList.add('active');
  const modeLabel = cp.mode === 'retry' ? 'Retry-by-ID run' : 'Export run';
  $('cp-title').textContent = `${modeLabel}${cp.paused ? ' (paused)' : ''}`;
  const when = cp.lastUpdate ? new Date(cp.lastUpdate).toLocaleString() : '';
  $('cp-summary').innerHTML =
    `<strong>${cp.fetched}</strong>/${cp.total} fetched` +
    (cp.failed ? ` · ${cp.failed} failed` : '') +
    `<br>Last update: ${when}`;
}

async function refreshCheckpointBanner(tab) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tab.id, { action: 'get-checkpoint' }, (response) => {
      if (chrome.runtime.lastError || !response) {
        renderCheckpointBanner(null);
        resolve(null);
        return;
      }
      renderCheckpointBanner(response.hasCheckpoint ? response.checkpoint : null);
      resolve(response.hasCheckpoint ? response.checkpoint : null);
    });
  });
}

(async () => {
  try {
    const tab = await injectAndGetTab();
    if (!tab) {
      $('project-loading').textContent = 'Open chatgpt.com to load projects';
      return;
    }

    // Check if an export is already running
    chrome.tabs.sendMessage(tab.id, { action: 'get-status' }, (response) => {
      if (chrome.runtime.lastError || !response) return;
      if (response.running) {
        setRunningUI(true);
        if (response.lastStatus) applyStatus(response.lastStatus);
        log('Reconnected to running export');
      } else if (response.lastStatus) {
        // Show last result from a completed run
        applyStatus(response.lastStatus);
      }
    });

    // Check for existing checkpoint
    await refreshCheckpointBanner(tab);

    // Load projects
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

// --- Gather current filter options ---
function getOptions() {
  return {
    project: $('project').value,
    source: $('source').value,
    dateFrom: $('date-from').value || null,
    dateTo: $('date-to').value || null,
    keyword: $('keyword').value.trim() || null,
    limit: $('export-all').checked ? 0 : (parseInt($('limit').value) || 0),
    attachments: $('attachments').checked && $('format').value === 'json',
    format: $('format').value,
  };
}

// --- Send action to content script ---
async function sendAction(action, optionsOverride) {
  let options;
  if (optionsOverride) {
    options = optionsOverride;
  } else if (action === 'exportMemories') {
    options = { format: $('memories-format').value };
  } else {
    options = getOptions();
  }

  setRunningUI(true);
  $('progress').textContent = 'Starting…';
  $('progress').className = '';
  $('progress-bar-container').style.display = 'block';
  $('progress-bar').style.width = '0%';
  $('log').textContent = '';
  log(`${action} started`);

  try {
    const tab = await injectAndGetTab();
    if (!tab) throw new Error('Open chatgpt.com first');

    chrome.tabs.sendMessage(tab.id, { action, options }, (response) => {
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

// --- Retry-by-ID parsing ---
// Non-global for .test(), global for .match() — keep separate to avoid lastIndex bugs
const UUID_TEST = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UUID_FIND = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

function parseRetryIds(text) {
  if (!text) return [];
  const trimmed = text.trim();
  // Try JSON array first
  if (trimmed.startsWith('[')) {
    try {
      const arr = JSON.parse(trimmed);
      if (Array.isArray(arr)) {
        const ids = arr
          .map((x) => (typeof x === 'string' ? x : x && x.id))
          .filter((x) => typeof x === 'string' && UUID_TEST.test(x))
          .map((s) => s.toLowerCase());
        return [...new Set(ids)];
      }
    } catch {}
  }
  // Fallback: extract UUIDs from any text (lines, commas, whitespace)
  const matches = trimmed.match(UUID_FIND) || [];
  return [...new Set(matches.map((s) => s.toLowerCase()))];
}

$('retry-ids').addEventListener('input', () => {
  const ids = parseRetryIds($('retry-ids').value);
  $('retry-ids-count').textContent = `${ids.length} IDs parsed`;
});

$('export-btn').addEventListener('click', async () => {
  // Re-read live checkpoint from storage — cached value may be stale after pause/done
  const tab = await injectAndGetTab();
  if (!tab) { sendAction('export'); return; }
  const cp = await refreshCheckpointBanner(tab);
  if (cp) {
    const msg = `A previous run has ${cp.fetched}/${cp.total} fetched.\n\n` +
      `OK = discard it and start fresh.\nCancel = use the Resume button in the banner instead.`;
    if (!confirm(msg)) return;
    chrome.tabs.sendMessage(tab.id, { action: 'clear-checkpoint' }, () => {
      if (chrome.runtime.lastError) {
        $('progress').textContent = 'Failed to clear checkpoint';
        $('progress').className = 'error';
        return;
      }
      renderCheckpointBanner(null);
      sendAction('export');
    });
    return;
  }
  sendAction('export');
});
$('memories-btn').addEventListener('click', () => sendAction('exportMemories'));

$('retry-btn').addEventListener('click', async () => {
  const ids = parseRetryIds($('retry-ids').value);
  if (ids.length === 0) {
    $('progress').textContent = 'No valid conversation IDs found.';
    $('progress').className = 'error';
    return;
  }
  const options = {
    _retryIds: ids,
    format: $('retry-format').value,
    attachments: $('retry-attachments').checked && $('retry-format').value === 'json',
  };
  const tab = await injectAndGetTab();
  if (!tab) { sendAction('export', options); return; }
  const cp = await refreshCheckpointBanner(tab);
  if (cp) {
    const msg = `A previous run has ${cp.fetched}/${cp.total} fetched.\n\n` +
      `OK = discard it and start this retry run.\nCancel = keep previous checkpoint.`;
    if (!confirm(msg)) return;
    chrome.tabs.sendMessage(tab.id, { action: 'clear-checkpoint' }, () => {
      if (chrome.runtime.lastError) {
        $('progress').textContent = 'Failed to clear checkpoint';
        $('progress').className = 'error';
        return;
      }
      renderCheckpointBanner(null);
      sendAction('export', options);
    });
    return;
  }
  sendAction('export', options);
});

// --- Pause (keep checkpoint) ---
$('pause-btn').addEventListener('click', async () => {
  try {
    const tab = await injectAndGetTab();
    if (tab) chrome.tabs.sendMessage(tab.id, { action: 'pause' });
  } catch {}
  log('Pause requested — checkpoint will be preserved');
});

// --- Cancel (discard checkpoint) ---
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

// --- Checkpoint banner actions ---
$('cp-resume-btn').addEventListener('click', async () => {
  if (!currentCheckpoint) return;
  // Resume uses the SAME options from the checkpoint + _resume flag
  const opts = { ...currentCheckpoint.options, _resume: true };
  sendAction('export', opts);
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
  } catch (e) {
    log('Download partial failed: ' + e.message);
  }
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
  } catch (e) {
    log('Discard failed: ' + e.message);
  }
});

// --- Listen for progress updates ---
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'progress') {
    $('progress').textContent = msg.text;
    log(msg.text);
    if (msg.percent !== undefined) {
      $('progress-bar').style.width = msg.percent + '%';
    }
  } else if (msg.type === 'done') {
    $('progress').textContent = msg.text;
    $('progress-bar').style.width = '100%';
    log(msg.text);
    setRunningUI(false);
    // Refresh banner — checkpoint is cleared on success
    injectAndGetTab().then((tab) => tab && refreshCheckpointBanner(tab)).catch(() => {});
  } else if (msg.type === 'error') {
    $('progress').textContent = msg.text;
    $('progress').className = 'error';
    log('ERROR: ' + msg.text);
    setRunningUI(false);
    // Refresh banner — may now reflect pause state or preserved checkpoint
    injectAndGetTab().then((tab) => tab && refreshCheckpointBanner(tab)).catch(() => {});
  }
});

// Init
updateUI();
