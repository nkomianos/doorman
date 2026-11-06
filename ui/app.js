// Switchboard inbox. No build step, no framework: state lives in `S`, render() redraws from it.
const TOKEN = document.querySelector('meta[name="switchboard-token"]').content;
const VERSION = document.querySelector('meta[name="switchboard-version"]').content;
const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const trunc = (s, n) => (s && s.length > n ? `${s.slice(0, n - 1)}…` : s);
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

const VIEWS = ['inbox', 'updates', 'snoozed', 'history', 'now', 'connect', 'agents', 'rules', 'activity', 'settings'];
const UNDO_MS = 5000;
const URG = ['low', 'normal', 'high', 'critical'];

const MODES = {
  available: { label: 'Available', desc: 'Normal and urgent asks can ping you' },
  focus: { label: 'Focus', desc: 'Only urgent asks ping you. Everything else waits for your break' },
  dnd: { label: 'Do not disturb', desc: 'Only critical asks ping you' },
  away: { label: 'Away', desc: 'Urgent asks go to your phone, the rest wait' },
};

const S = {
  view: 'inbox',
  asks: new Map(),
  history: [],
  agents: [],
  rules: [],
  suggestions: [],
  ledger: [],
  verify: null,
  state: null,
  stats: null,
  config: null,
  selId: null,
  drafts: new Map(), // ask id -> { text, values, always }
  open: new Set(), // expanded ask / row ids
  hidden: new Set(), // asks with a local action waiting out its undo window
  seen: new Set(), // asks already rendered once (for the enter animation)
  pending: [], // [{ id, run, timer }]
  menu: null, // { type: 'snooze', id }
  duration: '',
  histFilter: 'all',
  histQuery: '',
  ruleForm: false,
  integrations: [],
  keys: [],
  newKey: null, // shown once after creating
  now: null,
  calendar: null,
  calProvider: 'google',
  calDraft: '',
  calPreview: null,
  snippetLang: 'curl',
  previews: new Map(), // `${askId}:${i}` -> { state, data | error }
  previewOpen: new Set(),
  autoPreviewed: new Set(),
  noteOpen: new Set(),
  replyOpen: new Set(),
  settingsDirty: false,
  testResult: null,
  connected: false,
  loaded: false,
};

// ------------------------------------------------------------------ icons

const PATHS = {
  inbox: '<path d="M3 13h5l1.5 3h5L16 13h5"/><path d="M5.5 5h13L21 13v5a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-5z"/>',
  bell: '<path d="M6 9a6 6 0 1 1 12 0c0 6 2.5 8 2.5 8h-17S6 15 6 9z"/><path d="M10 20.5a2 2 0 0 0 4 0"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  history: '<path d="M3.5 12a8.5 8.5 0 1 0 2.5-6"/><path d="M3 4v4h4"/><path d="M12 8v4l3 2"/>',
  bot: '<rect x="4.5" y="8" width="15" height="11" rx="3"/><path d="M12 4v4M9 13h.01M15 13h.01"/>',
  rules: '<path d="M4 6h10M4 12h16M4 18h7"/><circle cx="17" cy="6" r="2"/><circle cx="14" cy="18" r="2"/>',
  shield: '<path d="M12 3l7.5 3v5.5c0 4.5-3.2 8.2-7.5 9.5-4.3-1.3-7.5-5-7.5-9.5V6z"/><path d="M9 12l2 2 4-4"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  checks: '<path d="M2.5 12.5l4.5 4.5L16 8"/><path d="M12 16.5l.5.5L22 8"/>',
  x: '<path d="M6 6l12 12M18 6L6 18"/>',
  info: '<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5M12 8h.01"/>',
  alert: '<path d="M12 3.5L2.5 20h19z"/><path d="M12 10v4M12 17h.01"/>',
  lock: '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
  zap: '<path d="M13 2.5L4.5 13.5H12l-1 8 8.5-11H12z"/>',
  play: '<path d="M7 4.5v15l12-7.5z"/>',
  copy: '<rect x="8.5" y="8.5" width="11" height="11" rx="2"/><path d="M15.5 8.5V6a1.5 1.5 0 0 0-1.5-1.5H6A1.5 1.5 0 0 0 4.5 6v8A1.5 1.5 0 0 0 6 15.5h2.5"/>',
  undo: '<path d="M9 14L4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 0 10h-3"/>',
  phone: '<rect x="7" y="2.5" width="10" height="19" rx="2.5"/><path d="M11 18h2"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  trash: '<path d="M4 7h16M9 7V4.5h6V7M6.5 7l1 13h9l1-13"/>',
  sparkle: '<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/><path d="M19 15.5l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7z"/>',
  wake: '<path d="M12 3v3M12 18v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M3 12h3M18 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1"/><circle cx="12" cy="12" r="3.5"/>',
  mute: '<path d="M11 5L6 9H3v6h3l5 4z"/><path d="M16 9l5 6M21 9l-5 6"/>',
  link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
  calendar: '<rect x="3.5" y="5" width="17" height="15.5" rx="2"/><path d="M3.5 10h17M8 3v4M16 3v4"/>',
  key: '<circle cx="8" cy="15" r="4"/><path d="M11 12l9-9M17 6l3 3M15 8l2 2"/>',
  pulse: '<path d="M3 12h4l2.5-6 4 12 2.5-6H21"/>',
  doc: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M9 13h6M9 17h4"/>',
  diff: '<path d="M12 4v8M8 8h8M8 18h8"/>',
  code: '<path d="M9 8l-4 4 4 4M15 8l4 4-4 4"/>',
  reply: '<path d="M10 8L5 13l5 5"/><path d="M5 13h9a5 5 0 0 1 5 5v1"/>',
  sound: '<path d="M11 5L6 9H3v6h3l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13"/>',
};
const I = (name, size = 16) => `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${PATHS[name]}</svg>`;

// --------------------------------------------------------------- helpers

async function api(method, path, body, { keepalive = false } = {}) {
  const res = await fetch(path, { method, keepalive, headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `HTTP ${res.status}`), { status: res.status });
  return data;
}

const fmtLeft = (ms) => {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return s < 600 ? `${m}m ${String(s % 60).padStart(2, '0')}s` : `${m}m`;
  const h = Math.floor(m / 60);
  return h < 48 ? `${h}h${m % 60 ? ` ${m % 60}m` : ''}` : `${Math.round(h / 24)} days`;
};
const fmtTime = (t) => new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const sameDay = (a, b) => new Date(a).toDateString() === new Date(b).toDateString();
const fmtWhen = (t) => {
  if (sameDay(t, Date.now())) return fmtTime(t);
  if (sameDay(t, Date.now() + 86400000)) return `tomorrow ${fmtTime(t)}`;
  return new Date(t).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' });
};
const fmtAgo = (t) => {
  const s = (Date.now() - t) / 1000;
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return new Date(t).toLocaleDateString([], { month: 'short', day: 'numeric' });
};
const dayLabel = (t) => {
  if (sameDay(t, Date.now())) return 'Today';
  if (sameDay(t, Date.now() - 86400000)) return 'Yesterday';
  return new Date(t).toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' });
};

function hue(s) {
  let h = 0;
  for (const c of String(s)) h = (h * 31 + c.charCodeAt(0)) % 360;
  return h;
}
const initials = (name) => String(name || '?').split(/[\s_-]+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('') || '?';
const avatar = (agent) => `<span class="avatar" style="--h:${hue(agent?.id || agent?.name)}" aria-hidden="true">${esc(initials(agent?.name))}</span>`;

const optLabel = (a, id) => a.options?.find((o) => o.id === id)?.label ?? id;
const defaultOpt = (a) => (a.default?.option ? a.options?.find((o) => o.id === a.default.option) : null);

// ------------------------------------------------------------------ toasts

function toast(msg, { sub = '', action = null, error = false, ms = 3200 } = {}) {
  const host = $('#toasts');
  while (host.children.length >= 3) host.firstElementChild.remove();
  const el = document.createElement('div');
  el.className = `toast${error ? ' error' : ''}`;
  el.setAttribute('role', error ? 'alert' : 'status');
  el.innerHTML = `<span class="msg">${esc(msg)}${sub ? `<small>${esc(sub)}</small>` : ''}</span>${action ? `<button class="undo">${esc(action.label)}</button>` : ''}<button aria-label="Close notification">${I('x', 14)}</button><span class="bar" style="animation-duration:${ms}ms"></span>`;
  const close = () => { el.remove(); clearTimeout(timer); };
  const timer = setTimeout(close, ms);
  if (action) el.querySelector('.undo').onclick = () => { close(); action.fn(); };
  el.querySelector('[aria-label="Close notification"]').onclick = close;
  host.append(el);
  return close;
}
const fail = (err) => toast(err.message || String(err), { error: true, ms: 6000 });

// ------------------------------------------------------------------- data

const loadAsks = async () => { const { asks } = await api('GET', '/v1/asks?status=open'); S.asks = new Map(asks.map((a) => [a.id, a])); };
const loadState = async () => { S.state = await api('GET', '/v1/state?detail=1'); };
const loadAgents = async () => { S.agents = (await api('GET', '/v1/agents')).agents; };
const loadRules = async () => { const r = await api('GET', '/v1/rules'); S.rules = r.rules; S.suggestions = r.suggestions; };
const loadStats = async () => { S.stats = (await api('GET', '/v1/stats')).stats; };
const loadHistory = async () => { S.history = (await api('GET', '/v1/asks?status=closed&limit=300')).asks; };
const loadLedger = async () => { S.ledger = (await api('GET', '/v1/ledger?limit=200')).entries; };
const loadConfig = async () => { S.config = await api('GET', '/v1/config'); };
const loadIntegrations = async () => { S.integrations = (await api('GET', '/v1/integrations')).integrations; };
const loadKeys = async () => { S.keys = (await api('GET', '/v1/keys')).keys; };
const loadNow = async () => { S.now = await api('GET', '/v1/now'); };
const loadCalendar = async () => { S.calendar = await api('GET', '/v1/calendar'); };

const isOpen = (a) => a.status === 'pending' || a.status === 'unread';
const visible = (a) => isOpen(a) && !S.hidden.has(a.id);
const isSnoozed = (a) => a.delivery?.mode === 'snoozed';
const byUrgency = (a, b) => URG.indexOf(b.urgency) - URG.indexOf(a.urgency) || (a.deadline ?? Infinity) - (b.deadline ?? Infinity) || a.created_at - b.created_at;
const isLoud = (a) => ['interrupted', 'queued'].includes(a.delivery?.mode);

function lists() {
  const all = [...S.asks.values()].filter(visible);
  const decisions = all.filter((a) => a.kind !== 'inform' && !isSnoozed(a)).sort(byUrgency);
  return {
    now: decisions.filter(isLoud),
    quiet: decisions.filter((a) => !isLoud(a)),
    updates: all.filter((a) => a.kind === 'inform' && !isSnoozed(a)).sort((a, b) => b.created_at - a.created_at),
    snoozed: all.filter(isSnoozed).sort((a, b) => a.delivery.until - b.delivery.until),
  };
}

/** Items in the order the keyboard walks them, for the current view. */
function currentList() {
  const L = lists();
  if (S.view === 'inbox') return [...L.now, ...L.quiet];
  if (S.view === 'updates') return L.updates;
  if (S.view === 'snoozed') return L.snoozed;
  return [];
}
function selected() {
  const list = currentList();
  return list.find((a) => a.id === S.selId) || list[0] || null;
}

// --------------------------------------------------------------- actions

/** Hide an item now and run the real request once the undo window passes (like Gmail's undo send). */
function commitLater(a, { msg, sub, run }) {
  const leaving = document.getElementById(a.id);
  const neighbour = nextAfter(a.id);
  const finish = () => {
    S.hidden.add(a.id);
    if (S.selId === a.id) S.selId = neighbour;
    S.menu = null;
    render();
  };
  if (leaving && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
    leaving.classList.add('leaving');
    setTimeout(finish, 170);
  } else finish();

  const tight = a.deadline && a.deadline - Date.now() < UNDO_MS + 2000;
  const p = { id: a.id, run };
  const commit = async () => {
    S.pending = S.pending.filter((x) => x !== p);
    try {
      await run();
    } catch (err) {
      S.hidden.delete(a.id);
      render();
      if (err.status === 409) toast('Already settled', { sub: err.message });
      else fail(err);
    }
  };
  if (tight) {
    commit();
    toast(msg, { sub });
    return;
  }
  p.timer = setTimeout(commit, UNDO_MS);
  p.commit = commit;
  S.pending.push(p);
  toast(msg, {
    sub,
    ms: UNDO_MS,
    action: { label: 'Undo', fn: () => undo(p) },
  });
}

function undo(p = S.pending.at(-1)) {
  if (!p) return false;
  clearTimeout(p.timer);
  S.pending = S.pending.filter((x) => x !== p);
  S.hidden.delete(p.id);
  S.selId = p.id;
  S.seen.delete(p.id);
  render();
  return true;
}

function nextAfter(id) {
  const list = currentList();
  const i = list.findIndex((a) => a.id === id);
  return (list[i + 1] || list[i - 1] || {}).id ?? null;
}

function answer(a, option) {
  const d = S.drafts.get(a.id) || {};
  const label = optLabel(a, option);
  const note = (d.note || '').trim();
  if (a.review && option === 'changes' && !note) {
    toast('Add a comment so the agent knows what to change', { error: true });
    $(`[data-note="${a.id}"]`)?.focus();
    return;
  }
  commitLater(a, {
    msg: `Sent “${label}”${note ? ' with your note' : ''} to ${a.agent.name}`,
    sub: d.always ? 'Saved as a rule: Switchboard will answer this for you next time' : note ? `“${trunc(note, 60)}”` : '',
    run: async () => { await api('POST', `/v1/asks/${a.id}/answer`, { option, text: note || undefined, always: !!d.always, surface: 'web' }, { keepalive: true }); S.drafts.delete(a.id); },
  });
}

function submitInput(a) {
  const body = { surface: 'web' };
  if (a.input?.schema) {
    body.values = {};
    for (const el of $$(`[data-id="${a.id}"][data-field]`)) body.values[el.dataset.field] = el.type === 'checkbox' ? el.checked : el.type === 'number' && el.value !== '' ? Number(el.value) : el.value;
    const missing = (a.input.schema.required || []).filter((k) => body.values[k] == null || body.values[k] === '');
    if (missing.length) return toast(`Fill in ${missing.join(', ')}`, { error: true });
  } else {
    body.text = ($(`[data-text="${a.id}"]`)?.value ?? '').trim();
    if (!body.text) { $(`[data-text="${a.id}"]`)?.focus(); return toast('Type an answer first'); }
  }
  commitLater(a, {
    msg: `Sent your answer to ${a.agent.name}`,
    sub: body.text ? `“${trunc(body.text, 60)}”` : '',
    run: async () => { await api('POST', `/v1/asks/${a.id}/answer`, body, { keepalive: true }); S.drafts.delete(a.id); },
  });
}

function dismiss(a) {
  const def = defaultOpt(a);
  commitLater(a, {
    msg: a.kind === 'inform' ? 'Marked not useful' : 'Dismissed',
    sub: a.kind === 'inform' ? `${a.agent.name} will interrupt you less` : `${a.agent.name} ${def ? `gets “${def.label}”` : 'is told no'} and will interrupt you less`,
    run: () => api('POST', `/v1/asks/${a.id}/dismiss`, { surface: 'web' }, { keepalive: true }),
  });
}

function ack(a) {
  commitLater(a, { msg: 'Marked as read', run: () => api('POST', `/v1/asks/${a.id}/ack`, { surface: 'web' }, { keepalive: true }) });
}

function ackAll() {
  const items = lists().updates;
  if (!items.length) return;
  for (const a of items) S.hidden.add(a.id);
  S.selId = null;
  render();
  const p = {
    id: null,
    run: async () => { for (const a of items) await api('POST', `/v1/asks/${a.id}/ack`, { surface: 'web' }, { keepalive: true }).catch(() => {}); },
  };
  p.timer = setTimeout(async () => { S.pending = S.pending.filter((x) => x !== p); await p.run(); }, UNDO_MS);
  S.pending.push(p);
  const restore = () => { clearTimeout(p.timer); S.pending = S.pending.filter((x) => x !== p); for (const a of items) S.hidden.delete(a.id); render(); };
  p.undo = restore;
  toast(`Marked ${plural(items.length, 'update')} as read`, { ms: UNDO_MS, action: { label: 'Undo', fn: restore } });
}

function snoozeChoices(a) {
  const now = Date.now();
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(9, 0, 0, 0);
  const out = [
    { key: '5m', label: 'In 5 minutes', at: now + 5 * 60000 },
    { key: '15m', label: 'In 15 minutes', at: now + 15 * 60000 },
    { key: '1h', label: 'In 1 hour', at: now + 3600000 },
    { key: '3h', label: 'In 3 hours', at: now + 3 * 3600000 },
    { key: 'tomorrow', label: 'Tomorrow morning', at: tomorrow.getTime() },
  ];
  const def = defaultOpt(a);
  return out.map((c) => ({ ...c, blocked: a.deadline && c.at >= a.deadline ? (def ? `After the deadline. “${def.label}” would apply first` : 'After the deadline') : null }));
}

async function snooze(a, choice) {
  S.menu = null;
  const leaving = document.getElementById(a.id);
  if (leaving) leaving.classList.add('leaving');
  const neighbour = nextAfter(a.id);
  try {
    const ms = Math.max(60000, choice.at - Date.now());
    await api('POST', `/v1/asks/${a.id}/snooze`, { for: `${Math.round(ms / 1000)}s`, surface: 'web' });
    a.delivery = { mode: 'snoozed', until: Date.now() + ms };
    if (S.selId === a.id) S.selId = neighbour;
    render();
    toast(`Snoozed until ${fmtWhen(Date.now() + ms)}`, {
      sub: 'It comes back to your inbox and pings you then',
      ms: 6000,
      action: { label: 'Undo', fn: () => unsnooze(a, true) },
    });
  } catch (err) {
    leaving?.classList.remove('leaving');
    fail(err);
  }
}

async function unsnooze(a, quiet = false) {
  try {
    const r = await api('POST', `/v1/asks/${a.id}/unsnooze`, { surface: 'web' });
    void r;
    S.seen.delete(a.id);
    if (!quiet) toast('Back in your inbox', { action: { label: 'Open', fn: () => go('inbox', a.id) } });
  } catch (err) { fail(err); }
}

async function setStatus(mode) {
  closeStatusMenu();
  try {
    const dur = mode === 'auto' ? undefined : S.duration || undefined;
    S.state = await api('POST', '/v1/state', { mode, for: dur });
    render();
    const st = S.state;
    if (mode === 'auto') toast(`Automatic: ${MODES[st.mode]?.label ?? st.mode} right now`, { sub: 'Following your calendar and quiet hours' });
    else toast(`${MODES[mode].label}${st.until ? ` until ${fmtWhen(st.until)}` : ''}`, { sub: MODES[mode].desc });
  } catch (err) { fail(err); }
}

async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('Copied to clipboard');
  } catch {
    toast('Copy failed. Select the text and copy it manually', { error: true });
  }
}

