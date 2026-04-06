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

  $('export-filters').classList.toggle('hidden', isMemories);
  $('memories-options').classList.toggle('hidden', !isMemories);
  $('export-btn').classList.toggle('hidden', isMemories);
  $('memories-btn').classList.toggle('hidden', !isMemories);

  if (!isMemories) {
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
const ACTION_BTNS = ['export-btn', 'memories-btn'];

function setRunningUI(isRunning) {
  ACTION_BTNS.forEach((id) => { $(id).disabled = isRunning; });
  $('cancel-btn').classList.toggle('hidden', !isRunning);
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
async function sendAction(action) {
  const options = action === 'exportMemories'
    ? { format: $('memories-format').value }
    : getOptions();

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

$('export-btn').addEventListener('click', () => sendAction('export'));
$('memories-btn').addEventListener('click', () => sendAction('exportMemories'));

// --- Cancel ---
$('cancel-btn').addEventListener('click', async () => {
  try {
    const tab = await injectAndGetTab();
    if (tab) {
      chrome.tabs.sendMessage(tab.id, { action: 'abort' });
    }
  } catch {}
  $('cancel-btn').classList.add('hidden');
  log('Cancel requested');
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
  } else if (msg.type === 'error') {
    $('progress').textContent = msg.text;
    $('progress').className = 'error';
    log('ERROR: ' + msg.text);
    setRunningUI(false);
  }
});

// Init
updateUI();
