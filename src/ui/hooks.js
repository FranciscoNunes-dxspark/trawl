import { useEffect, useRef, useState } from 'react';
import { useStdin, useStdout } from 'ink';

export function useTerminalSize() {
  const { stdout } = useStdout();
  const read = () => ({ columns: stdout.columns || 100, rows: stdout.rows || 30 });
  const [size, setSize] = useState(read);
  useEffect(() => {
    const onResize = () => setSize(read());
    stdout.on('resize', onResize);
    return () => stdout.off('resize', onResize);
  }, [stdout]);
  return size;
}

/**
 * Cursor and scroll position for a list of `count` rows shown `height` at a time.
 * Rows where `selectable(i)` is false (section headers) are skipped over.
 * `resetKey` puts the cursor back on top when it changes (another repo, another filter), or on
 * row `start` (where it also starts). With `keyOf(i)` (what row i is: an id, a path), the cursor
 * stays on the same thing when the rows change under it (read again, rows coming in above it).
 */
export function useListNav(count, height, { selectable = () => true, resetKey, start = 0, keyOf } = {}) {
  const [index, setIndex] = useState(start);
  const offset = useRef(0);
  // The index as of the last key, which may not have rendered yet (j then d, typed fast).
  const latest = useRef(start);
  const lastKey = useRef(resetKey);
  // Scrolled with the wheel, the view leaves the cursor where it was, out of sight if need be,
  // until the cursor moves again.
  const free = useRef(false);
  const [, setScrolled] = useState(0);
  // What the cursor was on (keyOf), to find again when the rows change.
  const on = useRef(null);
  let i = index;
  if (lastKey.current !== resetKey) {
    lastKey.current = resetKey;
    i = start;
    offset.current = 0;
    free.current = false;
    on.current = null;
    if (index !== start) setIndex(start);
  } else if (keyOf && on.current != null && count && keyOf(Math.max(0, Math.min(i, count - 1))) !== on.current) {
    for (let j = 0; j < count; j++) {
      if (keyOf(j) === on.current) {
        i = j;
        if (index !== j) setIndex(j);
        break;
      }
    }
  }

  const find = (from, dir) => {
    for (let j = from; j >= 0 && j < count; j += dir) if (selectable(j)) return j;
    return -1;
  };
  i = Math.max(0, Math.min(i, count - 1));
  if (count && !selectable(i)) {
    const down = find(i, 1);
    i = down >= 0 ? down : Math.max(0, find(i, -1));
  }

  const h = Math.max(1, height);
  if (!free.current) {
    if (i < offset.current) offset.current = i;
    if (i >= offset.current + h) offset.current = i - h + 1;
    // Keep a section header in view above the first row under it.
    if (i > 0 && i === offset.current && !selectable(i - 1)) offset.current = i - 1;
  }
  offset.current = Math.max(0, Math.min(offset.current, Math.max(0, count - h)));

  const moveTo = (j) => {
    free.current = false;
    latest.current = j;
    if (keyOf) on.current = keyOf(j) ?? null;
    setIndex(j);
  };
  const go = (target, dir) => {
    const t = Math.max(0, Math.min(target, count - 1));
    let j = find(t, dir);
    if (j < 0) j = find(t, -dir);
    if (j >= 0) moveTo(j);
  };

  const handle = (input, key) => {
    if (!count) return false;
    const at = latest.current;
    if (key.downArrow || input === 'j') go(at + 1, 1);
    else if (key.upArrow || input === 'k') go(at - 1, -1);
    else if (key.pageDown || (key.ctrl && input === 'd')) go(at + h - 1, 1);
    else if (key.pageUp || (key.ctrl && input === 'u')) go(at - h + 1, -1);
    else if (input === 'g' || key.home) go(0, 1);
    else if (input === 'G' || key.end) go(count - 1, -1);
    else return false;
    return true;
  };

  /** Puts the cursor on the visible row `row` (a click), if that row takes it. Returns whether it did. */
  const pick = (row) => {
    const j = offset.current + row;
    if (row < 0 || row >= h || j >= count || !selectable(j)) return false;
    moveTo(j);
    return true;
  };

  /** Scrolls the list `n` rows (the wheel), leaving the cursor where it is. */
  const scrollBy = (n) => {
    if (!count) return;
    free.current = true;
    offset.current = Math.max(0, Math.min(offset.current + n, count - h));
    setScrolled((s) => s + 1);
  };

  latest.current = i;
  if (keyOf && count) on.current = keyOf(i) ?? null;
  return { index: i, offset: offset.current, handle, setIndex: moveTo, pick, scrollBy, current: () => latest.current };
}

/**
 * Mouse events for a component in the main area: wheel notches and left clicks, with `y` counted
 * from the component's top and `double` (or `triple`) set on a double-click. App hands each one to
 * the component mounted last whose `top` (its first line in the main area) is above it: the view on
 * screen, an overlay over it, or the results under the console. Where `drags(press)` says so, a drag
 * from there comes too, move by move ({ drag, x, y, from }, the last with `release`), in place of the
 * screen selection.
 */
