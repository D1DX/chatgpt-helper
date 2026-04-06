// Format converters — transform raw conversation data into export formats.

// Extract the linear message list from a conversation's mapping tree.
function extractMessages(conversation) {
  const mapping = conversation.mapping || {};
  const messages = [];

  // Walk the tree from current_node backwards to build the path
  let nodeId = conversation.current_node;
  const chain = [];
  while (nodeId && mapping[nodeId]) {
    chain.unshift(mapping[nodeId]);
    nodeId = mapping[nodeId].parent;
  }

  for (const node of chain) {
    const msg = node.message;
    if (!msg || !msg.content) continue;
    const role = msg.author?.role;
    if (!role || role === 'system') continue;

    const parts = msg.content.parts || [];
    const text = parts
      .filter((p) => typeof p === 'string')
      .join('\n')
      .trim();
    if (!text) continue;

    messages.push({
      role,
      content: text,
      timestamp: msg.create_time || null,
      model: msg.metadata?.model_slug || null,
    });
  }
  return messages;
}

function toMarkdown(exportData) {
  const lines = [];
  lines.push(`# ChatGPT Export`);
  lines.push(`> Exported: ${exportData.exported_at}`);
  lines.push(`> Conversations: ${exportData.stats.fetched}`);
  lines.push('');

  for (const conv of exportData.conversations) {
    const title = conv.title || 'Untitled';
    const created = conv.create_time
      ? new Date(typeof conv.create_time === 'number' ? conv.create_time * 1000 : conv.create_time).toISOString().slice(0, 10)
      : '';
    lines.push(`---`);
    lines.push('');
    lines.push(`## ${title}`);
    if (created) lines.push(`*${created}*`);
    lines.push('');

    const messages = extractMessages(conv);
    for (const msg of messages) {
      const label = msg.role === 'user' ? '**User**' : '**Assistant**';
      lines.push(`${label}:`);
      lines.push('');
      lines.push(msg.content);
      lines.push('');
    }
  }
  return lines.join('\n');
}

function toJSONL(exportData) {
  const lines = [];
  for (const conv of exportData.conversations) {
    const messages = extractMessages(conv);
    for (const msg of messages) {
      lines.push(JSON.stringify({
        conversation_id: conv.conversation_id || conv.id,
        conversation_title: conv.title || null,
        role: msg.role,
        content: msg.content,
        timestamp: msg.timestamp,
        model: msg.model,
      }));
    }
  }
  return lines.join('\n');
}

function toPlainText(exportData) {
  const lines = [];
  for (const conv of exportData.conversations) {
    const title = conv.title || 'Untitled';
    lines.push(`=== ${title} ===`);
    lines.push('');

    const messages = extractMessages(conv);
    for (const msg of messages) {
      const label = msg.role === 'user' ? 'User' : 'Assistant';
      lines.push(`${label}:`);
      lines.push(msg.content);
      lines.push('');
    }
    lines.push('');
  }
  return lines.join('\n');
}

