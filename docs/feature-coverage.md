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
- [~] Render headings, emphasis, lists, task lists, quotes, tables, fenced code, allowlisted external Markdown links without raw HTML, KaTeX mathematical notation, Mermaid diagrams as inert SVG images with source and separate-view controls, collapsed thinking blocks, and bounded safe previews of user, assistant, and tool-result images; arbitrary extension renderers remain unsupported.
- [~] Tool cards show live activity and reconstruct persisted calls/results with bounded argument/output previews; per-tool expansion preferences, focused transcript mode, and line-level Pi-context edit diffs are available, while exploration grouping remains unavailable.
- [~] Code blocks can be copied; finished assistant replies link inline code symbols to workspace definitions, while model-generated prompt suggestions are missing. Message quoting, bookmarks, persistent context edits, and context compaction are available.
- [x] Export a redacted diagnostic report with software versions and generic error categories; the report excludes prompt/transcript content, workspace/session paths, file names, provider IDs, credentials, and environment variables.
- [ ] Run shell commands from `!` messages. The required direct command execution was rejected by the automatic security review, so this remains unavailable.

## Sessions

- [x] Create, list, search, rename, pin, color, reorder, reopen, clone, export, and delete workspace sessions.
- [~] Fork from a user message, edit earlier text/context/image prompts into a new branch, and navigate the current branch history. Multi-tab session restore and cross-workspace search remain unavailable.
- [~] Transcript search includes visible thinking and tool output; session search indexes names, messages, assistant thinking, tool calls, and tool outputs within the current workspace. Cross-workspace session search remains unavailable.
- [~] Open the latest session when the chat view starts is optional; multiple independent chat editor tabs, persisted tab restore, and new chat beside a file are unavailable.
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
- [x] Quote selected Git diff lines into the composer, jump from a sent transcript quote to its source message, and expand attached text context from composer chips.

## Pi tools, skills, prompts, extensions, and packages

- [x] Choose Pi defaults, a read-only built-in tool set, no tools, or individual tools per session.
- [x] Browse/invoke skills and persist per-session switches for automatic skill invocation.
- [x] Browse/invoke Pi slash prompt templates.
- [x] Prompt-template argument forms/previews; create project templates; edit loaded templates; show extension, skill, prompt, and theme diagnostics; explicitly reload Pi resources.
- [~] List configured packages; install/remove in user or trusted project scope; confirm package updates; enable/disable individual extensions, skills, prompts, and themes with Pi settings filters. Package gallery/recommendations remain unavailable. Package install/update can run package-manager code and reload executable extensions only after an explicit modal confirmation; enabling an extension requires confirmation and changes take effect only after a confirmed resource reload or a new session.
- [~] Support queued extension select/confirm/input/editor dialogs, notices, status values, plain-text widgets, and composer text. Concurrent dialog responses are matched by request ID, the queue and request payloads are bounded, and pending dialogs are cleared when the Pi session changes. Bounded structured tool details and generic checklist cards render in live and saved sessions; timeouts/signals, arbitrary custom renderers/components, and terminal cards remain unavailable.
- [x] Show and open extension load-error sources and reload Pi resources.
- [~] Browse registered Pi extension commands and request their argument suggestions; completion code runs only after a user click, and suggestions only fill the composer.
- [~] Opt-in connections from Pi's MCP configuration, project trust gating, status/login/reconnect through `/mcp`, and generic tool cards; graphical server controls and per-server exposure edits remain in `mcp.json`.
- [~] Recognize structured single/parallel/chain subagent results; show bounded run metadata, task text, assistant text/tool-call transcripts, usage, and errors. Per-child stop and live activity controls remain unavailable.

## Git review, notifications, and privacy

- [~] Show branch and changed-file summaries, open bounded Git diffs, and discard confirmed tracked unstaged changes by restoring from the index; Pi edit-history review and untracked-file deletion are unavailable.
- [~] Prepare editable commit-message and pull-request prompts with bounded Git change context; Pi generates the draft in the active chat after the user reviews and submits it.
- [x] Show VS Code notifications for a finished run or extension input request while the chat view is hidden.
- [~] A bounded local diagnostic log records timestamps and generic runtime/operation error categories; notification sound and user-defined command hooks remain unavailable.
- [x] Keep session/model traffic local to Pi and the selected provider; the extension adds no account, proxy, or telemetry.
- [ ] Optional OS sandbox for Pi tools.

## Explicit scope and review notes

- Voice dictation is excluded at the user's request.
- Remote phone access is out of scope.
- Direct shell execution from the composer is unimplemented because automatic security review rejected adding that command-execution path.
- Pi tool calls use the user's current Pi permissions; narrower tool sets are available in the extension.
