import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { extract, digest } from '../extract.mjs';
import { imageDataURL } from '../images.mjs';
import { sessionID } from './session.mjs';

const MAX_HISTORY_BYTES = 16 * 1024 * 1024;
const MAX_RECORDS = 300;

function unavailable(connected, hint) {
  return { messages: [], origin: 'Exact Claude Code transcript unavailable', limited: false,
    issue: connected ? {
      title: 'The bound Claude Code transcript is unavailable.',
      hint: hint || 'Check the reported transcript and Claude config directory; or preview selected text.',
    } : {
      title: 'Claude Code session is not connected.',
      hint: "Herdr must report this pane's exact Claude session through its existing SessionStart integration; selected-text preview remains available.",
    } };
}

function sessionReference(pane) {
  const session = pane.agent_session;
  if (session?.agent !== 'claude') return null;
  if (session.kind === 'id' && sessionID.test(session.value || '')) return { id: session.value };
  if (session.kind === 'path' && typeof session.value === 'string' && path.isAbsolute(session.value)) {
    const id = path.basename(session.value, '.jsonl');
    if (sessionID.test(id) && path.basename(session.value) === `${id}.jsonl`) return { id, file: session.value };
  }
  return null;
}

export function parseClaudeTranscript(text, { sessionId, cwd } = {}) {
  const records = new Map();
  // A UUID identifies one persisted block, not the whole API response. Keep
  // distinct UUIDs sharing message.id, while replacing a rewritten UUID.
  for (const line of text.split('\n').slice(0, -1)) {
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    if (row.sessionId !== sessionId || typeof row.uuid !== 'string' || !row.uuid ||
        row.isSidechain || row.isMeta || row.isCompactSummary) continue;
    if (row.type === 'assistant' || row.type === 'user') records.set(row.uuid, row);
  }

  const messages = [];
  let turn = 0;
  for (const row of records.values()) {
    const message = row.message;
    const content = Array.isArray(message?.content) ? message.content : [];
    const sourceCwd = typeof row.cwd === 'string' ? row.cwd : cwd;
    if (row.type === 'user' && message?.role === 'user') {
      const results = content.filter(c => c?.type === 'tool_result');
      if (!results.length && (typeof message.content === 'string' || content.some(c => c?.type === 'text' || c?.type === 'image'))) turn++;
      for (const result of results) {
        if (result.is_error || typeof result.tool_use_id !== 'string' || !Array.isArray(result.content)) continue;
        result.content.forEach((block, index) => {
          if (block?.type !== 'image' || block.source?.type !== 'base64') return;
          const imageData = imageDataURL({ type: 'image', mimeType: block.source.media_type, data: block.source.data });
          if (!imageData) return;
          const id = digest(`${sessionId}:${row.uuid}:${result.tool_use_id}:${index}:${imageData}`);
          const title = `Tool image ${index + 1}`;
          const text = `${title}\nEmbedded image returned by a Claude Code tool.`;
          messages.push({ id, turn, kind: 'image', text, timestamp: row.timestamp, blocks: [{
            id: `${id}:image`, messageId: id, type: 'image', source: title, title,
            context: 'Conversation image', imageData, line: 1, raw: text, cwd: sourceCwd,
          }] });
        });
      }
    } else if (row.type === 'assistant' && message?.role === 'assistant') {
      const text = content.filter(c => c?.type === 'text' && typeof c.text === 'string').map(c => c.text).join('\n');
      if (!text.trim()) continue;
      const id = digest(`${sessionId}:${row.uuid}:${text}`);
      messages.push({ id, turn, text, timestamp: row.timestamp, blocks: extract(text, id, sourceCwd) });
    }
  }
  return messages;
}

export class ClaudeSource {
  constructor({ claudeHome = process.env.HERDR_VISUALS_CLAUDE_HOME || process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude') } = {}) {
    this.home = claudeHome;
  }
  async resolve(reference) {
    if (reference.file) return reference.file;
    const files = [];
    for await (const file of fs.glob(`*/${reference.id}.jsonl`, { cwd: path.join(this.home, 'projects') })) {
      files.push(path.join(this.home, 'projects', file));
      if (files.length > 1) throw new Error('More than one transcript has this session ID. Herdr must report an exact path.');
    }
    return files[0];
  }
  async read(pane) {
    const reference = sessionReference(pane);
    if (!reference) return unavailable(pane.agent_session?.agent === 'claude');
    try {
      let file = await this.resolve(reference);
      if (!file) return unavailable(true);
      let handle;
      try { handle = await fs.open(file, constants.O_RDONLY | constants.O_NONBLOCK); }
      catch (error) {
        if (error.code !== 'ENOENT' || reference.file) throw error;
        this.last = null;
        file = await this.resolve(reference);
        if (!file) return unavailable(true);
        handle = await fs.open(file, constants.O_RDONLY | constants.O_NONBLOCK);
      }
      try {
        const stat = await handle.stat();
        if (!stat.isFile()) throw new Error('Claude transcript is not a regular file.');
        if (this.last?.file === file && this.last.size === stat.size && this.last.mtime === stat.mtimeMs &&
            this.last.ino === stat.ino && this.last.dev === stat.dev) return this.last.value;
        const start = Math.max(0, stat.size - MAX_HISTORY_BYTES);
        const buffer = Buffer.alloc(stat.size - start);
        let bytesRead = 0;
        while (bytesRead < buffer.length) {
          const part = await handle.read(buffer, bytesRead, buffer.length - bytesRead, start + bytesRead);
          if (!part.bytesRead) break;
          bytesRead += part.bytesRead;
        }
        let text = buffer.subarray(0, bytesRead).toString('utf8');
        if (start) text = text.slice(text.indexOf('\n') + 1);
        const messages = parseClaudeTranscript(text, { sessionId: reference.id, cwd: pane.foreground_cwd || pane.cwd });
        const value = { messages: messages.slice(-MAX_RECORDS), origin: 'Claude Code transcript',
          limited: start > 0 || messages.length > MAX_RECORDS, issue: null };
        this.last = { id: reference.id, file, size: stat.size, mtime: stat.mtimeMs, ino: stat.ino, dev: stat.dev, value };
        return value;
      } finally { await handle.close(); }
    } catch (error) {
      this.last = null;
      return unavailable(true, error.message);
    }
  }
}
