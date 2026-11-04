import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';
import { Router } from '../src/router.js';

let t;
const clock = () => t;
const advance = (ms, r) => { t += ms; r?.tick(); };

function makeRouter(config = {}) {
  const r = new Router({ config: { bundleWindowMs: 1000, digest: { times: [], onBreak: true }, ...config }, clock });
  const pings = [];
  r.on('interrupt', (n) => pings.push(n));
  return { r, pings };
}

const decision = (over = {}) => ({ agent: { id: 'coder', name: 'Coder' }, question: 'Run tests?', options: ['Allow', 'Deny'], ...over });

beforeEach(() => { t = new Date(2026, 10, 3, 10, 0, 0).getTime(); });

describe('routing', () => {
  test('asks arriving together become one interruption', () => {
    const { r, pings } = makeRouter();
    r.submit(decision());
    r.submit(decision({ agent: 'Mailer', question: 'Send reply?' }));
    r.submit(decision({ agent: 'Travel', question: 'Book flight?', urgency: 'high' }));
    advance(500, r);
    assert.equal(pings.length, 0, 'still inside the bundle window');
    advance(600, r);
    assert.equal(pings.length, 1);
    assert.equal(pings[0].asks.length, 3);
    for (const a of r.list()) assert.equal(a.delivery.mode, 'interrupted');
    assert.equal(r.stats.notifications, 1);
  });

  test('focus holds normal asks, lets urgent through, and flushes held ones at the natural break', () => {
    const { r, pings } = makeRouter();
    r.setState('focus');
    const normal = r.submit(decision());
    const fyi = r.submit({ agent: 'Mailer', question: 'Archived 3 newsletters' });
    assert.equal(normal.delivery.mode, 'held');
    assert.equal(fyi.delivery.mode, 'digest');
    const urgent = r.submit(decision({ question: 'Prod is down, roll back?', urgency: 'high' }));
    assert.equal(urgent.delivery.mode, 'queued');
    advance(1100, r);
    assert.equal(pings.length, 1);
    assert.deepEqual(pings[0].asks.map((a) => a.id), [urgent.id]);

    r.setState('available');
    assert.equal(pings.length, 2, 'natural break delivers immediately, in one notification');
    assert.deepEqual(pings[1].asks.map((a) => a.id), [normal.id]);
    assert.deepEqual(pings[1].digest.map((a) => a.id), [fyi.id]);
  });

  test('dnd only lets critical through, immediately', () => {
    const { r, pings } = makeRouter();
    r.setState('dnd');
    assert.equal(r.submit(decision({ urgency: 'high' })).delivery.mode, 'held');
    const crit = r.submit(decision({ urgency: 'critical', question: 'Card fraud detected, freeze?' }));
    assert.equal(pings.length, 1, 'critical skips the bundle window');
    assert.equal(crit.delivery.mode, 'interrupted');
  });

  test('low priority goes to the digest, delivered at digest time', () => {
    const { r, pings } = makeRouter({ digest: { times: ['10:30'], onBreak: true } });
    const low = r.submit({ agent: 'Mailer', question: 'Unsubscribed from 2 lists', urgency: 'low' });
    assert.equal(low.delivery.mode, 'digest');
    advance(20 * 60e3, r);
    assert.equal(pings.length, 0);
    advance(11 * 60e3, r);
    assert.equal(pings.length, 1);
    assert.equal(pings[0].kind, 'digest');
    assert.equal(pings[0].digest[0].id, low.id);
  });
});

