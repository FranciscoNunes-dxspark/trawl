// diagram.js: a table's foreign keys as boxes and lines, and as a Mermaid erDiagram; then D in the
// Explorer and /diagram against the demo (helpers copied from app.test.js).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import React from 'react';
import { render } from 'ink-testing-library';
import { DEMO_CONNECTIONS } from '../src/connections.js';
import { boxColumns, diagramGraph, drawDiagram, mermaidDiagram, parseDiagramArgs } from '../src/diagram.js';
import { stringWidth } from '../src/text.js';
import { App } from '../src/ui/App.jsx';

const col = (name, type, extra = {}) => ({ name, type, nullable: false, identity: false, pk: false, ...extra });
const table = (schema, name, columns) => ({ schema, name, kind: 'table', rows: 0, columns });
// A shop: orders refer to customers and to an address, lines to orders and products, products to a
// category; categories to their parent (themselves).
const SCHEMA = {
  database: 'Shop',
  databases: ['Shop'],
  objects: [
    table('dbo', 'Customers', [col('Id', 'int', { pk: true }), col('Name', 'nvarchar(100)')]),
    table('dbo', 'Addresses', [col('Id', 'int', { pk: true }), col('City', 'nvarchar(50)')]),
    table('dbo', 'Orders', [col('Id', 'int', { pk: true }), col('CustomerId', 'int'), col('AddressId', 'int', { nullable: true }), col('Total', 'decimal(10,2)')]),
    table('dbo', 'OrderLines', [col('OrderId', 'int', { pk: true }), col('Line', 'int', { pk: true }), col('ProductId', 'int')]),
    table('dbo', 'Products', [col('Id', 'int', { pk: true }), col('CategoryId', 'int')]),
    table('dbo', 'Categories', [col('Id', 'int', { pk: true }), col('ParentId', 'int', { nullable: true })]),
    table('dbo', 'Log', [col('At', 'datetime2'), col('Text', 'nvarchar(max)')]),
    { schema: 'dbo', name: 'vSales', kind: 'view', rows: null, columns: [col('Total', 'decimal(10,2)')] },
  ],
  foreignKeys: [
    { name: 'FK_Orders_Customers', from: 'dbo.Orders', to: 'dbo.Customers', columns: [['CustomerId', 'Id']] },
    { name: 'FK_Orders_Addresses', from: 'dbo.Orders', to: 'dbo.Addresses', columns: [['AddressId', 'Id']] },
    { name: 'FK_OrderLines_Orders', from: 'dbo.OrderLines', to: 'dbo.Orders', columns: [['OrderId', 'Id']] },
    { name: 'FK_OrderLines_Products', from: 'dbo.OrderLines', to: 'dbo.Products', columns: [['ProductId', 'Id']] },
    { name: 'FK_Products_Categories', from: 'dbo.Products', to: 'dbo.Categories', columns: [['CategoryId', 'Id']] },
    { name: 'FK_Categories_Parent', from: 'dbo.Categories', to: 'dbo.Categories', columns: [['ParentId', 'Id']] },
  ],
};
const text = (lines) => lines.map((l) => l.map((s) => s.text).join(''));
const layers = (g) => Object.fromEntries(g.nodes.map((n) => [n.name, n.layer]));

test('the graph: tables by how far they are from the one asked for, both ways, to the depth', () => {
  const one = diagramGraph(SCHEMA, 'Orders');
  assert.equal(one.root, 'dbo.Orders');
  assert.deepEqual(layers(one), { 'dbo.Orders': 0, 'dbo.Customers': 1, 'dbo.Addresses': 1, 'dbo.OrderLines': 1 });
  assert.deepEqual(one.edges.map((f) => f.name), ['FK_Orders_Customers', 'FK_Orders_Addresses', 'FK_OrderLines_Orders']);
  const three = diagramGraph(SCHEMA, 'dbo.Orders', { depth: 3 });
  assert.deepEqual(layers(three), { 'dbo.Orders': 0, 'dbo.Customers': 1, 'dbo.Addresses': 1, 'dbo.OrderLines': 1, 'dbo.Products': 2, 'dbo.Categories': 3 });
  // Every table: from those that refer to nothing, and the ones in no chain of keys too.
  const all = diagramGraph(SCHEMA, null);
  assert.equal(all.root, null);
  assert.deepEqual(layers(all), { 'dbo.Customers': 0, 'dbo.Addresses': 0, 'dbo.Categories': 0, 'dbo.Log': 0, 'dbo.Orders': 1, 'dbo.Products': 1, 'dbo.OrderLines': 2 });
  assert.match(diagramGraph(SCHEMA, 'Nope').reason, /No table Nope in Shop/);
  assert.match(diagramGraph(SCHEMA, 'vSales').reason, /is a view/);
  assert.match(diagramGraph(null, 'x').reason, /Connect first/);
});

