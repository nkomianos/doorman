import { randomBytes, createHash } from 'node:crypto';

export const URGENCY = ['low', 'normal', 'high', 'critical'];
export const urgencyRank = (u) => URGENCY.indexOf(u);

export function newId(prefix) {
  return `${prefix}_${Date.now().toString(36)}${randomBytes(4).toString('hex')}`;
}

export function randomToken(bytes = 24) {
  return randomBytes(bytes).toString('base64url');
}

/** "90s" | "10m" | "2h" | "1d" | 1500 (ms) -> milliseconds, or null if unparseable. */
export function parseDuration(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const m = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)?$/i.exec(String(value).trim());
  if (!m) return null;
  const mult = { ms: 1, s: 1e3, m: 6e4, h: 36e5, d: 864e5 }[(m[2] || 's').toLowerCase()];
  return Math.round(parseFloat(m[1]) * mult);
}

/** Absolute time from an ISO string, epoch ms, or a relative duration ("10m"). */
export function parseWhen(value, now = Date.now()) {
  if (value == null || value === '') return null;
  if (typeof value === 'number') return value > 1e12 ? value : now + value;
  const rel = parseDuration(value);
  if (rel != null) return now + rel;
  const t = Date.parse(value);
  return Number.isNaN(t) ? null : t;
}

export function fmtDuration(ms) {
  if (ms == null) return '';
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return m % 60 ? `${h}h${m % 60}m` : `${h}h`;
}

const escapeRe = (c) => c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Case-insensitive glob: `*` any run, `?` one char, `|` alternatives, `\` escapes. */
export function globToRegExp(glob) {
  const s = String(glob);
  const alts = [];
  let cur = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\\' && i + 1 < s.length) cur += escapeRe(s[++i]);
    else if (c === '*') cur += '.*';
    else if (c === '?') cur += '.';
    else if (c === '|') { alts.push(cur); cur = ''; }
    else cur += escapeRe(c);
  }
  alts.push(cur);
  return new RegExp(`^(?:${alts.join('|')})$`, 'is');
}

/** Make a literal string safe to use as a glob that matches only itself. */
export const escapeGlob = (s) => String(s).replace(/[\\*?|]/g, '\\$&');

export function matchGlob(pattern, value) {
  if (pattern == null) return true;
  if (value == null) return false;
  return globToRegExp(pattern).test(String(value));
}

export function slug(s) {
  return String(s).toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'option';
}

/** JSON with recursively sorted keys, so hashes are stable. */
export function canonicalJSON(value) {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJSON).join(',')}]`;
  const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJSON(value[k])}`).join(',')}}`;
}

export const sha256 = (s) => createHash('sha256').update(s).digest('hex');

export function truncate(s, n) {
  if (s == null) return s;
  s = String(s);
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

/** Minutes since local midnight for "HH:MM". */
export function hhmmToMinutes(s) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || '').trim());
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

export function minutesOfDay(t) {
  const d = new Date(t);
  return d.getHours() * 60 + d.getMinutes();
}
