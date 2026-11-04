// Answer buttons on Windows notifications. Toast buttons can only launch URLs, so
// we register a per-user doorman:// handler (HKCU, no admin) that runs a tiny
// hidden script, which hands the signed answer to the daemon. Every button URL
// carries an HMAC, so a doorman:// link on some web page can't answer for you.
import { execFile } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BIN } from './integrations.js';

const reg = (args) => new Promise((resolve) => execFile('reg.exe', args, { windowsHide: true }, (err) => resolve(!err)));

/** Idempotent. Resolves true when doorman:// links will reach this copy of Doorman. */
export async function registerProtocol(home) {
  if (process.platform !== 'win32') return false;
  const vbs = join(home, 'doorman-url.vbs');
  // wscript runs node without flashing a console window.
  writeFileSync(vbs, [
    "' Opened by doorman:// links from Doorman's Windows notifications.",
    'If WScript.Arguments.Count = 0 Then WScript.Quit',
    'Set sh = CreateObject("WScript.Shell")',
    `sh.Run """${process.execPath}"" ""${BIN}"" url """ & WScript.Arguments(0) & """", 0, False`,
    '',
  ].join('\r\n'));
  const key = 'HKCU\\Software\\Classes\\doorman';
  const ok = await reg(['add', key, '/ve', '/d', 'URL:Doorman', '/f'])
    && await reg(['add', key, '/v', 'URL Protocol', '/d', '', '/f'])
    && await reg(['add', `${key}\\shell\\open\\command`, '/ve', '/d', `wscript.exe //B //Nologo "${vbs}" "%1"`, '/f']);
  return ok;
}

export const actionUrl = (askId, option, sig) => `doorman://answer?ask=${encodeURIComponent(askId)}&option=${encodeURIComponent(option)}&sig=${sig}`;

export function parseActionUrl(raw) {
  try {
    const u = new URL(raw);
    if (u.protocol !== 'doorman:') return null;
    const p = u.searchParams;
    if (!p.get('ask') || !p.get('option') || !p.get('sig')) return null;
    return { ask: p.get('ask'), option: p.get('option'), sig: p.get('sig') };
  } catch {
    return null;
  }
}