test("a box lists the table's key and foreign key columns", () => {
  const g = diagramGraph(SCHEMA, 'Orders');
  assert.deepEqual(boxColumns(SCHEMA.objects[2], g.edges), [{ name: 'Id', tag: 'PK' }, { name: 'CustomerId', tag: 'FK' }, { name: 'AddressId', tag: 'FK' }]);
  assert.deepEqual(boxColumns(SCHEMA.objects[3], diagramGraph(SCHEMA, 'OrderLines').edges), [{ name: 'OrderId', tag: 'PK FK' }, { name: 'Line', tag: 'PK' }, { name: 'ProductId', tag: 'FK' }]);
});

test('drawn: boxes in columns by distance, a line from each foreign key column to the key it refers to, arrows at the table referred to', () => {
  const g = diagramGraph(SCHEMA, 'Orders');
  const lines = drawDiagram(g, { width: 100, colors: { root: 'R', box: 'B', line: 'L', name: 'N', pk: 'P', fk: 'F' } });
  const t = text(lines);
  assert.match(t[0], /^┌─+┐ +┌─+┐$/);
  assert.match(t[1], /^│ dbo\.Orders +│ +│ dbo\.\w+ +│$/);
  // Orders' Id is reached from OrderLines' OrderId; its CustomerId and AddressId lines leave on the right.
  const orders = t.findIndex((l) => l.includes('PK Id') && l.startsWith('│ PK Id'));
  assert.ok(orders > 0);
  assert.match(t[orders], /^│ PK Id +├◀/);
  assert.match(t.find((l) => l.includes('FK CustomerId')), /^│ FK CustomerId +├─/);
  // Each layer's boxes line up; the tables referred to get ▶ on their left side.
  assert.equal(t.filter((l) => /▶┤ PK Id/.test(l)).length, 2);
  assert.ok(t.some((l) => /┤ PK FK OrderId/.test(l)));
  // The table asked for is drawn in the root's colour, the others in the box colour.
  assert.equal(lines[0][0].color, 'R');
  assert.ok(lines[0].some((s) => s.color === 'B'));
  assert.ok(lines.flat().some((s) => s.color === 'P' && s.text.includes('PK')));
  for (const l of t) assert.ok(stringWidth(l) <= 100, l);
  // A key to itself is said in the box.
  const cats = text(drawDiagram(diagramGraph(SCHEMA, 'Categories')));
  assert.ok(cats.some((l) => l.includes('FK ParentId → itself')));
  // A table with no keys says so.
  assert.ok(text(drawDiagram(diagramGraph(SCHEMA, 'Log'))).some((l) => l.includes('(no keys)')));
});

test('narrow: boxes are cut to fit, names end in …', () => {
  const g = diagramGraph(SCHEMA, 'OrderLines', { depth: 3 });
  const t = text(drawDiagram(g, { width: 60 }));
  assert.ok(t.some((l) => l.includes('…')));
  for (const l of t) assert.ok(stringWidth(l) <= 70, `${stringWidth(l)}: ${l}`);
});

test('Mermaid: an erDiagram of every column with its keys, a relationship per foreign key, optional when it can be NULL', () => {
  const m = mermaidDiagram(diagramGraph(SCHEMA, 'Orders'));
  assert.equal(
    m,
    [
      'erDiagram',
      '    dbo_Orders {',
      '        int Id PK',
      '        int CustomerId FK',
      '        int AddressId FK',
      '        decimal(10_2) Total',
      '    }',
      '    dbo_Addresses {',
      '        int Id PK',
      '        nvarchar(50) City',
      '    }',
      '    dbo_Customers {',
      '        int Id PK',
      '        nvarchar(100) Name',
      '    }',
      '    dbo_OrderLines {',
      '        int OrderId PK, FK',
      '        int Line PK',
      '        int ProductId',
      '    }',
      '    dbo_Customers ||--o{ dbo_Orders : "FK_Orders_Customers"',
      '    dbo_Addresses |o--o{ dbo_Orders : "FK_Orders_Addresses"',
      '    dbo_Orders ||--o{ dbo_OrderLines : "FK_OrderLines_Orders"',
      '',
    ].join('\n'),
  );
});

