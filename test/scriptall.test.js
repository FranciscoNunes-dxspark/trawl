import { test } from 'node:test';
import assert from 'node:assert/strict';
import { demoSession } from '../src/demo.js';
import { DIALECTS } from '../src/dialects.js';
import { SCHEMA_SQL, buildSchema, rowsOf } from '../src/schema.js';
import { EXTRAS_SQL, buildTableExtras, columnNames, createKey, fileName, fileText, inLayout, planFiles, scriptFiles, summaryLine, summaryText, tableFile, uniqueColumns, withoutAutoIncrement } from '../src/scriptall.js';

const { sqlserver: MS, postgres: PG, mysql: MY } = DIALECTS;

async function demo(database = 'ClubA') {
  const s = demoSession({ name: 'demo', demo: true, database });
  const schema = buildSchema((await s.run(SCHEMA_SQL, { limit: 1e6 })).sets);
  const extras = buildTableExtras((await s.run(EXTRAS_SQL.sqlserver, { limit: 1e6 })).sets);
  const modules = rowsOf((await s.run(MS.grepSql(''), { limit: 1e6 })).sets[0]);
  return { schema, extras, modules };
}

test('every object gets a file of its own in the layout, tables with their keys, defaults, checks and indexes', async () => {
  const { files, skipped } = scriptFiles({ ...(await demo()), dialect: MS });
  assert.deepEqual(files.map((f) => f.path), [
    'dbo/Procedures/usp_RecalculateTable.sql',
    'dbo/Tables/Clubs.sql',
    'dbo/Tables/Matches.sql',
    'dbo/Tables/Players.sql',
    'dbo/Triggers/trg_Players_Goals.sql',
    'dbo/Views/vTopScorers.sql',
    'i18n/Tables/Translations.sql',
  ]);
  assert.deepEqual(skipped, []);
  const players = files.find((f) => f.path === 'dbo/Tables/Players.sql').text;
  assert.equal(
    players,
    [
      'CREATE TABLE [dbo].[Players] (',
      '  [Id] int IDENTITY(1,1) NOT NULL,',
      '  [ClubId] int NOT NULL,',
      '  [Name] nvarchar(100) NOT NULL,',
      '  [Position] char(2) NOT NULL,',
      '  [Shirt] tinyint NULL,',
      '  [Goals] int NOT NULL CONSTRAINT [DF_Players_Goals] DEFAULT ((0)),',
      '  CONSTRAINT [PK_Players] PRIMARY KEY CLUSTERED ([Id]),',
      '  CONSTRAINT [CK_Players_Goals] CHECK ([Goals]>=(0))',
      ');',
      'ALTER TABLE [dbo].[Players] ADD CONSTRAINT [FK_Players_Clubs]',
      '  FOREIGN KEY ([ClubId]) REFERENCES [dbo].[Clubs] ([Id]);',
      'CREATE NONCLUSTERED INDEX [IX_Players_ClubId] ON [dbo].[Players] ([ClubId]);',
      '',
    ].join('\n'),
  );
  assert.match(files.find((f) => f.path === 'i18n/Tables/Translations.sql').text, /CONSTRAINT \[PK_Translations\] PRIMARY KEY CLUSTERED \(\[ResourceKey\], \[Culture\]\)/);
  for (const f of files) assert.ok(f.text.endsWith('\n') && !f.text.endsWith('\n\n') && !f.text.includes('\r'), f.path);
  // The same database, the same bytes.
  assert.deepEqual(scriptFiles({ ...(await demo()), dialect: MS }).files, files);
});

