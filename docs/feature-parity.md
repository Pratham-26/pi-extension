# Pendant feature parity

This checklist follows Pendant's published [guide](https://pendant.sh/guide/) as checked on 28 October 2026. It tracks behavior, not copied implementation. `[~]` means a partial implementation; `[ ]` means not implemented.

## Pi runtime, models, and settings

- [x] Use Pi's SDK and the user's existing Pi configuration, credentials, extensions, skills, prompt templates, and workspace session files.
- [x] Pick an available model; show provider, context-window size, and image support.
- [x] Search models by provider, name, ID, or vision support; refresh manually and watch `models.json` for updates.
- [x] Choose a thinking level supported by the selected model.
- [x] Save, rename, remove, reorder, and use model/thinking presets.
- [ ] Provider onboarding: OAuth/API-key login, custom provider setup, and custom-provider model discovery.
- [ ] Show provider usage or balance.
- [ ] Pi settings controls for offline mode, Pi home, environment variables, retry policy, cache warming, sandbox, and context files.
- [~] A settings command opens the extension's searchable VS Code settings; the settings surface currently covers editor-context behavior and notifications only.

## Chat and transcript

- [x] Stream Pi replies; stop a run; show live tool start, update, and result cards.
- [x] Queue follow-ups or steer a running turn; reorder, edit, and remove queued text messages.
- [x] Search the current transcript and step through matches in messages and visible tool output.
- [x] Persist drafts and prompt history by Pi session; quote a message or selected passage into the next prompt.
- [x] Bookmark transcript messages with persistent branch-local bookmarks and jump back to bookmarked messages.
- [x] Show estimated context usage and warn visually near the model's context limit.
- [x] Offer Pi context compaction near the context limit, with an explicit confirmation and cancellation through Stop.
- [x] Export the active session as HTML or JSONL.
- [~] Render a safe Markdown subset; full Markdown, math, Mermaid, image output, thinking blocks, and extension renderers are not supported.
- [~] Tool cards show live activity; historical tool cards, edit diffs, exploration grouping, focused transcript mode, and per-tool expansion settings are not restored/rendered.
- [~] Code blocks can be copied; symbol links and model-generated prompt suggestions are missing. Message quoting, bookmark lists, and context compaction are available.
- [ ] Redacted diagnostic/bug-report export.
- [ ] Run shell commands from `!` messages. The required direct command execution was rejected by the automatic security review, so this remains unavailable.

## Sessions

- [x] Create, list, search, rename, pin, color, reorder, reopen, export, and delete workspace sessions.
- [x] Fork from a user message and navigate the current branch history.
- [~] Session search is limited to the current workspace and session name/message text; it does not index all workspaces, thinking, or tool calls.
- [ ] Multiple independent chat editor tabs, persisted tab restore, new chat beside a file, and open-latest-session preference.
- [ ] Clone a session, edit a previous user message into a new branch, or auto-name a session.
- [ ] Git worktree sessions, setup commands, ignored-file copying, and safe worktree removal.
- [ ] Group running sessions and expose live progress in the session list.
- [ ] Export a redacted bug report with optional diagnostics.

## Workspace context

- [x] Attach files, folders, images, active-file problems, and Git status; paste images; drag/drop workspace files; optionally add diagnostics and Git status automatically.
- [x] Attach a selected line range manually by line number.
- [x] Type `@` to search workspace files, insert a reference, and attach the selected file.
- [x] Automatically attach a selected-line reference or follow the active file, controlled by extension settings.
- [~] Manual file attachments include bounded text content; automatic editor context uses file/line references. Image context is sent as image content.
- [~] Automatic diagnostics/Git toggles, active-file following, and arbitrary line ranges are available; pinning an active file until removed is missing.
- [ ] Quote diff lines, quote transcript passages with persistent jump-back references, and show full attached context as compact chips.

## Pi tools, skills, prompts, extensions, and packages

- [x] Choose Pi defaults, a read-only built-in tool set, no tools, or individual tools per session.
- [x] Browse/invoke skills and persist per-session switches for automatic skill invocation.
- [x] Browse/invoke Pi slash prompt templates.
- [x] Prompt-template argument forms/previews; create project templates; edit loaded templates; show extension, skill, prompt, and theme diagnostics; explicitly reload Pi resources.
- [ ] Browse/install/update/remove packages; choose user/project scope; enable/disable package resources; recommendations.
- [~] Support extension select/confirm/input/editor dialogs, notices, status values, plain-text widgets, and composer text. Concurrent dialogs, timeouts/signals, custom components, renderers, terminal cards, checklist/plan presentation, and native subagent UI are missing.
- [~] Show and open extension load-error sources and reload Pi resources; package-manager controls are missing.
- [ ] Extension command/action picker and argument autocomplete.
- [ ] MCP server manager and supported web/MCP tool cards.
- [ ] Recognize supported subagent tools and show their runs, transcripts, and controls.

## Git review, notifications, and privacy

- [ ] Show edit diffs and changed-file summaries; safely revert recorded edits.
- [ ] Generate commit messages and pull-request descriptions from Git changes.
- [x] Show VS Code notifications for a finished run or extension input request while the chat view is hidden.
- [ ] Notification sound, user-defined command hooks, and local diagnostic logs.
- [x] Keep session/model traffic local to Pi and the selected provider; the extension adds no account, proxy, or telemetry.
- [ ] Optional OS sandbox for Pi tools.

## Explicit scope and review notes

- Voice dictation is excluded at the user's request.
- Pendant's guide describes phone access as internal development, not a published feature; it is excluded.
- Direct shell execution from the composer is unimplemented because automatic security review rejected adding that command-execution path.
- Pendant does not ask before agent tools run; this extension offers narrower tool sets instead.
