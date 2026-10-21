import React, { useEffect, useRef, useState } from 'react';
import { Box, Text, useApp, useInput } from 'ink';
import { readFileSync, statSync, unwatchFile, watchFile } from 'node:fs';
import { basename, resolve } from 'node:path';
import * as a from '../actions.js';
import { COMMANDS, findCommand, suggestionsFor } from '../commands.js';
import { loadClaudeHistory, loadConsole, removeConsole, saveConfig, saveConsole, withRan } from '../config.js';
import { freeFile, tabsOf } from '../consoles.js';
import * as ed from '../editor.js';
import { commitMode, describeConn, isReadOnly } from '../connections.js';
import { copyToClipboard } from '../clipboard.js';
import { osCredentials } from '../credentials.js';
import { connect as openSession } from '../db.js';
import { changesText, editTarget, hasChanges, noChanges, readTarget } from '../edit.js';
import { HELP } from '../help.js';
import { commandsSection, sectionFor } from '../help-layout.js';
import { buildSchema } from '../schema.js';
import { dialectOf, qualifiedFor } from '../dialects.js';
import { qualified, splitStatements, statisticsSummary } from '../sql.js';
import { BULLET, theme } from '../theme.js';
import { fitSegments, stringWidth } from '../text.js';
import { useTerminalSize } from './hooks.js';
import { Confirm, Panel, PromptBox, Row, SecretPrompt, Spinner, Suggestions, confirmHeight } from './parts.jsx';
import { ActivityView } from './ActivityView.jsx';
import { ConnectionsView } from './ConnectionsView.jsx';
import { SettingsView } from './SettingsView.jsx';
import { ConsoleView } from './ConsoleView.jsx';
import { ExplorerView } from './ExplorerView.jsx';
import { HistoryView } from './HistoryView.jsx';
import { QueryView } from './QueryView.jsx';
import { ResultsView } from './ResultsView.jsx';
import { HelpView } from './HelpView.jsx';
import { TextViewer } from './TextViewer.jsx';
import { Picker } from './Picker.jsx';
import { WELCOME_HEIGHT, Welcome } from './Glim.jsx';
import { FACES, moodFor } from '../glim.js';
import { checksDisabled, isDue, isNewer, openUrl, updateAdvice } from '../update.js';
import { askClaude as askClaudeCli } from '../ai.js';
import { COMPILED, VERSION } from '../version.js';
import { worthNotifying } from '../notify.js';

const VIEWS = [
  { id: 'explorer', label: 'Explorer' },
  { id: 'query', label: 'Query' },
  { id: 'results', label: 'Results' },
  { id: 'history', label: 'History' },
  { id: 'connections', label: 'Connections' },
  { id: 'activity', label: 'Activity' },
];

// What ? shows: help.js's sections, then the slash commands.
const HELP_SECTIONS = [...HELP, commandsSection(COMMANDS)];

const HINTS = {
  explorer: '↵ first rows · d describe · s query it in the console · c CREATE script · /find filter',
  query: '↵ run statement · v select several · R run file · e edit in the console · /console',
  results: 'h/l columns · o sort · f filter · ↵ record · v value · y/Y copy · F follow key · p pin · c compare · e edit · n NULL · d delete · a add · s save · x export',
  history: '↵ run again · e edit in the console · ◆ ran by Claude',
  connections: '↵ connect · n new · p password · f folder · x forget',
  activity: 'R read again · ↵ full SQL · x kill · a idle sessions too',
};

// Typed at the prompt without "!", these still run as SQL.
const SQL_START = /^(select|with|insert|update|delete|merge|exec|execute|create|alter|drop|truncate|declare|set|begin|commit|rollback|use|print|waitfor)\b/i;
// Statements after which the Explorer's catalog may be out of date.
const CHANGES_SCHEMA = /\b(create|alter|drop|sp_rename|use)\b/i;

const firstLine = (s) => String(s ?? '').split('\n')[0];
// Changes staged in Results: "row:col" → the text typed (null for NULL), and rows to delete.
const NO_CHANGES = noChanges();
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
// What a mouse selection copied: "3 lines", "12 characters". A whole line cut with ctrl+x ends in
// its newline, which doesn't count.
const copiedText = (text) => {
  const t = text.replace(/\n$/, '');
  const n = t.split('\n').length;
  return n > 1 ? `${n} lines` : plural(t.length, 'character');
};

/** The activity line under a run: "12 rows · 3 rows affected · 41 ms". */
// STATISTICS IO and TIME (/stats) send several messages a statement: one line says it all.
function withStatistics(res) {
  const { summary, messages } = statisticsSummary(res.messages ?? []);
  return summary ? { ...res, messages: [summary, ...messages] } : res;
}

function summarize(res, limit) {
  const parts = res.sets.map((s) => (s.truncated ? `first ${s.rows.length} rows (the limit is ${limit})` : plural(s.rows.length, 'row')));
  return [[...parts, ...res.messages.filter((m) => /rows? affected$/.test(m)), `${res.ms} ms`].join(' · '), ...res.messages.filter((m) => !/rows? affected$/.test(m))];
}

// How far installing a newer release has got, after its version in the header.
const UPDATE_STATES = { installing: ' downloading…', installed: ' at next start' };

