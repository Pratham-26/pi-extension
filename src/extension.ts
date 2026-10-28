import * as vscode from 'vscode';
import * as path from 'node:path';
import { access, lstat, open as openFile, realpath } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { isPiPackageSource } from './package-source';

type Attachment = {
  id: string;
  label: string;
  path: string;
  context: string;
  image?: { data: string; mimeType: string };
};

type RuntimeMessage = {
  type: string;
  [key: string]: unknown;
};

type ModelPreset = {
  id: string;
  name: string;
  provider: string;
  modelId: string;
  thinkingLevel?: string;
};

type ProviderSetup = {
  id: string;
  name: string;
  supportsApiKey: boolean;
  apiKeyName: string;
  supportsOAuth: boolean;
  oauthLabel: string;
  configured: boolean;
  authLabel: string;
};

type GitChangeRecord = {
  uri?: vscode.Uri;
  resourceUri?: vscode.Uri;
  status?: unknown;
};

type GitRepositoryLike = {
  rootUri: vscode.Uri;
  state: {
    HEAD?: { name?: string; upstream?: { remote?: string; name?: string }; ahead?: number; behind?: number };
    indexChanges?: GitChangeRecord[];
    workingTreeChanges?: GitChangeRecord[];
    untrackedChanges?: GitChangeRecord[];
    mergeChanges?: GitChangeRecord[];
  };
  status?: () => Promise<void>;
  diffWithHEAD?: (path?: string) => Promise<string | GitChangeRecord[]>;
  diffWithHEADShortStats?: () => Promise<{ files: number; insertions: number; deletions: number }>;
  restore?: (paths: string[], options?: { staged?: boolean; ref?: string }) => Promise<void>;
};

type GitApiLike = {
  repositories: GitRepositoryLike[];
};

type GitFileStatus = {
  path: string;
  status: string[];
  canDiscard: boolean;
  isUntracked: boolean;
};

const VIEW_ID = 'piChat.chatView';
const MAX_ATTACHMENT_BYTES = 1024 * 1024;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_ATTACHMENT_CHARS = 40_000;
const MAX_GIT_REVIEW_FILES = 500;
const MAX_GIT_DIFF_CHARS = 500_000;
const MAX_GIT_DRAFT_CHARS = 30_000;
const MAX_GIT_DRAFT_FILES = 24;
const MAX_UNTRACKED_DRAFT_BYTES = 16_000;

export function activate(context: vscode.ExtensionContext): void {
  const provider = new PiChatViewProvider(context);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(VIEW_ID, provider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.commands.registerCommand('piChat.newSession', () => provider.newSession()),
    vscode.commands.registerCommand('piChat.cloneSession', () => provider.cloneSession()),
    vscode.commands.registerCommand('piChat.openSettings', () => vscode.commands.executeCommand('workbench.action.openSettings', '@ext:local.pi-chat-vscode')),
    vscode.commands.registerCommand('piChat.exportDiagnostics', () => provider.exportDiagnostics()),
    vscode.workspace.onDidChangeWorkspaceFolders(() => provider.restartRuntime()),
    provider,
  );
}

export function deactivate(): void {
  // The webview provider owns the Pi worker for the lifetime of the extension host.
}

