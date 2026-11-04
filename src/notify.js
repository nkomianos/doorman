// Interruption surfaces: desktop notifications and phone push (ntfy).
import { spawn } from 'node:child_process';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { findOption } from './spec.js';
import { fmtDuration, truncate } from './util.js';

/** Turn a delivered bundle into one human-readable notification. */
export function compose(n, baseUrl, now = Date.now()) {
  const asks = n.asks;
  const fyi = n.digest || [];
  if (asks.length === 1 && !fyi.length) {
    const a = asks[0];
    const tag = a.urgency === 'critical' ? ' · CRITICAL' : a.urgency === 'high' ? ' · urgent' : '';
    let body = a.question;
    if (a.deadline) {
      const def = a.default?.option ? findOption(a, a.default.option)?.label : null;
      body += def ? ` (in ${fmtDuration(a.deadline - now)}: ${def})` : ` (needs answer in ${fmtDuration(a.deadline - now)})`;
    }
    return { title: `${a.agent.name}${tag}`, body, url: `${baseUrl}/#${a.id}`, single: a, urgency: a.urgency };
  }
  const agents = new Set(asks.map((a) => a.agent.name));
  const lines = asks.slice(0, 4).map((a) => `${a.agent.name}: ${truncate(a.question, 80)}`);
  if (asks.length > 4) lines.push(`+${asks.length - 4} more`);
  if (fyi.length) lines.push(`${fyi.length} update${fyi.length > 1 ? 's' : ''} in your digest`);
  const title = asks.length
    ? `${asks.length} thing${asks.length > 1 ? 's' : ''} need${asks.length > 1 ? '' : 's'} you${agents.size > 1 ? ` (${agents.size} agents)` : ''}`
    : `Digest: ${fyi.length} update${fyi.length > 1 ? 's' : ''}`;
  const order = ['low', 'normal', 'high', 'critical'];
  const urgency = [...asks, ...fyi].reduce((m, a) => (order.indexOf(a.urgency) > order.indexOf(m) ? a.urgency : m), 'low');
  return { title, body: lines.join('\n'), url: `${baseUrl}/`, single: null, urgency };
}

const xml = (s) => String(s).replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]);

/** Best-effort native notification. Never throws. */
export function desktopNotify({ title, body, url }) {
  try {
    let child;
    if (process.platform === 'win32') {
      const toast = `<toast activationType="protocol" launch="${xml(url)}"><visual><binding template="ToastGeneric"><text>${xml(title)}</text><text>${xml(body)}</text></binding></visual></toast>`;
      const ps = [
        '[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null',
        '[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null',
        '$x = New-Object Windows.Data.Xml.Dom.XmlDocument',
        `$x.LoadXml('${toast.replace(/'/g, "''")}')`,
        "[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe').Show([Windows.UI.Notifications.ToastNotification]::new($x))",
      ].join('\n');
      const encoded = Buffer.from(ps, 'utf16le').toString('base64');
      child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', encoded], { stdio: 'ignore', windowsHide: true });
    } else if (process.platform === 'darwin') {
      const q = (s) => String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      child = spawn('osascript', ['-e', `display notification "${q(body)}" with title "Doorman" subtitle "${q(title)}"`], { stdio: 'ignore' });
    } else {
      child = spawn('notify-send', ['--app-name=Doorman', title, body], { stdio: 'ignore' });
    }
    child.on('error', () => {});
    child.unref();
  } catch { /* notifications are best-effort */ }
}

const NTFY_PRIORITY = { low: 2, normal: 3, high: 4, critical: 5 };

/**
 * Phone push through ntfy (https://ntfy.sh or self-hosted). Action buttons on the
 * phone POST a signed answer to a reply topic that the daemon subscribes to, so
 * one-tap answers work from anywhere without exposing your machine to the internet.
 */
