export const HELP = `Anywhere
  1-5 / tab        Explorer, Query, Results, History, Connections (shift+tab goes back)
  / or :           Command prompt (slash commands, with completion)
  !                Run SQL typed at the prompt, e.g.  !SELECT COUNT(*) FROM dbo.Players
  r                Reload the schema
  esc              Cancel the running query, or clear the activity lines
  ?                This help
  ,                Settings (/settings)
  q / ctrl+c       Quit (asks first if a transaction is open)

Lists
  j k / ↑ ↓        Move            g G         Top, bottom
  ctrl+d ctrl+u    Page down, up   J K         Scroll the right-hand pane

Explorer (tables, views and routines of the current database)
  ↵                First rows (SELECT TOP (limit) *)
  d                Describe: columns, types, keys
  s                Start a query on it in the console
  /find <text>     Filter by name

Query, the console (a SQL editor, kept between sessions)
  ↵ or i           Start typing; while typing, every key is text (digits and q too)
  esc              Stop typing
  ctrl+r           Run the selection, or the statement under the cursor (marked ▌ in the gutter); the results show below
  R                Run the whole console
  j k  g G         Move between lines (when not typing)
  Typing           arrows · home/end or ctrl+a/ctrl+e · ctrl+u/ctrl+k cut to start/end · tab two spaces
                   ctrl+←/→ a word at a time · ctrl+w delete a word · shift+movement selects (esc lets go)
  ctrl+z  ctrl+y   Undo · Redo (a word at a time; also when not typing, and /new can be undone too)
  Suggestions      tables, columns, keywords, JOIN … ON from foreign keys · tab take one · ↑↓ pick (then ↵ takes it)
                   esc close · ctrl+space ask for them anywhere · tab after SELECT * writes out the columns
  /new  /save <file.sql>   Clear it · Write it to a file

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
  Editing (the rows of one table, with its primary key: ↵ in the Explorer, or SELECT … FROM one table)
  e or i           Edit the cell: ↵ keeps it, tab keeps it and edits the next column, esc leaves it
  n                Make the cell NULL           d           Mark the row to delete (again: keep it)
  u                Undo the row's changes       U           Undo them all
  s                Save: shows the UPDATE/DELETE script and asks; each must find its row unchanged, or none is saved

History (every statement that ran, newest first; ◆ marks what Claude ran through trawl mcp)
  ↵                Run it again (the same checks apply)
  e                Copy it into the console to edit

Connections (in folders; /import datagrip brings in DataGrip's data sources and folders)
  ↵                Connect         n           New (/add …)
  p                Password: saved in the OS credential store (Trawl also asks when you connect)
  f                Move to a folder (/folder <connection> [folder])
  x                Forget (and its saved password)

Settings (, or /settings: Trawl's own; a connection's are on Connections)
  ↵ or space       Change it: the row limit, the accent colour, checking for and installing updates
  esc / q          Close

Claude
  /ask <question>  Claude writes a query from the schema; it lands in the console, and nothing runs until ctrl+r
  /ai [connection] [off|schema|results]   What Claude may see: nothing, names only (the default), or rows too
  trawl mcp        Run from Claude Code (claude mcp add --scope user trawl -- trawl mcp); it only reads

Safety
  A production connection (/add … --prod) is read-only: writes are refused until /writes.
  /tx manual (production's default, as DataGrip's Tx: Manual): a write starts a transaction,
  /commit keeps it, /rollback undoes it. /tx auto commits each statement as it runs.
  UPDATE or DELETE with no WHERE, DROP and TRUNCATE always ask first.

Prompt
  tab              Complete        ↑ ↓         Pick a suggestion, or walk history
  esc              Back to the view (the text is kept)
  ctrl+u ctrl+w    Clear the line · Delete a word

Slash commands
  /import datagrip [folder]   /connect <name>   /add <name> <server> [database] [--user u] [--domain d] [--folder f] [--prod] [--commit auto|manual] [--trust-cert]
  /forget <name>   /folder <connection> [folder]   /password [connection]   /disconnect   /use <database>   /open <file.sql>   /console   /new   /save <file.sql>
  /describe <table>   /find [text]
  /export <file>   /limit [rows]   /writes   /tx [auto|manual]   /commit   /rollback   /ask <question>   /ai   /update   /settings   /last   /refresh   /help   /quit

Viewer (describe, records, output, this help)
  j k  space  g G  Scroll         esc / q     Close`;
