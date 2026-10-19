import React, { useEffect, useRef, useState } from 'react';
import { Box, Text, useApp, useInput } from 'ink';
import { readFileSync, statSync, unwatchFile, watchFile } from 'node:fs';
import { basename, resolve } from 'node:path';
import * as a from '../actions.js';
import { findCommand, suggestionsFor } from '../commands.js';
import { saveConfig, withRan } from '../config.js';
import { describeConn, isReadOnly } from '../connections.js';
import { connect as openSession } from '../db.js';
import { HELP } from '../help.js';
import { SCHEMA_SQL, buildSchema } from '../schema.js';
import { splitStatements } from '../sql.js';
import { BULLET, theme } from '../theme.js';
import { fitSegments, stringWidth } from '../text.js';
import { useTerminalSize } from './hooks.js';
import { Confirm, Panel, PromptBox, Row, Spinner, Suggestions, confirmHeight } from './parts.jsx';
import { ConnectionsView } from './ConnectionsView.jsx';
import { ExplorerView } from './ExplorerView.jsx';
import { HistoryView } from './HistoryView.jsx';
import { QueryView } from './QueryView.jsx';
import { ResultsView } from './ResultsView.jsx';
import { TextViewer } from './TextViewer.jsx';
import { WELCOME_HEIGHT, Welcome } from './Glim.jsx';
import { FACES, moodFor } from '../glim.js';
import { checksDisabled, isDue, isNewer, openUrl, updateAdvice } from '../update.js';
import { COMPILED, VERSION } from '../version.js';

const VIEWS = [
  { id: 'explorer', label: 'Explorer' },
  { id: 'query', label: 'Query' },
  { id: 'results', label: 'Results' },
  { id: 'history', label: 'History' },
  { id: 'connections', label: 'Connections' },
];

const HINTS = {
  explorer: '↵ first rows · d describe · s query it · /find filter',
  query: '↵ run statement · v select several · R run file · e to prompt',
  results: 'h/l columns · [ ] result sets · ↵ record · x export',
  history: '↵ run again · e to prompt',
  connections: '↵ connect · n new · x forget',
};

// Typed at the prompt without "!", these still run as SQL.
const SQL_START = /^(select|with|insert|update|delete|merge|exec|execute|create|alter|drop|truncate|declare|set|begin|commit|rollback|use|print|waitfor)\b/i;
// Statements after which the Explorer's catalog may be out of date.
const CHANGES_SCHEMA = /\b(create|alter|drop|sp_rename|use)\b/i;

const firstLine = (s) => String(s ?? '').split('\n')[0];
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** The activity line under a run: "12 rows · 3 rows affected · 41 ms". */
function summarize(res, limit) {
  const parts = res.sets.map((s) => (s.truncated ? `first ${s.rows.length} rows (the limit is ${limit})` : plural(s.rows.length, 'row')));
  return [[...parts, ...res.messages.filter((m) => /rows? affected$/.test(m)), `${res.ms} ms`].join(' · '), ...res.messages.filter((m) => !/rows? affected$/.test(m))];
}

function Header({ session, tranCount, writesAllowed, file, width, connecting, mood, update }) {
  const segs = [
    { text: `${FACES[mood]} `, color: mood === 'alert' ? theme.warn : theme.accent, bold: true },
    { text: 'Trawl', bold: true },
  ];
  if (update) segs.push({ text: ` ↑ ${update.version}`, color: theme.warn, bold: true });
  if (session) {
    const { conn } = session;
    segs.push({ text: '  │  ', color: theme.border }, { text: conn.name, bold: true });
    segs.push({ text: `  ${describeConn({ ...conn, database: session.database })}`, color: theme.dim });
    if (conn.prod) segs.push({ text: '  ' }, { text: ' PROD ', bg: theme.del, color: theme.ink, bold: true });
    if (isReadOnly(conn)) segs.push({ text: writesAllowed ? '  writes allowed' : '  read-only', color: writesAllowed ? theme.warn : theme.dim });
    if (tranCount) segs.push({ text: '  ' }, { text: ` TRANSACTION OPEN `, bg: theme.warn, color: theme.ink, bold: true });
  } else {
    segs.push({ text: connecting ? '  connecting…' : '  not connected', color: theme.dim });
  }
  // The file path gives way first, keeping its end.
  const full = file ? file.path : '';
  const pathW = Math.min(stringWidth(full), Math.max(0, width - 70));
  const path = pathW < full.length ? `…${full.slice(-(pathW - 1))}` : full;
  return <Row pointer={false} width={width} segments={[...fitSegments(segs, width - pathW - 1), { text: ' ' }, { text: path, color: theme.dim }]} />;
}

