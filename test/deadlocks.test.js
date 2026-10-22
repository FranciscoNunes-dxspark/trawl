import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDeadlocks, buildInnodbDeadlocks, deadlockSummary, deadlockText, deadlockTime, parseDeadlockXml, parseInnodbDeadlock, postgresDeadlockPlan, sqlServerDeadlockPlan, unescapeXml } from '../src/deadlocks.js';

const set = (names, rows) => ({ columns: names.map((name) => ({ name, type: '' })), rows, truncated: false });

// As system_health's event file has it (shortened): a read and an update, over a key and a page.
const EVENT = `<event name="xml_deadlock_report" package="sqlserver" timestamp="2026-10-20T08:15:02.123Z"><data name="xml_report"><type name="xml" package="package0" /><value><deadlock>
 <victim-list>
  <victimProcess id="process1d2f3a4b88" />
 </victim-list>
 <process-list>
  <process id="process1d2f3a4b88" taskpriority="0" logused="0" waitresource="KEY: 7:72057594043695104 (8194443284a0)" waittime="4012" ownerId="12345" transactionname="SELECT" lasttranstarted="2026-10-20T08:14:58.110" XDES="0x1d2e" lockMode="S" schedulerid="1" kpid="7720" status="suspended" spid="64" sbid="0" ecid="0" priority="0" trancount="0" lastbatchstarted="2026-10-20T08:14:58.110" clientapp="Power BI" hostname="BI01" hostpid="1200" loginname="CORP\\report" isolationlevel="read committed (2)" xactid="12345" currentdb="7" currentdbname="ClubA" lockTimeout="4294967295" clientoption1="671088672" clientoption2="128056">
   <executionStack>
    <frame procname="adhoc" line="1" stmtstart="38" sqlhandle="0x0200000041">
SELECT * FROM dbo.Clubs WHERE Id &lt; @p0    </frame>
    <frame procname="unknown" line="1" sqlhandle="0x0400000000">
unknown    </frame>
   </executionStack>
   <inputbuf>
(@p0 int)SELECT * FROM dbo.Clubs WHERE Id &lt; @p0&#xD;
   </inputbuf>
  </process>
  <process id="process1d2f3a9c48" taskpriority="0" logused="296" waitresource="PAGE: 7:1:312 " waittime="3990" ownerId="12300" transactionname="user_transaction" lockMode="IX" schedulerid="2" kpid="5100" status="suspended" spid="61" sbid="0" ecid="0" priority="0" trancount="2" clientapp="Nightly load" hostname="BATCH02" hostpid="4120" loginname="etl" isolationlevel="serializable (4)" xactid="12300" currentdb="7" currentdbname="ClubA" lockTimeout="4294967295">
   <executionStack>
    <frame procname="ClubA.dbo.usp_Load" line="12" stmtstart="400" stmtend="560" sqlhandle="0x03000700">
UPDATE dbo.Players SET Goals = 0    </frame>
   </executionStack>
   <inputbuf>
Proc [Database Id = 7 Object Id = 901578250]   </inputbuf>
  </process>
 </process-list>
 <resource-list>
  <keylock hobtid="72057594043695104" dbid="7" objectname="ClubA.dbo.Clubs" indexname="PK_Clubs" id="lock1d2e5c" mode="X" associatedObjectId="72057594043695104">
   <owner-list>
    <owner id="process1d2f3a9c48" mode="X" />
   </owner-list>
   <waiter-list>
    <waiter id="process1d2f3a4b88" mode="S" requestType="wait" />
   </waiter-list>
  </keylock>
  <pagelock fileid="1" pageid="312" dbid="7" subresource="FULL" objectname="ClubA.dbo.Players" id="lock1d2e6d" mode="S" associatedObjectId="72057594043760640">
   <owner-list>
    <owner id="process1d2f3a4b88" mode="S" />
   </owner-list>
   <waiter-list>
    <waiter id="process1d2f3a9c48" mode="IX" requestType="convert" />
   </waiter-list>
  </pagelock>
 </resource-list>
</deadlock></value></data></event>`;

