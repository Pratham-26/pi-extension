# Pi Chat feature coverage

This checklist tracks implemented and pending product capabilities as of 28 October 2026. `[~]` means a partial implementation; `[ ]` means not implemented.

## Pi runtime, models, and settings

- [x] Use Pi's SDK and the user's existing Pi configuration, credentials, extensions, skills, prompt templates, and workspace session files; request trust before loading project-local Pi resources.
- [x] Pick an available model; show provider, context-window size, and image support.
- [x] Search models by provider, name, ID, or vision support; refresh manually and watch `models.json` for updates.
- [x] Choose a thinking level supported by the selected model.
- [x] Save, rename, remove, reorder, and use model/thinking presets.
- [~] OAuth/API-key sign-in through Pi's SDK; open Pi's custom model file and manually refresh remote model catalogs. Provider account balance and in-app custom endpoint forms are not shown.
- [~] Show cumulative tokens and cost for the active session from Pi's recorded usage; provider account quota and balance are unavailable.
- [~] In-app Pi controls for automatic retry, automatic compaction, and cache warming; offline mode, Pi home, environment variables, sandbox, and context-file controls remain unavailable.
- [~] Settings open the extension's searchable VS Code settings and Pi's `settings.json`; extension settings cover editor context and notifications, while other Pi-specific settings must be edited in the file.

## Chat and transcript

- [x] Stream Pi replies; stop a run; show live tool start, update, and result cards.
- [x] Queue follow-ups or steer a running turn; reorder, edit, and remove queued text messages.
- [x] Search the current transcript and step through matches in messages and visible tool output.
- [x] Persist drafts and prompt history by Pi session; quote a message or selected passage into the next prompt.
- [x] Bookmark transcript messages with persistent branch-local bookmarks and jump back to bookmarked messages.
- [x] Omit, edit, or restore user and assistant text in future model context using append-only Pi session edits; the original transcript remains visible.
- [x] Show estimated context usage and warn visually near the model's context limit.
- [x] Offer Pi context compaction near the context limit, with an explicit confirmation and cancellation through Stop.
- [x] Export the active session as HTML or JSONL.
- [~] Render a safe Markdown subset; full Markdown, math, Mermaid, image output, thinking blocks, and extension renderers are not supported.
- [~] Tool cards show live activity; historical tool cards, edit diffs, exploration grouping, focused transcript mode, and per-tool expansion settings are not restored/rendered.
- [~] Code blocks can be copied; symbol links and model-generated prompt suggestions are missing. Message quoting, bookmarks, persistent context edits, and context compaction are available.
- [x] Export a redacted diagnostic report with software versions and generic error categories; the report excludes prompt/transcript content, workspace/session paths, file names, provider IDs, credentials, and environment variables.
- [ ] Run shell commands from `!` messages. The required direct command execution was rejected by the automatic security review, so this remains unavailable.

## Sessions

- [x] Create, list, search, rename, pin, color, reorder, reopen, clone, export, and delete workspace sessions.
- [~] Fork from a user message, edit earlier text/context prompts into a new branch, and navigate the current branch history; original image attachments cannot be restored into the editor.
- [~] Session search is limited to the current workspace and session name/message text; it does not index all workspaces, thinking, or tool calls.
- [ ] Multiple independent chat editor tabs, persisted tab restore, new chat beside a file, and open-latest-session preference.
- [x] Save a local title from the first non-command prompt without an extra provider request; configurable through `piChat.sessions.autoName`.
- [ ] Git worktree sessions, setup commands, ignored-file copying, and safe worktree removal.
- [ ] Group running sessions and expose live progress in the session list.

## Workspace context

- [x] Attach files, folders, images, active-file problems, and Git status; paste images; drag/drop workspace files; optionally add diagnostics and Git status automatically.
- [x] Attach a selected line range manually by line number.
- [x] Type `@` to search workspace files, insert a reference, and attach the selected file.
- [x] Automatically attach a selected-line reference or follow the active file, controlled by extension settings.
- [~] Manual file attachments include bounded text content; automatic editor context uses file/line references. Image context is sent as image content.
- [x] Automatic diagnostics/Git toggles, active-file following, active-file pinning with selected-line updates, and arbitrary line ranges.
- [~] Quote selected Git diff lines into the composer; transcript quotes lack persistent jump-back references, and attached context is not expandable from its chips.

## Pi tools, skills, prompts, extensions, and packages

- [x] Choose Pi defaults, a read-only built-in tool set, no tools, or individual tools per session.
- [x] Browse/invoke skills and persist per-session switches for automatic skill invocation.
- [x] Browse/invoke Pi slash prompt templates.
- [x] Prompt-template argument forms/previews; create project templates; edit loaded templates; show extension, skill, prompt, and theme diagnostics; explicitly reload Pi resources.
- [~] List configured packages; install/remove in user or trusted project scope; confirm and update all configured packages. Package gallery/recommendations and per-resource enable/disable controls are missing. Package install/update can run package-manager code and reload executable extensions only after an explicit modal confirmation.
- [~] Support extension select/confirm/input/editor dialogs, notices, status values, plain-text widgets, and composer text. Concurrent dialogs, timeouts/signals, custom components, renderers, terminal cards, checklist/plan presentation, and native subagent UI are missing.
- [x] Show and open extension load-error sources and reload Pi resources.
- [~] Browse registered Pi extension commands and request their argument suggestions; completion code runs only after a user click, and suggestions only fill the composer.
- [~] Opt-in connections from Pi's MCP configuration, project trust gating, status/login/reconnect through `/mcp`, and generic tool cards; graphical server controls and per-server exposure edits remain in `mcp.json`.
- [ ] Recognize supported subagent tools and show their runs, transcripts, and controls.

## Git review, notifications, and privacy

- [~] Show branch and changed-file summaries, open bounded Git diffs, and discard confirmed tracked unstaged changes by restoring from the index; Pi edit-history review and untracked-file deletion are unavailable.
- [ ] Generate commit messages and pull-request descriptions from Git changes.
- [x] Show VS Code notifications for a finished run or extension input request while the chat view is hidden.
- [ ] Notification sound, user-defined command hooks, and local diagnostic logs.
- [x] Keep session/model traffic local to Pi and the selected provider; the extension adds no account, proxy, or telemetry.
- [ ] Optional OS sandbox for Pi tools.

## Explicit scope and review notes

- Voice dictation is excluded at the user's request.
- Remote phone access is out of scope.
- Direct shell execution from the composer is unimplemented because automatic security review rejected adding that command-execution path.
- Pi tool calls use the user's current Pi permissions; narrower tool sets are available in the extension.
