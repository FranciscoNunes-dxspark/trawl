<p align="center"><img src="assets/glim.svg" width="128" alt="Glim, the Trawl anglerfish"></p>

# Trawl

A keyboard-driven SQL Server client for the terminal, built the same way as [Tiller](https://github.com/FranciscoNunes-dxspark/tiller): titled rounded panels, a prompt box with slash commands and completion, `!` to run any SQL, and a running log of what each statement did.

```
><((•> Trawl  │  club-a  myserver.database.windows.net/ClubA   PROD   read-only
 1 Explorer   2 Query   3 Results   4 History   5 Connections
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

**From source** (Node 22+):

```bash
cd C:\Team\Trawl
npm install
npm link          # puts a `trawl` command on your PATH
```

Without `npm link`, run it with `node C:\Team\Trawl\bin\trawl.js`. `npm run build` makes a single executable in `dist/` that needs nothing else installed.

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
| A SQL login | `/add local localhost,1433 Dev --user sa --password-env SA_PASSWORD --trust-cert` |
| Windows (NTLM) | `/add corp sqlhost\SQLEXPRESS Dev --user me --domain CORP --password-env CORP_PW` |

Trawl never stores a password or token. Azure SQL gets a fresh token from the Azure CLI each time it connects. A SQL or Windows login reads its password from the environment variable you name. Connections live in `~/.trawl/config.json` (or `TRAWL_HOME`), along with the prompt history, the run history and the row limit.

`/use <database>` switches database by reconnecting. That works on Azure SQL Database too, where `USE` doesn't.

## Use

Press `?` inside for every shortcut. The essentials:

| Where | Keys |
| --- | --- |
| Anywhere | `1`–`5` or `tab` switch views · `/` commands · `!` SQL · `r` reload the schema · `esc` cancel the running query · `q` quit |
| Lists | `j`/`k` or arrows · `g`/`G` top/bottom · `ctrl+d`/`ctrl+u` page |
| Explorer | `↵` first rows · `d` describe · `s` start a query on it · `/find <text>` filter |
| Query | `↵` run the statement under the cursor · `v` select several · `R` run the whole file · `e` copy to the prompt |
| Results | `h`/`l` columns · `[`/`]` result sets · `↵` the row as a record · `x` export |
| History | `↵` run again · `e` copy to the prompt |
| Connections | `↵` connect · `n` new · `x` forget |

SQL typed at the prompt runs with `!`, or without it when it starts with a SQL keyword (`select …`, `exec …`).

### Scripts

`/open <file.sql>` lists the file's statements in Query. Edit the file in your own editor: Trawl reloads it each time you save. A statement ends at `;`, at a `GO` line or at a blank line, except inside parentheses or a `BEGIN … END` block (`IF … ELSE` and `TRY … CATCH` stay together). A procedure, function, trigger or view runs on to the next `GO`, as SQL Server requires. `R` runs the whole file batch by batch, and `GO 3` runs a batch three times.

Errors say which line of the file they're on.

### Results

Each result set stops at the row limit (500 to start with; `/limit <n>` changes it). Trawl cancels the query there instead of pulling the rest of the table over the network. `NULL` is shown as `NULL`, dates as `2026-10-19 15:14:35`, and binary as `0x…` hex. `/export <file.csv>` or `/export <file.json>` saves the result set on screen.

### Safety

- **Production is read-only.** On a connection added with `--prod`, anything that changes data is refused until `/writes`, which asks first and lasts until you disconnect.
- **Production writes run in a transaction.** The first write starts one, and the header shows `TRANSACTION OPEN` until you `/commit` or `/rollback`. Disconnecting, switching database or quitting with a transaction open asks first, because it rolls back.
- **Risky statements ask first, on every connection**: `UPDATE` or `DELETE` with no `WHERE`, `DROP` and `TRUNCATE`.
- A statement counts as a write when it has `INSERT`, `UPDATE`, `DELETE`, `MERGE`, `SELECT … INTO`, DDL, `GRANT`/`REVOKE`, `DBCC`, or `EXEC` of anything except the read-only system procedures (`sp_help`, `sp_who2`, `sp_spaceused` and the like).

### Slash commands

Type `/` and the menu narrows as you type. `tab` completes, `↑`/`↓` picks, `↵` runs. `/connect` completes connection names, `/use` database names and `/describe` tables and views.

`/connect <name>` `/add …` `/forget <name>` `/disconnect` `/use <database>` `/open <file.sql>` `/describe <table>` `/find [text]` `/export <file>` `/limit [rows]` `/writes` `/commit` `/rollback` `/update` `/last` `/refresh` `/help` `/quit`

## Updates

Once a day, in the background, Trawl asks GitHub for the latest release of [FranciscoNunes-dxspark/trawl](https://github.com/FranciscoNunes-dxspark/trawl/releases). If there's a newer one, the header shows `↑ 0.2.0` and the activity log says so once per start. `/update` checks right away and says how to update: for the executable, the file to download (replace the old one after quitting); for a checkout, `git pull && npm install`. Trawl never downloads or replaces anything itself.

The check is one GET request with `trawl/<version>` as the user agent. Nothing about your connections or queries is sent. When it fails (offline, say), it stays silent and tries again the next day. To turn it off, set `"checkUpdates": false` in `~/.trawl/config.json`, or the environment variable `TRAWL_NO_UPDATE_CHECK=1`.

## Glim

Glim is Trawl's anglerfish: it carries its own light into the deep, which is roughly what a query does. It says hello in the welcome box when Trawl starts (if the terminal is tall enough), and a small fish in the header shows how it feels:

| | |
| --- | --- |
| `><((–>` | Not connected: asleep, lure dimmed |
| `><((•>` | Connected, looking around (it glances side to side while a query runs) |
| `><((^>` | A query just worked |
| `><((◉>` | Something just went wrong |
| `><((!>` | A transaction is open: the lure glows red until `/commit` or `/rollback` |

The logo and the Windows icon in `assets/` are drawn from the same pixels (`src/glim.js`); `node scripts/logo.js` regenerates them.

## Not yet

- Postgres and MySQL (the driver layer is one interface, so they'd be new adapters).
- Running one query across a group of databases, with each row tagged by database.
- Schema diff between two databases.
- An Activity view: sessions, blocking, kill.
