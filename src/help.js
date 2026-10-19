export const HELP = `Anywhere
  1-5 / tab        Explorer, Query, Results, History, Connections (shift+tab goes back)
  / or :           Command prompt (slash commands, with completion)
  !                Run SQL typed at the prompt, e.g.  !SELECT COUNT(*) FROM dbo.Players
  r                Reload the schema
  esc              Cancel the running query, or clear the activity lines
  ?                This help
  q / ctrl+c       Quit (asks first if a transaction is open)

Lists
  j k / ↑ ↓        Move            g G         Top, bottom
  ctrl+d ctrl+u    Page down, up   J K         Scroll the right-hand pane

Explorer (tables, views and routines of the current database)
  ↵                First rows (SELECT TOP (limit) *)
  d                Describe: columns, types, keys
  s                Start a query on it at the prompt
  /find <text>     Filter by name

Query (a .sql file opened with /open; Trawl reloads it when you save)
  ↵                Run the statement under the cursor
  v                Start or end a selection of statements; ↵ then runs them together
  R                Run the whole file, batch by batch (split on GO)
  e                Copy the statement to the prompt as !SQL
  A statement ends at ;, a GO line or a blank line, except inside parentheses or BEGIN … END.
  Procedures, functions, triggers and views run on to the next GO.

Results
  j k              Rows            h l  ← →    Columns
  [ ]              Previous, next result set
  ↵                The row as a record, one column per line
  x                Export (/export <file.csv|file.json>)

History (every statement that ran, newest first)
  ↵                Run it again (the same checks apply)
  e                Copy it to the prompt as !SQL

Connections
  ↵                Connect         n           New (/add …)
  x                Forget

Safety
  A production connection (/add … --prod) is read-only: writes are refused until /writes.
  Then each write starts a transaction: /commit keeps it, /rollback undoes it.
  UPDATE or DELETE with no WHERE, DROP and TRUNCATE always ask first.

Prompt
  tab              Complete        ↑ ↓         Pick a suggestion, or walk history
  esc              Back to the view (the text is kept)
  ctrl+u ctrl+w    Clear the line · Delete a word

Slash commands
  /connect <name>   /add <name> <server> [database] [--user u --password-env VAR] [--domain d] [--prod] [--trust-cert]
  /forget <name>   /disconnect   /use <database>   /open <file.sql>   /describe <table>   /find [text]
  /export <file>   /limit [rows]   /writes   /commit   /rollback   /update   /last   /refresh   /help   /quit

Viewer (describe, records, output, this help)
  j k  space  g G  Scroll         esc / q     Close`;