function Header({ session, tranCount, writesAllowed, file, width, connecting, mood, update }) {
  const segs = [
    { text: `${FACES[mood]} `, color: mood === 'alert' ? theme.warn : theme.accent, bold: true },
    { text: 'Trawl', bold: true },
  ];
  if (update) segs.push({ text: ` ↑ ${update.version}${UPDATE_STATES[update.state] ?? ''}`, color: update.state === 'installed' ? theme.ok : theme.warn, bold: true });
  if (session) {
    const { conn } = session;
    segs.push({ text: '  │  ', color: theme.border }, { text: conn.name, bold: true });
    segs.push({ text: `  ${describeConn({ ...conn, database: session.database })}`, color: theme.dim });
    if (conn.prod) segs.push({ text: '  ' }, { text: ' PROD ', bg: theme.del, color: theme.ink, bold: true });
    if (isReadOnly(conn)) segs.push({ text: writesAllowed ? '  writes allowed' : '  read-only', color: writesAllowed ? theme.warn : theme.dim });
    // DataGrip's "Tx: Manual": writes wait for /commit.
    if (commitMode(conn) === 'manual') segs.push({ text: '  manual commit', color: theme.dim });
    if (tranCount) segs.push({ text: '  ' }, { text: ` TRANSACTION OPEN `, bg: theme.warn, color: theme.ink, bold: true });
    if (session.stats) segs.push({ text: '  stats on', color: theme.dim });
  } else {
    segs.push({ text: connecting ? '  connecting…' : '  not connected', color: theme.dim });
  }
  // The file path gives way first, keeping its end.
  const full = file ? file.path : '';
  const pathW = Math.min(stringWidth(full), Math.max(0, width - 70));
  const path = pathW < full.length ? `…${full.slice(-(pathW - 1))}` : full;
  return <Row pointer={false} width={width} segments={[...fitSegments(segs, width - pathW - 1), { text: ' ' }, { text: path, color: theme.dim }]} />;
}

/** The tabs' labels and the columns each one covers (`from` up to `to`), which clicks are matched against. */
function tabLabels(results) {
  let x = 0;
  return VIEWS.map((v, i) => {
    let label = ` ${i + 1} ${v.label}`;
    if (v.id === 'results' && results?.sets.length > 1) label += ` ${results.sets.length}`;
    label += ' ';
    const from = x;
    x += stringWidth(label) + 1;
    return { id: v.id, label, from, to: from + stringWidth(label) };
  });
}