test('an identity seed, a computed column, a unique constraint and other kinds of index', () => {
  const o = { schema: 'dbo', name: 'Orders', kind: 'table', columns: [{ name: 'Id', type: 'bigint', identity: true, pk: true }, { name: 'Code', type: 'varchar(10)' }, { name: 'Total', type: 'decimal(10,2)', computed: true }] };
  const extras = buildTableExtras([
    { columns: [], rows: [] },
    { columns: [], rows: [] },
    {
      columns: ['schema', 'object', 'name', 'is_unique', 'is_unique_constraint', 'is_primary_key', 'type_desc', 'filter_definition', 'columns', 'included', 'definition'].map((name) => ({ name })),
      rows: [
        ['dbo', 'Orders', 'PK_Orders', 1, 0, 1, 'NONCLUSTERED', null, '[Id]', null, null],
        ['dbo', 'Orders', 'UQ_Orders_Code', 1, 1, 0, 'NONCLUSTERED', null, '[Code]', null, null],
        ['dbo', 'Orders', 'IX_Orders_Code', 0, 0, 0, 'NONCLUSTERED', '([Code] IS NOT NULL)', '[Code] DESC', '[Total]', null],
        ['dbo', 'Orders', 'CCI', 0, 0, 0, 'CLUSTERED COLUMNSTORE', null, null, null, null],
      ],
    },
    { columns: ['schema', 'object', 'column', 'seed', 'increment'].map((name) => ({ name })), rows: [['dbo', 'Orders', 'Id', '1000', '5']] },
    { columns: ['schema', 'object', 'column', 'definition', 'is_persisted'].map((name) => ({ name })), rows: [['dbo', 'Orders', 'Total', '([Id]*(2))', true]] },
  ]);
  assert.equal(
    tableFile(o, { foreignKeys: [] }, extras, MS),
    [
      'CREATE TABLE [dbo].[Orders] (',
      '  [Id] bigint IDENTITY(1000,5) NOT NULL,',
      '  [Code] varchar(10) NOT NULL,',
      '  [Total] AS ([Id]*(2)) PERSISTED,',
      '  CONSTRAINT [PK_Orders] PRIMARY KEY NONCLUSTERED ([Id]),',
      '  CONSTRAINT [UQ_Orders_Code] UNIQUE NONCLUSTERED ([Code])',
      ');',
      'CREATE NONCLUSTERED INDEX [IX_Orders_Code] ON [dbo].[Orders] ([Code] DESC) INCLUDE ([Total]) WHERE ([Code] IS NOT NULL);',
      "-- [CCI]: a clustered columnstore index, which Trawl doesn't script.",
    ].join('\n'),
  );
  assert.deepEqual(uniqueColumns(extras, o), ['Code']);
  assert.deepEqual(columnNames('[a]]b], [c] DESC'), ['a]b', 'c']);
  assert.deepEqual(columnNames('"Mixed", plain, `x`'), ['Mixed', 'plain', 'x']);
});

test('Postgres: defaults and checks as the server writes them, indexes from pg_get_indexdef', () => {
  const o = { schema: 'public', name: 'clubs', kind: 'table', columns: [{ name: 'id', type: 'integer', identity: true, pk: true }, { name: 'name', type: 'text' }, { name: 'active', type: 'boolean' }, { name: 'upper_name', type: 'text', nullable: true }] };
  const set = (names, rows) => ({ columns: names.map((name) => ({ name })), rows });
  const extras = buildTableExtras([
    set(['schema', 'object', 'column', 'name', 'definition'], [['public', 'clubs', 'active', null, 'true']]),
    set(['schema', 'object', 'name', 'definition'], [['public', 'clubs', 'clubs_name_check', 'CHECK (length(name) > 0)']]),
    set(['schema', 'object', 'name', 'is_unique', 'is_unique_constraint', 'is_primary_key', 'type_desc', 'filter_definition', 'columns', 'included', 'definition'], [
      ['public', 'clubs', 'clubs_pkey', true, false, true, null, null, 'id', null, 'CREATE UNIQUE INDEX clubs_pkey ON public.clubs USING btree (id)'],
      ['public', 'clubs', 'clubs_name_idx', false, false, false, null, null, 'name', null, 'CREATE INDEX clubs_name_idx ON public.clubs USING btree (lower(name))'],
    ]),
    set(['schema', 'object', 'column', 'seed', 'increment'], []),
    set(['schema', 'object', 'column', 'definition', 'is_persisted'], [['public', 'clubs', 'upper_name', 'upper(name)', true]]),
  ]);
  assert.equal(
    tableFile(o, { foreignKeys: [] }, extras, PG),
    [
      'CREATE TABLE "public"."clubs" (',
      '  "id" integer GENERATED BY DEFAULT AS IDENTITY NOT NULL,',
      '  "name" text NOT NULL,',
      '  "active" boolean NOT NULL DEFAULT true,',
      '  "upper_name" text GENERATED ALWAYS AS (upper(name)) STORED,',
      '  CONSTRAINT "clubs_pkey" PRIMARY KEY (id),',
      '  CONSTRAINT "clubs_name_check" CHECK (length(name) > 0)',
      ');',
      'CREATE INDEX clubs_name_idx ON public.clubs USING btree (lower(name));',
    ].join('\n'),
  );
  for (const kind of ['sqlserver', 'postgres', 'mysql']) assert.match(EXTRAS_SQL[kind], /^-- trawl:script-extras\n/);
  assert.equal(EXTRAS_SQL.postgres.match(/^SELECT/gm).length, 5);
  assert.equal(EXTRAS_SQL.mysql.match(/^SELECT/gm).length, 5);
});

