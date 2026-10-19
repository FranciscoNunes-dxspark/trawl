# Fathom

A keyboard-driven SQL Server client for the terminal, built the same way as [Tiller](https://github.com/FranciscoNunes-dxspark/tiller): titled rounded panels, a prompt box with slash commands and completion, `!` to run any SQL, and a running log of what each statement did.

```
≋ Fathom  │  club-a  myserver.database.windows.net/ClubA   PROD   read-only
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
cd C:\Team\Fathom
npm install
npm link          # puts a `fathom` command on your PATH
```

Without `npm link`, run it with `node C:\Team\Fathom\bin\fathom.js`. `npm run build` makes a single executable in `dist/` that needs nothing else installed.

## Try it without a server

```bash
fathom --demo
```

This adds two in-memory connections for the session: `demo`, and `demo-prod`, which behaves like a production connection. Each has the databases `ClubA` and `ClubB`. The demo has no SQL engine. It answers the catalog, `SELECT [TOP (n)] * FROM` a table, simple `SELECT` lists, `USE`, transactions, `WAITFOR DELAY` (to try cancelling) and `RAISERROR`/`THROW`. Writes only report how many rows they would touch.

## Connect

```bash
fathom                       # the connection you used last
fathom query.sql             # and open a script in Query
fathom --connect club-a      # a specific connection
```

Save connections with `/add`:

| | |
| --- | --- |
| Azure SQL, signing in with your `az login` | `/add club-a myserver.database.windows.net ClubA` |
| The same, as production | `/add club-a-prod myserver.database.windows.net ClubA --prod` |
| A SQL login | `/add local localhost,1433 Dev --user sa --password-env SA_PASSWORD --trust-cert` |
| Windows (NTLM) | `/add corp sqlhost\SQLEXPRESS Dev --user me --domain CORP --password-env CORP_PW` |

Fathom never stores a password or token. Azure SQL gets a fresh token from the Azure CLI each time it connects. A SQL or Windows login reads its password from the environment variable you name. Connections live in `~/.fathom/config.json` (or `FATHOM_HOME`), along with the prompt history, the run history and the row limit.

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

`/open <file.sql>` lists the file's statements in Query. Edit the file in your own editor: Fathom reloads it each time you save. A statement ends at `;`, at a `GO` line or at a blank line, except inside parentheses or a `BEGIN … END` block (`IF … ELSE` and `TRY … CATCH` stay together). A procedure, function, trigger or view runs on to the next `GO`, as SQL Server requires. `R` runs the whole file batch by batch, and `GO 3` runs a batch three times.

Errors say which line of the file they're on.

### Results

Each result set stops at the row limit (500 to start with; `/limit <n>` changes it). Fathom cancels the query there instead of pulling the rest of the table over the network. `NULL` is shown as `NULL`, dates as `2026-10-19 15:14:35`, and binary as `0x…` hex. `/export <file.csv>` or `/export <file.json>` saves the result set on screen.

### Safety

- **Production is read-only.** On a connection added with `--prod`, anything that changes data is refused until `/writes`, which asks first and lasts until you disconnect.
- **Production writes run in a transaction.** The first write starts one, and the header shows `TRANSACTION OPEN` until you `/commit` or `/rollback`. Disconnecting, switching database or quitting with a transaction open asks first, because it rolls back.
- **Risky statements ask first, on every connection**: `UPDATE` or `DELETE` with no `WHERE`, `DROP` and `TRUNCATE`.
- A statement counts as a write when it has `INSERT`, `UPDATE`, `DELETE`, `MERGE`, `SELECT … INTO`, DDL, `GRANT`/`REVOKE`, `DBCC`, or `EXEC` of anything except the read-only system procedures (`sp_help`, `sp_who2`, `sp_spaceused` and the like).

### Slash commands

Type `/` and the menu narrows as you type. `tab` completes, `↑`/`↓` picks, `↵` runs. `/connect` completes connection names, `/use` database names and `/describe` tables and views.

`/connect <name>` `/add …` `/forget <name>` `/disconnect` `/use <database>` `/open <file.sql>` `/describe <table>` `/find [text]` `/export <file>` `/limit [rows]` `/writes` `/commit` `/rollback` `/last` `/refresh` `/help` `/quit`

## Not yet

- Postgres and MySQL (the driver layer is one interface, so they'd be new adapters).
- Running one query across a group of databases, with each row tagged by database.
- Schema diff between two databases.
- An Activity view: sessions, blocking, kill.
