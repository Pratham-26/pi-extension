# Pi Chat for VS Code

A local VS Code sidebar for working with Pi. This independent implementation uses the official Pi SDK and the user's existing Pi configuration, credentials, resources, and workspace session storage by default, with an option to select another Pi configuration folder.

## Current build

- Persistent Pi sessions with search across messages, thinking, and tool activity; opt-in search across all Pi workspaces; pinning, colors, ordering, cloning, branching, edit-and-continue prompts with text/context/image restoration, deletion, export, configurable local auto-naming, and optional latest-session restore
- Streamed assistant text, bounded previews for user, assistant, and tool-result images, KaTeX math and Mermaid diagrams, collapsible thinking blocks, a focused transcript toggle, live and persisted tool-call/result cards with saved per-tool expansion preferences, line-level Pi-context edit diffs, editable follow-up/steering queues, and stop controls
- Searchable model catalog with provider sign-in, custom `models.json` editing, Pi runtime controls, securely stored custom environment variables, per-workspace selection of discovered `AGENTS.md` context files, confirmed catalog refresh, thinking levels, and presets
- Per-session tool selection, skill invocation, extension command suggestions, opt-in MCP servers with per-server enablement and exposure controls, confirmed Pi package install/update/remove, and per-resource enable/disable controls; prompt template argument forms, previews, create/edit, and resource diagnostics/reload
- Workspace `@` file search, file/folder/image attachments with expandable text-context previews, selected-line and active-file context, a persistent active-file pin, diagnostics, Git status, and selected Git diff quoting; optional automatic diagnostics/Git context and numbered line ranges
- Git branch and changed-file review, bounded diffs, editable commit-message/PR-description prompts, and confirmation-gated discard of tracked unstaged changes while preserving staged content
- Create a Git worktree on a new local branch, review the destination and checkout-hook/filter warning, optionally copy explicitly selected ignored files without overwriting, and optionally open it in a separate VS Code window; remove clean worktrees with a separate confirmation
- Cumulative active-session token and cost totals from Pi's recorded usage
- A bounded local diagnostic log with timestamps and generic error categories (**Pi Chat: Open Local Diagnostic Log**), plus a redacted report with software versions and generic error categories only
- Transcript search across messages, visible thinking, and tool output; quote-to-prompt with jump-back references; persistent bookmarks; branch-safe omit/edit/restore controls for model context; prompt history/drafts; and a context-usage meter with confirmed Pi compaction
- Copy controls for assistant code blocks, workspace definition links on inline symbols in finished replies, and on-demand model-generated follow-up prompts that fill the composer without sending automatically
- Queued Pi extension dialogs with request-matched responses, abort signals, optional deadlines with countdowns, plain-text widgets, safe structured tool details, checklist results, supported subagent transcripts and usage, and hidden-view VS Code notifications

See [the feature coverage checklist](docs/feature-coverage.md) for implemented and planned capabilities. Voice dictation is out of scope. Direct shell execution from the composer is unavailable because the automatic security review rejected that execution path.

Set `piChat.sessions.openLatestOnStart` in VS Code Settings to reopen the latest session for the active workspace when the chat view starts. It defaults to `false`.

The extension runs Pi in a worker thread. The webview uses a restrictive Content Security Policy and renders Pi output as text or a safe Markdown subset; external links are limited to HTTPS and loopback HTTP. It does not add telemetry or route requests through a hosted service. Live session indicators are shared between local VS Code windows using short-lived records with hashed session identifiers and generic activity labels; prompts, titles, and file paths are not stored in those records.

Use **Pi Chat: Choose Pi Configuration Folder** to select another machine-local Pi configuration directory. The picker restarts Pi after confirmation when there is no running or queued work. If you change `piChat.agentDir` or `piChat.offlineMode` directly in VS Code Settings, use **Pi Chat: Restart Pi Runtime** to apply the change; the command refuses while Pi work is active. Offline mode disables automatic startup network operations, but it does not block model API requests.

Use **Pi Chat: Manage Pi Runtime Environment Variables** to add or remove custom runtime values. Values are stored in VS Code SecretStorage and are not shown in diagnostics. After a manual runtime restart, Pi, its tools, and loaded extensions can read them, so only add values you intend to expose to those local processes.

Pi's configured tools and extensions retain the same local permissions they have when Pi runs directly. This extension does not add an OS sandbox; use the **Read-only** or **None** tool presets when you want to limit agent actions.

MCP connections are disabled by default. Enabling a server requires confirmation because configured servers can run local commands or contact remote services. The MCP manager can change enablement and tool exposure in user settings or, after Pi trust, a workspace-only override. Project-local Pi resources remain behind Pi's workspace trust decision.

The extension bundles the Pi SDK version listed in `package.json`. Updating a separately installed Pi CLI with `pi update` does not change the runtime bundled in this extension; install a newer extension build to update that SDK.

## Develop

```powershell
npm install
npm run compile
npm run typecheck
```

## Install the VSIX

After packaging, install `pi-chat-vscode-0.1.51.vsix` from VS Code's Extensions view using **… → Install from VSIX…**, or run:

```powershell
code --install-extension .\pi-chat-vscode-0.1.51.vsix --force
```

Reload VS Code after installation. The package is built locally from this source; the extension needs a Pi provider/model already configured in your Pi setup.

Open this folder in VS Code and press **F5** to launch an Extension Development Host. Open a workspace folder there, then choose **Pi Chat** from the Activity Bar. The Pi SDK reads the same configuration used by Pi, so a configured provider and model are needed before sending a prompt.

To package a VSIX after installing dependencies:

```powershell
npm run package
```
