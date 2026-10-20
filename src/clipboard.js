// Copying to the system clipboard, through tools the system already has (as credentials.js does),
// so the compiled build needs no native module: PowerShell's Set-Clipboard on Windows, pbcopy on
// macOS, wl-copy, xclip or xsel on Linux. Over SSH, or when none of them works, it asks the
// terminal instead (OSC 52), which Windows Terminal, iTerm2, kitty, WezTerm and tmux understand.
import { execFile } from 'node:child_process';
import { osc52 } from './selection.js';

function run(file, args, input) {
  return new Promise((resolve, reject) => {
    const child = execFile(file, args, { windowsHide: true, timeout: 10_000 }, (err) => (err ? reject(err) : resolve()));
    child.stdin.end(input);
  });
}

// The text crosses as base64 so no console code page can mangle it.
const POWERSHELL = '$t = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::In.ReadToEnd().Trim())); Set-Clipboard -Value $t';

function systemCopy(text) {
  if (process.platform === 'win32') return run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', POWERSHELL], Buffer.from(text, 'utf8').toString('base64'));
  if (process.platform === 'darwin') return run('pbcopy', [], text);
  if (process.env.WAYLAND_DISPLAY) return run('wl-copy', [], text);
  return run('xclip', ['-selection', 'clipboard'], text).catch(() => run('xsel', ['--clipboard', '--input'], text));
}

/** Copies `text`: 'system' when the system's clipboard took it, 'terminal' when it went by OSC 52. */
export async function copyToClipboard(text, { write = (s) => process.stdout.write(s) } = {}) {
  const terminal = () => (write(osc52(text)), 'terminal');
  // Over SSH the system clipboard is the far machine's: only the terminal can reach yours.
  if (process.env.SSH_TTY || process.env.SSH_CONNECTION) return terminal();
  try {
    await systemCopy(text);
    return 'system';
  } catch {
    return terminal();
  }
}