async function startDemo() {
  try {
    const r = await api('POST', '/v1/demo');
    if (!r.started) return toast('The sample agents are already running');
    if (S.view !== 'inbox') go('inbox');
    toast('Three sample agents are sending you 12 asks', { sub: 'Watch how many actually interrupt you', ms: 5000 });
  } catch (err) { fail(err); }
}

// ------------------------------------------------------------ inbox cards

function deliveryLine(a) {
  const d = a.delivery || {};
  const notes = (d.notes || []).filter(Boolean);
  const reason = d.reason ? d.reason.replace(/^./, (c) => c.toUpperCase()) : '';
  let lead;
  switch (d.mode) {
    case 'interrupted': lead = `Pinged you${d.bundle_size > 1 ? ` with ${plural(d.bundle_size - 1, 'other')}` : ''}${d.delivered_at ? ` at ${fmtTime(d.delivered_at)}` : ''}`; break;
    case 'queued': lead = 'Pinging you in a moment'; break;
    case 'held': lead = 'Didn’t ping you'; break;
    case 'digest': lead = d.digested_at ? `Sent in your ${fmtTime(d.digested_at)} digest` : 'Saved for your digest'; break;
    default: lead = '';
  }
  const text = [lead, reason, ...notes].filter(Boolean).join(' · ');
  return text ? `<div class="why">${I('info', 14)}<span>${esc(text)}</span></div>` : '';
}

function timer(a) {
  if (!a.deadline) return '';
  const def = defaultOpt(a);
  const prefix = a.kind === 'inform' ? 'Expires' : def ? `“${trunc(def.label, 18)}” in` : 'Expires in';
  return `<span class="timer" data-deadline="${a.deadline}" data-prefix="${esc(prefix)}" title="${esc(def ? `If you don't answer by ${fmtTime(a.deadline)}, Switchboard answers “${def.label}” for you` : `The agent stops waiting at ${fmtTime(a.deadline)}`)}">${I('clock', 13)}<span></span></span>`;
}

function snoozeMenu(a) {
  const choices = snoozeChoices(a);
  return `<div class="popover snooze-menu" role="menu" aria-label="Snooze until">
    <div class="menu-head">Remind me…</div>
    ${choices.map((c, i) => `<button class="menu-item" role="menuitem" data-act="snooze-at" data-id="${a.id}" data-i="${i}" ${c.blocked ? 'disabled' : ''}>
      <b>${esc(c.label)}</b><span class="when">${esc(fmtWhen(c.at))}</span>${c.blocked ? `<small>${esc(c.blocked)}</small>` : ''}
    </button>`).join('')}
  </div>`;
}

// ------------------------------------------------------- docs & previews

/** A small, safe Markdown renderer: everything is escaped first, then formatted. */
function renderMarkdown(src) {
  const inline = (s) => esc(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
  const lines = String(src ?? '').replace(/\r/g, '').split('\n');
  let html = '';
  let list = null;
  let para = [];
  const flush = () => {
    if (para.length) { html += `<p>${para.map(inline).join('<br>')}</p>`; para = []; }
    if (list) { html += `</${list}>`; list = null; }
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fence = /^```\s*([\w-]*)/.exec(line);
    if (fence) {
      flush();
      const code = [];
      while (++i < lines.length && !/^```/.test(lines[i])) code.push(lines[i]);
      html += fence[1] === 'diff' ? renderDiff(code.join('\n')) : `<pre class="code"><code>${esc(code.join('\n'))}</code></pre>`;
      continue;
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) { flush(); html += `<h${Math.min(6, h[1].length + 2)}>${inline(h[2])}</h${Math.min(6, h[1].length + 2)}>`; continue; }
    const li = /^\s*([-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (li) {
      if (para.length) flush();
      const kind = /\d/.test(li[1]) ? 'ol' : 'ul';
      if (list !== kind) { if (list) html += `</${list}>`; html += `<${kind}>`; list = kind; }
      html += `<li>${inline(li[2].replace(/^\[( |x)\]\s*/i, (m, x) => (x.trim() ? '☑ ' : '☐ ')))}</li>`;
      continue;
    }
    if (/^>\s?/.test(line)) { flush(); html += `<blockquote>${inline(line.replace(/^>\s?/, ''))}</blockquote>`; continue; }
    if (/^\s*([-*_])\1{2,}\s*$/.test(line)) { flush(); html += '<hr>'; continue; }
    if (!line.trim()) { flush(); continue; }
    if (list) { html += `</${list}>`; list = null; }
    para.push(line);
  }
  flush();
  return `<div class="md">${html}</div>`;
}

function renderDiff(src) {
  const rows = String(src ?? '').split('\n').map((l) => {
    const cls = /^(\+\+\+|---|diff |index )/.test(l) ? 'meta' : l.startsWith('@@') ? 'hunk' : l.startsWith('+') ? 'add' : l.startsWith('-') ? 'del' : '';
    return `<span class="${cls}">${esc(l) || ' '}</span>`;
  });
  return `<pre class="diff">${rows.join('\n')}</pre>`;
}

function renderPreview(att, p) {
  if (!p || p.state === 'loading') return '<p class="help"><span class="spinner inline" aria-hidden="true"></span> Loading…</p>';
  if (p.state === 'error') return `<div class="callout bad">${I('alert', 16)}<div>${esc(p.error)}</div></div>`;
  const d = p.data;
  if (d.error) return `<div class="callout bad">${I('alert', 16)}<div>${esc(d.error)}</div></div>`;
  if (d.content == null) return `<p class="help">This file type can’t be previewed here.${att.path ? ' Open it to have a look.' : ''}</p>`;
  const body = att.format === 'markdown' ? renderMarkdown(d.content) : att.format === 'diff' ? renderDiff(d.content) : `<pre class="code"><code>${esc(d.content)}</code></pre>`;
  return `${body}${d.truncated ? '<p class="help">Showing the first 1 MB.</p>' : ''}`;
}

async function loadPreview(id, i) {
  const key = `${id}:${i}`;
  if (S.previews.get(key)?.state === 'loading') return;
  S.previews.set(key, { state: 'loading' });
  scheduleRender();
  try {
    S.previews.set(key, { state: 'ok', data: await api('GET', `/v1/asks/${id}/attachments/${i}`) });
  } catch (err) {
    S.previews.set(key, { state: 'error', error: err.message });
  }
  scheduleRender();
}

const ATT_ICON = { markdown: 'doc', text: 'doc', diff: 'diff', code: 'code', file: 'doc' };
function attachmentsBlock(a) {
  if (!a.attachments?.length) return '';
  return `<div class="attachments">${a.attachments.map((att, i) => {
    const key = `${a.id}:${i}`;
    const open = S.previewOpen.has(key);
    const where = att.url ? att.url.replace(/^https?:\/\//, '') : att.path ? att.path : att.format === 'diff' ? 'Diff' : 'Document';
    const actions = att.url
      ? `<a class="btn sm" href="${esc(att.url)}" target="_blank" rel="noreferrer">${I('link', 14)} Open link</a>`
      : `<button class="btn sm" data-act="att-preview" data-id="${a.id}" data-i="${i}" aria-expanded="${open}">${open ? 'Hide' : 'Preview'}</button>${att.path ? `<button class="btn ghost sm" data-act="att-open" data-id="${a.id}" data-i="${i}">${I('code', 14)} Open in editor</button>` : ''}`;
    return `<div class="attachment${open ? ' is-open' : ''}">
      <div class="att-head"><span class="ico">${I(att.url ? 'link' : ATT_ICON[att.format] || 'doc', 15)}</span><div class="att-title"><b>${esc(att.title)}</b><span class="mono">${esc(trunc(where, 80))}</span></div><div class="form-actions">${actions}</div></div>
      ${open ? `<div class="att-body">${renderPreview(att, S.previews.get(key))}</div>` : ''}
    </div>`;
  }).join('')}</div>`;
}

const agentShort = (a) => a.agent.name.split(' · ')[0];

/** What an agent said in its chat, so you can answer without switching to it. */
function agentMessage(a) {
  const full = a.detail.full;
  const long = full.length > 700;
  const open = S.open.has(`msg:${a.id}`);
  return `<div class="agent-message${long && !open ? ' clipped' : ''}">${renderMarkdown(long && !open ? `${full.slice(0, 700)}…` : full)}
    ${long ? `<button class="link-btn" data-act="msg-expand" data-id="${a.id}">${open ? 'Show less' : 'Show the whole message'}</button>` : ''}</div>`;
}

function askCard(a, sel) {
  const def = defaultOpt(a);
  const draft = S.drafts.get(a.id) || {};
  const detail = a.detail || {};
  const enter = S.loaded && !S.seen.has(a.id) ? ' enter' : '';
  S.seen.add(a.id);
  const facts = [];
  if (a.delay_cost) facts.push(`${I('zap', 14)} Waiting costs <strong>${esc(a.delay_cost)}</strong>`);
  if (a.deadline && !def && a.kind !== 'inform') facts.push(`${I('alert', 14)} <span>No safe default. Switchboard will ping you before it expires</span>`);
  if (a.reversible === true) facts.push(`${I('undo', 14)} Can be undone`);

  let body = '';
  if (a.kind === 'decision') {
    // A note travels with whichever option you pick; on reviews it's the comments box.
    const noteOpen = a.review || S.noteOpen.has(a.id) || draft.note;
    const note = noteOpen
      ? `<label class="field note"><span>${a.review ? `Comments for ${esc(agentShort(a))}` : 'Note'} <small>${a.review ? 'needed if you request changes' : `sent to ${esc(agentShort(a))} with your answer`}</small></span><textarea class="input" rows="${a.review ? 3 : 2}" data-note="${a.id}" placeholder="${a.review ? 'What should change?' : 'e.g. Use staging instead'}">${esc(draft.note || '')}</textarea></label>`
      : '';
    body = `${note}<div class="options" role="group" aria-label="Options">${a.options.map((o, k) => `
      <button class="opt ${esc(o.style || '')}" data-act="answer" data-id="${a.id}" data-opt="${esc(o.id)}" aria-keyshortcuts="${k + 1}">
        <span class="l">${esc(o.label)}${def?.id === o.id ? '<span class="def" title="Applied automatically if you don\'t answer in time">Default</span>' : ''}<span class="k">${k + 1}</span></span>
        ${o.consequence ? `<span class="c">${esc(o.consequence)}</span>` : ''}
      </button>`).join('')}</div>`;
  } else if (a.kind === 'input') {
    const schema = a.input?.schema;
    const fields = schema
      ? Object.entries(schema.properties).map(([k, p]) => {
        const req = (schema.required || []).includes(k);
        const v = draft.values?.[k] ?? p.default ?? '';
        const label = `${esc(p.title || k)}${req ? '' : ' <small>(optional)</small>'}`;
        const attrs = `data-field="${esc(k)}" data-id="${a.id}" ${req ? 'required' : ''}`;
        if (p.enum) return `<label class="field"><span>${label}</span><select ${attrs}>${p.enum.map((e, j) => `<option value="${esc(e)}" ${String(v) === String(e) ? 'selected' : ''}>${esc(p.enumNames?.[j] ?? e)}</option>`).join('')}</select></label>`;
        if (p.type === 'boolean') return `<label class="check-row"><input type="checkbox" ${attrs} ${v === true ? 'checked' : ''}> ${label}</label>`;
        const type = p.type === 'number' || p.type === 'integer' ? 'number' : p.format === 'email' ? 'email' : 'text';
        return `<label class="field"><span>${label}</span><input ${attrs} type="${type}" value="${esc(v)}" placeholder="${esc(p.description || '')}"></label>`;
      }).join('')
      : `<label class="field"><span class="visually-hidden">Your answer</span><textarea rows="2" data-text="${a.id}" placeholder="${esc(a.input?.placeholder || 'Type your answer')}">${esc(draft.text || '')}</textarea></label>`;
    const sendLabel = a.metadata?.reply ? `Send to ${esc(agentShort(a))}` : 'Send';
    body = `<div class="form">${fields}<div class="form-actions"><button class="btn primary" data-act="submit" data-id="${a.id}">${sendLabel} <kbd>Ctrl</kbd><kbd>↵</kbd></button>${a.options.map((o) => `<button class="btn" data-act="answer" data-id="${a.id}" data-opt="${esc(o.id)}">${esc(o.label)}</button>`).join('')}</div></div>`;
  }
  const fromChat = a.metadata?.reply && detail.full;
  const canNote = a.kind === 'decision' && !a.review && !S.noteOpen.has(a.id) && !draft.note;

  const canAlways = a.kind === 'decision' && a.reversible !== false;
  const menuOpen = S.menu?.type === 'snooze' && S.menu.id === a.id;
  return `<article class="card u-${a.urgency}${sel ? ' sel' : ''}${enter}" id="${a.id}" data-card="${a.id}" aria-labelledby="q-${a.id}">
    <div class="card-head">
      ${avatar(a.agent)}
      <div class="who"><b>${esc(a.agent.name)}</b><span title="${esc(new Date(a.created_at).toLocaleString())}">${fmtAgo(a.created_at)}</span></div>
      <div class="badges">
        ${a.urgency === 'critical' ? `<span class="badge critical">${I('alert', 12)} Critical</span>` : a.urgency === 'high' ? '<span class="badge high">Urgent</span>' : ''}
        ${a.reversible === false ? `<span class="badge irrev" title="The agent says this can't be undone">${I('lock', 12)} Can't be undone</span>` : ''}
      </div>
      ${timer(a)}
    </div>
    <h2 class="question" id="q-${a.id}">${a.review ? `<span class="badge review">${I('doc', 12)} Review</span> ` : ''}${esc(a.question)}</h2>
    ${detail.line ? `<p class="subline">${esc(detail.line)}</p>` : ''}
    ${facts.length ? `<div class="facts">${facts.map((f) => `<span>${f}</span>`).join('')}</div>` : ''}
    ${fromChat ? agentMessage(a) : a.review && detail.paragraph ? `<p class="subline">${esc(detail.paragraph)}</p>` : detail.paragraph || detail.full ? `<details class="more" data-more="${a.id}" ${S.open.has(a.id) ? 'open' : ''}><summary>More context</summary>${detail.paragraph ? `<p>${esc(detail.paragraph)}</p>` : ''}${detail.full ? `<pre class="full">${esc(detail.full)}</pre>` : ''}</details>` : ''}
    ${attachmentsBlock(a)}
    ${body}
    <div class="card-foot">
      ${canNote ? `<button class="btn ghost sm" data-act="note-toggle" data-id="${a.id}">${I('plus', 14)} Add a note</button>` : ''}
      ${canAlways && !a.review ? `<label class="toggle" title="Make a rule: next time this exact request comes in, Switchboard answers the same way without asking you"><input type="checkbox" data-always="${a.id}" ${draft.always ? 'checked' : ''}><span class="sw"></span><span>Always do this${a.fingerprint ? ` for <code>${esc(trunc(a.fingerprint, 40))}</code>` : ''}</span></label>` : ''}
      <span class="grow"></span>
      <span class="menu-anchor">
        <button class="btn ghost sm" data-act="snooze-menu" data-id="${a.id}" aria-haspopup="menu" aria-expanded="${menuOpen}" aria-keyshortcuts="s">${I('clock', 15)} Snooze</button>
        ${menuOpen ? snoozeMenu(a) : ''}
      </span>
      <button class="btn ghost sm" data-act="dismiss" data-id="${a.id}" aria-keyshortcuts="d" title="${esc(def ? `Answers “${def.label}” and` : 'Answers no and')} tells Switchboard this wasn't worth your attention">${I('x', 15)} Dismiss</button>
    </div>
    ${deliveryLine(a)}
  </article>`;
}

// ------------------------------------------------------------------ views

function pageHead(title, sub, right = '') {
  return `<div class="page-head"><div class="grow"><h1>${title}</h1>${sub ? `<p>${sub}</p>` : ''}</div>${right}</div>`;
}

function emptyState(icon, title, text, extra = '') {
  return `<div class="empty"><div class="art">${I(icon, 26)}</div><h2>${title}</h2><p>${text}</p>${extra}</div>`;
}

const cmdBox = (cmd) => `<div class="cmd"><code>${esc(cmd)}</code><button class="btn ghost sm" data-act="copy" data-text="${esc(cmd)}" aria-label="Copy command">${I('copy', 14)} Copy</button></div>`;

function viewInbox() {
  const selOn = !!S.selId;
  const L = lists();
  const total = L.now.length + L.quiet.length;
  const sel = selOn ? selected() : null;
  const soonest = [...L.now, ...L.quiet].filter((a) => a.deadline).sort((a, b) => a.deadline - b.deadline)[0];
  const sub = total
    ? `${plural(total, 'decision')} waiting${soonest ? ` · next deadline <span data-deadline="${soonest.deadline}" data-prefix="in"></span>` : ''}`
    : '';
  const head = pageHead('Needs you', sub);
  if (!total) {
    const s = S.stats || {};
    const checklist = S.loaded ? setupChecklist({ compact: !!s.asks }) : '';
    if (checklist && !s.asks) return head + checklist;
    return head + checklist + emptyState('check', 'You’re all caught up', s.asks
      ? `Switchboard has handled ${plural(s.asks, 'request')} and interrupted you ${plural(s.notifications || 0, 'time')}. New decisions will show up here.`
      : 'When an agent needs a decision, it lands here.', `<button class="btn" data-act="demo">${I('play', 14)} Try with sample agents</button>`);
  }
  let html = head;
  if (L.now.length) {
    if (L.quiet.length) html += `<div class="section-title">${I('bell', 14)} Pinged you <span class="hint">· ${L.now.length}</span></div>`;
    html += L.now.map((a) => askCard(a, a === sel)).join('');
  }
  if (L.quiet.length) {
    html += `<div class="section-title">${I('clock', 14)} Didn't ping you <span class="hint">· waiting quietly until you have a moment</span></div>`;
    html += L.quiet.map((a) => askCard(a, a === sel)).join('');
  }
  return html;
}

