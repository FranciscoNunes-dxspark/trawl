import React, { useEffect, useRef, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { theme } from '../theme.js';
import { clean, fit, fitSegments, stringWidth } from '../text.js';

/** One line of styled segments, cut to `width`. Draws the ❯ cursor and the selection background. */
export function Row({ segments, width, selected = false, focused = true, pointer = true }) {
  const head = pointer ? [{ text: selected ? '❯ ' : '  ', color: theme.accent, bold: true }] : [];
  const segs = fitSegments([...head, ...segments], width);
  const bg = selected && focused ? theme.selBg : undefined;
  return (
    <Text wrap="truncate">
      {segs.map((s, i) => (
        <Text
          key={i}
          color={s.color}
          backgroundColor={s.bg ?? bg}
          bold={s.bold || (selected && focused && s.strong)}
          dimColor={s.dim}
          italic={s.italic}
          underline={s.underline}
          strikethrough={s.strike}
          inverse={s.inverse}
        >
          {s.text}
        </Text>
      ))}
    </Text>
  );
}

/** A rounded box with its title set into the top border, like Claude Code's panels. */
export function Panel({ title, hint, width, height, focused = false, children }) {
  const color = focused ? theme.accent : theme.border;
  const label = title ? ` ${title} ` : '';
  const right = hint ? ` ${hint} ` : '';
  const room = width - 4;
  const shownLabel = fit(label, Math.min(stringWidth(label), room)).trimEnd() + (label ? ' ' : '');
  const shownHint = stringWidth(shownLabel) + stringWidth(right) <= room ? right : '';
  const fill = Math.max(0, room - stringWidth(shownLabel) - stringWidth(shownHint));
  return (
    <Box flexDirection="column" width={width} height={height}>
      <Text wrap="truncate">
        <Text color={color}>╭─</Text>
        <Text color={focused ? theme.accent : undefined} bold>
          {shownLabel}
        </Text>
        <Text color={color}>{'─'.repeat(fill)}</Text>
        <Text color={theme.dim}>{shownHint}</Text>
        <Text color={color}>─╮</Text>
      </Text>
      <Box
        flexDirection="column"
        width={width}
        height={height - 1}
        borderStyle="round"
        borderTop={false}
        borderColor={color}
        overflow="hidden"
      >
        {children}
      </Box>
    </Box>
  );
}

/** Lines of segments (or plain strings) without a cursor, for detail panes. */
export function Lines({ lines, width, height, offset = 0 }) {
  const shown = lines.slice(offset, offset + height);
  return shown.map((line, i) => (
    <Row key={i} pointer={false} width={width} segments={typeof line === 'string' ? [{ text: line }] : line} />
  ));
}

const FRAMES = ['·', '✢', '✳', '✶', '✻', '✽', '✻', '✶', '✳', '✢'];

/** "✻ Running… (3s · esc to cancel)", animated while a query runs. */
export function Spinner({ label, started, width }) {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 120);
    return () => clearInterval(t);
  }, []);
  const secs = Math.floor((Date.now() - started) / 1000);
  return (
    <Row
      pointer={false}
      width={width}
      segments={[
        { text: `${FRAMES[tick % FRAMES.length]} ${label}…`, color: theme.accent },
        { text: ` (${secs}s · esc to cancel)`, color: theme.dim },
      ]}
    />
  );
}

export function confirmHeight(req) {
  if (req.secret) return 4 + (req.detail ? 1 : 0) + (req.remember !== undefined ? 1 : 0);
  return 3 + (req.detail ? 1 : 0) + req.options.length;
}

/**
 * A password field in the confirm box: what's typed shows as * (or as it is, with `req.plain`, for
 * a value that isn't secret; `req.value` is what it starts with). ↵ gives { value, remember },
 * esc null. With `req.remember` set, tab flips the "keep it" choice under the field.
 */
