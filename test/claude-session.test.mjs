import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseClaudeTranscript, SourceReader } from '../src/sources/index.mjs';
import { answerContext } from '../src/navigation.mjs';
import { PreviewModel } from '../src/model.mjs';

const ids = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'];
const pixel = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLttAAAAABJRU5ErkJggg==';
const image = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: pixel } };
const row = (uuid, type, content, extra = {}) => ({ uuid, parentUuid: null, sessionId: ids[0], cwd: '/fixture/project',
  timestamp: '2026-01-01T00:00:00Z', type, message: { id: 'shared-api-message', role: type, content }, ...extra });
const answer = (uuid, text, extra) => row(uuid, 'assistant', [{ type: 'text', text }], extra);
const jsonl = rows => rows.map(JSON.stringify).join('\n') + '\n';
const pane = id => ({ pane_id: 'source', agent: 'claude', agent_session: { agent: 'claude', kind: 'id', value: id } });

test('Claude assistant blocks sharing an API message ID keep text, equations and local image context', () => {
  const messages = parseClaudeTranscript(jsonl([
    row('prompt', 'user', 'Show a fictional workflow.'),
    row('thinking', 'assistant', [{ type: 'thinking', thinking: '$$PRIVATE$$' }]),
    answer('diagram', '## Workflow\n```mermaid\nflowchart LR\nA --> B\n```'),
    row('tool', 'assistant', [{ type: 'tool_use', id: 'call', name: 'Read', input: { file_path: '/fixture/hidden.png' } }]),
    answer('equation', '## Equation\n$$x^2$$\n[Chart](assets/chart.png)'),
    answer('subagent', '$$SIDECHAIN$$', { isSidechain: true }),
    answer('meta', '$$META$$', { isMeta: true }),
    answer('other-session', '$$UNRELATED$$', { sessionId: ids[1] }),
    row('summary', 'user', '$$SUMMARY$$', { isCompactSummary: true }),
    { type: 'system', subtype: 'compact_boundary', uuid: 'boundary', sessionId: ids[0] },
    answer('after-compact', '$$z$$'),
  ]), { sessionId: ids[0] });
  assert.deepEqual(messages.flatMap(m => m.blocks).map(b => b.type), ['mermaid', 'math', 'image', 'math']);
  assert.equal(messages.length, 3);
  assert.ok(messages.every(m => m.turn === 1));
  assert.equal(messages[1].blocks[1].cwd, '/fixture/project');
  const context = answerContext(messages, messages[0].blocks[0]);
  assert.equal(context.lines[context.start], '```mermaid');
  assert.doesNotMatch(messages.map(m => m.text).join('\n'), /PRIVATE|SIDECHAIN|META|UNRELATED|SUMMARY|hidden/);
});

test('Claude typed tool images preserve parallel results without parsing logs or user attachments', () => {
  const messages = parseClaudeTranscript(jsonl([
    row('prompt', 'user', [image, { type: 'text', text: '$$PROMPT$$' }]),
    row('tool-a', 'assistant', [{ type: 'tool_use', id: 'a', name: 'Read', input: {} }]),
    row('tool-b', 'assistant', [{ type: 'tool_use', id: 'b', name: 'Read', input: {} }], { parentUuid: 'tool-a' }),
    row('result-a', 'user', [{ type: 'tool_result', tool_use_id: 'a', content: [image, { type: 'text', text: '/fixture/private.png' }] }], { parentUuid: 'tool-a' }),
    row('result-b', 'user', [{ type: 'tool_result', tool_use_id: 'b', content: [image] }], { parentUuid: 'tool-b' }),
    row('logs', 'user', [{ type: 'tool_result', tool_use_id: 'c', content: '/fixture/log.png' }]),
    row('failed', 'user', [{ type: 'tool_result', tool_use_id: 'd', is_error: true, content: [image] }]),
    row('remote', 'user', [{ type: 'tool_result', tool_use_id: 'e', content: [{ type: 'image', source: { type: 'url', url: 'https://example.invalid/image.png' } }] }]),
    answer('final', 'Both pictures are available.'),
  ]), { sessionId: ids[0] });
  const blocks = messages.flatMap(m => m.blocks);
  assert.equal(blocks.length, 2);
  assert.ok(blocks.every(b => b.imageData === `data:image/png;base64,${pixel}`));
  assert.notEqual(blocks[0].id, blocks[1].id);
  assert.ok(messages.every(m => m.turn === 1));
  const model = new PreviewModel(); model.update(messages); model.history = false;
  assert.equal(model.items.length, 2, 'latest turn retains images despite a plain-text final response');
  assert.equal(answerContext(messages, blocks[0]).kind, 'image');
  assert.doesNotMatch(messages.map(m => m.text).join('\n'), /PROMPT|private|log.png|base64/);
});

