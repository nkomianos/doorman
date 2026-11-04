import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { expandEvents, parseIcs } from '../src/ics.js';
import { Ledger } from '../src/ledger.js';
import { elicitationToAsk, answerToElicitResult } from '../src/proxy.js';
import { claudeInform, permissionAsk, permissionOutput } from '../src/hooks.js';
import { normalizeAsk, SpecError } from '../src/spec.js';
import { HumanState } from '../src/state.js';
import { matchGlob, parseDuration } from '../src/util.js';

describe('spec', () => {
  test('fills defaults and infers kind', () => {
    const a = normalizeAsk({ question: 'Deploy?', options: ['Ship it', { label: 'Wait', consequence: 'Release slips a day' }], default: 'wait', deadline: '15m', agent: 'CI Bot' }, 1000);
    assert.equal(a.kind, 'decision');
    assert.deepEqual(a.options.map((o) => o.id), ['ship-it', 'wait']);
    assert.equal(a.default.option, 'wait');
    assert.equal(a.deadline, 1000 + 15 * 60e3);
    assert.equal(a.agent.id, 'ci-bot');
    assert.equal(normalizeAsk({ question: 'FYI' }).kind, 'inform');
  });

  test('rejects bad asks with every problem listed', () => {
    try {
      normalizeAsk({ options: ['only one'], urgency: 'yesterday', default: 'nope' });
      assert.fail('should throw');
    } catch (err) {
      assert.ok(err instanceof SpecError);
      assert.equal(err.status, 400);
      const msg = err.errors.join('|');
      assert.match(msg, /question is required/);
      assert.match(msg, /at least 2 options/);
      assert.match(msg, /urgency/);
      assert.match(msg, /default "nope"/);
    }
  });
});

describe('util', () => {
  test('durations and globs', () => {
    assert.equal(parseDuration('90s'), 90000);
    assert.equal(parseDuration('2h'), 72e5);
    assert.equal(parseDuration('soon'), null);
    assert.ok(matchGlob('Bash:npm *', 'Bash:npm test'));
    assert.ok(matchGlob('create_*|delete_*', 'delete_repo'));
    assert.ok(!matchGlob('create_*|delete_*', 'list_repos'));
    assert.ok(matchGlob('a\\*b', 'a*b'));
    assert.ok(!matchGlob('a\\*b', 'axxb'));
  });
});

describe('calendar', () => {
  const ics = [
    'BEGIN:VCALENDAR',
    'BEGIN:VEVENT',
    'SUMMARY:Standup',
    'DTSTART:20261102T093000',
    'DTEND:20261102T094500',
    'RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR',
    'EXDATE:20261104T093000',
    'END:VEVENT',
    'BEGIN:VEVENT',
    'SUMMARY:Deep work',
    'DTSTART:20261103T140000',
    'DURATION:PT2H',
    'END:VEVENT',
    'BEGIN:VEVENT',
    'SUMMARY:Lunch (free)',
    'DTSTART:20261103T120000',
    'DTEND:20261103T130000',
    'TRANSP:TRANSPARENT',
    'END:VEVENT',
    'BEGIN:VEVENT',
    'SUMMARY:Holiday',
    'DTSTART;VALUE=DATE:20261105',
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n');
  const day = (d, h, m = 0) => new Date(2026, 10, d, h, m).getTime();

  test('expands weekly recurrences and honours EXDATE', () => {
    const occ = expandEvents(parseIcs(ics), day(2, 0), day(7, 0)).filter((e) => e.summary === 'Standup');
    assert.deepEqual(occ.map((e) => new Date(e.start).getDate()), [2, 3, 5, 6]);
  });

  test('human state follows the calendar but never exposes event titles', () => {
    let now = day(3, 9, 35);
    const s = new HumanState({ calendar: { ics: 'x' } }, () => now);
    s.events = expandEvents(parseIcs(ics), day(2, 0), day(7, 0));
    assert.equal(s.current().mode, 'focus');
    assert.equal(s.current().source, 'calendar');
    now = day(3, 12, 30);
    assert.equal(s.current().mode, 'available', 'transparent events are free time');
    now = day(3, 15, 0);
    assert.equal(s.current().mode, 'dnd', '"Deep work" blocks are do-not-disturb');
    assert.ok(!JSON.stringify(s.coarse()).includes('Deep work'));
    s.setManual('available');
    assert.equal(s.current().mode, 'available', 'manual state wins');
  });

  test('quiet hours wrap past midnight', () => {
    let now = day(3, 23, 0);
    const s = new HumanState({ quietHours: { start: '22:00', end: '07:30', mode: 'dnd' } }, () => now);
    assert.equal(s.current().mode, 'dnd');
    assert.equal(new Date(s.current().until).getHours(), 7);
    now = day(4, 8, 0);
    assert.equal(s.current().mode, 'available');
  });
});

describe('ledger', () => {
  test('detects tampering', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'doorman-ledger-')), 'ledger.jsonl');
    const l = new Ledger(file);
    l.append('ask.created', { id: 'a1', question: 'Deploy?' });
    l.append('ask.resolved', { id: 'a1', status: 'answered', answer: { option: 'deny' } });
    l.append('ask.created', { id: 'a2', question: 'Pay invoice?' });
    assert.equal(Ledger.verifyFile(file).ok, true);
    const reopened = new Ledger(file);
    reopened.append('x', {});
    assert.equal(Ledger.verifyFile(file).count, 4, 'chain continues across restarts');
    writeFileSync(file, readFileSync(file, 'utf8').replace('"deny"', '"allow"'));
    const v = Ledger.verifyFile(file);
    assert.equal(v.ok, false);
    assert.equal(v.broken_at, 2);
  });
});

