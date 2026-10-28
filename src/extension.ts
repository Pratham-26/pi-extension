import * as vscode from 'vscode';
import * as path from 'node:path';
import { access, lstat, open as openFile, realpath } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { Worker } from 'node:worker_threads';

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

const VIEW_ID = 'piChat.chatView';
const MAX_ATTACHMENT_BYTES = 1024 * 1024;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_ATTACHMENT_CHARS = 40_000;

export function activate(context: vscode.ExtensionContext): void {
  const provider = new PiChatViewProvider(context);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(VIEW_ID, provider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.commands.registerCommand('piChat.newSession', () => provider.newSession()),
    vscode.commands.registerCommand('piChat.cloneSession', () => provider.cloneSession()),
    vscode.commands.registerCommand('piChat.openSettings', () => vscode.commands.executeCommand('workbench.action.openSettings', '@ext:local.pi-chat-vscode')),
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
  private knownSessionPaths = new Set<string>();
  private knownPromptPaths = new Set<string>();
  private knownResourcePaths = new Set<string>();
  private availableProviders: ProviderSetup[] = [];
  private modelsConfigPath = '';
  private settingsConfigPath = '';
  private providerAuthPromptCancels = new Map<string, { worker: Worker; cancel: () => void }>();
  private activeEditorSubscription: vscode.Disposable;
  private selectionSubscription: vscode.Disposable;
  private pinnedActiveFileEnabled: boolean;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.pinnedActiveFileEnabled = context.workspaceState.get<boolean>('piChat.context.pinnedActiveFile', false);
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
    if (worker) void worker.terminate();
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
    if (!this.worker) await this.ensureRuntime();
    this.worker?.postMessage({ type: 'newSession' });
  }

  async cloneSession(): Promise<void> {
    if (!this.worker) await this.ensureRuntime();
    this.worker?.postMessage({ type: 'cloneSession' });
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
    this.activeSessionPath = '';
    if (previous) void previous.terminate();
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
    if (previous) void previous.terminate();
    this.knownSessionPaths.clear();
    this.knownPromptPaths.clear();
    this.knownResourcePaths.clear();
    this.availableProviders = [];
    this.modelsConfigPath = '';
    this.settingsConfigPath = '';
    this.activeSessionPath = '';

    this.workerWorkspace = cwd;
    const workerUri = vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'pi-worker.mjs');
    const worker = new Worker(workerUri.fsPath, { workerData: { cwd } });
    this.worker = worker;
    worker.on('message', (message: RuntimeMessage) => {
      if (this.worker !== worker) return;
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
        const { modelsConfigPath: _modelsConfigPath, settingsConfigPath: _settingsConfigPath, ...safeMessage } = message;
        this.post({ ...safeMessage, presets: this.context.workspaceState.get<ModelPreset[]>('piChat.modelPresets', []) });
      } else {
        this.post(message);
      }
    });
    worker.on('error', (error: Error) => {
      if (this.worker === worker) {
        this.post({ type: 'runtime-error', message: error.message || 'The Pi runtime stopped unexpectedly.' });
      }
    });
    worker.on('exit', (code: number) => {
      if (this.worker === worker) {
        this.worker = undefined;
        this.cancelProviderAuthPrompts(worker);
      }
      if (this.workerWorkspace === cwd && code !== 0) {
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
        this.publishPinnedActiveFile();
        return;
      case 'newSession':
        await this.newSession();
        return;
      case 'cloneSession':
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
        if (this.isKnownSessionPath(message.path)) this.worker?.postMessage({ type: 'openSession', path: message.path });
        else this.post({ type: 'notice', message: 'That session is not in the current workspace session list.', isError: true });
        return;
      case 'stop':
        this.worker?.postMessage({ type: 'stop' });
        return;
      case 'send': {
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
    const extension = vscode.extensions.getExtension('vscode.git');
    if (!extension) throw new Error('The built-in Git extension is unavailable.');
    const git = extension.isActive ? extension.exports : await extension.activate();
    const api = git.getAPI(1);
    const repository = api.repositories.find((item: any) => this.workspaceRelativePath(item.rootUri, workspace) !== undefined);
    if (!repository) return undefined;
    const state = repository.state;
    const names = (changes: any[]) => changes.slice(0, 100).map((change) => {
      const uri = change.uri ?? change.resourceUri;
      return uri ? this.workspaceRelativePath(uri, workspace) : undefined;
    }).filter(Boolean);
    const branch = String(state.HEAD?.name ?? '(detached HEAD)').slice(0, 200);
    const upstream = state.HEAD?.upstream ? `\nUpstream: ${String(state.HEAD.upstream).slice(0, 200)}` : '';
    const commits = state.HEAD?.ahead !== undefined || state.HEAD?.behind !== undefined
      ? `\nAhead: ${Number(state.HEAD.ahead) || 0}; behind: ${Number(state.HEAD.behind) || 0}`
      : '';
    const index = names(state.indexChanges ?? []);
    const working = names(state.workingTreeChanges ?? []);
    const conflicts = names(state.mergeChanges ?? []);
    const context = [
      `Branch: ${branch}${upstream}${commits}`,
      `Staged (${state.indexChanges?.length ?? 0}): ${index.join(', ') || 'none'}`,
      `Unstaged (${state.workingTreeChanges?.length ?? 0}): ${working.join(', ') || 'none'}`,
      `Conflicts (${state.mergeChanges?.length ?? 0}): ${conflicts.join(', ') || 'none'}`,
    ].join('\n');
    return {
      id: randomBytes(8).toString('hex'),
      label: 'Git status',
      path: workspace.name,
      context: `Git workspace state:\n${context}`.slice(0, MAX_ATTACHMENT_CHARS),
    };
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
    if (uri.scheme !== folder.uri.scheme) return undefined;
    const relative = path.relative(folder.uri.fsPath, uri.fsPath);
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
            <button id="skills-toggle" class="control-button" type="button" aria-expanded="false" disabled>Skills / prompts</button>
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
        <div class="composer-note"><span>Pi uses your existing configuration</span><span id="extension-status" class="extension-status"></span><span id="model-label"></span></div>
      </footer>
    </section>
  </div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}