function Tabs({ view, results, width }) {
  const segs = [];
  VIEWS.forEach((v, i) => {
    let label = `${i + 1} ${v.label}`;
    if (v.id === 'results' && results?.sets.length > 1) label += ` ${results.sets.length}`;
    const on = v.id === view;
    segs.push({ text: ` ${label} `, bg: on ? theme.accent : undefined, color: on ? theme.ink : theme.dim, bold: on }, { text: ' ' });
  });
  return <Row pointer={false} width={width} segments={segs} />;
}

// The last two results, Claude Code style: "● SELECT …" then "  ⎿  12 rows · 41 ms".
function activityRows(entries) {
  const out = [];
  for (const e of entries.slice(-2)) {
    const color = { error: theme.del, ok: theme.accent, running: theme.dim, info: theme.info }[e.status];
    out.push([{ text: `${BULLET} `, color }, { text: e.title, bold: e.status !== 'info' }]);
    const max = e.status === 'error' ? 3 : 2;
    e.lines.slice(0, max).forEach((l, i) =>
      out.push([{ text: i === 0 ? '  ⎿  ' : '     ', color: theme.dim }, { text: l, color: e.status === 'error' ? theme.del : theme.dim }]),
    );
    if (e.lines.length > max) out.push([{ text: '     ' }, { text: `… +${e.lines.length - max} lines (/last to see all)`, color: theme.dim }]);
  }
  return out.slice(-6);
}

/**
 * `checkLatest({ signal })` looks up the latest release (update.js fetchLatest); without it,
 * as in the tests, Trawl never checks for updates.
 */