test('parseDeadlockXml reads the victim, the processes with their SQL, and the locks', () => {
  const d = parseDeadlockXml(EVENT);
  assert.equal(d.at.toISOString(), '2026-10-20T08:15:02.123Z');
  assert.deepEqual(d.victims, ['process1d2f3a4b88']);
  const [reader, loader] = d.processes;
  assert.equal(reader.spid, 64);
  assert.equal(reader.login, 'CORP\\report');
  assert.equal(reader.isolation, 'read committed');
  assert.equal(reader.statement, 'SELECT * FROM dbo.Clubs WHERE Id < @p0', 'entities undone');
  assert.equal(reader.batch, '(@p0 int)SELECT * FROM dbo.Clubs WHERE Id < @p0');
  assert.equal(reader.waitMs, 4012);
  assert.equal(loader.procedure, 'ClubA.dbo.usp_Load');
  assert.equal(loader.tranCount, 2);
  assert.deepEqual(
    d.resources.map((r) => [r.label, r.owners, r.waiters]),
    [
      ['KEY ClubA.dbo.Clubs (PK_Clubs)', [{ id: 'process1d2f3a9c48', mode: 'X' }], [{ id: 'process1d2f3a4b88', mode: 'S' }]],
      ['PAGE ClubA.dbo.Players page 1:312', [{ id: 'process1d2f3a4b88', mode: 'S' }], [{ id: 'process1d2f3a9c48', mode: 'IX' }]],
    ],
  );
  assert.equal(parseDeadlockXml('<event name="xml_deadlock_report"></event>'), null);
});

