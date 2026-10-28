# Pi Chat for VS Code

A local VS Code sidebar for working with Pi. This independent implementation uses the official Pi SDK and the user's existing Pi configuration, credentials, resources, and workspace session storage by default, with an option to select another Pi configuration folder.

## Current build

- Persistent Pi sessions with search across messages, thinking, and tool activity; opt-in search across all Pi workspaces; pinning, colors, manual/recent/title ordering, optional grouping of running sessions, Command Palette session switching, cloning, branching, edit-and-continue prompts with text/context/image restoration, deletion, export, configurable local auto-naming, and optional latest-session restore
- Dedicated Pi chat editors beside the active file, each with an independent worker and session; editor tabs restore their prior session after VS Code restarts when it is still available in the same workspace. Open one with **Pi Chat: Open New Chat Beside Active Editor**
- Streamed assistant text, bounded previews for user, assistant, and tool-result images, KaTeX math and Mermaid diagrams, collapsible thinking blocks, a focused transcript toggle, live and persisted tool-call/result cards with Pi's call/result renderers shown through a bounded safe text bridge, consecutive tool runs grouped into collapsible activity sections and file exploration shown in its own group, configurable successful-card expansion with errors kept open, saved per-tool and per-group expansion preferences, line-level Pi-context edit diffs, editable follow-up/steering queues with a configurable default send action, and stop controls
- Adjustable transcript appearance: align or tint user messages, raise text/separator contrast, choose compact/normal/relaxed spacing, show turn separators, set a base font size or follow VS Code, and enable smooth navigation while respecting reduced-motion preferences
- Searchable model catalog with provider sign-in, guided custom endpoint setup for six Pi API formats and API identifiers registered by loaded Pi extensions, API keys in VS Code SecretStorage, custom `models.json` editing, Pi runtime controls for default reasoning, provider transport, and image handling, per-workspace selection of discovered `AGENTS.md` context files, an option to suppress all context-file loading, confirmed manual refresh, optional confirmed refresh at runtime startup (skipped offline), thinking levels and model presets with an optional default for new chats; model and thinking pickers are also available from the Command Palette
- Per-session tool selection restored with the session, save/reset controls for the default tool set on new chats, skill invocation, extension command suggestions, opt-in MCP servers with per-server enablement and exposure controls, confirmed Pi package install/update/remove, curated community package suggestions with dismiss/restore and version-pinned installs, and per-resource enable/disable controls; prompt template argument forms, previews, create/edit, and resource diagnostics/reload
- User-configured system prompt overrides and appended prompt text/files, extra local extension/skill/prompt-template paths, and switches for automatic resource discovery
- Workspace `@` file search, file/folder/image attachments with expandable text-context previews, selected-line and active-file context, a persistent active-file pin, diagnostics, Git status, and selected Git diff quoting; optional automatic diagnostics/Git context and numbered line ranges, plus a setting to prevent Pi from loading workspace instruction files
- Git branch and changed-file review, per-run file summaries, a confirmed “Take edits back” action for complete safe snapshots while the workspace is idle, bounded diffs, editable commit-message/PR-description prompts, confirmation-gated discard of tracked unstaged changes while preserving staged content, and confirmed removal of regular untracked files with VS Code requesting OS Trash when supported
- Create a Git worktree on a new local branch, review the destination and checkout-hook/filter warning, optionally copy explicitly selected ignored files without overwriting, and optionally open it in a separate VS Code window; remove clean worktrees with a separate confirmation
- Cumulative active-session token and cost totals from Pi's recorded usage
- A bounded local diagnostic log with timestamps and generic error categories (**Pi Chat: Open Local Diagnostic Log**), plus a redacted report with software versions and generic error categories only
- Transcript search across messages, visible thinking, and tool output; quote-to-prompt with jump-back references; persistent bookmarks; branch-safe omit/edit/restore controls and bounded inline revision history for model context; locally stored prompt history with an opt-out, session-scoped saved drafts with attachment restore and delete undo; and a context-usage meter with confirmed Pi compaction
- Copy controls for assistant code blocks, workspace definition links on inline symbols in finished replies, and on-demand model-generated follow-up prompts that fill the composer without sending automatically
- Queued Pi extension dialogs with request-matched responses, abort signals, optional deadlines with countdowns, bounded static widgets and interactive text-only widget cards with keyboard/pointer input, selectable Pi extension UI mode, header/footer components, text-only interactive extension components with keyboard/pointer input and cancellation, custom editor components rendered through a bounded text bridge with routed input and composer synchronization, safe structured tool details, checklist results, supported subagent transcripts and usage, hidden-window VS Code notifications, and optional machine-scoped script hooks for selected events after explicit confirmation

See [the feature coverage checklist](docs/feature-coverage.md) for implemented and planned capabilities. Voice dictation is out of scope. Direct shell execution from the composer is unavailable because the automatic security review rejected that execution path.

## Local verification

Run `npm run smoke:worker` to open a real Pi SDK worker with a temporary configuration and a loopback-only mock model. The check covers prompt overrides, appended prompt files, extra local resource paths, discovery switches, model selection, streamed output, and the persisted session transcript, then removes its temporary data. It uses Pi offline mode and a temporary config; it does not read the user's Pi credentials or call an external provider.