test('Claude UUID revisions replace one block and incomplete lines wait for completion', () => {
  const records = jsonl([answer('block', '$$old$$'), answer('block', '$$new$$')]);
  const pending = JSON.stringify(answer('next', '$$next$$'));
  assert.deepEqual(parseClaudeTranscript(records + pending, { sessionId: ids[0] }).map(m => m.blocks[0].source), ['new']);
  assert.deepEqual(parseClaudeTranscript(records + pending + '\n', { sessionId: ids[0] }).map(m => m.blocks[0].source), ['new', 'next']);
  assert.equal(parseClaudeTranscript(jsonl([answer('unfinished', '```mermaid\nflowchart LR\nA-->B')]), { sessionId: ids[0] })[0].blocks.length, 0);
});

test('Claude reads only exact sessions, follows appends and replacement, and leaves files unchanged', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hv-claude-'));
  const project = path.join(dir, 'projects', 'fictional');
  await fs.mkdir(project, { recursive: true });
  const file = path.join(project, `${ids[0]}.jsonl`), other = path.join(project, `${ids[1]}.jsonl`);
  const original = jsonl([answer('one', '$$one$$')]);
  const unrelated = jsonl([answer('two', '$$unrelated$$', { sessionId: ids[1] })]);
  await fs.writeFile(file, original); await fs.writeFile(other, unrelated);
  const reader = new SourceReader({ claudeHome: dir, history: { read() { assert.fail('Claude must never access Codex history'); } } });
  try {
    const current = pane(ids[0]);
    assert.equal((await reader.read(current)).messages[0].blocks[0].source, 'one');
    assert.equal(await fs.readFile(file, 'utf8'), original);
    const incomplete = JSON.stringify(answer('next', '$$next$$'));
    await fs.appendFile(file, incomplete);
    assert.equal((await reader.read(current)).messages.length, 1);
    await fs.appendFile(file, '\n');
    assert.equal((await reader.read(current)).messages.length, 2);
    assert.equal(await fs.readFile(file, 'utf8'), original + incomplete + '\n');
    const replacement = path.join(project, 'replacement');
    await fs.writeFile(replacement, jsonl([answer('replacement', '$$replacement$$')]));
    await fs.rename(replacement, file);
    assert.equal((await reader.read(current)).messages[0].blocks[0].source, 'replacement');
    assert.equal((await reader.read(pane(ids[1]))).messages[0].blocks[0].source, 'unrelated');
    await fs.unlink(file);
    assert.equal((await reader.read(current)).issue.title, 'The bound Claude Code transcript is unavailable.');
    assert.equal(await fs.readFile(other, 'utf8'), unrelated);
    assert.equal((await reader.read({ agent: 'claude' })).issue.title, 'Claude Code session is not connected.');
    assert.match((await reader.read(pane('../../invalid'))).origin, /unavailable/);
  } finally { reader.close(); await fs.rm(dir, { recursive: true, force: true }); }
});

