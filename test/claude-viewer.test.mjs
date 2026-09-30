import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const root = fileURLToPath(new URL('..', import.meta.url));
const ids = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'];
const pixel = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLttAAAAABJRU5ErkJggg==';
const answer = (sessionId, uuid, text) => JSON.stringify({ type: 'assistant', sessionId, uuid, parentUuid: null,
  cwd: '/fixture/project', message: { role: 'assistant', content: [{ type: 'text', text }] } }) + '\n';

async function until(predicate, describe, timeout = 20000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await predicate()) return; await delay(50); }
  throw new Error(`Timed out: ${describe}`);
}

test('Claude PTY preview follows only its bound transcript, supports context/export and clears pins on session change', { timeout: 60000 }, async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hv-claude-viewer-'));
  const project = path.join(dir, 'projects', 'fictional'); await fs.mkdir(project, { recursive: true });
  const firstFile = path.join(project, `${ids[0]}.jsonl`), secondFile = path.join(project, `${ids[1]}.jsonl`);
  const initial = answer(ids[0], 'answer', '## Workflow\n```mermaid\nflowchart LR\nA --> B\n```\n## Formula\n$$x^2$$') +
    JSON.stringify({ type: 'user', sessionId: ids[0], uuid: 'image-result', parentUuid: 'answer', message: { role: 'user', content: [{
      type: 'tool_result', tool_use_id: 'read', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: pixel } }],
    }] } }) + '\n';
  await fs.writeFile(firstFile, initial);
  const second = answer(ids[1], 'answer', '## Second session\n$$y^2$$'); await fs.writeFile(secondFile, second);
  let session = null;
  const calls = [], socketPath = path.join(dir, 'herdr.sock');
  const server = net.createServer(socket => {
    let buffer = ''; socket.setEncoding('utf8'); socket.on('error', () => {});
    socket.on('data', chunk => {
      buffer += chunk; if (!buffer.includes('\n')) return;
      const call = JSON.parse(buffer.slice(0, buffer.indexOf('\n'))); calls.push(call);
      const result = call.method === 'pane.get' ? { pane: { pane_id: 'source', terminal_id: 'terminal', agent: 'claude', cwd: '/fixture/project',
        ...(session ? { agent_session: { agent: 'claude', kind: 'id', value: session } } : {}) } } : {};
      socket.end(JSON.stringify({ id: call.id, result }) + '\n');
    });
  });
  await new Promise(resolve => server.listen(socketPath, resolve));
  const child = spawn('python3', [path.join(root, 'test/pty-runner.py'), process.execPath, path.join(root, 'src/viewer.mjs')], {
    env: { ...process.env, HERDR_ENV: '1', HERDR_PANE_ID: 'viewer', HERDR_SOCKET_PATH: socketPath,
      HERDR_VISUALS_SOURCE: 'source', HERDR_VISUALS_CLAUDE_HOME: dir, HERDR_VISUALS_RECORD: '', HERDR_VISUALS_EXPORT_DIR: dir },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let output = ''; child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { output += data; });
  const keys = text => child.stdin.write(JSON.stringify({ keys: text }) + '\n');
  try {
    await until(() => output.includes('Claude Code session is not connected.'), 'unbound Claude message');
    assert.doesNotMatch(output, /Codex session|No diagrams/);
    output = ''; session = ids[0];
    await until(() => output.includes('3 items') && output.includes('\x1b_Ga=T,'), 'three native Claude visuals');
    keys('l'); await until(() => output.includes('MERMAID  Workflow') && output.includes('MATH  Formula') && output.includes('IMAGE  Tool image'), 'Claude item list');
    keys('\r'); output = ''; keys('[g');
    await until(() => output.includes('Answer context') && output.includes('$$x^2$$'), 'containing Claude answer');
    keys('\x1b'); output = ''; keys('se');
    await until(() => output.includes('$$x^2$$'), 'Claude source view');
    const exported = path.join(dir, 'herdr-visuals');
    await until(async () => (await fs.readdir(exported).catch(() => [])).some(n => n.endsWith('.png')), 'Claude export');
    const names = await fs.readdir(exported);
    assert.equal(await fs.readFile(path.join(exported, names.find(n => n.endsWith('.md'))), 'utf8'), '$$x^2$$');
    output = ''; keys('sp'); await until(() => output.includes('PINNED'), 'pin a Claude item');
    const appended = answer(ids[0], 'new', '## New answer\n$$z^2$$'); await fs.appendFile(firstFile, appended);
    await until(() => output.includes('1 new answer'), 'queue Claude output while pinned');
    output = ''; keys('r'); await until(() => output.includes('LIVE') && output.includes('New answer'), 'resume Claude live preview');
    keys('pg'); await until(() => output.includes('Answer context'), 'pin and inspect appended answer');
    output = ''; session = ids[1];
    await until(() => output.includes('Second session') && output.includes('1 items'), 'Claude clear/resume switches identity');
    assert.doesNotMatch(output, /PINNED|Answer context|New answer|Workflow/);
    output = ''; keys('/Workflow\r'); await until(() => output.includes('0 items'), 'search excludes old Claude session');
    assert.equal(await fs.readFile(firstFile, 'utf8'), initial + appended);
    assert.equal(await fs.readFile(secondFile, 'utf8'), second);
    assert.ok(calls.every(c => c.method === 'pane.get' && c.params.pane_id === 'source'), 'no Claude command, terminal scraping or mutating Herdr API');
    keys('q'); await until(() => child.exitCode !== null, 'Claude viewer exits'); assert.equal(child.exitCode, 0);
  } finally {
    child.kill('SIGTERM'); server.close(); await fs.rm(dir, { recursive: true, force: true });
  }
});
