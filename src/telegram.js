// Phone push through your own Telegram bot: free, works anywhere, one-tap answer
// buttons, and nothing on your computer is exposed. The daemon long-polls the Bot
// API (outbound only). Only the chat you paired with /start <code> can answer.
import { findOption } from './spec.js';
import { fmtDuration, truncate } from './util.js';

const API = 'https://api.telegram.org';
const html = (s) => String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const URGENCY_TAG = { critical: '🔴 critical', high: '🟠 urgent', normal: '', low: '' };

export class Telegram {
  /**
   * @param cfg {token, chatId, userId, mirror: 'always'|'away', redact}
   * @param hooks {onAnswer(askId, optionId), onText(askId, text), onCommand(cmd, arg) -> reply, onPaired({chatId, userId, username}), pairCode(), log}
   */
  constructor(cfg, hooks) {
    this.cfg = { ...cfg };
    this.hooks = hooks;
    this.log = hooks.log || (() => {});
    this.base = (cfg.apiBase || API).replace(/\/+$/, '');
    this.me = null;
    this.error = null;
    this.offset = 0;
    this.messages = new Map(); // ask id -> message_id, so we can mark it answered later
    this.byMessage = new Map(); // message_id -> ask id, for text replies
    this.abort = new AbortController();
    this.closed = false;
  }

