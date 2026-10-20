// The mouse: asks the terminal to report clicks, drags and the wheel, and takes those reports out of
// what Ink reads (it would turn them into junk key presses). Clicks are routed to the views by App;
// drags select text (selection.js).
import { copyToClipboard } from './clipboard.js';
import { frameLines, selectedText, selectionRows } from './selection.js';

// Button events plus drags (?1002), in the SGR encoding (?1006): ESC [ < b ; x ; y M (press) or m (release).
export const MOUSE_ON = '\x1b[?1002h\x1b[?1006h';
export const MOUSE_OFF = '\x1b[?1002l\x1b[?1006l';

const SGR = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/g;

/** Splits input into what's left for Ink and the mouse events in it (x, y 0-based). */
export function parseMouse(chunk) {
  const events = [];
  const rest = chunk.replace(SGR, (_, b, x, y, end) => {
    const code = Number(b);
    const e = {
      x: Number(x) - 1,
      y: Number(y) - 1,
      release: end === 'm',
      drag: Boolean(code & 32),
      shift: Boolean(code & 4),
      alt: Boolean(code & 8),
      ctrl: Boolean(code & 16),
    };
    // 64 and 65 are the wheel up and down; 66 and 67 tilt it sideways, which nothing uses.
    if (code & 64) e.button = code & 2 ? 'tilt' : 'wheel';
    else e.button = ['left', 'middle', 'right', 'none'][code & 3];
    if (e.button === 'wheel') e.wheel = code & 1 ? 1 : -1;
    events.push(e);
    return '';
  });
  return { rest, events };
}

/**
 * Takes mouse reports out of what Ink reads from `stdin` and calls `onMouse` with each, and `onKeys`
 * when anything else comes in. Returns an undo.
 */