/** Continue an agent's conversation from Switchboard: your message goes into that session. */
function replyBox(a) {
  const d = S.drafts.get(a.id) || {};
  return `<div class="reply-box detail">
    <label class="field"><span>Reply to ${esc(agentShort(a))} <small>continues the same session${a.metadata.reply.cwd ? ` in <span class="mono">${esc(a.metadata.reply.cwd.split(/[\\/]/).pop())}</span>` : ''}</small></span>
    <textarea class="input" rows="2" data-reply="${a.id}" placeholder="e.g. Yes, go ahead and open the PR">${esc(d.reply || '')}</textarea></label>
    <div class="form-actions"><button class="btn primary sm" data-act="reply-send" data-id="${a.id}">${I('reply', 14)} Send to ${esc(agentShort(a))}</button><span class="help" style="margin:0">Its answer comes back here when it’s done.</span></div>
  </div>`;
}

async function sendReplyTo(a) {
  const text = (S.drafts.get(a.id)?.reply || $(`[data-reply="${a.id}"]`)?.value || '').trim();
  if (!text) { $(`[data-reply="${a.id}"]`)?.focus(); return toast('Type a reply first'); }
  try {
    const r = await api('POST', `/v1/asks/${a.id}/reply`, { text });
    S.replyOpen.delete(a.id);
    S.drafts.delete(a.id);
    if (r.queued) toast(`Sending to ${agentShort(a)}…`); // the result arrives as a live event
    render();
  } catch (err) { fail(err); }
}

function replyFailed(r) {
  toast(`Couldn’t reach ${r.name || 'the agent'}`, { sub: r.error || '', error: true, ms: 10000, action: r.command ? { label: 'Copy command', fn: () => copy(r.command) } : null });
}

function viewUpdates() {
  const selOn = !!S.selId;
  const items = lists().updates;
  const sel = selOn ? selected() : null;
  const head = pageHead('Updates', items.length ? `${plural(items.length, 'unread update')} from your agents. These never interrupt you unless they're urgent.` : 'Status reports from your agents. They arrive in digests instead of pinging you.',
    items.length > 1 ? `<button class="btn" data-act="ack-all">${I('checks', 15)} Mark all read</button>` : '');
  if (!items.length) return head + emptyState('bell', 'No unread updates', 'When agents finish things or have news, it collects here quietly.');
  return `${head}<div class="list">${items.map((a) => {
    const open = S.open.has(a.id);
    const detail = a.detail || {};
    const more = detail.line || detail.paragraph || detail.full;
    const enter = S.loaded && !S.seen.has(a.id) ? ' enter' : '';
    S.seen.add(a.id);
    return `<div class="item clickable${a === sel ? ' sel' : ''}${enter}" id="${a.id}" data-act="toggle" data-id="${a.id}" aria-expanded="${open}">
      ${avatar(a.agent)}
      <div><div class="title unread">${esc(a.question)}</div><div class="sub"><span>${esc(a.agent.name)}</span><span>·</span><span>${fmtAgo(a.created_at)}</span>${a.urgency === 'high' || a.urgency === 'critical' ? '<span class="badge high">Urgent</span>' : ''}</div></div>
      <div class="side">
        ${a.metadata?.reply ? `<button class="btn ghost sm" data-act="reply-toggle" data-id="${a.id}" aria-expanded="${S.replyOpen.has(a.id)}">${I('reply', 15)} Reply</button>` : ''}
        <button class="btn ghost sm" data-act="ack" data-id="${a.id}" title="Mark read (Enter)">${I('check', 15)} Read</button>
        <button class="icon-btn" data-act="dismiss" data-id="${a.id}" title="Not useful: this agent interrupts you less" aria-label="Not useful">${I('x', 15)}</button>
      </div>
      ${open && more ? `<div class="detail">${detail.line ? `<p>${esc(detail.line)}</p>` : ''}${detail.paragraph ? `<p>${esc(detail.paragraph)}</p>` : ''}${detail.full ? (a.metadata?.reply ? renderMarkdown(detail.full) : `<pre class="full">${esc(detail.full)}</pre>`) : ''}</div>` : ''}
      ${S.replyOpen.has(a.id) ? replyBox(a) : ''}
    </div>`;
  }).join('')}</div>`;
}

function viewSnoozed() {
  const selOn = !!S.selId;
  const items = lists().snoozed;
  const sel = selOn ? selected() : null;
  const head = pageHead('Snoozed', 'Each one comes back to your inbox and pings you when its snooze ends.');
  if (!items.length) return head + emptyState('clock', 'Nothing snoozed', 'Snooze a request from your inbox to get it out of the way until later.');
  return `${head}<div class="list">${items.map((a) => `<div class="item${a === sel ? ' sel' : ''}" id="${a.id}">
      ${avatar(a.agent)}
      <div><div class="title">${esc(a.question)}</div><div class="sub"><span>${esc(a.agent.name)}</span><span>·</span><span>Back at ${esc(fmtWhen(a.delivery.until))} (<span data-deadline="${a.delivery.until}" data-prefix="in"></span>)</span>${a.deadline ? `<span>·</span><span>deadline ${esc(fmtWhen(a.deadline))}</span>` : ''}</div></div>
      <div class="side"><button class="btn sm" data-act="unsnooze" data-id="${a.id}">${I('wake', 15)} Bring back now</button></div>
    </div>`).join('')}</div>`;
}

function outcome(a) {
  const ans = a.answer || {};
  const opt = ans.option ? optLabel(a, ans.option) : null;
  const val = opt ?? (ans.text ? `“${trunc(ans.text, 50)}”` : ans.values ? 'Form sent' : '');
  const via = { web: 'in the inbox', phone: 'from your phone', cli: 'from the terminal', api: 'via API', deadline: 'at the deadline' }[ans.surface] || (ans.surface ? `via ${ans.surface}` : '');
  switch (a.status) {
    case 'answered': return { icon: 'check', cls: 'ok', text: `You answered ${val ? `“${val.replace(/^“|”$/g, '')}”` : ''} ${via}${ans.latency_ms ? ` · ${fmtLeft(ans.latency_ms)} after the ping` : ''}` };
    case 'auto': return { icon: 'sparkle', cls: 'rule', text: `Answered “${val}” by your rule` };
    case 'defaulted': return { icon: 'clock', cls: 'def', text: `No answer in time. Default “${val}” applied` };
    case 'dismissed': return { icon: 'x', cls: 'bad', text: `Dismissed${val ? `. Agent got “${val}”` : ''}` };
    case 'expired': return { icon: 'alert', cls: 'bad', text: 'Expired with no answer' };
    case 'cancelled': return { icon: 'x', cls: '', text: 'Withdrawn by the agent' };
    case 'read': return { icon: 'check', cls: '', text: ans.by === 'collapsed' ? 'Replaced by a newer update' : ans.by === 'rule' || String(ans.by).startsWith('rule') ? 'Muted by your rule' : 'Read' };
    default: return { icon: 'info', cls: '', text: a.status };
  }
}

const HIST_FILTERS = [
  ['all', 'All', () => true],
  ['you', 'You answered', (a) => a.status === 'answered'],
  ['rules', 'By rules', (a) => a.status === 'auto'],
  ['defaults', 'Defaults', (a) => a.status === 'defaulted' || a.status === 'expired'],
  ['dismissed', 'Dismissed', (a) => a.status === 'dismissed'],
  ['updates', 'Updates', (a) => a.kind === 'inform'],
];

function viewHistory() {
  const q = S.histQuery.trim().toLowerCase();
  const match = (a) => !q || `${a.question} ${a.agent.name}`.toLowerCase().includes(q);
  const filters = HIST_FILTERS.map(([key, label, fn]) => `<button class="chip-btn" data-act="hist-filter" data-key="${key}" aria-pressed="${S.histFilter === key}">${label}<span class="n">${S.history.filter((a) => fn(a) && match(a)).length}</span></button>`).join('');
  const fn = HIST_FILTERS.find(([k]) => k === S.histFilter)[2];
  const items = S.history.filter((a) => fn(a) && match(a));
  let html = pageHead('History', 'Everything your agents asked, and how it was settled.');
  html += `<div class="toolbar"><div class="chips" role="group" aria-label="Filter">${filters}</div><input class="input search" type="search" placeholder="Search" aria-label="Search history" data-hist-search value="${esc(S.histQuery)}"></div>`;
  if (!items.length) return html + emptyState('history', S.history.length ? 'Nothing matches' : 'No history yet', S.history.length ? 'Try a different filter or search.' : 'Answered, defaulted and dismissed requests show up here.');
  let day = null;
  let rows = '';
  for (const a of items) {
    const t = a.resolved_at || a.created_at;
    const label = dayLabel(t);
    if (label !== day) {
      if (day !== null) rows += '</div>';
      rows += `<div class="day">${label}</div><div class="list">`;
      day = label;
    }
    const o = outcome(a);
    const open = S.open.has(a.id);
    rows += `<div class="item clickable" data-act="toggle" data-id="${a.id}" role="button" tabindex="0" aria-expanded="${open}">
      <span class="ico ${o.cls}">${I(o.icon, 15)}</span>
      <div><div class="title">${esc(a.question)}</div><div class="sub"><span>${esc(a.agent.name)}</span><span>·</span><span>${esc(o.text)}</span></div></div>
      <div class="side">${fmtTime(t)}</div>
      ${open ? `<div class="detail">${a.delivery?.reason ? `<p>${I('info', 13)} ${esc(`${{ interrupted: 'Pinged you', held: 'Didn’t ping you', digest: 'Went to your digest', auto: 'Handled by a rule', muted: 'Muted', 'settled-before-ping': 'Settled before Switchboard pinged you' }[a.delivery.mode] || a.delivery.mode}: ${a.delivery.reason}`)}</p>` : ''}${a.answer?.option && a.answer?.text ? `<p>${I('reply', 13)} Your note: “${esc(a.answer.text)}”</p>` : ''}${a.reply_result ? (a.reply_result.state === 'failed' ? `<div class="callout bad">${I('alert', 16)}<div>Couldn’t send your reply to ${esc(a.reply_result.name || 'the agent')}: ${esc(a.reply_result.error || '')}${a.reply_result.command ? cmdBox(a.reply_result.command) : ''}</div></div>` : `<p>${I('check', 13)} Your reply went to ${esc(a.reply_result.name || 'the agent')}${a.reply_result.state === 'sending' ? '…' : '.'}</p>`) : ''}${a.metadata?.reply ? `<div class="form-actions"><button class="btn sm" data-act="reply-toggle" data-id="${a.id}">${I('reply', 14)} ${a.reply_result?.state === 'failed' ? 'Try again' : `Reply to ${esc(agentShort(a))}`}</button></div>${S.replyOpen.has(a.id) ? replyBox(a) : ''}` : ''}${a.detail?.paragraph ? `<p>${esc(a.detail.paragraph)}</p>` : ''}${a.status === 'auto' && String(a.answer?.by).startsWith('rule:') && S.rules.some((r) => r.id === a.answer.by.slice(5)) ? `<div class="form-actions"><button class="btn sm" data-act="rule-rm" data-id="${esc(a.answer.by.slice(5))}">Stop answering this for me</button></div>` : ''}</div>` : ''}
    </div>`;
  }
  return `${html}${rows}</div>`;
}

