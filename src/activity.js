// Opt-in, minimal activity sensing: how long since you touched the keyboard or
// mouse, and which app is in front (its process name only: never window
// titles, never content). Kept in memory, never logged, never shown to agents.
import { spawn, execFile } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createInterface } from 'node:readline';

const MEETING = /^(zoom|zoom\.us|cpthost|teams|ms-teams|msteams|webex|ciscowebexstart|atmgr|facetime|around|tuple|gather)$/i;
const EDITOR = /^(code|code - insiders|cursor|windsurf|zed|idea(64)?|pycharm(64)?|webstorm(64)?|goland(64)?|rider(64)?|clion(64)?|phpstorm(64)?|rubymine(64)?|android studio|studio64|devenv|sublime_text|sublime text|xcode|nvim|vim|emacs|windowsterminal|wt|openconsole|iterm2|terminal|warp|wezterm-gui|wezterm|alacritty|kitty|ghostty|hyper)$/i;

export function categorize(app) {
  if (!app) return 'unknown';
  const name = String(app).replace(/\.exe$/i, '').trim();
  if (MEETING.test(name)) return 'meeting';
  if (EDITOR.test(name)) return 'editor';
  return 'other';
}

const PRETTY = { claude: 'Claude', chrome: 'Chrome', msedge: 'Edge', firefox: 'Firefox', slack: 'Slack', explorer: 'File Explorer', outlook: 'Outlook', olk: 'Outlook', code: 'VS Code', cursor: 'Cursor', windowsterminal: 'Windows Terminal', idea64: 'IntelliJ IDEA', pycharm64: 'PyCharm', 'zoom.us': 'Zoom', ms_teams: 'Teams', msteams: 'Teams', 'ms-teams': 'Teams', iterm2: 'iTerm', devenv: 'Visual Studio' };
export const prettyApp = (app) => {
  if (!app) return null;
  const name = String(app).replace(/\.exe$/i, '');
  return PRETTY[name.toLowerCase()] || name.charAt(0).toUpperCase() + name.slice(1);
};

const WIN_SCRIPT = (seconds) => `
$ErrorActionPreference = 'SilentlyContinue'
Add-Type @"
using System; using System.Runtime.InteropServices;
public static class DoormanActivity {
  [StructLayout(LayoutKind.Sequential)] public struct LII { public uint cbSize; public uint dwTime; }
  [DllImport("user32.dll")] static extern bool GetLastInputInfo(ref LII p);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  public static uint Idle() { var l = new LII(); l.cbSize = (uint)Marshal.SizeOf(l); GetLastInputInfo(ref l); return unchecked((uint)Environment.TickCount - l.dwTime); }
  public static uint Front() { uint pid; GetWindowThreadProcessId(GetForegroundWindow(), out pid); return pid; }
}
"@
while ($true) {
  $app = ''
  try { $app = (Get-Process -Id ([DoormanActivity]::Front())).ProcessName } catch {}
  [Console]::Out.WriteLine('{"idle_ms":' + [DoormanActivity]::Idle() + ',"app":' + (ConvertTo-Json -Compress $app) + '}')
  [Console]::Out.Flush()
  Start-Sleep -Seconds ${seconds}
}`;

const run = (cmd, args) => new Promise((resolve) => {
  execFile(cmd, args, { timeout: 4000, windowsHide: true }, (err, stdout) => resolve(err ? '' : String(stdout)));
});

/** Emits 'sample' {idle_ms, app, category, at} and 'change' when the stable picture changes. */
export class ActivitySensor extends EventEmitter {
  constructor({ intervalMs = 10000, log = () => {} } = {}) {
    super();
    this.intervalMs = intervalMs;
    this.log = log;
    this.latest = null;
    this.stable = null; // category only flips after two identical samples, so alt-tabbing doesn't flap
    this.pending = null;
    this.proc = null;
    this.timer = null;
    this.supported = ['win32', 'darwin', 'linux'].includes(process.platform);
  }

  start() {
    if (this.proc || this.timer) return;
    if (process.platform === 'win32') {
      const encoded = Buffer.from(WIN_SCRIPT(Math.max(2, Math.round(this.intervalMs / 1000))), 'utf16le').toString('base64');
      this.proc = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', encoded], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
      this.proc.on('error', (err) => { this.log(`activity sensor unavailable: ${err.message}`); this.proc = null; });
      this.proc.on('exit', () => { this.proc = null; });
      createInterface({ input: this.proc.stdout }).on('line', (line) => {
        try { const j = JSON.parse(line); this._sample(Number(j.idle_ms), j.app || null); } catch { /* ignore partial lines */ }
      });
    } else {
      const poll = async () => {
        let idle = null;
        let app = null;
        if (process.platform === 'darwin') {
          const io = await run('ioreg', ['-c', 'IOHIDSystem', '-d', '4']);
          const m = /"HIDIdleTime" = (\d+)/.exec(io);
          if (m) idle = Number(m[1]) / 1e6;
          const front = (await run('lsappinfo', ['front'])).trim();
          if (front) app = (/"(?:LSDisplayName|name)"\s*=\s*"([^"]+)"/.exec(await run('lsappinfo', ['info', '-only', 'name', front])) || [])[1] || null;
        } else {
          const x = (await run('xprintidle', [])).trim();
          if (x) idle = Number(x);
        }
        if (idle != null) this._sample(idle, app);
      };
      poll();
      this.timer = setInterval(poll, this.intervalMs);
      this.timer.unref?.();
    }
  }

  _sample(idleMs, app) {
    const category = categorize(app);
    const at = Date.now();
    this.latest = { idle_ms: idleMs, app: prettyApp(app), category, at };
    if (this.pending === category || !this.stable) {
      if (!this.stable || this.stable.category !== category) {
        this.stable = { category, app: prettyApp(app), since: at };
        this.emit('change', this.stable);
      } else this.stable.app = prettyApp(app);
    }
    this.pending = category;
    this.emit('sample', this.latest);
  }

  snapshot() {
    if (!this.latest) return null;
    return { ...this.latest, category: this.stable?.category ?? this.latest.category, app: this.stable?.app ?? this.latest.app, since: this.stable?.since ?? this.latest.at };
  }

  stop() {
    this.proc?.kill();
    this.proc = null;
    clearInterval(this.timer);
    this.timer = null;
    this.latest = null;
    this.stable = null;
  }
}