function toCSV(exportData) {
  const escape = (s) => {
    if (!s) return '';
    if (s.includes('"') || s.includes(',') || s.includes('\n')) {
      return '"' + s.replace(/"/g, '""') + '"';
    }
    return s;
  };

  const rows = ['conversation_id,title,timestamp,role,model,content'];
  for (const conv of exportData.conversations) {
    const id = conv.conversation_id || conv.id || '';
    const title = conv.title || '';
    const messages = extractMessages(conv);
    for (const msg of messages) {
      const ts = msg.timestamp
        ? new Date(msg.timestamp * 1000).toISOString()
        : '';
      rows.push(
        [id, escape(title), ts, msg.role, msg.model || '', escape(msg.content)].join(',')
      );
    }
  }
  return rows.join('\n');
}

function memoriesToMarkdown(exportData) {
  const lines = [];
  lines.push(`# ChatGPT Memories`);
  lines.push(`> Exported: ${exportData.exported_at}`);
  lines.push(`> Count: ${exportData.count}`);
  lines.push('');

  exportData.memories.forEach((entry, i) => {
    // Handle various possible field names for the text content
    const text = entry.text || entry.content || entry.memory || (typeof entry === 'string' ? entry : JSON.stringify(entry));
    const id = entry.id || entry.memory_id || null;
    const created = entry.created_at || entry.create_time || entry.created || null;
    const updated = entry.updated_at || entry.update_time || entry.updated || null;

    const dateStr = created
      ? new Date(typeof created === 'number' ? created * 1000 : created).toISOString().slice(0, 10)
      : null;

    lines.push(`${i + 1}. ${text}`);
    const meta = [dateStr, id ? `id: ${id}` : null].filter(Boolean).join(' · ');
    if (meta) lines.push(`   *${meta}*`);
    lines.push('');
  });

  return lines.join('\n');
}

function memoriesToText(exportData) {
  const lines = [];
  lines.push(`ChatGPT Memories — exported ${exportData.exported_at.slice(0, 10)}`);
  lines.push(`Total: ${exportData.count}`);
  lines.push('');

  exportData.memories.forEach((entry, i) => {
    const text = entry.text || entry.content || entry.memory || (typeof entry === 'string' ? entry : JSON.stringify(entry));
    lines.push(`${i + 1}. ${text}`);
  });

  return lines.join('\n');
}

function toHTML(exportData) {
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  let html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>ChatGPT Export — ${exportData.exported_at.slice(0, 10)}</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: Inter, -apple-system, sans-serif; background: #f5f7fa; color: #333; padding: 24px; max-width: 800px; margin: 0 auto; }
  h1 { font-size: 20px; color: #005490; margin-bottom: 4px; }
  .meta { font-size: 12px; color: #888; margin-bottom: 24px; }
  .conversation { background: #fff; border-radius: 8px; padding: 20px; margin-bottom: 16px; border: 1px solid #e0e0e0; }
  .conv-title { font-size: 16px; font-weight: 600; color: #005490; margin-bottom: 4px; }
  .conv-date { font-size: 11px; color: #999; margin-bottom: 12px; }
  .message { margin-bottom: 12px; padding: 10px 12px; border-radius: 6px; }
  .message.user { background: #e8f0fe; }
  .message.assistant { background: #f0f0f0; }
  .role { font-size: 11px; font-weight: 600; text-transform: uppercase; color: #666; margin-bottom: 4px; }
  .content { font-size: 14px; line-height: 1.6; white-space: pre-wrap; word-wrap: break-word; }
  .content code { background: #e8e8e8; padding: 1px 4px; border-radius: 3px; font-size: 13px; }
  .content pre { background: #1e1e1e; color: #d4d4d4; padding: 12px; border-radius: 4px; overflow-x: auto; margin: 8px 0; }
  .content pre code { background: none; padding: 0; color: inherit; }
  .footer { text-align: center; font-size: 11px; color: #999; margin-top: 24px; }
  .footer a { color: #005490; text-decoration: none; }
</style>
</head>
<body>
<h1>ChatGPT Export</h1>
<div class="meta">${exportData.stats.fetched} conversations &middot; ${exportData.exported_at.slice(0, 10)}</div>
`;

  for (const conv of exportData.conversations) {
    const title = esc(conv.title || 'Untitled');
    const created = conv.create_time
      ? new Date(typeof conv.create_time === 'number' ? conv.create_time * 1000 : conv.create_time).toISOString().slice(0, 10)
      : '';

    html += `<div class="conversation">\n<div class="conv-title">${title}</div>\n`;
    if (created) html += `<div class="conv-date">${created}</div>\n`;

    const messages = extractMessages(conv);
    for (const msg of messages) {
      const roleLabel = msg.role === 'user' ? 'You' : 'ChatGPT';
      // Basic markdown-to-html for code blocks
      let content = esc(msg.content);
      // Code blocks
      content = content.replace(/```(\w*)\n([\s\S]*?)```/g, '<pre><code>$2</code></pre>');
      // Inline code
      content = content.replace(/`([^`]+)`/g, '<code>$1</code>');
      html += `<div class="message ${msg.role}"><div class="role">${roleLabel}</div><div class="content">${content}</div></div>\n`;
    }
    html += `</div>\n`;
  }

  html += `<div class="footer">Exported with <a href="https://github.com/d1dx/chatgpt-export">ChatGPT Export</a> by D1DX</div>\n`;
  html += `</body></html>`;
  return html;
}
