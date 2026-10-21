// Your own keys ("keys" in config.json), shared by Trawl and Splice: key names as people write them
// (ctrl+s, shift+tab, alt+x, F5, X) turned into what the terminal sends, and a keymap that says what
// a key does in a view, or anywhere: another key (the view then does what that key does) or a slash
// command line. Pure; App rewrites keys with it before any handler sees them (hooks.js useKeyTranslation).

// What the terminal sends for each named key: the first is the one a key mapped to it sends, the
// others what some terminals send instead.
const NAMED = {
  enter: ['\r', '\n'],
  esc: ['\x1b'],
  tab: ['\t'],
  'shift+tab': ['\x1b[Z'],
  space: [' '],
  backspace: ['\x7f', '\b'],
  delete: ['\x1b[3~'],
  up: ['\x1b[A', '\x1bOA'],
  down: ['\x1b[B', '\x1bOB'],
  right: ['\x1b[C', '\x1bOC'],
  left: ['\x1b[D', '\x1bOD'],
  home: ['\x1b[H', '\x1b[1~', '\x1bOH'],
  end: ['\x1b[F', '\x1b[4~', '\x1bOF'],
  pageup: ['\x1b[5~'],
  pagedown: ['\x1b[6~'],
  f1: ['\x1bOP', '\x1b[11~'],
  f2: ['\x1bOQ', '\x1b[12~'],
  f3: ['\x1bOR', '\x1b[13~'],
  f4: ['\x1bOS', '\x1b[14~'],
  f5: ['\x1b[15~'],
  f6: ['\x1b[17~'],
  f7: ['\x1b[18~'],
  f8: ['\x1b[19~'],
  f9: ['\x1b[20~'],
  f10: ['\x1b[21~'],
  f11: ['\x1b[23~'],
  f12: ['\x1b[24~'],
};
// Other ways of writing them.
const ALIASES = { return: 'enter', '↵': 'enter', escape: 'esc', '↑': 'up', '↓': 'down', '←': 'left', '→': 'right', del: 'delete', pgup: 'pageup', pgdn: 'pagedown', pgdown: 'pagedown' };
// ctrl and these letters send the same as another key: it couldn't be told apart.
const CTRL_SAME = { i: 'tab', m: 'enter', '[': 'esc' };

/**
 * A key name as people write it ("ctrl+s", "shift+tab", "alt+x", "F5", "X", "↵"), as
 * { name, seq, seqs }: `name` written the one way (ctrl+s, f5, X), `seq` what the terminal sends for
 * it and `seqs` every form it may come in; or { error } saying what's wrong with it.
 */
export function parseKey(text) {
  const raw = String(text ?? '');
  if (!raw) return { error: 'an empty key' };
  // A key of one character is itself, + and space included.
  if ([...raw].length === 1) {
    if (raw === ' ') return key('space', NAMED.space);
    if (ALIASES[raw]) return key(ALIASES[raw], NAMED[ALIASES[raw]]);
    return /[\x00-\x1f\x7f]/.test(raw) ? { error: `"${printable(raw)}" isn't a key name` } : key(raw, [raw]);
  }
  const parts = raw.split('+');
  // "ctrl++" is ctrl and the + key.
  if (parts.at(-1) === '' && parts.length > 1) parts.splice(-2, 2, '+');
  const last = parts.pop();
  const mods = new Set(parts.map((p) => p.trim().toLowerCase()));
  for (const m of mods) if (!['ctrl', 'alt', 'shift', 'meta', 'option'].includes(m)) return { error: `"${raw}": ${m} isn't ctrl, alt or shift` };
  const alt = mods.has('alt') || mods.has('meta') || mods.has('option');
  const ctrl = mods.has('ctrl');
  const shift = mods.has('shift');
  const alias = ALIASES[last.toLowerCase()] ?? last.toLowerCase();
  const named = NAMED[alias] ? alias : null;
  if (ctrl && (shift || alt)) return { error: `"${raw}": terminals don't send ctrl with shift or alt as a key of its own` };
  if (named) {
    if (ctrl || alt) return { error: `"${raw}": terminals don't tell ${ctrl ? 'ctrl' : 'alt'}+${named} apart reliably; use a letter` };
    if (shift && named !== 'tab') return { error: `"${raw}": shift+${named} isn't a key terminals send; shift+tab is` };
    const name = shift ? 'shift+tab' : named;
    return key(name, NAMED[name]);
  }
  if ([...last].length !== 1) return { error: `"${raw}" isn't a key name (a letter, ctrl+s, alt+x, shift+tab, F5, enter, esc…)` };
  if (ctrl) {
    const c = last.toLowerCase();
    if (CTRL_SAME[c]) return { error: `"${raw}" is the same as ${CTRL_SAME[c]} in a terminal` };
    if (c === 'c') return { error: '"ctrl+c" always quits' };
    if (!/^[a-z]$/.test(c)) return { error: `"${raw}": ctrl goes with a letter` };
    return key(`ctrl+${c}`, [String.fromCharCode(c.charCodeAt(0) - 96)]);
  }
  // shift+x is X; shift with anything but a letter is that key's own character.
  const ch = shift ? (/^[a-z]$/i.test(last) ? last.toUpperCase() : null) : last;
  if (ch == null) return { error: `"${raw}": shift goes with a letter (shift+x is X) or tab` };
  if (alt) return key(`alt+${ch}`, [`\x1b${ch}`]);
  return key(ch, [ch]);
}

