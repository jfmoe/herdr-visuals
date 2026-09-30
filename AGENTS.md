# Contributor contract

- `npm run check` is the required verification command. It includes real rendering.
- Keep package.json, package-lock.json, and herdr-plugin.toml versions synchronized.
- Never commit session transcripts, exports, host paths, tokens, or test-output images.
- Examples must use generic fictional content, with no dental, clinical, or internal project material.
- Read only the exact Claude Code or Codex session attached to the selected Herdr pane. Do not guess by cwd.
- Claude access is read-only JSONL access. Use Herdr's exact ID/path, retain distinct block UUIDs, and exclude thinking, prompts, meta/sidechain records and tool text. Never modify Claude config/hooks/transcripts, launch/resume a session, or send input.
- Codex app-server access is read-only: initialize, thread/read metadata and thread/items/list for the exact ID only. Never discover, resume or start threads. Live footer identity takes precedence over hooks; losing an observed footer identity clears stale bindings.
- Never follow focus to another session. Scope history/search to the bound session and clear records/pins on explicit source or session identity changes.
- Keep Mermaid strict, KaTeX trust disabled, and browser network/file access restricted.
- Only explicit user export writes conversation content to disk.
- Separate renderer cache invalidation from graphics-layer ownership and teardown.
- Export a captured item, never whichever page happened to render most recently.
- Use the installed Herdr schema when changing API calls; newer online docs may differ.
- Verify the GitHub-installed plugin's action and pane entrypoint before claiming delivery.
