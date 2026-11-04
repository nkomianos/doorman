// Append-only, hash-chained decision ledger (JSONL). Every entry commits to the
// one before it, so editing or deleting history is detectable with `verify`.
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { canonicalJSON, sha256 } from './util.js';

const GENESIS = 'GENESIS';

export function hashEntry({ seq, ts, type, data, prev }) {
  return sha256(canonicalJSON({ seq, ts, type, data, prev }));
}

export class Ledger {
  /** file = null keeps the ledger in memory (tests). */
  constructor(file = null) {
    this.file = file;
    this.entries = [];
    this.seq = 0;
    this.prev = GENESIS;
    if (file && existsSync(file)) {
      for (const line of readFileSync(file, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        try {
          const e = JSON.parse(line);
          this.entries.push(e);
          this.seq = e.seq;
          this.prev = e.hash;
        } catch { /* a torn final line is reported by verify() */ }
      }
    }
  }

  append(type, data) {
    const entry = { seq: this.seq + 1, ts: new Date().toISOString(), type, data, prev: this.prev };
    entry.hash = hashEntry(entry);
    if (this.file) appendFileSync(this.file, `${JSON.stringify(entry)}\n`);
    this.entries.push(entry);
    if (this.entries.length > 5000) this.entries.splice(0, this.entries.length - 5000);
    this.seq = entry.seq;
    this.prev = entry.hash;
    return entry;
  }

  tail(limit = 100, type = null) {
    const list = type ? this.entries.filter((e) => e.type === type || e.type.startsWith(`${type}.`)) : this.entries;
    return list.slice(-limit).reverse();
  }

  verify() {
    if (this.file) return Ledger.verifyFile(this.file);
    return Ledger.verifyEntries(this.entries);
  }

  static verifyEntries(entries) {
    let prev = GENESIS;
    let seq = 0;
    for (const e of entries) {
      if (e.seq !== seq + 1) return { ok: false, count: seq, broken_at: e.seq, reason: `sequence gap: expected ${seq + 1}, got ${e.seq}` };
      if (e.prev !== prev) return { ok: false, count: seq, broken_at: e.seq, reason: 'prev hash does not match the previous entry' };
      if (hashEntry(e) !== e.hash) return { ok: false, count: seq, broken_at: e.seq, reason: 'entry content does not match its hash' };
      prev = e.hash;
      seq = e.seq;
    }
    return { ok: true, count: seq, head: prev };
  }

  static verifyFile(file) {
    if (!existsSync(file)) return { ok: true, count: 0, head: GENESIS };
    const entries = [];
    const lines = readFileSync(file, 'utf8').split('\n').filter((l) => l.trim());
    for (let i = 0; i < lines.length; i++) {
      try { entries.push(JSON.parse(lines[i])); } catch {
        return { ok: false, count: i, broken_at: i + 1, reason: `line ${i + 1} is not valid JSON` };
      }
    }
    return Ledger.verifyEntries(entries);
  }
}
