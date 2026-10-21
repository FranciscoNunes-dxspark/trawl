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

This adds two in-memory connections for the session: `demo`, and `demo-prod`, which behaves like a production connection. Each has the databases `ClubA` and `ClubB`. The demo has no SQL engine. It answers the catalog (and `/grep` and `/uses`, with a trigger on `Players` for them to find), `SELECT [TOP (n)] * FROM` a table, simple `SELECT` lists, `USE`, transactions, made-up plans (estimated and actual), `WAITFOR DELAY` (to try cancelling) and `RAISERROR`/`THROW`. Writes only report how many rows they would touch.

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
| PostgreSQL | `/add shop db.local:5432 shop --kind postgres --user app` |
| MySQL or MariaDB | `/add blog db.local:3306 blog --kind mysql --user app --ssl` |

`--trust-cert` trusts the server's certificate without checking it, as SSMS's "Trust server certificate" does. A local SQL Server signs its own, which Trawl can't verify otherwise. If you leave it off and connecting fails on the certificate, Trawl asks whether to trust it, and keeps that on the connection.

Azure SQL gets a fresh token from the Azure CLI each time it connects, so there's no password to keep. A SQL or Windows login asks for its password the first time you connect, shown as `*`. With "Keep it" ticked (`tab` changes it), a password that signs in is saved in the operating system's credential store: **Windows Credential Manager** (as `Trawl:<connection>`), the macOS Keychain, or the Secret Service keyring on Linux (through `secret-tool`). It is never written to Trawl's own files. A saved password the server turns down is asked for again. `p` in Connections, or `/password [connection]`, sets a new one ahead of time; leaving it empty removes the saved one, and forgetting a connection removes its password too. If you'd rather keep a password in an environment variable, `/add … --password-env <VAR>` names it, and the variable comes first when it's set.

Connections live in `~/.trawl/config.json` (or `TRAWL_HOME`), along with the prompt history, the run history and what Settings (`,`) changes: the row limit, the accent colour, the mouse, updates and notifications.

When a query (or anything else with the spinner) takes longer than 10 seconds, Trawl rings the terminal's bell and asks it for a desktop notification saying what finished and how (OSC 9, which Windows Terminal, iTerm2, WezTerm and kitty show, or OSC 777 in GNOME Terminal and other VTE terminals), for when you've switched to another window. **Notify when done** in Settings turns it off, and `"notifyAfter": 30` in `config.json` changes the seconds. A run you cancel says nothing.

### PostgreSQL and MySQL

Besides SQL Server, a connection can be to PostgreSQL or MySQL (MariaDB too): `/add … --kind postgres` or `--kind mysql`, with the server as `host` or `host:port` (5432 and 3306 by default) and a login (`--user`), whose password is asked for and kept as for a SQL login. TLS is off unless you add `--ssl`, or `--trust-cert` to use it without checking the server's certificate. Trawl talks to them through the `pg` and `mysql2` drivers, plain JavaScript in the same executable.

Most of Trawl works the same there: the Explorer, the console and its suggestions, scripts, Results with sorting, filters, copying, comparing, following foreign keys and editing in place, History, the read-only and production rules, manual commit (`BEGIN`/`START TRANSACTION`, then `/commit` or `/rollback`), the questions before risky statements and the row count before an `UPDATE` or `DELETE`, parameters and snippets, `/fanout` (a folder can mix kinds), CSV import, Activity and `/kill` (`pg_terminate_backend` on Postgres), `p` for the plan (`EXPLAIN`, which doesn't run anything) and Claude's explanation of it, `P` for the actual plan (`EXPLAIN (ANALYZE, BUFFERS)` on Postgres, `EXPLAIN ANALYZE` on MySQL 8.0.18 or later, with the same `▲`/`▼` marks), `c` for a view's or routine's definition, `/grep` and `/uses`, and `trawl mcp`. The differences:

- A script runs a statement at a time, split at `;` (Postgres's `$$` bodies and MySQL's backslash escapes are understood); there is no `GO`, and MySQL's `DELIMITER` isn't supported.
- Rows past the row limit are dropped once they arrive, rather than the query being stopped there, so a huge `SELECT` still crosses the network: add a `LIMIT`.
- Saving edited results is written each server's way (see [Editing results](#editing-results)). Generated columns, Postgres arrays, intervals and geometric values, and MySQL's spatial types can't be edited, and on MySQL a failed save leaves only tables that keep transactions (InnoDB, not MyISAM) as they were.
- `/stats` and the sync script of `/diff` are SQL Server only; `/diff` compares tables, columns and keys only (not indexes or definitions) when either side isn't SQL Server.
- Activity on MySQL doesn't show who blocks whom. There are no SQL Agent jobs on either (`J` says so), and the top queries come from `pg_stat_statements` (which has to be installed: `Q` says how) and from `performance_schema` on MySQL, where reads are rows examined and there is no CPU time.
- `/uses` takes what views use from Postgres's catalog (`pg_depend`), and the triggers on a table from both, but neither records what a routine's or trigger's body refers to (nor, on MySQL, a view's), so those are found by the object's name in their definitions, and the report marks them "by name".
- `P` runs the statement through `EXPLAIN ANALYZE`, which sends back the plan but not the rows, so Results stays as it was. It always runs inside a transaction that is rolled back afterwards (or back to a savepoint, when you have one open, which then stays as it was), whatever the commit mode: an actual plan is for looking at, and it would be easy to forget that it changed data. To apply a write, run it (`ctrl+r`). A table that can't roll back (MySQL's MyISAM) keeps the change. MariaDB has `ANALYZE` instead, which Trawl doesn't use.
- `/ask` writes T-SQL, and the suggestions and `/format` know T-SQL's keywords and functions, not every other one.
- `/import datagrip` still leaves Postgres and MySQL data sources out.

