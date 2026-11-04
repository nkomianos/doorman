// Your standing orders. A rule matches asks by glob and either answers them
// for you or forces a route (now / digest / hold / mute).
import { findOption } from './spec.js';
import { matchGlob, newId } from './util.js';

export const ROUTES = ['now', 'digest', 'hold', 'mute'];
const MATCH_FIELDS = ['agent', 'kind', 'urgency', 'fingerprint', 'question', 'thread', 'tag'];

export function validateRule(input) {
  const errors = [];
  const match = input?.match;
  const action = input?.action;
  if (!match || typeof match !== 'object' || !Object.keys(match).some((k) => MATCH_FIELDS.includes(k))) {
    errors.push(`match needs at least one of ${MATCH_FIELDS.join(', ')}`);
  }
  if (!action || (action.answer == null && !ROUTES.includes(action.route))) {
    errors.push(`action needs "answer": <option> or "route": ${ROUTES.join('|')}`);
  }
  if (errors.length) throw Object.assign(new Error(errors.join('; ')), { status: 400 });
  const clean = {};
  for (const k of MATCH_FIELDS) if (match[k] != null) clean[k] = String(match[k]);
  return { match: clean, action: action.answer != null ? { answer: String(action.answer) } : { route: action.route } };
}

export function ruleMatches(rule, ask) {
  const m = rule.match;
  if (m.agent && !matchGlob(m.agent, ask.agent.id) && !matchGlob(m.agent, ask.agent.name)) return false;
  if (m.kind && !matchGlob(m.kind, ask.kind)) return false;
  if (m.urgency && !matchGlob(m.urgency, ask.urgency)) return false;
  if (m.fingerprint && !matchGlob(m.fingerprint, ask.fingerprint)) return false;
  if (m.question && !matchGlob(m.question, ask.question)) return false;
  if (m.thread && !matchGlob(m.thread, ask.thread)) return false;
  if (m.tag && !ask.tags.some((t) => matchGlob(m.tag, t))) return false;
  // An answer rule only applies when that option exists on this ask.
  if (rule.action.answer != null && !findOption(ask, rule.action.answer)) return false;
  return true;
}

export class Rules {
  constructor(list = [], clock = Date.now) {
    this.clock = clock;
    this.list = list.map((r) => ({ hits: 0, ...r }));
  }

  match(ask) {
    return this.list.find((r) => !r.disabled && ruleMatches(r, ask)) || null;
  }

  add(input, source = 'user') {
    const { match, action } = validateRule(input);
    const rule = { id: newId('rule'), match, action, note: input.note ? String(input.note) : null, source, created_at: this.clock(), hits: 0 };
    this.list.unshift(rule);
    return rule;
  }

  remove(id) {
    const i = this.list.findIndex((r) => r.id === id);
    if (i < 0) return null;
    return this.list.splice(i, 1)[0];
  }

  toJSON() {
    return this.list;
  }
}