export function SecretPrompt({ req, width, onDone }) {
  const [value, setValueState] = useState(req.value ?? '');
  const [remember, setRemember] = useState(req.remember);
  // ↵ can come before the render after the last key, so the text lives in a ref too.
  const valueRef = useRef(req.value ?? '');
  const setValue = (v) => {
    valueRef.current = v;
    setValueState(v);
  };
  useInput((input, key) => {
    if (key.escape) return onDone(null);
    if (key.return) return onDone({ value: valueRef.current, remember: Boolean(remember) });
    if (key.tab) return remember !== undefined && setRemember((r) => !r);
    if (key.backspace || key.delete) return setValue(valueRef.current.slice(0, -1));
    if (key.ctrl && input === 'u') return setValue('');
    if (key.ctrl || key.meta || !input) return;
    const text = input.replace(/[\x00-\x1f\x7f]/g, '');
    if (text) setValue(valueRef.current + text);
  });
  const inner = width - 4;
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={req.danger ? theme.del : theme.accent} width={width} paddingX={1}>
      <Text bold wrap="truncate">
        {fit(req.title, inner).trimEnd()}
      </Text>
      {req.detail ? (
        <Text color={theme.dim} wrap="truncate">
          {fit(req.detail, inner).trimEnd()}
        </Text>
      ) : null}
      <Text wrap="truncate">
        <Text color={theme.accent} bold>
          {'> '}
        </Text>
        {req.plain ? value.slice(-Math.max(1, inner - 3)) : '*'.repeat(Math.min(value.length, Math.max(0, inner - 3)))}
        <Text inverse> </Text>
      </Text>
      {remember !== undefined ? (
        <Row
          pointer={false}
          width={inner}
          segments={[
            { text: remember ? '[x] ' : '[ ] ', color: theme.accent, bold: true },
            { text: req.rememberLabel ?? 'Remember it' },
            { text: '  (tab changes it · ↵ connect · esc cancel)', color: theme.dim },
          ]}
        />
      ) : null}
    </Box>
  );
}

/** A numbered choice in a box, like Claude Code's permission prompts. Esc picks null. */
export function Confirm({ req, width, onDone }) {
  const [sel, setSel] = useState(0);
  const n = req.options.length;
  useInput((input, key) => {
    if (key.escape) return onDone(null);
    if (key.upArrow || input === 'k') return setSel((s) => (s - 1 + n) % n);
    if (key.downArrow || input === 'j' || key.tab) return setSel((s) => (s + 1) % n);
    const num = Number(input);
    if (num >= 1 && num <= n) return onDone(req.options[num - 1].value);
    if (key.return) onDone(req.options[sel].value);
  });
  const inner = width - 4;
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={req.danger ? theme.del : theme.accent} width={width} paddingX={1}>
      <Text bold wrap="truncate">
        {fit(req.title, inner).trimEnd()}
      </Text>
      {req.detail ? (
        <Text color={theme.dim} wrap="truncate">
          {fit(req.detail, inner).trimEnd()}
        </Text>
      ) : null}
      {req.options.map((o, i) => (
        <Row
          key={i}
          width={inner}
          selected={i === sel}
          focused={false}
          segments={[{ text: `${i + 1}. ${o.label}`, color: i === sel ? theme.accent : undefined, bold: i === sel }]}
        />
      ))}
    </Box>
  );
}

/** The input box. Rendering only: App owns the text and handles the keys (see usePromptKeys). */
export function PromptBox({ value, cursor, focused, width, placeholder }) {
  const sqlMode = value.startsWith('!');
  const color = !focused ? theme.border : sqlMode ? theme.sqlMode : theme.accent;
  const inner = width - 6;
  let body;
  if (!focused && !value) {
    body = <Text color={theme.dim}>{fit(placeholder, inner).trimEnd()}</Text>;
  } else {
    // Scroll the text so the cursor stays visible.
    const start = Math.max(0, cursor - inner + 1);
    const visible = value.slice(start, start + inner);
    const at = cursor - start;
    const before = clean(visible.slice(0, at));
    const under = visible[at] ?? ' ';
    const after = clean(visible.slice(at + 1));
    body = focused ? (
      <Text>
        {before}
        <Text inverse>{under}</Text>
        {after}
      </Text>
    ) : (
      <Text color={theme.dim}>{clean(visible)}</Text>
    );
  }
  return (
    <Box borderStyle="round" borderColor={color} width={width} paddingX={1}>
      <Text color={focused ? color : theme.dim} bold>
        {sqlMode ? '! ' : '> '}
      </Text>
      {body}
    </Box>
  );
}

/** The slash-command menu under the prompt. */
export function Suggestions({ items, selected, width }) {
  const nameW = Math.min(28, Math.max(...items.map((s) => stringWidth(s.label + (s.hint ? ` ${s.hint}` : '')))) + 2);
  return items.map((s, i) => {
    const on = i === selected;
    const name = s.label + (s.hint ? ` ${s.hint}` : '');
    return (
      <Row
        key={s.label}
        width={width}
        pointer={false}
        segments={[
          { text: '  ' },
          { text: fit(name, nameW), color: on ? theme.accent : undefined, bold: on },
          { text: s.desc ?? '', color: on ? theme.accent : theme.dim },
        ]}
      />
    );
  });
}
