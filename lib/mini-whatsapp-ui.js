// @ts-check
'use strict';

/**
 * Self-contained HTML page for the Mini-WhatsApp local test sandbox.
 * All user/message strings render with DOM textContent to prevent script injection.
 */
function renderMiniWhatsAppHtml() {
  return `<!DOCTYPE html>
<html lang="zh-HK">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Mini WhatsApp Sandbox (wa-bridge)</title>
<style>
  :root {
    --bg: #0b141a;
    --panel: #111b21;
    --panel-alt: #202c33;
    --border: #2a3942;
    --text: #e9edef;
    --muted: #8696a0;
    --green: #00a884;
    --in-bubble: #202c33;
    --user-bubble: #005c4b;
    --bot-bubble: #182b3a;
    --danger: #f15c6d;
    --warn: #f59e0b;
    --info: #38bdf8;
    --mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    --sans: system-ui, -apple-system, "Segoe UI", Roboto, "PingFang HK", "Microsoft JhengHei", sans-serif;
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; height: 100%; background: var(--bg); color: var(--text); font-family: var(--sans); font-size: 14px; }
  .app { display: grid; grid-template-columns: 310px 1fr 340px; height: 100vh; overflow: hidden; }
  .col { display: flex; flex-direction: column; min-height: 0; border-right: 1px solid var(--border); background: var(--panel); }
  .col:last-child { border-right: none; }
  .hdr { padding: 10px 12px; background: var(--panel-alt); border-bottom: 1px solid var(--border); display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-wrap: wrap; }
  .title { font-weight: 700; font-size: 14px; }
  .sub { font-size: 12px; color: var(--muted); font-family: var(--mono); word-break: break-all; }
  .pill { display: inline-block; padding: 2px 7px; border-radius: 999px; font-size: 11px; font-weight: 600; background: #2a3942; color: var(--text); }
  .pill.ok { background: #144d37; color: #7ef2c2; }
  .pill.warn { background: #4b340a; color: #fcd34d; }
  .pill.bad { background: #541d26; color: #fda4af; }
  .pill.info { background: #0f364d; color: #7dd3fc; }
  .scroll { flex: 1; overflow-y: auto; min-height: 0; }
  .controls { padding: 8px 10px; border-bottom: 1px solid var(--border); display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
  button, select, input, textarea { font-family: inherit; font-size: 12px; color: var(--text); background: var(--panel-alt); border: 1px solid var(--border); border-radius: 6px; padding: 5px 8px; }
  button { cursor: pointer; }
  button:hover { border-color: var(--green); }
  button.primary { background: var(--green); color: #052019; font-weight: 700; border-color: var(--green); }
  button.danger { border-color: var(--danger); color: #fda4af; }
  .chat-item { padding: 10px 12px; border-bottom: 1px solid #1c2830; cursor: pointer; display: flex; flex-direction: column; gap: 4px; }
  .chat-item:hover { background: #182329; }
  .chat-item.active { background: #2a3942; }
  .chat-row { display: flex; justify-content: space-between; align-items: center; gap: 6px; }
  .chat-name { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .chat-badges { display: flex; gap: 4px; flex-wrap: wrap; }
  .msg-list { flex: 1; overflow-y: auto; padding: 14px; display: flex; flex-direction: column; gap: 10px; background: var(--bg); }
  .msg { max-width: 78%; padding: 8px 11px; border-radius: 9px; border: 1px solid var(--border); display: flex; flex-direction: column; gap: 5px; }
  .msg.inbound { align-self: flex-start; background: var(--in-bubble); }
  .msg.user { align-self: flex-end; background: var(--user-bubble); }
  .msg.bot { align-self: flex-end; background: var(--bot-bubble); border-color: #244b66; }
  .msg-meta { font-size: 11px; color: var(--muted); display: flex; justify-content: space-between; gap: 8px; align-items: center; }
  .msg-body { white-space: pre-wrap; word-break: break-word; line-height: 1.4; }
  .poll-opts { display: flex; flex-direction: column; gap: 6px; margin-top: 4px; }
  .poll-btn { text-align: left; padding: 7px 10px; background: #13222d; border: 1px solid #2b4a61; }
  .poll-btn.selected { background: #144d37; border-color: var(--green); color: #b7fce0; font-weight: 600; }
  .composer { padding: 10px 12px; background: var(--panel-alt); border-top: 1px solid var(--border); display: flex; flex-direction: column; gap: 8px; }
  .composer-row { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
  textarea { width: 100%; min-height: 56px; resize: vertical; }
  .log-item { padding: 7px 10px; border-bottom: 1px solid #1b272f; font-family: var(--mono); font-size: 11px; white-space: pre-wrap; word-break: break-all; }
  .section-title { padding: 6px 10px; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em; color: var(--muted); background: #172229; border-bottom: 1px solid var(--border); }
  .tabs { display: flex; gap: 4px; }
  .tab.active { background: var(--green); color: #052019; font-weight: 700; border-color: var(--green); }
  label { font-size: 12px; color: var(--muted); display: inline-flex; align-items: center; gap: 4px; }
  @media (max-width: 1020px) { .app { grid-template-columns: 240px 1fr; } .col-right { display: none; } }
</style>
</head>
<body>
<div class="app">
  <div class="col">
    <div class="hdr">
      <div>
        <div class="title">Mini WhatsApp Sandbox</div>
        <div class="sub" id="bridgeMeta">loading...</div>
      </div>
      <span class="pill" id="sseBadge">SSE: 0</span>
    </div>
    <div class="controls">
      <label><input type="checkbox" id="chkSynced" /> contactsSynced</label>
      <label><input type="checkbox" id="chkFailContact" /> contact 503</label>
      <button id="btnEmitReady">Emit ready</button>
      <button id="btnReset" class="danger">Reset</button>
    </div>
    <div class="controls" id="addContactForm">
      <input id="newContactId" placeholder="85261119999 or 123@lid" style="width: 145px;" />
      <input id="newContactName" placeholder="名稱" style="width: 85px;" />
      <label><input type="checkbox" id="newContactSaved" /> 已儲存</label>
      <button id="btnAddContact">+ 聯絡人</button>
    </div>
    <div class="section-title">對話清單</div>
    <div class="scroll" id="chatList"></div>
  </div>

  <div class="col">
    <div class="hdr">
      <div>
        <div class="title" id="activeChatTitle">-</div>
        <div class="sub" id="activeChatMeta">-</div>
      </div>
      <div class="controls" style="border:none;padding:0;">
        <button id="btnToggleSaved">切換已儲存</button>
        <button id="btnUnarchive">模擬用戶解除封存</button>
        <button id="btnArchive">模擬用戶封存</button>
      </div>
    </div>
    <div class="msg-list" id="msgList"></div>
    <div class="composer">
      <div class="composer-row">
        <select id="presetSelect" style="flex:1;min-width:160px;"></select>
        <button id="btnApplyPreset">載入範例並傳送</button>
      </div>
      <textarea id="msgInput" placeholder="輸入訊息（Ctrl+Enter 以對方身分發送）..."></textarea>
      <div class="composer-row">
        <button class="primary" id="btnSendInbound">以對方身分發送 (message)</button>
        <button id="btnSendUser">以自己身分回覆 (user: / message_create)</button>
        <label><input type="checkbox" id="chkForwarded" /> Forwarded</label>
      </div>
    </div>
  </div>

  <div class="col col-right">
    <div class="hdr">
      <div class="tabs">
        <button class="tab active" id="tabActions">Bridge API 記錄</button>
        <button class="tab" id="tabBotLogs">Bot 日誌</button>
      </div>
      <span class="pill" id="botBadge">bot: external</span>
    </div>
    <div class="scroll" id="rightLog"></div>
  </div>
</div>

<script>
(() => {
  let state = null;
  let activeChatId = '85261110001@c.us';
  let rightTab = 'actions';
  let botLogs = [];

  async function api(path, body) {
    const res = await fetch(path, body === undefined ? undefined : {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status));
    return data;
  }

  function pill(text, cls) {
    const s = document.createElement('span');
    s.className = 'pill' + (cls ? ' ' + cls : '');
    s.textContent = text;
    return s;
  }

  function contactById(id) {
    return (state && state.contacts || []).find((c) => c.id === id) || null;
  }

  function mappedPhoneId(id) {
    return (state && state.lidMappings && state.lidMappings[id]) || '';
  }

  function effectiveContact(id) {
    const ct = contactById(id);
    const pn = mappedPhoneId(id);
    const mapped = pn ? contactById(pn) : null;
    if (!mapped) return ct;
    return {
      ...(ct || { id }),
      isMyContact: Boolean((ct && ct.isMyContact) || mapped.isMyContact),
      name: (ct && ct.name) || mapped.name || '',
      blocked: Boolean((ct && ct.blocked) || mapped.blocked),
    };
  }

  function chatById(id) {
    return (state && state.chats || []).find((c) => c.id === id) || null;
  }

  function render() {
    if (!state) return;
    document.getElementById('bridgeMeta').textContent = state.baseUrl + '  |  token: ' + state.token.slice(0, 8) + '...';
    const sseBadge = document.getElementById('sseBadge');
    sseBadge.textContent = 'SSE: ' + state.sseClientsCount;
    sseBadge.className = 'pill ' + (state.sseClientsCount > 0 ? 'ok' : 'warn');

    document.getElementById('chkSynced').checked = Boolean(state.health.contactsSynced);
    document.getElementById('chkFailContact').checked = Boolean(state.contactLookupFailing);

    const presetSel = document.getElementById('presetSelect');
    if (presetSel.options.length === 0 && Array.isArray(state.presets)) {
      for (const p of state.presets) {
        const opt = document.createElement('option');
        opt.value = p.id;
        opt.textContent = p.label;
        presetSel.appendChild(opt);
      }
    }

    const chatList = document.getElementById('chatList');
    chatList.textContent = '';
    for (const chat of state.chats) {
      const div = document.createElement('div');
      div.className = 'chat-item' + (chat.id === activeChatId ? ' active' : '');
      div.onclick = () => { activeChatId = chat.id; render(); };
      const row = document.createElement('div');
      row.className = 'chat-row';
      const name = document.createElement('div');
      name.className = 'chat-name';
      const ct = effectiveContact(chat.id);
      name.textContent = (ct && (ct.name || ct.pushname)) || chat.title || chat.id;
      const cnt = (state.timelines[chat.id] || []).length;
      row.appendChild(name);
      row.appendChild(pill(String(cnt), 'info'));
      div.appendChild(row);

      const sub = document.createElement('div');
      sub.className = 'sub';
      sub.textContent = chat.id;
      div.appendChild(sub);

      const badges = document.createElement('div');
      badges.className = 'chat-badges';
      if (ct && ct.isMyContact) badges.appendChild(pill('已儲存', 'ok'));
      if (ct && ct.blocked) badges.appendChild(pill('已封鎖', 'bad'));
      if (chat.archived) badges.appendChild(pill('已封存', 'warn'));
      if (chat.muted) badges.appendChild(pill('靜音', 'warn'));
      if (state.lidMappings[chat.id]) badges.appendChild(pill('PN: ' + state.lidMappings[chat.id].split('@')[0], 'info'));
      if (badges.childNodes.length) div.appendChild(badges);
      chatList.appendChild(div);
    }

    const activeChat = chatById(activeChatId) || state.chats[0];
    if (activeChat) activeChatId = activeChat.id;
    const activeCt = effectiveContact(activeChatId);
    document.getElementById('activeChatTitle').textContent = (activeCt && (activeCt.name || activeCt.pushname)) || (activeChat && activeChat.title) || '-';
    document.getElementById('activeChatMeta').textContent = activeChatId +
      (activeCt ? '  |  isMyContact=' + String(activeCt.isMyContact) + '  blocked=' + String(activeCt.blocked) : '') +
      (activeChat ? '  |  archived=' + String(activeChat.archived) + '  muted=' + String(activeChat.muted) : '');

    const msgList = document.getElementById('msgList');
    msgList.textContent = '';
    for (const msg of (state.timelines[activeChatId] || [])) {
      const card = document.createElement('div');
      card.className = 'msg ' + (msg.direction || (msg.fromMe ? 'user' : 'inbound'));
      const meta = document.createElement('div');
      meta.className = 'msg-meta';
      const who = document.createElement('span');
      who.textContent = (msg.direction === 'bot' ? 'BOT' : msg.direction === 'user' ? 'user:' : msg.author) +
        (msg.isForwarded ? ' [Forwarded]' : '') +
        (msg.edited ? ' [Edited]' : '');
      meta.appendChild(who);

      if (msg.type !== 'poll' && msg.direction !== 'bot') {
        const editBtn = document.createElement('button');
        editBtn.textContent = '編輯';
        editBtn.style.padding = '2px 6px';
        editBtn.onclick = async () => {
          const next = window.prompt('編輯訊息內容:', msg.body);
          if (next != null) await api('/api/edit', { messageId: msg.id, newBody: next });
        };
        meta.appendChild(editBtn);
      }
      card.appendChild(meta);

      const bodyEl = document.createElement('div');
      bodyEl.className = 'msg-body';
      bodyEl.textContent = msg.body;
      card.appendChild(bodyEl);

      if (msg.poll && Array.isArray(msg.poll.options)) {
        const opts = document.createElement('div');
        opts.className = 'poll-opts';
        for (const opt of msg.poll.options) {
          const btn = document.createElement('button');
          const selected = Array.isArray(msg.poll.selectedOptions) && msg.poll.selectedOptions.includes(opt);
          btn.className = 'poll-btn' + (selected ? ' selected' : '');
          btn.textContent = (selected ? '✓ ' : '○ ') + opt;
          btn.onclick = () => api('/api/vote', { pollId: msg.id, selectedOptions: [opt] });
          opts.appendChild(btn);
        }
        card.appendChild(opts);
      }
      msgList.appendChild(card);
    }
    msgList.scrollTop = msgList.scrollHeight;

    const rightLog = document.getElementById('rightLog');
    rightLog.textContent = '';
    if (rightTab === 'actions') {
      for (const act of (state.actions || [])) {
        const el = document.createElement('div');
        el.className = 'log-item';
        el.textContent = act.at.slice(11, 19) + '  ' + act.op + '  ' + JSON.stringify(act);
        rightLog.appendChild(el);
      }
    } else {
      for (const line of botLogs) {
        const el = document.createElement('div');
        el.className = 'log-item';
        el.textContent = line;
        rightLog.appendChild(el);
      }
    }
  }

  async function refresh() {
    const res = await fetch('/api/state');
    const data = await res.json();
    state = data.sandbox;
    botLogs = data.botLogs || [];
    const badge = document.getElementById('botBadge');
    badge.textContent = 'bot: ' + (data.botStatus || 'external');
    badge.className = 'pill ' + (data.botStatus === 'running' ? 'ok' : 'info');
    render();
  }

  document.getElementById('btnSendInbound').onclick = async () => {
    const input = document.getElementById('msgInput');
    const body = input.value.trim();
    if (!body) return;
    await api('/api/inbound', { chatId: activeChatId, body, isForwarded: document.getElementById('chkForwarded').checked });
    input.value = '';
  };

  document.getElementById('btnSendUser').onclick = async () => {
    const input = document.getElementById('msgInput');
    const body = input.value.trim();
    if (!body) return;
    await api('/api/user', { chatId: activeChatId, body });
    input.value = '';
  };

  document.getElementById('msgInput').addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.key === 'Enter') {
      e.preventDefault();
      document.getElementById('btnSendInbound').click();
    }
  });

  document.getElementById('btnApplyPreset').onclick = async () => {
    const id = document.getElementById('presetSelect').value;
    const preset = (state.presets || []).find((p) => p.id === id);
    if (!preset) return;
    activeChatId = preset.chatId;
    if (preset.sender === 'user') {
      await api('/api/user', { chatId: preset.chatId, body: preset.body });
    } else {
      await api('/api/inbound', { chatId: preset.chatId, body: preset.body, isForwarded: Boolean(preset.isForwarded) });
    }
  };

  document.getElementById('btnToggleSaved').onclick = async () => {
    const ct = effectiveContact(activeChatId);
    const nextSaved = !(ct && ct.isMyContact);
    const nextName = nextSaved ? ((ct && ct.name) || 'Saved Contact') : '';
    const pn = mappedPhoneId(activeChatId);
    if (pn) {
      await api('/api/contact', { id: pn, isMyContact: nextSaved, name: nextName });
      if (!nextSaved) {
        await api('/api/contact', { id: activeChatId, isMyContact: false, name: '' });
      }
    } else {
      await api('/api/contact', { id: activeChatId, isMyContact: nextSaved, name: nextName });
    }
  };

  document.getElementById('btnUnarchive').onclick = () => api('/api/archive', { chatId: activeChatId, archived: false });
  document.getElementById('btnArchive').onclick = () => api('/api/archive', { chatId: activeChatId, archived: true });
  document.getElementById('btnReset').onclick = () => api('/api/reset', {});
  document.getElementById('btnEmitReady').onclick = () => api('/api/flags', { emitEvent: 'ready' });
  document.getElementById('chkSynced').onchange = (e) => api('/api/flags', { contactsSynced: e.target.checked });
  document.getElementById('chkFailContact').onchange = (e) => api('/api/flags', { contactLookupFailing: e.target.checked });

  document.getElementById('btnAddContact').onclick = async () => {
    const id = document.getElementById('newContactId').value.trim();
    const name = document.getElementById('newContactName').value.trim();
    const isMyContact = document.getElementById('newContactSaved').checked;
    if (!id) return;
    await api('/api/contact', { id, name, pushname: name || id, isMyContact });
    document.getElementById('newContactId').value = '';
    document.getElementById('newContactName').value = '';
  };

  document.getElementById('tabActions').onclick = () => {
    rightTab = 'actions';
    document.getElementById('tabActions').classList.add('active');
    document.getElementById('tabBotLogs').classList.remove('active');
    render();
  };
  document.getElementById('tabBotLogs').onclick = () => {
    rightTab = 'bot';
    document.getElementById('tabBotLogs').classList.add('active');
    document.getElementById('tabActions').classList.remove('active');
    render();
  };

  const es = new EventSource('/api/ui-stream');
  es.addEventListener('update', () => { void refresh(); });
  void refresh();
})();
</script>
</body>
</html>`;
}

module.exports = { renderMiniWhatsAppHtml };
