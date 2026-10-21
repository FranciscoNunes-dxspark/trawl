// The ? window's layout, shared by Trawl, Splice and Keel; each keeps its own help.js. Pure: a
// section's rows laid out as lines of segments, a search across every section, and the slash
// commands as a section of their own. HelpView (ui/HelpView.jsx) draws what these return.
//
// A section is { title, about?, views?, rows }. A row is [keys, what they do] (a \n in the text
// starts a line of its own), a string (a note, across the pane), or { heading, about? }.
// `views` names the views the window opens on this section from.

import { stringWidth, wrap } from './text.js';

// The keys' column is as wide as a section's widest keys up to this; wider ones take a line of
// their own, with what they do under them, so one long key doesn't push every row over.
const KEYS_MAX = 16;

/** The slash commands as a help section, from commands.js: /name, then its arguments (dim) and what it does. */
export function commandsSection(commands, title = 'Slash commands') {
  return { title, about: 'type / anywhere; tab completes', rows: commands.map((c) => [`/${c.name}`, c.desc ?? '', c.args]) };
}

/** The section `view` opens on (its index), or 0. */
export function sectionFor(sections, view) {
  return Math.max(0, sections.findIndex((s) => s.views?.includes(view)));
}

const rowText = (row) => (typeof row === 'string' ? row : Array.isArray(row) ? row.filter(Boolean).join(' ') : `${row.heading} ${row.about ?? ''}`);

/**
 * The sections with only their rows that mention `query` (ignoring case); a section whose title
 * matches keeps every row. Sections with nothing left go.
 */
export function searchHelp(sections, query) {
  const q = query.trim().toLowerCase();
  if (!q) return sections;
  return sections
    .map((s) => (s.title.toLowerCase().includes(q) ? s : { ...s, rows: s.rows.filter((r) => rowText(r).toLowerCase().includes(q)) }))
    .filter((s) => s.rows.length);
}

/** Splits segments where `query` appears (ignoring case), marking those pieces as matches. */
function marked(segs, query) {
  const q = query?.trim().toLowerCase();
  if (!q) return segs;
  return segs.flatMap((s) => {
    const out = [];
    const lower = s.text.toLowerCase();
    let at = 0;
    for (let i = lower.indexOf(q); i >= 0; i = lower.indexOf(q, i + q.length)) {
      if (i > at) out.push({ ...s, text: s.text.slice(at, i) });
      out.push({ ...s, text: s.text.slice(i, i + q.length), match: true });
      at = i + q.length;
    }
    if (at < s.text.length) out.push({ ...s, text: s.text.slice(at) });
    return out;
  });
}

/**
 * What keys do, wrapped to `width`: one list of segments a line, a command's arguments (dim) in
 * front of its description.
 */
function described(text, args, width) {
  const whole = args ? `${args}  ${text}` : text;
  if (!whole) return [];
  let dim = args ? args.length : 0;
  return wrap(whole, width).map((line) => {
    const n = Math.min(dim, line.length);
    // The space a line breaks at isn't on either line.
    dim = Math.max(0, dim - n - 1);
    return [...(n ? [{ text: line.slice(0, n), kind: 'args' }] : []), ...(line.length > n ? [{ text: line.slice(n), kind: 'text' }] : [])];
  });
}

/**
 * A section as lines `width` columns wide, each a list of segments { text, kind, match? }: kind is
 * 'keys', 'text', 'args' (a command's arguments), 'note' or 'heading'. The keys sit in a column as
 * wide as the section's widest (up to KEYS_MAX), with what they do wrapped beside them. `query`
 * marks where it appears.
 */
export function sectionLines(section, width, { query = '' } = {}) {
  const w = Math.max(10, width - 1);
  const keysW = Math.max(0, ...section.rows.filter(Array.isArray).map((r) => stringWidth(r[0])).filter((n) => n <= KEYS_MAX));
  const col = keysW + 3;
  const textW = Math.max(10, w - col);
  const lines = [];
  const push = (segs) => lines.push(marked([{ text: ' ' }, ...segs], query));
  const indent = (n) => ({ text: ' '.repeat(n) });

  if (section.about) for (const l of wrap(section.about, w)) push([{ text: l, kind: 'note' }]);
  if (section.about) lines.push([]);
  for (const row of section.rows) {
    if (typeof row === 'string') {
      // A note is a paragraph: a line between it and what's above.
      if (lines.length && lines.at(-1).length) lines.push([]);
      for (const l of wrap(row, w)) push([{ text: l, kind: 'note' }]);
      continue;
    }
    if (!Array.isArray(row)) {
      if (lines.length && lines.at(-1).length) lines.push([]);
      push([{ text: row.heading, kind: 'heading' }]);
      if (row.about) for (const l of wrap(row.about, w)) push([{ text: l, kind: 'note' }]);
      continue;
    }
    const [keys, text, args] = row;
    const body = described(text, args, textW);
    if (stringWidth(keys) > keysW) {
      // Too wide for the column: the keys on a line of their own, what they do under them.
      for (const l of wrap(keys, w)) push([{ text: l, kind: 'keys' }]);
      for (const b of body) push([indent(col - 1), ...b]);
      continue;
    }
    const pad = indent(col - 1 - stringWidth(keys));
    push([{ text: keys, kind: 'keys' }, pad, ...(body[0] ?? [])]);
    for (const b of body.slice(1)) push([indent(col - 1), ...b]);
  }
  return lines;
}