Run `npm run smoke:sessions` to verify pinned priority, saved manual order, recent/title sorting, and the recent-order fallback without modifying Pi session files. Run `npm run smoke:drafts` to exercise saved-draft session isolation, text/image context, swap restore, delete undo, retention limits, persisted-data validation, and storage bounds.

Run `npm run smoke:notification-hooks` for event filtering, environment isolation and bounded command execution. Run `npm run smoke:package-recommendations` for npm manifest validation.

Set `piChat.sessions.openLatestOnStart` in VS Code Settings to reopen the latest session for the active workspace when the chat view starts. It defaults to `false`.

The extension instantiates the bundled Pi SDK directly in a worker thread; it does not launch the Pi CLI and speak the CLI's RPC protocol. The `piChat.extensionUiMode` setting controls the UI mode exposed to loaded Pi extensions. The webview uses a restrictive Content Security Policy and renders Pi output as text or a safe Markdown subset; external links are limited to HTTPS and loopback HTTP. It does not add telemetry or route requests through a hosted service. Saved draft contents stay in local VS Code extension storage and are only sent to Pi when you submit them. Live session indicators are shared between local VS Code windows using short-lived records with hashed session identifiers and generic activity labels; prompts, titles, and file paths are not stored in those records.

Use **Pi Chat: Choose Pi Configuration Folder** to select another machine-local Pi configuration directory. The picker restarts Pi after confirmation when there is no running or queued work. If you change `piChat.agentDir` or `piChat.offlineMode` directly in VS Code Settings, use **Pi Chat: Restart Pi Runtime** to apply the change; the command refuses while Pi work is active. Offline mode disables automatic startup network operations, but it does not block model API requests.

Use **Pi Chat: Manage Pi Runtime Environment Variables** to add or remove custom runtime values. Values are stored in VS Code SecretStorage and are not shown in diagnostics. After a manual runtime restart, Pi, its tools, and loaded extensions can read them, so only add values you intend to expose to those local processes.

Optional notification hooks are configured in Runtime settings or through `piChat.notifications.hookCommand` and `piChat.notifications.hookEvents`. The command is machine-scoped, ignored in workspace settings, and requires confirmation before it can run. It runs as your OS account with a 10-second limit; the process receives event data through JSON on stdin and `PI_CHAT_*` variables. Only basic OS variables and explicitly named `PI_CHAT_HOOK_*` variables are forwarded, not Pi provider credentials.

Use `piChat.prompts.systemPromptText` or `piChat.prompts.systemPromptFile` to replace Pi's system prompt; text takes precedence over the file. `piChat.prompts.appendSystemPromptText` and `piChat.prompts.appendSystemPromptFiles` add instructions after Pi's configured prompt files. Files must be UTF-8 and are limited to 1 MiB each. `piChat.resources.additionalExtensionPaths`, `additionalSkillPaths`, `additionalPromptTemplatePaths`, and `additionalThemePaths` add local resources, while the `disable*Discovery` settings turn off automatic discovery for each resource type. These settings apply after **Pi Chat: Restart Pi Runtime**. Workspace-level prompt and resource settings are ignored until the workspace is trusted. Only add extension paths you trust, because Pi loads extension code into its runtime. `piChat.appearance.spacing` controls transcript spacing; `piChat.appearance.showSeparators` adds dividers before the next message after a finished assistant turn.

Pi's configured tools and extensions retain the same local permissions they have when Pi runs directly. Explicit `!` and `!!` shell commands also run with your OS account's permissions. This extension does not add an OS sandbox; use the **Read-only** or **None** tool presets when you want to limit agent actions.

MCP connections are disabled by default. Enabling a server requires confirmation because configured servers can run local commands or contact remote services. The MCP manager can change enablement and tool exposure in user settings or, after Pi trust, a workspace-only override. Project-local Pi resources remain behind Pi's workspace trust decision.

The extension bundles the Pi SDK version listed in `package.json`. Running `pi update` updates a separately installed Pi CLI, but does not change the runtime bundled in this extension; install a newer extension build to update that SDK. Guided custom endpoint setup adds a provider to the selected Pi configuration's `models.json`; optional API keys are stored in VS Code SecretStorage and referenced through a runtime environment variable.

## Develop

```powershell
npm install
npm run compile
npm run typecheck
```

## Install the VSIX

After packaging, install `pi-chat-vscode-0.1.118.vsix` from VS Code's Extensions view using **… → Install from VSIX…**, or run:

```powershell
code --install-extension .\pi-chat-vscode-0.1.118.vsix --force
```

Reload VS Code after installation. The package is built locally from this source; the extension needs a Pi provider/model already configured in your Pi setup.

Open this folder in VS Code and press **F5** to launch an Extension Development Host. Open a workspace folder there, then choose **Pi Chat** from the Activity Bar. The Pi SDK reads the same configuration used by Pi, so a configured provider and model are needed before sending a prompt.

To package a VSIX after installing dependencies:

```powershell
npm run package
```