### Folders

The Connections tab groups connections by folder, as DataGrip does: each folder's heading, its connections under it, and the ones in no folder last. `--folder` puts a connection in one when adding it, and `f` in Connections or `/folder <connection> <folder>` moves it; `/folder <connection>` with no folder takes it out. Nested folders are written with `/`, like `Clubs/PROD`.

### Comparing schemas

`/diff <connection> [database]` compares the schema of the database you're in with another one's: a saved connection's (its own database, or the one named), or `/diff <database>` for another database on this server. It reads both catalogs and lists what differs, by kind: tables, and inside the tables both have, columns (type, nullability, identity), the primary key, foreign keys and indexes; then views, procedures and functions, by their definitions, with the lines that differ. `<` marks what only this database has, `>` what only the other has, and `~` what both have, differently.

Then it asks whether to put the script that would make **this** database match the other in the console: `CREATE TABLE` for a missing table (with its keys), `ALTER TABLE … ADD`/`ALTER COLUMN` for columns, constraints and indexes, and the other side's definitions for views, procedures and functions (`CREATE OR ALTER` where they differ, a batch each). Dropping a table or a column loses its data, so those lines come commented out, to uncomment on purpose; so does what can't change in place, like an identity or a primary key. Nothing runs until you do, and then the usual checks apply. For the other direction, connect to the other database and `/diff` back. The demo's `ClubB` has drifted a little from `ClubA`, so `/diff ClubB` shows it.

### One query on a folder of databases

`/fanout <folder> <sql>` runs one query on every connection in a folder (and in the folders under it), as when the same schema lives in a database per client: `/fanout Clubs SELECT COUNT(*) AS Players FROM dbo.Players`. Without the SQL, it runs the console's selection, or the statement under its cursor. Each connection gets a session of its own, four at a time, and the rows come back as one result set in Results, each led by a `connection` and a `database` column; columns are matched by name, so a database missing one shows `NULL` there. A connection that fails (a missing table, no saved password) says why under the grid, and the others carry on. `esc` stops them all.

It only reads: anything that would change data or schema is refused, and what runs is rolled back afterwards, as `trawl mcp` does. Each connection's run is in History. A login that has never connected has no saved password yet: connect to it once in Trawl first.

### From DataGrip

`/import datagrip` brings in your DataGrip data sources as connections. It reads the places DataGrip keeps them (its projects in `DataGripProjects`, its global data sources, and the per-project history newer versions use) and shows what it would add before adding anything. `/import datagrip <folder>` reads one project's `.idea` instead.

- SQL Server and Azure SQL data sources come across with their server, database, login name, options (trust certificate, encryption, Entra sign-in) and **DataGrip folder**. DataGrip can reach a local server whose data source doesn't say to trust its certificate; Trawl then asks the first time you connect (see `--trust-cert` above). Others (Postgres, CockroachDB, MySQL…) are listed as skipped.
- **Passwords don't**: DataGrip keeps them encrypted in its own store, which Trawl never opens. Trawl asks for each login's password the first time you connect, and keeps it in the OS credential store (see above).
- Data sources in a DataGrip folder called PROD (or with prod in the name) become production connections, read-only until `/writes`; DataGrip's own read-only flag and manual commit (Tx: Manual) carry over too.
- Importing again only adds what's new: one Trawl already has (same server, database and login) is skipped. If that one is in no folder yet, it goes into its DataGrip folder, so connections imported before Trawl had folders get theirs by running `/import datagrip` again.