test("/diagram's arguments", () => {
  assert.deepEqual(parseDiagramArgs([]), { table: null, depth: 1, mermaid: false });
  assert.deepEqual(parseDiagramArgs(['dbo.Orders', '--depth', '2', '--mermaid']), { table: 'dbo.Orders', depth: 2, mermaid: true });
  assert.match(parseDiagramArgs(['--depth', 'x']).reason, /whole number from 1 to 10/);
  assert.match(parseDiagramArgs(['--wide']).reason, /doesn't know --wide/);
  assert.match(parseDiagramArgs(['a', 'b']).reason, /One table at a time/);
});

// ---------------------------------------------------------------------------------------------------

const KEYS = { enter: '\r', esc: '\x1b' };
let base;
before(() => {
  base = mkdtempSync(join(tmpdir(), 'trawl-'));
  process.env.TRAWL_HOME = join(base, 'home');
});
after(() => rmSync(base, { recursive: true, force: true }));

let lastApp = null;
async function until(check, what, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return new Promise((r) => setTimeout(r, 100));
    await new Promise((r) => setTimeout(r, 40));
  }
  throw new Error(`Timed out waiting for ${what}. Last frame:\n${lastApp?.lastFrame()}`);
}
const frame = () => lastApp.lastFrame();
const type = async (stdin, s) => {
  for (const ch of s) {
    stdin.write(ch);
    await new Promise((r) => setTimeout(r, 5));
  }
};

test('D in the Explorer draws the table under the cursor; m gives the Mermaid, y copies it and s saves it', async () => {
  const copied = [];
  const config = { connections: [...DEMO_CONNECTIONS], history: [], ran: [], limit: 500, last: null };
  const app = (lastApp = render(React.createElement(App, { config, initialConnection: 'demo', projectDir: base, clipboard: (t) => copied.push(t) })));
  await until(() => frame().includes('Translations'), 'the explorer');
  // The cursor starts on Clubs, which Players and Matches refer to.
  app.stdin.write('D');
  await until(() => frame().includes('dbo.Clubs: its keys 1 level out both ways · 3 tables'), 'the diagram');
  assert.match(frame(), /│ dbo\.Matches/);
  assert.match(frame(), /FK HomeId/);
  assert.match(frame(), /│ PK Id +├◀/);
  app.stdin.write('m');
  await until(() => frame().includes('Mermaid erDiagram: dbo.Clubs'), 'the Mermaid text');
  app.stdin.write('G');
  await until(() => /dbo_Clubs \|\|--o\{ dbo_Players : "FK_Players_Clubs"/.test(frame()), 'the end of it');
  app.stdin.write('y');
  await until(() => copied.length === 1 && frame().includes('Copied the Mermaid diagram'), 'the copy');
  assert.match(copied[0], /^erDiagram\n {4}dbo_Clubs \{/);
  await until(() => frame().includes('Mermaid erDiagram: dbo.Clubs'), 'the Mermaid text again');
  app.stdin.write('s');
  await until(() => frame().includes('Save the Mermaid diagram as'), 'the file name question');
  app.stdin.write(KEYS.enter);
  await until(() => frame().includes('Saved the Mermaid diagram to'), 'the save');
  assert.equal(readFileSync(join(base, 'dbo.Clubs.mmd'), 'utf8'), copied[0]);
  app.stdin.write(KEYS.esc);
  await until(() => !frame().includes('Mermaid erDiagram'), 'the viewer closed');
  await type(app.stdin, '/diagram Players --mermaid');
  app.stdin.write(KEYS.enter);
  await until(() => frame().includes('Mermaid erDiagram: dbo.Players') && frame().includes('    dbo_Players {'), 'the Mermaid text of Players, from its top');
  app.stdin.write(KEYS.esc);
  await until(() => !frame().includes('Mermaid erDiagram'), 'the viewer closed');
  await type(app.stdin, '/diagram Nope');
  app.stdin.write(KEYS.enter);
  await until(() => frame().includes('No table Nope in ClubA'), 'the error');
  app.unmount();
});