test('deadlockText draws who waited for whom from the victim, until it comes back round', () => {
  const text = deadlockText(parseDeadlockXml(EVENT));
  const lines = text.split('\n');
  assert.equal(lines[0], 'Deadlock 2026-10-20 08:15:02 UTC in ClubA: 2 sessions, session 64 chosen as the victim (rolled back).');
  assert.deepEqual(lines.slice(2, 7), [
    '✗ session 64 · CORP\\report on BI01 · Power BI · the victim',
    '    wants S on KEY ClubA.dbo.Clubs (PK_Clubs), which session 61 holds (X)',
    '  └ session 61 · etl on BATCH02 · Nightly load',
    '      wants IX on PAGE ClubA.dbo.Players page 1:312, which session 64 holds (S)',
    '    └ session 64: back to the start, so neither can go on',
  ]);
  assert.match(text, /\n  session 61 · serializable · 2 open transactions · waited 4\.0 s · ClubA · in ClubA\.dbo\.usp_Load\n      UPDATE dbo\.Players SET Goals = 0\n    in the batch:\n      Proc \[Database Id = 7/);
  assert.match(text, /\nLocks\n  KEY ClubA\.dbo\.Clubs \(PK_Clubs\): session 61 holds X · session 64 wants S\n/);
  assert.equal(deadlockSummary(parseDeadlockXml(EVENT)), 'victim session 64 · 2 sessions · ClubA.dbo.Clubs, ClubA.dbo.Players');
});

test('buildDeadlocks: newest first, and Azure’s events with their database', () => {
  const older = EVENT.replace('2026-10-20T08:15:02.123Z', '2026-10-19T08:00:00.000Z');
  const azure = EVENT.replace('name="xml_deadlock_report"', 'name="database_xml_deadlock_report"').replace('<data name="xml_report">', '<data name="database_name"><type name="unicode_string" package="package0" /><value>Shop</value></data><data name="xml_report">');
  const list = buildDeadlocks([set(['event_xml'], [[older], [azure], ['<event/>']])]);
  assert.equal(list.length, 2);
  assert.equal(deadlockTime(list[0]), '2026-10-20 08:15:02 UTC');
  assert.equal(list[0].database, 'Shop');
  assert.match(deadlockText(list[0]), /^Deadlock .* in Shop:/);
});

test('unescapeXml', () => {
  assert.equal(unescapeXml('a &lt;&gt; b &amp;&amp; &quot;c&quot; &#39;d&#x27; &#xD;'), 'a <> b && "c" \'d\' \r');
});

test('where SQL Server keeps them: system_health, or master on Azure SQL Database', () => {
  assert.deepEqual(sqlServerDeadlockPlan({ engine_edition: 3, database_name: 'ClubA' }).sources.map((s) => s.id), ['file', 'ring']);
  assert.match(sqlServerDeadlockPlan({ engine_edition: 5, database_name: 'ClubA' }).unavailable, /\/use master/);
  assert.deepEqual(sqlServerDeadlockPlan({ engine_edition: 5, database_name: 'master' }).sources.map((s) => s.id), ['azure']);
  assert.match(postgresDeadlockPlan({ database_name: 'shop', deadlocks: '4', stats_reset: new Date('2026-10-01T00:00:00Z') }).unavailable, /server log .* counts 4 deadlocks in shop since 2026-10-01\./);
});

// MySQL 5.7's monitor: it names what the second transaction holds, but not the first.
const STATUS_57 = `
------------------------
LATEST DETECTED DEADLOCK
------------------------
2026-10-21 08:57:13 0x7f3c2c0b7700
*** (1) TRANSACTION:
TRANSACTION 421937, ACTIVE 6 sec starting index read
mysql tables in use 1, locked 1
LOCK WAIT 2 lock struct(s), heap size 1136, 1 row lock(s)
MySQL thread id 18, OS thread handle 139895, query id 2201 localhost root updating
UPDATE t
SET a = 1 WHERE id = 2
*** (1) WAITING FOR THIS LOCK TO BE GRANTED:
RECORD LOCKS space id 12 page no 3 n bits 72 index PRIMARY of table \`shop\`.\`t\` trx id 421937 lock_mode X locks rec but not gap waiting
Record lock, heap no 3 PHYSICAL RECORD: n_fields 4; compact format; info bits 0
*** (2) TRANSACTION:
TRANSACTION 421938, ACTIVE 4 sec starting index read
mysql tables in use 1, locked 1
3 lock struct(s), heap size 1136, 2 row lock(s)
MySQL thread id 21, OS thread handle 139871, query id 2207 10.0.0.31 app updating
UPDATE t SET a = 2 WHERE id = 1
*** (2) HOLDS THE LOCK(S):
RECORD LOCKS space id 12 page no 3 n bits 72 index PRIMARY of table \`shop\`.\`t\` trx id 421938 lock_mode X locks rec but not gap
Record lock, heap no 3 PHYSICAL RECORD: n_fields 4; compact format; info bits 0
*** (2) WAITING FOR THIS LOCK TO BE GRANTED:
RECORD LOCKS space id 12 page no 3 n bits 72 index PRIMARY of table \`shop\`.\`t\` trx id 421938 lock_mode X locks rec but not gap waiting
Record lock, heap no 2 PHYSICAL RECORD: n_fields 4; compact format; info bits 0
*** WE ROLL BACK TRANSACTION (2)
------------
TRANSACTIONS
------------
Trx id counter 421950
`;

test('parseInnodbDeadlock reads the latest deadlock out of the monitor, and fills in what 5.7 leaves out', () => {
  const [d] = parseInnodbDeadlock(STATUS_57);
  assert.equal(d.at, '2026-10-21 08:57:13');
  assert.deepEqual(d.victims, ['2']);
  assert.deepEqual(d.processes.map((p) => [p.spid, p.login, p.host, p.statement]), [
    [18, 'root', 'localhost', 'UPDATE t\nSET a = 1 WHERE id = 2'],
    [21, 'app', '10.0.0.31', 'UPDATE t SET a = 2 WHERE id = 1'],
  ]);
  const [first, second] = d.resources;
  assert.equal(first.label, 'RECORD shop.t (PRIMARY) page 12:3 heap no 3');
  assert.deepEqual(first.owners, [{ id: '2', mode: 'X locks rec but not gap' }]);
  // Nobody is said to hold heap no 2: the other transaction must.
  assert.deepEqual(second.owners, [{ id: '1', mode: '?' }]);
  const text = deadlockText(d);
  assert.match(text, /^Deadlock 2026-10-21 08:57:13: 2 sessions, session 21 chosen as the victim/);
  assert.match(text, /\n✗ session 21 · app on 10\.0\.0\.31 · the victim\n    wants X locks rec but not gap on RECORD shop\.t \(PRIMARY\) page 12:3 heap no 2, which session 18 holds\n  └ session 18/);
  assert.deepEqual(parseInnodbDeadlock('=====\nTRANSACTIONS\n'), []);
  assert.equal(buildInnodbDeadlocks([set(['Type', 'Name', 'Status'], [['InnoDB', '', STATUS_57]])]).length, 1);
});
