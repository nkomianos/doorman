// A minimal agent that asks before doing something it can't undo.
//   node examples/agent.mjs
import { SwitchboardClient } from '../src/client.js';

const switchboard = new SwitchboardClient({ agent: { id: 'invoice-bot', name: 'Invoice bot' } });

// Check first: no point starting a task that needs you if you're in deep work.
const state = await switchboard.state();
console.log(`Human is ${state.mode}; interrupts for ${state.interruptible_for}+`);

const result = await switchboard.ask({
  question: 'Pay the €1,240 invoice from Acme Hosting?',
  options: [
    { id: 'pay', label: 'Pay now', style: 'primary', consequence: 'Bank transfer today, can\'t be recalled' },
    { id: 'hold', label: 'Hold', consequence: 'Due in 6 days, I\'ll ask again on Friday' },
  ],
  default: 'hold', // safe: nothing happens if you don't answer, so no need to interrupt you
  deadline: '2h',
  reversible: false,
  delay_cost: 'None until the due date',
  detail: {
    line: 'INV-2291 · matches last month\'s amount',
    paragraph: 'Same amount as the previous 5 months. PO 7731 approved by finance.',
  },
});

console.log(`Decision: ${result.answer?.label ?? result.status} (by ${result.answer?.by ?? 'nobody'})`);

await switchboard.notify(result.answer?.option === 'pay' ? 'Paid INV-2291' : 'Holding INV-2291 until Friday', { urgency: 'low' });
