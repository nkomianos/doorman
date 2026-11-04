// The router: decides, for every ask from every agent, whether it may interrupt
// you now, should wait for a better moment, or belongs in the digest.
//
// Principle: the router controls *interruptions*, never *visibility*. Every ask
// is in the inbox the moment it arrives; only the ping is scheduled.
import { EventEmitter } from 'node:events';
import { Budgets } from './budget.js';
import { Ledger } from './ledger.js';
import { Rules } from './rules.js';
import { findOption, isOpen, normalizeAsk } from './spec.js';
import { HumanState, MODES } from './state.js';
import { URGENCY, escapeGlob, fmtDuration, hhmmToMinutes, newId, urgencyRank } from './util.js';

export const DEFAULT_ROUTER_CONFIG = {
  bundleWindowMs: 4000,
  credibilityFloor: 0.5,
  escalateBeforeMs: 5 * 60e3,
  learnThreshold: 3,
  budget: { initial: 6, min: 1, max: 30 },
  digest: { times: ['12:00', '17:30'], onBreak: true },
  quietHours: null,
  calendar: null,
};

const httpError = (status, message) => Object.assign(new Error(message), { status });

function summarize(ask) {
  return {
    id: ask.id,
    agent: ask.agent,
    kind: ask.kind,
    question: ask.question,
    options: ask.options.map((o) => o.id),
    urgency: ask.urgency,
    deadline: ask.deadline,
    default: ask.default,
    reversible: ask.reversible,
    fingerprint: ask.fingerprint,
    thread: ask.thread,
  };
}

export class Router extends EventEmitter {
  constructor({ config = {}, clock = Date.now, ledger, budgets, state, rules } = {}) {
    super();
    this.config = { ...DEFAULT_ROUTER_CONFIG, ...config };
    this.clock = clock;
    this.ledger = ledger ?? new Ledger();
    this.budgets = budgets ?? new Budgets(this.config.budget, clock);
    this.state = state ?? new HumanState(this.config, clock);
    this.rules = rules ?? new Rules([], clock);
    this.asks = new Map();
    this.bundle = null;
    this.waiters = new Map();
    this.streaks = new Map();
    this.answerLog = []; // recent decisions, for learning patterns across similar requests
    this.fyiLog = new Map(); // agent id -> recent update outcomes (read / dismissed)
    this.suggestions = new Map();
    this.declined = new Set();
    // notifications = times you were actually pinged (a bundle and a digest delivered together count once).
    this.stats = { asks: 0, notifications: 0, interruptions: 0, interrupted_asks: 0, bundled_asks: 0, held: 0, digested: 0, digests: 0, auto: 0, answered: 0, dismissed: 0, defaulted: 0, expired: 0 };
    this.lastState = this.state.current();
    this.lastDigestCheck = clock();
  }

  // ---------------------------------------------------------------- intake

  submit(input) {
    const now = this.clock();
    const ask = normalizeAsk(input, now);
    this.budgets.noteAsk(ask.agent, ask.urgency);
    this.stats.asks++;
    this.asks.set(ask.id, ask);
    this.ledger.append('ask.created', summarize(ask));
    this.emit('ask', ask);

    // Like a mobile push collapse_key: a newer FYI replaces the unread older one.
    if (ask.collapse_key) {
      for (const old of this.asks.values()) {
        if (old !== ask && isOpen(old) && old.kind === 'inform' && old.agent.id === ask.agent.id && old.collapse_key === ask.collapse_key) {
          this._finalize(old, 'read', { by: 'collapsed', surface: 'router', replaced_by: ask.id });
        }
      }
    }

    const rule = this.rules.match(ask);
    if (rule) {
      rule.hits++;
      rule.last_hit = now;
      this.emit('rules');
    }
    if (rule?.action.answer != null) {
      this._autoAnswer(ask, rule, now);
    } else if (rule?.action.route === 'mute' && ask.kind === 'inform') {
      ask.delivery = { mode: 'muted', reason: 'muted by your rule', at: now, rule: rule.id };
      this._finalize(ask, 'read', { by: `rule:${rule.id}`, surface: 'rule' });
    } else {
      if (rule) ask.rule = { id: rule.id, route: rule.action.route };
      this._applyRoute(ask, this._decide(ask, now), now);
    }
    this._prune(now);
    return ask;
  }

