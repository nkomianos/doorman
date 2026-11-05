// Agent keys: give a script or another agent its own key instead of your owner
// token. A key can ask, notify, wait for its own answers and read your coarse
// state. It can't answer, read your inbox, change settings, or claim to be a
// different agent: its asks are always attributed to the key's agent id.
import { createHash, timingSafeEqual } from 'node:crypto';
import { readJSON, writeJSON } from './config.js';
import { newId, randomToken, slug } from './util.js';

const hash = (key) => createHash('sha256').update(key).digest('hex');

export class AgentKeys {
  constructor(file) {
    this.file = file;
    this.keys = file ? readJSON(file, []) : [];
  }

  _save() {
    if (this.file) writeJSON(this.file, this.keys);
  }

  list() {
    return this.keys.map(({ hash: _h, ...k }) => k);
  }

  create({ name, agentId } = {}) {
    const label = String(name || '').trim();
    if (!label) throw Object.assign(new Error('give the key a name, e.g. "Nightly backup"'), { status: 400 });
    const key = `sbk_${randomToken().replace(/[^A-Za-z0-9]/g, '').slice(0, 32)}`;
    const rec = { id: newId('key'), name: label, agent_id: agentId ? String(agentId) : `key-${slug(label)}`, prefix: key.slice(0, 7), hash: hash(key), created_at: Date.now(), last_used: null };
    this.keys.push(rec);
    this._save();
    const { hash: _h, ...pub } = rec;
    return { ...pub, key }; // the only time the full key is shown
  }

  revoke(id) {
    const before = this.keys.length;
    this.keys = this.keys.filter((k) => k.id !== id);
    if (this.keys.length === before) throw Object.assign(new Error(`no key ${id}`), { status: 404 });
    this._save();
    return { ok: true };
  }

  /** The key record for a presented secret, or null. */
  check(given) {
    if (!given || !given.startsWith('sbk_')) return null;
    const h = Buffer.from(hash(given));
    const rec = this.keys.find((k) => {
      const b = Buffer.from(k.hash);
      return b.length === h.length && timingSafeEqual(b, h);
    });
    if (rec) {
      rec.last_used = Date.now();
      clearTimeout(this._t);
      this._t = setTimeout(() => this._save(), 2000);
      this._t.unref?.();
    }
    return rec || null;
  }
}