function viewAgents() {
  let html = pageHead('Agents', 'Each agent gets a ping budget. Act on its pings and it grows. Dismiss them and it shrinks, so noisy agents quiet down on their own.');
  if (!S.agents.length) return html + emptyState('bot', 'No agents yet', 'Agents show up here the first time they ask you something.', `<button class="btn" data-act="demo">${I('play', 14)} Try with sample agents</button>`);
  html += `<div class="agents">${S.agents.map((g) => {
    const pct = Math.min(100, (g.tokens / Math.max(1, g.capacity)) * 100);
    const cred = Math.round(g.credibility * 100);
    return `<div class="agent-card${g.muted ? ' is-muted' : ''}">
      <div class="card-head">${avatar(g)}<div class="who"><b>${esc(g.name)}</b><span class="mono">${esc(g.id)}</span></div>${g.muted ? `<span class="badge muted" style="margin-left:auto">${I('mute', 12)} Muted</span>` : ''}</div>
      <div>
        <div class="meter-label"><span>Pings left this hour</span><b>${Math.floor(g.tokens * 10) / 10} of ${Math.round(g.capacity * 10) / 10}</b></div>
        <div class="meter" role="meter" aria-valuemin="0" aria-valuemax="${g.capacity}" aria-valuenow="${g.tokens}" aria-label="Ping budget"><i class="${pct < 34 ? 'low' : ''}" style="width:${pct}%"></i></div>
      </div>
      <div class="meter-label" style="margin:0" title="Share of this agent's urgent asks you acted on. Below 50%, its urgent asks are treated as one level lower."><span>Credibility when it says “urgent”</span><b class="${cred < 50 ? 'bad-t' : ''}">${cred}%</b></div>
      <div class="stat-row"><div><b>${g.asks}</b><span>asks</span></div><div><b>${g.interrupts}</b><span>pinged you</span></div><div><b>${g.answered}</b><span>answered</span></div><div><b>${g.dismissed}</b><span>dismissed</span></div></div>
      <div class="form-actions">
        <button class="btn sm" data-act="mute" data-agent="${esc(g.id)}" data-muted="${g.muted ? 0 : 1}">${g.muted ? `${I('sound', 14)} Unmute` : `${I('mute', 14)} Mute`}</button>
        <button class="btn ghost sm" data-act="reset" data-agent="${esc(g.id)}" title="Restore the default budget and credibility">Reset budget</button>
      </div>
    </div>`;
  }).join('')}</div>`;
  return html;
}

const ROUTE_TEXT = { now: 'always ping me', digest: 'send it to my digest', hold: 'never ping me (keep it in the inbox)', mute: 'mute it' };
function ruleSentence(r) {
  const m = r.match || {};
  const parts = [];
  if (m.agent) parts.push(`from <b>${esc(m.agent)}</b>`);
  if (m.fingerprint) parts.push(`matching <code>${esc(m.fingerprint)}</code>`);
  if (m.question) parts.push(`asking <code>${esc(m.question)}</code>`);
  if (m.kind) parts.push(`of kind <b>${esc(m.kind)}</b>`);
  if (m.urgency) parts.push(`with <b>${esc(m.urgency)}</b> urgency`);
  if (m.tags) parts.push(`tagged <code>${esc([].concat(m.tags).join(', '))}</code>`);
  const then = r.action?.answer != null ? `answer <b>${esc(r.action.answer)}</b> for me` : esc(ROUTE_TEXT[r.action?.route] || r.action?.route);
  return `When a request ${parts.join(' ') || 'of any kind'} comes in, ${then}.`;
}

function viewRules() {
  let html = pageHead('Rules', 'Rules answer or route requests for you, so you only see what needs a human.',
    `<button class="btn${S.ruleForm ? '' : ' primary'}" data-act="rule-form">${S.ruleForm ? 'Cancel' : `${I('plus', 15)} New rule`}</button>`);
  if (S.ruleForm) {
    html += `<form id="rule-form" class="panel form" autocomplete="off">
      <h2>New rule</h2>
      <p class="help" style="margin:0 0 6px">Fill in what to match (leave a field empty to match anything), then what Switchboard should do. <code>*</code> matches any text and <code>|</code> means “or”.</p>
      <div class="grid2">
        <label class="field">Agent <input name="agent" placeholder="e.g. Email agent or claude-code-*"></label>
        <label class="field"><span>Request <small>fingerprint</small></span><input name="fingerprint" placeholder="e.g. Bash:npm test*"></label>
        <label class="field">Urgency<select name="urgency"><option value="">Any</option><option value="low">Low</option><option value="normal">Normal</option><option value="high">Urgent</option><option value="critical">Critical</option></select></label>
        <label class="field">Kind<select name="kind"><option value="">Any</option><option value="decision">Decision</option><option value="input">Question</option><option value="inform">Update (FYI)</option></select></label>
        <label class="field">Then<select name="then"><option value="answer">Answer with an option</option><option value="now">Always ping me</option><option value="digest">Send to my digest</option><option value="hold">Never ping me (keep in inbox)</option><option value="mute">Mute updates</option></select></label>
        <label class="field" data-answer-field>Option to answer<input name="answer" placeholder="e.g. allow"></label>
      </div>
      <div class="form-actions"><button class="btn primary" type="submit">Create rule</button><button class="btn ghost" type="button" data-act="rule-form">Cancel</button></div>
    </form>`;
  }
  if (S.suggestions.length) {
    html += `<div class="section-title">${I('sparkle', 14)} Suggested from your answers</div>`;
    html += S.suggestions.map((s) => `<div class="suggestion">
      <div class="card-head" style="margin:0">${avatar(s.agent)}<div class="who"><b>${esc(s.agent.name)}</b><span>${esc(s.why || `You answered “${s.label}” ${s.count} times in a row`)}</span></div></div>
      <p class="sentence">${s.kind === 'route' ? esc(s.sentence)
        : s.glob ? `Answer <b>“${esc(s.label)}”</b> automatically to anything ${esc(s.agent.name)} asks that matches <code>${esc(s.fingerprint)}</code>?`
          : `Answer <b>“${esc(s.label)}”</b> automatically whenever ${esc(s.agent.name)} asks <code>${esc(s.fingerprint)}</code>?`}</p>
      ${s.examples?.length ? `<p class="help" style="margin:-6px 0 12px">For example: ${s.examples.map((x) => `<code>${esc(x)}</code>`).join(' ')}</p>` : ''}
      <div class="form-actions"><button class="btn primary" data-act="sug-accept" data-id="${s.id}">${I('check', 15)} ${s.kind === 'route' ? 'Yes, use the digest' : 'Make it a rule'}</button><button class="btn ghost" data-act="sug-decline" data-id="${s.id}">Keep asking me</button></div>
    </div>`).join('');
  }
  html += `<div class="section-title">Your rules <span class="hint">· checked top to bottom</span></div>`;
  if (!S.rules.length) {
    html += emptyState('rules', 'No rules yet', 'Turn on “Always do this” when you answer, accept a suggestion, or create one yourself.');
  } else {
    html += `<div class="list">${S.rules.map((r) => `<div class="rule">
      <div><div class="sentence">${ruleSentence(r)}</div><div class="sub">Used ${plural(r.hits || 0, 'time')} · ${{ learned: 'learned from your answers', always: 'from “Always do this”', user: 'added by you' }[r.source] || esc(r.source || '')}${r.note ? ` · ${esc(r.note)}` : ''}</div></div>
      <button class="icon-btn" data-act="rule-rm" data-id="${r.id}" aria-label="Delete rule" title="Delete rule">${I('trash', 16)}</button>
    </div>`).join('')}</div>`;
  }
  return html;
}

const LEDGER_TEXT = {
  'ask.created': (d) => ['New request', `${d.agent?.name}: ${d.question}`],
  'ask.routed': (d) => ['Routed', `${{ queued: 'Will ping you', held: 'Held', digest: 'To digest', snoozed: 'Snoozed', interrupted: 'Pinged' }[d.mode] || d.mode}: ${d.reason}`],
  'ask.resolved': (d) => ['Settled', `${d.status}${d.answer?.option ? ` → ${d.answer.option} (by ${d.answer.by})` : ''}`],
  'bundle.delivered': (d) => ['Pinged you', `${plural(d.asks.length, 'request')}${d.digest?.length ? ` + ${plural(d.digest.length, 'update')}` : ''} via ${d.surfaces.join(', ')}`],
  'state.changed': (d) => ['Status', `${d.from} → ${d.to} (${d.source})`],
  'ask.snoozed': (d) => ['Snoozed', `until ${fmtWhen(d.until)}`],
  'ask.unsnoozed': () => ['Unsnoozed', 'brought back to the inbox'],
};

function viewActivity() {
  const v = S.verify;
  let html = pageHead('Activity log', 'Every request, routing decision and answer, in a tamper-evident log. Each entry includes the hash of the one before it, so editing history breaks the chain.');
  html += `<div class="panel verify">
    <button class="btn" data-act="verify">${I('shield', 15)} Verify the chain</button>
    ${v ? (v.ok ? `<span class="state-pill ok">${I('check', 14)} Intact · ${plural(v.count, 'entry', 'entries')}</span><span class="hash mono">head ${esc(v.head?.slice(0, 16) || '')}…</span>` : `<span class="state-pill bad">${I('alert', 14)} Broken at entry ${v.broken_at}</span><span class="hash">${esc(v.reason)}</span>`) : '<span class="help" style="margin:0">Checks every hash from the first entry to the last.</span>'}
  </div>`;
  if (!S.ledger.length) return html + emptyState('shield', 'Nothing logged yet', 'Entries appear as soon as an agent asks you something.');
  html += `<div class="list">${S.ledger.map((e) => {
    const [kind, text] = (LEDGER_TEXT[e.type] || (() => [e.type, JSON.stringify(e.data).slice(0, 140)]))(e.data || {});
    return `<div class="item"><span class="ico">${esc(String(e.seq))}</span><div><div class="title">${esc(kind)}</div><div class="sub"><span>${esc(text)}</span></div></div><div class="side"><span title="${esc(new Date(e.ts).toLocaleString())}">${fmtTime(e.ts)}</span><span class="mono" title="${esc(e.hash)}">${esc(e.hash.slice(0, 8))}</span></div></div>`;
  }).join('')}</div>`;
  return html;
}

function viewSettings() {
  if (!S.config) return pageHead('Settings', '') + '<p class="help">Loading…</p>';
  const c = S.config.config;
  const q = c.quietHours || {};
  const cal = c.calendar || {};
  const n = c.ntfy || {};
  const cs = S.state?.calendar || {};
  const notif = 'Notification' in window ? Notification.permission : 'unsupported';
  const cli = S.config.cli || 'switchboard';
  const testBox = testBoxHtml();
  return viewSettingsBody(c, q, cal, n, cs, notif, cli, testBox);
}

function testBoxHtml() {
  const tr = S.testResult;
  const isWin = (tr?.platform || navigator.userAgent).toString().toLowerCase().includes('win');
  return !tr ? '' : tr.errors && Object.keys(tr.errors).length
    ? `<div class="callout bad">${I('alert', 16)}<div>Couldn't send: ${esc(Object.entries(tr.errors).map(([k, v]) => `${k}: ${v}`).join('; '))}</div></div>`
    : `<div class="callout ok">${I('check', 16)}<div><b>Sent to ${esc(tr.sent.join(' and ') || 'nothing')}.</b> Didn't see it?${isWin
      ? '<ul><li>Turn off <b>Do not disturb</b> (Windows hides banners while it’s on and files them in the notification center).</li><li>Open <b>Settings → System → Notifications</b>, find <b>Switchboard</b> and make sure <b>Show notification banners</b> is on.</li></ul>'
      : '<ul><li>Check that Focus / Do Not Disturb is off.</li><li>Allow notifications for your terminal app or “Script Editor” in system settings.</li></ul>'}</div></div>`;
}