class PiChatViewProvider implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private worker?: Worker;
  private workerWorkspace?: string;
  private webviewMessageSubscription?: vscode.Disposable;
  private sessionQuery = '';
  private activeSessionPath = '';
  private openLatestSessionOnStart: boolean;
  private latestSessionOpenAttempted = false;
  private sessionInteractionStarted = false;
  private knownSessionPaths = new Set<string>();
  private knownPromptPaths = new Set<string>();
  private knownResourcePaths = new Set<string>();
  private availableProviders: ProviderSetup[] = [];
  private modelsConfigPath = '';
  private settingsConfigPath = '';
  private mcpConfigPath = '';
  private pendingMcpSetting?: { worker: Worker; requestId: string; enabled: boolean; previous: boolean };
  private providerAuthPromptCancels = new Map<string, { worker: Worker; cancel: () => void }>();
  private activeEditorSubscription: vscode.Disposable;
  private selectionSubscription: vscode.Disposable;
  private pinnedActiveFileEnabled: boolean;
  private diagnosticEvents: Array<{ at: string; category: string }> = [];

  constructor(private readonly context: vscode.ExtensionContext) {
    this.pinnedActiveFileEnabled = context.workspaceState.get<boolean>('piChat.context.pinnedActiveFile', false);
    this.openLatestSessionOnStart = vscode.workspace.getConfiguration('piChat.sessions').get<boolean>('openLatestOnStart', false);
    this.activeEditorSubscription = vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (this.pinnedActiveFileEnabled && editor) this.publishPinnedActiveFile(editor);
    });
    this.selectionSubscription = vscode.window.onDidChangeTextEditorSelection((event) => {
      if (this.pinnedActiveFileEnabled && event.textEditor === vscode.window.activeTextEditor) this.publishPinnedActiveFile(event.textEditor);
    });
  }

  dispose(): void {
    this.cancelProviderAuthPrompts();
    this.activeEditorSubscription.dispose();
    this.selectionSubscription.dispose();
    this.webviewMessageSubscription?.dispose();
    this.webviewMessageSubscription = undefined;
    const worker = this.worker;
    this.worker = undefined;
    this.knownPromptPaths.clear();
    this.knownResourcePaths.clear();
    this.availableProviders = [];
    this.modelsConfigPath = '';
    this.settingsConfigPath = '';
    this.mcpConfigPath = '';
    this.failPendingMcpSetting(worker);
    if (worker) this.stopWorker(worker);
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')],
    };
    view.webview.html = this.getHtml(view.webview);
    this.webviewMessageSubscription?.dispose();
    this.webviewMessageSubscription = view.webview.onDidReceiveMessage((message: RuntimeMessage) => {
      void this.handleWebviewMessage(message);
    });
    view.onDidDispose(() => {
      this.webviewMessageSubscription?.dispose();
      this.webviewMessageSubscription = undefined;
      if (this.view === view) this.view = undefined;
    });

    void this.ensureRuntime();
  }

  async newSession(): Promise<void> {
    this.sessionInteractionStarted = true;
    if (!this.worker) await this.ensureRuntime();
    this.worker?.postMessage({
      type: 'newSession',
      autoNameSessions: vscode.workspace.getConfiguration('piChat.sessions').get<boolean>('autoName', true),
    });
  }

  async cloneSession(): Promise<void> {
    this.sessionInteractionStarted = true;
    if (!this.worker) await this.ensureRuntime();
    this.worker?.postMessage({ type: 'cloneSession' });
  }

  async exportDiagnostics(): Promise<void> {
    const packageJson = this.context.extension.packageJSON as {
      version?: unknown;
      dependencies?: Record<string, unknown>;
    };
    const destination = await vscode.window.showSaveDialog({
      filters: { 'JSON report': ['json'] },
      saveLabel: 'Export redacted report',
    });
    if (!destination) return;
    const report = {
      format: 'pi-chat-vscode-diagnostic-report',
      generatedAt: new Date().toISOString(),
      versions: {
        vscode: vscode.version,
        extension: String(packageJson.version ?? 'unknown').slice(0, 32),
        piSdk: String(packageJson.dependencies?.['@earendil-works/pi-coding-agent'] ?? 'unknown').slice(0, 32),
        node: process.versions.node,
      },
      environment: {
        platform: process.platform,
        architecture: process.arch,
        workspaceOpen: Boolean(vscode.workspace.workspaceFolders?.length),
        piWorkerRunning: Boolean(this.worker),
      },
      recentErrors: this.diagnosticEvents.slice(-20),
      privacy: 'This report omits prompt text, transcript content, workspace and session paths, file names, provider IDs, credentials, and environment variables.',
    };
    try {
      await vscode.workspace.fs.writeFile(destination, Buffer.from(JSON.stringify(report, null, 2), 'utf8'));
      void vscode.window.showInformationMessage('Redacted Pi Chat diagnostic report saved.');
    } catch (error) {
      void vscode.window.showErrorMessage(`Could not save the diagnostic report. ${error instanceof Error ? error.message.slice(0, 240) : ''}`);
    }
  }

  restartRuntime(): void {
    const previous = this.worker;
    if (previous) this.cancelProviderAuthPrompts(previous);
    this.worker = undefined;
    this.workerWorkspace = undefined;
    this.knownSessionPaths.clear();
    this.knownPromptPaths.clear();
    this.knownResourcePaths.clear();
    this.availableProviders = [];
    this.modelsConfigPath = '';
    this.settingsConfigPath = '';
    this.mcpConfigPath = '';
    this.activeSessionPath = '';
    this.latestSessionOpenAttempted = false;
    this.sessionInteractionStarted = false;
    this.failPendingMcpSetting(previous);
    if (previous) this.stopWorker(previous);
    void this.ensureRuntime();
    this.publishPinnedActiveFile();
  }

  private async ensureRuntime(): Promise<void> {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
      this.post({ type: 'workspace', hasWorkspace: false });
      this.publishPinnedActiveFile();
      return;
    }

    const cwd = folder.uri.fsPath;
    if (this.worker && this.workerWorkspace === cwd) {
      this.post({ type: 'workspace', hasWorkspace: true, name: folder.name });
      this.worker.postMessage({ type: 'listSessions' });
      return;
    }

    const previous = this.worker;
    if (previous) this.cancelProviderAuthPrompts(previous);
    this.worker = undefined;
    this.failPendingMcpSetting(previous);
    if (previous) this.stopWorker(previous);
    this.knownSessionPaths.clear();
    this.knownPromptPaths.clear();
    this.knownResourcePaths.clear();
    this.availableProviders = [];
    this.modelsConfigPath = '';
    this.settingsConfigPath = '';
    this.mcpConfigPath = '';
    this.pendingMcpSetting = undefined;
    this.activeSessionPath = '';

    this.workerWorkspace = cwd;
    const workerUri = vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'pi-worker.mjs');
    const worker = new Worker(workerUri.fsPath, {
      workerData: {
        cwd,
        autoNameSessions: vscode.workspace.getConfiguration('piChat.sessions').get<boolean>('autoName', true),
        mcpEnabled: vscode.workspace.getConfiguration('piChat').get<boolean>('mcp.enabled', false),
      },
    });
    this.worker = worker;
    worker.on('message', (message: RuntimeMessage) => {
      if (this.worker !== worker) return;
      if (message.type === 'runtime-error') this.recordDiagnostic('Pi runtime error');
      else if (message.type === 'notice' && message.isError === true) this.recordDiagnostic('Pi operation error');
      if (message.type === 'run-finished') void this.refreshGitChanges();
      if (message.type === 'snapshot' && typeof message.sessionFile === 'string') {
        this.activeSessionPath = message.sessionFile;
        this.post(message);
      } else if (message.type === 'run-finished' && !message.providerLogin && !this.view?.visible && vscode.workspace.getConfiguration('piChat.notifications').get<boolean>('runFinished', true)) {
        void this.showChatNotification('Pi finished its run.');
        this.post(message);
      } else if (message.type === 'extension-ui-request' && !this.view?.visible && vscode.workspace.getConfiguration('piChat.notifications').get<boolean>('inputRequired', true)) {
        void this.showChatNotification('A Pi extension is waiting for your answer.');
        this.post(message);
      } else if (message.type === 'provider-auth-prompt') {
        void this.handleProviderAuthPrompt(message, worker);
      } else if (message.type === 'provider-auth-prompt-cancel') {
        if (typeof message.requestId === 'string') {
          const pending = this.providerAuthPromptCancels.get(message.requestId);
          if (pending?.worker === worker) pending.cancel();
        }
      } else if (message.type === 'provider-auth-event') {
        void this.handleProviderAuthEvent(message, worker);
      } else if (message.type === 'project-trust-request') {
        void this.handleProjectTrustRequest(message, worker);
      } else if (message.type === 'mcp-open-url') {
        void this.handleMcpOpenUrl(message, worker);
      } else if (message.type === 'mcp-setting-applied' || message.type === 'mcp-setting-failed') {
        void this.handleMcpSettingResult(message, worker);
      } else if (message.type === 'session-exported') {
        void this.handleSessionExport(message);
      } else if (message.type === 'sessions' && Array.isArray(message.sessions)) {
        const allSessionPaths = Array.isArray(message.sessionPaths)
          ? message.sessionPaths
          : (message.sessions as Array<Record<string, unknown>>).map((item) => item.path);
        this.knownSessionPaths = new Set(allSessionPaths
          .filter((value): value is string => typeof value === 'string')
          .map((value) => this.normalizeSessionPath(value)));
        const pins = this.context.globalState.get<Record<string, boolean>>('piChat.pinnedSessions', {});
        const colors = this.context.globalState.get<Record<string, string>>('piChat.sessionColors', {});
        const order = this.context.globalState.get<string[]>('piChat.sessionOrder', []);
        const orderIndex = new Map(order.map((path, index) => [path, index]));
        const sessions: Array<Record<string, unknown>> = (message.sessions as Array<Record<string, unknown>>)
          .map((item): Record<string, unknown> => ({
            ...item,
            pinned: Boolean(pins[String(item.path ?? '')]),
            color: colors[String(item.path ?? '')] ?? 'default',
          }))
          .sort((a, b) => Number(b['pinned']) - Number(a['pinned'])
            || (orderIndex.get(String(a['path'] ?? '')) ?? Number.MAX_SAFE_INTEGER) - (orderIndex.get(String(b['path'] ?? '')) ?? Number.MAX_SAFE_INTEGER)
            || Number(b['modified'] ?? 0) - Number(a['modified'] ?? 0));
        this.post({ ...message, sessions });
        if (this.openLatestSessionOnStart && !this.latestSessionOpenAttempted) {
          this.latestSessionOpenAttempted = true;
          if (!this.sessionInteractionStarted && !this.activeSessionPath) {
            const latest = sessions
              .filter((item) => this.isKnownSessionPath(item['path']))
              .reduce<Record<string, unknown> | undefined>((current, item) =>
                !current || Number(item['modified'] ?? 0) > Number(current['modified'] ?? 0) ? item : current, undefined);
            if (latest && typeof latest['path'] === 'string') {
              this.worker?.postMessage({ type: 'openSession', path: latest['path'] });
            }
          }
        }
      } else if (message.type === 'options') {
        this.availableProviders = Array.isArray(message.providers)
          ? (message.providers as Array<Record<string, unknown>>).slice(0, 200).flatMap((provider) => {
            if (typeof provider.id !== 'string' || provider.id.length > 128 || typeof provider.name !== 'string') return [];
            return [{
              id: provider.id,
              name: provider.name.slice(0, 128),
              supportsApiKey: provider.supportsApiKey === true,
              apiKeyName: typeof provider.apiKeyName === 'string' ? provider.apiKeyName.slice(0, 128) : 'API key',
              supportsOAuth: provider.supportsOAuth === true,
              oauthLabel: typeof provider.oauthLabel === 'string' ? provider.oauthLabel.slice(0, 128) : 'Sign in',
              configured: provider.configured === true,
              authLabel: typeof provider.authLabel === 'string' ? provider.authLabel.slice(0, 128) : '',
            }];
          })
          : [];
        this.modelsConfigPath = typeof message.modelsConfigPath === 'string'
          && message.modelsConfigPath.length <= 4096
          && path.isAbsolute(message.modelsConfigPath)
          ? path.resolve(message.modelsConfigPath)
          : '';
        this.settingsConfigPath = typeof message.settingsConfigPath === 'string'
          && message.settingsConfigPath.length <= 4096
          && path.isAbsolute(message.settingsConfigPath)
          ? path.resolve(message.settingsConfigPath)
          : '';
        this.mcpConfigPath = typeof message.mcpConfigPath === 'string'
          && message.mcpConfigPath.length <= 4096
          && path.isAbsolute(message.mcpConfigPath)
          ? path.resolve(message.mcpConfigPath)
          : '';
        const promptPaths = Array.isArray(message.prompts)
          ? (message.prompts as Array<Record<string, unknown>>).map((prompt) => prompt.filePath)
          : [];
        this.knownPromptPaths = new Set(promptPaths
          .filter((value): value is string => typeof value === 'string' && value.length > 0 && value.length <= 4096)
          .map((value) => this.normalizeSessionPath(value)));
        const diagnosticPaths = Array.isArray(message.resourceDiagnostics)
          ? (message.resourceDiagnostics as Array<Record<string, unknown>>).map((diagnostic) => diagnostic.path)
          : [];
        this.knownResourcePaths = new Set([...promptPaths, ...diagnosticPaths]
          .filter((value): value is string => typeof value === 'string' && value.length > 0 && value.length <= 4096)
          .map((value) => this.normalizeSessionPath(value)));
        const { modelsConfigPath: _modelsConfigPath, settingsConfigPath: _settingsConfigPath, mcpConfigPath: _mcpConfigPath, ...safeMessage } = message;
        this.post({ ...safeMessage, presets: this.context.workspaceState.get<ModelPreset[]>('piChat.modelPresets', []) });
      } else {
        this.post(message);
      }
    });
    worker.on('error', (error: Error) => {
      if (this.worker === worker) {
        this.recordDiagnostic('Pi worker error');
        this.post({ type: 'runtime-error', message: error.message || 'The Pi runtime stopped unexpectedly.' });
      }
    });
    worker.on('exit', (code: number) => {
      if (this.worker === worker) {
        this.worker = undefined;
        this.cancelProviderAuthPrompts(worker);
      }
      this.failPendingMcpSetting(worker);
      if (this.workerWorkspace === cwd && code !== 0) {
        this.recordDiagnostic('Pi worker exited unexpectedly');
        this.post({ type: 'runtime-error', message: `The Pi runtime exited with code ${code}.` });
      }
    });

    this.post({ type: 'workspace', hasWorkspace: true, name: folder.name });
    this.publishPinnedActiveFile();
  }

  private async handleWebviewMessage(message: RuntimeMessage): Promise<void> {
    switch (message.type) {
      case 'togglePinActiveFile':
        this.togglePinnedActiveFile();
        return;
      case 'unpinActiveFile':
        this.setPinnedActiveFile(false);
        return;
      case 'ready':
        await this.ensureRuntime();
        this.worker?.postMessage({ type: 'listSessions' });
        this.worker?.postMessage({ type: 'listPackages' });
        await this.refreshGitChanges();
        this.publishPinnedActiveFile();
        return;
      case 'refreshGitChanges':
        await this.refreshGitChanges();
        return;
      case 'openGitDiff':
        await this.openGitDiff(message.path);
        return;
      case 'quoteGitDiffSelection':
        this.quoteGitDiffSelection();
        return;
      case 'draftGitChanges':
        await this.draftGitChanges(message.kind);
        return;
      case 'discardGitChange':
        await this.discardGitChange(message.path);
        return;
      case 'exportDiagnostics':
        await this.exportDiagnostics();
        return;
      case 'newSession':
        this.sessionInteractionStarted = true;
        await this.newSession();
        return;
      case 'cloneSession':
        this.sessionInteractionStarted = true;
        if (this.worker) this.worker.postMessage({ type: 'cloneSession' });
        return;
      case 'openSettings':
        await vscode.commands.executeCommand('piChat.openSettings');
        return;
      case 'listSessions':
        this.sessionQuery = typeof message.query === 'string' ? message.query.slice(0, 250) : this.sessionQuery;
        this.worker?.postMessage({ type: 'listSessions', query: this.sessionQuery });
        return;
      case 'toggleSessionPin': {
        if (!this.isKnownSessionPath(message.path)) return;
        const pins = this.context.globalState.get<Record<string, boolean>>('piChat.pinnedSessions', {});
        const next = { ...pins };
        if (next[message.path]) delete next[message.path];
        else next[message.path] = true;
        await this.context.globalState.update('piChat.pinnedSessions', next);
        this.worker?.postMessage({ type: 'listSessions', query: this.sessionQuery });
        return;
      }
      case 'colorSession': {
        if (!this.isKnownSessionPath(message.path)) return;
        const colors = this.context.globalState.get<Record<string, string>>('piChat.sessionColors', {});
        const options = [
          { label: 'Default', value: 'default' },
          { label: 'Red', value: 'red' },
          { label: 'Orange', value: 'orange' },
          { label: 'Yellow', value: 'yellow' },
          { label: 'Green', value: 'green' },
          { label: 'Blue', value: 'blue' },
          { label: 'Purple', value: 'purple' },
        ];
        const selected = await vscode.window.showQuickPick(options, { placeHolder: 'Choose a session color' });
        if (!selected) return;
        const next = { ...colors };
        if (selected.value === 'default') delete next[message.path];
        else next[message.path] = selected.value;
        await this.context.globalState.update('piChat.sessionColors', next);
        this.worker?.postMessage({ type: 'listSessions', query: this.sessionQuery });
        return;
      }
      case 'reorderSessions': {
        if (!Array.isArray(message.paths)) return;
        const prior = this.context.globalState.get<string[]>('piChat.sessionOrder', []);
        const proposed = message.paths.slice(0, 5000).filter((item): item is string => this.isKnownSessionPath(item));
        const visible = new Set(proposed);
        const order = [...proposed, ...prior.filter((item) => this.isKnownSessionPath(item) && !visible.has(item))];
        await this.context.globalState.update('piChat.sessionOrder', order);
        this.worker?.postMessage({ type: 'listSessions', query: this.sessionQuery });
        return;
      }
      case 'renameSession': {
        if (!this.isKnownSessionPath(message.path)) {
          this.post({ type: 'notice', message: 'That session is not in the current workspace session list.', isError: true });
          return;
        }
        const name = await vscode.window.showInputBox({
          prompt: 'Name this Pi session',
          placeHolder: 'Session name',
          value: typeof message.currentName === 'string' ? message.currentName : '',
        });
        if (name !== undefined && this.isKnownSessionPath(message.path)) this.worker?.postMessage({ type: 'renameSession', path: message.path, name: name.slice(0, 160) });
        return;
      }
      case 'forkSession':
        if (typeof message.entryId === 'string') this.worker?.postMessage({ type: 'forkSession', entryId: message.entryId });
        return;
      case 'exportSession': {
        const format = await vscode.window.showQuickPick([
          { label: 'Web page', description: 'Open a readable HTML export', value: 'html' },
          { label: 'Pi session file', description: 'Export this branch as JSONL', value: 'jsonl' },
        ], { placeHolder: 'Export this Pi session' });
        if (format) this.worker?.postMessage({ type: 'exportSession', name: format.value });
        return;
      }
      case 'deleteSession': {
        if (!this.isKnownSessionPath(message.path)) {
          this.post({ type: 'notice', message: 'That session is not in the current workspace session list.', isError: true });
          return;
        }
        if (this.normalizeSessionPath(message.path) === this.normalizeSessionPath(this.activeSessionPath)) {
          this.post({ type: 'notice', message: 'Switch to another session before deleting the active one.', isError: true });
          return;
        }
        const answer = await vscode.window.showWarningMessage(
          `Permanently delete this Pi session?\n${String(message.title ?? path.basename(message.path))}`,
          { modal: true },
          'Delete session',
        );
        if (answer !== 'Delete session') return;
        if (!this.isKnownSessionPath(message.path)
          || this.normalizeSessionPath(message.path) === this.normalizeSessionPath(this.activeSessionPath)) {
          this.post({ type: 'notice', message: 'The session changed while the confirmation was open; refresh history and try again.', isError: true });
          return;
        }
        await vscode.workspace.fs.delete(vscode.Uri.file(message.path));
        this.worker?.postMessage({ type: 'listSessions', query: this.sessionQuery });
        return;
      }
      case 'openSession':
        this.sessionInteractionStarted = true;
        if (this.isKnownSessionPath(message.path)) this.worker?.postMessage({ type: 'openSession', path: message.path });
        else this.post({ type: 'notice', message: 'That session is not in the current workspace session list.', isError: true });
        return;
      case 'stop':
        this.worker?.postMessage({ type: 'stop' });
        return;
      case 'send': {
        this.sessionInteractionStarted = true;
        if (typeof message.text !== 'string') return;
        const text = message.text.trim().slice(0, 100_000);
        const attachments = this.validateAttachments(message.attachments);
        const promptText = text || (attachments.some((item) => item.image)
          ? 'Please inspect the attached image.'
          : attachments.some((item) => item.context) ? 'Please inspect the attached context.' : '');
        if (!promptText) return;
        const attachedPaths = new Set(attachments.map((item) => {
          const relative = item.path.replaceAll('\\', '/');
          return process.platform === 'win32' ? relative.toLocaleLowerCase() : relative;
        }));
        const automaticContext = await this.collectAutomaticContext(attachedPaths);
        const prompt = this.composePrompt(promptText, [...attachments, ...automaticContext]);
        this.worker?.postMessage({
          type: 'prompt',
          text: prompt,
          deliverAs: message.deliverAs === 'steer' ? 'steer' : 'followUp',
          images: attachments
            .map((item) => item?.image)
            .filter((image): image is { data: string; mimeType: string } => Boolean(image && typeof image.data === 'string' && typeof image.mimeType === 'string'))
            .slice(0, 5),
        });
        return;
      }
      case 'copyText': {
        if (typeof message.text !== 'string') return;
        if (message.text.length > 100_000) {
          this.post({ type: 'notice', message: 'That code block is too large to copy from the chat.', isError: true });
          return;
        }
        try {
          await vscode.env.clipboard.writeText(message.text);
          this.post({ type: 'notice', message: 'Code copied to the clipboard.' });
        } catch (error) {
          this.post({ type: 'notice', message: error instanceof Error ? error.message : 'Could not write to the clipboard.', isError: true });
        }
        return;
      }
      case 'openExternalLink': {
        const uri = this.safeProviderUri(message.url);
        if (!uri) {
          this.post({ type: 'notice', message: 'That Markdown link is not allowed.', isError: true });
          return;
        }
        try {
          await vscode.env.openExternal(uri);
        } catch {
          this.post({ type: 'notice', message: 'Could not open that Markdown link.', isError: true });
        }
        return;
      }
      case 'setModel':
      case 'setThinkingLevel':
      case 'setTools':
      case 'setSkills':
      case 'usePreset':
      case 'setBookmarks':
      case 'replaceQueue':
      case 'extensionUiResponse':
      case 'navigateTree':
      case 'editUserMessage':
      case 'setMessageContext':
      case 'editMessageContext':
      case 'completeExtensionCommand':
        this.worker?.postMessage(message);
        return;
      case 'refreshModels': {
        const answer = await vscode.window.showWarningMessage(
          'Refresh configured model catalogs? Pi may contact provider endpoints and run API-key commands configured in its model settings.',
          { modal: true },
          'Refresh catalogs',
        );
        if (answer === 'Refresh catalogs') this.worker?.postMessage({ type: 'refreshModels' });
        return;
      }
      case 'updatePiSetting': {
        const worker = this.worker;
        if (!worker) return;
        const valid = (message.setting === 'autoCompaction' || message.setting === 'autoRetry')
          ? typeof message.value === 'boolean'
          : message.setting === 'cacheWarming'
            && (message.value === 'off' || message.value === 'streaming' || message.value === 'idle');
        if (!valid) {
          worker.postMessage({ type: 'getOptions' });
          return;
        }
        if (message.setting === 'cacheWarming' && message.value !== 'off') {
          const answer = await vscode.window.showWarningMessage(
            'Pi cache warming makes additional provider requests and may incur API costs. Enable the selected cache-warming mode in global Pi settings?',
            { modal: true },
            'Enable cache warming',
          );
          if (answer !== 'Enable cache warming') {
            if (this.worker === worker) worker.postMessage({ type: 'getOptions' });
            return;
          }
        }
        if (this.worker === worker) worker.postMessage(message);
        return;
      }
      case 'compactSession': {
        const answer = await vscode.window.showWarningMessage(
          'Pi will summarize older context and update the active session. Continue?',
          { modal: true },
          'Compact session',
        );
        if (answer === 'Compact session') this.worker?.postMessage({ type: 'compactSession' });
        return;
      }
      case 'reloadResources': {
        const answer = await vscode.window.showWarningMessage(
          'Reload Pi extensions, skills, prompts, and themes from your Pi configuration? Enabled extensions can run code during reload.',
          { modal: true },
          'Reload Pi resources',
        );
        if (answer === 'Reload Pi resources') this.worker?.postMessage({ type: 'reloadResources' });
        return;
      }
      case 'installPackage':
      case 'managePackage': {
        const worker = this.worker;
        if (!worker) return;
        const action = message.type === 'installPackage' ? 'install' : message.action;
        const source = typeof message.source === 'string' ? message.source.trim() : '';
        const scope = message.scope === 'project' ? 'project' : message.scope === 'user' ? 'user' : undefined;
        if (!['install', 'remove', 'update'].includes(String(action))) return;
        if (source.length > 512 || /[\u0000-\u001f\u007f]/.test(source)) return;
        if ((action === 'install' && (!source || !scope)) || (action === 'remove' && (!source || !scope))) return;
        if ((action === 'install' || action === 'remove') && !isPiPackageSource(source)) {
          this.post({ type: 'notice', message: 'Use npm:, git:, https://, or an explicit local path as the package source.', isError: true });
          return;
        }
        const scopeLabel = scope === 'project' ? 'project Pi settings' : 'global Pi settings';
        const prompt = action === 'install'
          ? `Install ${source} to ${scopeLabel}? Package installers may run code, and enabled extensions can execute inside Pi. Review the source before continuing.`
          : action === 'remove'
            ? `Remove ${source} from ${scopeLabel} and delete its managed install?`
            : 'Update configured Pi packages? This contacts package registries or Git remotes and may change code that runs inside Pi.';
        const label = action === 'install' ? 'Install package' : action === 'remove' ? 'Remove package' : 'Update packages';
        const answer = await vscode.window.showWarningMessage(prompt, { modal: true }, label);
        if (answer === label && this.worker === worker) {
          worker.postMessage({ type: 'managePackage', action, source, scope });
        }
        return;
      }
      case 'openPromptTemplate':
        await this.openPromptTemplate(message.filePath);
        return;
      case 'openResourceFile':
        await this.openResourceFile(message.filePath);
        return;
      case 'connectProvider':
        await this.connectProvider();
        return;
      case 'openModelsConfig':
        await this.openModelsConfig();
        return;
      case 'openPiSettings':
        await this.openPiSettings();
        return;
      case 'openMcpConfig':
        await this.openMcpConfig();
        return;
      case 'setMcpEnabled':
        await this.setMcpEnabled(message);
        return;
      case 'createPromptTemplate':
        await this.createPromptTemplate();
        return;
      case 'addPreset':
        await this.addPreset(message);
        return;
      case 'managePreset':
        await this.managePreset(message);
        return;
      case 'reorderPresets':
        await this.reorderPresets(message);
        return;
      case 'attachEditor':
        this.attachActiveEditor();
        return;
      case 'attachRange':
        await this.attachLineRange();
        return;
      case 'attachFile':
        await this.attachFile();
        return;
      case 'attachFolder':
        await this.attachFolder();
        return;
      case 'attachDiagnostics':
        this.attachDiagnostics();
        return;
      case 'attachGit':
        await this.attachGitState();
        return;
      case 'attachUris':
        if (Array.isArray(message.uris)) await this.attachUris(message.uris.filter((item): item is string => typeof item === 'string'));
        return;
      case 'searchMentions':
        await this.searchMentions(typeof message.query === 'string' ? message.query : '');
        return;
    }
  }

  private togglePinnedActiveFile(): void {
    if (this.pinnedActiveFileEnabled) {
      this.setPinnedActiveFile(false);
      return;
    }
    const editor = vscode.window.activeTextEditor;
    const workspace = vscode.workspace.workspaceFolders?.[0];
    if (!editor || !workspace || !this.workspaceRelativePath(editor.document.uri, workspace)) {
      this.post({ type: 'notice', message: 'Open a file inside this workspace before pinning the active file.' });
      return;
    }
    this.setPinnedActiveFile(true, editor);
  }

  private setPinnedActiveFile(enabled: boolean, editor = vscode.window.activeTextEditor): void {
    this.pinnedActiveFileEnabled = enabled;
    void this.context.workspaceState.update('piChat.context.pinnedActiveFile', enabled);
    if (enabled) this.publishPinnedActiveFile(editor);
    else this.post({ type: 'pinned-file', enabled: false });
  }

  private publishPinnedActiveFile(editor = vscode.window.activeTextEditor): void {
    if (!this.pinnedActiveFileEnabled) {
      this.post({ type: 'pinned-file', enabled: false });
      return;
    }
    const workspace = vscode.workspace.workspaceFolders?.[0];
    const relativePath = editor && workspace ? this.workspaceRelativePath(editor.document.uri, workspace) : undefined;
    if (!editor || !workspace || !relativePath) {
      this.post({ type: 'pinned-file', enabled: true });
      return;
    }
    const selection = editor.selection;
    const start = selection.isEmpty ? 0 : selection.start.line + 1;
    const end = selection.isEmpty ? 0 : Math.max(start, selection.end.line + (selection.end.character === 0 ? 0 : 1));
    const range = start ? `:${start}-${end}` : '';
    this.post({
      type: 'pinned-file',
      enabled: true,
      attachment: {
        id: 'pi-chat-pinned-active-file',
        label: `${path.basename(relativePath)} · pinned${range ? ` · lines ${start}-${end}` : ''}`,
        path: relativePath,
        context: `@${relativePath}${range}`,
      } satisfies Attachment,
    });
  }

  private attachActiveEditor(): void {
    const editor = vscode.window.activeTextEditor;
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!editor || !folder) {
      this.post({ type: 'notice', message: 'Open a file in this workspace before attaching editor context.' });
      return;
    }

    const relativePath = this.workspaceRelativePath(editor.document.uri, folder);
    if (!relativePath) {
      this.post({ type: 'notice', message: 'The active file is outside this workspace and was not attached.' });
      return;
    }

    const selection = editor.selection;
    const selectedText = selection.isEmpty ? '' : editor.document.getText(selection);
    const startLine = selection.start.line + 1;
    const endLine = selection.isEmpty ? startLine : selection.end.line + (selection.end.character === 0 ? 0 : 1);
    const lineSuffix = selectedText ? `:${startLine}-${Math.max(startLine, endLine)}` : '';
    const attachedText = selectedText || editor.document.getText();
    const contextText = this.formatFileContext(relativePath, attachedText, lineSuffix);
    const label = selectedText
      ? `${path.basename(relativePath)} · lines ${startLine}-${Math.max(startLine, endLine)}`
      : `${path.basename(relativePath)} · file`;

    this.post({
      type: 'attachment',
      attachment: { id: randomBytes(8).toString('hex'), label, path: relativePath, context: contextText } satisfies Attachment,
    });
  }

  private async attachLineRange(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    const workspace = vscode.workspace.workspaceFolders?.[0];
    if (!editor || !workspace) {
      this.post({ type: 'notice', message: 'Open a file in this workspace before attaching a line range.' });
      return;
    }
    const relativePath = this.workspaceRelativePath(editor.document.uri, workspace);
    if (!relativePath) {
      this.post({ type: 'notice', message: 'The active file is outside this workspace.' });
      return;
    }
    const selection = editor.selection;
    const firstLine = selection.isEmpty ? selection.active.line + 1 : selection.start.line + 1;
    const lastLine = selection.isEmpty ? firstLine : Math.max(firstLine, selection.end.line + (selection.end.character === 0 ? 0 : 1));
    const value = await vscode.window.showInputBox({
      prompt: `Choose lines from ${relativePath} (1–${editor.document.lineCount})`,
      placeHolder: '12 or 12-24',
      value: firstLine === lastLine ? String(firstLine) : `${firstLine}-${lastLine}`,
      validateInput: (input) => {
        const match = input.trim().match(/^(\d+)(?:\s*-\s*(\d+))?$/);
        if (!match) return 'Enter a line number or range, such as 12-24.';
        const start = Number(match[1]);
        const end = Number(match[2] ?? match[1]);
        if (start < 1 || end < start || end > editor.document.lineCount) return `Choose a range between 1 and ${editor.document.lineCount}.`;
        return undefined;
      },
    });
    if (value === undefined) return;
    const match = value.trim().match(/^(\d+)(?:\s*-\s*(\d+))?$/);
    if (!match) return;
    const start = Number(match[1]);
    const end = Number(match[2] ?? match[1]);
    this.post({
      type: 'attachment',
      attachment: {
        id: randomBytes(8).toString('hex'),
        label: `${path.basename(relativePath)} · lines ${start}-${end}`,
        path: relativePath,
        context: `@${relativePath}:${start}-${end}`,
      } satisfies Attachment,
    });
  }

  private async attachFile(): Promise<void> {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
      this.post({ type: 'notice', message: 'Open a workspace before attaching a file.' });
      return;
    }

    const files = await vscode.window.showOpenDialog({
      canSelectFiles: true,
      canSelectFolders: false,
      canSelectMany: false,
      openLabel: 'Attach file to Pi',
      defaultUri: folder.uri,
    });
    const uri = files?.[0];
    if (!uri) return;

    const relativePath = this.workspaceRelativePath(uri, folder);
    if (!relativePath) {
      this.post({ type: 'notice', message: 'Choose a file inside the open workspace.' });
      return;
    }

    try {
      const stat = await vscode.workspace.fs.stat(uri);
      const mimeType = this.imageMimeType(uri.fsPath);
      if (mimeType) {
        if (stat.size > MAX_IMAGE_BYTES) {
          this.post({ type: 'notice', message: 'This image is over 5 MB. Choose a smaller image.' });
          return;
        }
        const bytes = await vscode.workspace.fs.readFile(uri);
        this.post({
          type: 'attachment',
          attachment: {
            id: randomBytes(8).toString('hex'),
            label: `${path.basename(relativePath)} · image`,
            path: relativePath,
            context: '',
            image: { data: Buffer.from(bytes).toString('base64'), mimeType },
          } satisfies Attachment,
        });
        return;
      }
      if (stat.size > MAX_ATTACHMENT_BYTES) {
        this.post({ type: 'notice', message: 'This file is over 1 MB. Attach a smaller file or select a relevant range in the editor.' });
        return;
      }
      const document = await vscode.workspace.openTextDocument(uri);
      const text = document.getText();
      this.post({
        type: 'attachment',
        attachment: {
          id: randomBytes(8).toString('hex'),
          label: `${path.basename(relativePath)} · file`,
          path: relativePath,
          context: this.formatFileContext(relativePath, text),
        } satisfies Attachment,
      });
    } catch (error) {
      const detail = error instanceof Error ? ` ${error.message}` : '';
      this.post({ type: 'notice', message: `Could not read this file as text.${detail}` });
    }
  }

  private async attachFolder(): Promise<void> {
    const workspace = vscode.workspace.workspaceFolders?.[0];
    if (!workspace) {
      this.post({ type: 'notice', message: 'Open a workspace before attaching a folder.' });
      return;
    }
    const folders = await vscode.window.showOpenDialog({
      canSelectFiles: false,
      canSelectFolders: true,
      canSelectMany: false,
      openLabel: 'Attach folder to Pi',
      defaultUri: workspace.uri,
    });
    const uri = folders?.[0];
    if (!uri) return;
    const relativePath = this.workspaceRelativePath(uri, workspace);
    if (!relativePath) {
      this.post({ type: 'notice', message: 'Choose a folder inside the open workspace.' });
      return;
    }
    const found = await vscode.workspace.findFiles(
      new vscode.RelativePattern(uri, '**/*'),
      '**/{.git,node_modules,dist,build}/**',
      200,
    );
    const paths = found.map((file) => path.relative(uri.fsPath, file.fsPath).replaceAll(path.sep, '/'));
    const listing = paths.length ? paths.map((item) => `@${relativePath}/${item}`).join('\n') : '(empty folder)';
    this.post({
      type: 'attachment',
      attachment: {
        id: randomBytes(8).toString('hex'),
        label: `${path.basename(relativePath)} · folder (${paths.length}${found.length === 200 ? '+' : ''} files)`,
        path: relativePath,
        context: `@${relativePath}/\n${listing}`,
      } satisfies Attachment,
    });
  }

  private attachDiagnostics(): void {
    const editor = vscode.window.activeTextEditor;
    const workspace = vscode.workspace.workspaceFolders?.[0];
    if (!editor || !workspace) {
      this.post({ type: 'notice', message: 'Open a file in this workspace before attaching its problems.' });
      return;
    }
    const relativePath = this.workspaceRelativePath(editor.document.uri, workspace);
    if (!relativePath) {
      this.post({ type: 'notice', message: 'The active file is outside this workspace.' });
      return;
    }
    const attachment = this.createDiagnosticsAttachment(editor.document.uri, workspace);
    if (attachment) this.post({ type: 'attachment', attachment });
  }

  private createDiagnosticsAttachment(uri: vscode.Uri, workspace: vscode.WorkspaceFolder): Attachment | undefined {
    const relativePath = this.workspaceRelativePath(uri, workspace);
    if (!relativePath) return undefined;
    const problems = vscode.languages.getDiagnostics(uri);
    const severity = (value: vscode.DiagnosticSeverity): string => value === vscode.DiagnosticSeverity.Error
      ? 'error'
      : value === vscode.DiagnosticSeverity.Warning ? 'warning' : value === vscode.DiagnosticSeverity.Information ? 'info' : 'hint';
    const details = problems.slice(0, 50).map((problem) => {
      const line = problem.range.start.line + 1;
      const column = problem.range.start.character + 1;
      const code = typeof problem.code === 'string' || typeof problem.code === 'number' ? ` [${problem.code}]` : '';
      return `${severity(problem.severity)} ${relativePath}:${line}:${column}${code}: ${String(problem.message).slice(0, 500)}`;
    });
    const omitted = problems.length > details.length ? `\n[${problems.length - details.length} more diagnostics omitted]` : '';
    return {
      id: randomBytes(8).toString('hex'),
      label: `${path.basename(relativePath)} · ${problems.length} problems`,
      path: relativePath,
      context: `Problems for @${relativePath}:\n${details.length ? details.join('\n') : 'No reported problems.'}${omitted}`.slice(0, MAX_ATTACHMENT_CHARS),
    };
  }

  private async attachGitState(): Promise<void> {
    const workspace = vscode.workspace.workspaceFolders?.[0];
    if (!workspace) {
      this.post({ type: 'notice', message: 'Open a workspace before attaching Git status.' });
      return;
    }
    try {
      const attachment = await this.createGitStateAttachment(workspace);
      if (!attachment) {
        this.post({ type: 'notice', message: 'This workspace is not inside a Git repository.' });
        return;
      }
      this.post({ type: 'attachment', attachment });
    } catch (error) {
      this.post({ type: 'notice', message: `Could not read Git status. ${error instanceof Error ? error.message : ''}` });
    }
  }

  private async createGitStateAttachment(workspace: vscode.WorkspaceFolder): Promise<Attachment | undefined> {
    const handle = await this.getGitRepository(workspace);
    if (!handle) return undefined;
    const { repository } = handle;
    const state = repository.state;
    const names = (changes: GitChangeRecord[]) => changes.slice(0, 100).map((change) => {
      const uri = change.uri ?? change.resourceUri;
      return uri ? this.workspaceRelativePath(uri, workspace) : undefined;
    }).filter(Boolean);
    const branch = String(state.HEAD?.name ?? '(detached HEAD)').slice(0, 200);
    const upstreamName = state.HEAD?.upstream
      ? `${state.HEAD.upstream.remote ?? ''}/${state.HEAD.upstream.name ?? ''}`.replace(/^\/|\/$/g, '')
      : '';
    const upstream = upstreamName ? `\nUpstream: ${upstreamName.slice(0, 200)}` : '';
    const commits = state.HEAD?.ahead !== undefined || state.HEAD?.behind !== undefined
      ? `\nAhead: ${Number(state.HEAD.ahead) || 0}; behind: ${Number(state.HEAD.behind) || 0}`
      : '';
    const index = names(state.indexChanges ?? []);
    const working = names(state.workingTreeChanges ?? []);
    const untracked = names(state.untrackedChanges ?? []);
    const conflicts = names(state.mergeChanges ?? []);
    const context = [
      `Branch: ${branch}${upstream}${commits}`,
      `Staged (${state.indexChanges?.length ?? 0}): ${index.join(', ') || 'none'}`,
      `Unstaged (${state.workingTreeChanges?.length ?? 0}): ${working.join(', ') || 'none'}`,
      `Untracked (${state.untrackedChanges?.length ?? 0}): ${untracked.join(', ') || 'none'}`,
      `Conflicts (${state.mergeChanges?.length ?? 0}): ${conflicts.join(', ') || 'none'}`,
    ].join('\n');
    return {
      id: randomBytes(8).toString('hex'),
      label: 'Git status',
      path: workspace.name,
      context: `Git workspace state:\n${context}`.slice(0, MAX_ATTACHMENT_CHARS),
    };
  }

  private async getGitRepository(workspace: vscode.WorkspaceFolder): Promise<{ api: GitApiLike; repository: GitRepositoryLike } | undefined> {
    const extension = vscode.extensions.getExtension('vscode.git');
    if (!extension) throw new Error('The built-in Git extension is unavailable.');
    const git = extension.isActive ? extension.exports : await extension.activate();
    const api = git.getAPI(1) as GitApiLike;
    const containing = api.repositories
      .filter((item) => this.relativePathFrom(item.rootUri, workspace.uri) !== undefined)
      .sort((a, b) => b.rootUri.fsPath.length - a.rootUri.fsPath.length);
    const nested = api.repositories
      .filter((item) => this.relativePathFrom(workspace.uri, item.rootUri) !== undefined)
      .sort((a, b) => a.rootUri.fsPath.length - b.rootUri.fsPath.length);
    const repository = containing[0] ?? nested[0];
    return repository ? { api, repository } : undefined;
  }

  private async refreshGitChanges(): Promise<void> {
    const workspace = vscode.workspace.workspaceFolders?.[0];
    if (!workspace) {
      this.post({ type: 'git-changes', available: false, message: 'Open a workspace to review Git changes.', files: [] });
      return;
    }
    try {
      const handle = await this.getGitRepository(workspace);
      if (!handle) {
        this.post({ type: 'git-changes', available: false, message: 'This workspace is not inside a Git repository.', files: [] });
        return;
      }
      const { repository } = handle;
      await repository.status?.();
      const state = repository.state;
      const files = new Map<string, GitFileStatus>();
      const add = (changes: GitChangeRecord[] | undefined, label: string, canDiscard = false) => {
        for (const change of (changes ?? []).slice(0, MAX_GIT_REVIEW_FILES)) {
          const uri = change.uri ?? change.resourceUri;
          const relativePath = uri ? this.workspaceRelativePath(uri, workspace) : undefined;
          if (!relativePath) continue;
          let item = files.get(relativePath);
          if (!item) {
            item = { path: relativePath.slice(0, 4096), status: [], canDiscard: false, isUntracked: false };
            files.set(relativePath, item);
          }
          if (!item.status.includes(label)) item.status.push(label);
          if (label === 'Untracked') item.isUntracked = true;
          if (canDiscard && !item.isUntracked) item.canDiscard = true;
        }
      };
      add(state.indexChanges, 'Staged');
      add(state.workingTreeChanges, 'Modified', true);
      add(state.untrackedChanges, 'Untracked');
      add(state.mergeChanges, 'Conflict');
      for (const item of files.values()) {
        if (item.status.includes('Conflict') || item.isUntracked) item.canDiscard = false;
      }
      let stats: { files: number; insertions: number; deletions: number } | undefined;
      try {
        stats = await repository.diffWithHEADShortStats?.();
      } catch {
        // File names and statuses remain useful when Git cannot compute diff statistics.
      }
      const head = state.HEAD;
      const summary = {
        branch: String(head?.name ?? '(detached HEAD)').slice(0, 200),
        staged: state.indexChanges?.length ?? 0,
        modified: state.workingTreeChanges?.length ?? 0,
        untracked: state.untrackedChanges?.length ?? 0,
        conflicts: state.mergeChanges?.length ?? 0,
        files: files.size,
        insertions: stats?.insertions ?? 0,
        deletions: stats?.deletions ?? 0,
      };
      this.post({
        type: 'git-changes',
        available: true,
        summary,
        files: [...files.values()].slice(0, MAX_GIT_REVIEW_FILES),
        truncated: files.size > MAX_GIT_REVIEW_FILES,
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message.slice(0, 300) : 'Git status is unavailable.';
      this.post({ type: 'git-changes', available: false, message: `Could not read Git changes. ${reason}`, files: [] });
    }
  }

  private async findCurrentGitChange(value: unknown): Promise<{ workspace: vscode.WorkspaceFolder; repository: GitRepositoryLike; uri: vscode.Uri; relativePath: string; isUntracked: boolean } | undefined> {
    if (typeof value !== 'string' || value.length < 1 || value.length > 4096 || path.isAbsolute(value)) return undefined;
    const normalized = value.replaceAll('\\', '/');
    if (normalized.split('/').some((part) => !part || part === '.' || part === '..')) return undefined;
    const workspace = vscode.workspace.workspaceFolders?.[0];
    if (!workspace) return undefined;
    const handle = await this.getGitRepository(workspace);
    if (!handle) return undefined;
    await handle.repository.status?.();
    const state = handle.repository.state;
    const groups: Array<{ changes: GitChangeRecord[] | undefined; isUntracked: boolean }> = [
      { changes: state.indexChanges, isUntracked: false },
      { changes: state.workingTreeChanges, isUntracked: false },
      { changes: state.untrackedChanges, isUntracked: true },
      { changes: state.mergeChanges, isUntracked: false },
    ];
    for (const group of groups) {
      for (const change of group.changes ?? []) {
        const uri = change.uri ?? change.resourceUri;
        if (!uri || this.workspaceRelativePath(uri, workspace) !== normalized) continue;
        return { workspace, repository: handle.repository, uri, relativePath: normalized, isUntracked: group.isUntracked };
      }
    }
    return undefined;
  }

  private async openGitDiff(value: unknown): Promise<void> {
    try {
      const target = await this.findCurrentGitChange(value);
      if (!target) {
        this.post({ type: 'notice', message: 'That file is no longer listed as a Git change. Refresh and try again.', isError: true });
        await this.refreshGitChanges();
        return;
      }
      if (target.isUntracked) {
        await vscode.window.showTextDocument(target.uri, { preview: false });
        return;
      }
      const repositoryPath = this.relativePathFrom(target.repository.rootUri, target.uri);
      if (!repositoryPath) {
        this.post({ type: 'notice', message: 'Could not resolve this file inside its Git repository.' });
        return;
      }
      const patch = await target.repository.diffWithHEAD?.(repositoryPath);
      if (typeof patch !== 'string' || !patch.trim()) {
        this.post({ type: 'notice', message: 'Git returned no diff for that file.' });
        return;
      }
      const boundedPatch = patch.length > MAX_GIT_DIFF_CHARS
        ? `${patch.slice(0, MAX_GIT_DIFF_CHARS)}\n\n[Diff truncated in this editor. Open the file in Source Control for the full change.]`
        : patch;
      const document = await vscode.workspace.openTextDocument({ language: 'diff', content: boundedPatch });
      await vscode.window.showTextDocument(document, { preview: false });
    } catch (error) {
      this.post({ type: 'notice', message: `Could not open this Git change. ${error instanceof Error ? error.message.slice(0, 300) : ''}`, isError: true });
    }
  }

  private async discardGitChange(value: unknown): Promise<void> {
    const target = await this.findCurrentGitChange(value);
    if (!target || target.isUntracked || !target.repository.restore) {
      this.post({ type: 'notice', message: 'Only tracked unstaged changes can be discarded here. Refresh the Git list and try again.', isError: true });
      await this.refreshGitChanges();
      return;
    }
    const hasConflict = (target.repository.state.mergeChanges ?? []).some((change) => {
      const uri = change.uri ?? change.resourceUri;
      return uri && this.workspaceRelativePath(uri, target.workspace) === target.relativePath;
    });
    const hasUnstagedChange = (target.repository.state.workingTreeChanges ?? []).some((change) => {
      const uri = change.uri ?? change.resourceUri;
      return uri && this.workspaceRelativePath(uri, target.workspace) === target.relativePath;
    });
    if (!hasUnstagedChange || hasConflict) {
      this.post({ type: 'notice', message: 'That file no longer has a discardable unstaged change. Refresh and try again.', isError: true });
      await this.refreshGitChanges();
      return;
    }
    const answer = await vscode.window.showWarningMessage(
      `Discard unstaged changes to ${target.relativePath}? This restores the file to its staged version; staged changes are retained.`,
      { modal: true },
      'Discard unstaged changes',
    );
    if (answer !== 'Discard unstaged changes') return;
    const current = await this.findCurrentGitChange(target.relativePath);
    if (!current || current.isUntracked || current.uri.fsPath !== target.uri.fsPath) {
      this.post({ type: 'notice', message: 'The Git state changed while confirmation was open. Nothing was discarded.', isError: true });
      await this.refreshGitChanges();
      return;
    }
    const latestWorkingChange = (current.repository.state.workingTreeChanges ?? []).some((change) => {
      const uri = change.uri ?? change.resourceUri;
      return uri && this.workspaceRelativePath(uri, current.workspace) === current.relativePath;
    });
    const latestConflict = (current.repository.state.mergeChanges ?? []).some((change) => {
      const uri = change.uri ?? change.resourceUri;
      return uri && this.workspaceRelativePath(uri, current.workspace) === current.relativePath;
    });
    if (!latestWorkingChange || latestConflict
      || this.normalizeSessionPath(current.repository.rootUri.fsPath) !== this.normalizeSessionPath(target.repository.rootUri.fsPath)) {
      this.post({ type: 'notice', message: 'The Git state changed while confirmation was open. Nothing was discarded.', isError: true });
      await this.refreshGitChanges();
      return;
    }
    try {
      const repositoryPath = this.relativePathFrom(current.repository.rootUri, current.uri);
      if (!repositoryPath) {
        this.post({ type: 'notice', message: 'Could not resolve this file inside its Git repository. Nothing was discarded.', isError: true });
        return;
      }
      // Git restore without --staged restores the worktree from the index, preserving staged content.
      await current.repository.restore!([repositoryPath]);
      await this.refreshGitChanges();
    } catch (error) {
      this.post({ type: 'notice', message: `Could not discard this Git change. ${error instanceof Error ? error.message.slice(0, 300) : ''}`, isError: true });
    }
  }

  private quoteGitDiffSelection(): void {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.languageId !== 'diff' || editor.selection.isEmpty) {
      this.post({ type: 'notice', message: 'Select lines in an opened Git diff before quoting them.' });
      return;
    }
    const selected = editor.document.getText(editor.selection).trim();
    if (!selected) {
      this.post({ type: 'notice', message: 'The selected Git diff lines are empty.' });
      return;
    }
    const content = this.formatFileContext('Git diff selection', selected);
    this.post({
      type: 'attachment',
      attachment: {
        id: randomBytes(8).toString('hex'),
        label: 'Git diff · selected lines',
        path: 'Git diff selection',
        context: content.slice(0, MAX_ATTACHMENT_CHARS),
      } satisfies Attachment,
    });
  }

  private async draftGitChanges(value: unknown): Promise<void> {
    const kind = value === 'commit' || value === 'pullRequest' ? value : undefined;
    if (!kind) return;
    const workspace = vscode.workspace.workspaceFolders?.[0];
    if (!workspace) {
      this.post({ type: 'notice', message: 'Open a workspace before preparing a Git draft.', isError: true });
      return;
    }
    try {
      const handle = await this.getGitRepository(workspace);
      if (!handle) {
        this.post({ type: 'notice', message: 'This workspace is not inside a Git repository.', isError: true });
        return;
      }
      const { repository } = handle;
      await repository.status?.();
      const gitState = repository.state;
      const changes = new Map<string, { uri: vscode.Uri; statuses: Set<string>; untracked: boolean }>();
      let omittedPaths = false;
      const collect = (records: GitChangeRecord[] | undefined, label: string, untracked = false) => {
        for (const record of records ?? []) {
          const uri = record.uri ?? record.resourceUri;
          const relativePath = uri ? this.workspaceRelativePath(uri, workspace) : undefined;
          if (!uri || !relativePath) continue;
          if (!changes.has(relativePath) && changes.size >= MAX_GIT_REVIEW_FILES) {
            omittedPaths = true;
            continue;
          }
          const item = changes.get(relativePath) ?? { uri, statuses: new Set<string>(), untracked: false };
          item.statuses.add(label);
          item.untracked ||= untracked;
          changes.set(relativePath, item);
        }
      };
      collect(gitState.indexChanges, 'staged');
      collect(gitState.workingTreeChanges, 'modified');
      collect(gitState.untrackedChanges, 'untracked', true);
      collect(gitState.mergeChanges, 'conflict');
      if (!changes.size) {
        this.post({ type: 'notice', message: 'There are no Git changes to include in a draft.' });
        return;
      }

      const listedPaths = [...changes.entries()].slice(0, 12)
        .map(([relativePath, item]) => `${JSON.stringify(relativePath.slice(0, 120))} (${[...item.statuses].join(', ')})`);
      const header = [
        `Git changes on branch: ${String(gitState.HEAD?.name ?? '(detached HEAD)').slice(0, 200)}`,
        `Changed files: ${changes.size}${omittedPaths ? '+' : ''}`,
        ...listedPaths,
        ...(changes.size > listedPaths.length || omittedPaths ? ['Additional paths are omitted from this preview.'] : []),
        '',
        'Bounded diff and text preview follows. Content may include sensitive values; review it before sending.',
      ].join('\n').slice(0, MAX_GIT_DRAFT_CHARS - 64);
      const sections: string[] = [header];
      let usedChars = header.length;
      let truncated = omittedPaths;
      for (const [relativePath, item] of [...changes.entries()].slice(0, MAX_GIT_DRAFT_FILES)) {
        if (usedChars >= MAX_GIT_DRAFT_CHARS) { truncated = true; break; }
        let detail = '';
        if (item.untracked) {
          try {
            const stat = await vscode.workspace.fs.stat(item.uri);
            if ((stat.type & vscode.FileType.SymbolicLink) !== 0) {
              detail = '[Symbolic link; content omitted.]';
            } else if ((stat.type & vscode.FileType.File) === 0) {
              detail = '[Non-file untracked item; content omitted.]';
            } else if (stat.size > MAX_UNTRACKED_DRAFT_BYTES) {
              detail = '[Untracked file exceeds the preview size limit; content omitted.]';
            } else {
              const bytes = await vscode.workspace.fs.readFile(item.uri);
              detail = bytes.includes(0)
                ? '[Binary untracked file; content omitted.]'
                : `Untracked file content:\n${Buffer.from(bytes).toString('utf8')}`;
            }
          } catch {
            detail = '[Untracked file content could not be read.]';
          }
        } else {
          const repositoryPath = this.relativePathFrom(repository.rootUri, item.uri);
          if (repositoryPath) {
            try {
              const diff = await repository.diffWithHEAD?.(repositoryPath);
              detail = typeof diff === 'string' && diff.trim() ? diff : '[No text diff available.]';
            } catch {
              detail = '[Diff could not be read.]';
            }
          }
        }
        const section = `\n\n--- ${JSON.stringify(relativePath.slice(0, 512))} (${[...item.statuses].join(', ')}) ---\n${detail}`;
        const remaining = MAX_GIT_DRAFT_CHARS - usedChars;
        sections.push(section.slice(0, remaining));
        usedChars += Math.min(section.length, remaining);
        if (section.length > remaining) { truncated = true; break; }
      }
      if (changes.size > MAX_GIT_DRAFT_FILES) truncated = true;
      const combinedContext = sections.join('');
      const truncationNotice = '\n\n[Git context truncated at the preview limit.]';
      const boundedContext = truncated
        ? `${combinedContext.slice(0, Math.max(0, MAX_GIT_DRAFT_CHARS - truncationNotice.length))}${truncationNotice}`
        : combinedContext.slice(0, MAX_GIT_DRAFT_CHARS);
      const attachment: Attachment = {
        id: randomBytes(8).toString('hex'),
        label: kind === 'commit' ? 'Git changes · commit draft' : 'Git changes · PR draft',
        path: 'Git review',
        context: boundedContext,
      };
      const draftPrompt = kind === 'commit'
        ? 'Draft one concise Conventional Commit subject using the attached Git changes. Return only the subject line. Do not claim tests were run.'
        : 'Draft a pull request description from the attached Git changes with Summary, Changes, Testing, and Risks sections. Say “Not run” for testing unless the attached context provides evidence. Do not invent results or claims.';
      this.post({ type: 'attachment', attachment, draftPrompt });
    } catch {
      this.post({ type: 'notice', message: 'Could not prepare Git changes for a draft. Refresh the Git review and try again.', isError: true });
    }
  }

  private async attachUris(rawUris: string[]): Promise<void> {
    const workspace = vscode.workspace.workspaceFolders?.[0];
    if (!workspace) return;
    for (const raw of rawUris.slice(0, 12)) {
      try {
        const uri = vscode.Uri.parse(raw);
        const relativePath = this.workspaceRelativePath(uri, workspace);
        if (!relativePath) continue;
        const stat = await vscode.workspace.fs.stat(uri);
        if ((stat.type & vscode.FileType.Directory) !== 0) {
          const found = await vscode.workspace.findFiles(new vscode.RelativePattern(uri, '**/*'), '**/{.git,node_modules,dist,build}/**', 200);
          const listing = found.map((file) => `@${path.relative(workspace.uri.fsPath, file.fsPath).replaceAll(path.sep, '/')}`);
          this.post({
            type: 'attachment',
            attachment: { id: randomBytes(8).toString('hex'), label: `${path.basename(relativePath)} · folder`, path: relativePath, context: listing.join('\n') } satisfies Attachment,
          });
          continue;
        }
        if (stat.size > MAX_ATTACHMENT_BYTES) continue;
        const document = await vscode.workspace.openTextDocument(uri);
        this.post({
          type: 'attachment',
          attachment: {
            id: randomBytes(8).toString('hex'),
            label: `${path.basename(relativePath)} · file`,
            path: relativePath,
            context: this.formatFileContext(relativePath, document.getText()),
          } satisfies Attachment,
        });
      } catch {
        // Ignore dropped items that are not readable workspace files.
      }
    }
  }

  private async searchMentions(query: string): Promise<void> {
    const workspace = vscode.workspace.workspaceFolders?.[0];
    if (!workspace) return;
    try {
      const files = await vscode.workspace.findFiles('**/*', '**/{.git,node_modules,dist,build}/**', 1200);
      const normalized = query.trim().toLocaleLowerCase();
      const results = files
        .map((uri) => ({ uri: uri.toString(), path: this.workspaceRelativePath(uri, workspace) }))
        .filter((item): item is { uri: string; path: string } => Boolean(item.path))
        .filter((item) => !normalized || item.path.toLocaleLowerCase().includes(normalized))
        .slice(0, 30);
      this.post({ type: 'mention-results', query, results });
    } catch (error) {
      this.post({ type: 'notice', message: `Could not search workspace files. ${error instanceof Error ? error.message : ''}` });
    }
  }

  private async addPreset(message: RuntimeMessage): Promise<void> {
    if (typeof message.provider !== 'string' || typeof message.modelId !== 'string') return;
    const name = await vscode.window.showInputBox({ prompt: 'Name this model preset', placeHolder: 'Quick, Deep, Review…' });
    if (!name?.trim()) return;
    const presets = this.context.workspaceState.get<ModelPreset[]>('piChat.modelPresets', []);
    presets.push({
      id: randomBytes(8).toString('hex'),
      name: name.trim(),
      provider: message.provider,
      modelId: message.modelId,
      thinkingLevel: typeof message.thinkingLevel === 'string' ? message.thinkingLevel : undefined,
    });
    await this.context.workspaceState.update('piChat.modelPresets', presets);
    this.post({ type: 'presets', presets });
  }

  private async managePreset(message: RuntimeMessage): Promise<void> {
    if (typeof message.id !== 'string') return;
    const presets = this.context.workspaceState.get<ModelPreset[]>('piChat.modelPresets', []);
    const preset = presets.find((item) => item.id === message.id);
    if (!preset) return;
    const action = await vscode.window.showQuickPick(['Rename', 'Remove'], { placeHolder: `Manage “${preset.name}”` });
    if (!action) return;
    if (action === 'Remove') {
      await this.context.workspaceState.update('piChat.modelPresets', presets.filter((item) => item.id !== preset.id));
    } else {
      const name = await vscode.window.showInputBox({ prompt: 'Rename this model preset', value: preset.name });
      if (!name?.trim()) return;
      preset.name = name.trim();
      await this.context.workspaceState.update('piChat.modelPresets', presets);
    }
    this.post({ type: 'presets', presets: this.context.workspaceState.get<ModelPreset[]>('piChat.modelPresets', []) });
  }

  private async openPromptTemplate(value: unknown): Promise<void> {
    if (typeof value !== 'string' || value.length > 4096) return;
    let normalized: string;
    try {
      normalized = this.normalizeSessionPath(value);
    } catch {
      return;
    }
    if (!this.knownPromptPaths.has(normalized)) {
      this.post({ type: 'notice', message: 'That prompt template is no longer in Pi’s loaded resource list. Reload resources and try again.', isError: true });
      return;
    }
    await this.openResourceDocument(value, 'prompt template');
  }

  private async openResourceFile(value: unknown): Promise<void> {
    if (typeof value !== 'string' || value.length > 4096) return;
    let normalized: string;
    try {
      normalized = this.normalizeSessionPath(value);
    } catch {
      return;
    }
    if (!this.knownResourcePaths.has(normalized)) {
      this.post({ type: 'notice', message: 'That resource file is no longer in Pi’s diagnostic list. Reload resources and try again.', isError: true });
      return;
    }
    await this.openResourceDocument(value, 'Pi resource');
  }

  private async openResourceDocument(value: string, label: string): Promise<void> {
    try {
      const document = await vscode.workspace.openTextDocument(vscode.Uri.file(value));
      await vscode.window.showTextDocument(document, { preview: false });
    } catch (error) {
      this.post({ type: 'notice', message: `Could not open the ${label}. ${error instanceof Error ? error.message : ''}`, isError: true });
    }
  }

  private async connectProvider(): Promise<void> {
    const methods = this.availableProviders.flatMap((provider) => [
      ...(provider.supportsOAuth ? [{
        label: `${provider.oauthLabel} · ${provider.name}`,
        description: provider.configured ? `Credential configured${provider.authLabel ? ` · ${provider.authLabel}` : ''}` : 'Sign in with a provider account',
        providerId: provider.id,
        providerName: provider.name,
        authType: 'oauth' as const,
      }] : []),
      ...(provider.supportsApiKey ? [{
        label: `${provider.apiKeyName} · ${provider.name}`,
        description: provider.configured ? `Credential configured${provider.authLabel ? ` · ${provider.authLabel}` : ''}` : 'Add an API key or provider credential',
        providerId: provider.id,
        providerName: provider.name,
        authType: 'api_key' as const,
      }] : []),
    ]);
    const selected = await vscode.window.showQuickPick(methods, {
      placeHolder: 'Choose a provider sign-in method',
      ignoreFocusOut: true,
    });
    if (!selected) return;
    const answer = await vscode.window.showWarningMessage(
      `Continue with ${selected.label}? Pi will store the credential in its existing configuration and may replace a saved credential for this provider.`,
      { modal: true },
      'Continue',
    );
    if (answer !== 'Continue') return;
    this.worker?.postMessage({ type: 'providerLogin', providerId: selected.providerId, authType: selected.authType });
  }

  private async handleProviderAuthPrompt(message: RuntimeMessage, worker: Worker): Promise<void> {
    if (typeof message.requestId !== 'string' || message.requestId.length > 128) return;
    const prompt = typeof message.message === 'string' ? message.message.slice(0, 1000) : 'Provider sign-in';
    const promptType = message.promptType;
    const controller = new AbortController();
    this.providerAuthPromptCancels.set(message.requestId, { worker, cancel: () => controller.abort() });
    let value: string | undefined;
    try {
      if (promptType === 'select' && Array.isArray(message.options)) {
        const options = (message.options as Array<Record<string, unknown>>).slice(0, 100)
          .filter((option) => typeof option.id === 'string' && option.id.length <= 256)
          .map((option) => ({
            label: typeof option.label === 'string' ? option.label.slice(0, 256) : String(option.id),
            description: typeof option.description === 'string' ? option.description.slice(0, 500) : undefined,
            id: option.id as string,
          }));
        value = await this.showProviderSelectPrompt(options, prompt, controller.signal);
      } else if (promptType === 'text' || promptType === 'secret' || promptType === 'manual_code') {
        value = await this.showProviderInputPrompt(
          prompt,
          typeof message.placeholder === 'string' ? message.placeholder.slice(0, 256) : undefined,
          promptType === 'secret',
          controller.signal,
        );
        if (value && value.length > 8192) {
          this.post({ type: 'notice', message: 'The provider credential input is too long; sign-in was cancelled.', isError: true });
          value = undefined;
        }
      }
    } catch (error) {
      this.post({ type: 'notice', message: `Provider sign-in prompt failed (${error instanceof Error ? error.name : 'error'}).`, isError: true });
    } finally {
      const pending = this.providerAuthPromptCancels.get(message.requestId);
      if (pending?.worker === worker) this.providerAuthPromptCancels.delete(message.requestId);
      if (this.worker === worker) worker.postMessage({ type: 'extensionUiResponse', requestId: message.requestId, value });
    }
  }

  private showProviderInputPrompt(prompt: string, placeholder: string | undefined, password: boolean, signal: AbortSignal): Promise<string | undefined> {
    if (signal.aborted) return Promise.resolve(undefined);
    const input = vscode.window.createInputBox();
    input.title = 'Pi provider sign-in';
    input.prompt = prompt;
    input.placeholder = placeholder ?? '';
    input.password = password;
    input.ignoreFocusOut = true;
    return new Promise((resolve) => {
      let settled = false;
      let accept: vscode.Disposable | undefined;
      let hide: vscode.Disposable | undefined;
      const onAbort = () => finish(undefined);
      const finish = (value: string | undefined) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', onAbort);
        accept?.dispose();
        hide?.dispose();
        input.hide();
        input.dispose();
        resolve(value);
      };
      accept = input.onDidAccept(() => finish(input.value));
      hide = input.onDidHide(() => finish(undefined));
      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) finish(undefined);
      else input.show();
    });
  }

  private showProviderSelectPrompt(options: Array<{ label: string; description?: string; id: string }>, prompt: string, signal: AbortSignal): Promise<string | undefined> {
    if (signal.aborted) return Promise.resolve(undefined);
    type AuthChoice = vscode.QuickPickItem & { id: string };
    const picker = vscode.window.createQuickPick<AuthChoice>();
    picker.title = 'Pi provider sign-in';
    picker.placeholder = prompt;
    picker.ignoreFocusOut = true;
    picker.items = options;
    return new Promise((resolve) => {
      let settled = false;
      let accept: vscode.Disposable | undefined;
      let hide: vscode.Disposable | undefined;
      const onAbort = () => finish(undefined);
      const finish = (value: string | undefined) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', onAbort);
        accept?.dispose();
        hide?.dispose();
        picker.hide();
        picker.dispose();
        resolve(value);
      };
      accept = picker.onDidAccept(() => finish(picker.selectedItems[0]?.id));
      hide = picker.onDidHide(() => finish(undefined));
      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) finish(undefined);
      else picker.show();
    });
  }

  private cancelProviderAuthPrompts(worker?: Worker): void {
    for (const [requestId, pending] of this.providerAuthPromptCancels) {
      if (worker && pending.worker !== worker) continue;
      this.providerAuthPromptCancels.delete(requestId);
      pending.cancel();
    }
  }

  private async handleProviderAuthEvent(message: RuntimeMessage, worker: Worker): Promise<void> {
    if (this.worker !== worker) return;
    const provider = typeof message.providerName === 'string' ? message.providerName.slice(0, 128) : 'provider';
    const instructions = typeof message.instructions === 'string' ? message.instructions.slice(0, 1000) : '';
    try {
      if (message.eventType === 'auth_url') {
        const uri = this.safeProviderUri(message.url);
        const action = await vscode.window.showInformationMessage(
          `${provider} sign-in${instructions ? `: ${instructions}` : ` is ready${uri ? ` at ${uri.authority}` : ''}.`}`,
          { modal: true },
          ...(uri ? ['Open sign-in page'] : []),
          'Cancel sign-in',
        );
        if (action === 'Open sign-in page' && uri) await vscode.env.openExternal(uri);
        else if (action === 'Cancel sign-in' || action === undefined) worker.postMessage({ type: 'cancelProviderLogin' });
        return;
      }
      if (message.eventType === 'device_code') {
        const uri = this.safeProviderUri(message.verificationUri);
        const code = typeof message.userCode === 'string' ? message.userCode.slice(0, 128) : '';
        const actions = [
          ...(uri ? ['Open verification page'] : []),
          ...(code ? ['Copy code'] : []),
          'Cancel sign-in',
        ];
        const action = await vscode.window.showInformationMessage(
          `${provider} sign-in${code ? `. Enter code ${code}` : ''}${uri ? ` at ${uri.authority}` : ''}.`,
          { modal: true },
          ...actions,
        );
        if (action === 'Open verification page' && uri) await vscode.env.openExternal(uri);
        else if (action === 'Copy code' && code) await vscode.env.clipboard.writeText(code);
        else if (action === 'Cancel sign-in' || action === undefined) worker.postMessage({ type: 'cancelProviderLogin' });
        return;
      }
      if (typeof message.message === 'string' && message.message) {
        this.post({ type: 'notice', message: `${provider}: ${message.message.slice(0, 1000)}` });
      }
    } catch (error) {
      this.post({ type: 'notice', message: `Provider sign-in interaction failed (${error instanceof Error ? error.name : 'error'}).`, isError: true });
      if (this.worker === worker) worker.postMessage({ type: 'cancelProviderLogin' });
    }
  }

  private async handleProjectTrustRequest(message: RuntimeMessage, worker: Worker): Promise<void> {
    if (this.worker !== worker || typeof message.requestId !== 'string' || message.requestId.length > 128) return;
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder || typeof message.cwd !== 'string' || !this.workerWorkspace
      || this.normalizeSessionPath(folder.uri.fsPath) !== this.normalizeSessionPath(this.workerWorkspace)
      || this.normalizeSessionPath(message.cwd) !== this.normalizeSessionPath(this.workerWorkspace)) {
      worker.postMessage({ type: 'extensionUiResponse', requestId: message.requestId, value: undefined });
      return;
    }
    const parent = path.dirname(folder.uri.fsPath);
    const options: Array<{ label: string; description: string; value: string }> = [
      { label: 'Trust this workspace', description: 'Remember this choice. Pi can load project settings, extensions, MCP servers, skills, prompts, and themes.', value: 'trust' },
      { label: 'Trust this workspace for this session only', description: 'Allow project resources for the current Pi session without saving a trust decision.', value: 'trust-session' },
    ];
    if (parent !== folder.uri.fsPath) {
      options.push({ label: 'Trust the parent folder', description: `Remember trust for ${parent}`, value: 'trust-parent' });
    }
    options.push(
      { label: 'Do not trust this workspace', description: 'Remember this choice and ignore project-local Pi resources.', value: 'deny' },
      { label: 'Do not trust for this session', description: 'Ignore project-local Pi resources in this session.', value: 'deny-session' },
    );
    try {
      const choice = await vscode.window.showQuickPick(options, {
        title: 'Trust Pi resources in this workspace?',
        placeHolder: folder.uri.fsPath,
        ignoreFocusOut: true,
      });
      if (this.worker === worker) {
        worker.postMessage({ type: 'extensionUiResponse', requestId: message.requestId, value: choice?.value });
      }
    } catch {
      if (this.worker === worker) worker.postMessage({ type: 'extensionUiResponse', requestId: message.requestId, value: undefined });
    }
  }

  private async handleMcpOpenUrl(message: RuntimeMessage, worker: Worker): Promise<void> {
    if (this.worker !== worker) return;
    const uri = this.safeProviderUri(message.url);
    if (!uri) {
      this.post({ type: 'notice', message: 'Pi MCP sign-in returned a URL that cannot be opened safely.', isError: true });
      return;
    }
    try {
      await vscode.env.openExternal(uri);
    } catch {
      this.post({ type: 'notice', message: 'Could not open the Pi MCP sign-in page.', isError: true });
    }
  }

  private async setMcpEnabled(message: RuntimeMessage): Promise<void> {
    if (typeof message.enabled !== 'boolean') return;
    const worker = this.worker;
    const current = vscode.workspace.getConfiguration('piChat').get<boolean>('mcp.enabled', false);
    if (!worker) {
      this.post({ type: 'mcp-setting-result', enabled: current, error: 'Open a Pi session before changing MCP settings.' });
      return;
    }
    if (this.pendingMcpSetting) return;
    if (message.enabled === current) {
      this.post({ type: 'mcp-setting-result', enabled: current });
      return;
    }
    if (message.enabled) {
      const answer = await vscode.window.showWarningMessage(
        'Connect enabled servers from the Pi MCP configuration? Stdio servers can launch local commands, and HTTP servers contact remote services. Project MCP configuration remains subject to Pi project trust.',
        { modal: true },
        'Connect MCP servers',
      );
      if (answer !== 'Connect MCP servers') {
        this.post({ type: 'mcp-setting-result', enabled: current });
        return;
      }
    }
    if (this.worker !== worker) {
      this.post({ type: 'mcp-setting-result', enabled: current, error: 'The Pi runtime changed. Try again.' });
      return;
    }
    const requestId = randomBytes(12).toString('hex');
    this.pendingMcpSetting = { worker, requestId, enabled: message.enabled, previous: current };
    this.post({ type: 'mcp-setting-pending' });
    worker.postMessage({ type: 'setMcpEnabled', enabled: message.enabled, requestId });
  }

  private recordDiagnostic(category: string): void {
    this.diagnosticEvents.push({ at: new Date().toISOString(), category });
    if (this.diagnosticEvents.length > 50) this.diagnosticEvents.splice(0, this.diagnosticEvents.length - 50);
  }

  private async handleMcpSettingResult(message: RuntimeMessage, worker: Worker): Promise<void> {
    const pending = this.pendingMcpSetting;
    if (!pending || pending.worker !== worker || pending.requestId !== message.requestId || this.worker !== worker) return;
    this.pendingMcpSetting = undefined;
    if (message.type === 'mcp-setting-failed') {
      this.post({
        type: 'mcp-setting-result',
        enabled: pending.previous,
        error: typeof message.message === 'string' ? message.message.slice(0, 300) : 'Pi could not apply the MCP setting.',
      });
      return;
    }
    try {
      await vscode.workspace.getConfiguration('piChat').update('mcp.enabled', pending.enabled, vscode.ConfigurationTarget.Global);
      this.post({ type: 'mcp-setting-result', enabled: pending.enabled });
    } catch {
      this.post({
        type: 'mcp-setting-result',
        enabled: pending.enabled,
        error: 'Could not save this choice in VS Code settings. The active session keeps the selected value until it closes.',
      });
    }
  }

  private safeProviderUri(value: unknown): vscode.Uri | undefined {
    if (typeof value !== 'string' || value.length > 2048) return undefined;
    try {
      const uri = vscode.Uri.parse(value, true);
      if (!uri.authority || uri.authority.includes('@')) return undefined;
      if (uri.scheme === 'https') return uri;
      if (uri.scheme === 'http' && /^(localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?$/i.test(uri.authority)) return uri;
      return undefined;
    } catch {
      return undefined;
    }
  }

  private async openModelsConfig(): Promise<void> {
    if (!this.modelsConfigPath || !path.isAbsolute(this.modelsConfigPath)) {
      this.post({ type: 'notice', message: 'Pi did not provide a custom models file path. Open a chat, then try again.', isError: true });
      return;
    }
    await this.openPiConfigFile(
      this.modelsConfigPath,
      'custom models file',
      `${JSON.stringify({ $schema: 'https://pi.dev/schemas/models.schema.json', providers: {} }, null, 2)}\n`,
      'Create Pi’s custom model configuration file? Pi reads provider endpoints and model definitions from this file. Values starting with ! may run a command when a provider is used.',
    );
  }

  private async openPiSettings(): Promise<void> {
    if (!this.settingsConfigPath || !path.isAbsolute(this.settingsConfigPath)) {
      this.post({ type: 'notice', message: 'Pi did not provide a settings file path. Open a chat, then try again.', isError: true });
      return;
    }
    await this.openPiConfigFile(
      this.settingsConfigPath,
      'settings file',
      '{}\n',
      'Create Pi’s settings file? This file changes Pi behavior for all sessions that use this configuration.',
    );
  }

  private async openMcpConfig(): Promise<void> {
    if (!this.mcpConfigPath || !path.isAbsolute(this.mcpConfigPath)) {
      this.post({ type: 'notice', message: 'Pi did not provide an MCP configuration path. Open a chat, then try again.', isError: true });
      return;
    }
    await this.openPiConfigFile(
      this.mcpConfigPath,
      'MCP configuration file',
      `${JSON.stringify({ mcpServers: {} }, null, 2)}\n`,
      'Create Pi’s MCP configuration file? Enabled stdio entries can launch local programs and HTTP entries can contact remote services when MCP is enabled in Pi Chat.',
    );
  }

  private async openPiConfigFile(filePath: string, label: string, initialContent: string, createPrompt: string): Promise<void> {
    try {
      try {
        await access(filePath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        const answer = await vscode.window.showWarningMessage(
          createPrompt,
          { modal: true },
          'Create and open',
        );
        if (answer !== 'Create and open') return;
        let file;
        try {
          file = await openFile(filePath, 'wx', 0o600);
          await file.writeFile(initialContent, 'utf8');
        } catch (createError) {
          if ((createError as NodeJS.ErrnoException).code !== 'EEXIST') throw createError;
        } finally {
          await file?.close();
        }
      }
      const document = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
      await vscode.window.showTextDocument(document, { preview: false });
    } catch (error) {
      this.post({ type: 'notice', message: `Could not open Pi’s ${label}. ${error instanceof Error ? error.message : ''}`, isError: true });
    }
  }

  private async createPromptTemplate(): Promise<void> {
    const workspace = vscode.workspace.workspaceFolders?.[0];
    if (!workspace) {
      this.post({ type: 'notice', message: 'Open a workspace before creating a project prompt template.' });
      return;
    }
    if (workspace.uri.scheme !== 'file') {
      this.post({ type: 'notice', message: 'Creating project prompt files is supported in local file workspaces.' });
      return;
    }
    const directory = vscode.Uri.joinPath(workspace.uri, '.pi', 'prompts');
    try {
      for (const part of ['.pi', path.join('.pi', 'prompts')]) {
        try {
          if ((await lstat(path.join(workspace.uri.fsPath, part))).isSymbolicLink()) {
            this.post({ type: 'notice', message: `The workspace prompt directory contains a symbolic link (${part}); no file was created.`, isError: true });
            return;
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
      }
      await vscode.workspace.fs.createDirectory(directory);
      const realWorkspaceRoot = await realpath(workspace.uri.fsPath);
      const realPromptDirectory = await realpath(directory.fsPath);
      const directoryRelative = path.relative(realWorkspaceRoot, realPromptDirectory);
      if (path.isAbsolute(directoryRelative) || directoryRelative === '..' || directoryRelative.startsWith(`..${path.sep}`)) {
        this.post({ type: 'notice', message: 'The workspace prompt directory resolves outside the workspace.', isError: true });
        return;
      }
      const name = await vscode.window.showInputBox({
        prompt: 'Name the project prompt template',
        placeHolder: 'review-change',
        validateInput: (value) => /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(value.trim())
          ? undefined
          : 'Use 1–64 letters, numbers, dots, underscores, or hyphens; begin with a letter or number.',
      });
      if (!name?.trim()) return;
      const filePath = path.join(directory.fsPath, `${name.trim()}.md`);
      const content = [
        '---',
        'description: Describe what this prompt does',
        'argument-hint: <arguments>',
        '---',
        '',
        'Write the prompt here. Use $ARGUMENTS for all supplied arguments, or $1, $2, and so on for positional arguments.',
        '',
      ].join('\n');
      let file;
      try {
        file = await openFile(filePath, 'wx');
        const realParentAfterOpen = await realpath(path.dirname(filePath));
        const normalizeForComparison = (value: string) => process.platform === 'win32' ? value.toLocaleLowerCase() : value;
        if (normalizeForComparison(realParentAfterOpen) !== normalizeForComparison(realPromptDirectory)) {
          this.post({ type: 'notice', message: 'The prompt directory changed while creating the file; no template content was written.', isError: true });
          return;
        }
        await file.writeFile(content, 'utf8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
          this.post({ type: 'notice', message: 'That file already exists; it was not overwritten.' });
          return;
        }
        throw error;
      } finally {
        await file?.close();
      }
      this.knownPromptPaths.add(this.normalizeSessionPath(filePath));
      const document = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
      await vscode.window.showTextDocument(document, { preview: false });
      this.post({ type: 'notice', message: 'Prompt template created. Use Reload resources after saving it to load the new template.' });
    } catch (error) {
      this.post({ type: 'notice', message: `Could not create the prompt template. ${error instanceof Error ? error.message : ''}`, isError: true });
    }
  }

  private async reorderPresets(message: RuntimeMessage): Promise<void> {
    if (!Array.isArray(message.ids)) return;
    const presets = this.context.workspaceState.get<ModelPreset[]>('piChat.modelPresets', []);
    const byId = new Map(presets.map((preset) => [preset.id, preset]));
    const reordered = message.ids
      .filter((id): id is string => typeof id === 'string')
      .map((id) => byId.get(id))
      .filter((preset): preset is ModelPreset => Boolean(preset));
    for (const preset of presets) if (!reordered.includes(preset)) reordered.push(preset);
    await this.context.workspaceState.update('piChat.modelPresets', reordered);
    this.post({ type: 'presets', presets: reordered });
  }

  private async handleSessionExport(message: RuntimeMessage): Promise<void> {
    if (typeof message.path !== 'string') return;
    const uri = vscode.Uri.file(message.path);
    if (message.format === 'html') {
      await vscode.env.openExternal(uri);
    } else {
      const action = await vscode.window.showInformationMessage(`Pi session exported to ${message.path}`, 'Open file');
      if (action === 'Open file') await vscode.commands.executeCommand('vscode.open', uri);
    }
  }

  private async showChatNotification(message: string): Promise<void> {
    const action = await vscode.window.showInformationMessage(message, 'Open Pi Chat');
    if (action === 'Open Pi Chat') await vscode.commands.executeCommand('workbench.view.extension.piChat');
  }

  private imageMimeType(filePath: string): string | undefined {
    const extension = path.extname(filePath).toLowerCase();
    return extension === '.png' ? 'image/png'
      : extension === '.jpg' || extension === '.jpeg' ? 'image/jpeg'
        : extension === '.webp' ? 'image/webp'
          : extension === '.gif' ? 'image/gif'
            : undefined;
  }

  private formatFileContext(relativePath: string, text: string, lineSuffix = ''): string {
    const content = text.length > MAX_ATTACHMENT_CHARS
      ? `${text.slice(0, MAX_ATTACHMENT_CHARS)}\n[truncated after ${MAX_ATTACHMENT_CHARS.toLocaleString()} characters]`
      : text;
    return `@${relativePath}${lineSuffix}\n${content}`;
  }

  private workspaceRelativePath(uri: vscode.Uri, folder: vscode.WorkspaceFolder): string | undefined {
    return this.relativePathFrom(folder.uri, uri);
  }

  private relativePathFrom(root: vscode.Uri, uri: vscode.Uri): string | undefined {
    if (uri.scheme !== root.scheme) return undefined;
    const relative = path.relative(root.fsPath, uri.fsPath);
    if (path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`)) return undefined;
    return relative.replaceAll(path.sep, '/');
  }

  private normalizeSessionPath(value: string): string {
    const resolved = path.resolve(value);
    return process.platform === 'win32' ? resolved.toLocaleLowerCase() : resolved;
  }

  private isKnownSessionPath(value: unknown): value is string {
    if (typeof value !== 'string' || value.length > 4096) return false;
    try {
      return this.knownSessionPaths.has(this.normalizeSessionPath(value));
    } catch {
      return false;
    }
  }

  private composePrompt(text: string, attachments: Attachment[]): string {
    const safeAttachments = attachments.filter(
      (item): item is Attachment => Boolean(item && typeof item.context === 'string' && typeof item.path === 'string'),
    );
    if (safeAttachments.length === 0) return text;

    const context = safeAttachments.map((item) => item.context).filter(Boolean).join('\n\n');
    if (!context) return text;
    const contextBlock = `--- pi-extension-context:start ---\n<workspace-context>\n${context}\n</workspace-context>\n--- pi-extension-context:end ---`;
    // Pi recognizes slash commands only at the beginning of a prompt. Keep that
    // command first so skill and prompt-template expansion still runs.
    return text.startsWith('/') ? `${text}\n\n${contextBlock}` : `${contextBlock}\n\n${text}`;
  }

  private validateAttachments(value: unknown): Attachment[] {
    if (!Array.isArray(value)) return [];
    const accepted: Attachment[] = [];
    let contextBytes = 0;
    let imageChars = 0;
    let imageCount = 0;
    const allowedImageTypes = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
    for (const candidate of value.slice(0, 32)) {
      if (!candidate || typeof candidate !== 'object') continue;
      const item = candidate as Record<string, unknown>;
      if (typeof item.path !== 'string' || item.path.length > 2048) continue;
      const context = typeof item.context === 'string' ? item.context.slice(0, MAX_ATTACHMENT_CHARS) : '';
      const label = typeof item.label === 'string' ? item.label.slice(0, 160) : path.basename(item.path).slice(0, 160);
      const attachment: Attachment = {
        id: typeof item.id === 'string' && item.id.length <= 100 ? item.id : randomBytes(8).toString('hex'),
        path: item.path,
        label,
        context,
      };
      const rawImage = item.image;
      if (rawImage && typeof rawImage === 'object') {
        const image = rawImage as Record<string, unknown>;
        if (typeof image.data === 'string' && image.data.length <= 7_000_000
          && /^[A-Za-z0-9+/]*={0,2}$/.test(image.data)
          && typeof image.mimeType === 'string' && allowedImageTypes.has(image.mimeType)
          && imageCount < 5 && imageChars + image.data.length <= 35_000_000) {
          attachment.image = { data: image.data, mimeType: image.mimeType };
          imageCount += 1;
          imageChars += image.data.length;
        }
      }
      if (!context && !attachment.image) continue;
      if (contextBytes + context.length > 120_000) attachment.context = '';
      else contextBytes += context.length;
      if (!attachment.context && !attachment.image) continue;
      accepted.push(attachment);
      if (accepted.length >= 20) break;
    }
    return accepted;
  }

  private async collectAutomaticContext(attachedPaths: Set<string> = new Set()): Promise<Attachment[]> {
    const settings = vscode.workspace.getConfiguration('piChat.context');
    const editor = vscode.window.activeTextEditor;
    const workspace = vscode.workspace.workspaceFolders?.[0];
    if (!workspace) return [];
    const attachments: Attachment[] = [];
    const followSelection = settings.get<boolean>('followSelection', true);
    const followActiveFile = settings.get<boolean>('followActiveFile', false);
    if (editor) {
      const relativePath = this.workspaceRelativePath(editor.document.uri, workspace);
      if (relativePath) {
        const comparablePath = process.platform === 'win32' ? relativePath.toLocaleLowerCase() : relativePath;
        const isAlreadyAttached = attachedPaths.has(comparablePath);
        if (!isAlreadyAttached && followSelection && !editor.selection.isEmpty) {
          const start = editor.selection.start.line + 1;
          const end = Math.max(start, editor.selection.end.line + (editor.selection.end.character === 0 ? 0 : 1));
          attachments.push({
            id: randomBytes(8).toString('hex'),
            label: `${path.basename(relativePath)} · lines ${start}-${end}`,
            path: relativePath,
            context: `@${relativePath}:${start}-${end}`,
          });
        } else if (!isAlreadyAttached && followActiveFile) {
          attachments.push({
            id: randomBytes(8).toString('hex'),
            label: `${path.basename(relativePath)} · active file`,
            path: relativePath,
            context: `@${relativePath}`,
          });
        }
        if (settings.get<boolean>('includeDiagnostics', false)) {
          const diagnostics = this.createDiagnosticsAttachment(editor.document.uri, workspace);
          if (diagnostics) attachments.push(diagnostics);
        }
      }
    }
    if (settings.get<boolean>('includeGitStatus', false)) {
      try {
        const gitStatus = await this.createGitStateAttachment(workspace);
        if (gitStatus) attachments.push(gitStatus);
      } catch {
        // Automatic context is optional; manual Git attachment reports errors.
      }
    }
    return attachments.slice(0, 8);
  }

  private post(message: RuntimeMessage): void {
    const webview = this.view?.webview;
    if (webview) void webview.postMessage(message);
  }

  private stopWorker(worker: Worker): void {
    if (worker.threadId === -1) return;
    try {
      worker.postMessage({ type: 'dispose' });
    } catch {
      void worker.terminate();
      return;
    }
    const timeout = setTimeout(() => { void worker.terminate(); }, 5000);
    timeout.unref?.();
    worker.once('exit', () => clearTimeout(timeout));
  }

  private failPendingMcpSetting(worker?: Worker): void {
    const pending = this.pendingMcpSetting;
    if (!pending || (worker && pending.worker !== worker)) return;
    this.pendingMcpSetting = undefined;
    this.post({ type: 'mcp-setting-result', enabled: pending.previous, error: 'The Pi runtime stopped before the MCP setting was applied.' });
  }

  private getHtml(webview: vscode.Webview): string {
    const nonce = randomBytes(16).toString('base64');
    const cssUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'chat.css'));
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'chat.js'));
    const csp = [
      "default-src 'none'",
      `style-src ${webview.cspSource}`,
      `script-src 'nonce-${nonce}' ${webview.cspSource}`,
      `img-src ${webview.cspSource} data:`,
      `font-src ${webview.cspSource}`,
    ].join('; ');

    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <link rel="stylesheet" href="${cssUri}">
  <title>Pi Chat</title>
</head>
<body>
  <div class="layout">
    <nav class="rail" aria-label="Pi chat navigation">
      <button id="new-session" class="rail-button prominent" type="button" title="New chat" aria-label="New chat">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>
      </button>
      <button id="history-toggle" class="rail-button" type="button" title="Recent sessions" aria-label="Recent sessions" aria-expanded="false">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h16M4 12h16M4 18h11"/><circle cx="19" cy="18" r="2"/></svg>
      </button>
      <div id="rail-sessions" class="rail-sessions" aria-label="Recent sessions"></div>
      <div class="rail-spacer"></div>
      <div class="rail-mark" aria-label="Pi"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 6h14M9 6v12M15 6v12M15 6h4"/></svg></div>
    </nav>

    <section class="main-panel" aria-label="Pi chat">
      <header class="topbar">
        <div class="title-stack">
          <div id="conversation-title" class="conversation-title">New chat</div>
          <div id="workspace-name" class="workspace-name">Waiting for workspace</div>
        </div>
        <button id="rename-session" class="icon-button" type="button" title="Rename session" aria-label="Rename session">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m4 16.5-.8 4.3 4.3-.8L19.8 7.7a2.8 2.8 0 0 0-4-4L4 16.5Z"/><path d="m14.5 5.5 4 4"/></svg>
        </button>
        <button id="branch-history-toggle" class="icon-button" type="button" title="Branch history" aria-label="Branch history" aria-expanded="false">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 4v11a4 4 0 0 0 4 4h8"/><path d="m14 15 4 4-4 4M6 4a2 2 0 1 0 0 .1M18 19a2 2 0 1 0 0 .1"/></svg>
        </button>
        <button id="chat-search-toggle" class="icon-button" type="button" title="Search this chat" aria-label="Search this chat" aria-expanded="false">
          <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.8" cy="10.8" r="6.8"/><path d="m16 16 4.5 4.5"/></svg>
        </button>
        <button id="git-review-toggle" class="icon-button" type="button" title="Review Git changes" aria-label="Review Git changes" aria-expanded="false" disabled>
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 3v12a4 4 0 0 0 4 4h8"/><path d="m14 15 4 4-4 4"/><circle cx="6" cy="3" r="2"/></svg>
        </button>
        <button id="bookmark-toggle" class="text-button header-action" type="button" title="Show bookmarked messages" aria-expanded="false">★</button>
        <button id="export-session" class="text-button header-action" type="button" title="Export session">Export</button>
        <button id="open-settings" class="icon-button" type="button" title="Pi Chat settings" aria-label="Pi Chat settings">
          <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="m19.4 15 .1.1a1.8 1.8 0 1 1-2.5 2.5l-.1-.1a1.8 1.8 0 0 0-3 1.3v.2a1.8 1.8 0 1 1-3.6 0v-.2a1.8 1.8 0 0 0-3-1.3l-.1.1a1.8 1.8 0 1 1-2.5-2.5l.1-.1a1.8 1.8 0 0 0-1.3-3h-.2a1.8 1.8 0 1 1 0-3.6h.2a1.8 1.8 0 0 0 1.3-3l-.1-.1a1.8 1.8 0 1 1 2.5-2.5l.1.1a1.8 1.8 0 0 0 3-1.3v-.2a1.8 1.8 0 1 1 3.6 0v.2a1.8 1.8 0 0 0 3 1.3l.1-.1a1.8 1.8 0 1 1 2.5 2.5l-.1.1a1.8 1.8 0 0 0 1.3 3h.2a1.8 1.8 0 1 1 0 3.6h-.2a1.8 1.8 0 0 0-1.3 3Z"/></svg>
        </button>
        <button id="refresh-sessions" class="icon-button" type="button" title="Refresh sessions" aria-label="Refresh sessions">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 11a8 8 0 0 0-14.8-3L4 10M4 5v5h5M4 13a8 8 0 0 0 14.8 3L20 14m0 5v-5h-5"/></svg>
        </button>
      </header>

      <div id="chat-search-bar" class="chat-search-bar" hidden>
        <input id="chat-search-input" class="session-search" type="search" aria-label="Find in this conversation" placeholder="Find in this conversation">
        <span id="chat-search-count" class="chat-search-count" aria-live="polite"></span>
        <button id="chat-search-prev" class="icon-button small" type="button" title="Previous match" aria-label="Previous match">↑</button>
        <button id="chat-search-next" class="icon-button small" type="button" title="Next match" aria-label="Next match">↓</button>
        <button id="chat-search-close" class="icon-button small" type="button" title="Close search" aria-label="Close search">×</button>
      </div>

      <aside id="bookmark-panel" class="history-panel bookmark-panel" aria-label="Bookmarks" hidden>
        <div class="history-heading"><span>Bookmarks</span><button id="close-bookmarks" class="icon-button small" type="button" title="Close" aria-label="Close bookmarks">×</button></div>
        <div id="bookmark-list" class="session-list"></div>
        <div id="bookmark-empty" class="session-empty">Bookmark a message to find it here.</div>
      </aside>

      <aside id="history-panel" class="history-panel" aria-label="Recent sessions" hidden>
        <div class="history-heading"><span>Recent sessions</span><button id="close-history" class="icon-button small" type="button" title="Close" aria-label="Close recent sessions"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg></button></div>
        <input id="session-search" class="session-search" type="search" aria-label="Search sessions" placeholder="Search chats and messages">
        <div id="session-list" class="session-list"></div>
        <div id="session-empty" class="session-empty" hidden>No matching sessions.</div>
      </aside>
      <aside id="branch-panel" class="history-panel branch-panel" aria-label="Branch history" hidden>
        <div class="history-heading"><span>Branch history</span><button id="close-branches" class="icon-button small" type="button" title="Close" aria-label="Close branch history"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg></button></div>
        <div id="branch-list" class="session-list"></div>
        <div id="branch-empty" class="session-empty" hidden>No user messages to branch from.</div>
      </aside>
      <aside id="queue-panel" class="history-panel queue-panel" aria-label="Queued messages" hidden>
        <div class="history-heading"><span>Queued messages</span><button id="clear-queue" class="text-button" type="button">Clear all</button><button id="close-queue" class="icon-button small" type="button" title="Close" aria-label="Close queued messages">×</button></div>
        <div id="queue-list" class="session-list"></div>
        <div id="queue-empty" class="session-empty">No queued messages.</div>
      </aside>
      <aside id="git-review-panel" class="history-panel git-review-panel" aria-label="Git changes" hidden>
        <div class="history-heading"><span>Git changes</span><div class="git-review-actions"><button id="quote-git-diff-selection" class="text-button" type="button" title="Attach selected lines from the open Git diff">Quote selection</button><button id="refresh-git-changes" class="icon-button small" type="button" title="Refresh Git changes" aria-label="Refresh Git changes">↻</button><button id="close-git-review" class="icon-button small" type="button" title="Close" aria-label="Close Git changes">×</button></div></div>
        <div id="git-change-summary" class="git-change-summary">Checking workspace…</div>
        <div class="git-draft-actions"><button id="draft-git-commit" class="text-button" type="button" disabled>Draft commit message</button><button id="draft-git-pr" class="text-button" type="button" disabled>Draft PR description</button></div>
        <div id="git-change-list" class="session-list"></div>
        <div id="git-change-empty" class="session-empty" hidden>No Git changes in this workspace.</div>
      </aside>

      <div id="notice" class="notice" role="status" aria-live="polite" hidden></div>
      <div id="extension-widgets" class="extension-widgets" aria-label="Pi extension widgets"></div>
      <section id="extension-dialog-layer" class="extension-dialog-layer" aria-label="Pi extension dialog" hidden>
        <div class="extension-dialog" role="dialog" aria-modal="true">
          <h2 id="extension-dialog-title"></h2>
          <p id="extension-dialog-message"></p>
          <div id="extension-dialog-options" class="extension-dialog-options"></div>
          <textarea id="extension-dialog-input" rows="4" hidden></textarea>
          <div class="extension-dialog-actions">
            <button id="extension-dialog-cancel" class="text-button" type="button">Cancel</button>
            <button id="extension-dialog-submit" class="send-button" type="button">Continue</button>
          </div>
        </div>
      </section>
      <section id="prompt-template-layer" class="extension-dialog-layer prompt-template-layer" aria-label="Prompt template form" hidden>
        <div class="extension-dialog prompt-template-dialog" role="dialog" aria-modal="true" aria-labelledby="prompt-template-title">
          <h2 id="prompt-template-title">Prompt template</h2>
          <p id="prompt-template-description"></p>
          <div id="prompt-template-fields" class="prompt-template-fields"></div>
          <details class="prompt-template-preview" open><summary>Preview</summary><pre id="prompt-template-preview"></pre></details>
          <div class="extension-dialog-actions">
            <button id="prompt-template-cancel" class="text-button" type="button">Cancel</button>
            <button id="prompt-template-use" class="send-button" type="button">Use template</button>
          </div>
        </div>
      </section>
      <main id="messages" class="messages" aria-live="polite" aria-relevant="additions text">
        <div id="empty-state" class="empty-state">
          <div class="empty-mark" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M4 6h16M9 6v12M15 6v12M15 6h5"/></svg></div>
          <h1>What can Pi help with?</h1>
          <p>Ask a question or give Pi a task in this workspace.</p>
          <div class="suggestions" aria-label="Suggested prompts">
            <button type="button" data-prompt="Give me a quick map of this project and its main entry points.">Map this project</button>
            <button type="button" data-prompt="Explain the current file and call out anything surprising.">Explain the current file</button>
            <button type="button" data-prompt="Help me find and fix a bug in this workspace.">Help debug</button>
          </div>
        </div>
        <div id="message-list" class="message-list"></div>
        <div id="activity" class="activity" hidden>
          <span class="spinner" aria-hidden="true"></span>
          <span id="activity-text">Pi is working</span>
          <button id="queue-toggle" class="queue-toggle" type="button" aria-expanded="false">Queue</button>
          <button id="stop" class="stop-button" type="button">Stop</button>
        </div>
      </main>

      <footer class="composer-wrap">
        <div id="attachments" class="attachments" aria-label="Attached workspace context"></div>
        <div id="mention-panel" class="mention-panel" role="listbox" aria-label="Workspace files" hidden></div>
        <div class="composer">
          <div id="model-presets" class="model-presets" aria-label="Model presets"></div>
          <div class="composer-controls" aria-label="Session controls">
            <button id="model-toggle" class="control-button model-toggle" type="button" aria-expanded="false" aria-label="Choose model" title="Choose model" disabled>Choose model</button>
            <select id="thinking-choice" class="control-select thinking-select" aria-label="Reasoning level" title="Reasoning level" hidden disabled></select>
            <button id="tools-toggle" class="control-button" type="button" aria-expanded="false" disabled>Tools</button>
            <button id="skills-toggle" class="control-button" type="button" aria-expanded="false" disabled>Resources</button>
            <button id="delivery-mode" class="control-button delivery-mode" type="button" aria-label="Queued message mode" title="Click to switch between queue and steer" hidden>Queue next</button>
            <section id="model-popover" class="control-popover model-popover" aria-label="Choose a model" hidden>
              <div class="model-search-row"><input id="model-search" class="session-search" type="search" aria-label="Search models" placeholder="Search models, providers, or vision"><button id="refresh-models" class="icon-button small" type="button" title="Refresh models; may contact providers and run configured API-key commands" aria-label="Refresh model catalog"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 11a8 8 0 0 0-14.8-3L4 10M4 5v5h5M4 13a8 8 0 0 0 14.8 3L20 14m0 5v-5h-5"/></svg></button></div>
              <div class="provider-actions"><span id="provider-status" class="provider-status"></span><button id="connect-provider" class="text-button" type="button">Connect</button><button id="runtime-settings-toggle" class="text-button" type="button" aria-expanded="false">Runtime</button><button id="edit-models-config" class="text-button" type="button" title="Edit Pi's custom models and providers">Models</button><button id="edit-pi-settings" class="text-button" type="button" title="Open Pi's user settings">Pi settings</button></div>
              <section id="runtime-settings" class="runtime-settings" aria-label="Pi runtime settings" hidden>
                <div class="popover-heading"><strong>Pi runtime settings</strong><span>Saved in global Pi settings</span></div>
                <label class="runtime-setting"><input id="auto-compaction" type="checkbox"><span>Automatic context compaction</span></label>
                <label class="runtime-setting"><input id="auto-retry" type="checkbox"><span>Automatic retry</span></label>
                <label class="runtime-setting cache-warming-setting" for="cache-warming"><span>Cache warming</span><select id="cache-warming"><option value="off">Off</option><option value="streaming">While streaming</option><option value="idle">Between runs</option></select></label>
                <p class="runtime-settings-note">These choices affect Pi sessions using your global settings. Cache warming sends extra provider requests and may cost money.</p>
                <div class="popover-heading extension-command-heading"><strong>MCP servers</strong><span>Configured connections are off until you enable them here</span></div>
                <label class="runtime-setting"><input id="mcp-enabled" type="checkbox"><span>Connect configured MCP servers</span></label>
                <button id="edit-mcp-config" class="text-button" type="button">Open global mcp.json</button>
                <p class="runtime-settings-note">Enabled stdio entries can launch local programs; HTTP entries contact remote services. Pi’s project trust rules still apply. Use <code>/mcp</code> to inspect connections and sign in; edit the file and reload resources to change server settings.</p>
                <button id="export-diagnostics" class="text-button" type="button">Export redacted diagnostic report</button>
                <p class="runtime-settings-note">The report includes versions and generic error categories. It omits prompts, paths, file names, provider IDs, credentials, and environment variables.</p>
              </section>
              <div id="model-list" class="option-list" role="listbox" aria-label="Available models"></div>
            </section>
            <section id="tools-popover" class="control-popover tools-popover" aria-label="Tools for this chat" hidden>
              <div class="popover-heading"><strong>Tools for this chat</strong><span>Changes apply to the next turn</span></div>
              <div class="tool-presets">
                <button type="button" data-tool-preset="default">Pi defaults</button>
                <button type="button" data-tool-preset="readonly">Read-only</button>
                <button type="button" data-tool-preset="none">None</button>
              </div>
              <div id="tool-list" class="option-list"></div>
            </section>
            <section id="skills-popover" class="control-popover skills-popover" aria-label="Skills and prompt templates" hidden>
              <div class="popover-heading"><strong>Skills</strong><span>Insert a slash command into the message</span></div>
              <div id="skill-list" class="option-list"></div>
              <div class="popover-heading extension-command-heading"><strong>Extension commands</strong><span>Suggestions call extension code and only fill the composer</span></div>
              <div id="extension-command-list" class="option-list"></div>
              <div id="extension-command-suggestions" class="extension-command-suggestions" aria-live="polite" hidden></div>
              <div class="popover-heading prompt-heading"><strong>Prompt templates</strong><div class="prompt-heading-actions"><button id="new-prompt-template" class="text-button" type="button" title="Create a project prompt template">New</button><button id="reload-pi-resources" class="text-button" type="button" title="Reload extensions, skills, prompts, and themes">Reload</button></div></div>
              <div id="prompt-list" class="option-list"></div>
              <div id="resource-diagnostics" class="resource-diagnostics"></div>
              <div class="package-heading"><strong>Pi packages</strong><div class="package-heading-actions"><button id="refresh-packages" class="text-button" type="button" title="Refresh the configured package list">Refresh</button><button id="update-packages" class="text-button" type="button" title="Update configured packages">Update all</button></div></div>
              <div class="package-install-form"><input id="package-source" type="text" maxlength="512" aria-label="Package source" placeholder="npm:@scope/package or git:host/path"><select id="package-scope" aria-label="Package installation scope"><option value="user">User</option><option value="project">Project</option></select><button id="install-package" class="text-button" type="button">Install</button></div>
              <p class="package-safety-note">Review package sources before installing. Package managers may run code, and enabled extensions can execute inside Pi. Project scope requires workspace trust.</p>
              <div id="package-status" class="package-status" aria-live="polite"></div>
              <div id="package-list" class="package-list"></div>
              <div id="package-empty" class="package-empty">Package manager is unavailable until a Pi session is ready.</div>
            </section>
          </div>
          <textarea id="prompt" rows="1" aria-label="Message Pi" placeholder="Ask Pi anything"></textarea>
          <div class="composer-bottom">
            <div class="composer-actions">
              <button id="attach-file" class="icon-button small" type="button" title="Attach a file" aria-label="Attach a file">
                <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 12.5 6.3-6.3a3.2 3.2 0 0 1 4.5 4.5L11 19.5a5 5 0 0 1-7.1-7.1l8.4-8.5"/></svg>
              </button>
              <button id="attach-editor" class="text-button" type="button">Add editor context</button>
              <button id="pin-active-file" class="text-button" type="button" aria-pressed="false" title="Keep the active file or selected line range attached until you remove it">Pin active file</button>
              <button id="attach-range" class="text-button" type="button" title="Attach a line range from the active file">Lines</button>
              <button id="attach-folder" class="text-button" type="button" title="Attach a folder">Folder</button>
              <button id="attach-diagnostics" class="text-button" type="button" title="Attach problems from the active file">Problems</button>
              <button id="attach-git" class="text-button" type="button" title="Attach Git status">Git</button>
            </div>
            <button id="send" class="send-button" type="button" title="Send message" aria-label="Send message">
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 19V5m-6 6 6-6 6 6"/></svg>
            </button>
          </div>
        </div>
        <div id="context-meter" class="context-meter" role="meter" aria-label="Pi context usage" aria-valuemin="0" aria-valuemax="100" hidden>
          <span id="context-meter-fill" class="context-meter-fill"></span>
          <span id="context-meter-label" class="context-meter-label"></span>
          <button id="compact-session" class="context-meter-action" type="button" hidden>Compact</button>
        </div>
        <div class="composer-note"><span>Pi uses your existing configuration</span><span id="extension-status" class="extension-status"></span><span id="session-usage" aria-label="Session token and cost usage"></span><span id="model-label"></span></div>
      </footer>
    </section>
  </div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}