The Explorer shows the server as a tree, as SSMS's Object Explorer does: every database you can open on it, the one you're in opened up to its schemas, tables, views and routines, and the server's own (`master`, `msdb`, …) last. `↵` on another database switches to it, as `/use <database>` does: by reconnecting, which works on Azure SQL Database too, where `USE` doesn't (and there the server lists only `master` and your database). With a transaction open, it asks first.

## Use

Press `?` inside for every shortcut: the sections down the left, opening on the one for the view you're in, `j`/`k` to pick another, and `/` to search them all (the slash commands too). The essentials:

| Where | Keys |
| --- | --- |
| Anywhere | `1`–`6` or `tab` switch views · `/` commands · `!` SQL · `r` reload the schema · `,` settings · `esc` cancel the running query · `q` quit |
| Lists | `j`/`k` or arrows · `g`/`G` top/bottom · `ctrl+d`/`ctrl+u` page |
| Explorer | `↵` first rows (on a database: switch to it) · `d` describe · `s` start a query on it in the console · `c` its CREATE script, into the console · `u` what uses it, and what it uses · `/find <text>` filter · `/grep <text>` search inside the definitions |
| Query, the console | `↵` or `i` start typing · `esc` stop · `ctrl+r` run the selection, or the statement under the cursor · `R` run it all · `f` format (`alt+shift+f` while typing) · `p` plan, `P` actual plan (then `a`: Claude explains it) · `S` save as a snippet · `[`/`]` previous/next tab · `+` new tab · `ctrl+f` find, then `n`/`N` · `ctrl+z`/`ctrl+y` undo/redo · while typing, `tab` takes a suggestion and `ctrl+n` asks for them |
| Query, a file | `↵` run the statement under the cursor · `v` select several · `R` run the whole file · `e` edit in the console |
| Results | `h`/`l` columns · `[`/`]` result sets · `m` more rows · `o` sort by the column · `f` filter · `y`/`Y` copy the cell/row · `↵` the row as a record · `v` the whole value of the cell · `F` follow the foreign key · `p` pin · `c` compare with the pinned · `e` edit · `n` NULL · `d` delete · `a` add a row · `u` undo · `s` save · `x` export |
| History | `↵` run again · `e` edit in the console · `◆` marks what Claude ran |
| Connections | `↵` connect · `n` new · `p` password · `f` folder · `x` forget |
| Activity | `R` read again · `↵` the session in full · `x` kill · `a` idle sessions too · `J` SQL Agent jobs · `Q` top queries (the same key again, or `esc`, back to the sessions) |
| Activity, jobs | `↵` recent runs · `s` start the job · `R` read again |
| Activity, top queries | `o` sort by total duration, CPU, reads or executions · `↵` the query in full · `e` edit in the console · `R` read again |
| Settings (`,`) | `↵` or space changes the row limit, the accent colour, the mouse, whether Trawl checks for and installs updates, and whether it notifies when a long run ends · `esc` closes |

One-liners can also go straight in the prompt: SQL there runs with `!`, or without it when it starts with a SQL keyword (`select …`, `exec …`).

The mouse works too: click a tab, a row or the prompt, and double-click a row to do what `↵` does: connect, switch database, show a table's first rows, a result row as a record, or change a setting. Where `↵` runs a statement (History, a file's statements), a click only picks it. In Results a click picks the cell. In the console a click starts typing with the cursor on the character under it, a double-click selects the word and a triple-click the line, a click in the gutter selects the statement on that line, and a click on a suggestion takes it, as `tab` does; dragging there selects the SQL itself (so `ctrl+r` runs just that, and typing replaces it), and copies it too. The wheel scrolls the list, grid or text under the pointer and leaves the cursor where it was, even out of sight, until the next key moves it from there and brings it back into view; `shift`+wheel scrolls the Results grid sideways. Drag to select text as you would in the terminal: it's copied when you let go (to the system clipboard, as `y` copies) and stays highlighted until the next key or click. While a question is open, only keys answer it. With **Mouse** turned off in Settings, Trawl doesn't ask the terminal for the mouse, which then selects text itself again. On Windows the downloaded Trawl handles the mouse itself; run from a checkout, it needs Node 22.17 or later.

### The console

The Query tab starts as a console: a SQL editor inside Trawl, with keywords, built-in functions (`GREATEST(`, `IIF(`, `DATEADD(`…), strings, comments and numbers each in a colour of their own. Press `↵` or `i` to start typing and `esc` to stop. While you type, every key is text, so the digits and `q` don't switch views or quit. `ctrl+r` runs the statement under the cursor (the gutter marks which one), and its results appear under the console, so you can keep typing. `R` runs everything, and `3` shows the results full size.

