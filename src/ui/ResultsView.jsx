import React, { useMemo, useState } from 'react';
import { Box, useInput } from 'ink';
import { formatValue, isNumericType } from '../sql.js';
import { theme } from '../theme.js';
import { fit, stringWidth } from '../text.js';
import { useListNav } from './hooks.js';
import { Lines, Panel, Row } from './parts.jsx';

const SEP = ' │ ';
const MAX_COL = 40;

/** Column widths from the header and the first rows, so wide text doesn't push everything off screen. */
export function columnWidths(set, sample = 200) {
  return set.columns.map((c, i) => {
    let w = stringWidth(c.name);
    for (const row of set.rows.slice(0, sample)) w = Math.max(w, stringWidth(formatValue(row[i])));
    return Math.max(4, Math.min(MAX_COL, w));
  });
}

/** One row as "column  value" lines, for the record view. */
export function recordText(set, row) {
  const nameW = Math.max(...set.columns.map((c) => stringWidth(c.name))) + 2;
  return set.columns.map((c, i) => `${c.name.padEnd(nameW)}${formatValue(row[i])}`).join('\n');
}

export function ResultsView({ results, setIndex, ctx, width, height, active }) {
  const sets = results?.sets ?? [];
  const set = sets[setIndex];
  const widths = useMemo(() => (set ? columnWidths(set) : []), [set]);
  const [colOffset, setColOffset] = useState(0);
  const innerW = width - 2;
  const innerH = height - 2;
  const notes = [...(results?.messages ?? [])];
  if (results?.error) notes.unshift(results.error);
  const noteLines = Math.min(3, notes.length);
  const gridH = Math.max(1, innerH - 2 - noteLines);
  const nav = useListNav(set?.rows.length ?? 0, gridH, { resetKey: `${results?.id}:${setIndex}` });
  const firstCol = Math.min(colOffset, Math.max(0, widths.length - 1));

  useInput(
    (input, key) => {
      if (!ctx.viewHasKeys()) return;
      if (nav.handle(input, key)) return;
      if (key.leftArrow || input === 'h') setColOffset(Math.max(0, firstCol - 1));
      else if (key.rightArrow || input === 'l') setColOffset(Math.min(widths.length - 1, firstCol + 1));
      else if (input === '[' && setIndex > 0) (ctx.setResultIndex(setIndex - 1), setColOffset(0));
      else if (input === ']' && setIndex < sets.length - 1) (ctx.setResultIndex(setIndex + 1), setColOffset(0));
      else if (input === 'x') ctx.prefill('/export ');
      else if (key.return && set?.rows[nav.index]) ctx.showText(`Row ${nav.index + 1} of ${set.rows.length}`, recordText(set, set.rows[nav.index]));
    },
    { isActive: active },
  );

  if (!results) {
    return (
      <Panel title="Results" width={width} height={height} focused={active}>
        <Row pointer={false} width={innerW} segments={[{ text: '  Nothing has run yet. ↵ on a table in the Explorer, or ! and some SQL at the prompt.', color: theme.dim }]} />
      </Panel>
    );
  }

  // The columns that fit, from the first one scrolled to.
  const shown = [];
  let used = 2;
  for (let i = firstCol; i < widths.length; i++) {
    const w = Math.min(widths[i], innerW - used);
    if (w < 4 && shown.length) break;
    shown.push({ i, w });
    used += w + SEP.length;
    if (used >= innerW) break;
  }
  const numeric = set ? set.columns.map((c) => isNumericType(c.type)) : [];
  const cells = (values, style) =>
    shown.flatMap(({ i, w }, k) => [
      ...(k ? [{ text: SEP, color: theme.border }] : []),
      { ...style(i, values[i]), text: fit(style(i, values[i]).text, w, numeric[i] ? 'right' : 'left') },
    ]);

  const parts = [];
  if (sets.length > 1) parts.push(`set ${setIndex + 1}/${sets.length}`);
  if (set) parts.push(`${set.rows.length}${set.truncated ? '+' : ''} row${set.rows.length === 1 ? '' : 's'}`);
  if (set && widths.length > shown.length) parts.push(`cols ${firstCol + 1}–${firstCol + shown.length}/${widths.length}`);
  if (results.ms != null) parts.push(`${results.ms} ms`);

  return (
    <Panel title={results.title} hint={parts.join(' · ')} width={width} height={height} focused={active}>
      {set ? (
        <Box flexDirection="column">
          <Row pointer={false} width={innerW} segments={[{ text: '  ' }, ...cells(set.columns.map((c) => c.name), (i, v) => ({ text: v, bold: true, color: theme.accent }))]} />
          <Row pointer={false} width={innerW} segments={[{ text: '  ' }, ...shown.flatMap(({ w }, k) => [...(k ? [{ text: '─┼─', color: theme.border }] : []), { text: '─'.repeat(w), color: theme.border }])]} />
          {set.rows.slice(nav.offset, nav.offset + gridH).map((row, r) => (
            <Row
              key={nav.offset + r}
              width={innerW}
              selected={nav.offset + r === nav.index}
              focused={active}
              segments={cells(row, (i, v) => ({ text: formatValue(v), color: v == null ? theme.nul : numeric[i] ? theme.number : undefined, italic: v == null }))}
            />
          ))}
          {set.rows.length === 0 ? <Row pointer={false} width={innerW} segments={[{ text: '  (no rows)', color: theme.dim }]} /> : null}
          {Array.from({ length: Math.max(0, gridH - Math.max(1, set.rows.length - nav.offset)) }, (_, k) => (
            <Row key={`pad${k}`} pointer={false} width={innerW} segments={[]} />
          ))}
        </Box>
      ) : (
        <Lines width={innerW} height={gridH + 2} lines={[[{ text: '  No result set: the statement returned no rows to show.', color: theme.dim }]]} />
      )}
      <Lines
        width={innerW}
        height={noteLines}
        lines={notes.slice(0, noteLines).map((m, k) => [{ text: `  ${m}`, color: results.error && k === 0 ? theme.del : theme.dim }])}
      />
    </Panel>
  );
}