export function useMouse(ctx, handler, { top = 0, drags } = {}) {
  const ref = useRef({ handler, top, drags });
  ref.current = { handler, top, drags };
  useEffect(() => {
    const entry = {
      get top() {
        return ref.current.top;
      },
      handle: (e) => ref.current.handler(e),
      drags: (e) => ref.current.drags?.(e),
    };
    ctx.mouseHandlers.push(entry);
    return () => {
      ctx.mouseHandlers = ctx.mouseHandlers.filter((h) => h !== entry);
    };
  }, []);
}

/**
 * Rewrites keys where they come in, before any useInput handler (the views', App's) sees them:
 * `translate(input)` gets each key as Ink read it and returns the key to hand on (the same one, or
 * another), or null to swallow it. Returns `send(input)`, which hands a key to every handler as if it
 * had been typed, without translating it. App uses it for your own keys (keymap.js) and ctrl+p.
 */
export function useKeyTranslation(translate) {
  const { internal_eventEmitter: events } = useStdin();
  const ref = useRef(translate);
  ref.current = translate;
  const emit = useRef(null);
  useEffect(() => {
    if (!events) return;
    const own = events.emit;
    emit.current = own;
    events.emit = function (name, input, ...rest) {
      if (name !== 'input' || typeof input !== 'string') return own.call(this, name, input, ...rest);
      const out = ref.current(input);
      return out == null ? false : own.call(this, name, out, ...rest);
    };
    return () => {
      events.emit = own;
      emit.current = null;
    };
  }, [events]);
  return (input) => (emit.current ?? events?.emit)?.call(events, 'input', input);
}

// Results of slow reads (diffs, commit details), keyed by what was asked, so moving back is instant.
// At most 300 of them and about MAX_WEIGHT characters of text: past either, the oldest go.
const cache = new Map();
const MAX_ENTRIES = 300;
const MAX_WEIGHT = 16_000_000;
let weight = 0;

/** About how much text `value` holds: its strings' lengths, looking at no more than 5000 values. */
export function weigh(value) {
  let total = 0;
  let seen = 0;
  const stack = [value];
  while (stack.length && seen++ < 5000) {
    const v = stack.pop();
    if (typeof v === 'string') total += v.length;
    else if (v && typeof v === 'object') {
      total += 8;
      for (const x of Array.isArray(v) ? v : Object.values(v)) stack.push(x);
    } else total += 1;
  }
  return total;
}

function remember(key, value) {
  const old = cache.get(key);
  if (old) weight -= old.weight;
  cache.delete(key);
  const entry = { value, weight: weigh(value) };
  cache.set(key, entry);
  weight += entry.weight;
  // The newest stays, however big.
  while (cache.size > 1 && (cache.size > MAX_ENTRIES || weight > MAX_WEIGHT)) {
    const [first, { weight: w }] = cache.entries().next().value;
    cache.delete(first);
    weight -= w;
  }
}

/** Lets go of the cached answers whose keys `stale(key)` picks. */
export function forgetAsync(stale) {
  for (const [k, { weight: w }] of cache) {
    if (stale(k)) {
      cache.delete(k);
      weight -= w;
    }
  }
}

/** What the cache holds now: { entries, weight } (for tests). */
export const asyncCacheSize = () => ({ entries: cache.size, weight });

/**
 * Runs `load` for `key` after a short pause (so holding j doesn't spawn a git per row),
 * keeping the previous value on screen until the new one arrives. Answers are cached by key;
 * `stale(key)`, when given, says which other keys the one shown makes useless (the same file read
 * for an older load), and those are let go once it is on screen.
 */
export function useAsync(key, load, delay = 60, { stale } = {}) {
  const [state, setState] = useState(() => (cache.has(key) ? { value: cache.get(key).value, key } : { loading: true }));
  // Through refs, so the effect (kept while the key stays) holds on to no render's closures: those
  // would keep that render's data alive after newer data replaced it.
  const staleRef = useRef(stale);
  staleRef.current = stale;
  const loadRef = useRef(load);
  loadRef.current = load;
  useEffect(() => {
    if (key == null) return;
    const shown = () => staleRef.current && forgetAsync((k) => k !== key && staleRef.current(k));
    if (cache.has(key)) {
      setState({ value: cache.get(key).value, key });
      shown();
      return;
    }
    let live = true;
    setState((s) => ({ ...s, loading: true }));
    const t = setTimeout(() => {
      loadRef.current().then(
        (value) => {
          remember(key, value);
          if (live) {
            setState({ value, key });
            shown();
          }
        },
        (error) => live && setState({ error, key }),
      );
    }, delay);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [key]);
  return state;
}
