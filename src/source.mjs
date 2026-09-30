import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { extract, digest } from './extract.mjs';
import { imageDataURL, IMAGE_EXT, resolveImage } from './images.mjs';
import { parse as parseToml } from 'smol-toml';
import { CodexHistory, sessionID } from './codex.mjs';
import { rpc } from './herdr.mjs';

function unavailable(connected) {
  return { messages: [], origin: 'Exact Codex transcript unavailable', limited: false,
    issue: connected ? {
      title: 'The bound Codex transcript is unavailable.',
      hint: 'Check the Codex home and transcript location; or preview selected text.',
    } : {
      title: 'Codex session is not connected.',
      hint: "Enable thread-id first in the Codex status line; or check Herdr's SessionStart binding.",
    } };
}

function outputContent(output) {
  if (typeof output === 'string') {
    try { output = JSON.parse(output); } catch { return []; }
  }
  const content = Array.isArray(output) ? output : output?.content;
  return Array.isArray(content) ? content : [];
}

function generatedImage(row) {
  let p = row.payload;
  if (row.type === 'event_msg' && p?.type === 'item_completed' &&
      (p.item?.type === 'ImageGeneration' ||
       (p.item?.type === 'Extension' && p.item.kind === 'image_gen.generation'))) {
    p = { ...p.item, saved_path: p.item.savedPath ?? p.item.saved_path };
  } else if (!(row.type === 'event_msg' && p?.type === 'image_generation_end') &&
      !(row.type === 'response_item' && p?.type === 'image_generation_call')) return null;
  if (p.status !== 'completed' || p.failure) return null;
  const imageData = imageDataURL({ type: 'image', mimeType: 'image/png', data: p.result });
  let source;
  if (typeof p.saved_path === 'string') {
    try {
      if (path.isAbsolute(p.saved_path) || p.saved_path.startsWith('file://')) {
        const file = resolveImage(p.saved_path);
        if (IMAGE_EXT.test(file)) source = file;
      }
    } catch { /* remote or malformed saved paths are not image sources */ }
  }
  return imageData || source ? { imageData, source, callId: p.call_id || p.id } : null;
}

export function parseRollout(text, { cwd } = {}) {
  const messages = [], generatedCalls = new Map();
  let turn = 0;
  function addImage(row, index, { imageData, source, callId }, generated = false) {
    const id = digest(`${row.timestamp}:${callId || row.payload.call_id || row.payload.id || ''}:${index}:${imageData || source}`);
    const title = generated ? 'Generated image' : `Image ${index + 1}`;
    const text = `${title}\n${generated ? 'Generated image' : 'Embedded image displayed'} in this conversation.`;
    messages.push({ id, turn, kind: 'image', text, timestamp: row.timestamp, blocks: [{
      id: `${id}:image`, messageId: id, type: 'image', source: source || title, title,
      context: 'Conversation image', ...(imageData ? { imageData } : {}), line: 1, raw: text, cwd,
    }] });
    return messages.at(-1);
  }
  function mergeImage(message, { imageData, source }) {
    const block = message.blocks[0];
    const nextData = block.imageData || imageData;
    const nextSource = source || block.source;
    if (nextData === block.imageData && nextSource === block.source) return;
    // An appended embedded result must invalidate a previously rendered file
    // fallback, including a missing-file error, without changing source scope.
    message.id = digest(`${message.id}:${nextSource}:${nextData || ''}`);
    Object.assign(block, { source: nextSource, ...(nextData ? { imageData: nextData } : {}), id: `${message.id}:image`, messageId: message.id });
  }
  for (const line of text.split('\n')) {
    let row;
    try { row = JSON.parse(line); } catch { continue; } // append-in-progress or tail starts mid-record
    const p = row.payload;
    if (['session_meta', 'turn_context'].includes(row.type) && typeof p?.cwd === 'string') cwd = p.cwd;
    const generated = generatedImage(row);
    if (generated) {
      const key = generated.callId && `${turn}:${generated.callId}`;
      const previous = key && generatedCalls.get(key);
      if (previous) {
        mergeImage(previous, generated);
      } else {
        const message = addImage(row, 0, generated, true);
        if (key) generatedCalls.set(key, message);
      }
      continue;
    }
    if (row.type === 'response_item' && p?.type === 'image_view') {
      try {
        if (typeof p.path === 'string' && path.isAbsolute(p.path) && IMAGE_EXT.test(p.path)) {
          addImage(row, 0, { source: resolveImage(p.path) });
        }
      } catch { /* invalid typed paths do not become image sources */ }
      continue;
    }
    if (row.type === 'response_item' && ['function_call_output', 'custom_tool_call_output'].includes(p?.type)) {
      const content = outputContent(p.output);
      const images = content.map(imageDataURL).filter(Boolean);
      // Code-mode output has a different call ID. Its saved-path hint can match
      // an already validated generation record; text alone never creates items.
      const hints = content.filter(c => c.type === 'input_text' && typeof c.text === 'string').map(c => c.text);
      const matches = images.length === 1 ? [...generatedCalls.values()].filter(m => {
        const source = m.blocks[0].source;
        return m.turn === turn && path.isAbsolute(source) && hints.some(t =>
          [source, pathToFileURL(source).href].some(value => t.includes(` as ${value} by default.`)));
      }) : [];
      images.forEach((imageData, index) => {
        const generated = index === 0 && (generatedCalls.get(`${turn}:${p.call_id}`) || (matches.length === 1 && matches[0]));
        if (generated) mergeImage(generated, { imageData });
        else addImage(row, index, { imageData });
      });
      continue;
    }
    if (row.type !== 'response_item' || p?.type !== 'message') continue;
    if (p.role === 'user') { turn++; continue; }
    if (p.role !== 'assistant' || (p.phase && !['final', 'final_answer'].includes(p.phase))) continue;
    const content = (p.content || []).filter(c => c.type === 'output_text').map(c => c.text).join('\n');
    if (!content.trim()) continue;
    const id = digest(`${row.timestamp}:${p.id || ''}:${content}`);
    messages.push({ id, turn, text: content, timestamp: row.timestamp, blocks: extract(content, id, cwd) });
  }
  return messages.slice(-300);
}