The console is saved as you type (in `~/.trawl/console.sql`) and is there again next time. `/save <file.sql>` writes it to a file, and `/new` clears it.

The console can have several tabs, all on the same connection (so a temp table or an open transaction is shared, as between SSMS's batches in one window): `+` (when not typing) or `/tab new [name]` opens one, `[` and `]` go to the one before or after, `/tab <name>` or `/tab <number>` goes to one, `/tab rename <name>` renames the one on screen, and `/tab close` closes it (asking first if it has text). The panel's title lists them, the one on screen in brackets, and a click on one's name goes to it. Each tab keeps its own text, in a file of its own (the first in `console.sql`, the others under `~/.trawl/consoles/`), and its own undo history; they're all there again next time, on the tab you left. `s` on a table in the Explorer starts a `SELECT … WHERE` for it, and `e` in History or on a file's statement copies that SQL into the console to edit.

Drop a `.sql` or `.txt` file on the terminal and it opens in a console tab of its own, named after it (several at once open one tab each). The terminal types a dropped file's path, so Trawl takes it as a drop when what arrives is nothing but the paths of such files: anywhere except the prompt, and in the console unless the cursor is inside a string or a comment, where the path is just text. Files over 1 MB are left to `/open`.

Editing keys: arrows, `backspace` and `delete`, `home`/`end` (`ctrl+e` goes to the end too), `ctrl+home`/`ctrl+end` the start and end of the text, `ctrl+←`/`ctrl+→` a word at a time, `ctrl+w`, `ctrl+backspace` or `alt+backspace` delete the word before the cursor and `ctrl+delete` the one after it, `ctrl+u`/`ctrl+k` cut to the start or end of the line, `tab` inserts two spaces, and a new line keeps the indent of the one above. Pasting works, multi-line text included. (On Windows, `ctrl+backspace` needs the downloaded Trawl or Node 22.17 or later; before that the console sends it as a plain backspace.) Holding `shift` with any of the movement keys selects text, and `ctrl+a` selects everything: typing or `backspace` replaces it, `ctrl+r` runs just the selection (the gutter marks its lines), `ctrl+c` copies it, `ctrl+x` cuts it (with nothing selected, the whole line), and `esc` lets go of it. With nothing selected, `ctrl+c` stops typing, as `esc` does. `ctrl+f` (or `/search <text>`) finds text in the console, ignoring case, and selects it; `n` and `N` then find the next and previous match, wrapping round the end.

Whole lines: `alt+↑`/`alt+↓` move the cursor's line, or every line the selection touches, up or down; `ctrl+d` writes it again under itself (with a selection, the selection after itself); `ctrl+/` comments it out with `--` at the least indent, or back in when every line already is; and with several lines selected, `tab` and `shift+tab` indent them two spaces in or out (`shift+tab` alone takes the cursor's line out).

`f` (when not typing), `alt+shift+f` or `ctrl+alt+l` (while typing, as in VS Code and DataGrip) or `/format` lays out the statement under the cursor, or the selection: each clause on a line of its own, the columns of a `SELECT` (and an `UPDATE`'s `SET`) one a line under it, joins indented under `FROM` with their `ON` under them, `AND` and `OR` indented under `WHERE` and `ON`, subqueries indented, and reserved words in capitals. Strings, comments and the spacing inside expressions are left alone, and so are procedures and other blocks. `ctrl+z` undoes it.

`p` (when not typing) or `/plan` shows the estimated plan of the statement under the cursor, or the selection, as text (`SET SHOWPLAN_TEXT`): nothing runs, so it's safe on a write too.

`P` (when not typing) or `/plan actual [sql]` shows the actual plan instead: the statement **runs**, so the usual checks come first (a read-only connection refuses a write, risky statements ask, and with manual commit a write waits for `/commit`), it lands in History, and its rows land in Results as any run's do. On SQL Server it runs with `SET STATISTICS PROFILE` on (and off again afterwards), and reads its rows to the end, keeping the row limit's worth, so the counts are whole. The plan opens as a tree of the operators, each with the rows it really produced beside the optimizer's estimate (`actual 12 / est 1`, and how many times it ran when that's more than once), and `▲` or `▼` marks an operator whose rows are 10 times the estimate or more, or a tenth or less: that's often where a plan goes wrong (stale statistics, a parameter sniffed for other values). `a` asks Claude about it, as on the estimated plan.

`/stats` turns on `SET STATISTICS IO` and `TIME` for the session (the header says `stats on`), and each run then ends with one line, such as `Logical reads: Players 3, Clubs 2 · CPU 16 ms · elapsed 20 ms`, in place of the server's long messages; `/stats off` stops it. `ctrl+z` undoes, a word at a time, and `ctrl+y` redoes; they work while typing or not, and cover everything that changes the console (`/new`, `/ask`, `s` in the Explorer, `e` in History) until you quit.

