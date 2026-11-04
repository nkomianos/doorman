// Minimal iCalendar (.ics) reader: enough to know when you're busy.
// Supports DTSTART/DTEND/DURATION, TRANSP, STATUS, EXDATE and RRULE with
// FREQ=DAILY|WEEKLY (INTERVAL, COUNT, UNTIL, BYDAY). TZID times are read as local time.

const DAY_CODES = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];

function unfold(text) {
  return text.replace(/\r\n/g, '\n').replace(/\n[ \t]/g, '').split('\n');
}

function parseLine(line) {
  const colon = line.indexOf(':');
  if (colon < 0) return null;
  const [name, ...params] = line.slice(0, colon).split(';');
  const p = {};
  for (const kv of params) {
    const [k, v] = kv.split('=');
    p[k.toUpperCase()] = v;
  }
  return { name: name.toUpperCase(), params: p, value: line.slice(colon + 1) };
}

/** Returns { t: epoch ms, allDay } or null. */
export function parseIcsDate(value, params = {}) {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/.exec(value.trim());
  if (!m) return null;
  const [, y, mo, d, h, mi, s, z] = m;
  if (h == null || params.VALUE === 'DATE') return { t: new Date(+y, +mo - 1, +d).getTime(), allDay: true };
  const t = z
    ? Date.UTC(+y, +mo - 1, +d, +h, +mi, +(s || 0))
    : new Date(+y, +mo - 1, +d, +h, +mi, +(s || 0)).getTime();
  return { t, allDay: false };
}

function parseIcsDuration(v) {
  const m = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(v.trim());
  if (!m) return null;
  const [, sign, w, d, h, mi, s] = m;
  const ms = (((+w || 0) * 7 + (+d || 0)) * 24 * 3600 + (+h || 0) * 3600 + (+mi || 0) * 60 + (+s || 0)) * 1000;
  return sign === '-' ? -ms : ms;
}

export function parseIcs(text) {
  const events = [];
  let cur = null;
  for (const raw of unfold(text)) {
    const line = parseLine(raw);
    if (!line) continue;
    if (line.name === 'BEGIN' && line.value === 'VEVENT') cur = { exdates: [] };
    else if (line.name === 'END' && line.value === 'VEVENT') {
      if (cur?.start != null) {
        if (cur.end == null) cur.end = cur.duration != null ? cur.start + cur.duration : cur.start + (cur.allDay ? 864e5 : 0);
        delete cur.duration;
        events.push(cur);
      }
      cur = null;
    } else if (cur) {
      switch (line.name) {
        case 'SUMMARY': cur.summary = line.value.replace(/\\,/g, ',').replace(/\\n/gi, ' '); break;
        case 'DTSTART': { const d = parseIcsDate(line.value, line.params); if (d) { cur.start = d.t; cur.allDay = d.allDay; } break; }
        case 'DTEND': { const d = parseIcsDate(line.value, line.params); if (d) cur.end = d.t; break; }
        case 'DURATION': cur.duration = parseIcsDuration(line.value); break;
        case 'TRANSP': cur.transparent = line.value.toUpperCase() === 'TRANSPARENT'; break;
        case 'STATUS': cur.cancelled = line.value.toUpperCase() === 'CANCELLED'; break;
        case 'RRULE': cur.rrule = Object.fromEntries(line.value.split(';').map((kv) => kv.split('=')).map(([k, v]) => [k.toUpperCase(), v])); break;
        case 'EXDATE':
          for (const v of line.value.split(',')) { const d = parseIcsDate(v, line.params); if (d) cur.exdates.push(d.t); }
          break;
        default: break;
      }
    }
  }
  return events;
}

/** Concrete occurrences overlapping [from, to). */
export function expandEvents(events, from, to) {
  const out = [];
  for (const ev of events) {
    if (ev.cancelled) continue;
    const dur = ev.end - ev.start;
    const push = (start) => {
      if (ev.exdates.includes(start)) return;
      if (start < to && start + dur > from) out.push({ start, end: start + dur, summary: ev.summary || '', allDay: ev.allDay, busy: !ev.transparent && !ev.allDay });
    };
    const r = ev.rrule;
    if (!r || !['DAILY', 'WEEKLY'].includes(r.FREQ)) {
      push(ev.start);
      continue;
    }
    const interval = Math.max(1, parseInt(r.INTERVAL || '1', 10));
    const count = r.COUNT ? parseInt(r.COUNT, 10) : Infinity;
    const until = r.UNTIL ? parseIcsDate(r.UNTIL)?.t ?? Infinity : Infinity;
    const first = new Date(ev.start);
    const byDay = r.FREQ === 'WEEKLY' && r.BYDAY
      ? r.BYDAY.split(',').map((d) => DAY_CODES.indexOf(d.slice(-2))).filter((d) => d >= 0)
      : null;
    let n = 0;
    // Walk day by day in local wall-clock time so DST doesn't shift meetings.
    for (let i = 0; i < 3660 && n < count; i++) {
      const d = new Date(first);
      d.setDate(first.getDate() + i);
      const t = d.getTime();
      if (t > until || t >= to) break;
      let hit;
      if (r.FREQ === 'DAILY') hit = i % interval === 0;
      else {
        const week = Math.floor(i / 7);
        hit = week % interval === 0 && (byDay ? byDay.includes(d.getDay()) : d.getDay() === first.getDay());
      }
      if (!hit) continue;
      n++;
      push(t);
    }
  }
  return out.sort((a, b) => a.start - b.start);
}