function viewSettingsBody(c, q, cal, n, cs, notif, cli, testBox) {
  return `${pageHead('Settings', 'Changes apply right away once you save.')}
  <div class="settings-nav">${['notifications', 'phone', 'schedule', 'privacy', 'delivery', 'connect'].map((k) => `<a class="chip-btn" href="#settings/${k}" data-anchor-link="${k}">${{ notifications: 'Notifications', phone: 'Phone', schedule: 'Schedule', privacy: 'Privacy', delivery: 'Delivery', connect: 'Connect agents' }[k]}</a>`).join('')}</div>
  <form id="settings" class="form" autocomplete="off">
    <section class="panel" id="s-notifications">
      <h2>Notifications on this computer</h2>
      <p class="help">How Switchboard gets your attention when something is worth interrupting you for.</p>
      <label class="toggle"><input type="checkbox" name="desktop" ${c.desktop !== false ? 'checked' : ''}><span class="sw"></span><span>Show desktop notifications</span></label>
      <div class="form-actions" style="margin-top:12px"><button class="btn" type="button" data-act="test-notify">${I('bell', 15)} Send a test notification</button>
        <span class="help" style="margin:0">Browser notifications for this tab: <b>${esc(notif)}</b></span>
        ${notif === 'default' ? '<button class="btn ghost sm" type="button" data-act="browser-notif">Allow</button>' : ''}</div>
      <div id="test-result">${testBox}</div>
    </section>

    <section class="panel" id="s-phone">
      <h2>Phone (ntfy)</h2>
      <p class="help">Prefer Telegram? Set it up on the <a href="#connect/phone" data-view="connect">Connect</a> page. ntfy: pings with one-tap answer buttons, through the free <a href="https://ntfy.sh" target="_blank" rel="noreferrer">ntfy</a> app. Your answers come back over a signed channel, so nothing on this computer is exposed to the internet.</p>
      <div class="grid2">
        <label class="field"><span>Topic <small>treat it like a password</small></span><span style="display:flex;gap:6px"><input name="n_topic" value="${esc(n.topic || '')}" placeholder="Click Generate"><button class="btn" type="button" data-act="gen-topic">Generate</button></span></label>
        <label class="field">Send to phone<select name="n_mirror"><option value="always" ${n.mirror !== 'away' ? 'selected' : ''}>Every time Switchboard pings me</option><option value="away" ${n.mirror === 'away' ? 'selected' : ''}>Only when I'm away</option></select></label>
        <label class="field">Server<input name="n_server" value="${esc(n.server || 'https://ntfy.sh')}"></label>
        <label class="field"><span>Access token <small>optional</small></span><input name="n_token" type="password" value="${esc(n.token || '')}"></label>
      </div>
      <label class="toggle" style="margin-top:12px"><input type="checkbox" name="n_redact" ${n.redact ? 'checked' : ''}><span class="sw"></span><span>Hide the question text on my phone (more private)</span></label>
      ${n.topic ? `<div class="callout">${I('phone', 16)}<div>In the ntfy app, tap <b>+</b> and subscribe to <code>${esc(n.topic)}</code>${n.server && n.server !== 'https://ntfy.sh' ? ` on <code>${esc(n.server)}</code>` : ''}. Then send a test notification.</div></div>` : ''}
    </section>

    <section class="panel" id="s-schedule">
      <h2>Schedule</h2>
      <p class="help">When your status is set to Automatic, Switchboard uses these. A status you pick yourself always wins.</p>
      <div class="grid2">
        <label class="field">Quiet hours from<input name="q_start" type="time" value="${esc(q.start || '')}"></label>
        <label class="field">until<input name="q_end" type="time" value="${esc(q.end || '')}"></label>
        <label class="field">During quiet hours<select name="q_mode">${['dnd', 'focus', 'away'].map((m) => `<option value="${m}" ${(q.mode || 'dnd') === m ? 'selected' : ''}>${MODES[m].label}</option>`).join('')}</select></label>
      </div>
      <div class="grid2" style="margin-top:14px">
        <label class="field" style="grid-column:1/-1"><span>Calendar <small>ICS link or file. Read on this computer; agents never see your events</small></span><input name="cal_ics" value="${esc(cal.ics || '')}" placeholder="https://calendar.google.com/calendar/ical/…/basic.ics"></label>
        <label class="field">During meetings<select name="cal_mode">${['focus', 'dnd', 'away'].map((m) => `<option value="${m}" ${(cal.busyMode || 'focus') === m ? 'selected' : ''}>${MODES[m].label}</option>`).join('')}</select></label>
        <label class="field">Events that mean Do not disturb<input name="cal_kw" value="${esc((cal.dndKeywords || ['focus time', 'deep work', 'do not disturb']).join(', '))}"></label>
      </div>
      ${cs.configured ? (cs.error ? `<div class="callout bad">${I('alert', 16)}<div>Couldn't read the calendar: ${esc(cs.error)}</div></div>` : `<div class="callout ok">${I('check', 16)}<div>Calendar connected: ${plural(cs.events_next_48h, 'busy block')} in the next 48 hours.</div></div>`) : ''}
    </section>

    <section class="panel" id="s-privacy">
      <h2>Privacy</h2>
      <p class="help">Everything below stays on this computer. Agents only ever see Available, Focus, Do not disturb or Away.</p>
      <label class="toggle"><input type="checkbox" name="sessions" ${c.sessions !== false ? 'checked' : ''}><span class="sw"></span><span>Show what my Claude Code and Codex sessions are doing on the Now page (reads their logs in <code>~/.claude</code> and <code>~/.codex</code>)</span></label>
      <p class="help">Activity sensing (idle time and the front app) is set on the <a href="#connect/activity" data-view="connect">Connect</a> page. It’s ${c.activity?.enabled ? '<b>on</b>' : 'off'}.</p>
    </section>

    <section class="panel" id="s-delivery">
      <h2>Delivery</h2>
      <p class="help">How Switchboard batches requests that don't need you right away.</p>
      <div class="grid2">
        <label class="field"><span>Bundle requests that arrive within <small>seconds</small></span><input name="bundle" type="number" min="0" max="120" value="${Math.round((c.bundleWindowMs ?? 4000) / 1000)}"></label>
        <label class="field"><span>Digest times <small>comma separated</small></span><input name="digest" value="${esc((c.digest?.times || []).join(', '))}" placeholder="12:00, 17:30"></label>
        <label class="field"><span>Suggest a rule after <small>same answers in a row</small></span><input name="learn" type="number" min="2" max="20" value="${c.learnThreshold ?? 3}"></label>
      </div>
      <label class="toggle" style="margin-top:12px"><input type="checkbox" name="onbreak" ${c.digest?.onBreak !== false ? 'checked' : ''}><span class="sw"></span><span>When Focus or Do not disturb ends, deliver everything that waited, in one notification</span></label>
    </section>

    ${S.settingsDirty ? `<div class="savebar" role="region" aria-label="Unsaved changes"><span class="grow">You have unsaved changes</span><button class="btn ghost sm" type="button" data-act="settings-discard">Discard</button><button class="btn primary sm" type="submit">Save changes</button></div>` : ''}
  </form>

  <section class="panel" id="s-connect">
    <h2>Connect your agents</h2>
    <p class="help">Run one of these in a terminal. Each prints or writes the exact setup for this computer.</p>
    <div class="form" style="margin:0">
      <div class="field">Claude Code: permission prompts and “done” messages${cmdBox(`${cli} setup claude-code --write`)}</div>
      <div class="field">Codex: turn-complete messages and the ask_human tool${cmdBox(`${cli} setup codex`)}</div>
      <div class="field">Cursor or any MCP client: ask_human, notify_human, get_human_state${cmdBox(`${cli} setup cursor`)}</div>
      <div class="field">Gate risky tools on any MCP server${cmdBox(`${cli} proxy --name github --gate "delete_*|merge_*" -- npx -y @modelcontextprotocol/server-github`)}</div>
    </div>
  </section>
  <p class="help">Switchboard ${esc(VERSION)} · data in <span class="mono">${esc(S.config.home)}</span> · port ${S.config.port}</p>`;
}

// ------------------------------------------------------------ now & setup

/** The four things that make Switchboard useful, and whether each is done. */
function setupSteps() {
  const c = S.config?.config || {};
  const realAgents = S.agents.filter((g) => !g.id.startsWith('demo-'));
  return [
    { key: 'demo', title: 'See it with sample agents', text: 'Three made-up agents send 12 requests at once. See how few of them actually ping you.', done: (S.stats?.asks || 0) > 0, action: `<button class="btn primary sm" data-act="demo">${I('play', 14)} Run the demo</button>` },
    { key: 'agents', title: 'Connect your agents', text: 'One click for Claude Code, Codex, Cursor, Claude Desktop, OpenClaw, Hermes or Muse Code. Grok and other cloud agents connect through a tunnel.', done: S.integrations.some((i) => i.connected) || S.keys.length > 0 || realAgents.length > 0, action: `<button class="btn sm" data-act="go" data-view="connect" data-anchor="agents">${I('link', 14)} Connect agents</button>` },
    { key: 'phone', title: 'Get pings on your phone', text: 'Answer from your lock screen with one tap, through Telegram or ntfy.', done: !!(S.config?.telegram?.paired || c.ntfy?.topic), action: `<button class="btn sm" data-act="go" data-view="connect" data-anchor="phone">${I('phone', 14)} Set up phone</button>` },
    { key: 'context', title: 'Tell Switchboard when you’re busy', text: 'Connect a calendar, or let it notice when you step away or join a call.', done: !!(c.calendar?.ics || c.activity?.enabled), action: `<button class="btn sm" data-act="go" data-view="connect" data-anchor="calendar">${I('calendar', 14)} Calendar &amp; activity</button>` },
  ];
}

function setupChecklist({ compact = false } = {}) {
  const steps = setupSteps();
  const done = steps.filter((s) => s.done).length;
  if (done === steps.length) return '';
  return `<section class="welcome${compact ? ' compact' : ''}">
    <div class="welcome-head"><div><h2>${compact ? 'Finish setting up' : 'Welcome to Switchboard'}</h2>
      <p>${compact ? `${done} of ${steps.length} done.` : 'Switchboard sits between your AI agents and you. Every request lands here, and Switchboard decides which ones are worth interrupting you for, and when.'}</p></div>
      <div class="progress" role="progressbar" aria-valuemin="0" aria-valuemax="${steps.length}" aria-valuenow="${done}" aria-label="Setup progress"><i style="width:${(done / steps.length) * 100}%"></i></div></div>
    <ol class="checklist">${steps.map((s) => `<li class="${s.done ? 'is-done' : ''}">
      <span class="tick" aria-hidden="true">${s.done ? I('check', 14) : ''}</span>
      <div><h3>${s.title}${s.done ? '<span class="visually-hidden"> (done)</span>' : ''}</h3><p>${s.text}</p></div>
      ${s.done ? '' : `<div class="form-actions">${s.action}</div>`}
    </li>`).join('')}</ol>
  </section>`;
}

const SESSION_STATUS = { working: ['Working', 'working'], waiting: ['Needs you', 'waiting'], done: ['Done', 'done'], idle: ['Idle', 'idle'] };

function viewNow() {
  const n = S.now;
  let html = pageHead('Now', 'What you and your agents are up to, from this computer only.');
  if (!n) return `${html}<p class="help">Loading…</p>`;
  const st = n.state;
  const act = n.state.activity;
  const L = lists();
  const waiting = L.now.length + L.quiet.length;
  const actLine = act
    ? act.idle_ms > 120000 ? `Idle for ${fmtLeft(act.idle_ms)}` : `${act.app ? `${esc(act.app)} in front` : 'Active'}${act.category === 'meeting' ? ' · looks like a call' : act.category === 'editor' ? ' · working' : ''}`
    : null;
  html += `<div class="now-grid">
    <section class="panel you">
      <div class="you-head"><span class="dot ${st.mode}"></span><div><h2>${esc(MODES[st.mode]?.label ?? st.mode)}</h2><p class="help" style="margin:0">${esc(MODES[st.mode]?.desc ?? '')}</p></div></div>
      <dl class="facts-list">
        <div><dt>Why</dt><dd>${esc({ manual: 'You set it', calendar: 'Your calendar', 'quiet-hours': 'Quiet hours', activity: `Activity: ${st.note || ''}`, default: 'Nothing says you’re busy' }[st.source] || st.source)}${st.until ? ` · until ${esc(fmtWhen(st.until))}` : ''}</dd></div>
        <div><dt>Activity</dt><dd>${actLine || (n.activity_enabled ? 'Waiting for the first reading…' : `Off · <button class="link-btn" data-act="go" data-view="connect" data-anchor="activity">turn on</button>`)}</dd></div>
        <div><dt>Next busy</dt><dd>${n.upcoming?.length ? esc(`${fmtWhen(n.upcoming[0].start)}–${fmtTime(n.upcoming[0].end)}`) : S.config?.config?.calendar?.ics ? 'Nothing in the next 2 days' : `No calendar · <button class="link-btn" data-act="go" data-view="connect" data-anchor="calendar">connect</button>`}</dd></div>
        <div><dt>Waiting on you</dt><dd>${waiting ? `<button class="link-btn" data-act="go" data-view="inbox">${plural(waiting, 'decision')}</button>` : 'Nothing'}</dd></div>
      </dl>
    </section>
  </div>`;
  html += `<div class="section-title">${I('bot', 14)} Agent sessions <span class="hint">· read from Claude Code and Codex logs on this computer</span></div>`;
  if (!n.sessions_enabled) return html + emptyState('bot', 'Session view is off', 'Turn it on in Settings to see what your Claude Code and Codex sessions are doing.');
  if (!n.sessions.length) return html + emptyState('bot', 'No recent sessions', 'Start Claude Code or Codex and its sessions show up here within a few seconds.');
  html += `<div class="list">${n.sessions.map((s) => {
    const [label, cls] = SESSION_STATUS[s.status] || [s.status, 'idle'];
    return `<div class="item session">
      <span class="pulse ${cls}" aria-hidden="true"></span>
      <div><div class="title">${esc(s.title)}</div><div class="sub"><span>${esc(s.agent)}</span>${s.project ? `<span>·</span><span class="mono">${esc(s.project)}</span>` : ''}${s.branch ? `<span>·</span><span class="mono">${esc(s.branch)}</span>` : ''}<span>·</span><span>${esc(s.detail)}</span></div></div>
      <div class="side"><span class="status-pill ${cls}">${label}</span><span title="${esc(new Date(s.last_activity).toLocaleString())}">${fmtAgo(s.last_activity)}</span></div>
    </div>`;
  }).join('')}</div>`;
  return html;
}

const CAL_HELP = {
  google: ['Google Calendar', 'Open Google Calendar on the web → <b>Settings</b> (gear) → under “Settings for my calendars” pick your calendar → <b>Integrate calendar</b> → copy <b>Secret address in iCal format</b>.'],
  outlook: ['Outlook', 'Outlook on the web → <b>Settings</b> → <b>Calendar</b> → <b>Shared calendars</b> → “Publish a calendar” → pick your calendar and <b>Can view all details</b> → <b>Publish</b> → copy the <b>ICS</b> link.'],
  apple: ['Apple iCloud', 'In the Calendar app or on iCloud.com, right-click your calendar → <b>Share Calendar</b> → tick <b>Public Calendar</b> → copy the link. A <code>webcal://</code> link works.'],
  other: ['Other', 'Any calendar that can publish an <b>.ics</b> link works, or the path to an <b>.ics</b> file on this computer.'],
};

function snippet(lang, key) {
  const url = location.origin;
  const k = key || '<your agent key>';
  return {
    curl: `curl -s ${url}/v1/asks?wait=25s \\\n  -H "Authorization: Bearer ${k}" \\\n  -H "content-type: application/json" \\\n  -d '{"question":"Deploy v2 to production?","options":["Deploy","Wait"],"default":"Wait","deadline":"30m"}'`,
    python: `import requests\n\nr = requests.post("${url}/v1/asks?wait=25s",\n    headers={"Authorization": "Bearer ${k}"},\n    json={"question": "Deploy v2 to production?", "options": ["Deploy", "Wait"],\n          "default": "Wait", "deadline": "30m"})\nask = r.json()\nwhile not ask.get("final"):\n    ask = requests.get(f"${url}/v1/asks/{ask['id']}/wait", headers={"Authorization": "Bearer ${k}"}).json()\nprint(ask["answer"]["label"])`,
    js: `import { SwitchboardClient } from '@nkomianos/switchboard/client';\n\nconst switchboard = new SwitchboardClient({ url: '${url}', token: '${k}' });\nconst r = await switchboard.ask({ question: 'Deploy v2 to production?', options: ['Deploy', 'Wait'], default: 'Wait', deadline: '30m' });\nconsole.log(r.answer?.label);`,
    mcp: JSON.stringify({ mcpServers: { switchboard: { command: 'node', args: [S.config?.cli?.match(/"(.+)"/)?.[1] || 'bin/switchboard.js', 'mcp'], env: { SWITCHBOARD_TOKEN: k } } } }, null, 2),
  }[lang];
}

function viewConnect() {
  const c = S.config?.config || {};
  const tg = S.config?.telegram;
  const tgc = c.telegram;
  let html = pageHead('Connect', 'Everything Switchboard needs to reach you, and for your agents to reach Switchboard.');
  html += setupChecklist({ compact: true });

  // Agents on this computer
  html += `<section class="panel" id="s-agents"><h2>Agents on this computer</h2><p class="help">Switchboard edits each agent’s config for you and keeps a backup next to it (<code>.switchboard-bak</code>). You can disconnect any time.</p>
    <div class="integrations">${S.integrations.map((i) => `<div class="integration${i.connected ? ' on' : ''}">
      <div class="int-head"><b>${esc(i.name)}</b><span class="status-pill ${i.connected ? 'done' : i.detected ? 'idle' : 'off'}">${i.connected ? 'Connected' : i.detected ? 'Installed' : 'Not found'}</span></div>
      <p>${esc(i.description)}</p>
      <div class="form-actions">${i.connected
        ? `<button class="btn sm" data-act="integration" data-id="${i.id}" data-on="0">Disconnect</button>`
        : `<button class="btn ${i.detected ? 'primary ' : ''}sm" data-act="integration" data-id="${i.id}" data-on="1">${I('link', 14)} Connect</button>`}
        <details class="snippet"><summary>Do it by hand</summary><p class="help">Add to <code>${esc(i.file)}</code>:</p><pre class="full">${esc(i.snippet)}</pre>${i.extra ? `<p class="help">${esc(i.extraLabel || 'Also:')}</p>${cmdBox(i.extra)}` : ''}</details>
      </div>
    </div>`).join('') || '<p class="help">Loading…</p>'}</div>
  </section>`;

  // Cloud agents
  const rem = c.remote || {};
  const mcpUrl = `${rem.url || 'https://<your-tunnel>'}/mcp?key=${S.newKey?.key || '<agent key>'}`;
  html += `<section class="panel" id="s-cloud"><h2>Agents in the cloud</h2>
    <p class="help"><b>Grok</b> and <b>Grok Bot</b>, the <b>Meta Muse</b> app and other cloud agents can’t reach your computer directly. Give them a private URL through a tunnel. Only <b>agent keys</b> work through it: your inbox, settings and owner token stay on this computer.</p>
    ${rem.enabled
      ? `<div class="callout ok">${I('check', 16)}<div><b>Cloud agents can reach you</b>${rem.url ? ` at <code>${esc(rem.url)}</code>` : ''}. Give each one its own key.${cmdBox(mcpUrl)}</div></div>
        <div class="form-actions" style="margin-top:12px"><button class="btn sm" data-act="remote" data-on="0">Turn off cloud access</button></div>`
      : `<ol class="mini-steps">
          <li><b>Create an agent key</b> for it, under <a href="#connect/other" data-act="go" data-view="connect" data-anchor="other">Any other agent</a> below.</li>
          <li><b>Open a tunnel.</b> Switchboard can do it with Cloudflare’s free quick tunnels:${cmdBox(`${S.config?.cli || 'switchboard'} tunnel`)}<span class="help">Needs <code>cloudflared</code>: <code>winget install --id Cloudflare.cloudflared</code> on Windows, <code>brew install cloudflared</code> on macOS. Using ngrok or your own tunnel instead? <button class="link-btn" data-act="remote" data-on="1">Allow cloud agents</button> and paste its URL.</span></li>
          <li><b>Add Switchboard to your agent</b> with the URL it prints: <code>https://…/mcp?key=…</code></li>
        </ol>`}
    <div class="cloud-agents">
      <div><b>Grok &amp; Grok Bot</b><p>grok.com/connectors → <b>New connector</b> → <b>Custom</b> → paste the MCP URL. Custom connectors need a paid Grok plan.</p></div>
      <div><b>Meta Muse app</b><p>There’s no MCP setting yet. Ask Muse: “Create a custom connector for the MCP server at <i>URL</i>, and use ask_human before doing anything I haven’t approved.” Experimental.</p></div>
      <div><b>Anything else</b><p>Any agent that supports remote MCP (Streamable HTTP), or plain HTTP to <code>/v1/asks</code> with the key.</p></div>
    </div>
  </section>`;

  // Phone
  html += `<section class="panel" id="s-phone"><h2>Your phone</h2><p class="help">Pick one. Both are free, give you one-tap answer buttons, and never expose this computer to the internet: Switchboard only makes outgoing connections.</p>
    <div class="phone-options">
      <div class="phone-card">
        <div class="int-head"><b>Telegram</b>${tg?.paired ? '<span class="status-pill done">Connected</span>' : '<span class="status-pill idle">Recommended</span>'}</div>
        ${tg?.paired ? `<p>Connected through <b>@${esc(tg.bot?.username || 'your bot')}</b>${tgc?.username ? ` to <b>${esc(tgc.username)}</b>` : ''}. Requests arrive with buttons; reply to a message to answer a question. Commands: <code>/status</code> <code>/inbox</code> <code>/focus 1h</code> <code>/away</code>.</p>
          <div class="grid2 form" style="margin-top:0">
            <label class="field">Send to Telegram<select data-tg="mirror"><option value="always" ${tgc?.mirror !== 'away' ? 'selected' : ''}>Every time Switchboard pings me</option><option value="away" ${tgc?.mirror === 'away' ? 'selected' : ''}>Only when I’m away</option></select></label>
            <label class="toggle" style="align-self:end"><input type="checkbox" data-tg="redact" ${tgc?.redact ? 'checked' : ''}><span class="sw"></span><span>Hide question text</span></label>
          </div>
          <div class="form-actions"><button class="btn sm" data-act="test-notify">${I('bell', 14)} Send a test</button><button class="btn ghost sm" data-act="tg-remove">Disconnect</button></div>`
        : tg?.bot ? `<ol class="mini-steps"><li class="is-done">Bot <b>@${esc(tg.bot.username)}</b> is ready.</li><li>On your phone, open <a href="https://t.me/${esc(tg.bot.username)}?start=${esc(tg.pair_code)}" target="_blank" rel="noreferrer">t.me/${esc(tg.bot.username)}</a> and tap <b>Start</b>. Or send it <code>/start ${esc(tg.pair_code)}</code>.</li></ol>
          <p class="help"><span class="spinner inline" aria-hidden="true"></span> Waiting for you to press Start…</p><div class="form-actions"><button class="btn ghost sm" data-act="tg-remove">Use a different bot</button></div>`
        : `<ol class="mini-steps">
            <li>In Telegram, open <a href="https://t.me/BotFather" target="_blank" rel="noreferrer">@BotFather</a>, send <code>/newbot</code> and pick any name. It replies with a token.</li>
            <li>Paste the token here:<div class="inline-form"><input class="input" type="password" autocomplete="off" placeholder="123456789:AA…" data-tg-token aria-label="Telegram bot token"><button class="btn primary sm" data-act="tg-save">Connect</button></div>${tg?.error ? `<span class="bad-t help">${esc(tg.error)}</span>` : ''}</li>
            <li>Tap Start on your new bot. Switchboard shows you the link.</li></ol>`}
      </div>
      <div class="phone-card">
        <div class="int-head"><b>ntfy</b>${c.ntfy?.topic ? '<span class="status-pill done">Connected</span>' : ''}</div>
        <p>An open-source push app. No account needed: subscribe to a secret topic and you’re done. Good if you don’t use Telegram.</p>
        <div class="form-actions"><button class="btn sm" data-act="go" data-view="settings" data-anchor="phone">${c.ntfy?.topic ? 'Settings' : 'Set up ntfy'}</button></div>
      </div>
    </div>
  </section>`;

  // Calendar
  const [provName, provHelp] = CAL_HELP[S.calProvider];
  const cal = S.calendar;
  html += `<section class="panel" id="s-calendar"><h2>Calendar</h2><p class="help">During meetings Switchboard holds everything but urgent requests, then delivers them in one go when the meeting ends. The calendar is read on this computer. Agents only ever see “Focus” or “Available”, never your events.</p>
    ${c.calendar?.ics ? `<div class="callout ${cal?.status?.error ? 'bad' : 'ok'}">${I(cal?.status?.error ? 'alert' : 'check', 16)}<div>${cal?.status?.error ? `Couldn’t read your calendar: ${esc(cal.status.error)}` : `<b>Connected.</b> ${plural(cal?.status?.events_next_48h ?? 0, 'busy block')} in the next 48 hours.`}</div></div>
      ${cal?.upcoming?.length ? `<ul class="events">${cal.upcoming.map((e) => `<li><span class="when">${esc(fmtWhen(e.start))}–${esc(fmtTime(e.end))}</span><span class="what">${esc(e.summary || 'Busy')}</span><span class="status-pill ${e.mode === 'dnd' ? 'waiting' : 'idle'}">${esc(MODES[e.mode]?.label ?? e.mode)}</span></li>`).join('')}</ul>` : ''}
      <div class="form-actions" style="margin-top:12px"><button class="btn ghost sm" data-act="cal-remove">Disconnect calendar</button></div>`
    : `<div class="chips" role="tablist" aria-label="Calendar provider">${Object.entries(CAL_HELP).map(([k, [n]]) => `<button class="chip-btn" role="tab" data-act="cal-provider" data-key="${k}" aria-pressed="${S.calProvider === k}">${n}</button>`).join('')}</div>
      <p class="cal-help">${provHelp}</p>
      <div class="inline-form"><input class="input" data-cal-url placeholder="Paste the ${esc(provName)} calendar link" value="${esc(S.calDraft)}" aria-label="Calendar link"><button class="btn sm" data-act="cal-test">Test</button></div>
      ${S.calPreview ? (S.calPreview.error ? `<div class="callout bad">${I('alert', 16)}<div>${esc(S.calPreview.error)}</div></div>`
        : `<div class="callout ok">${I('check', 16)}<div>Found <b>${plural(S.calPreview.count, 'busy block')}</b> in the next 7 days.${S.calPreview.events.length ? `<ul class="events">${S.calPreview.events.map((e) => `<li><span class="when">${esc(fmtWhen(e.start))}–${esc(fmtTime(e.end))}</span><span class="what">${esc(e.summary || 'Busy')}</span></li>`).join('')}</ul>` : ''}</div></div>
          <div class="form-actions" style="margin-top:12px"><button class="btn primary sm" data-act="cal-save">Use this calendar</button></div>`) : ''}`}
  </section>`;

  // Activity
  const a = c.activity || {};
  html += `<section class="panel" id="s-activity"><h2>Notice when I’m away or on a call</h2>
    <p class="help">Optional. Switchboard checks two things every 10 seconds: how long since you touched the keyboard or mouse, and the <i>name</i> of the app in front (like “Zoom” or “VS Code”). Never window titles, never what you type, never screenshots. Nothing is stored or sent anywhere.</p>
    ${S.config?.activity_supported === false ? '<div class="callout warn">Not supported on this system yet.</div>' : `
    <label class="toggle"><input type="checkbox" data-act-cfg="enabled" ${a.enabled ? 'checked' : ''}><span class="sw"></span><span><b>Sense my activity</b></span></label>
    <div class="activity-opts${a.enabled ? '' : ' is-off'}">
      <label class="toggle"><input type="checkbox" data-act-cfg="meetings" ${a.meetings !== false ? 'checked' : ''} ${a.enabled ? '' : 'disabled'}><span class="sw"></span><span>Treat Zoom, Teams, Webex and FaceTime as <b>Focus</b></span></label>
      <label class="toggle"><input type="checkbox" data-act-cfg="editorFocus" ${a.editorFocus ? 'checked' : ''} ${a.enabled ? '' : 'disabled'}><span class="sw"></span><span>Treat my editor and terminal as <b>Focus</b> (only urgent requests interrupt while I code)</span></label>
      <label class="field inline-field">Mark me <b>Away</b> after<input class="input" type="number" min="2" max="120" data-act-cfg="awayAfterMinutes" value="${a.awayAfterMinutes ?? 10}" ${a.enabled ? '' : 'disabled'}><span>minutes without input. Urgent requests then go to your phone.</span></label>
    </div>`}
  </section>`;

  // Other agents
  html += `<section class="panel" id="s-other"><h2>Any other agent or script</h2>
    <p class="help">Scripts, your own agents, and cloud agents like Grok. Anything that can make an HTTP request can ask you something. Give each one its own <b>agent key</b>: a key can only send requests and read your status (Available, Focus…). It can’t answer, read your inbox or pretend to be another agent.</p>
    <div class="inline-form"><input class="input" data-key-name placeholder="Name it, e.g. Nightly backup" aria-label="Key name"><button class="btn primary sm" data-act="key-create">${I('key', 14)} Create key</button></div>
    ${S.newKey ? `<div class="callout ok">${I('key', 16)}<div><b>Copy this key now.</b> It won’t be shown again.${cmdBox(S.newKey.key)}</div></div>` : ''}
    ${S.keys.length ? `<div class="list keys">${S.keys.map((k) => `<div class="item"><span class="ico">${I('key', 15)}</span><div><div class="title">${esc(k.name)}</div><div class="sub"><span class="mono">${esc(k.prefix)}…</span><span>·</span><span>agent id <span class="mono">${esc(k.agent_id)}</span></span><span>·</span><span>${k.last_used ? `used ${fmtAgo(k.last_used)}` : 'never used'}</span></div></div><div class="side"><button class="btn ghost sm" data-act="key-revoke" data-id="${k.id}">Revoke</button></div></div>`).join('')}</div>` : ''}
    <div class="chips" role="tablist" aria-label="Example" style="margin-top:16px">${[['curl', 'curl'], ['python', 'Python'], ['js', 'JavaScript'], ['mcp', 'MCP config']].map(([k, n]) => `<button class="chip-btn" role="tab" data-act="snippet-lang" data-key="${k}" aria-pressed="${S.snippetLang === k}">${n}</button>`).join('')}</div>
    <div class="code-block"><pre class="full">${esc(snippet(S.snippetLang, S.newKey?.key))}</pre><button class="btn ghost sm" data-act="copy" data-text="${esc(snippet(S.snippetLang, S.newKey?.key))}">${I('copy', 14)} Copy</button></div>
    <div class="form-actions" style="margin-top:12px"><button class="btn sm" data-act="test-ask">${I('play', 14)} Send me a test request</button><span class="help" style="margin:0">Full format: <a href="https://github.com/nkomianos/switchboard/blob/main/spec/ask-v0.1.md" target="_blank" rel="noreferrer">the Ask spec</a></span></div>
  </section>`;
  return html;
}

// ----------------------------------------------------------------- render

const setupLeft = () => (S.loaded && S.config ? setupSteps().filter((x) => !x.done).length : 0);

function renderNav() {
  const L = lists();
  const inbox = L.now.length + L.quiet.length;
  const item = (view, icon, label, count = 0, hot = false) => `<a class="nav-item" href="#${view}" data-view="${view}" ${S.view === view ? 'aria-current="page"' : ''}>${I(icon, 17)}<span>${label}</span>${count ? `<span class="count${hot ? ' hot' : ''}">${count}</span>` : ''}</a>`;
  const s = S.stats;
  $('#nav').innerHTML = `
    ${item('inbox', 'inbox', 'Needs you', inbox, true)}
    ${item('updates', 'bell', 'Updates', L.updates.length)}
    ${item('snoozed', 'clock', 'Snoozed', L.snoozed.length)}
    ${item('history', 'history', 'History')}
    ${item('now', 'pulse', 'Now', S.now?.sessions?.filter((x) => x.status === 'working' || x.status === 'waiting').length || 0)}
    <div class="nav-sep"></div>
    <div class="nav-label">Manage</div>
    ${item('connect', 'link', 'Connect', setupLeft(), true)}
    ${item('agents', 'bot', 'Agents')}
    ${item('rules', 'rules', 'Rules', S.suggestions.length, true)}
    ${item('activity', 'shield', 'Activity log')}
    ${item('settings', 'gear', 'Settings')}
    ${s?.asks ? `<div class="impact" title="Since Switchboard started"><strong>${s.notifications} of ${s.asks}</strong>requests actually interrupted you<div class="row2"><span><b>${s.auto}</b> by rules</span><span><b>${s.digested}</b> to digests</span></div></div>` : ''}`;
  document.title = inbox ? `(${inbox}) Switchboard` : 'Switchboard';
}

function renderStatus() {
  const st = S.state;
  if (!st) return;
  const manual = st.source === 'manual';
  $('#status-dot').className = `dot ${st.mode}`;
  $('#status-mode').textContent = MODES[st.mode]?.label ?? st.mode;
  const sub = st.until ? `until ${fmtWhen(st.until)}` : !manual && st.source && st.source !== 'default' ? `from ${st.source === 'quiet-hours' ? 'quiet hours' : st.source === 'activity' ? (st.note || 'activity') : st.source}` : manual ? '' : 'automatic';
  $('#status-sub').textContent = sub;
  $('#status-btn').title = `${MODES[st.mode]?.desc ?? ''}. Click to change (f)`;
  const menu = $('#status-menu');
  if (!menu.hidden) {
    const cur = manual ? st.mode : 'auto';
    const durs = [['', 'Until I change it'], ['30m', '30 min'], ['1h', '1 hour'], ['2h', '2 hours'], ['4h', '4 hours']];
    menu.innerHTML = `
      <div class="menu-head">For how long?</div>
      <div class="durations" role="group" aria-label="Duration">${durs.map(([v, l]) => `<button data-dur="${v}" aria-pressed="${S.duration === v}">${l}</button>`).join('')}</div>
      <div class="menu-sep"></div>
      ${Object.entries(MODES).map(([k, m]) => `<button class="menu-item" role="menuitemradio" aria-checked="${cur === k}" data-mode="${k}"><span class="dot ${k}"></span><b>${m.label}</b><span class="check">${cur === k ? I('check', 16) : ''}</span><small>${m.desc}</small></button>`).join('')}
      <div class="menu-sep"></div>
      <button class="menu-item" role="menuitemradio" aria-checked="${cur === 'auto'}" data-mode="auto"><span>${I('clock', 16)}</span><b>Automatic</b><span class="check">${cur === 'auto' ? I('check', 16) : ''}</span><small>Follow your calendar, quiet hours and activity${S.state?.calendar?.configured || S.config?.config?.activity?.enabled ? '' : ' (set them up in Connect)'}</small></button>`;
  }
}

function focusKey(el) {
  if (!el || el === document.body) return null;
  if (el.dataset.text) return `[data-text="${el.dataset.text}"]`;
  if (el.dataset.note) return `[data-note="${el.dataset.note}"]`;
  if (el.dataset.reply) return `[data-reply="${el.dataset.reply}"]`;
  if (el.dataset.field) return `[data-id="${el.dataset.id}"][data-field="${el.dataset.field}"]`;
  if (el.dataset.histSearch !== undefined) return '[data-hist-search]';
  if (el.dataset.act) {
    let sel = `[data-act="${el.dataset.act}"]`;
    for (const k of ['id', 'opt', 'i', 'agent', 'key']) if (el.dataset[k] != null) sel += `[data-${k}="${CSS.escape(el.dataset[k])}"]`;
    return sel;
  }
  return null;
}

function render() {
  renderNav();
  renderStatus();
  const main = $('#main');
  // Don't wipe a settings form the user is editing.
  if (S.view === 'settings' && S.settingsDirty && main.querySelector('#settings')) {
    const bar = main.querySelector('.savebar');
    if (!bar) {
      main.querySelector('#settings').insertAdjacentHTML('beforeend', '<div class="savebar" role="region" aria-label="Unsaved changes"><span class="grow">You have unsaved changes</span><button class="btn ghost sm" type="button" data-act="settings-discard">Discard</button><button class="btn primary sm" type="submit">Save changes</button></div>');
    }
    return;
  }
  const key = focusKey(document.activeElement);
  const caret = document.activeElement?.selectionStart;
  const html = {
    inbox: viewInbox,
    updates: viewUpdates,
    snoozed: viewSnoozed,
    history: viewHistory,
    now: viewNow,
    connect: viewConnect,
    agents: viewAgents,
    rules: viewRules,
    activity: viewActivity,
    settings: viewSettings,
  }[S.view]();
  main.innerHTML = html;
  tick();
  // Reviews open with their document already showing.
  if (['inbox', 'snoozed'].includes(S.view)) {
    for (const a of currentList()) {
      const i = a.review ? (a.attachments || []).findIndex((x) => !x.url) : -1;
      if (i < 0 || S.autoPreviewed.has(a.id)) continue;
      S.autoPreviewed.add(a.id);
      S.previewOpen.add(`${a.id}:${i}`);
      loadPreview(a.id, i);
    }
  }
  if (key) {
    const el = main.querySelector(key);
    if (el) {
      el.focus({ preventScroll: true });
      if (caret != null && el.setSelectionRange && !['number', 'email', 'checkbox'].includes(el.type)) el.setSelectionRange(caret, caret);
    }
  }
}

let queued = false;
function scheduleRender() {
  if (queued) return;
  queued = true;
  requestAnimationFrame(() => { queued = false; render(); });
}

function tick() {
  for (const el of $$('[data-deadline]')) {
    const left = Number(el.dataset.deadline) - Date.now();
    const target = el.querySelector('span') || el;
    target.textContent = left > 0 ? `${el.dataset.prefix ? `${el.dataset.prefix} ` : ''}${fmtLeft(left)}` : 'now';
    el.classList.toggle('soon', left > 0 && left < 120000 && el.classList.contains('timer'));
  }
}
setInterval(tick, 1000);
// The Now view follows your agents live; elsewhere a slow refresh keeps the nav count honest.
setInterval(async () => {
  if (document.hidden || !S.connected) return;
  if (S.view === 'now' || Date.now() - (S.nowAt || 0) > 60000) {
    S.nowAt = Date.now();
    await loadNow().catch(() => {});
    if (S.view === 'now' || S.view === 'inbox') scheduleRender(); else renderNav();
  }
}, 5000);
setInterval(() => { if (!S.settingsDirty && !document.activeElement?.matches('input,textarea,select')) scheduleRender(); }, 30000); // refresh "5 min ago"

// --------------------------------------------------------------- navigation

async function go(view, selId = null, anchor = null) {
  if (!VIEWS.includes(view)) view = 'inbox';
  if (S.view === 'settings' && view !== 'settings' && S.settingsDirty && !confirm('Discard unsaved settings?')) {
    history.replaceState(null, '', '#settings');
    return;
  }
  if (view !== 'settings') S.settingsDirty = false;
  const changed = S.view !== view;
  S.view = view;
  S.menu = null;
  if (selId) S.selId = selId;
  else if (changed) S.selId = null;
  const hash = `#${view}${anchor ? `/${anchor}` : ''}`;
  if (location.hash !== hash) history[changed ? 'pushState' : 'replaceState'](null, '', hash);
  render();
  if (changed) { window.scrollTo(0, 0); $('#main').focus({ preventScroll: true }); }
  try {
    if (view === 'history') await loadHistory();
    if (view === 'agents' || view === 'inbox') await loadAgents();
    if (view === 'rules') await loadRules();
    if (view === 'activity') await loadLedger();
    if (view === 'settings') await Promise.all([loadConfig(), loadState()]);
    if (view === 'now') await loadNow();
    if (view === 'connect') await Promise.all([loadConfig(), loadIntegrations(), loadKeys(), loadCalendar(), loadAgents()]);
    if (view !== 'connect') S.newKey = null;
  } catch (err) { fail(err); }
  render();
  if (selId) document.getElementById(selId)?.scrollIntoView({ block: 'center' });
  if (anchor) document.getElementById(`s-${anchor}`)?.scrollIntoView({ block: 'start' });
}

