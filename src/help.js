export const HELP = `Anywhere
  1-6 / tab        Explorer, Query, Results, History, Connections, Activity (shift+tab goes back)
  / or :           Command prompt (slash commands, with completion)
  !                Run SQL typed at the prompt, e.g.  !SELECT COUNT(*) FROM dbo.Players
  r                Reload the schema
  esc              Cancel the running query, or clear the activity lines
  ?                This help
  ,                Settings (/settings): row limit, accent colour, mouse, updates
  q / ctrl+c       Quit (asks first if a transaction is open)
  mouse            Click a tab, a row, a cell or the prompt · double-click does ↵ (but never runs a statement)
                   the wheel scrolls (shift+wheel: Results' columns) · drag to select text, copied when you let go
                   in the console: double-click a word, triple-click a line, click the gutter for the statement,
                   click a suggestion to take it; a drag selects the SQL (ctrl+r runs just that)

Lists
  j k / ↑ ↓        Move            g G         Top, bottom
  ctrl+d ctrl+u    Page down, up   J K         Scroll the right-hand pane

Explorer (the server's databases; the current one's tables, views and routines)
  ↵                First rows (SELECT TOP (limit) *); on another database, switch to it (/use)
  d                Describe: columns, types, keys
  s                Start a query on it in the console
  c                Its CREATE script, into the console (a table's from the catalog; others' from the server)
  /find <text>     Filter by name

Query, the console (a SQL editor, kept between sessions)
  ↵ or i           Start typing; while typing, every key is text (digits and q too)
  esc              Stop typing
  ctrl+r           Run the selection, or the statement under the cursor (marked ▌ in the gutter); the results show below
  R                Run the whole console
  j k  g G         Move between lines (when not typing)
  p                Its estimated plan, as text (/plan): nothing runs; there, a asks Claude to explain it (/explain)
  f                Format the statement under the cursor (or the selection): a clause a line, keywords in capitals
  ctrl+f  n N      Find (/search <text>) · the next match · the previous one (n N when not typing)
  Typing           arrows · home/end or ctrl+a/ctrl+e · ctrl+u/ctrl+k cut to start/end · tab two spaces
                   ctrl+←/→ a word at a time · ctrl+w delete a word · shift+movement selects (esc lets go)
  ctrl+z  ctrl+y   Undo · Redo (a word at a time; also when not typing, and /new can be undone too)
  Suggestions      tables, columns, keywords, JOIN … ON from foreign keys · tab take one · ↑↓ pick (then ↵ takes it)
                   they open by themselves after FROM, JOIN, ON, EXEC, USE · inside a call, its syntax shows above
                   esc close · ctrl+n (or ctrl+space) ask for them anywhere · tab after SELECT * writes out the columns
  /new  /save <file.sql>   Clear it · Write it to a file
  [  ]  +          Console tabs: the one before · the one after · a new one (/tab new [name])
  /tab …           /tab <name or number> switch · /tab rename <name> · /tab close · /tab alone lists them
  S                Save the statement under the cursor (or the selection) as a snippet (/snippet save <name>)

Snippets and parameters
  /snippets        The saved queries for this connection (and those saved while not connected): ↵ run · e edit · x forget
  /snippet <name>  Run one · /snippet save <name> · /snippet delete <name>
  @name            A variable the SQL uses without DECLARE is a parameter: Trawl asks for its value before running
                   (a number, NULL, or text, which it quotes); EXEC's argument names and @@functions aren't
  $(name)          sqlcmd variables too: :setvar name "value" gives one, any other is asked for

Query, a file (opened with /open; Trawl reloads it when you save; /console goes back)
  ↵                Run the statement under the cursor
  v                Start or end a selection of statements; ↵ then runs them together
  R                Run the whole file, batch by batch (split on GO)
  e                Copy the statement into the console to edit
  A statement ends at ;, a GO line or a blank line, except inside parentheses or BEGIN … END.
  Procedures, functions, triggers and views run on to the next GO.

Results
  j k              Rows            h l  ← →    Columns
  [ ]              Previous, next result set
  ↵                The row as a record, one column per line
  x                Export (/export <file.csv|file.json>)
  o                Sort by the column: A to Z, then Z to A, then as it came (the query doesn't run again)
  f                Filter: only rows with a value containing the text (/filter <text>; empty shows them all)
  y  Y             Copy the cell · the row (tab-separated); /copy [tsv|csv|json|insert] copies the whole set
  p  c             Pin the result set (/pin) · compare the one on screen with it (/compare): ~ changed, + added,
                   − removed, matched by the primary key when the rows are one table's, else row by row
  F                Follow the cell's foreign key (/follow): the row its value refers to, or on a key other
                   tables refer to, their rows (it asks which when there are several ways to go)
  Editing (the rows of one table, with its primary key: ↵ in the Explorer, or SELECT … FROM one table)
  e or i           Edit the cell: ↵ keeps it, tab keeps it and edits the next column, esc leaves it
  n                Make the cell NULL           d           Mark the row to delete (again: keep it)
  u                Undo the row's changes       U           Undo them all
  s                Save: shows the UPDATE/DELETE script and asks; each must find its row unchanged, or none is saved

History (every statement that ran, newest first; ◆ marks what Claude ran through trawl mcp)
  ↵                Run it again (the same checks apply)
  e                Copy it into the console to edit

Schema diff
  /diff <connection> [database]   Compare this database's schema with another's (/diff <database>: one on this server):
                   tables, columns, primary and foreign keys, indexes, and the definitions of views, procedures,
                   functions. < only here · > only there · ~ different. Then it offers the script that makes this
                   one match, in the console to read (dropping tables or columns is left commented out); nothing runs.

CSV import
  /import-csv <file.csv> <table> [--run]   The file's rows as INSERTs into the table, columns matched to its header
                   (case, spaces and _ ignored; identity columns left out); comma, semicolon or tab, quotes and
                   line breaks inside them. They open in a console tab to read; --run runs them (the usual checks apply).

Fan-out (one read-only query on every connection in a folder)
  /fanout <folder> [sql]   Runs it on each (and those in folders under it), four at a time; the rows come back
                   as one result set led by connection and database; a failing one says why and the rest go on.
                   Without sql: the console's selection, or its statement under the cursor. Writes are refused.

Connections (in folders; /import datagrip brings in DataGrip's data sources and folders)
  ↵                Connect         n           New (/add …)
  p                Password: saved in the OS credential store (Trawl also asks when you connect)
  f                Move to a folder (/folder <connection> [folder])
  x                Forget (and its saved password)

Activity (the server's sessions: blocking chains first, as a tree under the session at their head)
  R                Read them again (opening the tab reads them too)
  ↵                The session's details and SQL in full
  x                Kill the session (/kill <session>): asks first; refused on a read-only connection until /writes
  a                Show the idle sessions too, or only what's running, waiting or holding a transaction

Settings (, or /settings: Trawl's own; a connection's are on Connections)
  ↵ or space       Change it: the row limit, the accent colour, the mouse, checking for and installing updates,
                   and notifying when a run takes over 10 s (a bell and a desktop notification)
  esc / q          Close

Claude
  /ask <question>  Claude writes a query from the schema; it lands in the console, and nothing runs until ctrl+r
  /explain         Claude explains the last plan: what it does, what costs most, what might help (the query and plan only)
  /ai [connection] [off|schema|results]   What Claude may see: nothing, names only (the default), or rows too
  trawl mcp        Run from Claude Code (claude mcp add --scope user trawl -- trawl mcp); it only reads

Safety
  A production connection (/add … --prod) is read-only: writes are refused until /writes.
  /tx manual (production's default, as DataGrip's Tx: Manual): a write starts a transaction,
  /commit keeps it, /rollback undoes it. /tx auto commits each statement as it runs.
  UPDATE or DELETE with no WHERE, DROP and TRUNCATE always ask first. Before an UPDATE or DELETE runs,
  a SELECT COUNT over its FROM and WHERE says how many rows it changes; over 1,000, it asks first too.

Prompt
  tab              Complete        ↑ ↓         Pick a suggestion, or walk history
  esc              Back to the view (the text is kept)
  ctrl+u ctrl+w    Clear the line · Delete a word

Slash commands
  /import datagrip [folder]   /import-csv <file.csv> <table> [--run]   /connect <name>
  /add <name> <server> [database] [--kind sqlserver|postgres|mysql] [--user u] [--domain d] [--folder f] [--prod] [--commit auto|manual] [--trust-cert] [--ssl]
  /forget <name>   /folder <connection> [folder]   /password [connection]   /disconnect   /use <database>   /open <file.sql>   /console   /tab …   /new   /format   /search <text>   /save <file.sql>
  /describe <table>   /script <name>   /find [text]
  /export <file>   /filter [text]   /follow   /pin   /compare   /copy [format]   /limit [rows]   /writes   /tx [auto|manual]   /commit   /rollback   /ask <question>   /explain   /ai   /update   /settings   /stats [on|off]   /plan [sql]   /diff <connection> [database]   /fanout <folder> [sql]   /activity   /kill <session>   /last   /refresh   /help   /quit

Viewer (describe, records, output, this help)
  j k  space  g G  Scroll         esc / q     Close`;
