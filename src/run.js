// The only place Trawl starts another program. Nothing it starts has a terminal, so nothing may wait
// on a prompt: stdin is closed (or given `input`), and an abort kills the whole process tree.
import { spawn } from 'node:child_process';

export class RunError extends Error {
  constructor(message, { code, stdout = '', stderr = '', cancelled = false } = {}) {
    super(message);
    Object.assign(this, { code, stdout, stderr, cancelled });
  }
}

/**
 * Runs `command` through the shell (`/bin/sh`, `cmd.exe` on Windows), resolving with { stdout, stderr }.
 * Throws RunError with the program's own output when it fails; `signal` cancels it (`cancelled` set).
 */
export function run(command, { cwd = process.cwd(), signal, input, env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, { cwd, shell: true, windowsHide: true, env: { ...process.env, ...env }, detached: process.platform !== 'win32' });
    let stdout = '';
    let stderr = '';
    let cancelled = false;
    child.stdout.setEncoding('utf8').on('data', (d) => (stdout += d));
    child.stderr.setEncoding('utf8').on('data', (d) => (stderr += d));
    const kill = () => {
      cancelled = true;
      // The shell's children too: a process group off Windows, taskkill's tree on it.
      if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
      else {
        try {
          process.kill(-child.pid, 'SIGTERM');
        } catch {
          child.kill('SIGTERM');
        }
      }
    };
    if (signal?.aborted) kill();
    signal?.addEventListener('abort', kill, { once: true });
    child.on('error', (e) => reject(new RunError(e.message, { stdout, stderr })));
    child.on('close', (code) => {
      signal?.removeEventListener('abort', kill);
      if (cancelled) return reject(new RunError('Cancelled', { stdout, stderr, cancelled: true }));
      if (code === 0) return resolve({ stdout, stderr });
      reject(new RunError(stderr.trim() || stdout.trim() || `${command} exited with ${code}`, { code, stdout, stderr }));
    });
    // A program that exits without reading its input (one that isn't there, say) closes the pipe first.
    child.stdin.on('error', () => {});
    child.stdin.end(input ?? '');
  });
}

/**
 * A signal of its own for one call (a fetch, a pause) under a long-lived `signal` (a task's, a
 * load's): aborted with it, but tied to it only until `done()`. fetch keeps a listener on the signal
 * it is given until the request is garbage collected, so many calls on one signal pile listeners up
 * on it (and Node warns). With no `signal`, the call gets none.
 */
export function callSignal(signal) {
  if (!signal) return { signal: undefined, done: () => {} };
  const own = new AbortController();
  const stop = () => own.abort(signal.reason);
  if (signal.aborted) stop();
  else signal.addEventListener('abort', stop, { once: true });
  return { signal: own.signal, done: () => signal.removeEventListener('abort', stop) };
}
