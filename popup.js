const $ = (id) => document.getElementById(id);

$('export-btn').addEventListener('click', async () => {
  const btn = $('export-btn');
  btn.disabled = true;
  btn.textContent = 'Exporting…';
  $('progress').textContent = 'Starting…';
  $('progress').className = '';
  $('progress-bar-container').style.display = 'block';
  $('progress-bar').style.width = '0%';

  const options = {
    source: $('source').value,
    dateFrom: $('date-from').value || null,
    dateTo: $('date-to').value || null,
    keyword: $('keyword').value.trim() || null,
    limit: parseInt($('limit').value) || 0,
    attachments: $('attachments').checked,
  };

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.url?.startsWith('https://chatgpt.com')) {
      throw new Error('Open chatgpt.com first');
    }

    chrome.tabs.sendMessage(tab.id, { action: 'export', options });
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
    if (msg.percent !== undefined) {
      $('progress-bar').style.width = msg.percent + '%';
    }
  } else if (msg.type === 'done') {
    $('progress').textContent = msg.text;
    $('progress-bar').style.width = '100%';
    $('export-btn').disabled = false;
    $('export-btn').textContent = 'Export';
  } else if (msg.type === 'error') {
    $('progress').textContent = msg.text;
    $('progress').className = 'error';
    $('export-btn').disabled = false;
    $('export-btn').textContent = 'Export';
  }
});