const key = (name, seqs) => ({ name, seq: seqs[0], seqs });
const printable = (s) => s.replace(/[\x00-\x1f\x7f]/g, (c) => `\\x${c.charCodeAt(0).toString(16).padStart(2, '0')}`);

/** Whether a mapping's value is a command line (a slash command, or the app's `!` line) rather than a key. */
export const isCommandLine = (value) => typeof value === 'string' && /^[/!]/.test(value.trim()) && value.trim().length > 1;

/**
 * `spec` is config.json's "keys": { global: { "ctrl+s": "/commit" }, graph: { x: "X" } }, and `views`
 * the views' names. Returns { maps, rows, problems }: `maps` has a Map for "global" and for each view
 * named, from what the terminal sends to { name, to, key } (the key to send instead, as parseKey's) or
 * { name, to, command } (a line to run); `rows` lists them all as { view, name, to }, for the ? window
 * and the palette; `problems` says what was left out, and why, a line each.
 */
export function parseKeymap(spec, views) {
  const maps = { global: new Map() };
  const rows = [];
  const problems = [];
  if (spec == null) return { maps, rows, problems };
  if (typeof spec !== 'object' || Array.isArray(spec)) return { maps, rows, problems: ['"keys" should be an object: { "global": { "ctrl+s": "/commit" }, "<view>": { "x": "X" } }'] };
  for (const [view, keys] of Object.entries(spec)) {
    if (view !== 'global' && !views.includes(view)) {
      problems.push(`"${view}" isn't a view: use global, ${views.join(', ')}`);
      continue;
    }
    if (!keys || typeof keys !== 'object' || Array.isArray(keys)) {
      problems.push(`${view}: should be an object of key → key or command`);
      continue;
    }
    const map = (maps[view] ??= new Map());
    for (const [from, to] of Object.entries(keys)) {
      const k = parseKey(from);
      if (k.error) {
        problems.push(`${view}: ${k.error}`);
        continue;
      }
      if (typeof to !== 'string' || !to.trim()) {
        problems.push(`${view}: ${k.name} should map to a key or a command line, as text`);
        continue;
      }
      let binding;
      if (isCommandLine(to)) binding = { name: k.name, to: to.trim(), command: to.trim() };
      else {
        const target = parseKey(to);
        if (target.error) {
          problems.push(`${view}: ${k.name} → ${target.error}`);
          continue;
        }
        binding = { name: k.name, to: target.name, key: target };
      }
      for (const s of k.seqs) map.set(s, binding);
      rows.push({ view, name: k.name, to: binding.to });
    }
  }
  return { maps, rows, problems };
}

/** What the keymap does with `input` (a key as Ink reads it) in `view`: its binding there, else the global one, or null. */
export function translateKey(keymap, view, input) {
  return keymap.maps[view]?.get(input) ?? keymap.maps.global.get(input) ?? null;
}

/**
 * The keymap as a ? window section: anywhere first, then each view's (`labels` names them: { graph:
 * 'Graph' }), a row a key with what it does now.
 */
export function keymapSection(keymap, labels = {}) {
  if (!keymap.rows.length) return null;
  const rows = [];
  for (const view of ['global', ...Object.keys(labels)]) {
    const mine = keymap.rows.filter((r) => r.view === view);
    if (!mine.length) continue;
    rows.push({ heading: view === 'global' ? 'Anywhere' : labels[view] ?? view });
    for (const r of mine) rows.push([r.name, isCommandLine(r.to) ? `runs ${r.to}` : `does what ${r.to} does`]);
  }
  return { title: 'Your keys', about: '"keys" in the settings file; they work while a view has the keys, not while typing', rows };
}
