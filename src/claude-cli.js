// Running the Claude Code CLI (`claude -p`), shared by the sibling apps: signed in as you already are,
// so none of them sees a key. Each app writes its own prompts and picks its own flags; this starts
// claude with what it's given on stdin and says plainly when it isn't there or was cancelled.
import { execFile } from 'node:child_process';

// Each flag takes seconds off a call: no MCP servers to start, no settings files (whose hooks and
// plugins load on every run), no skills, and nothing saved to your session history.
export const FAST = ['--strict-mcp-config', '--setting-sources', '', '--disable-slash-commands', '--no-session-persistence'];

export const NOT_INSTALLED = 'Claude Code (claude) is not installed or not on the PATH. Get it from https://claude.com/claude-code';

/**
 * Runs `claude` with `args`, `input` on its stdin, in `cwd`. Resolves with { stdout, stderr, failed,
 * message }, `failed` when it exited with an error and `message` its last lines; rejects only when
 * claude isn't there, or was cancelled through `signal` (`cancelled` set). `execImpl` stands in for
 * execFile in tests.
 */
export function runClaude(args, { input = '', cwd, signal, execImpl = execFile } = {}) {
  return new Promise((resolve, reject) => {
    const child = execImpl('claude', args, { cwd, signal, windowsHide: true, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }, (err, stdout = '', stderr = '') => {
      if (err?.name === 'AbortError') return reject(Object.assign(new Error('Cancelled'), { cancelled: true }));
      if (err?.code === 'ENOENT') return reject(new Error(NOT_INSTALLED));
      const message = String(stderr || stdout || err?.message || 'claude gave no answer').trim().split('\n').slice(-3).join('\n');
      resolve({ stdout, stderr, failed: Boolean(err), message });
    });
    // claude may exit before reading it all (not signed in, say): its own error is the answer.
    child.stdin?.on('error', () => {});
    child.stdin?.end(input);
  });
}

/** Asks Claude `prompt` about `input` (sent on stdin), in `cwd`. `tools`: built-in tools it may use, none by default. */
export async function ask(prompt, { input = '', cwd, signal, tools = [], execImpl } = {}) {
  const r = await runClaude(['-p', prompt, '--tools', tools.join(','), ...FAST], { input, cwd, signal, execImpl });
  if (r.failed) throw new Error(r.message);
  return r.stdout.trim();
}

const MAX_INPUT = 200_000;

/** Keeps what's sent to Claude to a sensible size, saying where it was cut. */
export function clip(text, max = MAX_INPUT) {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n\n[Cut here: the rest (${(text.length - max).toLocaleString('en')} more characters) was left out.]`;
}