  async call(method, body = {}, { timeoutMs = 15000 } = {}) {
    const res = await fetch(`${this.base}/bot${this.cfg.token}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.any([this.abort.signal, AbortSignal.timeout(timeoutMs)]),
    });
    const data = await res.json().catch(() => ({}));
    if (!data.ok) throw new Error(`telegram ${method}: ${data.description || `HTTP ${res.status}`}`);
    return data.result;
  }

  get paired() { return !!this.cfg.chatId; }

  status() {
    return { configured: !!this.cfg.token, bot: this.me ? { username: this.me.username, name: this.me.first_name } : null, paired: this.paired, error: this.error, pair_code: this.paired ? null : this.hooks.pairCode?.() };
  }

  async start() {
    try {
      this.me = await this.call('getMe');
      this.error = null;
    } catch (err) {
      this.error = err.message;
      this.log(err.message);
      return;
    }
    this._poll();
  }

  async _poll() {
    let backoff = 1000;
    while (!this.closed) {
      try {
        const updates = await this.call('getUpdates', { offset: this.offset, timeout: 50, allowed_updates: ['message', 'callback_query'] }, { timeoutMs: 65000 });
        backoff = 1000;
        for (const u of updates) {
          this.offset = u.update_id + 1;
          await this._handle(u).catch((err) => this.log(`telegram: ${err.message}`));
        }
      } catch (err) {
        if (this.closed) return;
        this.error = err.message;
        await sleep(backoff);
        backoff = Math.min(backoff * 2, 60000);
      }
    }
  }

  _mine(chat, from) {
    return this.paired && String(chat?.id) === String(this.cfg.chatId) && (!this.cfg.userId || String(from?.id) === String(this.cfg.userId));
  }

  async _handle(u) {
    if (u.message) {
      const m = u.message;
      const text = (m.text || '').trim();
      const start = /^\/start(?:@\w+)?\s*(\S*)/.exec(text);
      if (start && !this.paired) {
        const want = this.hooks.pairCode?.();
        if (m.chat.type === 'private' && want && start[1] === want) {
          this.cfg.chatId = m.chat.id;
          this.cfg.userId = m.from?.id;
          this.hooks.onPaired?.({ chatId: m.chat.id, userId: m.from?.id, username: m.from?.username || m.from?.first_name });
          await this.send(`✅ <b>Connected.</b> Switchboard will message you here when an agent needs you.\n\nTry /status, /focus 1h, /available or /away.`);
        } else {
          await this.call('sendMessage', { chat_id: m.chat.id, text: 'Send the pairing code shown in your Switchboard inbox: /start <code>' });
        }
        return;
      }
      if (!this._mine(m.chat, m.from)) return; // someone else found the bot: ignore
      const replyTo = m.reply_to_message?.message_id;
      if (replyTo && this.byMessage.has(replyTo) && text && !text.startsWith('/')) {
        this.hooks.onText?.(this.byMessage.get(replyTo), text);
        return;
      }
      const cmd = /^\/(\w+)(?:@\w+)?\s*(.*)$/.exec(text);
      if (cmd) {
        const reply = await this.hooks.onCommand?.(cmd[1].toLowerCase(), cmd[2].trim());
        if (reply) await this.send(reply);
      }
      return;
    }
    if (u.callback_query) {
      const q = u.callback_query;
      if (!this._mine(q.message?.chat, q.from)) {
        await this.call('answerCallbackQuery', { callback_query_id: q.id, text: 'Not yours' }).catch(() => {});
        return;
      }
      const [kind, askId, idx] = String(q.data || '').split('|');
      if (kind !== 'a') return;
      const result = this.hooks.onAnswer?.(askId, Number(idx));
      await this.call('answerCallbackQuery', { callback_query_id: q.id, text: result?.toast || 'Sent' }).catch(() => {});
    }
  }

  send(text, extra = {}) {
    if (!this.paired) return Promise.resolve(null);
    return this.call('sendMessage', { chat_id: this.cfg.chatId, text, parse_mode: 'HTML', disable_web_page_preview: true, ...extra });
  }

  shouldSend(mode) {
    return this.paired && (this.cfg.mirror !== 'away' || mode === 'away');
  }

  _askText(a, now = Date.now()) {
    const tag = URGENCY_TAG[a.urgency];
    const head = `<b>${html(a.agent.name)}</b>${tag ? ` · ${tag}` : ''}${a.reversible === false ? ' · can’t be undone' : ''}`;
    if (this.cfg.redact) return `${head}\n${a.kind === 'inform' ? 'Sent you an update.' : 'Needs you.'} Open your Switchboard inbox to see it.`;
    const replyTo = a.metadata?.reply;
    // A message from an agent's chat: show what it actually said, not just the one-line summary.
    const lines = [head, replyTo && a.detail?.full ? html(truncate(a.detail.full, 1500)) : html(a.question)];
    if (a.review) lines[1] = `📝 <b>Review:</b> ${html(a.question)}`;
    if (a.detail?.line) lines.push(`<i>${html(a.detail.line)}</i>`);
    if (a.review && a.detail?.paragraph) lines.push(html(truncate(a.detail.paragraph, 600)));
    for (const att of a.attachments || []) if (att.url) lines.push(`🔗 <a href="${html(att.url)}">${html(att.title)}</a>`);
    if (a.kind === 'decision' && !a.review) {
      const cons = a.options.filter((o) => o.consequence).map((o) => `• <b>${html(o.label)}</b>: ${html(o.consequence)}`);
      if (cons.length) lines.push(cons.join('\n'));
    }
    if (a.deadline) {
      const def = a.default?.option ? findOption(a, a.default.option)?.label : null;
      lines.push(def ? `⏱ “${html(def)}” in ${fmtDuration(a.deadline - now)} if you don’t answer` : `⏱ needs an answer in ${fmtDuration(a.deadline - now)}`);
    }
    if (replyTo) lines.push(`<i>Reply to this message to answer ${a.agent.name.split(' · ')[0]}.</i>`);
    else if (a.kind === 'input') lines.push('<i>Reply to this message to answer.</i>');
    else if (a.review) lines.push('<i>Reply with your comments, then tap Approve or Request changes.</i>');
    else if (a.kind === 'decision') lines.push('<i>Tap an option. To add a note, reply to this message first.</i>');
    return lines.join('\n');
  }

  async sendAsk(a) {
    const keyboard = a.kind !== 'inform' && a.options?.length
      ? { inline_keyboard: chunk(a.options.slice(0, 8).map((o, i) => ({ text: o.label, callback_data: `a|${a.id}|${i}` })), a.options.length > 2 ? 2 : 3) }
      : undefined;
    const msg = await this.send(this._askText(a), {
      ...(keyboard ? { reply_markup: keyboard } : a.kind === 'input' ? { reply_markup: { force_reply: true, input_field_placeholder: truncate(a.input?.placeholder || 'Your answer', 60) } } : {}),
      ...(a.urgency === 'low' ? { disable_notification: true } : {}),
    });
    if (msg) {
      this.messages.set(a.id, msg.message_id);
      this.byMessage.set(msg.message_id, a.id);
      if (this.messages.size > 500) {
        const [oldest] = this.messages.keys();
        this.byMessage.delete(this.messages.get(oldest));
        this.messages.delete(oldest);
      }
      // Documents to review come along as files under the message.
      if (!this.cfg.redact) {
        for (const att of (a.attachments || []).slice(0, 3)) {
          const file = this.hooks.attachmentFile?.(att);
          if (file) await this.sendDocument(file, { replyTo: msg.message_id }).catch((err) => this.log(`telegram: ${err.message}`));
        }
      }
    }
    return msg;
  }

  async sendDocument(file, { caption, replyTo } = {}) {
    if (!this.paired) return null;
    const form = new FormData();
    form.append('chat_id', String(this.cfg.chatId));
    form.append('document', new Blob([file.data]), file.name);
    if (caption) form.append('caption', caption.slice(0, 1000));
    if (replyTo) form.append('reply_to_message_id', String(replyTo));
    form.append('disable_notification', 'true');
    const res = await fetch(`${this.base}/bot${this.cfg.token}/sendDocument`, { method: 'POST', body: form, signal: AbortSignal.any([this.abort.signal, AbortSignal.timeout(60000)]) });
    const data = await res.json().catch(() => ({}));
    if (!data.ok) throw new Error(`telegram sendDocument: ${data.description || `HTTP ${res.status}`}`);
    return data.result;
  }

  /** Deliver one interruption: decisions and messages you can reply to each get their own message; other FYIs are summarised. */
  async deliver(n) {
    const own = (a) => a.kind !== 'inform' || a.metadata?.reply;
    const decisions = n.asks.filter(own).slice(0, 5);
    for (const a of decisions) await this.sendAsk(a);
    const more = n.asks.filter(own).length - decisions.length;
    if (more > 0) await this.send(`…and ${more} more in your inbox. Send /inbox to see them here.`, { disable_notification: true });
    const fyi = [...n.asks.filter((a) => !own(a)), ...(n.digest || [])];
    if (fyi.length) {
      const lines = fyi.slice(0, 10).map((a) => `• <b>${html(a.agent.name)}</b>: ${this.cfg.redact ? 'update' : html(truncate(a.question, 120))}`);
      if (fyi.length > 10) lines.push(`…and ${fyi.length - 10} more`);
      await this.send(`📬 <b>${fyi.length} update${fyi.length === 1 ? '' : 's'}</b>\n${lines.join('\n')}`, { disable_notification: decisions.length > 0 });
    }
  }

  /** Mark a message as settled once the ask is answered anywhere. */
  async resolved(a, outcome) {
    const id = this.messages.get(a.id);
    if (!id) return;
    this.messages.delete(a.id);
    this.byMessage.delete(id);
    await this.call('editMessageText', { chat_id: this.cfg.chatId, message_id: id, parse_mode: 'HTML', text: `${this._askText(a)}\n\n${html(outcome)}` }).catch(() => {});
  }

  close() {
    this.closed = true;
    this.abort.abort();
  }
}

function chunk(list, n) {
  const out = [];
  for (let i = 0; i < list.length; i += n) out.push(list.slice(i, i + n));
  return out;
}
