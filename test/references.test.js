import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DIALECTS, definitionSqlFor, likePattern } from '../src/dialects.js';
import { demoSession } from '../src/demo.js';
import { grepHits, matchesIn, mentions, usesReport, usesText } from '../src/references.js';
import { buildSchema, findObject, rowsOf } from '../src/schema.js';

const { postgres: PG, mysql: MY, sqlserver: MS } = DIALECTS;

async function demo() {
  const s = demoSession({ name: 'demo' });
  return { s, schema: buildSchema((await s.run(MS.schemaSql)).sets) };
}

test('the text goes into LIKE with its own wildcards escaped, as each kind writes a string safely', () => {
  assert.equal(likePattern('50%_x!'), '%50!%!_x!!%');
  assert.equal(likePattern('[A]', { brackets: true }), '%![a]%', 'SQL Server reads [ as a wildcard too');
  assert.match(MS.grepSql("it's"), /LIKE LOWER\(N'%it''s%'\) ESCAPE N'!'/);
  assert.match(MS.grepSql('x'), /sys\.sql_modules[\s\S]*o\.type IN \('V', 'P', 'FN', 'IF', 'TF', 'TR'\)/);
  assert.match(PG.grepSql("a\\b'c"), /ILIKE E'%a\\\\b''c%' ESCAPE '!'/);
  assert.match(PG.grepSql('x'), /pg_get_viewdef[\s\S]*pg_get_functiondef[\s\S]*pg_get_triggerdef/);
  // Hex, so no sql_mode reads a quote or a backslash in it differently.
  assert.match(MY.grepSql("O'k"), /LIKE LOWER\(CONVERT\(X'256f276b25' USING utf8mb4\)\) ESCAPE '!'/);
  assert.match(MY.grepSql('x'), /information_schema\.routines[\s\S]*information_schema\.views[\s\S]*information_schema\.triggers/);
  assert.match(MS.usesSql({ schema: 'dbo', name: "O'k" }), /@name sysname = N'O''k'[\s\S]*sys\.sql_expression_dependencies[\s\S]*sys\.triggers/);
  assert.match(PG.usesSql({ schema: 'public', name: 'clubs' }), /to_regclass\(E'"public"\."clubs"'\)[\s\S]*pg_rewrite[\s\S]*pg_trigger/);
  assert.match(MY.usesSql({ schema: 'shop', name: 't' }), /event_object_table = CONVERT\(X'74' USING utf8mb4\)/);
  assert.match(definitionSqlFor(MY, { schema: 'shop', name: 'tr', kind: 'trigger' }), /^SHOW CREATE TRIGGER `shop`\.`tr`;$/);
  assert.match(definitionSqlFor(PG, { schema: 'public', name: 'tr', kind: 'trigger' }), /pg_get_triggerdef[\s\S]*t\.tgname = 'tr'/);
});

test('matches: each line once with how many times it has the text, ignoring case', () => {
  assert.deepEqual(matchesIn('SELECT a\r\n  FROM T t -- t again\nWHERE 1 = 1', 't'), {
    count: 4,
    lines: [
      { line: 1, text: 'SELECT a' },
      { line: 2, text: 'FROM T t -- t again' },
    ],
  });
  assert.deepEqual(matchesIn(null, 'x'), { count: 0, lines: [] });
  assert.equal(mentions('FROM dbo.[Players] p', 'players'), true);
  assert.equal(mentions('FROM dbo.PlayersArchive', 'Players'), false);
  assert.equal(mentions('FROM #Players', 'Players'), false);
});

test('/grep on the demo finds the view and the trigger, with their first matching line', async () => {
  const { s } = await demo();
  const hits = grepHits((await s.run(MS.grepSql('DBO.players'))).sets, 'DBO.players');
  assert.deepEqual(
    hits.map((h) => [h.schema, h.name, h.kind, h.parent, h.count, h.lines[0].line, h.lines[0].text]),
    [
      ['dbo', 'vTopScorers', 'view', null, 1, 3, 'FROM dbo.Players'],
      ['dbo', 'trg_Players_Goals', 'trigger', 'Players', 1, 1, 'CREATE TRIGGER dbo.trg_Players_Goals ON dbo.Players AFTER UPDATE AS'],
    ],
  );
  assert.deepEqual(grepHits((await s.run(MS.grepSql('50%'))).sets, '50%'), [], 'a % in the text is only a %');
});