describe('MCP elicitation mapping', () => {
  const agent = { id: 'c', name: 'C' };
  test('boolean, enum, text and form schemas', () => {
    const b = elicitationToAsk({ message: 'Proceed?', requestedSchema: { type: 'object', properties: { ok: { type: 'boolean' } } } }, { agent, serverName: 's' });
    assert.equal(b.ask.kind, 'decision');
    assert.deepEqual(answerToElicitResult({ status: 'answered', answer: { option: 'yes' } }, b.map), { action: 'accept', content: { ok: true } });
    const e = elicitationToAsk({ message: 'Env?', requestedSchema: { type: 'object', properties: { env: { type: 'string', enum: ['staging', 'prod'] } } } }, { agent, serverName: 's' });
    assert.deepEqual(e.ask.options.map((o) => o.label), ['staging', 'prod', 'Decline']);
    assert.deepEqual(answerToElicitResult({ status: 'answered', answer: { option: 'v1' } }, e.map), { action: 'accept', content: { env: 'prod' } });
    const f = elicitationToAsk({ message: 'Details', requestedSchema: { type: 'object', properties: { name: { type: 'string' }, age: { type: 'integer' } } } }, { agent, serverName: 's' });
    assert.equal(f.ask.kind, 'input');
    assert.deepEqual(answerToElicitResult({ status: 'answered', answer: { values: { name: 'Ada', age: '36' } } }, f.map), { action: 'accept', content: { name: 'Ada', age: 36 } });
    assert.deepEqual(answerToElicitResult({ status: 'expired', answer: null }, f.map), { action: 'cancel' });
    assert.deepEqual(answerToElicitResult({ status: 'answered', answer: { option: 'decline' } }, f.map), { action: 'decline' });
  });
});

describe('Claude Code hook mapping', () => {
  test('permission requests become decisions with useful fingerprints', () => {
    const a = permissionAsk({ hook_event_name: 'PermissionRequest', cwd: '/home/me/api', session_id: 's1', tool_name: 'Bash', tool_input: { command: 'git push origin main', description: 'Push' } });
    assert.equal(a.question, 'Run `git push origin main`?');
    assert.equal(a.fingerprint, 'Bash:git push origin main');
    assert.equal(a.reversible, false);
    assert.equal(a.agent.id, 'claude-code-api');
    const e = permissionAsk({ cwd: '/home/me/api', tool_name: 'Edit', tool_input: { file_path: '/home/me/api/src/app.js' } });
    assert.equal(e.question, 'Edit src/app.js?');
  });

  test('answers map to hook output', () => {
    assert.equal(permissionOutput({ final: true, status: 'answered', answer: { option: 'allow' } }).hookSpecificOutput.decision.behavior, 'allow');
    const deny = permissionOutput({ final: true, status: 'answered', answer: { option: 'deny', by: 'human' } });
    assert.equal(deny.hookSpecificOutput.decision.behavior, 'deny');
    assert.ok(deny.hookSpecificOutput.decision.message);
    assert.equal(permissionOutput({ final: true, status: 'cancelled' }), null, 'cancelled falls through to the terminal prompt');
  });

  test('Stop becomes a collapsible FYI; duplicate notifications are dropped', () => {
    const s = claudeInform({ hook_event_name: 'Stop', cwd: '/x/web', session_id: 's9', last_assistant_message: 'Done.' });
    assert.equal(s.kind, 'inform');
    assert.equal(s.collapse_key, 'claude-stop:s9');
    assert.equal(claudeInform({ hook_event_name: 'Stop', stop_hook_active: true }), null);
    assert.equal(claudeInform({ hook_event_name: 'Notification', notification_type: 'permission_prompt' }), null);
  });
});