As you type, a list under the cursor suggests what could come next, from the schema of the database you're in, as SSMS's IntelliSense does: tables and views after `FROM`, `JOIN`, `UPDATE` or `INTO` (schema-qualified, so `Pla` becomes `dbo.Players`), a table's columns after its alias or name and a dot (`p.` in `… FROM dbo.Players p`), the join condition after `ON`, from the foreign keys between the table just joined and those before it (`JOIN dbo.Clubs c ON` offers `c.Id = p.ClubId`), the columns of the statement's tables, keywords and functions anywhere else, procedures after `EXEC` and then their parameters (`@Season = `), and databases after `USE`. You don't have to ask: the list opens as you type a name or a dot, and straight after `FROM `, `JOIN `, `ON `, `EXEC ` and `USE `, where it's clear what comes next. Inside a function's parentheses, the line above shows its syntax with the argument you're on picked out (`DATEADD(datepart, number, date)`), and among a procedure's arguments, its parameters and their types from the schema. With the cursor just after the `*` of `SELECT *` (or `p.*`), `tab` writes out the columns in its place, qualified with their alias when the statement reads more than one table. `tab` takes the highlighted one; `↑`/`↓` pick another, and then `↵` takes it too (otherwise `↵` is still a new line). `esc` closes the list without leaving the console, and `ctrl+n` brings it up where nothing has been typed yet (`ctrl+space` does too, in terminals that send it: the Windows console sends a plain space). Nothing is suggested inside comments or strings, and `/refresh` reloads the schema the suggestions come from.

### Snippets and parameters

A query you run often can be kept as a snippet: `S` in the console (or `/snippet save <name>`) saves the selection, or the statement under the cursor, under a name, for the connection you're on (saved while not connected, it's for every connection). `/snippets` lists the ones for this connection: `↵` runs one, `e` puts it in the console, `x` forgets it. `/snippet <name>` runs one straight away, and `/snippet delete <name>` forgets it. They're kept in `config.json`.

SQL can have parameters, as in DataGrip: a variable it uses without declaring it, like `@id` in `SELECT * FROM dbo.Players WHERE Id = @id`, is asked for before it runs (snippets, the console, files, the prompt). Type a number, `NULL`, or text, which Trawl quotes for you (`N'…'`); type the quotes yourself to give a literal as it is (`'2026-01-01'`). Each `@name` is replaced by the value, and the value is offered again next time until you quit. A variable `DECLARE`d in the same batch isn't a parameter, and neither are `@@ROWCOUNT` and the like, the argument names in `EXEC dbo.p @Season = 2024`, or the parameters of a `CREATE PROCEDURE` or `FUNCTION`. `esc` at a question cancels the run.

sqlcmd variables work too, as in SSMS's SQLCMD mode: `:setvar Env "prod"` gives `$(Env)` its value, and a `$(name)` with no `:setvar` is asked for. The value goes into the SQL as it is, and the `:setvar` lines are left out of what the server gets. Other sqlcmd commands (`:r`, `:connect`) aren't supported.

### Scripts

`/open <file.sql>` lists the file's statements in Query. Edit the file in your own editor: Trawl reloads it each time you save. A statement ends at `;`, at a `GO` line or at a blank line, except inside parentheses or a `BEGIN … END` block (`IF … ELSE` and `TRY … CATCH` stay together). A procedure, function, trigger or view runs on to the next `GO`, as SQL Server requires. `R` runs the whole file batch by batch, and `GO 3` runs a batch three times.

Errors say which line of the file they're on.

### Searching definitions, and what uses what

`/grep <text>` searches inside every view, procedure, function and trigger in the database you're in, as Redgate's SQL Search does: the ones whose definition has the text, ignoring case, each with how many times and the first line it's on (with its number). The search runs on the server, so only the definitions that match cross the network, and `%`, `_` and `[` in the text are only themselves. On the right are all the lines it's on. `↵` puts the object's CREATE script in the console, as `c` in the Explorer does, with the first match selected; `n` and `N` go on to the others.

`u` on a table, view or routine in the Explorer, or `/uses <object>`, says what uses it and what it uses, grouped by kind, with schema-qualified names: the views, procedures, functions and triggers that refer to it (from `sys.sql_expression_dependencies`), the triggers on it, and the tables whose foreign keys refer to it; then what it refers to, and its own foreign keys. A reference to an object that isn't in the database (in another database, or not made yet) is listed apart. SQL built as a string and run with `EXEC` isn't in SQL Server's record, so it isn't in the report either. `/last` shows it again.

