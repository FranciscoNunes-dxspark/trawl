import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connectionName, findDataSources, importPlan, parseDataSources, parseJdbcUrl, planText, toConnection } from '../src/datagrip.js';

const ds = (name, url, extra = '') => `
    <data-source source="LOCAL" name="${name}" ${extra}>
      <driver-ref>azure.ms</driver-ref>
      <jdbc-url>${url}</jdbc-url>
      <user-name>${name.toLowerCase()}user</user-name>
    </data-source>`;

let home;
let appData;
before(() => {
  const base = mkdtempSync(join(tmpdir(), 'trawl-datagrip-'));
  home = join(base, 'home');
  appData = join(base, 'appdata');
  // A project: connections in dataSources.xml, login names in dataSources.local.xml.
  const idea = join(home, 'DataGripProjects', 'tracking', '.idea');
  mkdirSync(idea, { recursive: true });
  writeFileSync(join(idea, 'dataSources.xml'), `<project version="4"><component name="DataSourceManagerImpl">
    <data-source source="LOCAL" name="defaultdb@cockroach.example" uuid="c1">
      <driver-ref>cockroach</driver-ref><jdbc-url>jdbc:postgresql://cockroach.example:26257/defaultdb</jdbc-url>
    </data-source>
    <data-source source="LOCAL" name="QA &amp; tests" uuid="p1">
      <driver-ref>sqlserver.ms</driver-ref><jdbc-url>jdbc:sqlserver://qa.example.net:1433;database=qadb;trustServerCertificate=true</jdbc-url>
    </data-source></component></project>`);
  writeFileSync(join(idea, 'dataSources.local.xml'), `<project><component name="dataSourceStorageLocal">
    <data-source name="QA &amp; tests" uuid="p1"><user-name>qa_admin</user-name></data-source></component></project>`);
  // Newer DataGrip keeps them in a per-project history; an older version has a stale copy.
  const newer = join(appData, 'JetBrains', 'DataGrip2026.2', 'dataSourcesHistory', 'abc');
  const older = join(appData, 'JetBrains', 'DataGrip2025.3', 'dataSourcesHistory', 'abc');
  mkdirSync(newer, { recursive: true });
  mkdirSync(older, { recursive: true });
  writeFileSync(join(newer, 'data_sources_history.xml'), `<DataSourcesHistory>
  <DataSourceFromHistory isRemovedFromProject="false">${ds('FUNDS', 'jdbc:sqlserver://funds.database.windows.net;database=fundsdb', 'group="PROD" uuid="h1"')}
  </DataSourceFromHistory>
  <DataSourceFromHistory isRemovedFromProject="false">${ds('DEMO', 'jdbc:sqlserver://demo.database.windows.net:1433;database=demodb', 'group="PROD" uuid="h2"')}
  </DataSourceFromHistory>
  <DataSourceFromHistory isRemovedFromProject="false">${ds('@localhost', 'jdbc:sqlserver://localhost\\MSSQLSERVER', 'uuid="h3"')}
  </DataSourceFromHistory>
  <DataSourceFromHistory isRemovedFromProject="true">${ds('GONE', 'jdbc:sqlserver://gone.database.windows.net', 'uuid="h4"')}
  </DataSourceFromHistory>
</DataSourcesHistory>`);
  writeFileSync(join(older, 'data_sources_history.xml'), `<DataSourcesHistory>
  <DataSourceFromHistory isRemovedFromProject="false">${ds('FUNDS-OLD', 'jdbc:sqlserver://old.database.windows.net', 'uuid="h1"')}
  </DataSourceFromHistory></DataSourcesHistory>`);
});
after(() => rmSync(join(home, '..'), { recursive: true, force: true }));

test('JDBC URLs: Microsoft and jTDS, ports, instances and options', () => {
  assert.deepEqual(parseJdbcUrl('jdbc:sqlserver://h.database.windows.net:1433;database=db;encrypt=true'), {
    host: 'h.database.windows.net', instance: null, port: 1433, database: 'db', props: { database: 'db', encrypt: 'true' },
  });
  assert.equal(parseJdbcUrl('jdbc:sqlserver://localhost\\SQLEXPRESS;databaseName=x').instance, 'SQLEXPRESS');
  assert.equal(parseJdbcUrl('jdbc:sqlserver://localhost\\SQLEXPRESS;databaseName=x').database, 'x');
  assert.deepEqual(parseJdbcUrl('jdbc:jtds:sqlserver://srv:1500/shop;instance=A').database, 'shop');
  assert.equal(parseJdbcUrl('jdbc:postgresql://x:5432/db'), null);
});

test('names', () => {
  assert.equal(connectionName({ name: 'defaultdb@host.example' }), 'defaultdb');
  assert.equal(connectionName({ name: '@localhost' }), 'localhost');
  assert.equal(connectionName({ name: 'myserver.database.windows.net' }), 'myserver');
  assert.equal(connectionName({ name: 'QA & tests' }), 'qa-tests');
});

