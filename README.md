<p align="center"><img src="assets/glim.svg" width="128" alt="Glim, the Trawl anglerfish"></p>

# Trawl

A keyboard-driven SQL Server client for the terminal, built the same way as [Tiller](https://github.com/FranciscoNunes-dxspark/tiller): titled rounded panels, a prompt box with slash commands and completion, `!` to run any SQL, and a running log of what each statement did.

```
><((•> Trawl  │  club-a  myserver.database.windows.net/ClubA   PROD   read-only
 1 Explorer   2 Query   3 Results   4 History   5 Connections   6 Activity
╭─ SELECT TOP (500) * FROM [dbo].[Matches]; ─────────────────────────────── 8 rows · 6 ms ─╮
│    Id │ HomeId │ AwayId │ PlayedOn   │ HomeGoals │ AwayGoals                             │
│  ─────┼────────┼────────┼────────────┼───────────┼──────────                             │
│❯    1 │      2 │      3 │ 2026-02-11 │         1 │         0                             │
│     2 │      3 │      1 │ 2026-03-12 │         2 │         1                             │
╰──────────────────────────────────────────────────────────────────────────────────────────╯
● SELECT TOP (500) * FROM [dbo].[Matches];
  ⎿  8 rows · 6 ms
╭──────────────────────────────────────────────────────────────────────────────────────────╮
│ > /describe dbo.Pl                                                                       │
╰──────────────────────────────────────────────────────────────────────────────────────────╯
  dbo.Players
```

## Install

**Download** the executable for your platform from [Releases](https://github.com/FranciscoNunes-dxspark/trawl/releases): `trawl-windows-x64.exe`, `trawl-linux-x64` / `-arm64`, `trawl-macos-arm64` / `-x64`. The repository is private, so download in the browser while signed in, or with the GitHub CLI:

```bash
gh release download --repo FranciscoNunes-dxspark/trawl --pattern trawl-windows-x64.exe
```

It's a single file with nothing else to install. Rename it to `trawl` (`trawl.exe`) and put it in a folder on your PATH. `SHA256SUMS.txt` lists each file's checksum. The builds aren't code-signed, so Windows SmartScreen may ask before the first run ("More info" → "Run anyway"), and on macOS you may need `xattr -d com.apple.quarantine trawl-macos-arm64` once.

**From source** (Node 22+):

```bash
git clone https://github.com/FranciscoNunes-dxspark/trawl.git C:\Team\Trawl
cd C:\Team\Trawl
npm install
npm link          # puts a `trawl` command on your PATH
```

Without `npm link`, run it with `node C:\Team\Trawl\bin\trawl.js`. `npm run build` makes a single executable in `dist/` that needs nothing else installed.

Releases are automatic: every push to main (a merged pull request, say) publishes a new GitHub Release. The Release workflow (`.github/workflows/release.yml`) picks the next version, the latest release with the patch number raised (v0.2.0 → v0.2.1), runs the tests, builds every platform and publishes it with the files and generated notes, creating the tag. For a new minor or major version, set it in `package.json` (`npm version minor --no-git-tag-version`) and merge that; a version higher than the latest release is used as is. Nothing is committed back, so `package.json` keeps the last version set by hand, while the executables carry the released one. Pushes that only change Markdown files don't release, and "Run workflow" on the Release workflow in the Actions tab releases by hand.

## Try it without a server

```bash
trawl --demo
```

This adds two in-memory connections for the session: `demo`, and `demo-prod`, which behaves like a production connection. Each has the databases `ClubA` and `ClubB`. The demo has no SQL engine. It answers the catalog, `SELECT [TOP (n)] * FROM` a table, simple `SELECT` lists, `USE`, transactions, `WAITFOR DELAY` (to try cancelling) and `RAISERROR`/`THROW`. Writes only report how many rows they would touch.

## Connect

```bash
trawl                       # the connection you used last
trawl query.sql             # and open a script in Query
trawl --connect club-a      # a specific connection
```

Save connections with `/add`:

| | |
| --- | --- |
| Azure SQL, signing in with your `az login` | `/add club-a myserver.database.windows.net ClubA` |
| The same, as production | `/add club-a-prod myserver.database.windows.net ClubA --prod` |
| A SQL login | `/add local localhost,1433 Dev --user sa --trust-cert` |
| Windows (NTLM) | `/add corp sqlhost\SQLEXPRESS Dev --user me --domain CORP` |
| In a folder | `/add club-b srv.database.windows.net ClubB --folder Clubs/PROD` |

`--trust-cert` trusts the server's certificate without checking it, as SSMS's "Trust server certificate" does. A local SQL Server signs its own, which Trawl can't verify otherwise. If you leave it off and connecting fails on the certificate, Trawl asks whether to trust it, and keeps that on the connection.

Azure SQL gets a fresh token from the Azure CLI each time it connects, so there's no password to keep. A SQL or Windows login asks for its password the first time you connect, shown as `*`. With "Keep it" ticked (`tab` changes it), a password that signs in is saved in the operating system's credential store: **Windows Credential Manager** (as `Trawl:<connection>`), the macOS Keychain, or the Secret Service keyring on Linux (through `secret-tool`). It is never written to Trawl's own files. A saved password the server turns down is asked for again. `p` in Connections, or `/password [connection]`, sets a new one ahead of time; leaving it empty removes the saved one, and forgetting a connection removes its password too. If you'd rather keep a password in an environment variable, `/add … --password-env <VAR>` names it, and the variable comes first when it's set.

Connections live in `~/.trawl/config.json` (or `TRAWL_HOME`), along with the prompt history, the run history and what Settings (`,`) changes: the row limit, the accent colour, the mouse and updates.

### Folders

The Connections tab groups connections by folder, as DataGrip does: each folder's heading, its connections under it, and the ones in no folder last. `--folder` puts a connection in one when adding it, and `f` in Connections or `/folder <connection> <folder>` moves it; `/folder <connection>` with no folder takes it out. Nested folders are written with `/`, like `Clubs/PROD`.

### From DataGrip

`/import datagrip` brings in your DataGrip data sources as connections. It reads the places DataGrip keeps them (its projects in `DataGripProjects`, its global data sources, and the per-project history newer versions use) and shows what it would add before adding anything. `/import datagrip <folder>` reads one project's `.idea` instead.

- SQL Server and Azure SQL data sources come across with their server, database, login name, options (trust certificate, encryption, Entra sign-in) and **DataGrip folder**. DataGrip can reach a local server whose data source doesn't say to trust its certificate; Trawl then asks the first time you connect (see `--trust-cert` above). Others (Postgres, CockroachDB, MySQL…) are listed as skipped.
- **Passwords don't**: DataGrip keeps them encrypted in its own store, which Trawl never opens. Trawl asks for each login's password the first time you connect, and keeps it in the OS credential store (see above).
- Data sources in a DataGrip folder called PROD (or with prod in the name) become production connections, read-only until `/writes`; DataGrip's own read-only flag and manual commit (Tx: Manual) carry over too.
- Importing again only adds what's new: one Trawl already has (same server, database and login) is skipped. If that one is in no folder yet, it goes into its DataGrip folder, so connections imported before Trawl had folders get theirs by running `/import datagrip` again.

The Explorer shows the server as a tree, as SSMS's Object Explorer does: every database you can open on it, the one you're in opened up to its schemas, tables, views and routines, and the server's own (`master`, `msdb`, …) last. `↵` on another database switches to it, as `/use <database>` does: by reconnecting, which works on Azure SQL Database too, where `USE` doesn't (and there the server lists only `master` and your database). With a transaction open, it asks first.

## Use

Press `?` inside for every shortcut. The essentials:

| Where | Keys |
| --- | --- |
| Anywhere | `1`–`6` or `tab` switch views · `/` commands · `!` SQL · `r` reload the schema · `,` settings · `esc` cancel the running query · `q` quit |
| Lists | `j`/`k` or arrows · `g`/`G` top/bottom · `ctrl+d`/`ctrl+u` page |
| Explorer | `↵` first rows (on a database: switch to it) · `d` describe · `s` start a query on it in the console · `c` its CREATE script, into the console · `/find <text>` filter |
| Query, the console | `↵` or `i` start typing · `esc` stop · `ctrl+r` run the selection, or the statement under the cursor · `R` run it all · `f` format · `p` plan · `ctrl+f` find, then `n`/`N` · `ctrl+z`/`ctrl+y` undo/redo · while typing, `tab` takes a suggestion and `ctrl+n` asks for them |
| Query, a file | `↵` run the statement under the cursor · `v` select several · `R` run the whole file · `e` edit in the console |
| Results | `h`/`l` columns · `[`/`]` result sets · `o` sort by the column · `f` filter · `y`/`Y` copy the cell/row · `↵` the row as a record · `e` edit · `n` NULL · `d` delete · `u` undo · `s` save · `x` export |
| History | `↵` run again · `e` edit in the console · `◆` marks what Claude ran |
| Connections | `↵` connect · `n` new · `p` password · `f` folder · `x` forget |
| Activity | `R` read again · `↵` the session in full · `x` kill · `a` idle sessions too |
| Settings (`,`) | `↵` or space changes the row limit, the accent colour, the mouse, and whether Trawl checks for and installs updates · `esc` closes |

One-liners can also go straight in the prompt: SQL there runs with `!`, or without it when it starts with a SQL keyword (`select …`, `exec …`).

The mouse works too: click a tab, a row or the prompt, and double-click a row to do what `↵` does: connect, switch database, show a table's first rows, a result row as a record, or change a setting. Where `↵` runs a statement (History, a file's statements), a click only picks it. In Results a click picks the cell. In the console a click puts the cursor on the character under it, a double-click selects the word and a triple-click the line, a click in the gutter selects the statement on that line, and a click on a suggestion takes it, as `tab` does; dragging there selects the SQL itself (so `ctrl+r` runs just that, and typing replaces it), and copies it too. The wheel scrolls the list, grid or text under the pointer and leaves the cursor where it was, even out of sight, until the next key moves it from there and brings it back into view; `shift`+wheel scrolls the Results grid sideways. Drag to select text as you would in the terminal: it's copied when you let go (to the system clipboard, as `y` copies) and stays highlighted until the next key or click. While a question is open, only keys answer it. With **Mouse** turned off in Settings, Trawl doesn't ask the terminal for the mouse, which then selects text itself again. On Windows the downloaded Trawl handles the mouse itself; run from a checkout, it needs Node 22.17 or later.

### The console

The Query tab starts as a console: a SQL editor inside Trawl, with keywords, strings, comments and numbers in colour. Press `↵` or `i` to start typing and `esc` to stop. While you type, every key is text, so the digits and `q` don't switch views or quit. `ctrl+r` runs the statement under the cursor (the gutter marks which one), and its results appear under the console, so you can keep typing. `R` runs everything, and `3` shows the results full size.

The console is saved as you type (in `~/.trawl/console.sql`) and is there again next time. `/save <file.sql>` writes it to a file, and `/new` clears it. `s` on a table in the Explorer starts a `SELECT … WHERE` for it, and `e` in History or on a file's statement copies that SQL into the console to edit.

Editing keys: arrows, `home`/`end` (or `ctrl+a`/`ctrl+e`), `ctrl+←`/`ctrl+→` a word at a time, `ctrl+w` deletes the word before the cursor, `ctrl+u`/`ctrl+k` cut to the start or end of the line, `tab` inserts two spaces, and a new line keeps the indent of the one above. Pasting works, multi-line text included. Holding `shift` with any of the movement keys selects text: typing or `backspace` replaces it, `ctrl+r` runs just the selection (the gutter marks its lines), and `esc` lets go of it. `ctrl+f` (or `/search <text>`) finds text in the console, ignoring case, and selects it; `n` and `N` then find the next and previous match, wrapping round the end.

`f` (when not typing) or `/format` lays out the statement under the cursor, or the selection: each clause on a line of its own, `AND` and `OR` indented under `WHERE` and `ON`, subqueries indented, and reserved words in capitals. Strings, comments and the spacing inside expressions are left alone, and so are procedures and other blocks. `ctrl+z` undoes it.

`p` (when not typing) or `/plan` shows the estimated plan of the statement under the cursor, or the selection, as text (`SET SHOWPLAN_TEXT`): nothing runs, so it's safe on a write too. `/stats` turns on `SET STATISTICS IO` and `TIME` for the session (the header says `stats on`), and each run then ends with one line, such as `Logical reads: Players 3, Clubs 2 · CPU 16 ms · elapsed 20 ms`, in place of the server's long messages; `/stats off` stops it. `ctrl+z` undoes, a word at a time, and `ctrl+y` redoes; they work while typing or not, and cover everything that changes the console (`/new`, `/ask`, `s` in the Explorer, `e` in History) until you quit.

As you type, a list under the cursor suggests what could come next, from the schema of the database you're in, as SSMS's IntelliSense does: tables and views after `FROM`, `JOIN`, `UPDATE` or `INTO` (schema-qualified, so `Pla` becomes `dbo.Players`), a table's columns after its alias or name and a dot (`p.` in `… FROM dbo.Players p`), the join condition after `ON`, from the foreign keys between the table just joined and those before it (`JOIN dbo.Clubs c ON` offers `c.Id = p.ClubId`), the columns of the statement's tables, keywords and functions anywhere else, procedures after `EXEC` and then their parameters (`@Season = `), and databases after `USE`. You don't have to ask: the list opens as you type a name or a dot, and straight after `FROM `, `JOIN `, `ON `, `EXEC ` and `USE `, where it's clear what comes next. Inside a function's parentheses, the line above shows its syntax with the argument you're on picked out (`DATEADD(datepart, number, date)`), and among a procedure's arguments, its parameters and their types from the schema. With the cursor just after the `*` of `SELECT *` (or `p.*`), `tab` writes out the columns in its place, qualified with their alias when the statement reads more than one table. `tab` takes the highlighted one; `↑`/`↓` pick another, and then `↵` takes it too (otherwise `↵` is still a new line). `esc` closes the list without leaving the console, and `ctrl+n` brings it up where nothing has been typed yet (`ctrl+space` does too, in terminals that send it: the Windows console sends a plain space). Nothing is suggested inside comments or strings, and `/refresh` reloads the schema the suggestions come from.

### Scripts

`/open <file.sql>` lists the file's statements in Query. Edit the file in your own editor: Trawl reloads it each time you save. A statement ends at `;`, at a `GO` line or at a blank line, except inside parentheses or a `BEGIN … END` block (`IF … ELSE` and `TRY … CATCH` stay together). A procedure, function, trigger or view runs on to the next `GO`, as SQL Server requires. `R` runs the whole file batch by batch, and `GO 3` runs a batch three times.

Errors say which line of the file they're on.

### Results

Each result set stops at the row limit (500 to start with; `/limit <n>` changes it). Trawl cancels the query there instead of pulling the rest of the table over the network. `NULL` is shown as `NULL`, dates as `2026-10-19 15:14:35`, and binary as `0x…` hex. `/export <file.csv>` or `/export <file.json>` saves the result set on screen.

`o` sorts the rows by the column under the cursor, A to Z, then Z to A, then back to the order they came in. `f` (or `/filter <text>`) shows only the rows with a value containing the text, ignoring case; `/filter` with nothing shows them all again. Neither runs the query again, so they work on the rows Trawl has (up to the row limit), and edits stay with their rows.

`y` copies the cell under the cursor and `Y` the row, tab-separated. `/copy` copies the whole result set: tab-separated by default (it pastes into a spreadsheet as cells), or `/copy csv`, `/copy json`, or `/copy insert` for `INSERT` statements into its table. Trawl uses the system clipboard (PowerShell's `Set-Clipboard`, `pbcopy`, `wl-copy`, `xclip` or `xsel`), and over SSH asks the terminal to copy instead (OSC 52, which Windows Terminal, iTerm2, kitty, WezTerm and tmux understand).

### Editing results

When the rows on screen are the rows of one table, with its primary key among the columns (`↵` on a table in the Explorer, or a `SELECT … FROM` one table with no join or grouping), you can change them in place, as in DataGrip:

- `h`/`l` move between cells, and `e` (or `i`) edits the one under the cursor. `↵` keeps the new value, `tab` keeps it and moves on to the next column, and `esc` leaves the cell as it was.
- `n` makes the cell `NULL`, and `d` marks the row to be deleted (`d` again keeps it).
- Changes are only staged: they show in colour, with a count under the grid. `u` undoes the row's changes and `U` undoes them all.
- `s` saves. Trawl shows the `UPDATE`/`DELETE` script and asks first. Each statement finds its row by the primary key and, for the columns it changes, by the values they had when you read them. If any row has changed or gone since then, nothing is saved. The script runs in a transaction of its own, so a failure doesn't roll back one you had open.
- The usual rules apply: a read-only connection refuses it until `/writes`, and with manual commit the changes wait for `/commit`.

Columns that are expressions or renamed in the query, identity columns and `rowversion` can't be edited. If something can't be edited, `e` says why.

### Activity

The Activity tab (`6`, or `/activity`) lists the server's sessions, as SSMS's Activity Monitor does, read from `sys.dm_exec_sessions` and `sys.dm_exec_requests`: each one's status, what it waits on (`LCK_M_S`, `CXPACKET`…), how long it has run, its login and the SQL it is running (or ran last). Blocking chains come first, drawn as a tree: the session at the head (often one sitting idle with a transaction open), then the sessions waiting on it, and those waiting on them, with `▲` and a count on each session that blocks others. Sessions that are only sleeping are left out; `a` shows them too.

The list is read when the tab opens, and again on `R`. `↵` shows a session's details and its SQL in full. `x` (or `/kill <session>`) ends a session with `KILL`, after asking: what it hasn't committed is rolled back. A read-only connection refuses it until `/writes`, and so does an open transaction (KILL can't run inside one). Reading the sessions needs `VIEW SERVER STATE` (`VIEW DATABASE STATE` on Azure SQL Database, which lists that database's sessions only).

### Safety

- **Production is read-only.** On a connection added with `--prod`, anything that changes data is refused until `/writes`, which asks first and lasts until you disconnect.
- **Auto or manual commit, as DataGrip's Tx: Auto/Manual.** With manual commit, the first write starts a transaction, and the header shows `TRANSACTION OPEN` until you `/commit` or `/rollback`. With auto commit, each statement takes effect as it runs. Production connections use manual commit unless you change it. `/tx manual` or `/tx auto` switches the connection you're on and remembers it (switching production to auto asks first), `/add … --commit manual` sets it when adding, and a DataGrip data source set to manual comes across that way. Disconnecting, switching database or quitting with a transaction open asks first, because it rolls back.
- **Risky statements ask first, on every connection**: `UPDATE` or `DELETE` with no `WHERE`, `DROP` and `TRUNCATE`.
- **Writes say how many rows they change.** Before an `UPDATE` or `DELETE` runs, Trawl counts its rows with a `SELECT COUNT_BIG(*)` over the same `FROM` and `WHERE` (nothing is written to find out), and puts the number in the question. A `WHERE` that would still change more than 1,000 rows asks first too. `esc` while it counts cancels the write. Statements it can't count safely (`TOP`, `OUTPUT`, several at once) run as before.
- A statement counts as a write when it has `INSERT`, `UPDATE`, `DELETE`, `MERGE`, `SELECT … INTO`, DDL, `GRANT`/`REVOKE`, `DBCC`, or `EXEC` of anything except the read-only system procedures (`sp_help`, `sp_who2`, `sp_spaceused` and the like).

### Slash commands

Type `/` and the menu narrows as you type. `tab` completes, `↑`/`↓` picks, `↵` runs. `/connect` completes connection names, `/use` database names and `/describe` tables and views.

`/import datagrip [folder]` `/connect <name>` `/add …` `/forget <name>` `/folder <connection> [folder]` `/password [connection]` `/disconnect` `/use <database>` `/open <file.sql>` `/console` `/new` `/format` `/search <text>` `/save <file.sql>` `/describe <table>` `/script <name>` `/find [text]` `/export <file>` `/filter [text]` `/copy [tsv|csv|json|insert]` `/limit [rows]` `/writes` `/tx [auto|manual]` `/commit` `/rollback` `/ask <question>` `/ai [connection] [level]` `/update` `/settings` `/stats [on|off]` `/plan [sql]` `/activity` `/kill <session>` `/last` `/refresh` `/help` `/quit`

## Claude

### What Claude may see

Each connection has a Claude access level, shown in Connections and changed with `/ai`:

| Level | Claude sees |
| --- | --- |
| `schema` (the default) | Table and column names, the SQL, and error messages. Never rows. |
| `results` | Rows too, when it runs a query. `/ai results` asks first, since the data then leaves your machine. |
| `off` | Nothing. |

`/ai` on its own says the current level; `/ai results` sets it for the connection you're on, and `/ai <connection> <level>` for another. `/add … --ai <level>` sets it when adding. The demo connections allow everything; their data is made up.

### Ask for a query

`/ask top scorers per club this season` sends Claude the question and the database's tables and columns (names only, never rows) and puts the query it writes into the console, under the question and Claude's note as comments. **Nothing runs by itself**: read it, change it if you like, then `ctrl+r`. The usual checks apply when you do, so a risky statement still asks first.

It uses the Claude Code CLI you're already signed in to (`claude -p`), with no tools and none of your MCP servers, so Claude can only answer. Nothing to configure, and no API key. `esc` cancels while it thinks. A connection at the `off` level can't be asked about.

### Claude Code reads your databases (MCP)

`trawl mcp` runs Trawl as an MCP server, so Claude Code, working in any of your repositories, can look at your databases through your saved connections. Register it once:

```bash
claude mcp add --scope user trawl -- trawl mcp
```

(From a checkout without `npm link`: `claude mcp add --scope user trawl -- node C:\Team\Trawl\bin\trawl.js mcp`.) It gives Claude `list_connections`, `list_tables`, `describe_table` and `run_query`.

- Claude signs in exactly as you do (your `az login`, or the password saved in the OS credential store or named variable); it never sees a password. A login with no saved password can't be used until you've connected to it once in Trawl.
- **It only reads.** Anything the write check flags is refused before it reaches the database, on every connection, production or not. As a second lock, every query runs inside a transaction that is rolled back. The check reads the SQL text, so for connections Claude uses, a login with read-only rights (`db_datareader`) is the surest guard.
- `run_query` only returns rows from connections at the `results` level; on `schema` ones Claude gets the names and writes queries you run.
- Results stop at 100 rows unless Claude asks for more (1000 at most).
- Everything Claude runs shows in History, marked `◆`.

`trawl mcp --demo` adds the demo connections, to try it without a server.

## Updates

The downloaded Trawl keeps itself up to date, as Tiller does. Once a day, in the background, it asks GitHub for the latest release of [FranciscoNunes-dxspark/trawl](https://github.com/FranciscoNunes-dxspark/trawl/releases). If there's a newer one, it downloads it in the background and puts it in place of the executable you ran; the new version starts the next time you open Trawl. The header shows `↑ 0.2.0 downloading…`, then `↑ 0.2.0 at next start`, and the activity log says when it's in. `/update` does the same right away, with the spinner (esc stops it).

- The download comes from GitHub directly, or through `gh release download` while the repository is private.
- It must match the checksum published with the release (`SHA256SUMS.txt`), or nothing is replaced.
- On Windows a running program can't be overwritten, only renamed, so the old executable is moved aside (`trawl-windows-x64.exe.old.<time>`) and deleted on a later start.
- If Trawl can't write to the folder it's in (under Program Files, say), or anything else goes wrong, nothing changes: the header shows `↑ 0.2.0`, the activity log says why, and `/update` gives the `gh release download` command (replace the old file after quitting).
- Running from a checkout skips all of this; `git pull && npm install` updates that.

The repository is private, so GitHub only shows its releases to someone signed in with access. Trawl asks anonymously first, then through the GitHub CLI (`gh api`) with your own sign-in; without `gh` signed in, it just finds nothing. The request carries `trawl/<version>` as the user agent, and nothing about your connections or queries is sent. When it fails (offline, say), it stays silent and tries again the next day. To only be told about new versions, turn off **Install updates** in Settings (`,`), or set `"autoUpdate": false` in `~/.trawl/config.json`; `/update` still installs when you ask. To turn the check off, turn off **Check for updates** (`"checkUpdates": false`), or set the environment variable `TRAWL_NO_UPDATE_CHECK=1`.

## Glim

Glim is Trawl's anglerfish: it carries its own light into the deep, which is roughly what a query does. It says hello in the welcome box when Trawl starts (if the terminal is tall enough), and a small fish in the header shows how it feels:

| | |
| --- | --- |
| `><((–>` | Not connected: asleep, lure dimmed |
| `><((•>` | Connected, looking around (it glances side to side while a query runs) |
| `><((^>` | A query just worked |
| `><((◉>` | Something just went wrong |
| `><((!>` | A transaction is open: the lure glows red until `/commit` or `/rollback` |

The logo and the Windows icon in `assets/` are drawn from the same pixels (`src/glim.js`); `node scripts/logo.js` regenerates them. `glim.svg`, `glim.png` and `glim.ico` sit on the dark rounded square; `glim-transparent.svg`, `glim-transparent.png` (544 × 416) and `glim-transparent@4x.png` are just the fish, cropped (with room for the badge), on transparency, and `glim-transparent.ico` is the fish centred on a transparent square (16 to 256 px). Each one carries an "SQL" pixel-art badge in the bottom-right corner, so Trawl's icon is easy to tell from Tiller's at a glance.

## Not yet

- Postgres and MySQL (the driver layer is one interface, so they'd be new adapters).
- Running one query across a group of databases, with each row tagged by database.
- Schema diff between two databases.