### Results

Each result set stops at the row limit (500 to start with; `/limit <n>` changes it). Trawl cancels the query there instead of pulling the rest of the table over the network, and the line under the grid says the limit stopped it. `m` (or `/more`) then runs the query again with the limit raised by another limit's worth (500, then 1,000, then 1,500…), and the rows take the place of those on screen, with the cursor, the sort and the filter where they were. The first rows of a table (`↵` in the Explorer) and a followed key (`F`) ask for `TOP (500)` (`LIMIT 500` on Postgres and MySQL), and that goes up the same way. Only reads run again: `m` won't repeat anything that changes data. A script of several statements runs again whole, with the higher limit for every result set in it, since which statement gave which set isn't known; to fetch more of one, run it on its own. With edits not yet saved, save or undo them first. `NULL` is shown as `NULL`, dates as `2026-10-19 15:14:35`, and binary as `0x…` hex. `/export <file.csv>`, `/export <file.json>` or `/export <file.md>` (a Markdown table) saves the result set on screen.

A long value is cut short in the grid. `v` (or `/cell`) shows the whole of the cell under the cursor, the column and row in the title: JSON laid out with each level indented, XML a tag a line, binary as a hex dump with the bytes that are text beside it, and anything else wrapped to the width of the screen. `esc` closes it.

`o` sorts the rows by the column under the cursor, A to Z, then Z to A, then back to the order they came in. `f` (or `/filter <text>`) shows only the rows with a value containing the text, ignoring case; `/filter` with nothing shows them all again. Neither runs the query again, so they work on the rows Trawl has (up to the row limit), and edits stay with their rows.

`y` copies the cell under the cursor and `Y` the row, tab-separated. `/copy` copies the whole result set: tab-separated by default (it pastes into a spreadsheet as cells), or `/copy csv`, `/copy json`, `/copy md` for a Markdown table (to paste into a pull request or a wiki: `|` in a value is escaped, a line break becomes `<br>` and `NULL` stays `NULL`), or `/copy insert` for `INSERT` statements into its table. Trawl uses the system clipboard (PowerShell's `Set-Clipboard`, `pbcopy`, `wl-copy`, `xclip` or `xsel`), and over SSH asks the terminal to copy instead (OSC 52, which Windows Terminal, iTerm2, kitty, WezTerm and tmux understand).

### Comparing results

To see what a change did, pin a result first: `p` in Results (or `/pin`) keeps the result set on screen. Run the query again (after an update, say, or on another database), and `c` (or `/compare`) shows the difference as a result set of its own: a `change` column first, `~` for a row whose values changed (with the new values, and a `was` column at the end saying `Goals: 3 → 4`), `+` for a row that's new and `−` for one that's gone, and a line under it counting them and the rows that are the same. When the pinned rows are one table's with its primary key (as for editing, below), rows are matched by the key, so a changed row shows as changed; otherwise whole rows are compared, so it shows as one removed and one added. Both results need the same columns, in any order. The pin stays until you pin another.

### Following foreign keys

When the rows on screen are one table's (as for editing, below, though the primary key needn't be there), `h`/`l` move a cursor between cells, and `F` (or `/follow`) follows the cell's foreign key: on `Players.ClubId`, it opens the club that row refers to (`SELECT TOP (…) * FROM [dbo].[Clubs] WHERE [Id] = 2`); on a key other tables refer to, like `Clubs.Id`, it opens their rows that refer to it. When there are several ways to go, it asks which. A key of several columns takes them all from the row, and a `NULL` refers to nothing. The query runs like any other, so it lands in History and Results, and `F` works there again.

### Importing a CSV file

`/import-csv <file.csv> <table>` turns a CSV file into `INSERT` statements for a table of the database you're in. The file's header names the columns, matched to the table's ignoring case, spaces and underscores (`club_id` is `ClubId`); identity columns and headers the table hasn't are left out, and the script says which, and which `NOT NULL` columns the file doesn't have. Values can be separated by commas, semicolons or tabs (whichever the header uses), quoted with `"` (with `""` inside, and line breaks), and the file can have Windows line endings and a byte-order mark. An empty value is `NULL` where the column allows it. Each value is checked against its column's type first, and a bad one says its row and column (`Row 3, Goals: int takes a whole number ("x")`).

The script opens in a console tab of its own (`import`), to read through and then run with `R`. `/import-csv <file.csv> <table> --run` runs it straight away instead. Either way it goes through the usual checks: a read-only connection refuses it, and with manual commit it waits for `/commit`.

### Editing results

