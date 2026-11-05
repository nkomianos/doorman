// The Ask format (switchboard.ask/0.1). See spec/ask-v0.1.md for the prose version.
import { URGENCY, newId, parseWhen, slug, truncate } from './util.js';

export const SPEC_VERSION = 'switchboard.ask/0.1';
export const KINDS = ['decision', 'input', 'inform'];
export const OPEN_STATUSES = ['pending', 'unread'];
export const OPTION_STYLES = ['default', 'primary', 'danger'];
const MAX_OPTIONS = 8;

export class SpecError extends Error {
  constructor(errors) {
    super(`Invalid ask: ${errors.join('; ')}`);
    this.errors = errors;
    this.status = 400;
  }
}

export const isOpen = (ask) => OPEN_STATUSES.includes(ask.status);

const str = (v) => (v == null ? null : String(v).trim() || null);

function normalizeAgent(agent, errors) {
  if (agent == null) return { id: 'unknown', name: 'Unknown agent', instance: null };
  if (typeof agent === 'string') return { id: slug(agent), name: agent, instance: null };
  if (typeof agent !== 'object') {
    errors.push('agent must be a string or {id, name}');
    return { id: 'unknown', name: 'Unknown agent', instance: null };
  }
  const id = str(agent.id) || (agent.name ? slug(agent.name) : 'unknown');
  return { id, name: str(agent.name) || id, instance: str(agent.instance) };
}

function normalizeOptions(raw, errors) {
  if (raw == null) return [];
  if (!Array.isArray(raw)) {
    errors.push('options must be an array');
    return [];
  }
  if (raw.length > MAX_OPTIONS) errors.push(`at most ${MAX_OPTIONS} options`);
  const seen = new Set();
  return raw.slice(0, MAX_OPTIONS).map((o, i) => {
    const opt = typeof o === 'string' ? { label: o } : o && typeof o === 'object' ? o : null;
    if (!opt || !str(opt.label ?? opt.id)) {
      errors.push(`options[${i}] needs a label`);
      return { id: `option-${i}`, label: `Option ${i + 1}` };
    }
    const label = str(opt.label ?? opt.id);
    let id = str(opt.id) || slug(label);
    while (seen.has(id)) id = `${id}-${i}`;
    seen.add(id);
    const style = OPTION_STYLES.includes(opt.style) ? opt.style : 'default';
    return { id, label: truncate(label, 60), consequence: str(opt.consequence), style };
  });
}

function normalizeInput(raw, errors) {
  if (raw == null) return null;
  if (raw === true || raw === 'text') return { type: 'text', placeholder: null, schema: null };
  if (typeof raw !== 'object') {
    errors.push('input must be an object');
    return null;
  }
  const schema = raw.schema && typeof raw.schema === 'object' ? raw.schema : null;
  if (schema && (schema.type !== 'object' || typeof schema.properties !== 'object')) {
    errors.push('input.schema must be a flat object schema with properties');
  }
  return { type: schema ? 'form' : 'text', placeholder: str(raw.placeholder), schema };
}

function normalizeDetail(raw) {
  if (raw == null) return { line: null, paragraph: null, full: null };
  if (typeof raw === 'string') return { line: null, paragraph: raw, full: null };
  return { line: str(raw.line), paragraph: str(raw.paragraph), full: raw.full == null ? null : String(raw.full) };
}

/** Resolve an option reference (id or label, case-insensitive). */
export function findOption(ask, ref) {
  if (ref == null) return null;
  const r = String(ref).toLowerCase();
  return ask.options.find((o) => o.id.toLowerCase() === r) || ask.options.find((o) => o.label.toLowerCase() === r) || null;
}

/** Validate an incoming ask and fill in defaults. Throws SpecError. */
export function normalizeAsk(input, now = Date.now()) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new SpecError(['body must be a JSON object']);
  const errors = [];
  const options = normalizeOptions(input.options, errors);
  const inputSpec = normalizeInput(input.input, errors);
  const kind = input.kind ?? (options.length ? 'decision' : inputSpec ? 'input' : 'inform');
  if (!KINDS.includes(kind)) errors.push(`kind must be one of ${KINDS.join(', ')}`);
  if (kind === 'decision' && options.length < 2) errors.push('a decision needs at least 2 options');
  if (kind === 'input' && !inputSpec) errors.push('an input ask needs an `input` field');

  const question = str(input.question ?? input.title ?? input.message);
  if (!question) errors.push('question is required');
  else if (question.length > 300) errors.push('question must be ≤ 300 chars; put the rest in detail');

  const urgency = input.urgency ?? 'normal';
  if (!URGENCY.includes(urgency)) errors.push(`urgency must be one of ${URGENCY.join(', ')}`);

  const deadline = parseWhen(input.deadline, now);
  if (input.deadline != null && deadline == null) errors.push('deadline must be ISO time, epoch ms, or a duration like "10m"');
  else if (deadline != null && deadline <= now) errors.push('deadline is in the past');

  const ask = {
    spec: SPEC_VERSION,
    id: newId('ask'),
    agent: normalizeAgent(input.agent, errors),
    kind,
    question,
    options,
    input: inputSpec,
    urgency,
    deadline,
    default: null,
    reversible: typeof input.reversible === 'boolean' ? input.reversible : null,
    delay_cost: str(input.delay_cost),
    detail: normalizeDetail(input.detail),
    thread: str(input.thread),
    collapse_key: str(input.collapse_key),
    tags: Array.isArray(input.tags) ? input.tags.map(String).slice(0, 10) : [],
    fingerprint: null,
    metadata: input.metadata && typeof input.metadata === 'object' ? input.metadata : null,
    created_at: now,
    status: kind === 'inform' ? 'unread' : 'pending',
    delivery: null,
    answer: null,
  };

  const def = input.default;
  if (def != null && kind !== 'inform') {
    const ref = typeof def === 'object' ? def.option ?? def.id : def;
    const reason = typeof def === 'object' ? str(def.reason) : null;
    if (kind === 'decision') {
      const opt = findOption(ask, ref);
      if (!opt) errors.push(`default "${ref}" does not match any option`);
      else ask.default = { option: opt.id, reason };
    } else {
      ask.default = { option: null, text: str(typeof def === 'object' ? def.text : def), reason };
    }
  }

  ask.fingerprint = str(input.fingerprint) || `${ask.agent.id}:${(question || '').toLowerCase().replace(/\s+/g, ' ').slice(0, 120)}`;
  if (errors.length) throw new SpecError(errors);
  return ask;
}

/** What an agent gets back. */
export function answerView(ask) {
  const opt = ask.answer?.option ? findOption(ask, ask.answer.option) : null;
  return {
    id: ask.id,
    status: ask.status,
    final: !isOpen(ask),
    answer: ask.answer
      ? { option: ask.answer.option ?? null, label: opt?.label ?? null, text: ask.answer.text ?? null, values: ask.answer.values ?? null, by: ask.answer.by, at: ask.answer.at }
      : null,
    delivery: ask.delivery ? { mode: ask.delivery.mode, reason: ask.delivery.reason } : null,
  };
}
