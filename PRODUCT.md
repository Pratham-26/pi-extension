# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

TypeScript VS Code extension with a plain HTML, CSS, and JavaScript webview; official Pi SDK; package as a VS Code extension.

## Users

Developers who use Pi for coding and want to work with it alongside their project in VS Code.

## Product Purpose

Bring Pi coding sessions into a VS Code sidebar so developers can send tasks, follow streamed replies, return to saved sessions, organize sessions, and provide user-controlled workspace context without leaving VS Code.

## Positioning

The extension is a local interface to Pi through its official SDK. Pi remains the agent and continues to use the user's existing Pi configuration.

## Operating Context

The extension runs inside VS Code against the currently open workspace.

## Capabilities and Constraints

- The current build includes model search and refresh, session/model controls, workspace references, transcript search, prompt history/drafts, editable message queues, queued `!`/`!!` shell commands, notifications, and session exports.
- Feature coverage is tracked in `docs/feature-coverage.md`.
- Voice dictation is out of scope.
- Use the official Pi SDK and the user's existing Pi configuration and credentials.
- Do not add a hosted account, proxy, telemetry, or a shell execution path that bypasses Pi's configured `user_bash` handlers.
- Route explicit `!` and `!!` composer commands through Pi's configured `user_bash` handler and queue them for the session where they were submitted.
- Session context and Pi resources resolve from the active workspace and the user's existing Pi setup.

## Evidence on Hand

The extension is independently implemented and contains no third-party product code or branding beyond its declared dependencies.

## Product Principles

- Keep Pi's existing configuration authoritative.
- Make the agent's progress visible as it happens.
- Make workspace context understandable and user controlled.
- Treat webview and session-file inputs as untrusted until validated.
