// Doorman inbox. No build step, no framework: state in `S`, render() redraws the tab.
const TOKEN = document.querySelector('meta[name="doorman-token"]').content;
const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const S = {
  tab: (location.hash.match(/^#tab=(\w+)/) || [])[1] || 'inbox',
  asks: new Map(),
  history: [],
  agents: [],
  rules: [],
  suggestions: [],
  ledger: [],
  verify: null,
  state: null,
  stats: null,
  counts: null,
  config: null,
  sel: 0,
  drafts: new Map(), // ask id -> { text, values, always }
  open: new Set(), // expanded ask ids
};

async function api(method, path, body) {
  const res = await fetch(path, { method, headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { t.hidden = true; }, 2600);
}

const fmtLeft = (ms) => {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  const h = Math.floor(m / 60);
  return h < 48 ? `${h}h ${m % 60}m` : `${Math.round(h / 24)}d`;
};
const fmtTime = (t) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const fmtAgo = (t) => {
  const s = (Date.now() - t) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return new Date(t).toLocaleDateString();
};
const URG = ['low', 'normal', 'high', 'critical'];

// ------------------------------------------------------------------ data

async function loadAsks() {
  const { asks, counts } = await api('GET', '/v1/asks?status=open');
  S.asks = new Map(asks.map((a) => [a.id, a]));
  S.counts = counts;
}
const loadState = async () => { S.state = await api('GET', '/v1/state?detail=1'); };
const loadAgents = async () => { S.agents = (await api('GET', '/v1/agents')).agents; };
const loadRules = async () => { const r = await api('GET', '/v1/rules'); S.rules = r.rules; S.suggestions = r.suggestions; };
const loadStats = async () => { const r = await api('GET', '/v1/stats'); S.stats = r.stats; S.counts = r.counts; };
const loadHistory = async () => { S.history = (await api('GET', '/v1/asks?status=closed&limit=150')).asks; };
const loadLedger = async () => { S.ledger = (await api('GET', '/v1/ledger?limit=150')).entries; };
const loadConfig = async () => { S.config = await api('GET', '/v1/config'); };

function openAsks(kind) {
  const list = [...S.asks.values()].filter((a) => ['pending', 'unread'].includes(a.status) && (kind === 'fyi' ? a.kind === 'inform' : a.kind !== 'inform'));
  return list.sort((a, b) => URG.indexOf(b.urgency) - URG.indexOf(a.urgency) || (a.deadline ?? Infinity) - (b.deadline ?? Infinity) || a.created_at - b.created_at);
}

// ----------------------------------------------------------------- views

function routeChip(a) {
  const d = a.delivery;
  if (!d) return '';
  const label = {
    interrupted: d.bundle_size > 1 ? `pinged you · bundle of ${d.bundle_size}` : 'pinged you',
    queued: 'about to ping you',
    held: 'held, not pinged',
    snoozed: `snoozed until ${fmtTime(d.until)}`,
    digest: d.digested_at ? 'in digest (delivered)' : 'saved for digest',
  }[d.mode] || d.mode;
  return `<span class="chip route" title="${esc(d.reason)}">${esc(label)}</span>`;
}

function askCard(a, i) {
  const def = a.default?.option ? a.options.find((o) => o.id === a.default.option) : null;
  const draft = S.drafts.get(a.id) || {};
  const detail = a.detail || {};
  const hasMore = detail.paragraph || detail.full;
  const facts = [];
  if (a.deadline) facts.push(def ? `If no answer: <strong>${esc(def.label)}</strong>` : a.kind !== 'inform' ? '<strong>No safe default</strong>, will escalate near the deadline' : '');
  if (a.delay_cost) facts.push(`Waiting costs: <strong>${esc(a.delay_cost)}</strong>`);
  if (a.reversible === true) facts.push('Reversible');
  const notes = [a.delivery?.reason, ...(a.delivery?.notes || [])].filter(Boolean);

  let body = '';
  if (a.kind === 'decision') {
    body = `<div class="opts">${a.options.map((o, k) => `
      <button class="opt ${o.style} ${def?.id === o.id ? 'isdefault' : ''}" data-act="answer" data-id="${a.id}" data-opt="${esc(o.id)}">
        <span class="k">${k + 1}</span><span class="l">${esc(o.label)}</span>${o.consequence ? `<span class="c">${esc(o.consequence)}</span>` : ''}
      </button>`).join('')}</div>`;
  } else if (a.kind === 'input') {
    const schema = a.input?.schema;
    const fields = schema
      ? Object.entries(schema.properties).map(([k, p]) => {
        const req = (schema.required || []).includes(k) ? ' *' : '';
        const v = draft.values?.[k] ?? p.default ?? '';
        const label = esc(p.title || k) + req;
        if (p.enum) return `<label>${label}<select data-field="${esc(k)}" data-id="${a.id}">${p.enum.map((e, j) => `<option value="${esc(e)}" ${String(v) === String(e) ? 'selected' : ''}>${esc(p.enumNames?.[j] ?? e)}</option>`).join('')}</select></label>`;
        if (p.type === 'boolean') return `<label><span><input type="checkbox" data-field="${esc(k)}" data-id="${a.id}" ${v === true ? 'checked' : ''}> ${label}</span></label>`;
        return `<label>${label}<input data-field="${esc(k)}" data-id="${a.id}" type="${p.type === 'number' || p.type === 'integer' ? 'number' : p.format === 'email' ? 'email' : 'text'}" value="${esc(v)}" placeholder="${esc(p.description || '')}"></label>`;
      }).join('')
      : `<textarea class="field" rows="2" data-text="${a.id}" placeholder="${esc(a.input?.placeholder || 'Type your answer')}">${esc(draft.text || '')}</textarea>`;
    body = `<div class="form">${fields}</div><div class="opts"><button class="opt primary" data-act="submit" data-id="${a.id}"><span class="l">Send</span><span class="k">Ctrl+Enter</span></button>${a.options.map((o) => `<button class="opt ${o.style}" data-act="answer" data-id="${a.id}" data-opt="${esc(o.id)}"><span class="l">${esc(o.label)}</span></button>`).join('')}</div>`;
  }

  const actions = a.kind === 'inform'
    ? `<div class="actions"><button class="btn primary" data-act="ack" data-id="${a.id}">Got it</button><span class="sp"></span><button class="link" data-act="dismiss" data-id="${a.id}" title="Don't need these. Lowers this agent's budget if it pinged you.">Not useful</button></div>`
    : `<div class="actions">
        ${a.kind === 'decision' && a.reversible !== false ? `<label title="Make a rule: always answer this way for this exact request"><input type="checkbox" data-always="${a.id}" ${draft.always ? 'checked' : ''}> Always do this for <code>${esc(trunc(a.fingerprint, 48))}</code></label>` : ''}
        <span class="sp"></span>
        <button class="link" data-act="snooze" data-id="${a.id}" data-for="1h">Snooze 1h</button>
        <button class="link" data-act="dismiss" data-id="${a.id}" title="${def ? `Applies the default (${esc(def.label)}) and` : 'Rejects and'} tells Doorman this wasn't worth your attention">Dismiss</button>
      </div>`;

  return `<article class="card u-${a.urgency} ${i === S.sel ? 'sel' : ''}" id="${a.id}" data-i="${i}">
    <div class="meta">
      <span class="chip agent">${esc(a.agent.name)}</span>
      ${a.urgency !== 'normal' ? `<span class="chip ${a.urgency}">${a.urgency}</span>` : ''}
      ${a.reversible === false ? '<span class="chip irrev">irreversible</span>' : ''}
      ${routeChip(a)}
      <span>${fmtAgo(a.created_at)}</span>
      ${a.deadline ? `<span class="countdown" data-deadline="${a.deadline}"></span>` : ''}
    </div>
    <div class="q">${esc(a.question)}</div>
    ${detail.line ? `<p class="line">${esc(detail.line)}</p>` : ''}
    ${facts.filter(Boolean).length ? `<div class="facts">${facts.filter(Boolean).map((f) => `<span>${f}</span>`).join('')}</div>` : ''}
    ${hasMore ? `<details class="more" data-more="${a.id}" ${S.open.has(a.id) ? 'open' : ''}><summary>More context</summary>${detail.paragraph ? `<p>${esc(detail.paragraph)}</p>` : ''}${detail.full ? `<pre class="full">${esc(detail.full)}</pre>` : ''}</details>` : ''}
    ${body}
    ${actions}
    ${notes.length ? `<div class="why">Why: ${notes.map(esc).join(' · ')}</div>` : ''}
  </article>`;
}

const trunc = (s, n) => (s && s.length > n ? `${s.slice(0, n - 1)}…` : s);

function viewInbox(kind) {
  const list = openAsks(kind);
  if (!list.length) {
    return kind === 'fyi'
      ? '<div class="empty"><h2>No updates</h2>FYIs from your agents collect here and arrive as digests.</div>'
      : `<div class="empty"><h2>Nothing needs you</h2>Your agents are working. When one needs a decision, it lands here,<br>and Doorman decides whether it's worth interrupting you.<br><br>See it in action: <code>doorman demo</code></div>`;
  }
  const head = kind === 'fyi' && list.length > 1 ? '<div class="actions" style="margin:0 0 10px"><span class="sp"></span><button class="btn" data-act="ack-all">Mark all read</button></div>' : '';
  return head + list.map(askCard).join('');
}

function outcome(a) {
  const ans = a.answer || {};
  const opt = ans.option ? a.options.find((o) => o.id === ans.option)?.label ?? ans.option : null;
  const val = opt ?? (ans.text ? `"${trunc(ans.text, 40)}"` : ans.values ? 'form sent' : '');
  switch (a.status) {
    case 'answered': return `${esc(val)} <span class="t">via ${esc(ans.surface)}${ans.latency_ms ? ` in ${fmtLeft(ans.latency_ms)}` : ''}</span>`;
    case 'auto': return `${esc(val)} <span class="t">by your rule</span>`;
    case 'defaulted': return `${esc(val)} <span class="t">default at deadline</span>`;
    case 'dismissed': return `dismissed${val ? ` → ${esc(val)}` : ''}`;
    case 'read': return ans.by === 'collapsed' ? 'replaced by newer' : 'read';
    default: return esc(a.status);
  }
}

function viewHistory() {
  if (!S.history.length) return '<div class="empty"><h2>No history yet</h2></div>';
  return S.history.map((a) => `<div class="row"><span class="t">${fmtTime(a.resolved_at || a.created_at)}</span><span class="a">${esc(a.agent.name)}</span><span class="x">${esc(a.question)}</span><span class="o ${a.status}">${outcome(a)}</span></div>`).join('');
}

function viewAgents() {
  if (!S.agents.length) return '<div class="empty"><h2>No agents yet</h2>Agents appear here the first time they ask for you.</div>';
  return `<p class="help">Every agent gets an attention budget: interruptions per hour. Acting on an interruption grows it by one; dismissing one halves it, like TCP backing off under congestion. Credibility drops when you dismiss an agent's "urgent" asks, and then its urgent asks count as one level lower.</p>
  <table><thead><tr><th>Agent</th><th>Budget now</th><th class="num">Per hour</th><th class="num">Credibility</th><th class="num">Asks</th><th class="num">Pinged</th><th class="num">Answered</th><th class="num">Dismissed</th><th></th></tr></thead><tbody>
  ${S.agents.map((g) => `<tr>
    <td><strong>${esc(g.name)}</strong><div class="mono" style="color:var(--muted)">${esc(g.id)}</div></td>
    <td><div class="bar" title="${g.tokens} of ${g.capacity}"><i style="width:${Math.min(100, (g.tokens / Math.max(1, g.capacity)) * 100)}%"></i></div></td>
    <td class="num">${g.capacity}</td>
    <td class="num ${g.credibility < 0.5 ? 'bad' : ''}">${Math.round(g.credibility * 100)}%</td>
    <td class="num">${g.asks}</td><td class="num">${g.interrupts}</td><td class="num">${g.answered}</td><td class="num">${g.dismissed}</td>
    <td style="white-space:nowrap"><button class="link" data-act="mute" data-agent="${esc(g.id)}" data-muted="${g.muted ? 0 : 1}">${g.muted ? 'Unmute' : 'Mute'}</button><button class="link" data-act="reset" data-agent="${esc(g.id)}">Reset</button></td>
  </tr>`).join('')}</tbody></table>`;
}

function viewRules() {
  const sug = S.suggestions.map((s) => `<div class="card sug">
    <div class="meta"><span class="chip agent">${esc(s.agent.name)}</span><span>learned from your last ${s.count} answers</span></div>
    <div class="q">Always answer “${esc(s.label)}” to this?</div>
    <p class="line"><code>${esc(s.fingerprint)}</code></p>
    <div class="actions"><button class="btn primary" data-act="sug-accept" data-id="${s.id}">Make it a rule</button><button class="link" data-act="sug-decline" data-id="${s.id}">No, keep asking me</button></div>
  </div>`).join('');
  const rules = S.rules.length
    ? `<table><thead><tr><th>Match</th><th>Then</th><th class="num">Hits</th><th>Source</th><th></th></tr></thead><tbody>${S.rules.map((r) => `<tr>
      <td class="mono">${Object.entries(r.match).map(([k, v]) => `${esc(k)}: ${esc(v)}`).join('<br>')}${r.note ? `<div style="color:var(--muted)">${esc(r.note)}</div>` : ''}</td>
      <td>${r.action.answer != null ? `answer <strong>${esc(r.action.answer)}</strong>` : `route <strong>${esc(r.action.route)}</strong>`}</td>
      <td class="num">${r.hits}</td><td>${esc(r.source)}</td>
      <td><button class="link" data-act="rule-rm" data-id="${r.id}">Delete</button></td></tr>`).join('')}</tbody></table>`
    : '<p class="help">No rules yet. Tick “Always do this” on an ask, accept a suggestion, or add one below.</p>';
  return `${sug ? `<h3>Suggestions</h3>${sug}` : ''}
  <h3>Your rules</h3>${rules}
  <h3>Add a rule</h3>
  <div class="panel"><form id="rule-form" class="form">
    <div class="grid2">
      <label>Agent (glob)<input name="agent" placeholder="claude-code-* or Email agent"></label>
      <label>Fingerprint (glob)<input name="fingerprint" placeholder="Bash:npm test*"></label>
      <label>Kind<select name="kind"><option value="">any</option><option>decision</option><option>input</option><option>inform</option></select></label>
      <label>Urgency<select name="urgency"><option value="">any</option><option>low</option><option>normal</option><option>high</option><option>critical</option></select></label>
      <label>Then<select name="then"><option value="answer">answer with option…</option><option value="now">always interrupt me</option><option value="digest">send to digest</option><option value="hold">never interrupt (keep in inbox)</option><option value="mute">mute FYIs</option></select></label>
      <label>Option id (for “answer”)<input name="answer" placeholder="allow"></label>
    </div>
    <p class="help">Globs: <code>*</code> any text, <code>?</code> one character, <code>|</code> or. Rules are checked top to bottom; answer rules only fire when that option exists.</p>
    <div><button class="btn primary" type="submit">Add rule</button></div>
  </form></div>`;
}

function viewLedger() {
  const v = S.verify;
  const head = `<div class="panel"><div class="actions" style="margin:0"><span>Every ask, routing decision and answer is appended to a hash-chained log (<code>~/.doorman/ledger.jsonl</code>). Editing history breaks the chain.</span><span class="sp"></span><button class="btn" data-act="verify">Verify chain</button></div>
    ${v ? `<p class="${v.ok ? 'ok' : 'bad'}" style="margin:10px 0 0">${v.ok ? `✓ Intact: ${v.count} entries, head <span class="mono">${esc(v.head.slice(0, 16))}…</span>` : `✗ Broken at entry ${v.broken_at}: ${esc(v.reason)}`}</p>` : ''}</div>`;
  const rows = S.ledger.map((e) => {
    const d = e.data || {};
    const what = e.type === 'ask.created' ? `${esc(d.agent?.name)}: ${esc(d.question)}`
      : e.type === 'ask.resolved' ? `${esc(d.id)} → <strong>${esc(d.status)}</strong>${d.answer?.option ? ` (${esc(d.answer.option)} by ${esc(d.answer.by)})` : ''}`
        : e.type === 'ask.routed' ? `${esc(d.id)} → ${esc(d.mode)}: ${esc(d.reason)}`
          : e.type === 'bundle.delivered' ? `${d.asks.length} asks${d.digest?.length ? ` + ${d.digest.length} digest` : ''} → ${esc(d.surfaces.join(', '))}`
            : `<span class="mono">${esc(JSON.stringify(d).slice(0, 140))}</span>`;
    return `<div class="row"><span class="t">#${e.seq}</span><span class="a mono">${esc(e.type)}</span><span class="x">${what}</span><span class="o mono" title="${esc(e.hash)}">${esc(e.hash.slice(0, 8))}</span></div>`;
  }).join('');
  return head + (rows || '<div class="empty">Empty.</div>');
}

function viewSettings() {
  if (!S.config) return '<div class="empty">Loading…</div>';
  const c = S.config.config;
  const q = c.quietHours || {};
  const cal = c.calendar || {};
  const n = c.ntfy || {};
  const cs = S.state?.calendar || {};
  const notif = 'Notification' in window ? Notification.permission : 'unsupported';
  return `<form id="settings" class="form">
  <h3>Quiet hours</h3>
  <div class="panel"><div class="grid2">
    <label>From<input name="q_start" type="time" value="${esc(q.start || '')}"></label>
    <label>To<input name="q_end" type="time" value="${esc(q.end || '')}"></label>
    <label>Mode<select name="q_mode">${['dnd', 'focus', 'away'].map((m) => `<option ${q.mode === m ? 'selected' : ''}>${m}</option>`).join('')}</select></label>
  </div><p class="help">Leave empty to turn off. A manual state in the header always wins.</p></div>

  <h3>Calendar</h3>
  <div class="panel">
    <label>ICS URL or file path<input name="cal_ics" value="${esc(cal.ics || '')}" placeholder="https://calendar.google.com/calendar/ical/.../basic.ics"></label>
    <div class="grid2" style="margin-top:8px">
      <label>During meetings<select name="cal_mode">${['focus', 'dnd', 'away'].map((m) => `<option ${(cal.busyMode || 'focus') === m ? 'selected' : ''}>${m}</option>`).join('')}</select></label>
      <label>DND keywords<input name="cal_kw" value="${esc((cal.dndKeywords || ['focus time', 'deep work', 'do not disturb']).join(', '))}"></label>
    </div>
    <p class="help">Read locally every 5 minutes. Agents only ever see “focus” or “available”, never your events. ${cs.configured ? (cs.error ? `<span class="bad">Error: ${esc(cs.error)}</span>` : `<span class="ok">${cs.events_next_48h} busy blocks in the next 48h.</span>`) : ''}</p>
  </div>

  <h3>Interruptions</h3>
  <div class="panel">
    <div class="grid2">
      <label>Bundle window (seconds)<input name="bundle" type="number" min="0" max="120" value="${Math.round((c.bundleWindowMs ?? 4000) / 1000)}"></label>
      <label>Digest times<input name="digest" value="${esc((c.digest?.times || []).join(', '))}" placeholder="12:00, 17:30"></label>
      <label>Suggest a rule after N same answers<input name="learn" type="number" min="2" max="20" value="${c.learnThreshold ?? 3}"></label>
    </div>
    <label style="display:flex;gap:8px;align-items:center;margin-top:10px"><input type="checkbox" name="desktop" ${c.desktop !== false ? 'checked' : ''} style="width:auto"> Native desktop notifications</label>
    <label style="display:flex;gap:8px;align-items:center"><input type="checkbox" name="onbreak" ${c.digest?.onBreak !== false ? 'checked' : ''} style="width:auto"> Deliver held items and the digest when focus ends</label>
    <p class="help">Browser notifications for this tab: <strong>${esc(notif)}</strong> ${notif === 'default' ? '<button class="btn" type="button" data-act="browser-notif">Enable</button>' : ''}</p>
  </div>

  <h3>Phone (ntfy)</h3>
  <div class="panel">
    <p class="help">Push to your phone with one-tap answer buttons through <a href="https://ntfy.sh" target="_blank" rel="noreferrer">ntfy</a>. Install the ntfy app and subscribe to your topic. Answers come back over a signed reply topic, so nothing on your computer is exposed to the internet. Treat the topic like a password.</p>
    <div class="grid2">
      <label>Server<input name="n_server" value="${esc(n.server || 'https://ntfy.sh')}"></label>
      <label>Topic<input name="n_topic" value="${esc(n.topic || '')}" placeholder="click Generate"></label>
      <label>Access token (optional)<input name="n_token" type="password" value="${esc(n.token || '')}"></label>
      <label>Send to phone<select name="n_mirror"><option value="always" ${n.mirror !== 'away' ? 'selected' : ''}>every interruption</option><option value="away" ${n.mirror === 'away' ? 'selected' : ''}>only when I'm away</option></select></label>
    </div>
    <label style="display:flex;gap:8px;align-items:center;margin-top:10px"><input type="checkbox" name="n_redact" ${n.redact ? 'checked' : ''} style="width:auto"> Hide question text in phone notifications (privacy)</label>
    <div class="actions"><button class="btn" type="button" data-act="gen-topic">Generate topic</button>${n.topic ? `<span class="mono">subscribe to: ${esc(n.server || 'https://ntfy.sh')}/${esc(n.topic)}</span>` : ''}</div>
  </div>

  <div class="actions"><button class="btn primary" type="submit">Save settings</button><button class="btn" type="button" data-act="test-notify">Send test notification</button><span class="sp"></span><span class="mono">${esc(S.config.home)}</span></div>
  </form>

  <h3>Connect your agents</h3>
  <div class="panel"><p class="help">Run these in a terminal; each prints the exact snippet for your machine.</p>
  <pre class="full">doorman setup claude-code   # hooks: permission prompts, "done" and "needs you"
doorman setup codex         # turn-complete notifications + MCP
doorman setup cursor        # MCP tools: ask_human, notify_human, get_human_state

# Gate risky tools on any MCP server:
doorman proxy --name github --gate "delete_*|merge_*" -- npx -y @modelcontextprotocol/server-github</pre></div>`;
}

// ---------------------------------------------------------------- render

function renderHeader() {
  const st = S.state;
  if (st) {
    const manual = st.source === 'manual';
    $$('#state .seg button').forEach((b) => b.classList.toggle('on', manual ? b.dataset.mode === st.mode : b.dataset.mode === 'auto'));
    $('#state-label').textContent = `${st.label}${st.until ? ` until ${fmtTime(st.until)}` : ''}${!manual && st.source !== 'default' ? ` (${st.source})` : ''}`;
  }
  const inbox = openAsks('inbox').length;
  const fyi = openAsks('fyi').length;
  $('#c-inbox').textContent = inbox || '';
  $('#c-fyi').textContent = fyi || '';
  $('#c-rules').textContent = S.suggestions.length || '';
  document.title = inbox ? `(${inbox}) Doorman` : 'Doorman';
  $$('#tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === S.tab));
  if (S.stats) {
    const s = S.stats;
    $('#stats').textContent = `${s.asks} asks → ${s.notifications} interruptions ·${s.held} held · ${s.digested} digested · ${s.auto} auto-answered`;
  }
}

function render() {
  renderHeader();
  const main = $('#main');
  // Keep whatever the user is typing.
  const active = document.activeElement;
  const activeKey = active?.dataset?.text || (active?.dataset?.field ? `${active.dataset.id}:${active.dataset.field}` : null);
  if (S.tab === 'settings' && main.querySelector('#settings') && main.contains(active) && active.tagName !== 'BUTTON') return;
  const html = {
    inbox: () => viewInbox('inbox'),
    fyi: () => viewInbox('fyi'),
    history: viewHistory,
    agents: viewAgents,
    rules: viewRules,
    ledger: viewLedger,
    settings: viewSettings,
  }[S.tab]();
  main.innerHTML = html;
  tickCountdowns();
  if (activeKey) {
    const el = active.dataset.text ? $(`[data-text="${activeKey}"]`) : $(`[data-id="${active.dataset.id}"][data-field="${active.dataset.field}"]`);
    if (el) { el.focus(); if (el.setSelectionRange && el.type !== 'number' && el.type !== 'email') el.setSelectionRange(el.value.length, el.value.length); }
  }
}

let renderQueued = false;
function scheduleRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => { renderQueued = false; render(); });
}

function tickCountdowns() {
  for (const el of $$('[data-deadline]')) {
    const left = Number(el.dataset.deadline) - Date.now();
    el.textContent = left > 0 ? `⏱ ${fmtLeft(left)}` : 'deadline passed';
    el.classList.toggle('soon', left < 120000);
  }
}
setInterval(tickCountdowns, 1000);

// --------------------------------------------------------------- actions

async function act(fn, ok) {
  try {
    await fn();
    if (ok) toast(ok);
  } catch (err) {
    toast(err.message);
  }
}

function currentList() {
  return S.tab === 'inbox' ? openAsks('inbox') : S.tab === 'fyi' ? openAsks('fyi') : [];
}

async function answer(id, option) {
  const d = S.drafts.get(id) || {};
  const a = S.asks.get(id);
  await act(async () => {
    await api('POST', `/v1/asks/${id}/answer`, { option, always: !!d.always, surface: 'web' });
    S.drafts.delete(id);
  }, d.always ? 'Answered, and saved as a rule' : `Answered${a ? `: ${a.options.find((o) => o.id === option)?.label ?? option}` : ''}`);
}

async function submitInput(id) {
  const a = S.asks.get(id);
  if (!a) return;
  const d = S.drafts.get(id) || {};
  const body = { surface: 'web' };
  if (a.input?.schema) {
    body.values = {};
    for (const el of $$(`[data-id="${id}"][data-field]`)) body.values[el.dataset.field] = el.type === 'checkbox' ? el.checked : el.value;
  } else {
    body.text = $(`[data-text="${id}"]`)?.value ?? d.text ?? '';
    if (!body.text.trim()) return toast('Type an answer first');
  }
  await act(async () => { await api('POST', `/v1/asks/${id}/answer`, body); S.drafts.delete(id); }, 'Sent');
}

document.addEventListener('click', async (e) => {
  const seg = e.target.closest('#state .seg button');
  if (seg) {
    const forVal = $('#state-for').value;
    return act(async () => { S.state = await api('POST', '/v1/state', { mode: seg.dataset.mode, for: seg.dataset.mode === 'auto' ? undefined : forVal || undefined }); render(); });
  }
  const tab = e.target.closest('#tabs button');
  if (tab) return switchTab(tab.dataset.tab);
  const b = e.target.closest('[data-act]');
  if (!b) {
    const card = e.target.closest('.card[data-i]');
    if (card && !e.target.closest('input,textarea,select,summary,a')) { S.sel = Number(card.dataset.i); $$('.card').forEach((c) => c.classList.toggle('sel', c === card)); }
    return;
  }
  const id = b.dataset.id;
  switch (b.dataset.act) {
    case 'answer': return answer(id, b.dataset.opt);
    case 'submit': return submitInput(id);
    case 'ack': return act(() => api('POST', `/v1/asks/${id}/ack`, { surface: 'web' }));
    case 'ack-all': return act(async () => { for (const a of openAsks('fyi')) await api('POST', `/v1/asks/${a.id}/ack`, { surface: 'web' }); }, 'All read');
    case 'dismiss': return act(() => api('POST', `/v1/asks/${id}/dismiss`, { surface: 'web' }), 'Dismissed; that agent will interrupt you less');
    case 'snooze': return act(() => api('POST', `/v1/asks/${id}/snooze`, { for: b.dataset.for, surface: 'web' }), `Snoozed ${b.dataset.for}`);
    case 'mute': return act(async () => { await api('POST', `/v1/agents/${encodeURIComponent(b.dataset.agent)}/mute`, { muted: b.dataset.muted === '1' }); await loadAgents(); render(); });
    case 'reset': return act(async () => { await api('POST', `/v1/agents/${encodeURIComponent(b.dataset.agent)}/reset`); await loadAgents(); render(); }, 'Budget reset');
    case 'sug-accept': return act(async () => { await api('POST', `/v1/suggestions/${id}/accept`); await loadRules(); render(); }, 'Rule created');
    case 'sug-decline': return act(async () => { await api('POST', `/v1/suggestions/${id}/decline`); await loadRules(); render(); });
    case 'rule-rm': return act(async () => { await api('DELETE', `/v1/rules/${id}`); await loadRules(); render(); }, 'Rule deleted');
    case 'verify': return act(async () => { S.verify = await api('GET', '/v1/ledger/verify'); await loadLedger(); render(); });
    case 'test-notify': return act(async () => { const r = await api('POST', '/v1/notify-test'); toast(r.sent.length ? `Sent to ${r.sent.join(' + ')}` : 'No surfaces enabled'); });
    case 'browser-notif': return Notification.requestPermission().then(() => render());
    case 'gen-topic': {
      const bytes = crypto.getRandomValues(new Uint8Array(12));
      $('[name="n_topic"]').value = `doorman-${[...bytes].map((x) => x.toString(36)).join('').slice(0, 18)}`;
      return toast('Topic generated. Save, then subscribe to it in the ntfy app');
    }
    default: return undefined;
  }
});

document.addEventListener('input', (e) => {
  const t = e.target;
  if (t.dataset.text) S.drafts.set(t.dataset.text, { ...S.drafts.get(t.dataset.text), text: t.value });
  if (t.dataset.field) {
    const d = S.drafts.get(t.dataset.id) || {};
    S.drafts.set(t.dataset.id, { ...d, values: { ...d.values, [t.dataset.field]: t.type === 'checkbox' ? t.checked : t.value } });
  }
});
document.addEventListener('change', (e) => {
  const t = e.target;
  if (t.dataset.always) S.drafts.set(t.dataset.always, { ...S.drafts.get(t.dataset.always), always: t.checked });
});
document.addEventListener('toggle', (e) => {
  const d = e.target.closest?.('[data-more]');
  if (d) d.open ? S.open.add(d.dataset.more) : S.open.delete(d.dataset.more);
}, true);

document.addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  if (e.target.id === 'rule-form') {
    const match = {};
    for (const k of ['agent', 'fingerprint', 'kind', 'urgency']) if (f.get(k)) match[k] = f.get(k);
    const then = f.get('then');
    const action = then === 'answer' ? { answer: f.get('answer') } : { route: then };
    return act(async () => { await api('POST', '/v1/rules', { match, action }); await loadRules(); render(); }, 'Rule added');
  }
  if (e.target.id === 'settings') {
    const times = String(f.get('digest') || '').split(',').map((s) => s.trim()).filter(Boolean);
    const patch = {
      quietHours: f.get('q_start') && f.get('q_end') ? { start: f.get('q_start'), end: f.get('q_end'), mode: f.get('q_mode') } : null,
      calendar: f.get('cal_ics') ? { ics: f.get('cal_ics'), busyMode: f.get('cal_mode'), dndKeywords: String(f.get('cal_kw')).split(',').map((s) => s.trim()).filter(Boolean) } : null,
      bundleWindowMs: Number(f.get('bundle')) * 1000,
      digest: { times, onBreak: !!f.get('onbreak') },
      learnThreshold: Number(f.get('learn')) || 3,
      desktop: !!f.get('desktop'),
      ntfy: f.get('n_topic') ? { server: f.get('n_server') || 'https://ntfy.sh', topic: f.get('n_topic'), token: f.get('n_token') || null, mirror: f.get('n_mirror'), redact: !!f.get('n_redact') } : null,
    };
    return act(async () => { S.config = await api('PATCH', '/v1/config', patch); await loadState(); document.activeElement?.blur(); render(); }, 'Settings saved');
  }
  return undefined;
});

