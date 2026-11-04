// `doorman demo`: three simulated agents (coding, email, travel) hit you at once.
// Shows what reaches you with Doorman versus every agent pinging you directly.
import { DoormanClient } from './client.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const CODER = { id: 'demo-coder', name: 'Coding agent' };
const MAIL = { id: 'demo-mail', name: 'Email agent' };
const TRAVEL = { id: 'demo-travel', name: 'Travel agent' };

export const SCRIPT = [
  { at: 0, agent: CODER, kind: 'decision', question: 'Run `npm test` in api/?', options: [{ id: 'allow', label: 'Allow', style: 'primary' }, { id: 'deny', label: 'Deny' }], fingerprint: 'Bash:npm test', reversible: true, detail: { line: 'Verifying the refactor of the billing module' } },
  { at: 300, agent: MAIL, kind: 'inform', question: 'Archived 14 newsletters and 3 receipts', urgency: 'low' },
  { at: 600, agent: TRAVEL, kind: 'decision', question: 'Lisbon flight dropped to €212 (was €298). Book it?', urgency: 'high', options: [{ id: 'book', label: 'Book', style: 'primary', consequence: 'Charges your saved card €212' }, { id: 'skip', label: 'Skip', consequence: 'Keep watching the price' }], default: 'skip', deadline: '20m', reversible: false, delay_cost: 'Fare usually rebounds within the hour', detail: { line: 'TAP TP1351, Fri 14 Nov, 08:10 → 10:25', paragraph: 'Same itinerary you starred on Monday. Price is 29% below the 30-day median. Free cancellation for 24h does not apply to this fare class.' } },
  { at: 900, agent: MAIL, kind: 'decision', question: 'Reply to Dana accepting Thursday 3pm?', options: [{ id: 'send', label: 'Send reply', style: 'primary' }, { id: 'edit', label: 'Let me edit' }, { id: 'decline', label: 'Decline politely' }], default: 'edit', deadline: '2h', detail: { line: 'Draft: "Thursday 3pm works, see you then."', full: 'Hi Dana,\n\nThursday 3pm works for me. See you then.\n\nBest,\n—' }, thread: 'dana-meeting' },
  { at: 1200, agent: CODER, kind: 'decision', question: 'Run `npm test` in api/?', options: [{ id: 'allow', label: 'Allow', style: 'primary' }, { id: 'deny', label: 'Deny' }], fingerprint: 'Bash:npm test', reversible: true },
  { at: 1500, agent: MAIL, kind: 'inform', question: 'Your package from Hoka is out for delivery', urgency: 'low' },
  { at: 1800, agent: CODER, kind: 'decision', question: 'Push 3 commits to main?', urgency: 'high', options: [{ id: 'push', label: 'Push', style: 'danger', consequence: 'Triggers production deploy' }, { id: 'pr', label: 'Open a PR instead', style: 'primary' }], default: 'pr', deadline: '30m', reversible: false, detail: { line: 'refactor(billing): extract invoice calculator', full: 'a1b2c3d refactor(billing): extract invoice calculator\ne4f5a6b test(billing): cover proration\n9c8d7e6 chore: bump deps' } },
  { at: 2100, agent: TRAVEL, kind: 'inform', question: 'Hotel in Alfama confirmed for 14–17 Nov', urgency: 'normal' },
  { at: 2400, agent: MAIL, kind: 'decision', question: 'Unsubscribe from "Weekly Growth Hacks"?', urgency: 'low', options: ['Unsubscribe', 'Keep'], default: 'Keep', deadline: '1d' },
  { at: 2700, agent: CODER, kind: 'decision', question: 'Run `npm test` in api/?', options: [{ id: 'allow', label: 'Allow', style: 'primary' }, { id: 'deny', label: 'Deny' }], fingerprint: 'Bash:npm test', reversible: true },
  { at: 3000, agent: TRAVEL, kind: 'input', question: 'Any seat preference for the Lisbon flight?', input: { type: 'text', placeholder: 'e.g. aisle, front of the plane' }, urgency: 'low' },
  { at: 3300, agent: CODER, kind: 'inform', question: 'Refactor done: 12 files changed, all tests pass', urgency: 'normal', collapse_key: 'coder-status' },
];

export async function runDemo({ client = new DoormanClient(), log = console.log, speed = 1 } = {}) {
  if (!(await client.ensure())) throw new Error('could not reach or start the doorman daemon');
  const before = (await client.request('GET', '/v1/stats')).stats;
  log(`\nThree agents are about to need you: ${CODER.name}, ${MAIL.name}, ${TRAVEL.name}.`);
  log(`Open the inbox to answer: ${client.url}/\n`);
  const start = Date.now();
  for (const step of SCRIPT) {
    const wait = step.at / speed - (Date.now() - start);
    if (wait > 0) await sleep(wait);
    const { at, ...ask } = step;
    void at;
    const r = await client.submit({ ...ask, tags: ['demo'] });
    log(`  ${ask.agent.name.padEnd(13)} → ${ask.question}\n${''.padEnd(18)}${r.status === 'auto' ? 'auto-answered by your rule' : `${r.delivery?.mode}: ${r.delivery?.reason}`}`);
  }
  // Let the bundle window close (it runs in real time, whatever the demo speed).
  const { config } = await client.request('GET', '/v1/config');
  await sleep((config.bundleWindowMs ?? 4000) + 800);
  const after = (await client.request('GET', '/v1/stats')).stats;
  const d = (k) => (after[k] || 0) - (before[k] || 0);
  const naive = SCRIPT.length;
  const pings = d('notifications');
  log('\n── What reached you ─────────────────────────────');
  log(`  Without Doorman: ${naive} separate interruptions from 3 agents`);
  log(`  With Doorman:    ${pings} interruption${pings === 1 ? '' : 's'}`);
  log(`    ${d('interrupted_asks')} asks delivered in ${d('interruptions')} bundle${d('interruptions') === 1 ? '' : 's'}`);
  log(`    ${d('held')} held for a natural break, ${d('digested')} saved for your digest, ${d('auto')} auto-answered by rules`);
  log('\nEverything is in your inbox now. Try:');
  log('  • answer "Run npm test" three times, then accept the "always allow" suggestion');
  log('  • switch to Focus mode in the inbox and run the demo again');
  log('  • dismiss an urgent ask and watch that agent\'s attention budget shrink\n');
  return { naive, pings, stats: after };
}