export class Ntfy {
  constructor(cfg, { secret, onAnswer, log = () => {} }) {
    this.server = (cfg.server || 'https://ntfy.sh').replace(/\/+$/, '');
    this.topic = cfg.topic;
    this.replyTopic = cfg.replyTopic || `${cfg.topic}-reply`;
    this.token = cfg.token || null;
    this.redact = !!cfg.redact;
    this.mirror = cfg.mirror || 'always';
    this.secret = secret;
    this.onAnswer = onAnswer;
    this.log = log;
    this.abort = null;
    this.since = 'now';
    this.closed = false;
  }

  sign(askId, option) {
    return createHmac('sha256', this.secret).update(`${askId}:${option}`).digest('hex').slice(0, 24);
  }

  verify(askId, option, sig) {
    const want = Buffer.from(this.sign(askId, option));
    const got = Buffer.from(String(sig || ''));
    return want.length === got.length && timingSafeEqual(want, got);
  }

  _headers() {
    const h = { 'content-type': 'application/json' };
    if (this.token) h.authorization = `Bearer ${this.token}`;
    return h;
  }

  shouldSend(state) {
    return this.mirror === 'always' || state === 'away';
  }

  message(n, c) {
    const msg = {
      topic: this.topic,
      title: this.redact ? (c.single ? c.single.agent.name : 'Doorman') : c.title,
      message: this.redact ? (c.single ? 'Needs a decision. Open Doorman to see it.' : `${n.asks.length} items need you.`) : c.body,
      priority: NTFY_PRIORITY[c.urgency] ?? 3,
      tags: ['bellhop_bell'],
    };
    const a = c.single;
    if (a && a.kind === 'decision') {
      msg.actions = a.options.slice(0, 3).map((o) => ({
        action: 'http',
        label: truncate(o.label, 24),
        url: `${this.server}/${this.replyTopic}`,
        method: 'POST',
        body: JSON.stringify({ ask: a.id, option: o.id, sig: this.sign(a.id, o.id) }),
        clear: true,
      }));
    }
    return msg;
  }

  async publish(n, composed) {
    const res = await fetch(this.server, { method: 'POST', headers: this._headers(), body: JSON.stringify(this.message(n, composed)), signal: AbortSignal.timeout(10000) });
    if (!res.ok) throw new Error(`ntfy publish failed: HTTP ${res.status}`);
  }

  /** Handle one reply payload (the body a phone action button POSTed). */
  handleReply(raw) {
    let data;
    try { data = JSON.parse(raw); } catch { return false; }
    if (!data?.ask || !data?.option) return false;
    if (!this.verify(data.ask, data.option, data.sig)) {
      this.log(`ntfy: rejected reply with bad signature for ${data.ask}`);
      return false;
    }
    this.onAnswer(data.ask, data.option);
    return true;
  }

  async subscribe() {
    let backoff = 1000;
    while (!this.closed) {
      this.abort = new AbortController();
      try {
        const res = await fetch(`${this.server}/${this.replyTopic}/json?since=${encodeURIComponent(this.since)}`, { headers: this._headers(), signal: this.abort.signal });
        if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
        backoff = 1000;
        let buf = '';
        for await (const chunk of res.body) {
          buf += Buffer.from(chunk).toString('utf8');
          let nl;
          while ((nl = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, nl).trim();
            buf = buf.slice(nl + 1);
            if (!line) continue;
            try {
              const ev = JSON.parse(line);
              if (ev.event === 'message') {
                this.since = ev.id;
                this.handleReply(ev.message);
              }
            } catch { /* ignore malformed lines */ }
          }
        }
      } catch (err) {
        if (this.closed) return;
        this.log(`ntfy: subscription error (${err.message}); retrying in ${backoff / 1000}s`);
      }
      if (this.closed) return;
      await new Promise((r) => setTimeout(r, backoff));
      backoff = Math.min(backoff * 2, 60000);
    }
  }

  close() {
    this.closed = true;
    this.abort?.abort();
  }
}
