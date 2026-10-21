// The command palette (ctrl+p), shared by Trawl and Splice: every slash command, yours too, and the
// keys of the view you're in, filtered as you type. Pure: the fuzzy match, and the list made from
// commands.js, help.js's sections and the keymap. ui/Palette.jsx draws it; App runs what's picked.

import { isCommandLine, parseKey } from './keymap.js';
import { runsAlone } from './usercommands.js';

const isWordChar = (c) => /[\p{L}\p{N}]/u.test(c);

/**
 * How well `query` matches `text`: higher is better, null when it doesn't. Each word of the query
 * (split on spaces, in any order) must be in the text, ignoring case: whole, or with `loose`, its
 * letters in order but not side by side ("cmt" in "commit"). A word typed whole counts for more than
 * its letters, and more again at the start of a word and near the start of the text; letters count
 * for more side by side and at the start of a word.
 */
export function fuzzyScore(query, text, { loose = true } = {}) {
  const words = String(query ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  const t = String(text ?? '');
  const lower = t.toLowerCase();
  let total = 0;
  for (const w of words) {
    const s = Math.max(whole(w, t, lower) ?? -1, loose ? letters(w, t, lower) ?? -1 : -1);
    if (s < 0) return null;
    total += s;
  }
  return total;
}

const wordStart = (t, i) => i === 0 || !isWordChar(t[i - 1]);

// The word as it is, best where it starts a word of the text.
function whole(w, t, lower) {
  let best = null;
  for (let i = lower.indexOf(w); i >= 0; i = lower.indexOf(w, i + 1)) {
    const s = w.length * 10 + (wordStart(t, i) ? 30 : 10) + Math.max(0, 20 - i);
    if (best == null || s > best) best = s;
    if (wordStart(t, i)) break;
  }
  return best;
}

// Its letters in order, taken as early as they come.
function letters(w, t, lower) {
  let score = 0;
  let prev = -2;
  let from = 0;
  for (const c of w) {
    const i = lower.indexOf(c, from);
    if (i < 0) return null;
    score += 1 + (i === prev + 1 ? 5 : 0) + (wordStart(t, i) ? 8 : 0);
    if (prev < 0) score += Math.max(0, 10 - i);
    prev = i;
    from = i + 1;
  }
  return score;
}

/**
 * The items that match `query`, best first (in the order they came when as good, and all of them
 * with no query). Each word of the query must be in the item's `label`, loosely (letters in order:
 * "cmt" finds /commit) and worth double there, or whole in its label and `desc` together.
 */
export function filterItems(items, query) {
  const words = String(query ?? '').split(/\s+/).filter(Boolean);
  if (!words.length) return items;
  const scored = [];
  items.forEach((it, i) => {
    let s = 0;
    for (const w of words) {
      const label = fuzzyScore(w, it.label);
      const both = fuzzyScore(w, `${it.label} ${it.desc ?? ''}`, { loose: false });
      if (label == null && both == null) return;
      s += Math.max(label == null ? 0 : label * 2, both ?? 0);
    }
    scored.push({ it, i, s });
  });
  return scored.sort((a, b) => b.s - a.s || a.i - b.i).map((x) => x.it);
}

/**
 * A help row's keys as the keys to send: "c  A" → c and A, "↵ or i" → ↵, "ctrl+d ctrl+u" → both.
 * Words that aren't a key ("Typing", "/find", "1-6") are left out.
 */
export function rowKeys(keys) {
  const out = [];
  for (const word of String(keys).split(/\s+/)) {
    if (!word || word === 'or' || word === '/') continue;
    // "/find <text>" and the like are commands, which the palette lists already.
    if (word.length > 1 && /^[/<[!@$]/.test(word)) return [];
    const k = parseKey(word);
    if (!k.error) out.push(k);
  }
  return out;
}

/**
 * The keys of `sections` (help.js's, for the view on screen) as palette items: { label, desc, group,
 * key }. A row with as many keys as parts in what it says ("c  A", "Commit · Amend") is an item a
 * key; otherwise the row is one item, sending its first key. `skip` are key names to leave out (the
 * palette's own).
 */
export function keyItems(sections, { skip = [] } = {}) {
  const items = [];
  for (const s of sections) {
    for (const row of s.rows) {
      if (!Array.isArray(row)) continue;
      const [keys, text] = row;
      const ks = rowKeys(keys).filter((k) => !skip.includes(k.name));
      if (!ks.length) continue;
      const first = String(text).split('\n')[0];
      const parts = first.split(' · ');
      if (ks.length > 1 && parts.length === ks.length) ks.forEach((k, i) => items.push({ label: k.name, desc: parts[i], group: s.title, key: k }));
      else items.push({ label: keys, desc: first, group: s.title, key: ks[0] });
    }
  }
  return items;
}

/**
 * Every item the palette lists, for the view on screen: its keys (`sections`), the keys you mapped
 * there and anywhere (`keymap` rows for `view`), your commands (`user`), then the built-in ones
 * (`commands`). A command item has `command`, the line to run, and `ask` when it needs something typed
 * after it (it then goes into the prompt instead); a key's has `key`.
 */
export function paletteItems({ commands = [], user = [], sections = [], keymap = null, view = null, skip = [] }) {
  const command = (c, group) => ({ label: `/${c.name}`, hint: c.args ?? '', desc: c.desc ?? '', group, command: `/${c.name}`, ask: !runsAlone(c) });
  const mine = (keymap?.rows ?? [])
    .filter((r) => r.view === 'global' || r.view === view)
    .map((r) => ({ label: r.name, desc: isCommandLine(r.to) ? `runs ${r.to}` : `does what ${r.to} does`, group: 'Your keys', ...(isCommandLine(r.to) ? { command: r.to } : { key: parseKey(r.to) }) }));
  return [...keyItems(sections, { skip }), ...mine, ...user.map((c) => command(c, 'Your commands')), ...commands.map((c) => command(c, 'Slash commands'))];
}