export function App({ config: initialConfig, initialFile, initialConnection, checkLatest }) {
  const { exit } = useApp();
  const { columns, rows } = useTerminalSize();
  const [config, setConfigState] = useState(initialConfig);
  const [session, setSessionState] = useState(null);
  const [schema, setSchema] = useState(null);
  const [tranCount, setTranCountState] = useState(0);
  const [writesAllowed, setWritesAllowedState] = useState(false);
  const [results, setResults] = useState(null);
  const [resultIndex, setResultIndexState] = useState(0);
  const [file, setFile] = useState(null);
  const [view, setView] = useState('explorer');
  const [focus, setFocusState] = useState('view');
  const [prompt, setPromptState] = useState({ value: '', cursor: 0 });
  const [sugIndex, setSugIndex] = useState(0);
  const [overlay, setOverlayState] = useState(null);
  const [confirmReq, setConfirmReq] = useState(null);
  const [entries, setEntries] = useState([]);
  const [busy, setBusy] = useState(null);
  const [connecting, setConnecting] = useState(false);
  const [filter, setFilter] = useState('');
  const [welcome, setWelcome] = useState(true);
  const [update, setUpdate] = useState(null);
  // Glim looks happy (or worried) for a few seconds after a result; re-render when that wears off.
  const [, setMoodTick] = useState(0);
  useEffect(() => {
    const t = setTimeout(() => setMoodTick((n) => n + 1), 8100);
    return () => clearTimeout(t);
  }, [entries]);

  // Async actions read the latest state through refs, not through stale closures.
  const sessionRef = useRef(null);
  const schemaRef = useRef(null);
  const tranRef = useRef(0);
  const writesRef = useRef(false);
  const resultsRef = useRef(null);
  const resultIndexRef = useRef(0);
  const fileRef = useRef(null);
  const busyRef = useRef(null);
  const configRef = useRef(config);
  const promptRef = useRef(prompt);
  const confirmRef = useRef(null);
  const focusRef = useRef('view');
  const overlayRef = useRef(null);
  const nextId = useRef(1);
  const historyPos = useRef(-1);
  const lastOutput = useRef(null);

  const setConfig = (update) => {
    const next = update(configRef.current);
    configRef.current = next;
    setConfigState(next);
    saveConfig(next);
  };
  const setSession = (s) => {
    sessionRef.current = s;
    setSessionState(s);
  };
  const setSchemaBoth = (s) => {
    schemaRef.current = s;
    setSchema(s);
  };
  const setTranCount = (n) => {
    tranRef.current = n;
    setTranCountState(n);
  };
  const setWritesAllowed = (on) => {
    writesRef.current = on;
    setWritesAllowedState(on);
  };
  const setResultIndex = (i) => {
    resultIndexRef.current = i;
    setResultIndexState(i);
  };
  const setFocus = (f) => {
    focusRef.current = f;
    setFocusState(f);
  };
  const setOverlay = (next) => {
    overlayRef.current = typeof next === 'function' ? next(overlayRef.current) : next;
    setOverlayState(overlayRef.current);
  };
  const setPrompt = (value, cursor = value.length) => {
    promptRef.current = { value, cursor };
    setPromptState(promptRef.current);
  };

  const addEntry = (e) => {
    const id = nextId.current++;
    setEntries((list) => [...list.slice(-19), { id, lines: [], at: Date.now(), ...e }]);
    return id;
  };
  const updateEntry = (id, patch) => setEntries((list) => list.map((e) => (e.id === id ? { ...e, at: Date.now(), ...patch } : e)));

  const note = (text, status = 'info') => {
    const [title, ...lines] = String(text).split('\n');
    addEntry({ title, status, lines });
  };

  // One thing at a time, with the spinner, esc to cancel, and a line in the activity log.
  // `start(signal)` resolves with the lines to show under the title.
  const task = async (title, start, { label = 'Running', quiet = false } = {}) => {
    if (busyRef.current) {
      note(`Wait for "${busyRef.current.label}" to finish (esc cancels it).`, 'error');
      return { ok: false, error: new Error('busy') };
    }
    const controller = new AbortController();
    const b = { label, started: Date.now(), abort: () => controller.abort() };
    busyRef.current = b;
    setBusy(b);
    const id = quiet ? null : addEntry({ title, status: 'running' });
    if (!quiet && !title.startsWith('connect ')) setWelcome(false);
    try {
      const lines = await start(controller.signal);
      lastOutput.current = { title, text: lines.join('\n') || 'Done' };
      if (id) updateEntry(id, { status: 'ok', lines: lines.length ? lines : ['Done'] });
      return { ok: true };
    } catch (error) {
      const lines = error.cancelled ? ['Cancelled'] : error.message.split('\n');
      lastOutput.current = { title, text: lines.join('\n') };
      if (id) updateEntry(id, { status: 'error', lines });
      else addEntry({ title, status: 'error', lines });
      return { ok: false, error };
    } finally {
      busyRef.current = null;
      setBusy(null);
    }
  };

  const loadSchema = async (s, signal) => {
    const res = await s.run(SCHEMA_SQL, { signal, limit: 1_000_000 });
    const next = buildSchema(res.sets);
    if (sessionRef.current === s) setSchemaBoth(next);
    return next;
  };

  const dropSession = () => {
    const s = sessionRef.current;
    if (s) {
      s.onEnd = null;
      s.close();
    }
    setSession(null);
    setSchemaBoth(null);
    setTranCount(0);
    setWritesAllowed(false);
  };

  const connect = async (conn, { database } = {}) => {
    dropSession();
    setConnecting(true);
    const title = `connect ${conn.name}${database && database !== conn.database ? ` (${database})` : ''}`;
    const r = await task(
      title,
      async (signal) => {
        const s = await openSession(conn, { database, signal });
        s.onEnd = () => {
          if (sessionRef.current !== s) return;
          note(`The connection to ${conn.name} closed.`, 'error');
          setSession(null);
          setSchemaBoth(null);
          setTranCount(0);
        };
        setSession(s);
        const sc = await loadSchema(s, signal);
        return [`${describeConn({ ...conn, database: s.database })} · ${plural(sc.objects.length, 'object')}${isReadOnly(conn) ? ' · read-only' : ''}`];
      },
      { label: `Connecting to ${conn.name}` },
    );
    setConnecting(false);
    if (r.ok) {
      setConfig((c) => ({ ...c, last: conn.name }));
      setView((v) => (v === 'connections' ? 'explorer' : v));
    } else dropSession();
    return r.ok;
  };

  const query = async (sql, { title, wrapped = false, lineBase = 1 } = {}) => {
    const s = sessionRef.current;
    const limit = configRef.current.limit;
    let res = null;
    const r = await task(title, async (signal) => {
      try {
        res = await s.run(sql, { signal, limit });
      } catch (e) {
        if (e.partial) res = { ...e.partial, error: e };
        if (e.line) e.message = `Line ${Math.max(1, lineBase + e.line - 1 - (wrapped ? 1 : 0))}: ${e.message}`;
        throw e;
      }
      return summarize(res, limit);
    });
    if (res) {
      const shown = { id: nextId.current++, title, sql, ...res, error: res.error?.message ?? null };
      resultsRef.current = shown;
      setResults(shown);
      setResultIndex(0);
      if (res.sets.length) setView('results');
    }
    const summary = res && !res.error ? summarize(res, limit)[0] : r.error?.message;
    if (s && sessionRef.current === s) {
      setConfig((c) => withRan(c, { sql, conn: s.conn.name, database: s.database, at: Date.now(), ok: r.ok, summary: firstLine(summary) }));
      const n = await s.tranCount().catch(() => tranRef.current);
      if (n && !tranRef.current && wrapped) note('Started a transaction on production: /commit keeps the change, /rollback undoes it.');
      setTranCount(n);
      if (r.ok && (CHANGES_SCHEMA.test(sql) || s.database !== schemaRef.current?.database)) loadSchema(s).catch(() => {});
    }
    return r;
  };

  const confirm = (req) =>
    new Promise((done) => {
      const full = { options: [{ label: 'Yes', value: true }, { label: 'No', value: false }], ...req, id: nextId.current++, done };
      confirmRef.current = full;
      setConfirmReq(full);
    });
  const onConfirm = (value) => {
    const req = confirmRef.current;
    confirmRef.current = null;
    setConfirmReq(null);
    req?.done(value);
  };

  const prefill = (text, cursor = text.length) => {
    setPrompt(text, cursor);
    setSugIndex(0);
    historyPos.current = -1;
    setFocus('prompt');
  };

  const readFile = (path) => {
    try {
      const text = readFileSync(path, 'utf8');
      return { path, name: basename(path), text, statements: splitStatements(text), mtime: statSync(path).mtimeMs };
    } catch (e) {
      return { path, name: basename(path), text: '', statements: [], error: `Can't read it: ${firstLine(e.message)}` };
    }
  };

  const openFile = (path) => {
    const full = resolve(path);
    const f = readFile(full);
    fileRef.current = f;
    setFile(f);
    setView('query');
    if (f.error) note(`${full}: ${f.error}`, 'error');
  };

  // Reload the open script whenever it changes on disk (an editor saving it).
  useEffect(() => {
    if (!file?.path) return;
    const path = file.path;
    const onChange = (cur, prev) => {
      if (cur.mtimeMs === prev.mtimeMs || fileRef.current?.path !== path) return;
      const f = readFile(path);
      fileRef.current = f;
      setFile(f);
    };
    watchFile(path, { interval: 700 }, onChange);
    return () => unwatchFile(path, onChange);
  }, [file?.path]);

  // Remembers what GitHub said, and returns the release when it's newer than this copy.
  const recordCheck = (latest) => {
    setConfig((c) => ({ ...c, updateCheck: { at: Date.now(), latest } }));
    const newer = latest && isNewer(latest.version, VERSION) ? latest : null;
    setUpdate(newer);
    return newer;
  };

  const checkUpdates = async () => {
    if (!checkLatest) return note('Update checks are off in this copy.');
    let latest = null;
    const r = await task(
      'Check for updates',
      async (signal) => {
        latest = await checkLatest({ signal });
        recordCheck(latest);
        return updateAdvice({ latest, current: VERSION, compiled: COMPILED });
      },
      { label: 'Checking for updates' },
    );
    if (r.ok && latest && isNewer(latest.version, VERSION)) {
      const ok = await confirm({ title: `Open the Trawl ${latest.version} release page in your browser?`, options: [{ label: 'Yes, open it', value: true }, { label: 'No', value: false }] });
      if (ok) openUrl(latest.url);
    }
  };

  const quit = async () => {
    if (!(await a.leaveSession(ctx))) return;
    dropSession();
    exit();
  };

  const ctxRef = useRef(null);
  if (!ctxRef.current) {
    ctxRef.current = {
      get session() {
        return sessionRef.current;
      },
      get schema() {
        return schemaRef.current;
      },
      get config() {
        return configRef.current;
      },
      get tranCount() {
        return tranRef.current;
      },
      get writesAllowed() {
        return writesRef.current;
      },
    };
  }
  const ctx = ctxRef.current;
  Object.assign(ctx, {
    task,
    query,
    connect,
    disconnect: () => {
      const name = sessionRef.current?.conn.name;
      dropSession();
      note(`Disconnected from ${name}.`);
    },
    setConfig,
    setWritesAllowed,
    setResultIndex,
    currentSet: () => resultsRef.current?.sets[resultIndexRef.current] ?? null,
    note,
    confirm,
    prefill,
    openFile,
    setView,
    runFile: () => {
      const f = fileRef.current;
      if (f) a.runSql(ctx, f.text, { title: `${f.name} (whole file)` });
    },
    find: (text) => {
      setFilter(text.trim());
      setView('explorer');
    },
    refresh: () => {
      const s = sessionRef.current;
      if (!s) return note('Not connected.');
      task('Reload the schema', async (signal) => [`${plural((await loadSchema(s, signal)).objects.length, 'object')}`], { label: 'Reading the schema' });
    },
    viewHasKeys: () => focusRef.current === 'view' && !overlayRef.current && !confirmRef.current,
    quit,
    checkUpdates,
    showText: (title, text) => setOverlay({ title, text }),
    showHelp: () => setOverlay({ title: 'Keyboard shortcuts', text: HELP }),
    showLast: () => (lastOutput.current ? setOverlay({ ...lastOutput.current }) : note('Nothing has run yet.')),
  });

  const submit = async (raw) => {
    const text = raw.trim();
    setPrompt('');
    setFocus('view');
    if (!text) return;
    const history = [text, ...(configRef.current.history ?? []).filter((h) => h !== text)].slice(0, 100);
    setConfig((c) => ({ ...c, history }));
    try {
      if (text.startsWith('!')) return await a.runSql(ctx, text.slice(1));
      if (SQL_START.test(text)) return await a.runSql(ctx, text);
      const [, name, rest] = text.replace(/^\//, '').match(/^(\S+)\s*([\s\S]*)$/);
      const cmd = findCommand(name);
      if (!cmd) return note(`Unknown command: /${name}. Type / to see them all.`, 'error');
      await cmd.run(ctx, rest.trim());
    } catch (e) {
      note(firstLine(e.message), 'error');
    }
  };

  // First load: the script given on the command line, and the connection asked for (or the last one).
  useEffect(() => {
    if (initialFile) openFile(initialFile);
    const name = initialConnection ?? initialConfig.last;
    const conn = name && initialConfig.connections.find((c) => c.name === name);
    if (conn) connect(conn);
    else if (!initialFile) setView('connections');
  }, []);

  // At most once a day, in the background: a newer release gets one line in the activity log and
  // a ↑ in the header. A failed check (offline, rate-limited) says nothing and waits a day.
  useEffect(() => {
    if (!checkLatest || checksDisabled(configRef.current)) return;
    const cached = configRef.current.updateCheck;
    const announce = (latest) => note(`Trawl ${latest.version} is out (you have ${VERSION}). /update says how to get it.`);
    const known = cached?.latest && isNewer(cached.latest.version, VERSION) ? cached.latest : null;
    if (known) {
      setUpdate(known);
      announce(known);
    }
    if (!isDue(cached)) return;
    let live = true;
    checkLatest({ signal: AbortSignal.timeout(5000) }).then(
      (latest) => {
        if (!live) return;
        const newer = recordCheck(latest);
        if (newer && newer.version !== known?.version) announce(newer);
      },
      () => live && setConfig((c) => ({ ...c, updateCheck: { at: Date.now(), latest: cached?.latest ?? null } })),
    );
    return () => {
      live = false;
    };
  }, []);

  const lists = { config, schema };
  const suggestions = focus === 'prompt' && !confirmReq ? suggestionsFor(prompt.value, lists) : [];
  const sel = Math.min(sugIndex, Math.max(0, suggestions.length - 1));

  // Line editing in the prompt.
  const promptKeys = (input, key) => {
    const { value, cursor } = promptRef.current;
    const items = suggestionsFor(value, { config: configRef.current, schema: schemaRef.current });
    const pick = items[Math.min(sugIndex, items.length - 1)];
    const edit = (v, c) => {
      setPrompt(v, c);
      setSugIndex(0);
    };
    if (key.ctrl && input === 'c') return value ? edit('', 0) : quit();
    if (key.escape) return setFocus('view');
    if (key.return) {
      if (pick && value.trim() !== pick.insert.trim()) return pick.run ? submit(pick.insert) : edit(pick.insert);
      return submit(value);
    }
    if (key.tab) return pick ? edit(pick.insert) : undefined;
    if (key.upArrow || key.downArrow) {
      if (items.length) return setSugIndex((s) => (s + (key.upArrow ? items.length - 1 : 1)) % items.length);
      const history = configRef.current.history ?? [];
      const pos = Math.max(-1, Math.min(history.length - 1, historyPos.current + (key.upArrow ? 1 : -1)));
      historyPos.current = pos;
      return setPrompt(pos < 0 ? '' : history[pos]);
    }
    if (key.leftArrow) return setPrompt(value, Math.max(0, cursor - 1));
    if (key.rightArrow) return setPrompt(value, Math.min(value.length, cursor + 1));
    // Most terminals send DEL for backspace, which Ink reports as `delete`.
    if (key.backspace || key.delete) {
      if (!value) return setFocus('view');
      if (cursor > 0) edit(value.slice(0, cursor - 1) + value.slice(cursor), cursor - 1);
      return;
    }
    if (key.ctrl && input === 'a') return setPrompt(value, 0);
    if (key.ctrl && input === 'e') return setPrompt(value, value.length);
    if (key.ctrl && input === 'u') return edit(value.slice(cursor), 0);
    if (key.ctrl && input === 'w') {
      const start = value.slice(0, cursor).replace(/\S+\s*$/, '').length;
      return edit(value.slice(0, start) + value.slice(cursor), start);
    }
    if (key.ctrl || key.meta || !input) return;
    const text = input.replace(/[\r\n]+/g, ' ').replace(/[\x00-\x1f\x7f]/g, '');
    if (text) edit(value.slice(0, cursor) + text + value.slice(cursor), cursor + text.length);
  };

  // Keys that work in every view.
  const globalKeys = (input, key) => {
    if (key.escape) {
      if (busyRef.current) busyRef.current.abort();
      else {
        setEntries([]);
        setWelcome(false);
      }
      return;
    }
    if (input === '/' || input === ':') return prefill('/');
    if (input === '!') return prefill('!');
    if (input === '?') return ctx.showHelp();
    if (input === 'q') return quit();
    const n = Number(input);
    if (n >= 1 && n <= VIEWS.length) return setView(VIEWS[n - 1].id);
    if (key.tab) {
      const i = VIEWS.findIndex((v) => v.id === view);
      return setView(VIEWS[(i + (key.shift ? VIEWS.length - 1 : 1)) % VIEWS.length].id);
    }
    if (input === 'r') return ctx.refresh();
  };

  // One dispatcher reading focus from refs, which change the instant focus moves. Handlers that
  // switch on with the next render would let fast typing (or a paste) after "/" leak into the view.
  useInput((input, key) => {
    if (focusRef.current === 'prompt' && !confirmRef.current) return promptKeys(input, key);
    if (key.ctrl && input === 'c') return quit();
    if (confirmRef.current || overlayRef.current) return;
    globalKeys(input, key);
  });

  // Layout: everything is sized to the terminal, one row short of it so Ink never clears the screen.
  const W = columns;
  const H = Math.max(12, rows - 1);
  const act = activityRows(entries);
  const bottom = confirmReq ? confirmHeight(confirmReq) : 3 + suggestions.length;
  const mood = moodFor({ session, busy, lastEntry: entries.at(-1), tranCount });
  // The welcome box only appears when the terminal has room for it next to a useful view.
  const showWelcome = welcome && H >= 28;
  const mainH = Math.max(6, H - 2 - act.length - (busy ? 1 : 0) - bottom - 1 - (showWelcome ? WELCOME_HEIGHT : 0));
  const viewActive = focus === 'view' && !overlay && !confirmReq;

  let main;
  if (overlay) {
    main = <TextViewer {...overlay} width={W} height={mainH} active={focus === 'view' && !confirmReq} onClose={() => setOverlay(null)} />;
  } else if (view === 'connections') {
    main = <ConnectionsView connections={config.connections} current={session?.conn} ctx={ctx} width={W} height={mainH} active={viewActive} />;
  } else if (view === 'query') {
    main = <QueryView file={file} ctx={ctx} width={W} height={mainH} active={viewActive} />;
  } else if (view === 'results') {
    main = <ResultsView results={results} setIndex={resultIndex} ctx={ctx} width={W} height={mainH} active={viewActive} />;
  } else if (view === 'history') {
    main = <HistoryView ran={config.ran} ctx={ctx} width={W} height={mainH} active={viewActive} />;
  } else if (!schema) {
    main = (
      <Panel title="Explorer" width={W} height={mainH}>
        <Text color={theme.dim}>{connecting ? '  Connecting…' : '  Not connected. Press 5 for Connections, or /connect <name>.'}</Text>
      </Panel>
    );
  } else {
    main = <ExplorerView schema={schema} ctx={ctx} width={W} height={mainH} active={viewActive} filter={filter} />;
  }

  const left = focus === 'prompt' ? 'enter run · tab complete · ↑↓ pick or history · esc back' : overlay ? 'j/k scroll · space page · esc close' : HINTS[view];
  const right = focus === 'prompt' ? '' : '  / commands · ! SQL · ? help';

  return (
    <Box flexDirection="column" width={W} height={H}>
      <Header session={session} tranCount={tranCount} writesAllowed={writesAllowed} file={file} width={W} connecting={connecting} mood={mood} update={update} />
      <Tabs view={view} results={results} width={W} />
      <Box height={mainH} width={W}>
        {main}
      </Box>
      {showWelcome ? <Welcome mood={mood} session={session} width={W} /> : null}
      {act.map((segs, i) => (
        <Row key={i} pointer={false} width={W} segments={segs} />
      ))}
      {busy ? <Spinner label={busy.label} started={busy.started} width={W} /> : null}
      {confirmReq ? (
        <Confirm key={confirmReq.id} req={confirmReq} width={W} onDone={onConfirm} />
      ) : (
        <PromptBox value={prompt.value} cursor={prompt.cursor} focused={focus === 'prompt'} width={W} placeholder='Press / for commands, ! to run SQL (try "!SELECT TOP (10) * FROM dbo.Players"), ? for shortcuts' />
      )}
      {suggestions.length ? <Suggestions items={suggestions} selected={sel} width={W} /> : null}
      <Row
        pointer={false}
        width={W}
        segments={[...fitSegments([{ text: `  ${left}`, color: theme.dim }], W - stringWidth(right)), { text: right, color: theme.dim }]}
      />
    </Box>
  );
}