  _autoAnswer(ask, rule, now) {
    const opt = findOption(ask, rule.action.answer);
    ask.delivery = { mode: 'auto', reason: 'answered by your rule', at: now, rule: rule.id };
    this.stats.auto++;
    this.budgets.onOutcome(ask.agent, 'auto');
    this._finalize(ask, 'auto', { option: opt.id, by: `rule:${rule.id}`, surface: 'rule' });
  }

  // --------------------------------------------------------------- routing

  _decide(ask, now) {
    const st = this.state.current(now);
    const threshold = urgencyRank(st.interruptible_for);
    const notes = [];
    let rank = urgencyRank(ask.urgency);

    const cred = this.budgets.credibility(ask.agent);
    if (rank >= 2 && cred < this.config.credibilityFloor) {
      rank--;
      notes.push(`urgency lowered to ${URGENCY[rank]}: you dismissed most of this agent's "urgent" asks`);
    }
    if (ask.deadline && !ask.default && ask.kind !== 'inform') {
      const window = Math.min(this.config.escalateBeforeMs, (ask.deadline - ask.created_at) * 0.25);
      if (ask.deadline - now <= window && rank < 2) {
        rank = 2;
        notes.push('escalated: the deadline is close and there is no safe default');
      }
    }

    const rec = this.budgets.get(ask.agent);
    const forced = ask.rule?.route;
    if (forced === 'now') return { mode: 'interrupt', bypass: true, reason: 'your rule says always interrupt for this', notes };
    if (forced === 'digest') return { mode: 'digest', reason: 'your rule sends this to the digest', notes };
    if (forced === 'hold' || forced === 'mute') return { mode: 'held', reason: 'your rule says never interrupt for this', notes };
    if (rec.muted) return { mode: 'held', reason: `you muted ${rec.name}`, notes };

    if (ask.woke) {
      // A reminder you set yourself doesn't spend the agent's budget, but it still respects focus.
      ask.woke = false;
      if (Math.max(rank, 1) >= threshold) return { mode: 'interrupt', bypass: true, reason: 'your snooze ended', notes };
      return { mode: 'held', reason: `your snooze ended while you're ${MODES[st.mode].label.toLowerCase()}; waiting for a natural break`, notes };
    }
    if (rank >= threshold) {
      if (rank === 3) return { mode: 'interrupt', bypass: true, reason: 'critical', notes };
      const where = { available: 'available', focus: 'focused', dnd: 'in do-not-disturb', away: 'away' }[st.mode];
      if (this.budgets.canSpend(ask.agent)) return { mode: 'interrupt', reason: `${URGENCY[rank]} urgency while you're ${where}`, notes };
      const wait = fmtDuration(this.budgets.msUntilToken(ask.agent));
      return { mode: 'held', reason: `${rec.name} is over its attention budget (${Math.round(rec.capacity * 10) / 10}/hr); next slot in ${wait}`, notes };
    }
    if (rank === 0) return { mode: 'digest', reason: 'low priority, saved for your digest', notes };
    if (ask.kind === 'inform') return { mode: 'digest', reason: `FYI while you're ${MODES[st.mode].label.toLowerCase()}, saved for your digest`, notes };
    return { mode: 'held', reason: `you're ${MODES[st.mode].label.toLowerCase()}; waiting for a natural break`, notes };
  }

  _applyRoute(ask, d, now) {
    const prev = ask.delivery?.mode;
    if (d.mode === 'interrupt') {
      if (d.bypass) this.budgets.get(ask.agent).interrupts++;
      else this.budgets.spend(ask.agent);
      ask.delivery = { mode: 'queued', reason: d.reason, notes: d.notes, at: now, spent: !d.bypass };
      if (!this.bundle) this.bundle = { id: newId('bdl'), ids: [], opened: now };
      this.bundle.ids.push(ask.id);
    } else {
      ask.delivery = { mode: d.mode, reason: d.reason, notes: d.notes, at: now };
      if (d.mode === 'held' && !ask.was_held) { ask.was_held = true; this.stats.held++; }
      if (d.mode === 'digest' && !ask.was_digested) { ask.was_digested = true; this.stats.digested++; }
    }
    if (prev !== ask.delivery.mode) this.ledger.append('ask.routed', { id: ask.id, mode: ask.delivery.mode, reason: d.reason, notes: d.notes });
    this.emit('update', ask);
    if (d.mode === 'interrupt' && urgencyRank(ask.urgency) === 3) this._flush(now);
  }

