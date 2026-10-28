# Pi Chat for VS Code

A local VS Code sidebar for working with Pi. This independent implementation uses the official Pi SDK and the user's existing Pi configuration, credentials, resources, and workspace session storage.

## Current build

- Persistent Pi sessions with search, pinning, colors, ordering, branching, deletion, and export
- Streamed assistant text, live tool cards, editable follow-up/steering queues, and stop controls
- Searchable model catalog with manual and `models.json` refresh, thinking levels, and presets
- Per-session tool selection and skill/prompt invocation
- Workspace `@` file search, file/folder/image attachments, selected-line and active-file context, diagnostics, and Git status
- Transcript search, quote-to-prompt, persistent bookmarks, prompt history/drafts, and a context-usage meter with confirmed Pi compaction
- Basic Pi extension dialogs/widgets and hidden-view VS Code notifications

See [the feature-parity checklist](docs/feature-parity.md) for partial and missing Pendant features. Voice dictation is excluded. Direct shell execution from the composer is unavailable because the automatic security review rejected that execution path.

The extension runs Pi in a worker thread. The webview uses a restrictive Content Security Policy and renders Pi output as text or a limited Markdown subset. It does not add telemetry or route requests through a hosted service.

Pi's configured tools and extensions retain the same local permissions they have when Pi runs directly. This extension does not add an OS sandbox; use the **Read-only** or **None** tool presets when you want to limit agent actions.

## Develop

```powershell
npm install
npm run compile
npm run typecheck
```

## Install the VSIX

After packaging, install `pi-chat-vscode-0.1.1.vsix` from VS Code's Extensions view using **… → Install from VSIX…**, or run:

```powershell
code --install-extension .\pi-chat-vscode-0.1.1.vsix --force
```

Reload VS Code after installation. The package is built locally from this source; the extension needs a Pi provider/model already configured in your Pi setup.

Open this folder in VS Code and press **F5** to launch an Extension Development Host. Open a workspace folder there, then choose **Pi Chat** from the Activity Bar. The Pi SDK reads the same configuration used by Pi, so a configured provider and model are needed before sending a prompt.

To package a VSIX after installing dependencies:

```powershell
npm run package
```

Pendant was used only as a behavioral and interface reference; its bundled code and branding are not included.