test('/uses on the demo: what refers to a table, the triggers on it, and the foreign keys both ways', async () => {
  const { s, schema } = await demo();
  const report = async (name) => {
    const o = findObject(schema, name);
    const rows = (await s.run(MS.usesSql(o))).sets.flatMap(rowsOf);
    return usesText(o, usesReport(o, schema, { rows }), { database: 'ClubA' });
  };
  const players = await report('Players');
  assert.match(players, /^table dbo\.Players in ClubA\n\nUsed by\n  Views\n    dbo\.vTopScorers\n  Triggers on it\n    dbo\.trg_Players_Goals\n\nUses\n  Tables, through its foreign keys\n    dbo\.Clubs \(ClubId → Id\)  FK_Players_Clubs\n/);
  assert.doesNotMatch(players, /Triggers\n/, 'the trigger is listed once, as one on it');
  assert.match(await report('Clubs'), /Procedures\n    dbo\.usp_RecalculateTable\n  Tables, through their foreign keys\n    dbo\.Players \(ClubId\) → Id  FK_Players_Clubs\n    dbo\.Matches \(HomeId\) → Id  FK_Matches_Home/);
  assert.match(await report('usp_RecalculateTable'), /Used by\n  Nothing found\.\n\nUses\n  Tables\n    dbo\.Clubs\n    dbo\.Matches\n/);
  assert.match(await report('Players'), /sys\.sql_expression_dependencies/);
});

test('where the catalog says less, what refers to it is found by name, and marked so', () => {
  const schema = {
    objects: [
      { schema: 'public', name: 'clubs', kind: 'table', columns: [] },
      { schema: 'public', name: 'players', kind: 'table', columns: [] },
      { schema: 'public', name: 'club_count', kind: 'function', columns: [] },
    ],
    foreignKeys: [{ name: 'players_club_fk', from: 'public.players', to: 'public.clubs', columns: [['club_id', 'id']] }],
  };
  const clubs = schema.objects[0];
  const rows = [
    { rel: 'used_by', schema: 'public', name: 'v_clubs', type: 'V' },
    { rel: 'trigger', schema: 'public', name: 'clubs_audit', type: 'TR', parent: 'clubs' },
  ];
  const named = [
    { schema: 'public', name: 'club_count', type: 'FN', definition: 'CREATE FUNCTION public.club_count() … SELECT count(*) FROM public.clubs' },
    { schema: 'public', name: 'clubs_audit', type: 'TR', parent: 'clubs', definition: 'CREATE TRIGGER clubs_audit AFTER UPDATE ON public.clubs …' },
    { schema: 'public', name: 'v_clubs2', type: 'V', definition: 'SELECT * FROM clubs' },
    { schema: 'public', name: 'clubsx', type: 'FN', definition: 'SELECT * FROM clubsx_table' },
  ];
  const byName = PG.usesByName;
  const r = usesReport(clubs, schema, { rows, named, byName });
  assert.deepEqual(r.usedBy.map((x) => [x.kind, x.name, x.byName]), [['view', 'v_clubs', false], ['function', 'club_count', true]], "views come from the catalog only; a trigger on it isn't counted twice");
  assert.deepEqual(r.triggers.map((x) => x.name), ['clubs_audit']);
  const text = usesText(clubs, r, { label: 'PostgreSQL', byName });
  assert.match(text, /Functions\n    public\.club_count  · by name\n  Triggers on it\n    public\.clubs_audit\n  Tables, through their foreign keys\n    public\.players \(club_id\) → id  players_club_fk/);
  assert.match(text, /PostgreSQL's catalog doesn't record what routines and triggers refer to/);
  // A routine's own definition, read for the other objects' names.
  const fn = schema.objects[2];
  const own = usesReport(fn, schema, { own: 'CREATE FUNCTION public.club_count() RETURNS bigint AS $$ SELECT count(*) FROM clubs JOIN players USING (id) $$', byName });
  assert.deepEqual(own.uses.map((x) => [x.name, x.byName]), [['clubs', true], ['players', true]]);
  assert.match(usesText(fn, own, { label: 'PostgreSQL', byName }), /Uses\n  Tables\n    public\.clubs  · by name\n    public\.players  · by name/);
});