  _flush(now, digestItems = []) {
    const bundle = this.bundle;
    this.bundle = null;
    const items = (bundle?.ids ?? []).map((id) => this.asks.get(id)).filter((a) => a && isOpen(a) && a.delivery?.mode === 'queued');
    if (!items.length && !digestItems.length) return null;
    const id = bundle?.id ?? newId('bdl');
    for (const a of items) {
      a.delivery = { ...a.delivery, mode: 'interrupted', bundle: id, bundle_size: items.length, delivered_at: now };
      this.emit('update', a);
    }
    this.stats.notifications++;
    if (items.length) {
      this.stats.interruptions++;
      this.stats.interrupted_asks += items.length;
      if (items.length > 1) this.stats.bundled_asks += items.length;
    }
    const st = this.state.current(now);
    const n = { id, kind: items.length ? 'interrupt' : 'digest', asks: items, digest: digestItems, surfaces: st.surfaces, state: st.mode, at: now };
    this.ledger.append('bundle.delivered', { id, asks: items.map((a) => a.id), digest: digestItems.map((a) => a.id), surfaces: st.surfaces });
    this.emit('interrupt', n);
    return n;
  }

  _collectDigest(now) {
    const items = [...this.asks.values()].filter((a) => isOpen(a) && a.delivery?.mode === 'digest' && !a.delivery.digested_at);
    for (const a of items) a.delivery.digested_at = now;
    if (items.length) this.stats.digests++;
    return items;
  }

  /** Deliver the digest now (also used by "show me everything" in the UI). */
  deliverDigest() {
    const now = this.clock();
    const items = this._collectDigest(now);
    if (!items.length) return null;
    return this._flush(now, items);
  }

  _digestDue(now) {
    const times = this.config.digest?.times ?? [];
    for (const t of times) {
      const mins = hhmmToMinutes(t);
      if (mins == null) continue;
      const d = new Date(now);
      const at = new Date(d.getFullYear(), d.getMonth(), d.getDate(), Math.floor(mins / 60), mins % 60).getTime();
      if (this.lastDigestCheck < at && at <= now) return true;
    }
    return false;
  }

  /** Called periodically by the daemon (and directly by tests with a fake clock). */
  tick() {
    const now = this.clock();
    let naturalBreak = false;

    const st = this.state.current(now);
    if (st.mode !== this.lastState.mode) {
      const was = urgencyRank(this.lastState.interruptible_for);
      this.ledger.append('state.changed', { from: this.lastState.mode, to: st.mode, source: st.source });
      naturalBreak = urgencyRank(st.interruptible_for) < was;
      this.lastState = st;
      this.emit('state', st);
    }

    for (const ask of this.asks.values()) {
      if (!isOpen(ask)) continue;
      if (ask.deadline && ask.deadline <= now) {
        this._timeout(ask);
        continue;
      }
      if (ask.delivery?.mode === 'snoozed' && ask.delivery.until <= now) {
        // You asked to be reminded: try to interrupt now (see _decide), else wait for a break.
        ask.woke = true;
        ask.delivery = { mode: 'held', reason: 'snooze ended', at: now };
      }
      // Held asks may now interrupt (natural break, budget refill, deadline pressure).
      // Digest decisions can still escalate; digest FYIs wait for the digest.
      const mode = ask.delivery?.mode;
      if (mode === 'held' || (mode === 'digest' && ask.kind !== 'inform')) {
        const d = this._decide(ask, now);
        if (d.mode === 'interrupt') this._applyRoute(ask, d, now);
      }
    }

    const digestDue = (naturalBreak && this.config.digest?.onBreak !== false) || this._digestDue(now);
    this.lastDigestCheck = now;
    if (digestDue) {
      const items = this._collectDigest(now);
      if (items.length || this.bundle) this._flush(now, items);
    } else if (this.bundle && now - this.bundle.opened >= this.config.bundleWindowMs) {
      this._flush(now);
    }
  }