export function listenMouse(stdin, onMouse, onKeys) {
  const read = stdin.read;
  let held = ''; // a report cut in two by a read boundary waits here for its end
  stdin.read = function (...args) {
    let chunk = read.apply(this, args);
    if (typeof chunk !== 'string') return chunk;
    chunk = held + chunk;
    held = '';
    if (!chunk.includes('\x1b[<')) {
      if (chunk) onKeys?.();
      return chunk;
    }
    const { rest, events } = parseMouse(chunk);
    events.forEach(onMouse);
    // Only once "ESC [ <" has arrived: holding a lone ESC back would hold up the esc key.
    const cut = /\x1b\[<[\d;]*$/.exec(rest);
    const keys = cut ? rest.slice(0, cut.index) : rest;
    if (cut) held = cut[0];
    if (keys) onKeys?.();
    return keys;
  };
  return () => {
    stdin.read = read;
  };
}

/** Whether "version" (like v22.17.0) is at least major.minor. */
export function atLeast(version, major, minor) {
  const [a, b] = version.replace(/^v/, '').split('.').map(Number);
  return a > major || (a === major && b >= minor);
}

// Windows hands mouse input to a program as text only in the console's VT input mode; otherwise it
// sends console mouse records, which libuv drops. Node 22.17 and later turn that mode on with raw mode.
const VT_INPUT = 0x200;

/** Turns VT input on after every switch to raw mode, through Bun's FFI (the compiled builds). */
async function keepVtInput(stdin) {
  const { dlopen, ptr } = await import('bun:ffi');
  const { symbols: k } = dlopen('kernel32.dll', {
    GetStdHandle: { args: ['i32'], returns: 'ptr' },
    GetConsoleMode: { args: ['ptr', 'ptr'], returns: 'i32' },
    SetConsoleMode: { args: ['ptr', 'u32'], returns: 'i32' },
  });
  const setRawMode = stdin.setRawMode;
  stdin.setRawMode = function (on) {
    const result = setRawMode.call(this, on);
    if (on) {
      const handle = k.GetStdHandle(-10);
      const mode = new Uint32Array(1);
      if (k.GetConsoleMode(handle, ptr(mode))) k.SetConsoleMode(handle, mode[0] | VT_INPUT);
    }
    return result;
  };
}

const SAVE = '\x1b7';
const RESTORE = '\x1b8';

/**
 * The mouse over `stdin` and `stdout`: { subscribe(fn) → unsubscribe, enable(on), stdout, off() }.
 * Listeners get the wheel, and a left click once the button comes back up where it went down.
 * Dragging instead selects text, painted over the frame and copied on release (clipboard.js, as y
 * copies in Results: the system clipboard, or OSC 52 through `stdout`); listeners then get
 * { type: 'copy', text }. A key, a click or the wheel clears the selection. Ink must draw through
 * `stdout` (the same stream, watched for frames to select from and paint over); `off` turns the
 * terminal's reporting off when Trawl exits.
 *
 * `claimDrags(fn)`: where `fn(press)` says so, the app selects for itself (Trawl's console selects
 * SQL): listeners get each move as { drag: true, x, y, from } (`from` where the button went down),
 * the last with `release` set, and nothing is painted.
 */
export function mouseSession(stdin, stdout, { copy = (text) => copyToClipboard(text, { write: (s) => stdout.write(s) }) } = {}) {
  const listeners = new Set();
  const emit = (e) => listeners.forEach((fn) => fn(e));
  let on = false;
  let frame = []; // the last frame Ink drew, styled lines from the top of the screen
  let press = null; // where the left button went down, until it comes back up
  let sel = null; // { a, b }: the cells a drag went from and to
  let claims = () => false;
  let claimed = false; // the press is where the app takes drags itself
  let dragged = false; // and the button has moved since

  const paint = () =>
    selectionRows(frame, sel.a, sel.b)
      .filter((r) => r.text)
      .map((r) => `\x1b[${r.y + 1};${r.col + 1}H\x1b[7m${r.text}\x1b[27m`)
      .join('');
  // Rows go back to how the frame drew them.
  const unpaint = () => selectionRows(frame, sel.a, sel.b).map((r) => `\x1b[${r.y + 1};1H\x1b[0m${frame[r.y]}\x1b[0m`).join('');
  const select = (b) => {
    const old = sel ? unpaint() : '';
    sel = { a: press, b };
    stdout.write(SAVE + old + paint() + RESTORE);
  };
  const clear = () => {
    if (!sel) return;
    const old = unpaint();
    sel = null;
    stdout.write(SAVE + old + RESTORE);
  };

  const onMouse = (e) => {
    if (e.button === 'left' && !e.release && !e.drag) {
      clear();
      press = e;
      claimed = Boolean(claims(e));
      dragged = false;
      return;
    }
    const from = press && { x: press.x, y: press.y };
    if (e.button === 'left' && e.drag) {
      if (press && claimed && (dragged || e.x !== press.x || e.y !== press.y)) {
        dragged = true;
        return emit({ ...e, from });
      }
      if (press && !claimed && (sel || e.x !== press.x || e.y !== press.y)) select({ x: e.x, y: e.y });
      return;
    }
    if (e.release) {
      const p = press;
      press = null;
      if (!p) return;
      if (claimed && dragged) return emit({ ...e, button: 'left', drag: true, from });
      if (!sel) return emit(p);
      const text = selectedText(selectionRows(frame, sel.a, sel.b));
      if (!text.trim()) return clear();
      copy(text);
      return emit({ type: 'copy', text });
    }
    clear();
    emit(e);
  };
  listenMouse(stdin, onMouse, () => {
    press = null;
    clear();
  });

  // Ink draws through this; after each frame, the selection is painted again over it.
  const write = (data, ...rest) => {
    const result = stdout.write(data, ...rest);
    const lines = frameLines(data);
    if (lines) {
      frame = lines;
      if (sel) stdout.write(SAVE + paint() + RESTORE);
    }
    return result;
  };
  const inkStdout = new Proxy(stdout, {
    get: (target, key) => (key === 'write' ? write : typeof target[key] === 'function' ? target[key].bind(target) : target[key]),
  });
  // The frame Ink draws next fits the new size; the selection was on the old one.
  stdout.on?.('resize', () => {
    sel = null;
    press = null;
  });

  return {
    stdout: inkStdout,
    subscribe: (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    enable: (want) => {
      if (want === on) return;
      if (!want) clear();
      on = want;
      press = null;
      stdout.write(want ? MOUSE_ON : MOUSE_OFF);
    },
    claimDrags: (fn) => {
      claims = fn;
    },
    off: () => on && stdout.write(MOUSE_OFF),
  };
}

/**
 * mouseSession() over the terminal, or undefined where this Node or terminal can't report the mouse
 * (Windows under a Node older than 22.17). Reporting is always off again when Trawl exits.
 */
export async function terminalMouse(stdin, stdout) {
  if (process.platform === 'win32') {
    if (typeof Bun !== 'undefined') {
      try {
        await keepVtInput(stdin);
      } catch {
        return undefined;
      }
    } else if (!atLeast(process.version, 22, 17)) return undefined;
  }
  const mouse = mouseSession(stdin, stdout);
  process.on('exit', mouse.off);
  return mouse;
}