describe('deadlines', () => {
  test('the default applies when nobody answers', () => {
    const { r } = makeRouter();
    r.setState('focus');
    const a = r.submit(decision({ default: 'Deny', deadline: '10m' }));
    assert.equal(a.delivery.mode, 'held', 'a safe default means no need to interrupt');
    advance(10 * 60e3 + 1, r);
    assert.equal(a.status, 'defaulted');
    assert.equal(a.answer.option, 'deny');
    assert.equal(a.answer.by, 'default');
  });

  test('no safe default: escalates near the deadline, then expires', () => {
    const { r, pings } = makeRouter();
    r.setState('focus');
    const a = r.submit(decision({ deadline: '20m' }));
    assert.equal(a.delivery.mode, 'held');
    advance(14 * 60e3, r);
    assert.equal(a.delivery.mode, 'held');
    advance(2 * 60e3, r); // 4 minutes left: inside the 5 minute window
    advance(1100, r);
    assert.equal(a.delivery.mode, 'interrupted');
    assert.match(a.delivery.notes.join(' '), /escalated/);
    assert.equal(pings.length, 1);
    advance(5 * 60e3, r);
    assert.equal(a.status, 'expired');
  });
});

describe('attention budgets', () => {
  test('dismissing an interruption halves the agent budget; acting on one grows it', () => {
    const { r } = makeRouter();
    const a = r.submit(decision());
    advance(1100, r);
    r.dismiss(a.id);
    assert.equal(r.budgets.get('coder').capacity, 3);
    const b = r.submit(decision());
    advance(1100, r);
    r.answer(b.id, { option: 'allow' });
    assert.equal(r.budgets.get('coder').capacity, 4);
  });

  test('an agent over budget is held, with the reason shown', () => {
    const { r } = makeRouter({ budget: { initial: 2, min: 1, max: 30 } });
    r.submit(decision({ question: 'one?' }));
    r.submit(decision({ question: 'two?' }));
    const third = r.submit(decision({ question: 'three?' }));
    assert.equal(third.delivery.mode, 'held');
    assert.match(third.delivery.reason, /over its attention budget/);
    const other = r.submit(decision({ agent: 'Mailer' }));
    assert.equal(other.delivery.mode, 'queued', 'budgets are per agent');
    advance(1100, r);
    assert.equal(third.delivery.mode, 'held');
    advance(30 * 60e3, r); // refill at 2/hr -> one token after 30 min
    assert.equal(third.delivery.mode, 'queued');
  });

  test('crying wolf: dismissed "urgent" asks lower the agent\'s urgency', () => {
    const { r } = makeRouter({ budget: { initial: 30, min: 1, max: 30 } });
    for (let i = 0; i < 4; i++) {
      const a = r.submit(decision({ question: `urgent ${i}?`, urgency: 'high' }));
      r.dismiss(a.id);
    }
    assert.ok(r.budgets.credibility('coder') < 0.5);
    r.setState('focus');
    const next = r.submit(decision({ question: 'really urgent this time?', urgency: 'high' }));
    assert.equal(next.delivery.mode, 'held');
    assert.match(next.delivery.notes[0], /urgency lowered/);
  });

  test('asks settled before the ping goes out are refunded', () => {
    const { r, pings } = makeRouter();
    const a = r.submit(decision());
    assert.equal(r.budgets.get('coder').tokens, 5);
    r.answer(a.id, { option: 'allow' }); // answered in the inbox within the bundle window
    assert.equal(r.budgets.get('coder').tokens, 6);
    advance(1100, r);
    assert.equal(pings.length, 0);
  });

  test('muted agents never interrupt but still show up', () => {
    const { r } = makeRouter();
    r.setMuted('coder', true);
    const a = r.submit(decision({ urgency: 'high' }));
    assert.equal(a.delivery.mode, 'held');
    assert.equal(r.list().length, 1);
  });
});