  _timeout(ask) {
    const interrupted = ask.delivery?.mode === 'interrupted';
    if (ask.default) {
      this.stats.defaulted++;
      this._finalize(ask, 'defaulted', { option: ask.default.option, text: ask.default.text ?? null, by: 'default', surface: 'deadline' });
    } else {
      this.stats.expired++;
      this._finalize(ask, 'expired', null);
    }
    this.budgets.onOutcome(ask.agent, 'ignored', { interrupted, urgency: ask.urgency });
  }

  // ------------------------------------------------------------- responses

  _open(id) {
    const ask = this.asks.get(id);
    if (!ask) throw httpError(404, `no ask ${id}`);
    if (!isOpen(ask)) throw httpError(409, `ask ${id} is already ${ask.status}`);
    return ask;
  }

  answer(id, { option, text, values, surface = 'api', always = false } = {}) {
    const ask = this._open(id);
    const now = this.clock();
    if (ask.kind === 'inform') return this.ack(id, { surface });
    let opt = null;
    if (option != null) {
      opt = findOption(ask, option);
      if (!opt) throw httpError(400, `"${option}" is not an option on this ask`);
    }
    if (ask.kind === 'decision' && !opt) throw httpError(400, 'choose one of the options');
    if (ask.kind === 'input' && !opt && text == null && values == null) throw httpError(400, 'text or values is required');
    if (values != null && ask.input?.schema) {
      const missing = (ask.input.schema.required || []).filter((k) => values[k] == null || values[k] === '');
      if (missing.length) throw httpError(400, `missing required: ${missing.join(', ')}`);
    }
    const interrupted = ask.delivery?.mode === 'interrupted';
    const latency = now - (ask.delivery?.delivered_at ?? ask.created_at);
    this._finalize(ask, 'answered', { option: opt?.id ?? null, text: text ?? null, values: values ?? null, by: 'human', surface, latency_ms: latency });
    this.stats.answered++;
    this.budgets.onOutcome(ask.agent, 'answered', { interrupted, urgency: ask.urgency });
    if (opt && ask.kind === 'decision') {
      if (always) this._ruleFromAsk(ask, opt, 'always', `You chose "${opt.label}" and ticked "always"`);
      else this._learn(ask, opt);
    }
    return ask;
  }

  ack(id, { surface = 'api' } = {}) {
    const ask = this._open(id);
    const interrupted = ask.delivery?.mode === 'interrupted';
    this._finalize(ask, 'read', { by: 'human', surface });
    this.budgets.onOutcome(ask.agent, 'answered', { interrupted, urgency: ask.urgency });
    if (ask.kind === 'inform') this._learnFyi(ask, 'read');
    return ask;
  }

  dismiss(id, { surface = 'api' } = {}) {
    const ask = this._open(id);
    const interrupted = ask.delivery?.mode === 'interrupted';
    const answer = ask.default
      ? { option: ask.default.option, text: ask.default.text ?? null, by: 'default', surface, dismissed: true }
      : { option: null, by: 'human', surface, dismissed: true };
    this._finalize(ask, 'dismissed', answer);
    this.stats.dismissed++;
    this.budgets.onOutcome(ask.agent, 'dismissed', { interrupted, urgency: ask.urgency });
    if (ask.kind === 'inform') this._learnFyi(ask, 'dismissed');
    return ask;
  }

  snooze(id, ms, { surface = 'api' } = {}) {
    const ask = this._open(id);
    const now = this.clock();
    if (this.bundle) this.bundle.ids = this.bundle.ids.filter((x) => x !== id);
    const until = now + ms;
    const prev = ask.delivery?.mode === 'snoozed' ? ask.delivery.prev : ask.delivery;
    ask.delivery = { mode: 'snoozed', until, reason: `snoozed for ${fmtDuration(ms)}`, at: now, prev };
    this.ledger.append('ask.snoozed', { id, until, surface });
    this.emit('update', ask);
    return ask;
  }

  /** Undo a snooze: the ask goes back to where it was, without pinging you again. */
  unsnooze(id, { surface = 'api' } = {}) {
    const ask = this._open(id);
    if (ask.delivery?.mode !== 'snoozed') return ask;
    const prev = ask.delivery.prev;
    const now = this.clock();
    ask.delivery = prev && prev.mode !== 'queued' ? prev : { mode: 'held', reason: 'back from snooze', at: now };
    this.ledger.append('ask.unsnoozed', { id, surface });
    this.emit('update', ask);
    return ask;
  }

