# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Trawl is a keyboard-driven SQL Server client for the terminal, built with Ink (React for the terminal) on Node 22+. It is Tiller's sibling (`C:\Team\Tiller`, a git client): the shared pieces (`text.js`, `ui/parts.jsx`, `ui/hooks.js`, the jsx loader, the build script, the prompt and activity log in `App.jsx`) were copied from there and should stay recognisably the same. Plain JavaScript ES modules with `.jsx` for components; no TypeScript, no linter config. The README is the user-facing spec; when behaviour changes, update it too.

## Commands

```bash
npm test                                                       # whole suite (node:test)
node --import ./src/register.js --test test/sql.test.js        # one file
node --import ./src/register.js --test --test-name-pattern="WHERE" test/*.test.js   # tests matching a name
npm run demo                                                   # run against the in-memory demo (needs a real TTY)
node bin/trawl.js query.sql --connect club-a                  # open a script on a saved connection
npm run build                                                  # Bun-compiled executable for this machine → dist/
node scripts/logo.js                                           # regenerate assets/ from src/glim.js
```

`--import ./src/register.js` is required whenever Node loads `.jsx`: it installs a module hook (`src/jsx-hooks.js`) that compiles `.jsx` with esbuild on import. There is no dev build step. CI runs `npm test` on Linux and Windows, so path handling and line endings must work on both (`.gitattributes` forces LF).

Releases are automatic, as in Tiller: every push to main (except Markdown-only ones) runs the Release workflow, which publishes the latest release's version with the patch raised, or `package.json`'s version when that's higher (bump it there for minor or major). It sets the version in the runner before building and commits nothing back, so `package.json` on main lags behind the releases. Compiled builds get the version via `process.env.TRAWL_VERSION` (defined by `scripts/build.js`), which also sets `COMPILED`; from a checkout `src/version.js` reads `package.json`, and the update check is skipped.

## Architecture

The layering, bottom to top:

- **`src/sql.js`**: pure T-SQL text handling, where most tests point. `mask()` blanks comments, strings and quoted names while keeping offsets, and everything else works on the mask: `splitBatches` (GO), `splitStatements` (the Query view's units), `classify`/`classifyScript` (is it a write, and which statements are dangerous), value formatting, CSV/JSON.
- **`src/db.js`**: the only place queries reach a server, through tedious. A session is one connection, like an SSMS tab, so transactions and temp tables carry over between runs. `runScript` splits on GO and collects `{ sets, messages, stopped, ms }`; errors are `DbError` with the server's number, the line in the whole script, and `partial` results. Hitting the row limit cancels the request on purpose (`stopped`).
- **`src/demo.js`**: an in-memory session with the same interface, used by `--demo` and the tests. Anything new a session must do needs both drivers.
- **`src/connections.js`**: `/add` parsing, tedious options, and `connectionRows` (the Connections list grouped by `folder`, as DataGrip does). **config.json never holds a secret**: Azure SQL tokens come from `az` (`src/azure.js`, which calls az's Python directly on Windows, as Tiller does), and SQL login passwords live in the OS credential store.
- **`src/credentials.js`**: that store, reached through tools the OS already has, never a native module (the Bun build must keep working): PowerShell P/Invoking Credential Manager on Windows, `security` on macOS, `secret-tool` on Linux. Secrets cross on stdin/stdout, not argv (except macOS's `security`). Lookups take over a second on Windows, so they're cached per process. `db.connect` finds a password as: the one passed in, the connection's `passwordEnv` variable, the store; a missing one, or a stored or typed one the server turns down, is a `DbError` with `needsPassword`, and `App`'s `connect` then asks (`ctx.askSecret`, a masked field in the confirm slot) and saves it only once it has signed in. Tests use `memoryCredentials()` and App's `open`/`credentials` props.
- **`src/schema.js`**: `SCHEMA_SQL` reads the catalog in one batch; `buildSchema` shapes it into `{ database, databases, objects }` for the Explorer, completion and `/describe`.
- **`src/actions.js`**: every user-facing operation, written once; keys and slash commands call these with `ctx`. The safety rules live in `runSql`: read-only refusal, the danger confirmation, and wrapping writes in `BEGIN TRANSACTION` when the connection commits manually (`commitMode`: `conn.commit`, else manual for production, as DataGrip's Tx: Auto/Manual; `/tx` changes it).
- **`src/edit.js`**: editing results in place, pure. `editTarget(sql, sets, schema)` decides whether a result is the rows of one table with its primary key (reading the mask: one SELECT, one table in FROM, which select-list items are plain columns) and returns `{ table, keys, columns }` or `{ reason }`; `App.query` stores it on the results as `edit`. Changes are staged in App (`ctx.changes`: `"row:col"` → text or null, and rows to delete) and `saveScript` turns them into one TRY/CATCH batch inside a savepoint, where every statement must hit exactly one row whose changed columns still hold what was read. `saveEdits` runs it through `runSql` with `keep` (the grid stays). The demo recognises the batch by its `-- trawl:edit` marker and only counts rows. Typing into a cell is focus `'cell'`, handled like the console's `'editor'`.
- **`src/commands.js`**: the slash-command table and completion, same shape as Tiller's.
- **`src/ui/App.jsx`**: layout, focus, the prompt, overlays, the activity log, the open script's file watcher, and **`ctx`**. `ctx.query` runs SQL visibly (spinner, esc cancels, history, transaction count afterwards); read the `Object.assign(ctx, {...})` block before adding an action. Live values are getters in the object created once above it (`session`, `schema`, `console`, …): `Object.assign` would copy a getter's value, not the getter. It names the terminal window through the `setTitle` prop, which `cli.jsx` writes as an OSC sequence (and restores on exit); tests pass a recorder or nothing.
- **The console** (`src/editor.js`, `src/ui/ConsoleView.jsx`): the Query tab's SQL editor. Editing is pure functions over `{ lines, row, col }`; the component only maps keys to them. Typing is its own focus, `'editor'`: App's dispatcher ignores every key then, and `ctx.setEditing(false)` waits a microtask so the esc that stops typing isn't also a global key. Key handlers must edit `ctx.console` (the latest text), never the render's `editor` prop, or fast typing loses keys. Its text is saved to `console.sql` beside the config. Suggestions while typing come from `src/complete.js` (pure): `completeAt(editor, schema)` reads the mask around the cursor (the word, a `x.` qualifier, the keyword before it) and `tablesIn` the statement's FROM/JOIN aliases; the view only keeps `{ index, force, moved }` and works the list out again from `ctx.console` on every key, and draws it over the text rows below the cursor.
- **`src/ui/*View.jsx`**: one component per tab. Views must check `ctx.viewHasKeys()` at the start of their `useInput` handlers so keys don't fire while the prompt, an overlay or a confirm has focus. `useListNav` in `src/ui/hooks.js` is the shared cursor/scroll logic.

Claude (`src/ai.js`, `src/mcp.js`): a connection's `ai` level (`off` / `schema` / `results`, default `schema`) decides what Claude may see, and both the MCP server and `/ask` check it. `trawl mcp` is a hand-rolled JSON-RPC server over stdio (no SDK): stdout carries only protocol messages, so log to stderr. It reads config fresh per call, queues requests per connection (Claude calls tools in parallel; a session runs one request at a time), refuses anything `classifyScript` flags as a write, and wraps reads in a transaction it rolls back. It logs to `claude-history.jsonl`, never config.json, because it runs beside the app as a separate process.

DataGrip import (`src/datagrip.js`): brings each data source's DataGrip folder (`group`) across as `folder`, and files existing folderless connections on re-import (`plan.file`). It reads `DataGripProjects/*/.idea/dataSources(.local).xml`, `JetBrains/DataGrip*/options`, and `JetBrains/DataGrip*/dataSourcesHistory/*/data_sources_history.xml` (where recent DataGrip versions keep most data sources), newest version first, one entry per uuid. It parses with regexes, not an XML library: the files are machine-written and flat. Never touch `c.kdbx` / `c.pwd` (DataGrip's encrypted passwords); SQL logins are asked for their password on first connect instead. Imported names keep off the demo connections' names, which `--demo` would otherwise hide and then drop on save.

Updates (`src/update.js`): the only network call besides the database. Once a day `App` asks for the latest release and, in the downloaded build, installs a newer one in the background, as Tiller does (`installUpdate`: download next to the executable, check `SHA256SUMS.txt`, swap by renaming; on Windows the running exe is renamed aside and `removeOldExecutables` deletes it on a later start). `"autoUpdate": false` only announces it. Release file names must match `TARGETS` in `scripts/build.js`. `App` receives `checkLatest` and `installUpdate` from `cli.jsx`, only in compiled builds; tests pass fakes (or nothing, which turns checks off), so the suite never reaches GitHub or replaces anything.

Glim (`src/glim.js`, `src/ui/Glim.jsx`): the anglerfish mascot's pixel art and mood-from-session logic, as Tiller's Knot. `assets/` is generated from it by `scripts/logo.js`; don't hand-edit those files. The accent is blue (`theme.accent`, also Glim's outline).

Theme and text: use `BULLET` instead of `⏺` (Windows draws it wide), and `src/text.js` (`fit`, `fitSegments`, `stringWidth`) for width-aware truncation, never `.length`.

## Tests

`test/app.test.js` is end-to-end: it renders `<App>` against the demo connections with `ink-testing-library`, types keys into stdin and asserts on `lastFrame()`. Use its `until(check, what)` helper to wait for frames rather than fixed sleeps. Other test files are plain unit tests of the pure modules. Nothing in the suite needs a real SQL Server.

## Keeping things in sync

Adding or changing a key or command touches several places: the handler (view or `App.jsx`), `src/commands.js` for slash commands, the `?` overlay text in `src/help.js`, and the tables in `README.md`. Commit messages are short sentences describing the change, without type prefixes.