test("MySQL: the server's own CREATE for every object, without the AUTO_INCREMENT that changes with each insert", () => {
  const schema = { objects: [{ schema: 'shop', name: 'orders', kind: 'table', columns: [] }, { schema: 'shop', name: 'v_open', kind: 'view', columns: [] }, { schema: 'shop', name: 'p_locked', kind: 'procedure', columns: [] }], foreignKeys: [] };
  const modules = [{ schema: 'shop', name: 'trg_orders', type: 'TR', parent: 'orders', definition: 'BEGIN END' }];
  const creates = new Map([
    [createKey('table', 'shop', 'orders'), withoutAutoIncrement('CREATE TABLE `orders` (\n  `id` int NOT NULL AUTO_INCREMENT,\n  PRIMARY KEY (`id`)\n) ENGINE=InnoDB AUTO_INCREMENT=42 DEFAULT CHARSET=utf8mb4')],
    [createKey('view', 'shop', 'v_open'), 'CREATE VIEW `v_open` AS select 1'],
    [createKey('trigger', 'shop', 'trg_orders'), 'CREATE TRIGGER `trg_orders` BEFORE INSERT ON `orders` FOR EACH ROW BEGIN END'],
  ]);
  const { files, skipped } = scriptFiles({ schema, modules, dialect: MY, creates });
  assert.deepEqual(files.map((f) => f.path), ['shop/Tables/orders.sql', 'shop/Triggers/trg_orders.sql', 'shop/Views/v_open.sql']);
  assert.match(files[0].text, /\) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4\n$/);
  assert.match(files[0].text, /`id` int NOT NULL AUTO_INCREMENT,/);
  // A routine the login can't read keeps whatever file it had.
  assert.deepEqual(skipped, [{ name: 'shop.p_locked', path: 'shop/Procedures/p_locked.sql' }]);
});

test('file names any system can hold, the layout, and definitions as files', () => {
  assert.equal(fileName('a/b:c'), 'a%2Fb%3Ac');
  assert.equal(fileName('100%'), '100%25');
  assert.equal(fileName('CON'), 'CON_');
  assert.equal(fileName('end.'), 'end%2E');
  assert.equal(fileName('Ünïcode name'), 'Ünïcode name');
  assert.ok(inLayout('dbo/Tables/Players.sql'));
  assert.ok(inLayout('dbo/views/x.SQL'));
  assert.ok(!inLayout('dbo/Tables/sub/Players.sql'));
  assert.ok(!inLayout('README.sql'));
  assert.ok(!inLayout('dbo/Other/x.sql'));
  assert.equal(fileText('\r\n\r\nCREATE VIEW v\r\nAS SELECT 1  \r\n\r\n'), 'CREATE VIEW v\nAS SELECT 1\n');
});

test('planning: what is new, changed, the same (line ends aside), and stale (only in the layout, not kept, case aside)', () => {
  const files = [
    { path: 'dbo/Tables/A.sql', text: 'a\n' },
    { path: 'dbo/Tables/B.sql', text: 'b\n' },
    { path: 'dbo/Views/C.sql', text: 'c\n' },
    { path: 'dbo/Views/New.sql', text: 'n\n' },
  ];
  const existing = new Map([
    ['dbo/Tables/A.sql', 'a\r\n'],
    ['dbo/Tables/b.sql', 'b\n'],
    ['dbo/Views/C.sql', 'old\n'],
    ['dbo/Views/Gone.sql', 'g\n'],
    ['dbo/Procedures/Locked.sql', 'l\n'],
  ]);
  const plan = planFiles(files, existing, { keep: ['dbo/Procedures/Locked.sql'] });
  assert.deepEqual(plan.unchanged, ['dbo/Tables/A.sql', 'dbo/Tables/B.sql']);
  assert.deepEqual(plan.written, [{ path: 'dbo/Views/C.sql', text: 'c\n', isNew: false }, { path: 'dbo/Views/New.sql', text: 'n\n', isNew: true }]);
  assert.deepEqual(plan.stale, ['dbo/Views/Gone.sql']);
  assert.equal(summaryLine(plan), '2 written (1 new) · 2 unchanged');
  assert.equal(summaryLine(plan, 1), '2 written (1 new) · 2 unchanged · 1 removed');
  const text = summaryText(plan, { database: 'ClubA', folder: '/s', removed: ['dbo/Views/Gone.sql'], skipped: [{ name: 'dbo.Locked', path: 'dbo/Procedures/Locked.sql' }] });
  assert.match(text, /^ClubA → \/s\n2 written \(1 new\) · 2 unchanged · 1 removed/);
  assert.match(text, /~ dbo\/Views\/C\.sql\n {2}\+ dbo\/Views\/New\.sql/);
  assert.match(text, /- dbo\/Views\/Gone\.sql/);
  assert.match(text, /! dbo\.Locked/);
  assert.match(summaryText({ written: [], unchanged: ['x'], stale: [] }, { database: 'ClubA', folder: '/s' }), /Nothing changed since the files were written/);
});