  cancel(id, reason = null) {
    const ask = this._open(id);
    this._finalize(ask, 'cancelled', { by: 'agent', reason });
    return ask;
  }

  _finalize(ask, status, answer) {
    const now = this.clock();
    ask.status = status;
    ask.answer = answer ? { ...answer, at: now } : null;
    ask.resolved_at = now;
    if (this.bundle) this.bundle.ids = this.bundle.ids.filter((x) => x !== ask.id);
    // Settled before the ping went out: it never cost you attention, so refund it.
    if (ask.delivery?.mode === 'queued') {
      const rec = this.budgets.get(ask.agent);
      rec.interrupts = Math.max(0, rec.interrupts - 1);
      if (ask.delivery.spent) rec.tokens = Math.min(rec.capacity, rec.tokens + 1);
      ask.delivery = { ...ask.delivery, mode: 'settled-before-ping' };
    }
    this.ledger.append('ask.resolved', {
      id: ask.id,
      agent: ask.agent.id,
      status,
      answer: ask.answer,
      // What the human was shown when they decided: the evidence an auditor needs.
      seen: { question: ask.question, options: ask.options.map((o) => o.label), detail: ask.detail.line ?? ask.detail.paragraph, delivery: ask.delivery?.mode, reversible: ask.reversible },
    });
    const ws = this.waiters.get(ask.id);
    if (ws) for (const w of [...ws]) w();
    this.emit('update', ask);
  }

  wait(id, timeoutMs) {
    const ask = this.asks.get(id);
    if (!ask) return Promise.reject(httpError(404, `no ask ${id}`));
    if (!isOpen(ask) || timeoutMs <= 0) return Promise.resolve(ask);
    return new Promise((resolve) => {
      let set = this.waiters.get(id);
      if (!set) this.waiters.set(id, (set = new Set()));
      const done = () => {
        clearTimeout(timer);
        set.delete(done);
        if (!set.size) this.waiters.delete(id);
        resolve(ask);
      };
      const timer = setTimeout(done, timeoutMs);
      set.add(done);
    });
  }

  // -------------------------------------------------------------- learning

  _key(ask) {
    return `${ask.agent.id}\u0000${ask.fingerprint}`;
  }

  _learn(ask, opt) {
    this.answerLog.push({ agent: ask.agent.id, fp: ask.fingerprint, option: opt.id, irreversible: ask.reversible === false, at: this.clock() });
    if (this.answerLog.length > 300) this.answerLog.splice(0, this.answerLog.length - 300);
    if (ask.reversible === false) return; // never suggest automating irreversible decisions
    if (!this._learnExact(ask, opt)) this._learnPattern(ask, opt);
  }

  _suggest(sug) {
    this.suggestions.set(sug.id, sug);
    this.ledger.append('suggestion.created', { id: sug.id, kind: sug.kind, agent: sug.agent.id, fingerprint: sug.fingerprint ?? null, option: sug.option ?? null, count: sug.count });
    this.emit('rules');
    return true;
  }

  /**
   * Generalise across similar requests: if you gave the same answer to 3+ different
   * requests that share a prefix (Bash:git status, Bash:git diff, Bash:git log), offer
   * one rule for the prefix. Only for tool-style fingerprints the agent set itself,
   * and never if you ever answered differently, or the action was irreversible.
   */
  _learnPattern(ask, opt) {
    const fp = ask.fingerprint;
    if (!fp || fp.startsWith(`${ask.agent.id}:`)) return false;
    const head = fp.indexOf(':') + 1;
    if (head <= 1) return false;
    const mine = this.answerLog.filter((h) => h.agent === ask.agent.id && h.fp);
    for (let i = fp.length - 2; i >= head + 1; i--) {
      if (!' /\\:.'.includes(fp[i])) continue;
      const prefix = fp.slice(0, i + 1);
      const hits = mine.filter((h) => h.fp.startsWith(prefix));
      const distinct = [...new Set(hits.map((h) => h.fp))];
      if (distinct.length < this.config.learnThreshold) continue;
      if (hits.some((h) => h.option !== opt.id || h.irreversible)) return false;
      const glob = `${escapeGlob(prefix)}*`;
      const key = `${ask.agent.id}\u0000${glob}`;
      if (this.declined.has(`${key}\u0000${opt.id}`)) return false;
      if ([...this.suggestions.values()].some((x) => x.key === key)) return false;
      if (this.rules.list.some((r) => r.action.answer != null && r.match.fingerprint === glob)) return false;
      return this._suggest({
        id: newId('sug'),
        kind: 'answer',
        key,
        agent: { id: ask.agent.id, name: ask.agent.name },
        fingerprint: glob,
        glob: true,
        examples: distinct.slice(-4),
        option: opt.id,
        label: opt.label,
        count: distinct.length,
        question: ask.question,
        why: `You answered “${opt.label}” to ${distinct.length} different requests starting with “${prefix.trim()}”, and never anything else`,
        created_at: this.clock(),
      });
    }
    return false;
  }