function Tabs({ view, results, width }) {
  const segs = [];
  for (const t of tabLabels(results)) {
    const on = t.id === view;
    segs.push({ text: t.label, bg: on ? theme.accent : undefined, color: on ? theme.ink : theme.dim, bold: on }, { text: ' ' });
  }
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

const DOUBLE_CLICK_MS = 400;

/**
 * `checkLatest({ signal })` looks up the latest release (update.js fetchLatest), and
 * `installUpdate(version, { signal })` puts it in place of this executable; without them, as in
 * the tests, Trawl never checks for updates or replaces anything. `askClaude({ prompt, signal })` answers /ask
 * (the claude CLI by default) and `findDataSources` feeds /import datagrip (DataGrip's own
 * files by default). `credentials` keeps passwords (the OS store by default) and `open` starts
 * a session (db.js); the tests pass their own. `setTitle(text)` names the terminal window. `mouse` is
 * mouse.js's terminalMouse() from cli.jsx (missing where the terminal can't report it); tests pass their own.
 * `notify(title, body)` says a long run has finished (cli.jsx rings the terminal's bell and raises a
 * notification); without it, as in most tests, nothing is said.
 */
export function App({ config: initialConfig, initialFile, initialConnection, checkLatest, installUpdate, askClaude = askClaudeCli, findDataSources, credentials = osCredentials, open = openSession, clipboard = copyToClipboard, setTitle, mouse, notify }) {
  const { exit } = useApp();
  const { columns, rows } = useTerminalSize();
  const [config, setConfigState] = useState(initialConfig);
  const [session, setSessionState] = useState(null);
  const [schema, setSchema] = useState(null);
  const [tranCount, setTranCountState] = useState(0);
  const [writesAllowed, setWritesAllowedState] = useState(false);
  const [results, setResults] = useState(null);
  // The Activity view's sessions ({ me, sessions, at, conn, error }), read when it opens and on R.
  const [activity, setActivityState] = useState(null);
  const activityRef = useRef(null);
  const [changes, setChangesState] = useState(NO_CHANGES);
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
  // The console's tabs, { name, file, editor, history }: the one on screen lives in editorRef and
  // historyRef below, and goes back into its entry when another tab comes up.
  const tabsRef = useRef(null);
  if (!tabsRef.current) tabsRef.current = tabsOf(initialConfig).map((t) => ({ ...t, editor: null, history: ed.newHistory() }));
  const [tabIndex, setTabIndexState] = useState(() => Math.max(0, Math.min(tabsRef.current.length - 1, Number(initialConfig.consoleTab) || 0)));
  const tabIndexRef = useRef(tabIndex);
  const [editor, setEditorState] = useState(() => ed.fromText(loadConsole(tabsRef.current[tabIndexRef.current].file)));
  const [queryMode, setQueryMode] = useState(initialFile ? 'file' : 'console');
  // How Results shows the set on screen: sorted on a column ({ col, dir }) and narrowed by /filter.
  const [resultView, setResultView] = useState({ sort: null, filter: '' });
  // Glim looks happy (or worried) for a few seconds after a result; re-render when that wears off.
  const [, setMoodTick] = useState(0);
  useEffect(() => {
    const t = setTimeout(() => setMoodTick((n) => n + 1), 8100);
    return () => clearTimeout(t);
  }, [entries]);
  // A word in the bottom line for a moment ("Copied 3 lines"), where it moves nothing on screen.
  const [flash, setFlash] = useState(null);
  useEffect(() => {
    if (!flash) return;
    const t = setTimeout(() => setFlash(null), 3000);
    return () => clearTimeout(t);
  }, [flash]);

  // Async actions read the latest state through refs, not through stale closures.
  const sessionRef = useRef(null);
  const schemaRef = useRef(null);
  const tranRef = useRef(0);
  const writesRef = useRef(false);
  const resultsRef = useRef(null);
  const changesRef = useRef(NO_CHANGES);
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
  const editorRef = useRef(editor);
  // The console's undo history, for this session only (console.sql keeps just the text).
  const historyRef = useRef(ed.newHistory());
  const saveTimer = useRef(null);
  // Passwords typed this session, by connection, so /use and reconnecting don't ask again.
  const typed = useRef(new Map());

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
  const setActivity = (a) => {
    activityRef.current = a;
    setActivityState(a);
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
    if (i !== resultIndexRef.current) setResultView({ sort: null, filter: '' });
    resultIndexRef.current = i;
    setResultIndexState(i);
  };
  const setChanges = (next) => {
    changesRef.current = typeof next === 'function' ? next(changesRef.current) : next;
    setChangesState(changesRef.current);
  };
  // New results replace the grid, and with it any edits not yet saved.
  const showResults = (next) => {
    const pending = changesRef.current;
    if (hasChanges(pending) && next?.id !== resultsRef.current?.id) {
      note(`Dropped ${changesText(pending)} not saved to ${resultsRef.current?.edit?.table?.name ?? 'the table'}.`);
      setChanges(NO_CHANGES);
    }
    if (next?.id !== resultsRef.current?.id) setResultView({ sort: null, filter: '' });
    resultsRef.current = next;
    setResults(next);
  };
  // The console is saved a moment after typing stops, and straight away on quit. Every change to
  // its text is a step ctrl+z can undo; `merge` (typing) joins the keystrokes of a word into one.
  const setConsole = (next, { merge = false, record = true } = {}) => {
    const prev = editorRef.current;
    if (record && next.lines !== prev.lines && ed.toText(next) !== ed.toText(prev)) historyRef.current = ed.record(historyRef.current, prev, { merge });
    editorRef.current = next;
    setEditorState(next);
    clearTimeout(saveTimer.current);
    const { file } = tabsRef.current[tabIndexRef.current];
    saveTimer.current = setTimeout(() => saveConsole(ed.toText(next), file), 400);
  };
  // Writes the tab on screen now, rather than when typing stops.
  const flushConsole = () => {
    clearTimeout(saveTimer.current);
    saveConsole(ed.toText(editorRef.current), tabsRef.current[tabIndexRef.current].file);
  };
  // The tabs' names and files, and which is open, are kept in the config.
  const keepTabs = () => setConfig((c) => ({ ...c, consoleTabs: tabsRef.current.map(({ name, file }) => ({ name, file })), consoleTab: tabIndexRef.current }));
  // Brings tab `i` up in the console. `drop` leaves the one on screen out (it was just closed).
  const showTab = (i, { drop = false } = {}) => {
    if (!drop) {
      flushConsole();
      Object.assign(tabsRef.current[tabIndexRef.current], { editor: editorRef.current, history: historyRef.current });
    } else clearTimeout(saveTimer.current);
    const tab = tabsRef.current[i];
    tab.editor ??= ed.fromText(loadConsole(tab.file));
    tabIndexRef.current = i;
    setTabIndexState(i);
    historyRef.current = tab.history;
    editorRef.current = tab.editor;
    setEditorState(tab.editor);
    keepTabs();
    setQueryMode('console');
    setView('query');
  };
  const stepConsole = (step, nothing) => {
    const r = step(historyRef.current, editorRef.current);
    if (!r) return note(nothing);
    historyRef.current = r.history;
    setConsole(r.editor, { record: false });
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
    // A long run that ends says so, for when you've looked away (Settings' "Notify when done").
    const tell = (lines) => !quiet && notify && worthNotifying(Date.now() - b.started, configRef.current) && notify(`Trawl: ${title}`, lines[0] ?? '');
    try {
      const lines = await start(controller.signal);
      lastOutput.current = { title, text: lines.join('\n') || 'Done' };
      if (id) updateEntry(id, { status: 'ok', lines: lines.length ? lines : ['Done'] });
      tell(lines.length ? lines : ['Done']);
      return { ok: true };
    } catch (error) {
      const lines = error.cancelled ? ['Cancelled'] : error.message.split('\n');
      lastOutput.current = { title, text: lines.join('\n') };
      if (id) updateEntry(id, { status: 'error', lines });
      else addEntry({ title, status: 'error', lines });
      if (!error.cancelled) tell(lines);
      return { ok: false, error };
    } finally {
      busyRef.current = null;
      setBusy(null);
    }
  };

  const loadSchema = async (s, signal) => {
    const res = await s.run(dialectOf(s).schemaSql, { signal, limit: 1_000_000 });
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
    setActivity(null);
  };

  // A login with no password to hand (or a turned-down one) asks for it, then tries again. A
  // typed one (`remember` is then set) that works is kept in the OS store when "keep it" is on.
  const connect = async (conn, { database, password = typed.current.get(conn.name), remember } = {}) => {
    dropSession();
    setConnecting(true);
    const title = `connect ${conn.name}${database && database !== conn.database ? ` (${database})` : ''}`;
    const r = await task(
      title,
      async (signal) => {
        let s;
        try {
          s = await open(conn, { database, signal, password, credentials });
        } catch (e) {
          if (e.needsPassword && password == null && !/login failed/i.test(e.message)) e.message = `${conn.name} needs the password for ${conn.user}.`;
          throw e;
        }
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
    if (r.ok && remember !== undefined) {
      typed.current.set(conn.name, password);
      if (remember) {
        credentials.set(conn.name, { user: conn.user, password }).then(
          () => note(`Saved the password for ${conn.name} in ${credentials.name}.`, 'ok'),
          (e) => note(`Couldn't save the password in ${credentials.name}: ${firstLine(e.message)}`, 'error'),
        );
      }
    }
    // A certificate no authority vouches for (a local SQL Server's own) asks to trust it, as SSMS's
    // "Trust server certificate" does, and once trusted it is kept on the connection (--trust-cert).
    if (!r.ok && r.error?.untrustedCert) {
      const trust = await confirm({
        title: `${conn.name}: the server's certificate can't be verified. Trust it?`,
        detail: `Self-signed, as a local SQL Server's usually is. Trust it only for a server you know: ${conn.server}.`,
        options: [
          { label: 'Yes, trust it and connect (kept on the connection)', value: true },
          { label: 'No', value: false },
        ],
        danger: Boolean(conn.prod),
      });
      if (!trust) return false;
      const trusted = { ...conn, trustCert: true };
      setConfig((c) => ({ ...c, connections: c.connections.map((x) => (x.name === conn.name && !x.demo ? trusted : x)) }));
      return connect(trusted, { database, password, remember });
    }
    if (!r.ok && r.error?.needsPassword) {
      typed.current.delete(conn.name);
      const answer = await a.askPassword(ctx, conn, { failed: /login failed/i.test(r.error.message) });
      return answer ? connect(conn, { database, password: answer.password, remember: answer.remember }) : false;
    }
    return r.ok;
  };

  // `keep` leaves the grid as it is (saving edits shows no rows of its own).
  const query = async (sql, { title, wrapped = false, lineBase = 1, stay = false, keep = false } = {}) => {
    const s = sessionRef.current;
    const limit = configRef.current.limit;
    let res = null;
    const r = await task(title, async (signal) => {
      try {
        res = withStatistics(await s.run(sql, { signal, limit }));
      } catch (e) {
        if (e.partial) res = withStatistics({ ...e.partial, error: e });
        if (e.line) e.message = `Line ${Math.max(1, lineBase + e.line - 1 - (wrapped ? 1 : 0))}: ${e.message}`;
        throw e;
      }
      return summarize(res, limit);
    });
    if (res && !keep) {
      // Whether, and where, the rows can be edited and saved back (edit.js).
      const sc = schemaRef.current;
      const why = res.error ? { reason: 'the statement failed' } : sc?.database !== s.database ? { reason: 'the schema is still loading' } : null;
      // Saving edits writes T-SQL; following keys works everywhere.
      const native = dialectOf(s).kind === 'sqlserver';
      const edit = why ?? (native ? editTarget(sql, res.sets, sc) : { reason: `saving edits is for SQL Server only, and this is ${dialectOf(s).label}` });
      // Which table the rows are, for following a foreign key from a cell (F).
      const source = why ?? (edit.table ? { table: edit.table, columns: edit.columns } : readTarget(sql, res.sets, sc));
      const shown = { id: nextId.current++, title, sql, ...res, error: res.error?.message ?? null, edit, source, conn: s.conn.name, database: s.database };
      showResults(shown);
      setResultIndex(0);
      if (res.sets.length && !stay) setView('results');
    }
    const summary = res && !res.error ? summarize(res, limit)[0] : r.error?.message;
    if (s && sessionRef.current === s) {
      setConfig((c) => withRan(c, { sql, conn: s.conn.name, database: s.database, at: Date.now(), ok: r.ok, summary: firstLine(summary) }));
      const n = await s.tranCount().catch(() => tranRef.current);
      if (n && !tranRef.current && wrapped) note(`Started a transaction (${s.conn.name} commits manually): /commit keeps the change, /rollback undoes it.`);
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
  // The answer's key reaches App's own dispatcher after the Confirm's: the question stays in the ref
  // until then, or a digit answering it would also switch views.
  const onConfirm = (value) => {
    const req = confirmRef.current;
    queueMicrotask(() => confirmRef.current === req && (confirmRef.current = null));
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
    setQueryMode('file');
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
    return latest && isNewer(latest.version, VERSION) ? latest : null;
  };

  // Installing a newer release in place of this executable (only the downloaded Trawl has
  // installUpdate). `installing` is { version, done } while one is under way or once it's in.
  const installing = useRef(null);
  const install = async (latest, signal) => {
    installing.current = { version: latest.version, done: false };
    setUpdate({ ...latest, state: 'installing' });
    try {
      await installUpdate(latest.version, { signal });
      installing.current.done = true;
      setUpdate({ ...latest, state: 'installed' });
    } catch (e) {
      installing.current = null;
      setUpdate({ ...latest, state: 'out' });
      throw e;
    }
  };

  // A newer release found by the daily check: installed in the background, without the spinner
  // (nothing waits on it, and it only counts from the next start), unless "autoUpdate" is false.
  const offerUpdate = (latest) => {
    const out = (why = '') => note(`Trawl ${latest.version} is out (you have ${VERSION})${why}. /update says how to get it.`, why ? 'error' : 'info');
    if (!installUpdate || configRef.current.autoUpdate === false) {
      setUpdate({ ...latest, state: 'out' });
      return out();
    }
    if (installing.current) return;
    install(latest).then(
      () => note(`Trawl ${latest.version} is installed. It starts the next time you open Trawl.`, 'ok'),
      (e) => out(`, but it couldn't be installed: ${firstLine(e.message)}`),
    );
  };

  // /update: checks now and, in the downloaded Trawl, installs a newer release (whatever
  // "autoUpdate" says, since you asked); otherwise says how to get it.
  const checkUpdates = async () => {
    if (!checkLatest) return note('Update checks are off in this copy.');
    let newer = null;
    const r = await task(
      'Check for updates',
      async (signal) => {
        const latest = await checkLatest({ signal });
        newer = recordCheck(latest);
        if (newer && installUpdate) return [`Trawl ${newer.version} is out (you have ${VERSION}).`];
        if (newer) setUpdate({ ...newer, state: 'out' });
        return updateAdvice({ latest, current: VERSION, compiled: COMPILED });
      },
      { label: 'Checking for updates' },
    );
    if (!r.ok || !newer) return;
    if (installUpdate) {
      const now = installing.current;
      if (now?.version === newer.version) return note(now.done ? `Trawl ${newer.version} is installed already. It starts the next time you open Trawl.` : `Trawl ${newer.version} is downloading in the background.`);
      if (now && !now.done) return note(`Wait for Trawl ${now.version} to finish downloading.`, 'error');
      return task(
        `install Trawl ${newer.version}`,
        async (signal) => {
          try {
            await install(newer, signal);
          } catch (e) {
            if (signal.aborted) e.cancelled = true;
            else e.message = [firstLine(e.message), ...updateAdvice({ latest: newer, current: VERSION, compiled: true }).slice(1)].join('\n');
            throw e;
          }
          return ['It starts the next time you open Trawl.'];
        },
        { label: `Downloading Trawl ${newer.version}` },
      );
    }
    const ok = await confirm({ title: `Open the Trawl ${newer.version} release page in your browser?`, options: [{ label: 'Yes, open it', value: true }, { label: 'No', value: false }] });
    if (ok) openUrl(newer.url);
  };

  const quit = async () => {
    if (!(await a.leaveSession(ctx))) return;
    flushConsole();
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
      // The console's latest text; a getter here, since Object.assign below would copy a value.
      get console() {
        return editorRef.current;
      },
      get results() {
        return resultsRef.current;
      },
      // The console's tabs: { names, index }.
      get consoleTabs() {
        return { names: tabsRef.current.map((t) => t.name), index: tabIndexRef.current };
      },
      // Edits staged in Results, not yet saved.
      get changes() {
        return changesRef.current;
      },
      get activity() {
        return activityRef.current;
      },
      // What useMouse registers: the component on screen takes the main area's clicks and wheel.
      mouseHandlers: [],
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
    setActivity,
    setWritesAllowed,
    setResultIndex,
    // o in Results: by this column, A to Z, then Z to A, then as the server sent them.
    sortResults: (col) =>
      setResultView((v) => ({ ...v, sort: v.sort?.col !== col ? { col, dir: 1 } : v.sort.dir > 0 ? { col, dir: -1 } : null })),
    filterResults: (text) => {
      if (!resultsRef.current) return note('Run a query first: there is nothing to filter.', 'error');
      setResultView((v) => ({ ...v, filter: text.trim() }));
      setView('results');
    },
    currentSet: () => resultsRef.current?.sets[resultIndexRef.current] ?? null,
    // A session of its own on another connection (fan-out, schema diff); the caller closes it.
    openSession: (conn, opts = {}) => open(conn, { credentials, password: typed.current.get(conn.name), ...opts }),
    // Results that didn't come from running SQL on this session: fan-out's merged rows, a comparison.
    present: (res) => {
      showResults({ id: nextId.current++, error: null, messages: [], ...res });
      setResultIndex(0);
      setView('results');
    },
    // A line in History for SQL that ran somewhere other than this session.
    recordRun: (entry) => setConfig((c) => withRan(c, entry)),
    note,
    confirm,
    // A password field in place of the prompt: resolves { value, remember } or null.
    askSecret: (req) => confirm({ ...req, secret: true, options: [] }),
    // A line of text in the same place, shown as typed: resolves the text, or null on esc.
    askText: async (req) => (await confirm({ ...req, secret: true, plain: true, options: [] }))?.value ?? null,
    credentials,
    // Whether this terminal can report the mouse at all (Settings says so).
    mouseAvailable: Boolean(mouse),
    // Puts text on the clipboard and says so; `what` is "the cell", "12 rows as CSV"…
    copy: async (text, what) => {
      try {
        const via = await clipboard(text);
        note(`Copied ${what}${via === 'terminal' ? ' (through the terminal, which has to allow it)' : ''}.`, 'ok');
      } catch (e) {
        note(`Couldn't copy: ${firstLine(e.message)}`, 'error');
      }
    },
    // Text selected with the mouse (the console's SQL), or cut with ctrl+x: copied, and said for a
    // moment in the bottom line.
    copySelection: (text, verb = 'Copied') =>
      Promise.resolve(clipboard(text)).then(
        () => setFlash({ text: `${verb} ${copiedText(text)}` }),
        (e) => note(`Couldn't copy: ${firstLine(e.message)}`, 'error'),
      ),
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
    editorHasKeys: () => focusRef.current === 'editor' && !overlayRef.current && !confirmRef.current,
    setConsole,
    undoConsole: () => stepConsole(ed.undo, 'Nothing to undo.'),
    showConsoleTab: (i) => showTab(i),
    // A new, empty tab after the others, on screen.
    addConsoleTab: (name) => {
      const tabs = tabsRef.current;
      const file = freeFile(tabs, name);
      saveConsole('', file);
      tabs.push({ name, file, editor: ed.fromText(''), history: ed.newHistory() });
      showTab(tabs.length - 1);
    },
    // Closes the tab on screen, and its file goes; the one before it comes up.
    closeConsoleTab: () => {
      const tabs = tabsRef.current;
      const i = tabIndexRef.current;
      const [gone] = tabs.splice(i, 1);
      removeConsole(gone.file);
      showTab(Math.max(0, i - 1), { drop: true });
    },
    renameConsoleTab: (name) => {
      tabsRef.current[tabIndexRef.current].name = name;
      keepTabs();
    },
    redoConsole: () => stepConsole(ed.redo, 'Nothing to redo.'),
    // Stopping waits until this key has been handled everywhere, so the esc (or ctrl+c) that
    // ends typing isn't also taken as a global key: clear the log, or quit.
    setEditing: (on) => (on ? setFocus('editor') : queueMicrotask(() => focusRef.current === 'editor' && setFocus('view'))),
    // Typing into a cell in Results is a focus of its own too, with the same microtask on the way out.
    setCellEditing: (on) => (on ? setFocus('cell') : queueMicrotask(() => focusRef.current === 'cell' && setFocus('view'))),
    cellHasKeys: () => focusRef.current === 'cell' && !overlayRef.current && !confirmRef.current,
    setChanges,
    // After a save: the grid shows the rows as they now are, and nothing is pending.
    replaceResults: (next) => {
      setChanges(NO_CHANGES);
      showResults(next);
    },
    showConsole: () => {
      setQueryMode('console');
      setView('query');
    },
    // Puts SQL into the console to edit, after what's there, and starts typing.
    editInConsole: (sql, { atEnd = false } = {}) => {
      let next = ed.append(editorRef.current, sql);
      if (atEnd) next = ed.lineEnd({ ...next, row: next.lines.length - 1 });
      setConsole(next);
      setQueryMode('console');
      setView('query');
      setFocus('editor');
    },
    startQuery: (obj) => {
      const d = dialectOf(sessionRef.current);
      if (d.kind !== 'sqlserver') return ctx.editInConsole(`SELECT *\nFROM ${qualifiedFor(d, obj.schema, obj.name)}\nWHERE \nLIMIT 100`, { atEnd: true });
      return ctx.editInConsole(`SELECT TOP (100) *\nFROM ${qualified(obj.schema, obj.name)}\nWHERE `, { atEnd: true });
    },
    quit,
    checkUpdates,
    askClaude,
    findDataSources,
    showText: (title, text, extra = {}) => setOverlay({ title, text, ...extra }),
    // A list to pick from (Picker.jsx): { title, hint, items, keys, empty }.
    showPicker: (picker) => setOverlay({ picker }),
    closeOverlay: () => setOverlay(null),
    rememberOutput: (title, text) => (lastOutput.current = { title, text }),
    // On the section for the view on screen (the Query tab's console or file).
    showHelp: () => setOverlay({ help: true, start: sectionFor(HELP_SECTIONS, view === 'query' ? queryMode : view) }),
    showSettings: () => setOverlay({ settings: true }),
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

  // At most once a day, in the background: a newer release gets a ↑ in the header and is installed
  // (offerUpdate). A failed check (offline, rate-limited) says nothing and waits a day.
  useEffect(() => {
    if (!checkLatest || checksDisabled(configRef.current)) return;
    const cached = configRef.current.updateCheck;
    const known = cached?.latest && isNewer(cached.latest.version, VERSION) ? cached.latest : null;
    if (known) offerUpdate(known);
    if (!isDue(cached)) return;
    let live = true;
    checkLatest({ signal: AbortSignal.timeout(5000) }).then(
      (latest) => {
        if (!live) return;
        const newer = recordCheck(latest);
        if (newer && newer.version !== known?.version) offerUpdate(newer);
      },
      () => live && setConfig((c) => ({ ...c, updateCheck: { at: Date.now(), latest: cached?.latest ?? null } })),
    );
    return () => {
      live = false;
    };
  }, []);

  // The terminal's title says where you are: "Trawl · funds/fundsdb · PROD".
  const windowTitle = session ? `Trawl · ${session.conn.name}/${session.database ?? session.conn.database ?? ''}${session.conn.prod ? ' · PROD' : ''}`.replace(/\/$/, '') : 'Trawl';
  useEffect(() => {
    setTitle?.(windowTitle);
  }, [windowTitle]);

  // Leaving the console stops typing, so keys never go to an editor that isn't on screen.
  useEffect(() => {
    if ((view !== 'query' || queryMode !== 'console') && focusRef.current === 'editor') setFocus('view');
    if (view !== 'results' && focusRef.current === 'cell') setFocus('view');
  }, [view, queryMode]);

  const lists = { config, schema, conn: session?.conn.name, tabs: tabsRef.current.map((t) => t.name) };
  const suggestions = focus === 'prompt' && !confirmReq ? suggestionsFor(prompt.value, lists) : [];
  const sel = Math.min(sugIndex, Math.max(0, suggestions.length - 1));

  // Line editing in the prompt.
  const promptKeys = (input, key) => {
    const { value, cursor } = promptRef.current;
    const items = suggestionsFor(value, { config: configRef.current, schema: schemaRef.current, conn: sessionRef.current?.conn.name, tabs: tabsRef.current.map((t) => t.name) });
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
    // ctrl+r is the console's run key, not r for refresh; no other global key takes ctrl or alt.
    if (key.ctrl || key.meta) return;
    // A .sql or .txt file dropped on the terminal (which types its path) opens in a console tab.
    if (input.length > 1 && a.openDropped(ctx, input)) return;
    if (input === '/' || input === ':') return prefill('/');
    if (input === '!') return prefill('!');
    if (input === '?') return ctx.showHelp();
    if (input === ',') return ctx.showSettings();
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
    // While typing in the console or a cell, every key is text (their own handlers take them).
    if (focusRef.current === 'editor' || focusRef.current === 'cell') return;
    if (focusRef.current === 'prompt' && !confirmRef.current) return promptKeys(input, key);
    if (key.ctrl && input === 'c') return quit();
    if (confirmRef.current || overlayRef.current) return;
    globalKeys(input, key);
  });

  // The terminal reports the mouse while the setting is on (it is unless set off).
  useEffect(() => {
    mouse?.enable(config.mouse !== false);
  }, [config.mouse]);

  // Where things were drawn, for matching clicks against (set as the layout below is worked out).
  const layout = useRef(null);
  const lastPress = useRef(null);
  // The component under a point of the main area (`y` counted from its top), and that `y` in it.
  const mouseTarget = (y) => {
    const target = ctx.mouseHandlers.findLast((h) => h.top <= y);
    return target && { target, y: y - target.top };
  };
  const onMouse = (e) => {
    if (e.type === 'copy') return setFlash({ text: `Copied ${copiedText(e.text)}` });
    if (e.button === 'left' && !e.release && !e.drag) {
      const prev = lastPress.current;
      const now = Date.now();
      const count = prev && prev.x === e.x && prev.y === e.y && now - prev.at < DOUBLE_CLICK_MS ? prev.count + 1 : 1;
      e.double = count === 2;
      e.triple = count === 3;
      // A fourth click starts over rather than counting on.
      lastPress.current = count < 3 ? { x: e.x, y: e.y, at: now, count } : null;
    } else if (!e.drag && e.button !== 'wheel') return;
    // A confirmation's options (and a password field) take keys only.
    if (confirmRef.current || !layout.current) return;
    const { mainTop, mainH, promptTop, sugCount, tabs } = layout.current;
    if (e.drag) {
      // A drag the component it started in takes itself (claimDrags below): the console selecting SQL.
      const hit = mouseTarget(e.from.y - mainTop);
      if (!hit) return;
      if (focusRef.current === 'prompt') setFocus('view');
      return hit.target.handle({ ...e, y: e.y - mainTop - hit.target.top, from: { x: e.from.x, y: hit.y } });
    }
    if (e.y === mainTop - 1 && !e.wheel) {
      const tab = tabs.find((t) => e.x >= t.from && e.x < t.to);
      if (!tab) return;
      // Whatever is open over the view closes: a click on a tab should never do nothing.
      if (overlayRef.current) setOverlay(null);
      if (focusRef.current === 'prompt') setFocus('view');
      return setView(tab.id);
    }
    if (e.y >= mainTop && e.y < mainTop + mainH) {
      // Like esc, a click on the view leaves the prompt's text for later.
      if (!e.wheel && focusRef.current === 'prompt') setFocus('view');
      const hit = mouseTarget(e.y - mainTop);
      return hit?.target.handle({ ...e, y: hit.y });
    }
    if (e.wheel) return;
    if (e.y >= promptTop && e.y < promptTop + 3) {
      // The text starts after the border, the padding and "> ", scrolled as PromptBox scrolls it.
      const { value, cursor } = promptRef.current;
      const inner = columns - 6;
      const start = focusRef.current === 'prompt' ? Math.max(0, cursor - inner + 1) : 0;
      setPrompt(value, Math.max(0, Math.min(value.length, start + e.x - 4)));
      return setFocus('prompt');
    }
    const sug = e.y - promptTop - 3;
    if (sug >= 0 && sug < sugCount) {
      setSugIndex(sug);
      // As ↵ would, on the suggestion under the pointer.
      if (e.double) promptKeys('', { return: true });
    }
  };
  const mouseRef = useRef(onMouse);
  mouseRef.current = onMouse;
  useEffect(() => mouse?.subscribe((e) => mouseRef.current(e)), [mouse]);
  // Drags that start where the component on screen selects for itself skip the screen selection.
  useEffect(
    () =>
      mouse?.claimDrags?.((e) => {
        const at = layout.current;
        if (confirmRef.current || !at || e.y < at.mainTop || e.y >= at.mainTop + at.mainH) return false;
        const hit = mouseTarget(e.y - at.mainTop);
        return Boolean(hit?.target.drags?.({ ...e, y: hit.y }));
      }),
    [mouse],
  );

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
  layout.current = {
    mainTop: 2,
    mainH,
    promptTop: 2 + mainH + (showWelcome ? WELCOME_HEIGHT : 0) + act.length + (busy ? 1 : 0),
    sugCount: suggestions.length,
    tabs: tabLabels(results),
  };

  let main;
  // An overlay closes on a key (esc, q) once every handler has had it: App's dispatcher runs after the
  // overlay's, and would otherwise see no overlay and take q as quit.
  const closeOnKey = () => queueMicrotask(() => setOverlay(null));
  if (overlay?.settings) {
    // Over whichever view is open; ↵ on the row limit hands over to the prompt, and the overlay stays.
    const settingsActive = focus === 'view' && !confirmReq;
    main = <SettingsView config={config} ctx={ctx} updates={{ check: Boolean(checkLatest), install: Boolean(installUpdate) }} update={update} width={W} height={mainH} active={settingsActive} onClose={closeOnKey} />;
  } else if (overlay?.help) {
    main = <HelpView sections={HELP_SECTIONS} start={overlay.start} ctx={ctx} width={W} height={mainH} active={focus === 'view' && !confirmReq} onClose={closeOnKey} />;
  } else if (overlay?.picker) {
    main = <Picker {...overlay.picker} ctx={ctx} width={W} height={mainH} active={focus === 'view' && !confirmReq} onClose={closeOnKey} />;
  } else if (overlay) {
    main = <TextViewer {...overlay} ctx={ctx} width={W} height={mainH} active={focus === 'view' && (!confirmReq || confirmReq.scrollsOverlay)} pageOnly={Boolean(confirmReq)} onClose={closeOnKey} />;
  } else if (view === 'connections') {
    main = <ConnectionsView connections={config.connections} current={session?.conn} ctx={ctx} width={W} height={mainH} active={viewActive} />;
  } else if (view === 'query' && queryMode === 'console') {
    // Results go under the console when there's room, so a run doesn't take you away from it.
    const under = results?.sets.length && mainH >= 18 ? Math.floor(mainH * 0.45) : 0;
    const editing = focus === 'editor';
    main = (
      <Box flexDirection="column" width={W} height={mainH}>
        <ConsoleView editor={editor} tabs={tabsRef.current.map((t) => t.name)} tab={tabIndex} editing={editing} ctx={ctx} width={W} height={mainH - under} active={(viewActive || editing) && !overlay && !confirmReq} />
        {under ? <ResultsView results={results} changes={changes} setIndex={resultIndex} view={resultView} ctx={ctx} width={W} height={under} top={mainH - under} active={false} /> : null}
      </Box>
    );
  } else if (view === 'query') {
    main = <QueryView file={file} ctx={ctx} width={W} height={mainH} active={viewActive} />;
  } else if (view === 'results') {
    main = <ResultsView results={results} changes={changes} setIndex={resultIndex} view={resultView} ctx={ctx} width={W} height={mainH} active={viewActive || (focus === 'cell' && !confirmReq)} />;
  } else if (view === 'activity') {
    main = <ActivityView activity={activity} session={session} ctx={ctx} width={W} height={mainH} active={viewActive} />;
  } else if (view === 'history') {
    // Claude's queries come from trawl mcp's log, read each time the tab draws (it's small).
    const ran = [...config.ran, ...loadClaudeHistory()].sort((x, y) => y.at - x.at);
    main = <HistoryView ran={ran} ctx={ctx} width={W} height={mainH} active={viewActive} />;
  } else if (!schema) {
    main = (
      <Panel title="Explorer" width={W} height={mainH}>
        <Text color={theme.dim}>{connecting ? '  Connecting…' : '  Not connected. Press 5 for Connections, or /connect <name>.'}</Text>
      </Panel>
    );
  } else {
    main = <ExplorerView schema={schema} ctx={ctx} width={W} height={mainH} active={viewActive} filter={filter} />;
  }

  const left = flash
    ? flash.text
    : confirmReq?.plain
    ? 'type the value · ↵ done · esc cancel'
    : confirmReq?.secret
    ? 'type the password (shown as *) · ↵ done · esc cancel'
    : focus === 'prompt'
      ? 'enter run · tab complete · ↑↓ pick or history · esc back'
      : focus === 'editor'
        ? 'typing SQL · tab take a suggestion · shift+arrows select · ctrl+r run the statement (or selection) · esc stop typing'
        : focus === 'cell'
          ? 'editing the cell · ↵ keep it (s saves) · tab next column · esc leave it as it was · ctrl+u clear'
          : overlay?.settings
          ? 'j/k move · ↵ or space change it · esc close'
          : overlay?.help
          ? 'j/k section · space scroll · / search · esc close'
          : overlay?.picker
          ? `j/k move · ${overlay.picker.hint} · esc close`
          : overlay
          ? 'j/k scroll · space page · esc close'
          : view === 'query' && queryMode === 'console'
            ? '↵/i type · ctrl+r run statement · R run all · /save <file> · /open <file>'
            : HINTS[view];
  const right = focus === 'prompt' || focus === 'editor' || focus === 'cell' || confirmReq?.secret ? '' : '  / commands · ! SQL · ? help';

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
      {confirmReq?.secret ? (
        <SecretPrompt key={confirmReq.id} req={confirmReq} width={W} onDone={onConfirm} />
      ) : confirmReq ? (
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