function parseHash() {
  const h = location.hash.slice(1);
  if (/^ask_/.test(h)) {
    const a = S.asks.get(h);
    return [a?.kind === 'inform' ? 'updates' : a && isSnoozed(a) ? 'snoozed' : 'inbox', h, null];
  }
  const [view, anchor] = h.replace(/^tab=/, '').split('/');
  return [VIEWS.includes(view) ? view : 'inbox', null, anchor || null];
}
window.addEventListener('hashchange', () => { const [v, id, anchor] = parseHash(); go(v, id, anchor); });

function openStatusMenu() {
  const menu = $('#status-menu');
  menu.hidden = false;
  $('#status-btn').setAttribute('aria-expanded', 'true');
  renderStatus();
  (menu.querySelector('[aria-checked="true"]') || menu.querySelector('.menu-item'))?.focus({ preventScroll: true });
}
function closeStatusMenu() {
  $('#status-menu').hidden = true;
  $('#status-btn').setAttribute('aria-expanded', 'false');
}

// ------------------------------------------------------------------ events

document.addEventListener('click', async (e) => {
  const t = e.target;
  if (t.closest('#status-btn')) return $('#status-menu').hidden ? openStatusMenu() : closeStatusMenu();
  const dur = t.closest('[data-dur]');
  if (dur) { S.duration = dur.dataset.dur; renderStatus(); $(`[data-dur="${S.duration}"]`)?.focus(); return; }
  const mode = t.closest('#status-menu [data-mode]');
  if (mode) return setStatus(mode.dataset.mode);
  if (!t.closest('#status-menu')) closeStatusMenu();
  if (t.closest('#help-btn')) return $('#help').showModal();
  if (t.closest('[data-close]')) return t.closest('dialog').close();

  const nav = t.closest('[data-view]:not([data-act])');
  if (nav) { e.preventDefault(); return go(nav.dataset.view); }
  const anchorLink = t.closest('[data-anchor-link]');
  if (anchorLink) { e.preventDefault(); document.getElementById(`s-${anchorLink.dataset.anchorLink}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' }); return; }

  const b = t.closest('[data-act]');
  if (S.menu && !t.closest('.snooze-menu') && b?.dataset.act !== 'snooze-menu') { S.menu = null; render(); }
  if (!b) {
    const card = t.closest('[data-card]');
    if (card && !t.closest('input,textarea,select,summary,a,label') && S.selId !== card.dataset.card) {
      S.selId = card.dataset.card;
      $$('.card').forEach((c) => c.classList.toggle('sel', c === card));
    }
    return;
  }
  if (b.dataset.act === 'toggle' && t.closest('button:not([data-act="toggle"]),textarea,input,select,a,.reply-box')) return;
  const id = b.dataset.id;
  const a = id ? S.asks.get(id) || S.history.find((x) => x.id === id) || null : null;
  switch (b.dataset.act) {
    case 'answer': return a && answer(a, b.dataset.opt);
    case 'submit': return a && submitInput(a);
    case 'ack': e.stopPropagation(); return a && ack(a);
    case 'ack-all': return ackAll();
    case 'dismiss': e.stopPropagation(); return a && dismiss(a);
    case 'snooze-menu':
      S.menu = S.menu?.id === id ? null : { type: 'snooze', id };
      S.selId = id;
      render();
      if (S.menu) $('.snooze-menu .menu-item:not(:disabled)')?.focus({ preventScroll: true });
      return;
    case 'snooze-at': return a && snooze(a, snoozeChoices(a)[Number(b.dataset.i)]);
    case 'unsnooze': return a && unsnooze(a);
    case 'note-toggle': S.noteOpen.add(id); render(); $(`[data-note="${id}"]`)?.focus(); return undefined;
    case 'msg-expand': { const k = `msg:${id}`; S.open.has(k) ? S.open.delete(k) : S.open.add(k); return render(); }
    case 'att-preview': {
      const key = `${id}:${b.dataset.i}`;
      if (S.previewOpen.has(key)) S.previewOpen.delete(key);
      else { S.previewOpen.add(key); if (!S.previews.has(key)) loadPreview(id, Number(b.dataset.i)); }
      return render();
    }
    case 'att-open':
      try { const r = await api('POST', `/v1/asks/${id}/attachments/${b.dataset.i}/open`); toast(`Opened in ${r.opened}`); } catch (err) { fail(err); }
      return undefined;
    case 'reply-toggle':
      e.stopPropagation();
      S.replyOpen.has(id) ? S.replyOpen.delete(id) : S.replyOpen.add(id);
      render();
      $(`[data-reply="${id}"]`)?.focus();
      return undefined;
    case 'reply-send': e.stopPropagation(); return a && sendReplyTo(a);
    case 'toggle':
      S.open.has(id) ? S.open.delete(id) : S.open.add(id);
      S.selId = id;
      return render();
    case 'demo': return startDemo();
    case 'go': return go(b.dataset.view, null, b.dataset.anchor);
    case 'copy': return copy(b.dataset.text);
    case 'hist-filter': S.histFilter = b.dataset.key; return render();
    case 'mute': try {
      const muted = b.dataset.muted === '1';
      await api('POST', `/v1/agents/${encodeURIComponent(b.dataset.agent)}/mute`, { muted });
      await loadAgents(); render();
      const g = S.agents.find((x) => x.id === b.dataset.agent);
      toast(muted ? `Muted ${g?.name}` : `Unmuted ${g?.name}`, { sub: muted ? 'Its requests still land in your inbox, but never ping you' : '' });
    } catch (err) { fail(err); } return undefined;
    case 'reset': try { await api('POST', `/v1/agents/${encodeURIComponent(b.dataset.agent)}/reset`); await loadAgents(); render(); toast('Budget reset'); } catch (err) { fail(err); } return undefined;
    case 'sug-accept': try { await api('POST', `/v1/suggestions/${id}/accept`); await loadRules(); render(); toast('Rule created', { sub: 'Switchboard will answer this for you from now on' }); } catch (err) { fail(err); } return undefined;
    case 'sug-decline': try { await api('POST', `/v1/suggestions/${id}/decline`); await loadRules(); render(); toast('OK, Switchboard will keep asking you'); } catch (err) { fail(err); } return undefined;
    case 'rule-form': S.ruleForm = !S.ruleForm; render(); if (S.ruleForm) $('#rule-form input')?.focus(); return undefined;
    case 'rule-rm': {
      const r = S.rules.find((x) => x.id === id);
      try {
        await api('DELETE', `/v1/rules/${id}`);
        await loadRules(); render();
        toast('Rule deleted', { ms: 6000, action: { label: 'Undo', fn: async () => { try { await api('POST', '/v1/rules', { match: r.match, action: r.action, note: r.note }); await loadRules(); render(); } catch (err) { fail(err); } } } });
      } catch (err) { fail(err); }
      return undefined;
    }
    case 'verify': try { S.verify = await api('GET', '/v1/ledger/verify'); await loadLedger(); render(); } catch (err) { fail(err); } return undefined;
    case 'test-notify': try {
      b.disabled = true;
      S.testResult = await api('POST', '/v1/notify-test');
      if (!S.testResult.sent.length && !Object.keys(S.testResult.errors || {}).length) S.testResult.errors = { all: 'desktop notifications are off and no phone is set up' };
      const box = $('#test-result');
      if (box) box.innerHTML = testBoxHtml();
      else if (S.testResult.sent.length) toast(`Sent to ${S.testResult.sent.join(' and ')}`);
      else fail(new Error(Object.values(S.testResult.errors).join('; ')));
    } catch (err) { fail(err); }
    b.disabled = false;
    return undefined;
    case 'browser-notif': await Notification.requestPermission(); return render();
    case 'gen-topic': {
      const bytes = crypto.getRandomValues(new Uint8Array(12));
      const input = $('[name="n_topic"]');
      input.value = `switchboard-${[...bytes].map((x) => x.toString(36)).join('').slice(0, 18)}`;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return toast('Topic generated', { sub: 'Save, then subscribe to it in the ntfy app' });
    }
    case 'settings-discard': S.settingsDirty = false; await loadConfig().catch(fail); return render();
    case 'integration': {
      const on = b.dataset.on === '1';
      const name = S.integrations.find((x) => x.id === id)?.name || id;
      if (!on && !confirm(`Disconnect ${name}? Switchboard removes only its own entries and keeps a backup.`)) return undefined;
      b.disabled = true;
      try {
        const r = await api('POST', `/v1/integrations/${id}`, { connected: on });
        await loadIntegrations(); render();
        toast(on ? `${name} connected` : `${name} disconnected`, { sub: r.message, ms: 6000 });
      } catch (err) { b.disabled = false; fail(err); }
      return undefined;
    }
    case 'tg-save': {
      const token = $('[data-tg-token]')?.value.trim();
      if (!/^\d+:[\w-]{30,}$/.test(token || '')) return toast('That doesn’t look like a bot token. It looks like 123456789:AAE…', { error: true, ms: 6000 });
      b.disabled = true;
      try {
        S.config = await api('PATCH', '/v1/config', { telegram: { token, mirror: 'always' } });
        render();
        if (S.config.telegram?.error) fail(new Error(S.config.telegram.error));
      } catch (err) { b.disabled = false; fail(err); }
      return undefined;
    }
    case 'tg-remove':
      if (S.config?.telegram?.paired && !confirm('Disconnect Telegram? Switchboard stops sending to your phone there.')) return undefined;
      try { S.config = await api('PATCH', '/v1/config', { telegram: null }); render(); toast('Telegram disconnected'); } catch (err) { fail(err); }
      return undefined;
    case 'cal-provider': S.calProvider = b.dataset.key; return render();
    case 'cal-test': {
      const ics = ($('[data-cal-url]')?.value || '').trim();
      if (!ics) return toast('Paste your calendar link first', { error: true });
      S.calDraft = ics;
      b.disabled = true;
      b.textContent = 'Testing…';
      try { const r = await api('POST', '/v1/calendar/preview', { ics }); S.calPreview = r; } catch (err) { S.calPreview = { error: err.message }; }
      return render();
    }
    case 'cal-save':
      try {
        const cur = S.config?.config?.calendar || {};
        S.config = await api('PATCH', '/v1/config', { calendar: { ics: S.calDraft, busyMode: cur.busyMode || 'focus', dndKeywords: cur.dndKeywords || ['focus time', 'deep work', 'do not disturb'] } });
        S.calPreview = null;
        await Promise.all([loadCalendar(), loadState()]); render();
        toast('Calendar connected', { sub: 'Meetings now hold everything but urgent requests' });
      } catch (err) { fail(err); }
      return undefined;
    case 'cal-remove':
      if (!confirm('Disconnect your calendar?')) return undefined;
      try { S.config = await api('PATCH', '/v1/config', { calendar: null }); S.calDraft = ''; await loadCalendar(); render(); toast('Calendar disconnected'); } catch (err) { fail(err); }
      return undefined;
    case 'key-create': {
      const name = ($('[data-key-name]')?.value || '').trim();
      if (!name) { $('[data-key-name]')?.focus(); return toast('Give the key a name first', { error: true }); }
      try { S.newKey = await api('POST', '/v1/keys', { name }); await loadKeys(); render(); } catch (err) { fail(err); }
      return undefined;
    }
    case 'key-revoke': {
      const k = S.keys.find((x) => x.id === id);
      if (!confirm(`Revoke the key “${k?.name}”? Anything using it stops working.`)) return undefined;
      try { await api('DELETE', `/v1/keys/${id}`); if (S.newKey?.id === id) S.newKey = null; await loadKeys(); render(); toast('Key revoked'); } catch (err) { fail(err); }
      return undefined;
    }
    case 'snippet-lang': S.snippetLang = b.dataset.key; return render();
    case 'remote': {
      const on = b.dataset.on === '1';
      let url = S.config?.config?.remote?.url || null;
      if (on) {
        url = (prompt('Your tunnel’s public URL (e.g. https://abc.ngrok.app). Leave empty if you’ll add it later.') || '').trim().replace(/\/+$/, '') || null;
        if (url && !/^https:\/\//.test(url)) return toast('Use the https:// URL your tunnel gives you', { error: true });
      }
      try {
        S.config = await api('PATCH', '/v1/config', { remote: { enabled: on, url: on ? url : null } });
        render();
        toast(on ? 'Cloud agents can reach you through your tunnel' : 'Cloud access is off', { sub: on ? 'Only agent keys work from outside this computer' : '' });
      } catch (err) { fail(err); }
      return undefined;
    }
    case 'test-ask':
      try {
        await api('POST', '/v1/asks', { agent: { id: 'test-agent', name: 'Test agent' }, question: 'Is Switchboard set up the way you want?', options: [{ id: 'yes', label: 'Yes', style: 'primary' }, { id: 'later', label: 'Not yet' }], urgency: 'high', detail: 'This is a test request from the Connect page.', default: 'later', deadline: '1h' });
        toast('Test request sent', { sub: 'It should ping you and appear in your inbox', action: { label: 'Open', fn: () => go('inbox') } });
      } catch (err) { fail(err); }
      return undefined;
    default: return undefined;
  }
});

document.addEventListener('input', (e) => {
  const t = e.target;
  if (t.dataset.text) S.drafts.set(t.dataset.text, { ...S.drafts.get(t.dataset.text), text: t.value });
  if (t.dataset.note) S.drafts.set(t.dataset.note, { ...S.drafts.get(t.dataset.note), note: t.value });
  if (t.dataset.reply) S.drafts.set(t.dataset.reply, { ...S.drafts.get(t.dataset.reply), reply: t.value });
  if (t.dataset.field) {
    const d = S.drafts.get(t.dataset.id) || {};
    S.drafts.set(t.dataset.id, { ...d, values: { ...d.values, [t.dataset.field]: t.type === 'checkbox' ? t.checked : t.value } });
  }
  if (t.dataset.histSearch !== undefined) { S.histQuery = t.value; render(); }
  if (t.dataset.calUrl !== undefined) { S.calDraft = t.value; S.calPreview = null; }
  if (t.closest('#settings') && !S.settingsDirty) { S.settingsDirty = true; render(); }
});
document.addEventListener('change', (e) => {
  const t = e.target;
  if (t.dataset.always) S.drafts.set(t.dataset.always, { ...S.drafts.get(t.dataset.always), always: t.checked });
  if (t.closest('#settings') && !S.settingsDirty) { S.settingsDirty = true; render(); }
  if (t.name === 'then') $('[data-answer-field]')?.toggleAttribute('hidden', t.value !== 'answer');
  if (t.dataset.tg) {
    const cur = S.config?.config?.telegram || {};
    const next = { mirror: cur.mirror, redact: cur.redact, [t.dataset.tg]: t.type === 'checkbox' ? t.checked : t.value };
    api('PATCH', '/v1/config', { telegram: { token: '••••', ...next } }).then((c) => { S.config = c; toast('Saved'); }).catch(fail);
  }
  if (t.dataset.actCfg) {
    const cur = { enabled: false, awayAfterMinutes: 10, meetings: true, editorFocus: false, ...(S.config?.config?.activity || {}) };
    const k = t.dataset.actCfg;
    cur[k] = t.type === 'checkbox' ? t.checked : Math.max(2, Math.min(120, Number(t.value) || 10));
    api('PATCH', '/v1/config', { activity: cur }).then(async (c) => {
      S.config = c;
      render();
      if (k === 'enabled') toast(cur.enabled ? 'Activity sensing is on' : 'Activity sensing is off', { sub: cur.enabled ? 'Only idle time and the front app’s name. Nothing leaves this computer.' : '' });
      else toast('Saved');
    }).catch(fail);
  }
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
    for (const k of ['agent', 'fingerprint', 'kind', 'urgency']) if (f.get(k)) match[k] = f.get(k).trim();
    const then = f.get('then');
    if (then === 'answer' && !f.get('answer')) return toast('Enter the option to answer with, e.g. allow', { error: true });
    const action = then === 'answer' ? { answer: f.get('answer').trim() } : { route: then };
    try {
      await api('POST', '/v1/rules', { match, action });
      S.ruleForm = false;
      await loadRules(); render();
      toast('Rule created');
    } catch (err) { fail(err); }
    return;
  }
  if (e.target.id === 'settings') {
    const times = String(f.get('digest') || '').split(',').map((s) => s.trim()).filter(Boolean);
    const bad = times.find((x) => !/^\d{1,2}:\d{2}$/.test(x));
    if (bad) return toast(`“${bad}” isn't a time like 17:30`, { error: true });
    const patch = {
      quietHours: f.get('q_start') && f.get('q_end') ? { start: f.get('q_start'), end: f.get('q_end'), mode: f.get('q_mode') } : null,
      calendar: f.get('cal_ics') ? { ics: f.get('cal_ics').trim(), busyMode: f.get('cal_mode'), dndKeywords: String(f.get('cal_kw')).split(',').map((s) => s.trim()).filter(Boolean) } : null,
      bundleWindowMs: Math.max(0, Number(f.get('bundle')) || 0) * 1000,
      digest: { times, onBreak: !!f.get('onbreak') },
      learnThreshold: Number(f.get('learn')) || 3,
      desktop: !!f.get('desktop'),
      sessions: !!f.get('sessions'),
      ntfy: f.get('n_topic') ? { server: f.get('n_server') || 'https://ntfy.sh', topic: f.get('n_topic').trim(), token: f.get('n_token') || null, mirror: f.get('n_mirror'), redact: !!f.get('n_redact') } : null,
    };
    try {
      S.config = await api('PATCH', '/v1/config', patch);
      S.settingsDirty = false;
      await loadState();
      render();
      toast('Settings saved');
    } catch (err) { fail(err); }
  }
});

let gPrefix = 0;
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (!$('#status-menu').hidden) { closeStatusMenu(); $('#status-btn').focus(); return; }
    if (S.menu) { const id = S.menu.id; S.menu = null; render(); $(`[data-act="snooze-menu"][data-id="${id}"]`)?.focus(); return; }
  }
  // Arrow keys inside menus.
  const menu = e.target.closest?.('[role="menu"]');
  if (menu && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
    const items = $$('.menu-item:not(:disabled)', menu);
    const i = items.indexOf(document.activeElement);
    items[(i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus();
    e.preventDefault();
    return;
  }
  const typing = ['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName) || e.target.isContentEditable;
  if (typing) {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      const id = e.target.dataset.text || e.target.dataset.id;
      const a = id && S.asks.get(id);
      if (a) { e.preventDefault(); submitInput(a); }
    }
    if (e.key === 'Escape') e.target.blur();
    return;
  }
  if ((e.key === 'Enter' || e.key === ' ') && e.target.dataset?.act === 'toggle') { e.preventDefault(); e.target.click(); return; }
  if (e.ctrlKey || e.metaKey || e.altKey || $('#help').open) return;
  if (gPrefix && Date.now() - gPrefix < 1200) {
    gPrefix = 0;
    const v = { i: 'inbox', u: 'updates', s: 'snoozed', h: 'history', a: 'agents', r: 'rules', l: 'activity', ',': 'settings' }[e.key];
    if (v) { go(v); e.preventDefault(); }
    return;
  }
  if (e.key === 'g') { gPrefix = Date.now(); return; }
  if (e.key === '?') { $('#help').showModal(); return; }
  if (e.key === 'f') { openStatusMenu(); e.preventDefault(); return; }
  if (e.key === 'z') { if (S.pending.length) { const p = S.pending.at(-1); p.undo ? p.undo() : undo(p); toast('Undone'); } return; }
  const list = currentList();
  if (!list.length) return;
  const cur = selected();
  const i = list.indexOf(cur);
  if (e.key === 'j' || e.key === 'ArrowDown' || e.key === 'k' || e.key === 'ArrowUp') {
    const down = e.key === 'j' || e.key === 'ArrowDown';
    const next = list[Math.max(0, Math.min(list.length - 1, i + (down ? 1 : -1)))];
    S.selId = next.id;
    S.menu = null;
    render();
    document.getElementById(next.id)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    e.preventDefault();
    return;
  }
  const a = cur;
  if (!a) return;
  if (/^[1-9]$/.test(e.key) && a.kind === 'decision') { const o = a.options[Number(e.key) - 1]; if (o) answer(a, o.id); return; }
  if (e.key === 'e') { const d = $(`[data-more="${a.id}"]`); if (d) d.open = !d.open; else if (a.kind === 'inform') { S.open.has(a.id) ? S.open.delete(a.id) : S.open.add(a.id); render(); } return; }
  if (e.key === 'a') { const c = $(`[data-always="${a.id}"]`); if (c) { c.checked = !c.checked; c.dispatchEvent(new Event('change', { bubbles: true })); } return; }
  if (e.key === 's' && S.view !== 'snoozed') { S.menu = { type: 'snooze', id: a.id }; render(); $('.snooze-menu .menu-item:not(:disabled)')?.focus({ preventScroll: true }); return; }
  if (e.key === 'd') { dismiss(a); return; }
  if (e.key === 'Enter' && a.kind === 'inform') { ack(a); return; }
  if (e.key === 'Enter' && S.view === 'snoozed') unsnooze(a);
});