test('a data source becomes a connection, with sign-in, options and production', () => {
  const prod = toConnection({ name: 'FUNDS', group: 'PROD', url: 'jdbc:sqlserver://funds.database.windows.net;database=fundsdb', user: 'fundsapp' }).conn;
  assert.deepEqual(prod, {
    name: 'funds', server: 'funds.database.windows.net', database: 'fundsdb', auth: 'sql', user: 'fundsapp', prod: true, folder: 'PROD', from: 'DataGrip',
  });
  const entra = toConnection({ name: 'x', url: 'jdbc:sqlserver://x.database.windows.net;database=d;authentication=ActiveDirectoryDefault' }).conn;
  assert.equal(entra.auth, 'azure-cli');
  assert.equal(toConnection({ name: 'x', url: 'jdbc:sqlserver://x.database.windows.net;database=d' }).conn.auth, 'azure-cli');
  const local = toConnection({ name: '@localhost', url: 'jdbc:sqlserver://localhost\\MSSQLSERVER', user: 'sa' }).conn;
  assert.equal(local.server, 'localhost', 'the default instance needs no name');
  assert.equal(toConnection({ name: 'n', url: 'jdbc:sqlserver://h\\SQLEXPRESS', user: 'sa' }).conn.server, 'h\\SQLEXPRESS');
  assert.equal(toConnection({ name: 'n', url: 'jdbc:sqlserver://h:1500', user: 'sa' }).conn.server, 'h,1500');
  assert.equal(toConnection({ name: 'n', url: 'jdbc:sqlserver://h;trustServerCertificate=true;encrypt=false', user: 'sa' }).conn.trustCert, true);
  assert.equal(toConnection({ name: 'n', url: 'jdbc:sqlserver://h', user: 'sa', readOnly: true }).conn.readOnly, true);
  // DataGrip's "Tx: Manual" comes across; its default (auto) leaves Trawl's own.
  const [manual] = parseDataSources(`<data-source name="m" uuid="m1"><jdbc-url>jdbc:sqlserver://h</jdbc-url><user-name>sa</user-name><auto-commit>false</auto-commit></data-source>`);
  assert.equal(toConnection(manual).conn.commit, 'manual');
  assert.equal('commit' in toConnection({ name: 'n', url: 'jdbc:sqlserver://h', user: 'sa' }).conn, false);
  assert.match(toConnection({ name: 'w', url: 'jdbc:sqlserver://h;integratedSecurity=true' }).skip, /Windows integrated/);
  assert.match(toConnection({ name: 'n', url: 'jdbc:sqlserver://onprem.local' }).skip, /no login is saved/);
  assert.match(toConnection({ name: 'pg', driver: 'postgresql', url: 'jdbc:postgresql://x/db' }).skip, /postgresql isn't supported yet/);
});

test('finding them: projects with their local logins, the newest history, no removed or duplicate ones', () => {
  const found = findDataSources({ home, appData });
  const names = found.map((s) => s.name);
  assert.deepEqual(names.sort(), ['@localhost', 'DEMO', 'FUNDS', 'QA & tests', 'defaultdb@cockroach.example']);
  assert.equal(found.find((s) => s.name === 'QA & tests').user, 'qa_admin');
  assert.equal(found.find((s) => s.uuid === 'h1').name, 'FUNDS', 'the newer DataGrip wins');
  assert.equal(findDataSources({ folder: join(home, 'DataGripProjects', 'tracking') }).length, 2);
  assert.equal(parseDataSources('<nothing/>').length, 0);
});

test('the plan: keeps off the demo names, skips what Trawl already has, then imports nothing twice', () => {
  const sources = findDataSources({ home, appData });
  const existing = [{ name: 'funds-mine', server: 'funds.database.windows.net', database: 'fundsdb', user: 'fundsuser' }];
  const plan = importPlan(sources, existing);
  const added = Object.fromEntries(plan.add.map((c) => [c.name, c]));
  assert.ok(added['demo-2'], 'DEMO must not take the demo connection’s name');
  assert.equal(added['demo-2'].prod, true);
  assert.equal(added.localhost.server, 'localhost');
  assert.equal(added['qa-tests'].trustCert, true);
  assert.ok(plan.skip.some((s) => /FUNDS: already in Trawl as funds-mine/.test(s)));
  assert.ok(plan.skip.some((s) => /cockroach isn't supported yet/.test(s)));
  const again = importPlan(sources, [...existing, ...plan.add]);
  assert.equal(again.add.length, 0);
  const text = planText(plan);
  assert.match(text, /Will add 3 connections/);
  assert.match(text, /\n {2}PROD\/\n {4}demo-2 +demo\.database\.windows\.net\/demodb {2}PROD \(read-only\)/);
  assert.match(text, /asks for each login’s\npassword the first time you connect/);
  assert.doesNotMatch(text, /TRAWL_PW_/);
  assert.match(text, /already in Trawl as funds-mine/);
  assert.deepEqual(plan.file, [{ name: 'funds-mine', folder: 'PROD' }], 'one Trawl already has, in no folder, goes into DataGrip’s');
  assert.deepEqual(importPlan(sources, [{ ...existing[0], folder: 'Mine' }]).file, [], 'a folder you chose stays');
});