When the rows on screen are the rows of one table, with its primary key among the columns (`↵` on a table in the Explorer, or a `SELECT … FROM` one table with no join or grouping), you can change them in place, as in DataGrip:

- `h`/`l` move between cells, and `e` (or `i`) edits the one under the cursor. `↵` keeps the new value, `tab` keeps it and moves on to the next column, and `esc` leaves the cell as it was.
- `n` makes the cell `NULL`, and `d` marks the row to be deleted (`d` again keeps it).
- `a` adds a new row at the end. Its cells say `DEFAULT` until `e` or `n` gives them a value, and those left that way get the column's default (or `NULL`) from the server; left empty, a cell of any column but a text one is `DEFAULT` too. Identity and computed columns are always the server's.
- Changes are only staged: they show in colour, with a count under the grid. `u` undoes the row's changes (on a new row, it takes the row away) and `U` undoes them all.
- `s` saves. Trawl shows the `UPDATE`/`DELETE`/`INSERT` script and asks first. Each `UPDATE` and `DELETE` finds its row by the primary key and, for the columns it changes, by the values they had when you read them, and each new row is an `INSERT` of just the columns you gave it. If any row has changed or gone since then, or an `INSERT` doesn't add exactly one row, nothing is saved. The script runs in a transaction of its own, so a failure doesn't roll back one you had open. On SQL Server it's one `TRY`/`CATCH` batch with a savepoint. On PostgreSQL it's one `DO` block that checks each row count, inside a savepoint when a transaction is open. MySQL has no such block, so each statement carries a `-- trawl:one row:` line and Trawl checks its count itself; the statements run in a transaction of their own, or in a savepoint when one is open. When a save fails, Trawl goes back to the savepoint (or rolls back the save's own transaction). After saving new rows, Trawl runs the query again, so the grid shows them as the server has them, identity and defaults filled in (if the query's `TOP` or order leaves them out, they're saved all the same).
- The usual rules apply: a read-only connection refuses it until `/writes`, and with manual commit the changes wait for `/commit`.

Columns that are expressions or renamed in the query, identity (and `serial` or `AUTO_INCREMENT`) and computed or generated columns and `rowversion` can't be edited. Values are typed as the grid shows them: numbers, text, dates as `2026-10-20 15:30`, `1`/`0` (or `true`/`false`) for a bit or boolean, and binary as hex (`0x0A1B`); on Postgres and MySQL anything else, JSON or an enum say, goes to the server as text for it to read. If something can't be edited, `e` says why.

### Activity

The Activity tab (`6`, or `/activity`) lists the server's sessions, as SSMS's Activity Monitor does, read from `sys.dm_exec_sessions` and `sys.dm_exec_requests`: each one's status, what it waits on (`LCK_M_S`, `CXPACKET`…), how long it has run, its login and the SQL it is running (or ran last). Blocking chains come first, drawn as a tree: the session at the head (often one sitting idle with a transaction open), then the sessions waiting on it, and those waiting on them, with `▲` and a count on each session that blocks others. Sessions that are only sleeping are left out; `a` shows them too.

The list is read when the tab opens, and again on `R`. `↵` shows a session's details and its SQL in full. `x` (or `/kill <session>`) ends a session with `KILL`, after asking: what it hasn't committed is rolled back. A read-only connection refuses it until `/writes`, and so does an open transaction (KILL can't run inside one). Reading the sessions needs `VIEW SERVER STATE` (`VIEW DATABASE STATE` on Azure SQL Database, which lists that database's sessions only).

The tab has two more lists, and its title says which one is on screen. The same key again, or `esc`, goes back to the sessions.

- **SQL Agent jobs** (`J`, or `/jobs`): each job in `msdb`, whether it is running now (and since when), how its last run ended and how long it took, and when it runs next. Jobs whose last run failed are in red. `↵` shows a job's recent runs, each with its outcome, start and duration, and what its failed steps said. `s` starts a job with `sp_start_job`, after asking. Starting one counts as a write, so a read-only connection refuses it until `/writes`. Reading the jobs needs one of `msdb`'s SQL Agent roles (`SQLAgentReaderRole`, say) or sysadmin; without one, the list shows the server's error. Azure SQL Database and SQL Server Express have no SQL Agent, and the list says so. The times are the server's clock.
- **Top queries** (`Q`, or `/top-queries`): the queries that cost the most in the database you're in, with how often each ran, its total and average duration, CPU and logical reads, sorted by total duration. `o` sorts by CPU, reads or executions instead. They come from Query Store, over the last 24 hours. If Query Store is off for the database, the list says so and shows the plan cache instead (`sys.dm_exec_query_stats`, since the server last restarted), and the top of the list says which one you are looking at. `↵` shows a query in full, with how many plans it has had, and `e` puts it in the console. Reading them needs `VIEW DATABASE STATE` (`VIEW SERVER STATE` for the plan cache).

### Safety

- **Production is read-only.** On a connection added with `--prod`, anything that changes data is refused until `/writes`, which asks first and lasts until you disconnect.
- **Auto or manual commit, as DataGrip's Tx: Auto/Manual.** With manual commit, the first write starts a transaction, and the header shows `TRANSACTION OPEN` until you `/commit` or `/rollback`. With auto commit, each statement takes effect as it runs. Production connections use manual commit unless you change it. `/tx manual` or `/tx auto` switches the connection you're on and remembers it (switching production to auto asks first), `/add … --commit manual` sets it when adding, and a DataGrip data source set to manual comes across that way. Disconnecting, switching database or quitting with a transaction open asks first, because it rolls back.
- **Risky statements ask first, on every connection**: `UPDATE` or `DELETE` with no `WHERE`, `DROP` and `TRUNCATE`.
- **Writes say how many rows they change.** Before an `UPDATE` or `DELETE` runs, Trawl counts its rows with a `SELECT COUNT_BIG(*)` over the same `FROM` and `WHERE` (nothing is written to find out), and puts the number in the question. A `WHERE` that would still change more than 1,000 rows asks first too. `esc` while it counts cancels the write. Statements it can't count safely (`TOP`, `OUTPUT`, several at once) run as before.
- A statement counts as a write when it has `INSERT`, `UPDATE`, `DELETE`, `MERGE`, `SELECT … INTO`, DDL, `GRANT`/`REVOKE`, `DBCC`, or `EXEC` of anything except the read-only system procedures (`sp_help`, `sp_who2`, `sp_spaceused` and the like).

### Slash commands

Type `/` and the menu narrows as you type. `tab` completes, `↑`/`↓` picks, `↵` runs. `/connect` completes connection names, `/use` database names, `/describe` tables and views, and `/script` and `/uses` everything in the database.

`/import datagrip [folder]` `/import-csv <file.csv> <table> [--run]` `/connect <name>` `/add …` `/forget <name>` `/folder <connection> [folder]` `/password [connection]` `/disconnect` `/use <database>` `/open <file.sql>` `/snippet [name]` `/snippets` `/console` `/tab …` `/new` `/format` `/search <text>` `/save <file.sql>` `/describe <table>` `/script <name>` `/grep <text>` `/uses <object>` `/find [text]` `/export <file>` `/filter [text]` `/cell` `/follow` `/pin` `/compare` `/copy [tsv|csv|json|md|insert]` `/limit [rows]` `/writes` `/tx [auto|manual]` `/commit` `/rollback` `/ask <question>` `/explain` `/ai [connection] [level]` `/update` `/settings` `/stats [on|off]` `/plan [actual] [sql]` `/more` `/diff <connection> [database]` `/fanout <folder> [sql]` `/activity` `/jobs` `/top-queries` `/kill <session>` `/last` `/refresh` `/help` `/quit`

## Claude

### What Claude may see

Each connection has a Claude access level, shown in Connections and changed with `/ai`:

| Level | Claude sees |
| --- | --- |
| `schema` (the default) | Table and column names, the SQL, its plans, and error messages. Never rows. |
| `results` | Rows too, when it runs a query. `/ai results` asks first, since the data then leaves your machine. |
| `off` | Nothing. |

`/ai` on its own says the current level; `/ai results` sets it for the connection you're on, and `/ai <connection> <level>` for another. `/add … --ai <level>` sets it when adding. The demo connections allow everything; their data is made up.

### Ask for a query

`/ask top scorers per club this season` sends Claude the question and the database's tables and columns (names only, never rows) and puts the query it writes into the console, under the question and Claude's note as comments. **Nothing runs by itself**: read it, change it if you like, then `ctrl+r`. The usual checks apply when you do, so a risky statement still asks first.

It uses the Claude Code CLI you're already signed in to (`claude -p`), with no tools and none of your MCP servers, so Claude can only answer. Nothing to configure, and no API key. `esc` cancels while it thinks. A connection at the `off` level can't be asked about.

### Explain a plan

On a plan (`p` or `P` in the console, or `/plan`), `a` asks Claude to explain it, and `/explain` does the same for the last plan shown: what the plan does step by step, what is likely to cost the most (scans, lookups, sorts, conversions, a missing index) and what might help, with a `CREATE INDEX` when one would, and on an actual plan, where the estimates were far off. Claude gets the query and its plan text, never rows, so a connection at the `schema` level can ask; one at `off` can't. The answer opens in the viewer, and `/last` shows it again.

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

