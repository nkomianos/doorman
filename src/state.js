// The human-state sensor. Computed locally from manual overrides, quiet hours
// and your calendar. Agents only ever see the coarse result, never the inputs.
import { readFile } from 'node:fs/promises';
import { parseIcs, expandEvents } from './ics.js';
import { hhmmToMinutes, minutesOfDay } from './util.js';

export const MODES = {
  available: { threshold: 'normal', label: 'Available' },
  focus: { threshold: 'high', label: 'Focused, urgent only' },
  dnd: { threshold: 'critical', label: 'Do not disturb, critical only' },
  away: { threshold: 'high', label: 'Away, phone for urgent' },
};

export class HumanState {
  constructor(config = {}, clock = Date.now) {
    this.config = config;
    this.clock = clock;
    this.manual = null; // { mode, until, note, set_at }
    this.events = [];
    this.calendarError = null;
    this.calendarFetchedAt = null;
  }

  setManual(mode, until = null, note = null) {
    if (mode == null || mode === 'auto') {
      this.manual = null;
      return;
    }
    if (!MODES[mode]) throw Object.assign(new Error(`mode must be one of ${Object.keys(MODES).join(', ')}, auto`), { status: 400 });
    this.manual = { mode, until, note, set_at: this.clock() };
  }

  _quietHours(now) {
    const q = this.config.quietHours;
    if (!q) return null;
    const start = hhmmToMinutes(q.start);
    const end = hhmmToMinutes(q.end);
    if (start == null || end == null) return null;
    const m = minutesOfDay(now);
    const inside = start <= end ? m >= start && m < end : m >= start || m < end;
    if (!inside) return null;
    const d = new Date(now);
    const endDate = new Date(d.getFullYear(), d.getMonth(), d.getDate(), Math.floor(end / 60), end % 60);
    if (endDate.getTime() <= now) endDate.setDate(endDate.getDate() + 1);
    return { mode: MODES[q.mode] ? q.mode : 'dnd', until: endDate.getTime() };
  }

  _calendar(now) {
    const cal = this.config.calendar;
    if (!cal) return null;
    const busy = this.events.filter((e) => e.busy && e.start <= now && e.end > now);
    if (!busy.length) return null;
    const keywords = (cal.dndKeywords ?? ['focus time', 'deep work', 'do not disturb']).map((k) => k.toLowerCase());
    const dnd = busy.some((e) => keywords.some((k) => e.summary.toLowerCase().includes(k)));
    const mode = dnd ? 'dnd' : MODES[cal.busyMode] ? cal.busyMode : 'focus';
    return { mode, until: Math.max(...busy.map((e) => e.end)) };
  }

  /** Full state, for the owner (inbox UI). Still never includes event titles. */
  current(now = this.clock()) {
    if (this.manual && this.manual.until != null && this.manual.until <= now) this.manual = null;
    let s;
    if (this.manual) s = { mode: this.manual.mode, until: this.manual.until, source: 'manual', note: this.manual.note };
    else s = (() => {
      const c = this._calendar(now);
      if (c) return { ...c, source: 'calendar' };
      const q = this._quietHours(now);
      if (q) return { ...q, source: 'quiet-hours' };
      return { mode: 'available', until: null, source: 'default' };
    })();
    const def = MODES[s.mode];
    return {
      ...s,
      label: def.label,
      interruptible_for: def.threshold,
      surfaces: s.mode === 'away' ? ['phone'] : ['desktop', 'phone'],
      next_busy: this.events.find((e) => e.busy && e.start > now)?.start ?? null,
    };
  }

  /** What agents see. */
  coarse(now = this.clock()) {
    const s = this.current(now);
    return { mode: s.mode, label: s.label, interruptible_for: s.interruptible_for, until: s.until ? new Date(s.until).toISOString() : null };
  }

  async refreshCalendar() {
    const cal = this.config.calendar;
    if (!cal?.ics) {
      this.events = [];
      return;
    }
    try {
      const text = /^https?:\/\//i.test(cal.ics)
        ? await (await fetch(cal.ics, { signal: AbortSignal.timeout(15000) })).text()
        : await readFile(cal.ics, 'utf8');
      const now = this.clock();
      this.events = expandEvents(parseIcs(text), now - 864e5, now + 2 * 864e5);
      this.calendarError = null;
      this.calendarFetchedAt = now;
    } catch (err) {
      this.calendarError = err.message;
    }
  }

  calendarStatus() {
    return {
      configured: !!this.config.calendar?.ics,
      events_next_48h: this.events.filter((e) => e.busy && e.end > this.clock()).length,
      fetched_at: this.calendarFetchedAt,
      error: this.calendarError,
    };
  }

  toJSON() {
    return { manual: this.manual };
  }

  load(data) {
    if (data?.manual && MODES[data.manual.mode]) this.manual = data.manual;
  }
}