export class SourceReader {
  constructor({ codexHome = process.env.HERDR_VISUALS_CODEX_HOME || process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), history, readFooter } = {}) {
    this.codexHome = codexHome; this.cache = new Map(); this.footerPanes = new Set();
    this.history = history || new CodexHistory(codexHome);
    this.readFooter = readFooter || (async pane => (await rpc('pane.read', { pane_id: pane.pane_id, source: 'visible', lines: 3 })).read.text);
  }
  async resolvePane(pane) {
    if (!pane.pane_id) return pane;
    const key = `${pane.pane_id}:${pane.terminal_id || ''}`;
    const fallback = () => this.footerPanes.has(key) ? { ...pane, agent_session: undefined } : pane;
    if (pane.agent !== 'codex') return fallback();
    let configured;
    try {
      const config = parseToml(await fs.readFile(path.join(this.codexHome, 'config.toml'), 'utf8'));
      configured = ['thread-id', 'session-id'].includes(config.tui?.status_line?.[0]);
    } catch { return fallback(); }
    if (!configured) return fallback();
    // This is only the live footer's explicit identifier, never a transcript,
    // status card in scrollback, title substring, or cwd/session-list heuristic.
    let text;
    try { text = await this.readFooter(pane); } catch { return fallback(); }
    if (typeof text !== 'string') return fallback();
    const footer = text.trimEnd().split('\n').slice(-3);
    const matches = footer.map(line => line.trim().match(/^([a-f\d-]{36})(?:\s+[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏])?\s+·\s+/i)?.[1]).filter(id => sessionID.test(id || ''));
    // Once a terminal supplies live identity, missing/ambiguous identity must
    // clear it rather than falling back to an older hook's session.
    if (matches.length !== 1) return fallback();
    this.footerPanes.add(key);
    return { ...pane, agent_session: { agent: 'codex', kind: 'id', value: matches[0], source: 'visuals:codex-footer' } };
  }
  close() { this.history.close?.(); }
  async resolve(id) {
    if (!/^[a-f\d-]{36}$/i.test(id || '')) return null;
    const cached = this.cache.get(id);
    if (cached?.file || (cached && Date.now() - cached.at < 10000)) return cached?.file;
    let file = null;
    // UUIDv7 gives the creation date, avoiding a directory-wide walk in the common case.
    const millis = parseInt(id.replaceAll('-', '').slice(0, 12), 16);
    const date = new Date(millis);
    const guess = path.join(this.codexHome, 'sessions', String(date.getUTCFullYear()), String(date.getUTCMonth() + 1).padStart(2, '0'), String(date.getUTCDate()).padStart(2, '0'));
    try { file = (await fs.readdir(guess)).find(n => n.endsWith(`${id}.jsonl`)); if (file) file = path.join(guess, file); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    if (!file) {
      for (const directory of ['sessions', 'archived_sessions']) {
        for await (const candidate of fs.glob(`**/*${id}.jsonl`, { cwd: path.join(this.codexHome, directory) })) {
          file = path.join(this.codexHome, directory, candidate); break;
        }
        if (file) break;
      }
    }
    this.cache.set(id, { at: Date.now(), file });
    return file;
  }
  async read(pane) {
    if (pane.agent_session?.agent === 'codex' && pane.agent_session.kind === 'id') {
      const id = pane.agent_session.value;
      if (!sessionID.test(id || '')) return unavailable(true);
      try {
        const current = await this.history.read(id);
        if (current) return { messages: parseRollout(current.rows.map(row => JSON.stringify(row)).join('\n'), { cwd: current.cwd || pane.foreground_cwd || pane.cwd }), origin: 'Codex history', limited: current.limited, issue: null };
      } catch (error) {
        // A known active server failure must not silently show a stale snapshot.
        return { ...unavailable(true), issue: { title: 'The bound Codex history is unavailable.', hint: error.message } };
      }
      let file = await this.resolve(id);
      if (file) {
        try { await fs.access(file); }
        catch (error) {
          if (error.code !== 'ENOENT') throw error;
          this.cache.delete(id); this.last = null; file = await this.resolve(id);
        }
      }
      if (file) {
        const stat = await fs.stat(file);
        if (this.last?.file === file && this.last.size === stat.size && this.last.mtime === stat.mtimeMs) return this.last.value;
        const handle = await fs.open(file, 'r');
        let text;
        try {
          const start = Math.max(0, stat.size - 16 * 1024 * 1024);
          const buffer = Buffer.alloc(stat.size - start);
          const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
          text = buffer.subarray(0, bytesRead).toString('utf8');
        } finally { await handle.close(); }
        const value = { messages: parseRollout(text, { cwd: pane.foreground_cwd || pane.cwd }), origin: 'Codex transcript', limited: stat.size > 16 * 1024 * 1024, issue: null };
        this.last = { file, size: stat.size, mtime: stat.mtimeMs, value };
        return value;
      }
    }
    // A terminal's scrollback can contain earlier sessions. Never use it as
    // a substitute for the exact session transcript.
    return unavailable(pane.agent_session?.agent === 'codex' && pane.agent_session.kind === 'id');
  }
}
