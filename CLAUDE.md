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
```

`--import ./src/register.js` is required whenever Node loads `.jsx`: it installs a module hook (`src/jsx-hooks.js`) that compiles `.jsx` with esbuild on import. There is no dev build step. CI runs `npm test` on Linux and Windows, so path handling and line endings must work on both (`.gitattributes` forces LF).

Releases: bump `version` in `package.json`, commit, push a matching `vX.Y.Z` tag. Compiled builds get the version via `process.env.TRAWL_VERSION` (defined by `scripts/build.js`).

## Architecture

The layering, bottom to top:

- **`src/sql.js`**: pure T-SQL text handling, where most tests point. `mask()` blanks comments, strings and quoted names while keeping offsets, and everything else works on the mask: `splitBatches` (GO), `splitStatements` (the Query view's units), `classify`/`classifyScript` (is it a write, and which statements are dangerous), value formatting, CSV/JSON.
- **`src/db.js`**: the only place queries reach a server, through tedious. A session is one connection, like an SSMS tab, so transactions and temp tables carry over between runs. `runScript` splits on GO and collects `{ sets, messages, stopped, ms }`; errors are `DbError` with the server's number, the line in the whole script, and `partial` results. Hitting the row limit cancels the request on purpose (`stopped`).
- **`src/demo.js`**: an in-memory session with the same interface, used by `--demo` and the tests. Anything new a session must do needs both drivers.
- **`src/connections.js`**: `/add` parsing and tedious options. **Trawl never stores secrets**: Azure SQL tokens come from `az` (`src/azure.js`, which calls az's Python directly on Windows, as Tiller does), and SQL logins name an environment variable.
- **`src/schema.js`**: `SCHEMA_SQL` reads the catalog in one batch; `buildSchema` shapes it into `{ database, databases, objects }` for the Explorer, completion and `/describe`.
- **`src/actions.js`**: every user-facing operation, written once; keys and slash commands call these with `ctx`. The safety rules live in `runSql`: read-only refusal, the danger confirmation, and wrapping production writes in `BEGIN TRANSACTION`.
- **`src/commands.js`**: the slash-command table and completion, same shape as Tiller's.
- **`src/ui/App.jsx`**: layout, focus, the prompt, overlays, the activity log, the open script's file watcher, and **`ctx`**. `ctx.query` runs SQL visibly (spinner, esc cancels, history, transaction count afterwards); read the `Object.assign(ctx, {...})` block before adding an action.
- **`src/ui/*View.jsx`**: one component per tab. Views must check `ctx.viewHasKeys()` at the start of their `useInput` handlers so keys don't fire while the prompt, an overlay or a confirm has focus. `useListNav` in `src/ui/hooks.js` is the shared cursor/scroll logic.

Theme and text: use `BULLET` instead of `⏺` (Windows draws it wide), and `src/text.js` (`fit`, `fitSegments`, `stringWidth`) for width-aware truncation, never `.length`.

## Tests

`test/app.test.js` is end-to-end: it renders `<App>` against the demo connections with `ink-testing-library`, types keys into stdin and asserts on `lastFrame()`. Use its `until(check, what)` helper to wait for frames rather than fixed sleeps. Other test files are plain unit tests of the pure modules. Nothing in the suite needs a real SQL Server.

## Keeping things in sync

Adding or changing a key or command touches several places: the handler (view or `App.jsx`), `src/commands.js` for slash commands, the `?` overlay text in `src/help.js`, and the tables in `README.md`. Commit messages are short sentences describing the change, without type prefixes.
