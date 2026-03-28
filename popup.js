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
  // Source field: hide for unarchive (always archived), show for others
  $('source-field').classList.toggle('hidden', currentTab === 'unarchive');
  if (currentTab === 'unarchive') $('source').value = 'archived';
  if (currentTab === 'archive') $('source').value = 'active';

  // Project: only show when source is strictly "active"
  const showProject = $('source').value === 'active' && currentTab !== 'unarchive';
  $('project-field').classList.toggle('hidden', !showProject);
  if (sourceIsArchived) $('project').value = 'all';

  // Export-only options
  $('export-options').classList.toggle('hidden', currentTab !== 'export');

  // Buttons
  $('export-btn').classList.toggle('hidden', currentTab !== 'export');
  $('archive-btn').classList.toggle('hidden', currentTab !== 'archive');
  $('unarchive-btn').classList.toggle('hidden', currentTab !== 'unarchive');

  // Attachments only for JSON
  updateAttachmentsVisibility();
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

// --- Load projects on popup open ---
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
    source: currentTab === 'unarchive' ? 'archived' : currentTab === 'archive' ? 'active' : $('source').value,
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
  const options = getOptions();
  const btns = ['export-btn', 'archive-btn', 'unarchive-btn'];
  btns.forEach((id) => { $(id).disabled = true; });
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
        btns.forEach((id) => { $(id).disabled = false; });
      }
    });
  } catch (e) {
    $('progress').textContent = e.message;
    $('progress').className = 'error';
    btns.forEach((id) => { $(id).disabled = false; });
  }
}

$('export-btn').addEventListener('click', () => sendAction('export'));
$('archive-btn').addEventListener('click', () => sendAction('archive'));
$('unarchive-btn').addEventListener('click', () => sendAction('unarchive'));

// --- Listen for progress updates ---
chrome.runtime.onMessage.addListener((msg) => {
  const btns = ['export-btn', 'archive-btn', 'unarchive-btn'];
  if (msg.type === 'progress') {
    $('progress').textContent = msg.text;
    log(msg.text);
    if (msg.percent !== undefined) {
      $('progress-bar').style.width = msg.percent + '%';
    }
  } else if (msg.type === 'confirm') {
    // Archive/unarchive confirmation
    const ok = confirm(msg.text);
    chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
      chrome.tabs.sendMessage(tab.id, { action: 'confirm-response', confirmed: ok });
    });
    if (!ok) {
      $('progress').textContent = 'Cancelled.';
      log('Cancelled by user');
      btns.forEach((id) => { $(id).disabled = false; });
    }
  } else if (msg.type === 'done') {
    $('progress').textContent = msg.text;
    $('progress-bar').style.width = '100%';
    log(msg.text);
    btns.forEach((id) => { $(id).disabled = false; });
  } else if (msg.type === 'error') {
    $('progress').textContent = msg.text;
    $('progress').className = 'error';
    log('ERROR: ' + msg.text);
    btns.forEach((id) => { $(id).disabled = false; });
  }
});

// Init
updateUI();
