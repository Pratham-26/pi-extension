# Pi Chat feature coverage

This checklist tracks implemented and pending product capabilities as of 28 October 2026. `[~]` means a partial implementation; `[ ]` means not implemented.

## Pi runtime, models, and settings

- [x] Use Pi's SDK and the user's existing Pi configuration, credentials, extensions, skills, prompt templates, and workspace session files; request trust before loading project-local Pi resources.
- [x] Pick an available model before the first prompt; show provider, context-window size, and image support.
- [x] Search models by provider, name, ID, or vision support; refresh manually and watch `models.json` for updates.
- [x] Choose a thinking level supported by the selected model.
- [x] Save, rename, remove, reorder, and use model/thinking presets.
- [~] OAuth/API-key sign-in through Pi's SDK; guided custom endpoint setup supports six built-in API formats plus API identifiers registered by loaded Pi extensions, with optional keys stored in VS Code SecretStorage and referenced from `models.json` through a Pi runtime variable. Manual catalog refresh remains available; automatic startup refresh is opt-in, requires an explicit warning confirmation, and is skipped in Pi offline mode. Provider account quota/balance are unavailable.
- [~] Show cumulative tokens and cost for the active session from Pi's recorded usage; provider account quota and balance are unavailable.
- [~] In-app Pi controls for automatic retry, automatic compaction, cache warming, and Pi startup network mode; Pi's configuration folder can be changed with a machine-scoped setting and folder picker. A per-workspace picker enables or excludes up to 500 Pi-discovered `AGENTS.md` context files and applies changes through a confirmed resource reload. Manage up to 32 uppercase custom runtime variables through VS Code SecretStorage (8,192 characters total); values are hidden during entry, excluded from diagnostics, and passed to Pi, its tools, and loaded extensions only after a manual runtime restart. Process-loader and runtime-control names are blocked. An OS sandbox remains unavailable.
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
- [~] Render headings, emphasis, lists, task lists, quotes, tables, fenced code, allowlisted external Markdown links without raw HTML, KaTeX mathematical notation, Mermaid diagrams as inert SVG images with source and separate-view controls, collapsed thinking blocks, and bounded safe previews of user, assistant, and tool-result images. Pi tool call/result renderers run in the Pi worker for live calls and the latest 50 saved tool calls, with older saved tool cards rendered on demand when expanded; loaded Pi custom-message and custom-entry renderers run for the latest 50 entries, with bounded terminal text and allowlisted ANSI styles converted to DOM text/classes. Loaded Pi Markdown transformers apply to user, assistant, and thinking transcript text, with transform input/output bounded to 100,000 characters.
- [~] Tool cards show live activity and reconstruct persisted calls/results with bounded argument/output previews; consecutive built-in `read`, `grep`, `find`, and `ls` calls group into a collapsible exploration section. Per-tool expansion preferences, focused transcript mode, line-level Pi-context edit diffs, and bounded inline Pi context-edit history are available; broader tool grouping remains unavailable.
- [~] Code blocks can be copied; finished assistant replies link inline code symbols to workspace definitions; users can request up to three follow-up prompts from the current model, with the auxiliary request recorded in session usage and suggestions added to the composer only when clicked. Message quoting, bookmarks, persistent context edits, and context compaction are available.
- [x] Export a redacted diagnostic report with software versions and generic error categories; the report excludes prompt/transcript content, workspace/session paths, file names, provider IDs, credentials, and environment variables.
- [ ] Run shell commands from `!` messages. The required direct command execution was rejected by the automatic security review, so this remains unavailable.

## Sessions