describe('rules and learning', () => {
  test('answer rules settle asks without bothering you', () => {
    const { r, pings } = makeRouter();
    r.addRule({ match: { agent: 'coder', fingerprint: 'Bash:npm test*' }, action: { answer: 'allow' } });
    const a = r.submit(decision({ fingerprint: 'Bash:npm test -- --watch=false' }));
    assert.equal(a.status, 'auto');
    assert.equal(a.answer.option, 'allow');
    advance(1100, r);
    assert.equal(pings.length, 0);
  });

  test('route rules: digest and mute', () => {
    const { r } = makeRouter();
    r.addRule({ match: { agent: 'Mailer' }, action: { route: 'digest' } });
    r.addRule({ match: { agent: 'Newsbot', kind: 'inform' }, action: { route: 'mute' } });
    assert.equal(r.submit(decision({ agent: 'Mailer', urgency: 'high' })).delivery.mode, 'digest');
    assert.equal(r.submit({ agent: 'Newsbot', question: 'Top stories' }).status, 'read');
  });

  test('three identical answers produce a suggestion; accepting it settles waiting asks', () => {
    const { r } = makeRouter({ budget: { initial: 30, min: 1, max: 30 } });
    for (let i = 0; i < 3; i++) r.answer(r.submit(decision({ fingerprint: 'Bash:npm test' })).id, { option: 'allow' });
    const [sug] = r.suggestions.values();
    assert.ok(sug, 'suggestion created');
    assert.equal(sug.option, 'allow');
    const waiting = r.submit(decision({ fingerprint: 'Bash:npm test' }));
    r.acceptSuggestion(sug.id);
    assert.equal(waiting.status, 'auto');
  });

  test('irreversible decisions are never suggested for automation', () => {
    const { r } = makeRouter({ budget: { initial: 30, min: 1, max: 30 } });
    for (let i = 0; i < 5; i++) r.answer(r.submit(decision({ fingerprint: 'git push', reversible: false })).id, { option: 'allow' });
    assert.equal(r.suggestions.size, 0);
  });

  test('"always" rules match literally, not as globs', () => {
    const { r } = makeRouter({ budget: { initial: 30, min: 1, max: 30 } });
    const a = r.submit(decision({ fingerprint: 'Bash:cat *.log | grep err' }));
    r.answer(a.id, { option: 'allow', always: true });
    assert.equal(r.submit(decision({ fingerprint: 'Bash:cat *.log | grep err' })).status, 'auto');
    assert.equal(r.submit(decision({ fingerprint: 'Bash:cat secrets.log | grep err' })).status, 'pending');
    assert.equal(r.submit(decision({ fingerprint: 'Bash:cat ' })).status, 'pending');
  });
});

describe('agent-facing behaviour', () => {
  test('wait() resolves when the human answers', async () => {
    const { r } = makeRouter();
    const a = r.submit(decision());
    const p = r.wait(a.id, 5000);
    r.answer(a.id, { option: 'Deny' });
    const done = await p;
    assert.equal(done.status, 'answered');
    assert.equal(done.answer.option, 'deny');
  });

  test('collapse_key replaces an unread FYI', () => {
    const { r } = makeRouter();
    const first = r.submit({ agent: 'Coder', question: 'Build 1/3', collapse_key: 'build' });
    const second = r.submit({ agent: 'Coder', question: 'Build 2/3', collapse_key: 'build' });
    assert.equal(first.status, 'read');
    assert.equal(first.answer.replaced_by, second.id);
    assert.equal(r.list().length, 1);
  });

  test('input asks validate required form fields', () => {
    const { r } = makeRouter();
    const a = r.submit({ agent: 'Travel', question: 'Passport details?', input: { schema: { type: 'object', properties: { number: { type: 'string' }, country: { type: 'string' } }, required: ['number'] } } });
    assert.throws(() => r.answer(a.id, { values: { country: 'PT' } }), /missing required: number/);
    r.answer(a.id, { values: { number: 'X1', country: 'PT' } });
    assert.equal(a.status, 'answered');
  });

  test('every decision lands in the ledger, and the chain verifies', () => {
    const { r } = makeRouter();
    const a = r.submit(decision());
    r.answer(a.id, { option: 'allow' });
    const types = r.ledger.entries.map((e) => e.type);
    assert.ok(types.includes('ask.created') && types.includes('ask.routed') && types.includes('ask.resolved'));
    const resolved = r.ledger.entries.find((e) => e.type === 'ask.resolved');
    assert.deepEqual(resolved.data.seen.options, ['Allow', 'Deny']);
    assert.equal(r.ledger.verify().ok, true);
  });
});
