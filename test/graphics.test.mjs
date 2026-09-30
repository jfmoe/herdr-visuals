import test from 'node:test';
import assert from 'node:assert/strict';
import readline from 'node:readline';
import { PassThrough } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { clearGraphics, imageGraphics, terminalInput } from '../src/graphics.mjs';

test('Kitty upload preserves pixels, bounded chunks, placement and cursor; deletion frees only the owned image', () => {
  for (const size of [1, 3072, 3073, 1100000]) {
    const png = Buffer.alloc(size, 73);
    const output = imageGraphics(png, { cols: 88, rows: 22 });
    const commands = [...output.matchAll(/\x1b_G([^;\x1b]+);([A-Za-z0-9+/=]*)\x1b\\/g)];
    assert.match(output, /^\x1b7\x1b\[5;2H/);
    assert.ok(output.endsWith('\x1b8'));
    assert.equal(commands[0][1], 'a=T,f=100,t=d,i=1,c=88,r=22,C=1,q=2,m=' + (size > 3072 ? 1 : 0));
    for (const [index, command] of commands.entries()) {
      assert.ok(command[2].length > 0 && command[2].length <= 4096);
      assert.equal(command[2].length % 4, 0);
      assert.ok(command[1].endsWith(`m=${index === commands.length - 1 ? 0 : 1}`));
      if (index > 0) assert.match(command[1], /^q=2,m=[01]$/);
    }
    assert.deepEqual(Buffer.from(commands.map(c => c[2]).join(''), 'base64'), png);
  }
  assert.equal(clearGraphics(), '\x1b_Ga=d,d=I,i=1,q=2\x1b\\');
});

test('cell-size replies never become keys; split replies preserve Unicode, arrows and Escape', async () => {
  const input = new PassThrough(), sizes = [];
  const keys = terminalInput(input, size => sizes.push(size));
  const escapes = []; keys.on('keypress', (text, key) => escapes.push(key.name));
  let output = ''; keys.setEncoding('utf8'); keys.on('data', text => { output += text; });
  input.write('中🙂\x1b['); input.write('6;40;'); input.write('20t+\x1b[A');
  input.write('\x1b[6;0;0t\x1b[6;9999;20t');
  assert.deepEqual(sizes, [{ width: 20, height: 40 }]);
  assert.equal(output, '中🙂+\x1b[A');
  input.write('\x1b'); await delay(80);
  assert.equal(output, '中🙂+\x1b[A');
  assert.deepEqual(escapes, ['escape']);
  input.end('\x1b[6;');
  await new Promise(resolve => keys.on('end', resolve));
  assert.equal(output, '中🙂+\x1b[A');
  assert.deepEqual(escapes, ['escape']);
});


test('delayed cell reports are consumed at every split boundary before readline interprets keys', async () => {
  const reply = '\x1b[6;40;20t';
  for (let split = 1; split < reply.length; split++) {
    const input = new PassThrough(), sizes = [], events = [];
    const keys = terminalInput(input, size => sizes.push(size));
    readline.emitKeypressEvents(keys);
    keys.on('keypress', (text, key) => events.push(key.sequence));
    keys.expectCellSize();
    input.write(reply.slice(0, split)); await delay(80);
    input.write(reply.slice(split) + '+');
    assert.deepEqual(sizes, [{ width: 20, height: 40 }], `split ${split}`);
    assert.deepEqual(events, ['+'], `split ${split}`);
    input.end();
  }
});


test('one reply does not expose a later reply from overlapping resize queries as keys', async () => {
  const input = new PassThrough(), sizes = [], events = [];
  const keys = terminalInput(input, size => sizes.push(size));
  readline.emitKeypressEvents(keys);
  keys.on('keypress', (text, key) => events.push(key.sequence));
  keys.expectCellSize(); keys.expectCellSize();
  input.write('\x1b[6;40;20t\x1b'); await delay(80);
  input.end('[6;42;21t+');
  assert.deepEqual(sizes, [{ width: 20, height: 40 }, { width: 21, height: 42 }]);
  assert.deepEqual(events, ['+']);
});