test('Claude exact paths take precedence while duplicate IDs and non-regular paths fail closed', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hv-claude-path-'));
  const first = path.join(dir, 'projects', 'first'), second = path.join(dir, 'projects', 'second');
  await fs.mkdir(first, { recursive: true }); await fs.mkdir(second);
  const file = path.join(first, `${ids[0]}.jsonl`);
  await fs.writeFile(file, jsonl([answer('one', '$$one$$')]));
  await fs.writeFile(path.join(second, `${ids[0]}.jsonl`), jsonl([answer('two', '$$two$$')]));
  const reader = new SourceReader({ claudeHome: dir });
  try {
    assert.match((await reader.read(pane(ids[0]))).issue.hint, /More than one transcript/);
    const duplicate = path.join(second, `${ids[0]}.jsonl`);
    await fs.unlink(duplicate);
    assert.equal((await reader.read(pane(ids[0]))).messages[0].blocks[0].source, 'one');
    await fs.writeFile(duplicate, jsonl([answer('two', '$$two$$')]));
    assert.match((await reader.read(pane(ids[0]))).issue.hint, /More than one transcript/, 'new duplicate files invalidate a previously unique lookup');
    const exact = { agent: 'claude', agent_session: { agent: 'claude', kind: 'path', value: file } };
    assert.equal((await reader.read(exact)).messages[0].blocks[0].source, 'one');
    assert.match((await reader.read(pane(ids[0]))).issue.hint, /More than one transcript/, 'an exact path cannot seed ambiguous ID lookup');
    assert.equal((await reader.read({ ...exact, agent_session: { ...exact.agent_session, value: 'relative.jsonl' } })).messages.length, 0);
    await fs.unlink(file);
    assert.equal(spawnSync('mkfifo', [file]).status, 0);
    assert.match((await reader.read(exact)).issue.hint, /regular file/);
  } finally { reader.close(); await fs.rm(dir, { recursive: true, force: true }); }
});

test('Claude history limits are labeled and subagent files are not discovered', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hv-claude-limit-'));
  const project = path.join(dir, 'projects', 'fictional'); await fs.mkdir(project, { recursive: true });
  const file = path.join(project, `${ids[0]}.jsonl`);
  await fs.writeFile(file, jsonl(Array.from({ length: 301 }, (_, i) => answer(`answer-${i}`, `$$x_${i}$$`))));
  const reader = new SourceReader({ claudeHome: dir });
  try {
    const value = await reader.read(pane(ids[0]));
    assert.equal(value.messages.length, 300); assert.equal(value.limited, true);
    assert.equal(value.messages[0].blocks[0].source, 'x_1');
    await fs.writeFile(file, JSON.stringify({ ignored: 'x'.repeat(16 * 1024 * 1024) }) + '\n' + jsonl([answer('latest', '$$latest$$')]));
    const tail = await reader.read(pane(ids[0]));
    assert.equal(tail.limited, true); assert.equal(tail.messages[0].blocks[0].source, 'latest');
    await fs.unlink(file);
    const nested = path.join(project, ids[0], 'subagents'); await fs.mkdir(nested, { recursive: true });
    await fs.writeFile(path.join(nested, `${ids[0]}.jsonl`), jsonl([answer('subagent', '$$hidden$$')]));
    assert.equal((await reader.read(pane(ids[0]))).messages.length, 0);
  } finally { reader.close(); await fs.rm(dir, { recursive: true, force: true }); }
});

test('a Claude binding survives a former Codex footer and a stale agent binding is cleared', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hv-switch-agent-'));
  await fs.writeFile(path.join(dir, 'config.toml'), '[tui]\nstatus_line=["thread-id"]\n');
  let reads = 0, footer = `${ids[0]} · model`;
  const reader = new SourceReader({ codexHome: dir, readFooter: async () => { reads++; return footer; } });
  try {
    const codex = { pane_id: 'source', terminal_id: 'same', agent: 'codex' };
    assert.equal((await reader.resolvePane(codex)).agent_session.value, ids[0]);
    const claude = { ...pane(ids[1]), terminal_id: 'same' };
    assert.deepEqual(await reader.resolvePane(claude), claude);
    assert.equal(reads, 1, 'Claude never scrapes a terminal footer');
    footer = 'model';
    assert.equal((await reader.resolvePane({ ...claude, agent: 'codex' })).agent_session, undefined);
  } finally { reader.close(); await fs.rm(dir, { recursive: true, force: true }); }
});