document.addEventListener('keydown', (e) => {
  const typing = ['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName);
  if (typing) {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      const id = e.target.dataset.text || e.target.dataset.id;
      if (id) submitInput(id);
    }
    if (e.key === 'Escape') e.target.blur();
    return;
  }
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const list = currentList();
  const a = list[S.sel];
  if (e.key === 'j' || e.key === 'ArrowDown') { S.sel = Math.min(list.length - 1, S.sel + 1); render(); $('.card.sel')?.scrollIntoView({ block: 'nearest' }); e.preventDefault(); return; }
  if (e.key === 'k' || e.key === 'ArrowUp') { S.sel = Math.max(0, S.sel - 1); render(); $('.card.sel')?.scrollIntoView({ block: 'nearest' }); e.preventDefault(); return; }
  if (!a) return;
  if (/^[1-9]$/.test(e.key) && a.kind === 'decision') { const o = a.options[Number(e.key) - 1]; if (o) answer(a.id, o.id); return; }
  if (e.key === 'e') { const d = $(`[data-more="${a.id}"]`); if (d) d.open = !d.open; return; }
  if (e.key === 'a' && a.kind === 'decision') { const c = $(`[data-always="${a.id}"]`); if (c) { c.checked = !c.checked; c.dispatchEvent(new Event('change', { bubbles: true })); } return; }
  if (e.key === 's' && a.kind !== 'inform') { act(() => api('POST', `/v1/asks/${a.id}/snooze`, { for: '1h', surface: 'web' }), 'Snoozed 1h'); return; }
  if (e.key === 'd') { act(() => api('POST', `/v1/asks/${a.id}/dismiss`, { surface: 'web' }), 'Dismissed'); return; }
  if (e.key === 'Enter' && a.kind === 'inform') act(() => api('POST', `/v1/asks/${a.id}/ack`, { surface: 'web' }));
});