- [x] Create, list, search, rename, pin, color, reorder, reopen, clone, export, and delete workspace sessions; opt-in search reaches sessions across Pi workspaces, and a foreign result opens in its own VS Code window after confirmation.
- [~] Fork from a user message, edit earlier text/context/image prompts into a new branch, and navigate the current branch history. Editor chat tabs restore their session when it is still listed in the same workspace.
- [~] Transcript search includes visible thinking and tool output; session search indexes names, messages, assistant thinking, tool calls, and tool outputs in the current workspace by default, with an opt-in all-workspaces search. Foreign sessions load in the matching workspace so Pi applies that folder's tool paths and trust rules.
- [~] Open the latest session when the chat view starts is optional; multiple independent chat editor tabs, persisted same-workspace session restore, and new chat beside the active file are available through **Pi Chat: Open New Chat Beside Active Editor**. If a saved session is missing or belongs to another workspace, the editor opens a fresh session.
- [x] Save a local title from the first non-command prompt without an extra provider request; configurable through `piChat.sessions.autoName`.
- [~] Create a Git worktree for a new local branch from a selected local base branch in a trusted workspace, choose an external destination, confirm before checkout hooks or configured file filters can run, and optionally open it in a new VS Code window. Optionally copy selected ignored regular files after a separate warning; copying refuses overwrites and symlinks and is capped at 2 MB per file, 10 MB total, and 500 choices. Remove another clean worktree after rechecking tracked/untracked status and active Pi runs; ignored files are listed and explicitly included in the deletion confirmation, no force option is used, and branch deletion uses `git branch -d`. Close other VS Code windows before removal. Automatic setup commands and sandboxed worktree cleanup remain unavailable.
- [~] Group running sessions and expose live activity/queue status in the session list for sessions visible to the current workspace or opt-in all-workspaces search. Short-lived local records contain hashed identifiers, not prompts, titles, or paths; running sessions cannot be renamed or deleted. Cross-device status remains unavailable.

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
- [~] List configured packages; explicitly search the public npm registry and inspect validated name/version/description results; selecting a result fills a version-pinned source, while install still requires the existing explicit modal confirmation. Install/remove in user or trusted project scope; confirm package updates; enable/disable individual extensions, skills, prompts, and themes with Pi settings filters. Curated recommendations remain unavailable. Package install/update can run package-manager code and reload executable extensions only after an explicit modal confirmation; enabling an extension requires confirmation and changes take effect only after a confirmed resource reload or a new session.
- [~] Support queued extension select/confirm/input/editor dialogs, notices, status values, plain-text widgets, bounded static widgets, interactive text-only widget cards, and header/footer components. Status values can be placed in the chat footer, VS Code status bar, both, or hidden, and optionally filtered by exact keys. Widgets can be pinned beneath the chat header, with the pin choice persisted across restarts. Header/footer output is capped and rendered as text with allowlisted ANSI styles; footer data includes Git branch, extension statuses, and the available provider count. Select/confirm/input honor Pi abort signals and positive timeout options (capped at 24 hours); the active dialog shows a countdown and cancellation removes only its matching queued or visible request. Concurrent dialog responses are matched by request ID, the queue and request payloads are bounded, pending dialogs are cleared when the Pi session changes, and unanswered requests are cancelled if the chat view closes. Interactive custom components render in a bounded text-only modal with keyboard/pointer input, per-request routing, cancellation, and hidden/focus controls. Pi custom editor components render in the composer through bounded text output, with keyboard/pointer/paste input and synchronized draft/submit handling. Extension UI mode can be set to `rpc` or `tui`; widget components receive bounded input in the chat, while native terminal overlays and process integration remain unavailable. Bounded structured tool details and generic checklist cards render in live and saved sessions.
- [x] Show and open extension load-error sources and reload Pi resources.
- [~] Browse registered Pi extension commands and request their argument suggestions; completion code runs only after a user click, and suggestions only fill the composer.
- [x] Opt-in connections from Pi's MCP configuration; list servers and manage enablement and per-server tool exposure in user settings or trusted workspace overrides; status, login, and reconnect through `/mcp`; generic MCP tool cards.
- [~] Recognize structured single/parallel/chain subagent results; show bounded run metadata, task text, assistant text/tool-call transcripts, usage, and errors. Partial results identify each child as running, finished, or failed while the parent tool streams; independent per-child stop controls remain unavailable.

## Git review, notifications, and privacy

- [~] Show branch and changed-file summaries, open bounded Git diffs, discard confirmed tracked unstaged changes by restoring from the index, and remove a confirmed regular untracked file through VS Code's OS Trash option when supported. Recheck the Git state, file identity, workspace/repository containment, and dirty editor state before removal; reject directories, symlinks, and hard links.
- [~] Prepare editable commit-message and pull-request prompts with bounded Git change context; Pi generates the draft in the active chat after the user reviews and submits it.
- [x] Show VS Code notifications for a finished run or extension input request while the chat view is hidden.
- [~] A bounded local diagnostic log records timestamps and generic runtime/operation error categories. An opt-in synthesized local tone can play when a run finishes or an extension requests input while the chat view is hidden; arbitrary user-defined command hooks remain unavailable.
- [x] Keep session/model traffic local to Pi and the selected provider; the extension adds no account, proxy, or telemetry.
- [ ] Optional OS sandbox for Pi tools.

## Explicit scope and review notes

- Voice dictation is excluded at the user's request.
- All-workspace session search is opt-in; opening a result from another folder requires confirmation and starts that session in the folder's own VS Code window.
- Remote phone access is out of scope.
- Direct shell execution from the composer is unimplemented because automatic security review rejected adding that command-execution path.
- Pi tool calls use the user's current Pi permissions; narrower tool sets are available in the extension.
