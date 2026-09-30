import { CodexSource } from './codex.mjs';
import { ClaudeSource } from './claude.mjs';

export { parseRollout } from './codex.mjs';
export { parseClaudeTranscript } from './claude.mjs';

export class SourceReader {
  constructor(options = {}) {
    this.codex = new CodexSource(options);
    this.claude = new ClaudeSource(options);
  }
  resolvePane(pane) {
    if (pane.agent && pane.agent_session && pane.agent !== pane.agent_session.agent) pane = { ...pane, agent_session: undefined };
    return pane.agent === 'claude' || pane.agent_session?.agent === 'claude' ? pane : this.codex.resolvePane(pane);
  }
  read(pane) {
    const agent = pane.agent || pane.agent_session?.agent;
    if (agent === 'claude') return this.claude.read(pane);
    if (agent === 'codex' || !agent) return this.codex.read(pane);
    return { messages: [], origin: 'Unsupported session', limited: false,
      issue: { title: 'This agent is not supported.', hint: 'Open Visuals from a Claude Code or Codex pane; or preview selected text.' } };
  }
  close() { this.codex.close(); }
}