  /** Updates you keep marking "not useful" are better off in the digest. */
  _learnFyi(ask, outcome) {
    const list = this.fyiLog.get(ask.agent.id) || [];
    list.push(outcome);
    if (list.length > 10) list.shift();
    this.fyiLog.set(ask.agent.id, list);
    const dismissed = list.filter((x) => x === 'dismissed').length;
    if (dismissed < 3 || dismissed < 2 * (list.length - dismissed)) return;
    const key = `${ask.agent.id}\u0000route:inform`;
    if (this.declined.has(`${key}\u0000digest`) || [...this.suggestions.values()].some((x) => x.key === key)) return;
    if (this.rules.list.some((r) => r.action.route && r.match.kind === 'inform' && r.match.agent === escapeGlob(ask.agent.id))) return;
    this._suggest({
      id: newId('sug'),
      kind: 'route',
      key,
      agent: { id: ask.agent.id, name: ask.agent.name },
      match: { agent: escapeGlob(ask.agent.id), kind: 'inform' },
      action: { route: 'digest' },
      option: 'digest',
      label: 'Send to digest',
      count: dismissed,
      sentence: `Stop pinging you for ${ask.agent.name}’s updates and save them for your digest?`,
      why: `You marked ${dismissed} of its last ${list.length} updates as not useful`,
      created_at: this.clock(),
    });
  }

  _learnExact(ask, opt) {
    const key = this._key(ask);
    const s = this.streaks.get(key);
    const streak = s && s.option === opt.id ? { ...s, count: s.count + 1 } : { option: opt.id, count: 1 };
    this.streaks.set(key, streak);
    if (streak.count < this.config.learnThreshold) return false;
    if (this.declined.has(`${key}\u0000${opt.id}`)) return false;
    if ([...this.suggestions.values()].some((x) => x.key === key)) return true;
    if (this.rules.list.some((r) => r.action.answer != null && r.match.fingerprint === escapeGlob(ask.fingerprint))) return true;
    return this._suggest({
      id: newId('sug'),
      kind: 'answer',
      key,
      agent: { id: ask.agent.id, name: ask.agent.name },
      fingerprint: ask.fingerprint,
      option: opt.id,
      label: opt.label,
      count: streak.count,
      question: ask.question,
      why: `You answered “${opt.label}” the last ${streak.count} times`,
      created_at: this.clock(),
    });
  }

  _ruleFromAsk(ask, opt, source, note) {
    const rule = this.rules.add({ match: { agent: escapeGlob(ask.agent.id), fingerprint: escapeGlob(ask.fingerprint) }, action: { answer: opt.id }, note }, source);
    this.ledger.append('rule.created', { rule });
    this.emit('rules');
    return rule;
  }

  acceptSuggestion(id) {
    const s = this.suggestions.get(id);
    if (!s) throw httpError(404, `no suggestion ${id}`);
    this.suggestions.delete(id);
    const rule = s.kind === 'route'
      ? this.rules.add({ match: s.match, action: s.action, note: `Learned: ${s.why}` }, 'learned')
      : this.rules.add({ match: { agent: escapeGlob(s.agent.id), fingerprint: s.glob ? s.fingerprint : escapeGlob(s.fingerprint) }, action: { answer: s.option }, note: `Learned: ${s.why || `you chose "${s.label}" ${s.count}× in a row`}` }, 'learned');
    this.ledger.append('rule.created', { rule, from_suggestion: id });
    this.applyRulesToOpen();
    this.emit('rules');
    return rule;
  }

  declineSuggestion(id) {
    const s = this.suggestions.get(id);
    if (!s) throw httpError(404, `no suggestion ${id}`);
    this.suggestions.delete(id);
    this.declined.add(`${s.key}\u0000${s.option}`);
    this.ledger.append('suggestion.declined', { id });
    this.emit('rules');
    return s;
  }

