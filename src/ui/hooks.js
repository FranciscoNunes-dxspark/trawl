import { useEffect, useRef, useState } from 'react';
import { useStdout } from 'ink';

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
 * row `start` (where it also starts).
 */
export function useListNav(count, height, { selectable = () => true, resetKey, start = 0 } = {}) {
  const [index, setIndex] = useState(start);
  const offset = useRef(0);
  // The index as of the last key, which may not have rendered yet (j then d, typed fast).
  const latest = useRef(start);
  const lastKey = useRef(resetKey);
  // Scrolled with the wheel, the view leaves the cursor where it was, out of sight if need be,
  // until the cursor moves again.
  const free = useRef(false);
  const [, setScrolled] = useState(0);
  let i = index;
  if (lastKey.current !== resetKey) {
    lastKey.current = resetKey;
    i = start;
    offset.current = 0;
    free.current = false;
    if (index !== start) setIndex(start);
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

// Results of slow reads (diffs, commit details), keyed by what was asked, so moving back is instant.
const cache = new Map();

/**
 * Runs `load` for `key` after a short pause (so holding j doesn't spawn a git per row),
 * keeping the previous value on screen until the new one arrives.
 */
export function useAsync(key, load, delay = 60) {
  const [state, setState] = useState(() => (cache.has(key) ? { value: cache.get(key), key } : { loading: true }));
  useEffect(() => {
    if (key == null) return;
    if (cache.has(key)) {
      setState({ value: cache.get(key), key });
      return;
    }
    let live = true;
    setState((s) => ({ ...s, loading: true }));
    const t = setTimeout(() => {
      load().then(
        (value) => {
          cache.set(key, value);
          if (cache.size > 300) cache.delete(cache.keys().next().value);
          if (live) setState({ value, key });
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
