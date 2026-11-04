// Per-agent attention budgets with AIMD, like TCP congestion control.
// capacity = interruptions per hour the agent may cause. Tokens refill continuously.
// Acting on an interruption grows capacity additively; dismissing one halves it.

const HOUR = 36e5;

export class Budgets {
  constructor(opts = {}, clock = Date.now) {
    this.initial = opts.initial ?? 6;
    this.min = opts.min ?? 1;
    this.max = opts.max ?? 30;
    this.increase = opts.increase ?? 1;
    this.decrease = opts.decrease ?? 0.5;
    this.ignorePenalty = opts.ignorePenalty ?? 0.75;
    this.clock = clock;
    this.agents = new Map();
  }

  get(agent) {
    const id = typeof agent === 'string' ? agent : agent.id;
    let rec = this.agents.get(id);
    if (!rec) {
      rec = {
        id,
        name: typeof agent === 'string' ? agent : agent.name,
        capacity: this.initial,
        tokens: this.initial,
        updated: this.clock(),
        muted: false,
        asks: 0,
        interrupts: 0,
        answered: 0,
        dismissed: 0,
        ignored: 0,
        auto: 0,
        urgentClaims: 0,
        urgentDismissed: 0,
        lastSeen: this.clock(),
      };
      this.agents.set(id, rec);
    } else if (typeof agent === 'object' && agent.name) {
      rec.name = agent.name;
    }
    this._refill(rec);
    return rec;
  }

  _refill(rec) {
    const now = this.clock();
    const dt = Math.max(0, now - rec.updated);
    rec.tokens = Math.min(rec.capacity, rec.tokens + (rec.capacity * dt) / HOUR);
    rec.updated = now;
  }

  canSpend(agent) {
    const rec = this.get(agent);
    return !rec.muted && rec.tokens >= 1;
  }

  spend(agent) {
    const rec = this.get(agent);
    rec.tokens = Math.max(0, rec.tokens - 1);
    rec.interrupts++;
  }

  /** Milliseconds until the agent has a whole token again. */
  msUntilToken(agent) {
    const rec = this.get(agent);
    if (rec.tokens >= 1) return 0;
    return Math.ceil(((1 - rec.tokens) * HOUR) / rec.capacity);
  }

  noteAsk(agent, urgency) {
    const rec = this.get(agent);
    rec.asks++;
    rec.lastSeen = this.clock();
    if (urgency === 'high' || urgency === 'critical') rec.urgentClaims++;
  }

  /** outcome: answered | dismissed | ignored | auto */
  onOutcome(agent, outcome, { interrupted = false, urgency = 'normal' } = {}) {
    const rec = this.get(agent);
    const urgent = urgency === 'high' || urgency === 'critical';
    if (outcome === 'answered') {
      rec.answered++;
      if (interrupted) rec.capacity = Math.min(this.max, rec.capacity + this.increase);
    } else if (outcome === 'dismissed') {
      rec.dismissed++;
      if (urgent) rec.urgentDismissed++;
      // Only an interruption you didn't want costs budget; tidying the inbox doesn't.
      if (interrupted) {
        rec.capacity = Math.max(this.min, rec.capacity * this.decrease);
        rec.tokens = Math.min(rec.tokens, rec.capacity);
      }
    } else if (outcome === 'ignored') {
      rec.ignored++;
      if (interrupted) {
        rec.capacity = Math.max(this.min, rec.capacity * this.ignorePenalty);
        rec.tokens = Math.min(rec.tokens, rec.capacity);
      }
    } else if (outcome === 'auto') {
      rec.auto++;
    }
  }

  /** How much this agent's "urgent" label can be trusted, 0..1 (Laplace-smoothed). */
  credibility(agent) {
    const rec = this.get(agent);
    return (rec.urgentClaims - rec.urgentDismissed + 2) / (rec.urgentClaims + 2);
  }

  setMuted(agent, muted) {
    this.get(agent).muted = !!muted;
  }

  reset(agent) {
    const rec = this.get(agent);
    Object.assign(rec, { capacity: this.initial, tokens: this.initial, urgentClaims: 0, urgentDismissed: 0 });
  }

  view(agent) {
    const rec = this.get(agent);
    return {
      ...rec,
      capacity: Math.round(rec.capacity * 100) / 100,
      tokens: Math.round(rec.tokens * 100) / 100,
      credibility: Math.round(this.credibility(rec.id) * 100) / 100,
    };
  }

  list() {
    return [...this.agents.keys()].map((id) => this.view(id)).sort((a, b) => b.lastSeen - a.lastSeen);
  }

  toJSON() {
    return [...this.agents.values()];
  }

  load(list) {
    for (const rec of list || []) this.agents.set(rec.id, { ...rec });
  }
}