async function switchTab(tab) {
  S.tab = tab;
  S.sel = 0;
  history.replaceState(null, '', `#tab=${tab}`);
  render();
  try {
    if (tab === 'history') await loadHistory();
    if (tab === 'agents') await loadAgents();
    if (tab === 'rules') await loadRules();
    if (tab === 'ledger') await loadLedger();
    if (tab === 'settings') { await loadConfig(); await loadState(); }
  } catch (err) { toast(err.message); }
  render();
}

// ----------------------------------------------------------------- live

let refreshTimer = null;
function refreshSoon() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(async () => {
    try {
      await loadStats();
      if (S.tab === 'history') await loadHistory();
      if (S.tab === 'agents') await loadAgents();
      if (S.tab === 'ledger') await loadLedger();
    } catch { /* next event retries */ }
    scheduleRender();
  }, 250);
}

function connect() {
  const es = new EventSource(`/v1/events?token=${encodeURIComponent(TOKEN)}`);
  es.addEventListener('hello', async () => {
    $('#conn').classList.add('live');
    await Promise.all([loadAsks(), loadState(), loadRules(), loadStats()]).catch((e) => toast(e.message));
    if (S.tab !== 'inbox') await switchTab(S.tab); else render();
  });
  const upsert = (e) => {
    const a = JSON.parse(e.data);
    S.asks.set(a.id, a);
    scheduleRender();
    refreshSoon();
  };
  es.addEventListener('ask', upsert);
  es.addEventListener('update', upsert);
  es.addEventListener('state', async () => { await loadState().catch(() => {}); scheduleRender(); });
  es.addEventListener('rules', async () => { await loadRules().catch(() => {}); scheduleRender(); });
  es.addEventListener('agents', () => refreshSoon());
  es.addEventListener('interrupt', (e) => {
    const n = JSON.parse(e.data);
    if (n.composed && 'Notification' in window && Notification.permission === 'granted' && document.hidden) {
      const note = new Notification(n.composed.title, { body: n.composed.body, tag: n.id, icon: '/favicon.svg' });
      note.onclick = () => { window.focus(); note.close(); };
    }
  });
  es.onerror = () => $('#conn').classList.remove('live');
}

// Deep link from a notification: /#ask_123
if (/^#ask_/.test(location.hash)) {
  const id = location.hash.slice(1);
  setTimeout(() => { const el = document.getElementById(id); if (el) { el.scrollIntoView({ block: 'center' }); el.classList.add('sel'); } }, 600);
}
connect();
render();
