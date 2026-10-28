# Pi Chat for VS Code

A local VS Code sidebar for working with Pi. This independent implementation uses the official Pi SDK and the user's existing Pi configuration, credentials, resources, and workspace session storage.

## Current build

- Persistent Pi sessions with search, pinning, colors, ordering, cloning, branching, edit-and-continue prompts, deletion, export, and configurable local auto-naming
- Streamed assistant text, live tool cards, editable follow-up/steering queues, and stop controls
- Searchable model catalog with provider sign-in, custom `models.json` editing, Pi runtime controls, confirmed catalog refresh, thinking levels, and presets
- Per-session tool selection, skill invocation, extension command suggestions, opt-in MCP servers, and confirmed Pi package install/update/remove with user/project scope; prompt template argument forms, previews, create/edit, and resource diagnostics/reload
- Workspace `@` file search, file/folder/image attachments, selected-line and active-file context, a persistent active-file pin, diagnostics, Git status, and selected Git diff quoting; optional automatic diagnostics/Git context and numbered line ranges
- Git branch and changed-file review, bounded diffs, and confirmation-gated discard of tracked unstaged changes while preserving staged content
- Cumulative active-session token and cost totals from Pi's recorded usage
- A redacted diagnostic report with versions and generic error categories only
- Transcript search, quote-to-prompt, persistent bookmarks, branch-safe omit/edit/restore controls for model context, prompt history/drafts, and a context-usage meter with confirmed Pi compaction
- Copy controls for assistant code blocks
- Basic Pi extension dialogs/widgets and hidden-view VS Code notifications

See [the feature coverage checklist](docs/feature-coverage.md) for implemented and planned capabilities. Voice dictation is out of scope. Direct shell execution from the composer is unavailable because the automatic security review rejected that execution path.

The extension runs Pi in a worker thread. The webview uses a restrictive Content Security Policy and renders Pi output as text or a limited Markdown subset. It does not add telemetry or route requests through a hosted service.

Pi's configured tools and extensions retain the same local permissions they have when Pi runs directly. This extension does not add an OS sandbox; use the **Read-only** or **None** tool presets when you want to limit agent actions.

MCP connections are disabled by default. Enabling them requires confirmation because configured servers can run local commands or contact remote services. Project-local Pi resources remain behind Pi's workspace trust decision.

## Develop

```powershell
npm install
npm run compile
npm run typecheck
```

## Install the VSIX

After packaging, install `pi-chat-vscode-0.1.18.vsix` from VS Code's Extensions view using **… → Install from VSIX…**, or run:

```powershell
code --install-extension .\pi-chat-vscode-0.1.18.vsix --force
```

Reload VS Code after installation. The package is built locally from this source; the extension needs a Pi provider/model already configured in your Pi setup.

Open this folder in VS Code and press **F5** to launch an Extension Development Host. Open a workspace folder there, then choose **Pi Chat** from the Activity Bar. The Pi SDK reads the same configuration used by Pi, so a configured provider and model are needed before sending a prompt.

To package a VSIX after installing dependencies:

```powershell
npm run package
```
