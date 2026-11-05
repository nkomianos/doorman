// What an agent attached for you to look at: previews for the inbox and phone, and
// "Open in editor". Only the owner can reach these, and opening never runs anything.
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename, extname } from 'node:path';

const MAX_PREVIEW = 1024 * 1024;
// Opened with the system's default app only if it's a document; anything else goes to an editor.
const SAFE_TO_OPEN = new Set(['.md', '.markdown', '.txt', '.log', '.csv', '.json', '.pdf', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.docx', '.xlsx', '.pptx', '.odt', '.rtf', '.diff', '.patch', '.yaml', '.yml', '.toml', '.xml']);

export function previewAttachment(att) {
  if (!att) throw Object.assign(new Error('no such attachment'), { status: 404 });
  const out = { title: att.title, format: att.format, path: att.path, url: att.url, content: null, size: null, truncated: false, error: null };
  if (att.content != null) {
    out.content = att.content;
    out.size = Buffer.byteLength(att.content);
    return out;
  }
  if (!att.path) return out;
  try {
    if (!existsSync(att.path)) return { ...out, error: 'The file isn’t there anymore.' };
    const st = statSync(att.path);
    out.size = st.size;
    if (!st.isFile()) return { ...out, error: 'Not a file.' };
    if (att.format === 'file') return out; // binary: open it instead
    const buf = readFileSync(att.path);
    out.truncated = buf.length > MAX_PREVIEW;
    out.content = buf.subarray(0, MAX_PREVIEW).toString('utf8');
  } catch (err) {
    out.error = err.message;
  }
  return out;
}

const run = (cmd, args) => new Promise((resolve) => {
  // `code` is a .cmd shim on Windows, so it goes through the shell: quote the path ourselves.
  const shell = process.platform === 'win32' && cmd === 'code';
  const child = spawn(cmd, shell ? args.map((x) => (/[\s&()^%!"]/.test(x) ? `"${x}"` : x)) : args, { stdio: 'ignore', detached: true, windowsHide: true, shell });
  child.on('error', () => resolve(false));
  child.on('spawn', () => { child.unref(); setTimeout(() => resolve(true), 600); });
  child.on('exit', (code) => { if (code) resolve(false); });
});

/** Open in VS Code when available (it never executes anything), else the default app for documents. */
export async function openAttachment(att) {
  if (!att?.path) throw Object.assign(new Error('only files can be opened; links open in your browser'), { status: 400 });
  if (!existsSync(att.path)) throw Object.assign(new Error('the file isn’t there anymore'), { status: 404 });
  if (await run('code', ['-g', att.path])) return { opened: 'VS Code' };
  if (!SAFE_TO_OPEN.has(extname(att.path).toLowerCase())) {
    throw Object.assign(new Error(`Switchboard only opens documents with their default app. Open ${basename(att.path)} yourself, or install VS Code.`), { status: 400 });
  }
  const ok = process.platform === 'win32' ? await run('explorer.exe', [att.path])
    : process.platform === 'darwin' ? await run('open', [att.path]) : await run('xdg-open', [att.path]);
  if (!ok) throw Object.assign(new Error('couldn’t open the file'), { status: 500 });
  return { opened: 'its default app' };
}

/** A text attachment as a file to send to your phone, or null. */
export function attachmentFile(att, maxBytes = 5 * 1024 * 1024) {
  try {
    if (att.content != null) return { name: `${att.title.replace(/[^\w.-]+/g, '-').slice(0, 60) || 'attachment'}${att.format === 'diff' ? '.diff' : '.md'}`, data: Buffer.from(att.content) };
    if (!att.path || att.format === 'file' || !existsSync(att.path)) return null;
    if (statSync(att.path).size > maxBytes) return null;
    return { name: basename(att.path), data: readFileSync(att.path) };
  } catch {
    return null;
  }
}
