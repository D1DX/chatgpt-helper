const $ = (id) => document.getElementById(id);

function log(text) {
  const container = $('log-container');
  const el = $('log');
  container.style.display = 'block';
  const ts = new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  el.textContent += `[${ts}] ${text}\n`;
  container.scrollTop = container.scrollHeight;
}

$('export-btn').addEventListener('click', async () => {
  const btn = $('export-btn');
  btn.disabled = true;
  btn.textContent = 'Exporting…';
  $('progress').textContent = 'Starting…';
  $('progress').className = '';
  $('progress-bar-container').style.display = 'block';
  $('progress-bar').style.width = '0%';
  $('log').textContent = '';
  log('Export started');

  const options = {
    source: $('source').value,
    dateFrom: $('date-from').value || null,
    dateTo: $('date-to').value || null,
    keyword: $('keyword').value.trim() || null,
    limit: parseInt($('limit').value) || 0,
    attachments: $('attachments').checked,
    format: $('format').value,
  };

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.url?.startsWith('https://chatgpt.com')) {
      throw new Error('Open chatgpt.com first');
    }

    // Inject scripts (handles case where page was loaded before extension install)
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['converters.js', 'content.js'],
    });

    // Small delay to let the script register its listener
    await new Promise((r) => setTimeout(r, 100));

    chrome.tabs.sendMessage(tab.id, { action: 'export', options }, (response) => {
      if (chrome.runtime.lastError) {
        $('progress').textContent = 'Failed to connect. Refresh chatgpt.com and retry.';
        $('progress').className = 'error';
        btn.disabled = false;
        btn.textContent = 'Export';
      }
    });
  } catch (e) {
    $('progress').textContent = e.message;
    $('progress').className = 'error';
    btn.disabled = false;
    btn.textContent = 'Export';
  }
});

// Listen for progress updates from content script
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
    $('export-btn').disabled = false;
    $('export-btn').textContent = 'Export';
  } else if (msg.type === 'error') {
    $('progress').textContent = msg.text;
    $('progress').className = 'error';
    log('ERROR: ' + msg.text);
    $('export-btn').disabled = false;
    $('export-btn').textContent = 'Export';
  }
});