// If the tab closes mid-undo-window, send what's pending instead of dropping it.
window.addEventListener('pagehide', () => {
  for (const p of S.pending) { clearTimeout(p.timer); p.run(); }
  S.pending = [];
});

// -------------------------------------------------------------------- live

let refreshTimer = null;
function refreshSoon() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(async () => {
    try {
      await loadStats();
      if (S.view === 'history') await loadHistory();
      if (S.view === 'agents' || !S.agents.length) await loadAgents();
      if (S.view === 'activity') await loadLedger();
    } catch { /* the next event retries */ }
    scheduleRender();
  }, 300);
}

function connect() {
  const es = new EventSource(`/v1/events?token=${encodeURIComponent(TOKEN)}`);
  es.addEventListener('hello', async () => {
    S.connected = true;
    $('#offline').hidden = true;
    try {
      await Promise.all([loadAsks(), loadState(), loadRules(), loadStats(), loadAgents(), loadConfig(), loadIntegrations(), loadKeys(), loadNow()]);
    } catch (err) { fail(err); }
    if (!S.loaded) for (const id of S.asks.keys()) S.seen.add(id);
    S.loaded = true;
    const [view, id, anchor] = parseHash();
    await go(view, id, anchor);
  });
  const upsert = (e) => {
    const a = JSON.parse(e.data);
    S.asks.set(a.id, a);
    if (!isOpen(a)) { S.hidden.delete(a.id); S.drafts.delete(a.id); }
    if (S.menu?.id === a.id && !isOpen(a)) S.menu = null;
    scheduleRender();
    refreshSoon();
  };
  es.addEventListener('ask', upsert);
  es.addEventListener('update', upsert);
  es.addEventListener('state', async () => { await loadState().catch(() => {}); scheduleRender(); });
  es.addEventListener('rules', async () => { await loadRules().catch(() => {}); scheduleRender(); });
  es.addEventListener('reply', (e) => {
    const r = JSON.parse(e.data);
    if (r.state === 'sent') toast(`Sent to ${r.name}`, { sub: 'Its answer will show up here when it’s done' });
    else if (r.state === 'failed') replyFailed(r);
  });
  es.addEventListener('config', async () => {
    const wasPaired = !!S.config?.telegram?.paired;
    await loadConfig().catch(() => {});
    if (!wasPaired && S.config?.telegram?.paired) toast('Telegram connected', { sub: 'Switchboard will message you there when an agent needs you', ms: 6000 });
    scheduleRender();
  });
  es.addEventListener('agents', () => refreshSoon());
  es.addEventListener('interrupt', (e) => {
    const n = JSON.parse(e.data);
    if (!n.composed) return;
    if (document.hidden) {
      if ('Notification' in window && Notification.permission === 'granted') {
        const note = new Notification(n.composed.title, { body: n.composed.body, tag: n.id, icon: '/favicon.svg' });
        note.onclick = () => { window.focus(); note.close(); go('inbox', n.asks?.[0]); };
      }
    } else if (S.view !== 'inbox' && n.asks?.length) {
      toast(n.composed.title, { sub: n.composed.body.split('\n')[0], ms: 6000, action: { label: 'View', fn: () => go('inbox', n.asks[0]) } });
    }
  });
  es.onerror = () => {
    S.connected = false;
    $('#offline').hidden = false;
  };
}

connect();