  addRule(input, source = 'user') {
    const rule = this.rules.add(input, source);
    this.ledger.append('rule.created', { rule });
    this.applyRulesToOpen();
    this.emit('rules');
    return rule;
  }

  removeRule(id) {
    const rule = this.rules.remove(id);
    if (!rule) throw httpError(404, `no rule ${id}`);
    this.ledger.append('rule.removed', { id });
    this.emit('rules');
    return rule;
  }

  /** A new rule also settles matching asks that are already waiting. */
  applyRulesToOpen() {
    const now = this.clock();
    for (const ask of this.asks.values()) {
      if (!isOpen(ask) || ask.kind !== 'decision') continue;
      const rule = this.rules.match(ask);
      if (rule?.action.answer != null) {
        rule.hits++;
        this._autoAnswer(ask, rule, now);
      }
    }
  }

  setMuted(agentId, muted) {
    this.budgets.setMuted(agentId, muted);
    this.ledger.append('agent.muted', { agent: agentId, muted: !!muted });
    this.emit('agents');
  }

  setState(mode, until = null, note = null) {
    this.state.setManual(mode, until, note);
    this.tick();
    this.emit('state', this.state.current());
    return this.state.current();
  }

  // ----------------------------------------------------------------- views

  get(id) {
    return this.asks.get(id) || null;
  }

  list({ status = 'open', kind = null, limit = 200 } = {}) {
    let list = [...this.asks.values()];
    if (status === 'open') list = list.filter(isOpen);
    else if (status === 'closed') list = list.filter((a) => !isOpen(a));
    else if (status !== 'all') list = list.filter((a) => a.status === status);
    if (kind) list = list.filter((a) => (kind === 'asks' ? a.kind !== 'inform' : a.kind === kind));
    if (status === 'open') {
      list.sort((a, b) => urgencyRank(b.urgency) - urgencyRank(a.urgency) || (a.deadline ?? Infinity) - (b.deadline ?? Infinity) || a.created_at - b.created_at);
    } else {
      list.sort((a, b) => (b.resolved_at ?? b.created_at) - (a.resolved_at ?? a.created_at));
    }
    return list.slice(0, limit);
  }

  counts() {
    const open = [...this.asks.values()].filter(isOpen);
    return {
      needs_you: open.filter((a) => a.kind !== 'inform').length,
      fyi: open.filter((a) => a.kind === 'inform').length,
      held: open.filter((a) => a.delivery?.mode === 'held' || a.delivery?.mode === 'snoozed').length,
      digest: open.filter((a) => a.delivery?.mode === 'digest' && !a.delivery.digested_at).length,
    };
  }

  _prune(now) {
    if (this.asks.size < 2000) return;
    const cutoff = now - 7 * 864e5;
    for (const [id, a] of this.asks) if (!isOpen(a) && (a.resolved_at ?? 0) < cutoff) this.asks.delete(id);
    if (this.asks.size < 2000) return;
    const closed = [...this.asks.values()].filter((a) => !isOpen(a)).sort((a, b) => a.resolved_at - b.resolved_at);
    for (const a of closed.slice(0, this.asks.size - 1500)) this.asks.delete(a.id);
  }

  toJSON() {
    return {
      asks: [...this.asks.values()],
      bundle: this.bundle,
      streaks: [...this.streaks],
      answerLog: this.answerLog,
      fyiLog: [...this.fyiLog],
      suggestions: [...this.suggestions.values()],
      declined: [...this.declined],
      stats: this.stats,
      lastDigestCheck: this.lastDigestCheck,
    };
  }

  load(data) {
    if (!data) return;
    for (const a of data.asks || []) this.asks.set(a.id, a);
    this.bundle = data.bundle || null;
    this.streaks = new Map(data.streaks || []);
    this.answerLog = data.answerLog || [];
    this.fyiLog = new Map(data.fyiLog || []);
    this.suggestions = new Map((data.suggestions || []).map((s) => [s.id, s]));
    this.declined = new Set(data.declined || []);
    Object.assign(this.stats, data.stats || {});
    if (data.lastDigestCheck) this.lastDigestCheck = data.lastDigestCheck;
    this.lastState = this.state.current();
  }
}
