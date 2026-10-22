import { test } from 'node:test';
import assert from 'node:assert/strict';
import { argsOf, expandLines, runsAlone, userCommands, words } from '../src/usercommands.js';

test('your commands from the config: a line, a list, or { run, desc }; built-in names and bad entries left out', () => {
  const { commands, problems } = userCommands(
    {
      nuke: '!clean -fdx',
      morning: ['/fetch', '/sync'],
      '/Co': { run: '/checkout $1', desc: 'Switch branch' },
      commit: '/quit',
      'bad name': '/x',
      empty: '',
      half: ['/fetch', 3],
    },
    ['commit', 'checkout'],
  );
  assert.deepEqual(
    commands.map((c) => [c.name, c.args, c.desc, c.lines]),
    [
      ['nuke', null, '!clean -fdx', ['!clean -fdx']],
      ['morning', null, '/fetch then /sync', ['/fetch', '/sync']],
      ['co', '<1>', 'Switch branch', ['/checkout $1']],
    ],
  );
  assert.ok(commands.every((c) => c.user));
  assert.deepEqual(problems, [
    '/commit is built in, so yours is left out: give it another name',
    '/bad name: a name is letters, digits, - and _',
    '/empty: give it a line to run, or a list of them, as text',
    '/half: give it a line to run, or a list of them, as text',
  ]);
  assert.deepEqual(userCommands(undefined).commands, []);
  assert.match(userCommands('x').problems[0], /should be an object/);
});

test('what a command takes, for the menu, and whether it runs alone', () => {
  assert.equal(argsOf(['/x $1 $2']), '<1> <2>');
  assert.equal(argsOf(['/x $*']), '<text>');
  assert.equal(argsOf(['/x $1', '/y $*']), '<1> […]');
  assert.equal(argsOf(['/x costs $$5']), null);
  assert.equal(runsAlone({ args: null }), true);
  assert.equal(runsAlone({ args: '[ref]' }), true);
  assert.equal(runsAlone({ args: '<1>' }), false);
});

test('expanding: $1… words (quoted ones whole), $* everything, $$ a dollar; no $ takes the rest at the end', () => {
  assert.deepEqual(words('a "b c" \'d e\' f'), ['a', 'b c', 'd e', 'f']);
  const cmd = (...lines) => ({ lines });
  assert.deepEqual(expandLines(cmd('/branch $1', '/push $2'), 'topic origin'), ['/branch topic', '/push origin']);
  assert.deepEqual(expandLines(cmd("!SELECT * FROM dbo.Players WHERE Name = '$1'"), '"Ana Silva"'), ["!SELECT * FROM dbo.Players WHERE Name = 'Ana Silva'"]);
  assert.deepEqual(expandLines(cmd('/commit $*'), '  fix the poll  '), ['/commit fix the poll']);
  assert.deepEqual(expandLines(cmd('/x $3'), 'a'), ['/x ']);
  assert.deepEqual(expandLines(cmd('!echo $$1 $1'), 'a'), ['!echo $1 a']);
  assert.deepEqual(expandLines(cmd('/checkout'), 'main'), ['/checkout main']);
  assert.deepEqual(expandLines(cmd('/fetch', '/checkout'), 'main'), ['/fetch', '/checkout main']);
  assert.deepEqual(expandLines(cmd('/fetch'), ''), ['/fetch']);
});
