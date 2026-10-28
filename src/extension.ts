import * as vscode from 'vscode';
import * as path from 'node:path';
import { homedir } from 'node:os';
import { access, lstat, mkdir, open as openFile, opendir, readFile, realpath, rename, unlink, writeFile } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { applyEdits, modify, parse, type ParseError } from 'jsonc-parser';
import { isPiPackageSource } from './package-source';
import * as draftStore from './draft-store';
import { appendDiagnosticLog, DIAGNOSTIC_LOG_FILENAME, type DiagnosticCategory } from './diagnostic-log';
import {
  copyIgnoredFileSafely,
  isPathInside,
  isSafeRepositoryRelativePath,
  listGitWorktrees,
  listIgnoredFileChoices,
  runGitCommand,
  MAX_IGNORED_COPY_BYTES,
  MAX_IGNORED_FILES_FOR_PICKER,
  type GitCommandResult,
  type GitWorktreeEntry,
  type IgnoredFileChoice,
  type IgnoredFileListing,
} from './git-worktree-files';
import { sortSessionItems } from './session-order';

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

type McpServerChoice = {
  name: string;
  enabled: boolean;
  exposure: 'codemode' | 'deferred' | 'direct' | 'hidden';
  scope: 'global' | 'project';
  hasOverride: boolean;
  transport: 'stdio' | 'http' | 'unknown';
  globalEnabled?: boolean;
  globalExposure?: 'codemode' | 'deferred' | 'direct' | 'hidden';
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
  git?: { path?: string };
  repositories: GitRepositoryLike[];
};

type GitFileStatus = {
  path: string;
  status: string[];
  canDiscard: boolean;
  isUntracked: boolean;
  canMoveToTrash: boolean;
};

type PiResourceType = 'extensions' | 'skills' | 'prompts' | 'themes';

type PiResourceChoice = vscode.QuickPickItem & {
  id: string;
  type: PiResourceType;
  scope: 'user' | 'project';
  enabled: boolean;
};

type PiOfflineMode = 'inherit' | 'offline' | 'online';
type PiExtensionUiMode = 'rpc' | 'tui';
type PiExtensionStatusDisplay = 'footer' | 'statusBar' | 'both' | 'hidden';
type PiExtensionStatusPreferences = { display: PiExtensionStatusDisplay; keys: string[] };
type ContextFileChoice = { path: string; enabled: boolean };

type RunningSessionRecord = {
  version: 1;
  sessionKey: string;
  workspaceKey?: string;
  activity: string;
  updatedAt: number;
};

const VIEW_ID = 'piChat.chatView';
const PENDING_SESSION_HANDOFF_KEY = 'piChat.pendingSessionHandoff';
const SESSION_HANDOFF_MAX_AGE_MS = 10 * 60 * 1000;
const MAX_ATTACHMENT_BYTES = 1024 * 1024;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_ATTACHMENT_CHARS = 40_000;
const MAX_GIT_REVIEW_FILES = 500;
const MAX_GIT_DIFF_CHARS = 500_000;
const MAX_GIT_DRAFT_CHARS = 30_000;
const MAX_GIT_DRAFT_FILES = 24;
const MAX_UNTRACKED_DRAFT_BYTES = 16_000;
const MAX_RUNNING_SESSION_RECORD_BYTES = 8_192;
const MAX_RUNNING_SESSION_RECORDS = 200;
const RUNNING_SESSION_RECORD_TTL_MS = 12_000;
const MAX_GIT_BRANCHES_FOR_PICKER = 500;
const GIT_WORKTREE_COMMAND_TIMEOUT_MS = 5 * 60 * 1000;
const RUNTIME_ENV_SECRET_PREFIX = 'piChat.runtimeEnv:';
const PINNED_EXTENSION_WIDGETS_KEY = 'piChat.pinnedExtensionWidgets';
const MAX_PINNED_EXTENSION_WIDGETS = 32;
const MAX_RUNTIME_ENV_VARIABLES = 32;
const MAX_RUNTIME_ENV_VALUE_CHARS = 4096;
const MAX_RUNTIME_ENV_TOTAL_CHARS = 8192;
const MAX_WINDOWS_WORKER_ENVIRONMENT_CHARS = 30_000;
const MAX_PACKAGE_SEARCH_RESPONSE_BYTES = 512 * 1024;
const MAX_PACKAGE_SEARCHES_PER_MINUTE = 20;
const RESERVED_RUNTIME_ENV_NAMES = new Set([
  'PATH', 'PATHEXT', 'COMSPEC', 'SYSTEMROOT', 'WINDIR', 'HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH',
  'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP', 'TMPDIR', 'PI_CODING_AGENT_DIR', 'PI_OFFLINE',
  'NODE_OPTIONS', 'NODE_PATH', 'NODE_TLS_REJECT_UNAUTHORIZED', 'ELECTRON_RUN_AS_NODE',
  'LD_PRELOAD', 'LD_LIBRARY_PATH', 'DYLD_INSERT_LIBRARIES', 'DYLD_LIBRARY_PATH',
  'GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES',
]);

function isAllowedRuntimeEnvironmentName(value: string): boolean {
  return /^[A-Z_][A-Z0-9_]{0,127}$/.test(value)
    && !RESERVED_RUNTIME_ENV_NAMES.has(value)
    && !value.startsWith('GIT_CONFIG_')
    && !value.startsWith('VSCODE_')
    && !value.startsWith('ELECTRON_');
}

function readPiOfflineMode(): PiOfflineMode {
  const value = vscode.workspace.getConfiguration('piChat').get<string>('offlineMode', 'inherit');
  return value === 'offline' || value === 'online' ? value : 'inherit';
}

function readPiExtensionUiMode(): PiExtensionUiMode {
  return vscode.workspace.getConfiguration('piChat').get<string>('extensionUiMode', 'rpc') === 'tui' ? 'tui' : 'rpc';
}

function readPiExtensionStatusPreferences(): PiExtensionStatusPreferences {
  const configuration = vscode.workspace.getConfiguration('piChat.extensionStatus');
  const display = configuration.get<string>('display', 'footer');
  const keys = configuration.get<unknown[]>('keys', []);
  return {
    display: display === 'statusBar' || display === 'both' || display === 'hidden' ? display : 'footer',
    keys: Array.isArray(keys)
      ? [...new Set(keys.filter((key): key is string => typeof key === 'string' && key.length <= 128
        && !/[\u0000-\u001f\u007f]/.test(key)))].slice(0, 32)
      : [],
  };
}

type PiPackageSearchResult = { name: string; version: string; description: string; source: string };

async function readBoundedJsonResponse(response: Response, maximumBytes: number): Promise<unknown> {
  const contentLength = response.headers.get('content-length');
  if (contentLength && /^\d+$/.test(contentLength) && Number(contentLength) > maximumBytes) {
    throw new Error('The package search response is too large.');
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error('The package search response was empty.');
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maximumBytes) {
        await reader.cancel();
        throw new Error('The package search response is too large.');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown;
}

function parsePiPackageSearchResults(value: unknown): PiPackageSearchResult[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  const objects = (value as Record<string, unknown>).objects;
  if (!Array.isArray(objects)) return [];
  const results: PiPackageSearchResult[] = [];
  const seen = new Set<string>();
  for (const object of objects.slice(0, 50)) {
    if (!object || typeof object !== 'object' || Array.isArray(object)) continue;
    const packageData = (object as Record<string, unknown>).package;
    if (!packageData || typeof packageData !== 'object' || Array.isArray(packageData)) continue;
    const fields = packageData as Record<string, unknown>;
    const name = typeof fields.name === 'string' ? fields.name : '';
    const version = typeof fields.version === 'string' ? fields.version : '';
    const keywords = Array.isArray(fields.keywords) ? fields.keywords : [];
    if (!name || name.length > 214 || seen.has(name)
      || !keywords.some((keyword) => typeof keyword === 'string' && keyword.toLowerCase() === 'pi-package')
      || !/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version)) continue;
    const source = `npm:${name}@${version}`;
    if (!isPiPackageSource(source)) continue;
    const description = typeof fields.description === 'string'
      ? fields.description.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 240)
      : '';
    seen.add(name);
    results.push({ name, version, description, source });
    if (results.length >= 20) break;
  }
  return results;
}

type PendingSessionHandoff = {
  sessionPath: string;
  cwd: string;
  createdAt: number;
  token: string;
};

function isPendingSessionHandoff(value: unknown): value is PendingSessionHandoff {
  if (!value || typeof value !== 'object') return false;
  const handoff = value as Partial<PendingSessionHandoff>;
  return typeof handoff.sessionPath === 'string'
    && handoff.sessionPath.length <= 4096
    && !/[\u0000-\u001f\u007f]/.test(handoff.sessionPath)
    && path.isAbsolute(handoff.sessionPath)
    && typeof handoff.cwd === 'string'
    && handoff.cwd.length <= 4096
    && !/[\u0000-\u001f\u007f]/.test(handoff.cwd)
    && path.isAbsolute(handoff.cwd)
    && Number.isSafeInteger(handoff.createdAt)
    && typeof handoff.token === 'string'
    && /^[a-f0-9]{32}$/.test(handoff.token);
}

function isValidBase64ImageData(data: string): boolean {
  if (!data || data.length % 4 !== 0) return false;
  const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0;
  const contentLength = data.length - padding;
  if (data.indexOf('=') !== (padding ? contentLength : -1)) return false;
  for (let offset = 0; offset < contentLength; offset += 4096) {
    if (!/^[A-Za-z0-9+/]+$/.test(data.slice(offset, Math.min(offset + 4096, contentLength)))) return false;
  }
  return true;
}

export function activate(context: vscode.ExtensionContext): void {
  const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 90);
  statusBarItem.name = 'Pi extension status';
  const provider = new PiChatViewProvider(context, statusBarItem);
  const editorProviders = new Set<PiChatViewProvider>();
  const attachEditorPanel = (panel: vscode.WebviewPanel, state?: unknown): void => {
    const panelProvider = new PiChatViewProvider(context);
    panelProvider.setEditorPanelRestoreState(state);
    editorProviders.add(panelProvider);
    panelProvider.resolveWebviewPanel(panel);
    panel.onDidDispose(() => {
      editorProviders.delete(panelProvider);
      panelProvider.dispose();
    });
  };

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(VIEW_ID, provider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.commands.registerCommand('piChat.newEditorChat', () => {
      const panel = vscode.window.createWebviewPanel('piChat.editorChat', 'Pi Chat', vscode.ViewColumn.Beside, {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
          vscode.Uri.joinPath(context.extensionUri, 'media'),
          vscode.Uri.joinPath(context.extensionUri, 'dist'),
        ],
      });
      attachEditorPanel(panel);
      return panel;
    }),
    vscode.window.registerWebviewPanelSerializer('piChat.editorChat', {
      async deserializeWebviewPanel(panel, state) {
        attachEditorPanel(panel, state);
      },
    }),
    vscode.commands.registerCommand('piChat.newSession', () => provider.newSession()),
    vscode.commands.registerCommand('piChat.cloneSession', () => provider.cloneSession()),
    vscode.commands.registerCommand('piChat.createWorktree', () => provider.createGitWorktreeSession()),
    vscode.commands.registerCommand('piChat.removeWorktree', () => provider.removeGitWorktreeSession()),
    vscode.commands.registerCommand('piChat.openSettings', () => vscode.commands.executeCommand('workbench.action.openSettings', '@ext:local.pi-chat-vscode')),
    vscode.commands.registerCommand('piChat.chooseAgentDir', () => provider.chooseAgentDir()),
    vscode.commands.registerCommand('piChat.manageRuntimeEnvironment', () => provider.manageRuntimeEnvironment()),
    vscode.commands.registerCommand('piChat.restartRuntime', () => provider.restartPiRuntime()),
    vscode.commands.registerCommand('piChat.exportDiagnostics', () => provider.exportDiagnostics()),
    vscode.commands.registerCommand('piChat.openLogs', () => provider.openLogs()),
    vscode.commands.registerCommand('piChat.manageMcpServers', () => provider.manageMcpServers()),
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      for (const activeProvider of [provider, ...editorProviders]) void activeProvider.restartRuntime();
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      for (const activeProvider of [provider, ...editorProviders]) {
        if (event.affectsConfiguration('piChat.agentDir')) activeProvider.onAgentDirConfigurationChanged();
        if (event.affectsConfiguration('piChat.offlineMode')) activeProvider.onOfflineModeConfigurationChanged();
        if (event.affectsConfiguration('piChat.extensionUiMode')) activeProvider.onExtensionUiModeConfigurationChanged();
        if (event.affectsConfiguration('piChat.extensionStatus')) activeProvider.onExtensionStatusConfigurationChanged();
        if (event.affectsConfiguration('piChat.notifications.sound')) activeProvider.onNotificationSoundConfigurationChanged();
        if (event.affectsConfiguration('piChat.models.autoRefresh')) activeProvider.onModelRefreshConfigurationChanged();
        if (event.affectsConfiguration('piChat.queue.defaultAction')) activeProvider.onQueueDefaultActionConfigurationChanged();
      }
    }),
    new vscode.Disposable(() => {
      for (const panelProvider of editorProviders) panelProvider.dispose();
      editorProviders.clear();
    }),
    provider,
  );
}

export function deactivate(): void {
  // The webview provider owns the Pi worker for the lifetime of the extension host.
}

class PiChatViewProvider implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView | vscode.WebviewPanel;
  private worker?: Worker;
  private runtimeStartInFlight?: Promise<void>;
  private runtimeStartGeneration = 0;
  private workerWorkspace?: string;
  private workerAgentDirSetting = '';
  private workerOfflineModeSetting: PiOfflineMode = 'inherit';
  private workerExtensionUiModeSetting: PiExtensionUiMode = 'rpc';
  private runtimeBusy = false;
  private queuedWorkCount = 0;
  private runtimeActivity = 'Working in Pi';
  private sessionListForRunningStatus: Array<Record<string, unknown>> = [];
  private readonly runningSessionsDirectory: string;
  private readonly runningSessionRecordPath: string;
  private readonly runningSessionPoller: NodeJS.Timeout;
  private runningSessionOperation: Promise<void> = Promise.resolve();
  private runningSessionLeasePublished = false;
  private runningSessionLeaseSignature = '';
  private runningSessionLeaseWrittenAt = 0;
  private webviewMessageSubscription?: vscode.Disposable;
  private sessionQuery = '';
  private sessionSearchAllWorkspaces = false;
  private sessionWorkspaceByPath = new Map<string, string>();
  private activeSessionPath = '';
  private restoredEditorSessionPath?: string;
  private openLatestSessionOnStart: boolean;
  private latestSessionOpenAttempted = false;
  private sessionInteractionStarted = false;
  private sessionInitializationRequested = false;
  private knownSessionPaths = new Set<string>();
  private knownPromptPaths = new Set<string>();
  private knownResourcePaths = new Set<string>();
  private availableProviders: ProviderSetup[] = [];
  private availableProviderIds: string[] = [];
  private availableToolNames = new Set<string>();
  private contextFileChoices: ContextFileChoice[] = [];
  private contextFilesTruncated = false;
  private pendingContextFileSelection?: { worker: Worker; requestId: string; previousDisabled: string[] };
  private modelsConfigPath = '';
  private settingsConfigPath = '';
  private mcpConfigPath = '';
  private pendingMcpSetting?: { worker: Worker; requestId: string; enabled: boolean; previous: boolean };
  private pendingMcpServerRequests = new Map<string, { worker: Worker; resolve: (message: RuntimeMessage | undefined) => void; timer: NodeJS.Timeout }>();
  private mcpServerManagementInFlight = false;
  private pendingPiResourcePicker?: { worker: Worker; requestId: string };
  private pendingPackageSearch?: { controller: AbortController; timer: NodeJS.Timeout };
  private packageSearchesAt: number[] = [];
  private pendingExtensionUiRequestIds = new Set<string>();
  private providerAuthPromptCancels = new Map<string, { worker: Worker; cancel: () => void }>();
  private activeEditorSubscription: vscode.Disposable;
  private selectionSubscription: vscode.Disposable;
  private pinnedActiveFileEnabled: boolean;
  private diagnosticEvents: Array<{ at: string; category: string }> = [];
  private readonly outputChannel: vscode.OutputChannel;
  private readonly extensionStatuses = new Map<string, string>();
  private logWriteQueue: Promise<void> = Promise.resolve();
  private savedDraftsWrite: Promise<void> = Promise.resolve();

  constructor(private readonly context: vscode.ExtensionContext, private readonly extensionStatusBarItem?: vscode.StatusBarItem) {
    this.pinnedActiveFileEnabled = context.workspaceState.get<boolean>('piChat.context.pinnedActiveFile', false);
    this.openLatestSessionOnStart = vscode.workspace.getConfiguration('piChat.sessions').get<boolean>('openLatestOnStart', false);
    this.outputChannel = vscode.window.createOutputChannel('Pi Chat');
    this.runningSessionsDirectory = path.join(context.globalStorageUri.fsPath, 'running-sessions');
    this.runningSessionRecordPath = path.join(this.runningSessionsDirectory, `${randomBytes(16).toString('hex')}.json`);
    this.runningSessionPoller = setInterval(() => {
      this.refreshRunningSessionLease();
      void this.refreshRunningSessionStatuses();
    }, 2500);
    this.runningSessionPoller.unref?.();
    this.activeEditorSubscription = vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (editor) this.post({ type: 'dismiss-composer-popovers' });
      if (this.pinnedActiveFileEnabled && editor) this.publishPinnedActiveFile(editor);
    });
    this.selectionSubscription = vscode.window.onDidChangeTextEditorSelection((event) => {
      if (event.textEditor === vscode.window.activeTextEditor
        && event.kind === vscode.TextEditorSelectionChangeKind.Mouse) {
        this.post({ type: 'dismiss-composer-popovers' });
      }
      if (this.pinnedActiveFileEnabled && event.textEditor === vscode.window.activeTextEditor) this.publishPinnedActiveFile(event.textEditor);
    });
    this.updateExtensionStatusBar();
  }

  dispose(): void {
    clearInterval(this.runningSessionPoller);
    this.clearRunningSessionLease();
    this.cancelPackageSearch(false);
    this.cancelProviderAuthPrompts();
    this.outputChannel.dispose();
    this.extensionStatusBarItem?.dispose();
    this.activeEditorSubscription.dispose();
    this.selectionSubscription.dispose();
    this.webviewMessageSubscription?.dispose();
    this.webviewMessageSubscription = undefined;
    const worker = this.worker;
    this.cancelPendingExtensionUiRequests(worker);
    this.worker = undefined;
    this.pendingPiResourcePicker = undefined;
    this.knownPromptPaths.clear();
    this.knownResourcePaths.clear();
    this.availableProviders = [];
    this.availableProviderIds = [];
    this.availableToolNames.clear();
    this.contextFileChoices = [];
    this.contextFilesTruncated = false;
    this.pendingContextFileSelection = undefined;
    this.modelsConfigPath = '';
    this.settingsConfigPath = '';
    this.mcpConfigPath = '';
    this.failPendingMcpSetting(worker);
    this.failPendingMcpServerRequests(worker);
    if (worker) this.stopWorker(worker);
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.attachWebview(view);
  }

  resolveWebviewPanel(view: vscode.WebviewPanel): void {
    this.attachWebview(view);
  }

  setEditorPanelRestoreState(state: unknown): void {
    if (!state || typeof state !== 'object' || Array.isArray(state)) return;
    const sessionPath = (state as Record<string, unknown>).sessionPath;
    if (typeof sessionPath === 'string' && sessionPath.length <= 4096
      && path.isAbsolute(sessionPath) && !/[\u0000-\u001f\u007f]/.test(sessionPath)) {
      this.restoredEditorSessionPath = sessionPath;
    }
  }

  private attachWebview(view: vscode.WebviewView | vscode.WebviewPanel): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.context.extensionUri, 'media'),
        vscode.Uri.joinPath(this.context.extensionUri, 'dist'),
      ],
    };
    view.webview.html = this.getHtml(view.webview);
    this.webviewMessageSubscription?.dispose();
    this.webviewMessageSubscription = view.webview.onDidReceiveMessage((message: RuntimeMessage) => {
      void this.handleWebviewMessage(message);
    });
    view.onDidDispose(() => {
      this.webviewMessageSubscription?.dispose();
      this.webviewMessageSubscription = undefined;
      if (this.view === view) {
        this.view = undefined;
        this.cancelPendingExtensionUiRequests(this.worker);
        this.cancelPackageSearch(false);
      }
    });

    this.postExtensionStatusPreferences();
    this.postQueueDefaultAction();
    void this.ensureRuntime();
  }

  onQueueDefaultActionConfigurationChanged(): void {
    this.postQueueDefaultAction();
  }

  private postQueueDefaultAction(): void {
    const value = vscode.workspace.getConfiguration('piChat.queue').get<unknown>('defaultAction', 'followUp');
    this.post({ type: 'queue-default-action', action: value === 'steer' ? 'steer' : 'followUp' });
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

  async createGitWorktreeSession(): Promise<void> {
    const workspace = vscode.workspace.workspaceFolders?.[0];
    if (!workspace || workspace.uri.scheme !== 'file') {
      void vscode.window.showErrorMessage('Open a local workspace folder before creating a Git worktree.');
      return;
    }
    if (!vscode.workspace.isTrusted) {
      void vscode.window.showErrorMessage('Trust this workspace in VS Code before creating a Git worktree.');
      return;
    }

    try {
      const handle = await this.getGitRepository(workspace);
      if (!handle) {
        void vscode.window.showErrorMessage('The current workspace is not inside a Git repository.');
        return;
      }
      const gitPath = handle.api.git?.path || 'git';
      const repositoryPath = await realpath(handle.repository.rootUri.fsPath);
      const branchResult = await runGitCommand(gitPath, repositoryPath, [
        'for-each-ref', `--count=${MAX_GIT_BRANCHES_FOR_PICKER}`, '--sort=-committerdate', '--format=%(refname)', 'refs/heads',
      ], 15_000);
      if (branchResult.exitCode !== 0) {
        void vscode.window.showErrorMessage('Could not list local Git branches for this worktree.');
        return;
      }
      const branches = [...new Set(branchResult.stdout.split(/\r?\n/)
        .map((ref) => ref.trim())
        .filter((ref) => ref.startsWith('refs/heads/') && ref.length > 'refs/heads/'.length)
        .map((ref) => ref.slice('refs/heads/'.length)))];
      const currentBranch = handle.repository.state.HEAD?.name;
      if (currentBranch && !branches.includes(currentBranch)) branches.unshift(currentBranch);
      branches.sort((a, b) => (a === currentBranch ? -1 : b === currentBranch ? 1 : 0));
      if (branches.length === 0) {
        void vscode.window.showErrorMessage('Create an initial commit and branch before creating a Pi worktree.');
        return;
      }

      const baseBranch = await vscode.window.showQuickPick(
        branches.map((branch) => ({ label: branch, description: branch === currentBranch ? 'Current branch' : undefined })),
        { placeHolder: `Choose from up to ${MAX_GIT_BRANCHES_FOR_PICKER} recent local branches; the current branch is included when available` },
      );
      if (!baseBranch) return;
      const baseRef = `refs/heads/${baseBranch.label}`;

      const branchName = await vscode.window.showInputBox({
        title: 'Create Git worktree',
        prompt: 'Enter a new local branch name for the Pi worktree.',
        placeHolder: 'feature/my-change',
        ignoreFocusOut: true,
        validateInput: (value) => {
          if (!value || value !== value.trim()) return 'Enter a branch name without leading or trailing spaces.';
          if (value.length > 120 || !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value)) {
            return 'Use up to 120 letters, numbers, dots, underscores, hyphens, or slashes; start with a letter or number.';
          }
          return undefined;
        },
      });
      if (!branchName) return;

      const branchValidation = await runGitCommand(gitPath, repositoryPath, ['check-ref-format', '--branch', branchName], 15_000);
      if (branchValidation.exitCode !== 0) {
        void vscode.window.showErrorMessage('Git rejected that branch name. Choose another name and try again.');
        return;
      }
      const branchRef = `refs/heads/${branchName}`;
      const branchExists = await runGitCommand(gitPath, repositoryPath, ['show-ref', '--verify', '--quiet', branchRef], 15_000);
      if (branchExists.exitCode === 0) {
        void vscode.window.showErrorMessage(`The local branch "${branchName}" already exists.`);
        return;
      }
      if (branchExists.exitCode !== 1) {
        void vscode.window.showErrorMessage('Could not verify that the requested branch name is available.');
        return;
      }

      const parentSelection = await vscode.window.showOpenDialog({
        canSelectFiles: false,
        canSelectFolders: true,
        canSelectMany: false,
        defaultUri: vscode.Uri.file(path.dirname(repositoryPath)),
        openLabel: 'Choose worktree parent folder',
      });
      if (!parentSelection?.[0] || parentSelection[0].scheme !== 'file') return;
      const parentPath = await realpath(parentSelection[0].fsPath);
      if (/[\u0000-\u001f\u007f]/.test(repositoryPath) || /[\u0000-\u001f\u007f]/.test(parentPath)) {
        void vscode.window.showErrorMessage('The selected repository or destination path contains unsupported control characters.');
        return;
      }
      if (isPathInside(repositoryPath, parentPath)) {
        void vscode.window.showErrorMessage('Choose a worktree parent folder outside the current repository.');
        return;
      }

      const repoName = path.basename(repositoryPath).replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[.-]+/, '').slice(0, 60) || 'repo';
      const targetName = `${repoName}-${branchName.replaceAll('/', '-')}`;
      const targetPath = path.join(parentPath, targetName);
      if (targetPath.length > 4096 || isPathInside(repositoryPath, targetPath) || isPathInside(targetPath, repositoryPath)) {
        void vscode.window.showErrorMessage('The selected worktree location is not a safe path. Choose another parent folder.');
        return;
      }
      try {
        await lstat(targetPath);
        void vscode.window.showErrorMessage('The worktree destination already exists. Choose another parent folder.');
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }

      const confirmation = await vscode.window.showWarningMessage(
        `Create a new Git worktree?\n\nRepository: ${repositoryPath}\nStarting branch: ${baseBranch.label}\nNew branch: ${branchName}\nDestination: ${targetPath}\n\nGit checkout hooks and configured file filters may run. This will not run project setup commands or modify the current worktree.`,
        { modal: true },
        'Create worktree',
      );
      if (confirmation !== 'Create worktree') return;
      if (!vscode.workspace.isTrusted) {
        void vscode.window.showErrorMessage('Workspace trust changed. Trust this workspace before creating a Git worktree.');
        return;
      }

      if (await realpath(handle.repository.rootUri.fsPath) !== repositoryPath || await realpath(parentPath) !== parentPath) {
        void vscode.window.showErrorMessage('The repository or destination folder changed. Start the worktree operation again.');
        return;
      }
      const baseBranchRecheck = await runGitCommand(gitPath, repositoryPath, ['show-ref', '--verify', '--quiet', baseRef], 15_000);
      if (baseBranchRecheck.exitCode !== 0) {
        void vscode.window.showErrorMessage('The selected starting branch is no longer available. Start the worktree operation again.');
        return;
      }
      const branchRecheck = await runGitCommand(gitPath, repositoryPath, ['show-ref', '--verify', '--quiet', branchRef], 15_000);
      if (branchRecheck.exitCode === 0) {
        void vscode.window.showErrorMessage(`The local branch "${branchName}" was created elsewhere. Choose another name.`);
        return;
      }
      if (branchRecheck.exitCode !== 1) {
        void vscode.window.showErrorMessage('Could not recheck branch availability. Start the worktree operation again.');
        return;
      }
      try {
        await lstat(targetPath);
        void vscode.window.showErrorMessage('The worktree destination was created elsewhere. Choose another parent folder.');
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }

      let result: GitCommandResult;
      try {
        result = await vscode.window.withProgress({
          location: vscode.ProgressLocation.Notification,
          title: 'Creating Git worktree for Pi Chat',
          cancellable: false,
        }, () => runGitCommand(gitPath, repositoryPath, ['worktree', 'add', '-b', branchName, targetPath, baseRef], GIT_WORKTREE_COMMAND_TIMEOUT_MS));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ETIMEDOUT') {
          void vscode.window.showErrorMessage(`Git exceeded the five-minute timeout. It may have left a partial worktree at ${targetPath}; inspect it and Git's worktree list before retrying.`);
          return;
        }
        throw error;
      }
      if (result.exitCode !== 0) {
        const detail = result.stderr.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 400);
        void vscode.window.showErrorMessage(`Git could not create the worktree. Check ${targetPath} and Git's worktree list before retrying.${detail ? ` ${detail}` : ''}`);
        return;
      }

      try {
        await this.offerIgnoredFilesForWorktree(gitPath, repositoryPath, targetPath);
      } catch (error) {
        const detail = error instanceof Error ? error.message.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 240) : 'Unknown error.';
        void vscode.window.showErrorMessage(`The worktree was created, but ignored files could not be copied. ${detail}`);
      }

      const open = await vscode.window.showInformationMessage(`Git worktree created at ${targetPath}.`, 'Open in New Window');
      if (open === 'Open in New Window') {
        try {
          const opened = await vscode.commands.executeCommand<boolean>('vscode.openFolder', vscode.Uri.file(targetPath), { forceNewWindow: true });
          if (opened === false) void vscode.window.showInformationMessage(`Worktree created at ${targetPath}; open that folder in VS Code to start a Pi chat.`);
        } catch {
          void vscode.window.showInformationMessage(`Worktree created at ${targetPath}; open that folder in VS Code to start a Pi chat.`);
        }
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      const detail = code === 'ETIMEDOUT'
        ? 'Git did not finish before the five-minute timeout.'
        : error instanceof Error ? error.message.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 300) : 'Unknown error.';
      void vscode.window.showErrorMessage(`Could not create a Git worktree. ${detail}`);
    }
  }

  async removeGitWorktreeSession(): Promise<void> {
    const workspace = vscode.workspace.workspaceFolders?.[0];
    if (!workspace || workspace.uri.scheme !== 'file') {
      void vscode.window.showErrorMessage('Open a local workspace folder before removing a Git worktree.');
      return;
    }
    if (!vscode.workspace.isTrusted) {
      void vscode.window.showErrorMessage('Trust this workspace in VS Code before removing a Git worktree.');
      return;
    }

    try {
      const handle = await this.getGitRepository(workspace);
      if (!handle) {
        void vscode.window.showErrorMessage('The current workspace is not inside a Git repository.');
        return;
      }
      const gitPath = handle.api.git?.path || 'git';
      const repositoryPath = await realpath(handle.repository.rootUri.fsPath);
      const currentPath = this.normalizeSessionPath(repositoryPath);
      const entries = await listGitWorktrees(gitPath, repositoryPath);
      const candidates: Array<GitWorktreeEntry & { canonicalPath: string }> = [];
      for (const entry of entries) {
        if (entry.bare || entry.locked || entry.prunable || this.normalizeSessionPath(entry.path) === currentPath) continue;
        try {
          const stats = await lstat(entry.path);
          if (!stats.isDirectory() || stats.isSymbolicLink()) continue;
          const canonicalPath = await realpath(entry.path);
          if (this.normalizeSessionPath(canonicalPath) !== this.normalizeSessionPath(entry.path)) continue;
          candidates.push({ ...entry, canonicalPath });
        } catch {
          // Missing or inaccessible worktrees are not offered for removal.
        }
      }
      if (candidates.length === 0) {
        void vscode.window.showInformationMessage('There are no other unlocked Git worktrees available to remove.');
        return;
      }

      const selected = await vscode.window.showQuickPick(candidates.map((entry) => ({
        label: path.basename(entry.canonicalPath) || entry.canonicalPath,
        description: entry.branch ? `Branch: ${entry.branch}` : entry.detached ? 'Detached HEAD' : 'No branch',
        detail: entry.canonicalPath,
        path: entry.canonicalPath,
        branch: entry.branch,
      })), {
        title: 'Remove a Git worktree',
        placeHolder: 'Choose a worktree to inspect before removal',
        ignoreFocusOut: true,
      });
      if (!selected) return;

      const workspaceKey = this.runningWorkspaceKey(selected.path);
      if (!workspaceKey) {
        void vscode.window.showErrorMessage('Could not safely identify the selected worktree.');
        return;
      }
      const hasActiveWork = (await this.readRunningSessionRecords()).some((record) => !record.workspaceKey || record.workspaceKey === workspaceKey);
      if (hasActiveWork) {
        void vscode.window.showErrorMessage('A Pi session may still be working in this worktree. Stop its run and try again.');
        return;
      }

      const inspectWorktree = async () => {
        const status = await runGitCommand(gitPath, selected.path, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignore-submodules=none'], 15_000);
        if (status.exitCode !== 0) throw new Error('Git could not verify the worktree status.');
        const ignoredResult = await runGitCommand(gitPath, selected.path, ['ls-files', '--others', '--ignored', '--exclude-standard', '-z'], 15_000);
        if (ignoredResult.exitCode !== 0) throw new Error('Git could not verify ignored worktree files.');
        const ignoredPaths = ignoredResult.stdout.split('\0').filter(Boolean);
        if (ignoredPaths.some((item) => !isSafeRepositoryRelativePath(item))) throw new Error('Git returned a worktree path that could not be checked safely.');
        return { changeCount: status.stdout.split('\0').filter(Boolean).length, ignoredPaths };
      };

      const stateBeforeConfirmation = await inspectWorktree();
      if (stateBeforeConfirmation.changeCount > 0) {
        void vscode.window.showErrorMessage(`This worktree has ${stateBeforeConfirmation.changeCount} tracked or untracked change entries. Commit or move them before removing the worktree.`);
        return;
      }

      const branchUsedElsewhere = Boolean(selected.branch) && entries.some((entry) =>
        entry.branch === selected.branch && this.normalizeSessionPath(entry.path) !== this.normalizeSessionPath(selected.path));
      const confirmRemove = stateBeforeConfirmation.ignoredPaths.length > 0
        ? 'Remove worktree and ignored files'
        : 'Remove worktree';
      const confirmRemoveAndBranch = selected.branch && !branchUsedElsewhere
        ? stateBeforeConfirmation.ignoredPaths.length > 0
          ? 'Remove worktree, ignored files, and branch'
          : 'Remove worktree and branch'
        : undefined;
      const ignoredPreview = stateBeforeConfirmation.ignoredPaths.slice(0, 8).join('\n');
      const ignoredMore = stateBeforeConfirmation.ignoredPaths.length > 8
        ? `\n…and ${stateBeforeConfirmation.ignoredPaths.length - 8} more`
        : '';
      const warning = [
        `Remove this Git worktree?\n\nPath: ${selected.path}${selected.branch ? `\nBranch: ${selected.branch}` : ''}`,
        stateBeforeConfirmation.ignoredPaths.length > 0
          ? `\n\nThis also deletes ${stateBeforeConfirmation.ignoredPaths.length} ignored file${stateBeforeConfirmation.ignoredPaths.length === 1 ? '' : 's'}:\n${ignoredPreview}${ignoredMore}`
          : '',
        '\n\nThis action deletes the worktree folder. Close other VS Code windows using it first. Pi session files remain in your session history.',
      ].join('');
      const options = confirmRemoveAndBranch ? [confirmRemove, confirmRemoveAndBranch] : [confirmRemove];
      const confirmation = await vscode.window.showWarningMessage(warning, { modal: true }, ...options);
      if (!confirmation) return;
      if (!vscode.workspace.isTrusted) {
        void vscode.window.showErrorMessage('Workspace trust changed. Trust this workspace before removing a Git worktree.');
        return;
      }
      if ((await this.readRunningSessionRecords()).some((record) => !record.workspaceKey || record.workspaceKey === workspaceKey)) {
        void vscode.window.showErrorMessage('A Pi session started in this worktree while confirmation was open. Stop it before removing the worktree.');
        return;
      }

      const currentEntries = await listGitWorktrees(gitPath, repositoryPath);
      const currentEntry = currentEntries.find((entry) => this.normalizeSessionPath(entry.path) === this.normalizeSessionPath(selected.path));
      if (!currentEntry || currentEntry.bare || currentEntry.locked || currentEntry.prunable) {
        void vscode.window.showErrorMessage('The selected worktree changed while confirmation was open. Run the command again.');
        return;
      }
      const currentPathStats = await lstat(selected.path);
      if (!currentPathStats.isDirectory() || currentPathStats.isSymbolicLink()
        || this.normalizeSessionPath(await realpath(selected.path)) !== this.normalizeSessionPath(selected.path)) {
        void vscode.window.showErrorMessage('The selected worktree path changed while confirmation was open. Run the command again.');
        return;
      }
      const stateAfterConfirmation = await inspectWorktree();
      if (stateAfterConfirmation.changeCount > 0
        || JSON.stringify(stateAfterConfirmation.ignoredPaths) !== JSON.stringify(stateBeforeConfirmation.ignoredPaths)) {
        void vscode.window.showErrorMessage('Files in this worktree changed while confirmation was open. Run the command again to review its current state.');
        return;
      }

      const removeResult = await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: 'Removing Git worktree',
        cancellable: false,
      }, () => runGitCommand(gitPath, repositoryPath, ['worktree', 'remove', selected.path], GIT_WORKTREE_COMMAND_TIMEOUT_MS));
      if (removeResult.exitCode !== 0) {
        const detail = removeResult.stderr.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 400);
        void vscode.window.showErrorMessage(`Git refused to remove the worktree. No force removal was attempted.${detail ? ` ${detail}` : ''}`);
        return;
      }

      if (confirmation === confirmRemoveAndBranch && selected.branch && !branchUsedElsewhere) {
        const deleteResult = await runGitCommand(gitPath, repositoryPath, ['branch', '-d', '--', selected.branch], 15_000);
        if (deleteResult.exitCode !== 0) {
          const detail = deleteResult.stderr.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 300);
          void vscode.window.showWarningMessage(`The worktree was removed, but Git kept branch "${selected.branch}".${detail ? ` ${detail}` : ''}`);
          return;
        }
      }
      void vscode.window.showInformationMessage('Git worktree removed. Pi session files remain in history.');
    } catch (error) {
      const detail = error instanceof Error ? error.message.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 300) : 'Unknown error.';
      void vscode.window.showErrorMessage(`Could not remove the Git worktree. ${detail}`);
    }
  }

  private async offerIgnoredFilesForWorktree(gitPath: string, repositoryPath: string, worktreePath: string): Promise<void> {
    let listing: IgnoredFileListing;
    try {
      listing = await listIgnoredFileChoices(gitPath, repositoryPath);
    } catch {
      void vscode.window.showInformationMessage('The worktree was created; Git could not list ignored files to copy.');
      return;
    }
    if (listing.choices.length === 0) return;

    const selected = await vscode.window.showQuickPick(listing.choices, {
      canPickMany: true,
      title: 'Copy ignored files into the worktree?',
      placeHolder: `Select files to copy${listing.truncated ? ` (showing the first ${MAX_IGNORED_FILES_FOR_PICKER})` : ''}; files may contain secrets`,
      ignoreFocusOut: true,
    });
    if (!selected?.length) return;

    const preview = selected.slice(0, 8).map((item) => item.relativePath).join('\n');
    const more = selected.length > 8 ? `\n…and ${selected.length - 8} more` : '';
    const confirmation = await vscode.window.showWarningMessage(
      `Copy ${selected.length} selected ignored file${selected.length === 1 ? '' : 's'} into the new worktree? Ignored files can contain credentials or other private data. Existing destination files will not be overwritten.\n\n${preview}${more}\n\nLimits: 2 MB per file and 10 MB total.`,
      { modal: true },
      'Copy selected files',
    );
    if (confirmation !== 'Copy selected files') return;

    const copied: string[] = [];
    const skipped: string[] = [];
    await vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification,
      title: 'Copying selected ignored files',
      cancellable: false,
    }, async (progress) => {
      let copiedBytes = 0;
      for (let index = 0; index < selected.length; index += 1) {
        const item = selected[index];
        progress.report({ increment: 100 / selected.length, message: `${index + 1} of ${selected.length}` });
        try {
          const outcome = await copyIgnoredFileSafely(repositoryPath, worktreePath, item.relativePath, item.size, MAX_IGNORED_COPY_BYTES - copiedBytes);
          if (outcome === 'copied') {
            copied.push(item.relativePath);
            copiedBytes += item.size;
          } else {
            skipped.push(item.relativePath);
          }
        } catch {
          skipped.push(item.relativePath);
        }
      }
    });
    const skippedText = skipped.length ? ` ${skipped.length} skipped because they changed, collided with existing files, or failed path checks.` : '';
    void vscode.window.showInformationMessage(`Copied ${copied.length} ignored file${copied.length === 1 ? '' : 's'} into the worktree.${skippedText}`);
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

  async openLogs(): Promise<void> {
    try {
      await this.logWriteQueue;
      const logPath = path.join(this.context.globalStorageUri.fsPath, DIAGNOSTIC_LOG_FILENAME);
      await mkdir(path.dirname(logPath), { recursive: true });
      try {
        const logStats = await lstat(logPath);
        if (!logStats.isFile() || logStats.isSymbolicLink()) throw new Error('Diagnostic log path is not a regular file.');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        await writeFile(logPath, '', { encoding: 'utf8', mode: 0o600 });
      }
      const document = await vscode.workspace.openTextDocument(vscode.Uri.file(logPath));
      await vscode.window.showTextDocument(document, { preview: true });
    } catch {
      void vscode.window.showErrorMessage('Could not open the local Pi Chat diagnostic log.');
    }
  }

  restartRuntime(): void {
    this.runtimeStartGeneration += 1;
    const previous = this.worker;
    this.workerAgentDirSetting = '';
    this.workerOfflineModeSetting = 'inherit';
    this.workerExtensionUiModeSetting = 'rpc';
    if (previous) this.cancelProviderAuthPrompts(previous);
    this.cancelPendingExtensionUiRequests(previous);
    this.worker = undefined;
    this.runtimeBusy = false;
    this.queuedWorkCount = 0;
    this.runtimeActivity = '';
    this.sessionListForRunningStatus = [];
    this.clearRunningSessionLease();
    this.pendingPiResourcePicker = undefined;
    this.workerWorkspace = undefined;
    this.knownSessionPaths.clear();
    this.sessionWorkspaceByPath.clear();
    this.knownPromptPaths.clear();
    this.knownResourcePaths.clear();
    this.availableProviders = [];
    this.availableProviderIds = [];
    this.availableToolNames.clear();
    this.contextFileChoices = [];
    this.contextFilesTruncated = false;
    this.pendingContextFileSelection = undefined;
    this.modelsConfigPath = '';
    this.settingsConfigPath = '';
    this.mcpConfigPath = '';
    this.activeSessionPath = '';
    this.latestSessionOpenAttempted = false;
    this.sessionInteractionStarted = false;
    this.sessionInitializationRequested = false;
    this.failPendingMcpSetting(previous);
    this.failPendingMcpServerRequests(previous);
    if (previous) this.stopWorker(previous);
    void this.ensureRuntime();
    this.publishPinnedActiveFile();
  }

  private async readCustomRuntimeEnvironment(): Promise<NodeJS.Dict<string>> {
    const names = (await this.context.secrets.keys())
      .filter((key) => key.startsWith(RUNTIME_ENV_SECRET_PREFIX))
      .map((key) => key.slice(RUNTIME_ENV_SECRET_PREFIX.length))
      .filter(isAllowedRuntimeEnvironmentName)
      .sort();
    if (names.length > MAX_RUNTIME_ENV_VARIABLES) throw new Error('Too many stored runtime environment variables.');
    const environment: NodeJS.Dict<string> = {};
    let totalChars = 0;
    for (const name of names) {
      const value = await this.context.secrets.get(`${RUNTIME_ENV_SECRET_PREFIX}${name}`);
      if (value === undefined) continue;
      if (value.length > MAX_RUNTIME_ENV_VALUE_CHARS || value.includes('\0')) {
        throw new Error(`The stored value for ${name} is invalid or too large.`);
      }
      totalChars += name.length + value.length + 1;
      if (totalChars > MAX_RUNTIME_ENV_TOTAL_CHARS) throw new Error('Stored runtime environment values exceed the size limit.');
      environment[name] = value;
    }
    return environment;
  }

  private async validateRuntimeEnvironmentSecret(name: string, value: string): Promise<void> {
    if (value.length > MAX_RUNTIME_ENV_VALUE_CHARS || value.includes('\0')) {
      throw new Error('The API key exceeds the Pi runtime environment limit.');
    }
    const names = [...new Set((await this.context.secrets.keys())
      .filter((key) => key.startsWith(RUNTIME_ENV_SECRET_PREFIX))
      .map((key) => key.slice(RUNTIME_ENV_SECRET_PREFIX.length))
      .filter(isAllowedRuntimeEnvironmentName))];
    if (!names.includes(name) && names.length >= MAX_RUNTIME_ENV_VARIABLES) {
      throw new Error(`Pi runtime environment is limited to ${MAX_RUNTIME_ENV_VARIABLES} variables.`);
    }
    let totalChars = 0;
    for (const existingName of names) {
      const existingValue = existingName === name ? value
        : await this.context.secrets.get(`${RUNTIME_ENV_SECRET_PREFIX}${existingName}`);
      if (existingValue === undefined) continue;
      if (existingValue.length > MAX_RUNTIME_ENV_VALUE_CHARS || existingValue.includes('\0')) {
        throw new Error(`The stored value for ${existingName} is invalid or too large.`);
      }
      totalChars += existingName.length + existingValue.length + 1;
      if (totalChars > MAX_RUNTIME_ENV_TOTAL_CHARS) {
        throw new Error('Pi runtime environment values exceed the total size limit.');
      }
    }
  }

  private ensureRuntime(): Promise<void> {
    if (this.runtimeStartInFlight) {
      const generation = this.runtimeStartGeneration;
      const pending = this.runtimeStartInFlight;
      return pending.then(() => {
        if (generation !== this.runtimeStartGeneration) return this.ensureRuntime();
      });
    }

    const generation = this.runtimeStartGeneration;
    const start = this.startRuntime(generation);
    const tracked = start.finally(() => {
      if (this.runtimeStartInFlight === tracked) this.runtimeStartInFlight = undefined;
      if (generation !== this.runtimeStartGeneration) void this.ensureRuntime();
    });
    this.runtimeStartInFlight = tracked;
    return tracked;
  }

  private async startRuntime(generation: number): Promise<void> {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
      this.post({ type: 'workspace', hasWorkspace: false });
      this.publishPinnedActiveFile();
      return;
    }

    const cwd = folder.uri.fsPath;
    if (this.worker && this.workerWorkspace === cwd) {
      this.post({ type: 'workspace', hasWorkspace: true, name: folder.name });
      this.refreshSessions();
      return;
    }

    const previous = this.worker;
    if (previous) this.cancelProviderAuthPrompts(previous);
    this.cancelPendingExtensionUiRequests(previous);
    this.worker = undefined;
    this.workerWorkspace = undefined;
    this.queuedWorkCount = 0;
    this.runtimeActivity = '';
    this.sessionListForRunningStatus = [];
    this.clearRunningSessionLease();
    this.pendingPiResourcePicker = undefined;
    this.failPendingMcpSetting(previous);
    this.failPendingMcpServerRequests(previous);
    if (previous) this.stopWorker(previous);
    this.knownSessionPaths.clear();
    this.sessionWorkspaceByPath.clear();
    this.knownPromptPaths.clear();
    this.knownResourcePaths.clear();
    this.availableProviders = [];
    this.availableProviderIds = [];
    this.modelsConfigPath = '';
    this.settingsConfigPath = '';
    this.mcpConfigPath = '';
    this.pendingMcpSetting = undefined;
    this.activeSessionPath = '';

    let customRuntimeEnvironment: NodeJS.Dict<string>;
    try {
      customRuntimeEnvironment = await this.readCustomRuntimeEnvironment();
    } catch {
      if (generation !== this.runtimeStartGeneration) return;
      void vscode.window.showErrorMessage('Could not load the securely stored Pi runtime environment. The Pi worker was not started.');
      return;
    }
    if (generation !== this.runtimeStartGeneration) return;

    const workerUri = vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'pi-worker.mjs');
    const configuredAgentDir = vscode.workspace.getConfiguration('piChat').get<string>('agentDir', '').trim();
    const offlineMode = readPiOfflineMode();
    const extensionUiMode = readPiExtensionUiMode();
    const workerEnv: NodeJS.Dict<string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (typeof value === 'string') workerEnv[key] = value;
    }
    for (const [name, value] of Object.entries(customRuntimeEnvironment)) {
      if (value === undefined) continue;
      if (process.platform === 'win32') {
        for (const inheritedName of Object.keys(workerEnv)) {
          if (inheritedName.toUpperCase() === name) delete workerEnv[inheritedName];
        }
      }
      workerEnv[name] = value;
    }
    if (configuredAgentDir) workerEnv.PI_CODING_AGENT_DIR = configuredAgentDir;
    if (offlineMode === 'offline') workerEnv.PI_OFFLINE = '1';
    else if (offlineMode === 'online') delete workerEnv.PI_OFFLINE;
    const environmentChars = Object.entries(workerEnv)
      .reduce((total, [key, value]) => total + key.length + (value?.length ?? 0) + 2, 1);
    if (process.platform === 'win32' && environmentChars > MAX_WINDOWS_WORKER_ENVIRONMENT_CHARS) {
      void vscode.window.showErrorMessage('The Pi worker environment is too large for Windows. Reduce inherited or custom environment variables and restart.');
      return;
    }
    let worker: Worker;
    try {
      worker = new Worker(workerUri.fsPath, {
        env: workerEnv,
        workerData: {
          cwd,
          extensionRoot: this.context.extensionUri.fsPath,
          autoNameSessions: vscode.workspace.getConfiguration('piChat.sessions').get<boolean>('autoName', true),
          autoRefreshModels: vscode.workspace.getConfiguration('piChat.models').get<boolean>('autoRefresh', false),
          mcpEnabled: vscode.workspace.getConfiguration('piChat').get<boolean>('mcp.enabled', false),
          newSessionToolNames: this.readNewSessionToolNames(),
          disabledContextFiles: this.readDisabledContextFiles(),
          extensionUiMode,
        },
      });
    } catch {
      void vscode.window.showErrorMessage('Could not start the Pi worker. Check the runtime environment settings and extension installation.');
      return;
    }
    this.workerWorkspace = cwd;
    this.worker = worker;
    this.workerAgentDirSetting = configuredAgentDir;
    this.workerOfflineModeSetting = offlineMode;
    this.workerExtensionUiModeSetting = extensionUiMode;
    this.runtimeBusy = false;
    this.queuedWorkCount = 0;
    worker.on('message', (message: RuntimeMessage) => {
      if (this.worker !== worker) return;
      if (message.type === 'extension-ui-cancel') {
        const requestId = typeof message.requestId === 'string' && message.requestId.length <= 128
          ? message.requestId
          : '';
        if (requestId && this.pendingExtensionUiRequestIds.delete(requestId)) this.post({ type: 'extension-ui-cancel', requestId });
        return;
      }
      if (message.type === 'extension-ui-request') {
        const requestId = typeof message.requestId === 'string' && message.requestId.length <= 128
          ? message.requestId
          : '';
        if (!requestId || !this.view) {
          if (requestId) worker.postMessage({ type: 'extensionUiResponse', requestId, value: undefined });
          return;
        }
        this.pendingExtensionUiRequestIds.add(requestId);
        const notifications = vscode.workspace.getConfiguration('piChat.notifications');
        const hidden = !this.view.visible;
        if (hidden && notifications.get<boolean>('inputRequired', true)) {
          void this.showChatNotification('A Pi extension is waiting for your answer.');
        }
        this.post({
          ...message,
          notificationSound: hidden && notifications.get<boolean>('sound', false),
        });
        return;
      }
      if (message.type === 'extension-ui-reset') this.pendingExtensionUiRequestIds.clear();
      if (message.type === 'runtime-error') this.recordDiagnostic('Pi runtime error');
      else if (message.type === 'notice' && message.isError === true) this.recordDiagnostic('Pi operation error');
      if (message.type === 'run-started') {
        this.runtimeBusy = true;
        this.runtimeActivity = this.safeRunningActivity(message.activity);
        this.refreshRunningSessionLease();
      } else if (message.type === 'run-finished') {
        this.runtimeBusy = false;
        this.runtimeActivity = this.queuedWorkCount > 0 ? `Queued work (${this.queuedWorkCount})` : '';
        this.refreshRunningSessionLease();
      } else if (message.type === 'activity') {
        this.runtimeActivity = this.safeRunningActivity(message.message);
        this.refreshRunningSessionLease();
      }
      if (message.type === 'queue') {
        const steering = Array.isArray(message.steering) ? message.steering.length : 0;
        const followUp = Array.isArray(message.followUp) ? message.followUp.length : 0;
        this.queuedWorkCount = Math.min(5000, steering + followUp);
        if (!this.runtimeBusy) this.runtimeActivity = this.queuedWorkCount > 0 ? `Queued work (${this.queuedWorkCount})` : '';
        this.refreshRunningSessionLease();
      }
      if (message.type === 'run-finished') void this.refreshGitChanges();
      if (message.type === 'snapshot' && typeof message.sessionFile === 'string') {
        this.activeSessionPath = message.sessionFile;
        this.refreshRunningSessionLease();
        this.post(message);
      } else if (message.type === 'run-finished') {
        const notifications = vscode.workspace.getConfiguration('piChat.notifications');
        const hidden = !this.view?.visible;
        if (!message.providerLogin && hidden && notifications.get<boolean>('runFinished', true)) {
          void this.showChatNotification('Pi finished its run.');
        }
        this.post({
          ...message,
          notificationSound: !message.providerLogin && hidden && notifications.get<boolean>('sound', false),
        });
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
      } else if (message.type === 'mcp-server-list' || message.type === 'mcp-server-update-result') {
        this.resolveMcpServerRequest(message, worker);
      } else if (message.type === 'context-files-applied' || message.type === 'context-files-failed') {
        void this.handleContextFileSelectionResult(message, worker);
      } else if (message.type === 'session-exported') {
        void this.handleSessionExport(message);
      } else if (message.type === 'sessions' && Array.isArray(message.sessions)) {
        const allSessionPaths = Array.isArray(message.sessionPaths)
          ? message.sessionPaths
          : (message.sessions as Array<Record<string, unknown>>).map((item) => item.path);
        this.knownSessionPaths = new Set(allSessionPaths
          .filter((value): value is string => typeof value === 'string' && value.length <= 4096)
          .map((value) => this.normalizeSessionPath(value)));
        const sessionItems = message.sessions as Array<Record<string, unknown>>;
        this.sessionWorkspaceByPath = new Map(sessionItems.flatMap((item): Array<[string, string]> => {
          if (typeof item.path !== 'string' || item.path.length > 4096
            || typeof item.cwd !== 'string' || !item.cwd || item.cwd.length > 4096
            || /[\u0000-\u001f\u007f]/.test(item.cwd)) return [];
          try {
            return [[this.normalizeSessionPath(item.path), item.cwd]];
          } catch {
            return [];
          }
        }));
        const pins = this.context.globalState.get<Record<string, boolean>>('piChat.pinnedSessions', {});
        const colors = this.context.globalState.get<Record<string, string>>('piChat.sessionColors', {});
        const order = this.context.globalState.get<string[]>('piChat.sessionOrder', []);
        const configuredSortOrder = vscode.workspace.getConfiguration('piChat.sessions').get<unknown>('sortOrder', 'manual');
        const sortOrder = configuredSortOrder === 'updated' || configuredSortOrder === 'name' ? configuredSortOrder : 'manual';
        const currentWorkspace = this.workerWorkspace ?? '';
        const allWorkspaces = message.allWorkspaces === true;
        const sessions: Array<Record<string, unknown>> = sessionItems
          .map((item): Record<string, unknown> => {
            const workspacePath = typeof item.cwd === 'string' && item.cwd.length <= 4096
              && !/[\u0000-\u001f\u007f]/.test(item.cwd) ? item.cwd : '';
            let isCurrentWorkspace = !allWorkspaces && !workspacePath;
            if (workspacePath && currentWorkspace) {
              try {
                isCurrentWorkspace = this.normalizeSessionPath(workspacePath) === this.normalizeSessionPath(currentWorkspace);
              } catch {
                isCurrentWorkspace = false;
              }
            }
            return {
              ...item,
              workspacePath,
              workspaceName: workspacePath ? path.basename(workspacePath).slice(0, 128) : 'Unknown workspace',
              isCurrentWorkspace,
              pinned: Boolean(pins[String(item.path ?? '')]),
              color: colors[String(item.path ?? '')] ?? 'default',
            };
          });
        const sortedSessions = sortSessionItems(sessions, order, sortOrder);
        this.sessionListForRunningStatus = sortedSessions;
        void this.refreshRunningSessionStatuses();
        this.consumePendingSessionHandoff(worker);
        this.post({
          ...message,
          sessions: sortedSessions,
          groupRunningSessions: vscode.workspace.getConfiguration('piChat.sessions').get<boolean>('groupRunning', false),
          sessionSortOrder: sortOrder,
        });
        let openingInitialSession = this.sessionInteractionStarted || Boolean(this.activeSessionPath);
        if (!openingInitialSession && this.restoredEditorSessionPath) {
          const sessionPath = this.restoredEditorSessionPath;
          this.restoredEditorSessionPath = undefined;
          let belongsToWorkspace = false;
          try {
            const cwd = this.sessionWorkspaceByPath.get(this.normalizeSessionPath(sessionPath));
            belongsToWorkspace = Boolean(cwd && this.workerWorkspace
              && this.normalizeSessionPath(cwd) === this.normalizeSessionPath(this.workerWorkspace));
          } catch {
            belongsToWorkspace = false;
          }
          if (this.isKnownSessionPath(sessionPath) && belongsToWorkspace) {
            openingInitialSession = true;
            this.sessionInteractionStarted = true;
            this.worker?.postMessage({ type: 'openSession', path: sessionPath });
          } else {
            this.post({ type: 'notice', message: 'The previous editor chat session is no longer available in this workspace. A new session will open.' });
          }
        }
        if (!openingInitialSession) {
          let openingLatestSession = false;
          if (this.openLatestSessionOnStart && !this.latestSessionOpenAttempted) {
            this.latestSessionOpenAttempted = true;
            const latest = sessions
              .filter((item) => item['isCurrentWorkspace'] === true && this.isKnownSessionPath(item['path']))
              .reduce<Record<string, unknown> | undefined>((current, item) =>
                !current || Number(item['modified'] ?? 0) > Number(current['modified'] ?? 0) ? item : current, undefined);
            if (latest && typeof latest['path'] === 'string') {
              openingLatestSession = true;
              this.sessionInteractionStarted = true;
              this.worker?.postMessage({ type: 'openSession', path: latest['path'] });
            }
          }
          if (!openingLatestSession && !this.sessionInitializationRequested) {
            this.sessionInitializationRequested = true;
            this.worker?.postMessage({ type: 'initializeSession' });
          }
        }
      } else if (message.type === 'extension-status') {
        this.updateExtensionStatus(message);
        this.post(message);
      } else if (message.type === 'extension-chrome-reset') {
        this.extensionStatuses.clear();
        this.updateExtensionStatusBar();
        this.post(message);
      } else if (message.type === 'pi-resources') {
        const pending = this.pendingPiResourcePicker;
        if (!pending || pending.worker !== worker || pending.requestId !== message.requestId) return;
        this.pendingPiResourcePicker = undefined;
        void this.openPiResourcePicker(worker, message);
      } else if (message.type === 'options') {
        const runtimeSettings = message.runtimeSettings && typeof message.runtimeSettings === 'object'
          ? message.runtimeSettings as Record<string, unknown>
          : {};
        this.availableToolNames = new Set(Array.isArray(message.tools)
          ? (message.tools as Array<Record<string, unknown>>).slice(0, 1000).flatMap((tool) =>
            typeof tool.name === 'string' && tool.name.length > 0 && tool.name.length <= 128
              && !/[\u0000-\u001f\u007f]/.test(tool.name)
              ? [tool.name]
              : [])
          : []);
        this.availableProviderIds = Array.isArray(message.providerIds)
          ? [...new Set(message.providerIds.filter((providerId): providerId is string => typeof providerId === 'string'
            && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(providerId)))].slice(0, 500)
          : [];
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
        this.contextFileChoices = Array.isArray(message.contextFiles)
          ? (message.contextFiles as Array<Record<string, unknown>>).slice(0, 500).flatMap((item) => {
            if (typeof item.path !== 'string' || item.path.length > 4096 || !path.isAbsolute(item.path)
              || /[\u0000-\u001f\u007f]/.test(item.path) || typeof item.enabled !== 'boolean') return [];
            return [{ path: item.path, enabled: item.enabled }];
          })
          : [];
        this.contextFilesTruncated = message.contextFilesTruncated === true;
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
        const {
          modelsConfigPath: _modelsConfigPath,
          settingsConfigPath: _settingsConfigPath,
          mcpConfigPath: _mcpConfigPath,
          contextFiles: _contextFiles,
          contextFilesTruncated: _contextFilesTruncated,
          ...safeMessage
        } = message;
        this.post({
          ...safeMessage,
          runtimeSettings: { ...runtimeSettings, offlineMode: readPiOfflineMode() },
          notificationSound: vscode.workspace.getConfiguration('piChat.notifications').get<boolean>('sound', false),
          autoRefreshModels: vscode.workspace.getConfiguration('piChat.models').get<boolean>('autoRefresh', false),
          expandSuccessfulToolCalls: vscode.workspace.getConfiguration('piChat.transcript').get<boolean>('expandSuccessfulToolCalls', false),
          presets: this.context.workspaceState.get<ModelPreset[]>('piChat.modelPresets', []),
        });
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
        this.runtimeBusy = false;
        this.queuedWorkCount = 0;
        this.runtimeActivity = '';
        this.clearRunningSessionLease();
        this.pendingExtensionUiRequestIds.clear();
        this.pendingPiResourcePicker = undefined;
        this.cancelProviderAuthPrompts(worker);
        this.extensionStatuses.clear();
        this.updateExtensionStatusBar();
        this.post({ type: 'extension-chrome-reset' });
      }
      this.failPendingMcpSetting(worker);
      this.failPendingMcpServerRequests(worker);
      if (this.workerWorkspace === cwd && code !== 0) {
        this.recordDiagnostic('Pi worker exited unexpectedly');
        this.post({ type: 'runtime-error', message: `The Pi runtime exited with code ${code}.` });
      }
    });

    this.post({ type: 'workspace', hasWorkspace: true, name: folder.name });
    this.publishPinnedActiveFile();
  }

  private getPinnedExtensionWidgetKeys(): string[] {
    const value = this.context.globalState.get<unknown>(PINNED_EXTENSION_WIDGETS_KEY);
    if (!Array.isArray(value)) return [];
    return [...new Set(value.filter((key): key is string => typeof key === 'string'
      && key.length > 0 && key.length <= 128 && !/[\u0000-\u001f\u007f]/.test(key)))].slice(0, MAX_PINNED_EXTENSION_WIDGETS);
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
        this.sessionSearchAllWorkspaces = message.allWorkspaces === true;
        await this.savedDraftsWrite;
        this.post({ type: 'saved-drafts', drafts: draftStore.normalizeStore(this.context.globalState.get<unknown>('piChat.savedDrafts')) });
        this.post({ type: 'extension-widget-pins', keys: this.getPinnedExtensionWidgetKeys() });
        this.postExtensionStatusPreferences();
        await this.ensureRuntime();
        this.refreshSessions();
        this.worker?.postMessage({ type: 'listPackages' });
        await this.refreshGitChanges();
        this.publishPinnedActiveFile();
        return;
      case 'saveSavedDrafts': {
        const requestId = typeof message.requestId === 'string' && /^[a-f0-9]{24}$/.test(message.requestId)
          ? message.requestId
          : '';
        if (!requestId) return;
        const drafts = draftStore.normalizeStore(message.drafts);
        this.savedDraftsWrite = this.savedDraftsWrite.then(async () => {
          try {
            await this.context.globalState.update('piChat.savedDrafts', Object.fromEntries(Object.entries(drafts)));
            this.post({ type: 'saved-drafts-saved', requestId });
          } catch {
            this.post({ type: 'saved-drafts-save-failed', requestId });
          }
        });
        await this.savedDraftsWrite;
        return;
      }
      case 'searchPiPackages':
        await this.searchPiPackages(message);
        return;
      case 'cancelPiPackageSearch':
        this.cancelPackageSearch(true);
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
      case 'trashUntrackedGitChange':
        await this.trashUntrackedGitChange(message.path);
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
        this.sessionSearchAllWorkspaces = message.allWorkspaces === true;
        this.refreshSessions();
        return;
      case 'toggleSessionPin': {
        if (!this.isKnownSessionPath(message.path)) return;
        const pins = this.context.globalState.get<Record<string, boolean>>('piChat.pinnedSessions', {});
        const next = { ...pins };
        if (next[message.path]) delete next[message.path];
        else next[message.path] = true;
        await this.context.globalState.update('piChat.pinnedSessions', next);
        this.refreshSessions();
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
        this.refreshSessions();
        return;
      }
      case 'reorderSessions': {
        if (!Array.isArray(message.paths)) return;
        const prior = this.context.globalState.get<string[]>('piChat.sessionOrder', []);
        const proposed = message.paths.slice(0, 5000).filter((item): item is string => this.isKnownSessionPath(item));
        const visible = new Set(proposed);
        const order = [...proposed, ...prior.filter((item) => this.isKnownSessionPath(item) && !visible.has(item))];
        await this.context.globalState.update('piChat.sessionOrder', order);
        this.refreshSessions();
        return;
      }
      case 'setSessionSortOrder': {
        const sortOrder = message.sortOrder;
        if (sortOrder !== 'manual' && sortOrder !== 'updated' && sortOrder !== 'name') return;
        try {
          await vscode.workspace.getConfiguration('piChat.sessions').update(
            'sortOrder', sortOrder, vscode.ConfigurationTarget.Global,
          );
          this.refreshSessions();
        } catch (error) {
          this.post({ type: 'notice', message: error instanceof Error ? error.message : 'Could not save the session order preference.', isError: true });
        }
        return;
      }
      case 'setGroupRunningSessions': {
        if (typeof message.enabled !== 'boolean') return;
        try {
          await vscode.workspace.getConfiguration('piChat.sessions').update(
            'groupRunning', message.enabled, vscode.ConfigurationTarget.Global,
          );
          this.post({ type: 'session-grouping-setting', enabled: message.enabled });
        } catch (error) {
          this.post({ type: 'notice', message: error instanceof Error ? error.message : 'Could not save the session grouping preference.', isError: true });
        }
        return;
      }
      case 'setSuccessfulToolExpansion': {
        if (typeof message.enabled !== 'boolean') return;
        try {
          await vscode.workspace.getConfiguration('piChat.transcript').update(
            'expandSuccessfulToolCalls', message.enabled, vscode.ConfigurationTarget.Global,
          );
          this.post({ type: 'tool-expansion-default-setting', enabled: message.enabled });
        } catch (error) {
          this.post({ type: 'notice', message: error instanceof Error ? error.message : 'Could not save the tool-card display preference.', isError: true });
        }
        return;
      }
      case 'renameSession': {
        if (!this.isKnownSessionPath(message.path)) {
          this.post({ type: 'notice', message: 'That session is not in the current workspace session list.', isError: true });
          return;
        }
        if (await this.isSessionRunning(message.path)) {
          this.post({ type: 'notice', message: 'Wait for this Pi session to finish in its other window before renaming it.', isError: true });
          return;
        }
        const name = await vscode.window.showInputBox({
          prompt: 'Name this Pi session',
          placeHolder: 'Session name',
          value: typeof message.currentName === 'string' ? message.currentName : '',
        });
        if (name !== undefined && this.isKnownSessionPath(message.path) && !await this.isSessionRunning(message.path)) {
          this.worker?.postMessage({ type: 'renameSession', path: message.path, name: name.slice(0, 160) });
        }
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
        if (await this.isSessionRunning(message.path)) {
          this.post({ type: 'notice', message: 'Wait for this Pi session to finish in its other window before deleting it.', isError: true });
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
        if (!this.isKnownSessionPath(message.path) || await this.isSessionRunning(message.path)
          || this.normalizeSessionPath(message.path) === this.normalizeSessionPath(this.activeSessionPath)) {
          this.post({ type: 'notice', message: 'The session changed or began running while confirmation was open. Refresh history and try again.', isError: true });
          return;
        }
        await vscode.workspace.fs.delete(vscode.Uri.file(message.path));
        this.refreshSessions();
        return;
      }
      case 'openSession':
        this.sessionInteractionStarted = true;
        if (!this.isKnownSessionPath(message.path)) {
          this.post({ type: 'notice', message: 'That session is no longer in the session list. Refresh history and try again.', isError: true });
          return;
        }
        try {
          const targetCwd = this.sessionWorkspaceByPath.get(this.normalizeSessionPath(message.path));
          if (targetCwd && this.workerWorkspace
            && this.normalizeSessionPath(targetCwd) !== this.normalizeSessionPath(this.workerWorkspace)) {
            await this.openSessionInWorkspace(message.path, targetCwd);
            return;
          }
          if (!targetCwd && this.sessionSearchAllWorkspaces) {
            this.post({ type: 'notice', message: 'This older Pi session does not record its workspace path, so it cannot be opened safely from global search.', isError: true });
            return;
          }
          this.worker?.postMessage({ type: 'openSession', path: message.path });
        } catch {
          this.post({ type: 'notice', message: 'Could not open this Pi session. Refresh history and try again.', isError: true });
        }
        return;
      case 'stop':
        this.worker?.postMessage({ type: 'stop' });
        return;
      case 'stopSubagentChild': {
        const worker = this.worker;
        const requestId = typeof message.requestId === 'string' ? message.requestId : '';
        const toolCallId = typeof message.toolCallId === 'string' ? message.toolCallId : '';
        const runId = typeof message.runId === 'string' ? message.runId : '';
        const childId = typeof message.childId === 'string' ? message.childId : '';
        const sessionPath = typeof message.sessionPath === 'string' ? message.sessionPath : '';
        const validRequestId = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestId);
        const safeId = (value: string, maxLength: number) => value.length > 0 && value.length <= maxLength
          && !/[\u0000-\u001f\u007f]/.test(value);
        const valid = Boolean(worker && validRequestId
          && safeId(toolCallId, 256) && safeId(runId, 256)
          && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(childId)
          && safeId(sessionPath, 4096) && safeId(this.activeSessionPath, 4096)
          && (() => {
            try {
              return this.normalizeSessionPath(sessionPath) === this.normalizeSessionPath(this.activeSessionPath);
            } catch {
              return false;
            }
          })());
        if (!valid || !worker) {
          if (validRequestId) this.post({
            type: 'subagent-child-stop-result',
            requestId,
            success: false,
            message: 'This child task is no longer available to stop. Refresh the chat and try again.',
          });
          return;
        }
        worker.postMessage({ type: 'stopSubagentChild', requestId, toolCallId, runId, childId, sessionPath });
        return;
      }
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
      case 'openSymbol':
        await this.openWorkspaceSymbol(message.name);
        return;
      case 'openDiagram':
        this.openDiagramPanel(message.svg);
        return;
      case 'setNewChatToolDefault': {
        const requested = Array.isArray(message.toolNames) ? message.toolNames : undefined;
        if (!requested || requested.length > 256
          || requested.some((name) => typeof name !== 'string' || name.length === 0 || name.length > 128 || /[\u0000-\u001f\u007f]/.test(name))) {
          this.post({ type: 'notice', message: 'The new-chat tool selection was invalid.', isError: true });
          return;
        }
        const usePiDefaults = requested.length === 1 && requested[0] === '*';
        const names = [...new Set(requested as string[])];
        if (!usePiDefaults && (names.includes('*') || names.some((name) => !this.availableToolNames.has(name)))) {
          this.post({ type: 'notice', message: 'Refresh the Pi tools and try saving the new-chat selection again.', isError: true });
          return;
        }
        try {
          await vscode.workspace.getConfiguration('piChat.tools').update(
            'defaultToolNames',
            usePiDefaults ? ['*'] : names,
            vscode.ConfigurationTarget.Global,
          );
          this.worker?.postMessage({ type: 'setNewChatToolDefault', toolNames: usePiDefaults ? ['*'] : names });
          this.post({ type: 'notice', message: usePiDefaults ? 'New chats will use Pi’s configured default tools.' : 'New chats will use this tool selection.' });
        } catch (error) {
          this.post({ type: 'notice', message: error instanceof Error ? error.message : 'Could not save the new-chat tool selection.', isError: true });
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
        this.worker?.postMessage(message);
        return;
      case 'extensionUiResponse':
        if (typeof message.requestId !== 'string' || !this.pendingExtensionUiRequestIds.delete(message.requestId)) return;
        this.worker?.postMessage(message);
        return;
      case 'extensionCustomInput': {
        const requestId = typeof message.requestId === 'string' && /^pi-custom-\d{1,12}$/.test(message.requestId)
          ? message.requestId
          : '';
        if (!requestId) return;
        if (typeof message.data === 'string' && message.data.length <= 32) {
          this.worker?.postMessage({ type: 'extensionCustomInput', requestId, data: message.data });
          return;
        }
        if (!message.mouse || typeof message.mouse !== 'object' || Array.isArray(message.mouse)) return;
        const mouse = message.mouse as Record<string, unknown>;
        this.worker?.postMessage({
          type: 'extensionCustomInput',
          requestId,
          mouse: {
            type: typeof mouse.type === 'string' ? mouse.type.slice(0, 16) : '',
            button: typeof mouse.button === 'string' ? mouse.button.slice(0, 16) : '',
            x: mouse.x,
            y: mouse.y,
            width: mouse.width,
            height: mouse.height,
            shift: mouse.shift === true,
            alt: mouse.alt === true,
            ctrl: mouse.ctrl === true,
            wheelDelta: mouse.wheelDelta,
            clickCount: mouse.clickCount,
          },
        });
        return;
      }
      case 'extensionCustomCancel':
        if (typeof message.requestId === 'string' && /^pi-custom-\d{1,12}$/.test(message.requestId)) {
          this.worker?.postMessage({ type: 'extensionCustomCancel', requestId: message.requestId });
        }
        return;
      case 'extensionEditorSync':
        if (typeof message.text === 'string' && message.text.length <= 100_000) {
          this.worker?.postMessage({ type: 'extensionEditorSync', text: message.text });
        }
        return;
      case 'extensionEditorSetText':
        if (typeof message.requestId === 'string' && /^pi-editor-\d{1,12}$/.test(message.requestId)
          && typeof message.text === 'string' && message.text.length <= 100_000) {
          this.worker?.postMessage({ type: 'extensionEditorSetText', requestId: message.requestId, text: message.text });
        }
        return;
      case 'extensionEditorPaste':
      case 'extensionEditorInput': {
        const requestId = typeof message.requestId === 'string' && /^pi-editor-\d{1,12}$/.test(message.requestId)
          ? message.requestId
          : '';
        if (!requestId) return;
        if (message.type === 'extensionEditorPaste') {
          if (typeof message.text === 'string' && message.text.length <= 50_000) {
            this.worker?.postMessage({ type: 'extensionEditorPaste', requestId, text: message.text });
          }
          return;
        }
        if (typeof message.data === 'string' && message.data.length <= 32) {
          this.worker?.postMessage({ type: 'extensionEditorInput', requestId, data: message.data });
          return;
        }
        if (!message.mouse || typeof message.mouse !== 'object' || Array.isArray(message.mouse)) return;
        const mouse = message.mouse as Record<string, unknown>;
        this.worker?.postMessage({
          type: 'extensionEditorInput',
          requestId,
          mouse: {
            type: typeof mouse.type === 'string' ? mouse.type.slice(0, 16) : '',
            button: typeof mouse.button === 'string' ? mouse.button.slice(0, 16) : '',
            x: mouse.x,
            y: mouse.y,
            width: mouse.width,
            height: mouse.height,
            shift: mouse.shift === true,
            alt: mouse.alt === true,
            ctrl: mouse.ctrl === true,
            wheelDelta: mouse.wheelDelta,
            clickCount: mouse.clickCount,
          },
        });
        return;
      }
      case 'extensionWidgetInput': {
        const requestId = typeof message.requestId === 'string' && /^pi-widget-\d{1,12}$/.test(message.requestId)
          ? message.requestId
          : '';
        if (!requestId) return;
        if (message.paste === true) {
          if (typeof message.data === 'string' && message.data.length <= 50_000) {
            this.worker?.postMessage({ type: 'extensionWidgetInput', requestId, data: message.data, paste: true });
          }
          return;
        }
        if (typeof message.data === 'string' && message.data.length <= 32) {
          this.worker?.postMessage({ type: 'extensionWidgetInput', requestId, data: message.data });
          return;
        }
        if (!message.mouse || typeof message.mouse !== 'object' || Array.isArray(message.mouse)) return;
        const mouse = message.mouse as Record<string, unknown>;
        this.worker?.postMessage({
          type: 'extensionWidgetInput',
          requestId,
          mouse: {
            type: typeof mouse.type === 'string' ? mouse.type.slice(0, 16) : '',
            button: typeof mouse.button === 'string' ? mouse.button.slice(0, 16) : '',
            x: mouse.x,
            y: mouse.y,
            width: mouse.width,
            height: mouse.height,
            shift: mouse.shift === true,
            alt: mouse.alt === true,
            ctrl: mouse.ctrl === true,
            wheelDelta: mouse.wheelDelta,
            clickCount: mouse.clickCount,
          },
        });
        return;
      }
      case 'setExtensionWidgetPinned': {
        const key = typeof message.key === 'string' && message.key.length > 0 && message.key.length <= 128
          && !/[\u0000-\u001f\u007f]/.test(message.key) ? message.key : '';
        if (!key || typeof message.pinned !== 'boolean') return;
        const keys = this.getPinnedExtensionWidgetKeys();
        const next = message.pinned
          ? (keys.includes(key) ? keys : keys.length < MAX_PINNED_EXTENSION_WIDGETS ? [...keys, key] : keys)
          : keys.filter((entry) => entry !== key);
        if (next.length !== keys.length || next.some((entry, index) => entry !== keys[index])) {
          try {
            await this.context.globalState.update(PINNED_EXTENSION_WIDGETS_KEY, next);
          } catch {
            this.post({ type: 'notice', message: 'Could not save the extension widget pin.', isError: true });
            this.post({ type: 'extension-widget-pins', keys });
            return;
          }
        }
        this.post({ type: 'extension-widget-pins', keys: next });
        return;
      }
      case 'navigateTree':
      case 'editUserMessage':
      case 'setMessageContext':
      case 'editMessageContext':
      case 'completeExtensionCommand':
        this.worker?.postMessage(message);
        return;
      case 'renderSavedToolCall':
        if (typeof message.toolCallId === 'string' && message.toolCallId.length <= 256
          && !/[\u0000-\u001f\u007f]/.test(message.toolCallId)
          && typeof message.sessionPath === 'string' && message.sessionPath.length <= 4096
          && !/[\u0000-\u001f\u007f]/.test(message.sessionPath)) {
          this.worker?.postMessage({ type: 'renderSavedToolCall', toolCallId: message.toolCallId, sessionPath: message.sessionPath });
        }
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
        const valid = ((message.setting === 'autoCompaction' || message.setting === 'autoRetry'
          || message.setting === 'hideThinkingBlock' || message.setting === 'showCacheMissNotices'
          || message.setting === 'enableInstallTelemetry')
          && typeof message.value === 'boolean')
          || (message.setting === 'cacheWarming'
            && (message.value === 'off' || message.value === 'streaming' || message.value === 'idle'))
          || (message.setting === 'steeringMode'
            && (message.value === 'all' || message.value === 'one-at-a-time'))
          || (message.setting === 'followUpMode'
            && (message.value === 'all' || message.value === 'one-at-a-time'))
          || (message.setting === 'sessionShareDestination'
            && (message.value === 'auto' || message.value === 'gist' || message.value === 'radius'));
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
      case 'managePiResources': {
        const worker = this.worker;
        if (!worker) return;
        if (this.pendingPiResourcePicker) {
          this.post({ type: 'notice', message: 'The Pi resource list is already opening.' });
          return;
        }
        const requestId = randomBytes(16).toString('hex');
        this.pendingPiResourcePicker = { worker, requestId };
        worker.postMessage({ type: 'listPiResources', requestId });
        return;
      }
      case 'manageContextFiles':
        await this.manageContextFiles();
        return;
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
      case 'addCustomEndpoint':
        await this.addCustomEndpoint();
        return;
      case 'openPiSettings':
        await this.openPiSettings();
        return;
      case 'choosePiAgentDir':
        await this.chooseAgentDir();
        return;
      case 'restartPiRuntime':
        await this.restartPiRuntime();
        return;
      case 'setPiOfflineMode':
        await this.setPiOfflineMode(message);
        return;
      case 'setNotificationSound':
        if (typeof message.enabled === 'boolean') {
          await vscode.workspace.getConfiguration('piChat.notifications').update('sound', message.enabled, vscode.ConfigurationTarget.Global);
        }
        return;
      case 'setAutoRefreshModels':
        await this.setAutoRefreshModels(message);
        return;
      case 'openMcpConfig':
        await this.openMcpConfig();
        return;
      case 'manageMcpServers':
        await this.manageMcpServers();
        return;
      case 'suggestFollowUps': {
        const worker = this.worker;
        const entryId = typeof message.entryId === 'string' ? message.entryId : '';
        const requestId = typeof message.requestId === 'string' && /^[a-f0-9]{24}$/.test(message.requestId) ? message.requestId : '';
        if (!entryId || entryId.length > 256 || /[\u0000-\u001f\u007f]/.test(entryId) || !requestId) return;
        if (!worker || this.runtimeBusy || this.queuedWorkCount > 0) {
          this.post({ type: 'prompt-suggestions-result', requestId, entryId, suggestions: [], error: 'Finish current and queued Pi work before generating suggestions.' });
          return;
        }
        worker.postMessage({ type: 'suggestFollowUps', entryId, requestId });
        return;
      }
      case 'cancelPromptSuggestions': {
        const requestId = typeof message.requestId === 'string' && /^[a-f0-9]{24}$/.test(message.requestId) ? message.requestId : '';
        if (requestId) this.worker?.postMessage({ type: 'cancelPromptSuggestions', requestId });
        return;
      }
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

  private async openPiResourcePicker(worker: Worker, message: RuntimeMessage): Promise<void> {
    if (this.worker !== worker) return;
    if (message.available !== true) {
      this.post({ type: 'notice', message: 'Pi could not read the configured resources. Refresh Pi resources and try again.', isError: true });
      return;
    }
    const resources: PiResourceChoice[] = Array.isArray(message.resources)
      ? message.resources.slice(0, 500).flatMap((value): PiResourceChoice[] => {
        if (!value || typeof value !== 'object') return [];
        const item = value as Record<string, unknown>;
        if (typeof item.id !== 'string' || !/^[a-f0-9]{24}$/.test(item.id)
          || !['extensions', 'skills', 'prompts', 'themes'].includes(String(item.type))
          || (item.scope !== 'user' && item.scope !== 'project')
          || typeof item.enabled !== 'boolean'
          || typeof item.label !== 'string' || typeof item.sourceLabel !== 'string' || typeof item.pattern !== 'string') return [];
        return [{
          id: item.id,
          type: item.type as PiResourceType,
          scope: item.scope,
          enabled: item.enabled,
          label: item.label.slice(0, 160),
          description: `${item.type} · ${item.scope} settings · ${item.enabled ? 'enabled' : 'disabled'}`,
          detail: `${item.sourceLabel.slice(0, 180)} · ${item.pattern.slice(0, 512)}`,
          picked: item.enabled,
        }];
      })
      : [];
    if (!resources.length) {
      this.post({ type: 'notice', message: 'No configurable Pi resources were found in the trusted settings.' });
      return;
    }
    const selected = await vscode.window.showQuickPick(resources, {
      canPickMany: true,
      ignoreFocusOut: true,
      matchOnDescription: true,
      matchOnDetail: true,
      title: 'Configure Pi resources',
      placeHolder: 'Checked resources are enabled. Changes apply after reloading Pi resources.',
    });
    if (selected === undefined || this.worker !== worker) return;
    const selectedIds = new Set(selected.map((item) => item.id));
    const changes = resources
      .filter((item) => item.enabled !== selectedIds.has(item.id))
      .map((item) => ({ id: item.id, enabled: selectedIds.has(item.id), expectedEnabled: item.enabled }));
    if (!changes.length) return;
    const enablingExtensions = changes.filter((change) => change.enabled
      && resources.some((item) => item.id === change.id && item.type === 'extensions')).length;
    if (enablingExtensions) {
      const answer = await vscode.window.showWarningMessage(
        `Enable ${enablingExtensions} Pi extension${enablingExtensions === 1 ? '' : 's'}? The settings will be saved now; extension code runs only after Pi resources are reloaded or a new session starts.`,
        { modal: true },
        'Save resource settings',
      );
      if (answer !== 'Save resource settings' || this.worker !== worker) return;
    }
    worker.postMessage({ type: 'setPiResourceStates', resourceChanges: changes });
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
    const worker = this.worker;
    const workspace = vscode.workspace.workspaceFolders?.[0];
    if (!workspace) {
      worker?.postMessage({ type: 'setGitBranch', gitBranch: null });
      this.post({ type: 'git-changes', available: false, message: 'Open a workspace to review Git changes.', files: [] });
      return;
    }
    try {
      const handle = await this.getGitRepository(workspace);
      if (worker !== this.worker || this.workerWorkspace !== workspace.uri.fsPath) return;
      if (!handle) {
        worker?.postMessage({ type: 'setGitBranch', gitBranch: null });
        this.post({ type: 'git-changes', available: false, message: 'This workspace is not inside a Git repository.', files: [] });
        return;
      }
      const { repository } = handle;
      await repository.status?.();
      if (worker !== this.worker || this.workerWorkspace !== workspace.uri.fsPath) return;
      const state = repository.state;
      const files = new Map<string, GitFileStatus>();
      const add = (changes: GitChangeRecord[] | undefined, label: string, canDiscard = false) => {
        for (const change of (changes ?? []).slice(0, MAX_GIT_REVIEW_FILES)) {
          const uri = change.uri ?? change.resourceUri;
          const relativePath = uri ? this.workspaceRelativePath(uri, workspace) : undefined;
          if (!relativePath) continue;
          let item = files.get(relativePath);
          if (!item) {
            item = { path: relativePath.slice(0, 4096), status: [], canDiscard: false, isUntracked: false, canMoveToTrash: false };
            files.set(relativePath, item);
          }
          if (!item.status.includes(label)) item.status.push(label);
          if (label === 'Untracked') {
            item.isUntracked = true;
            item.canMoveToTrash = true;
          }
          if (canDiscard && !item.isUntracked) item.canDiscard = true;
        }
      };
      add(state.indexChanges, 'Staged');
      add(state.workingTreeChanges, 'Modified', true);
      add(state.untrackedChanges, 'Untracked');
      add(state.mergeChanges, 'Conflict');
      for (const item of files.values()) {
        if (item.status.includes('Conflict')) {
          item.canDiscard = false;
          item.canMoveToTrash = false;
        }
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
      if (worker === this.worker && this.workerWorkspace === workspace.uri.fsPath) {
        const gitBranch = head?.name;
        worker?.postMessage({ type: 'setGitBranch', gitBranch: typeof gitBranch === 'string' ? gitBranch.slice(0, 200) : null });
      }
      this.post({
        type: 'git-changes',
        available: true,
        summary,
        files: [...files.values()].slice(0, MAX_GIT_REVIEW_FILES),
        truncated: files.size > MAX_GIT_REVIEW_FILES,
      });
    } catch (error) {
      if (worker !== this.worker || this.workerWorkspace !== workspace.uri.fsPath) return;
      worker?.postMessage({ type: 'setGitBranch', gitBranch: null });
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

  private async inspectSafeUntrackedFile(target: {
    workspace: vscode.WorkspaceFolder;
    repository: GitRepositoryLike;
    uri: vscode.Uri;
  }): Promise<{ dev: number; ino: number; realPath: string } | undefined> {
    if (target.uri.scheme !== 'file') return undefined;
    const stats = await lstat(target.uri.fsPath);
    if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink > 1) return undefined;
    const [filePath, repositoryPath, workspacePath] = await Promise.all([
      realpath(target.uri.fsPath),
      realpath(target.repository.rootUri.fsPath),
      realpath(target.workspace.uri.fsPath),
    ]);
    if (!isPathInside(repositoryPath, filePath) || !isPathInside(workspacePath, filePath)) return undefined;
    const resolvedStats = await lstat(filePath);
    if (!resolvedStats.isFile() || resolvedStats.isSymbolicLink() || resolvedStats.nlink > 1
      || resolvedStats.dev !== stats.dev || resolvedStats.ino !== stats.ino) return undefined;
    return { dev: resolvedStats.dev, ino: resolvedStats.ino, realPath: filePath };
  }

  private async trashUntrackedGitChange(value: unknown): Promise<void> {
    try {
      const target = await this.findCurrentGitChange(value);
      if (!target || !target.isUntracked) {
        this.post({ type: 'notice', message: 'That file is no longer an untracked Git change. Refresh the list and try again.', isError: true });
        await this.refreshGitChanges();
        return;
      }
      const identity = await this.inspectSafeUntrackedFile(target);
      if (!identity) {
        this.post({ type: 'notice', message: 'Only regular untracked files inside the workspace can be moved to Trash. Directories, symlinks, and hard-linked files are not eligible.', isError: true });
        await this.refreshGitChanges();
        return;
      }
      const hasDirtyDocument = (realPath: string) => {
        const filePaths = new Set([target.uri.fsPath, realPath].map((filePath) => this.normalizeSessionPath(filePath)));
        return vscode.workspace.textDocuments.some((document) => document.isDirty
          && document.uri.scheme === 'file'
          && filePaths.has(this.normalizeSessionPath(document.uri.fsPath)));
      };
      if (hasDirtyDocument(identity.realPath)) {
        this.post({ type: 'notice', message: 'Save or discard the open file’s unsaved changes before moving it to Trash.', isError: true });
        return;
      }
      const answer = await vscode.window.showWarningMessage(
        `Remove untracked file ${target.relativePath}? VS Code will request the operating system’s Trash/Recycle Bin when supported; a file system without Trash support may delete it permanently. Git cannot restore it because it has not been committed.`,
        { modal: true },
        'Remove untracked file',
      );
      if (answer !== 'Remove untracked file') return;

      const current = await this.findCurrentGitChange(target.relativePath);
      if (!current || !current.isUntracked
        || this.normalizeSessionPath(current.uri.fsPath) !== this.normalizeSessionPath(target.uri.fsPath)
        || this.normalizeSessionPath(current.repository.rootUri.fsPath) !== this.normalizeSessionPath(target.repository.rootUri.fsPath)) {
        this.post({ type: 'notice', message: 'The Git state or open file changed while confirmation was open. Nothing was moved.', isError: true });
        await this.refreshGitChanges();
        return;
      }
      const currentIdentity = await this.inspectSafeUntrackedFile(current);
      if (!currentIdentity || currentIdentity.dev !== identity.dev || currentIdentity.ino !== identity.ino
        || this.normalizeSessionPath(currentIdentity.realPath) !== this.normalizeSessionPath(identity.realPath)) {
        this.post({ type: 'notice', message: 'The file changed while confirmation was open. Nothing was moved; refresh the Git list and try again.', isError: true });
        await this.refreshGitChanges();
        return;
      }
      if (hasDirtyDocument(currentIdentity.realPath)) {
        this.post({ type: 'notice', message: 'The file became unsaved while confirmation was open. Save it before moving it to Trash.', isError: true });
        return;
      }
      await vscode.workspace.fs.delete(vscode.Uri.file(currentIdentity.realPath), { useTrash: true });
      await this.refreshGitChanges();
    } catch {
      this.post({ type: 'notice', message: 'Could not remove the untracked file. Review its current state and refresh Git status.', isError: true });
      await this.refreshGitChanges();
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

  async manageMcpServers(): Promise<void> {
    if (this.mcpServerManagementInFlight) return;
    const worker = this.worker;
    if (!worker || !this.activeSessionPath) {
      void vscode.window.showInformationMessage('Open a Pi session before managing MCP servers.');
      return;
    }
    if (this.runtimeBusy || this.queuedWorkCount > 0) {
      void vscode.window.showInformationMessage('Finish the current and queued Pi work before changing MCP servers.');
      return;
    }
    this.mcpServerManagementInFlight = true;
    try {
      const response = await this.requestMcpServerWorker(worker, 'listMcpServers');
      if (!response || this.worker !== worker) {
        void vscode.window.showErrorMessage('Pi did not return the MCP server list. Try again.');
        return;
      }
      if (response.error) {
        void vscode.window.showErrorMessage(typeof response.error === 'string' ? response.error.slice(0, 300) : 'Could not read the Pi MCP server list.');
        return;
      }
      const servers = Array.isArray(response.servers) ? response.servers.slice(0, 500).flatMap((value): McpServerChoice[] => {
        if (!value || typeof value !== 'object') return [];
        const item = value as Record<string, unknown>;
        if (typeof item.name !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(item.name)
          || typeof item.enabled !== 'boolean'
          || !['codemode', 'deferred', 'direct', 'hidden'].includes(String(item.exposure))
          || (item.scope !== 'global' && item.scope !== 'project')
          || !['stdio', 'http', 'unknown'].includes(String(item.transport))) return [];
        return [{
          name: item.name,
          enabled: item.enabled,
          exposure: item.exposure as McpServerChoice['exposure'],
          scope: item.scope,
          hasOverride: item.hasOverride === true,
          transport: item.transport as McpServerChoice['transport'],
          ...(typeof item.globalEnabled === 'boolean' ? { globalEnabled: item.globalEnabled } : {}),
          ...(['codemode', 'deferred', 'direct', 'hidden'].includes(String(item.globalExposure))
            ? { globalExposure: item.globalExposure as McpServerChoice['exposure'] }
            : {}),
        }];
      }) : [];
      if (servers.length === 0) {
        void vscode.window.showInformationMessage('No configured MCP servers are available in this Pi session.');
        return;
      }
      const selected = await vscode.window.showQuickPick(servers.map((server) => ({
        label: server.name,
        description: `${server.enabled ? 'Enabled' : 'Disabled'} · ${server.exposure} · ${server.scope === 'project' ? 'workspace config' : 'user config'}${server.hasOverride ? ' · workspace override' : ''} · ${server.transport}`,
        server,
      })), { placeHolder: 'Choose a configured MCP server', title: 'Pi Chat: Manage MCP Servers', matchOnDescription: true });
      if (!selected || this.worker !== worker) return;

      const action = await vscode.window.showQuickPick([
        { label: selected.server.enabled ? 'Disable this server' : 'Enable this server', description: 'Save its connection state', action: 'enabled' as const },
        { label: 'Change tool exposure…', description: 'Choose how Pi can make its tools available', action: 'exposure' as const },
      ] as Array<vscode.QuickPickItem & { action: 'enabled' | 'exposure' }>, { placeHolder: `Choose a setting for ${selected.server.name}` });
      if (!action || this.worker !== worker) return;

      const trusted = response.projectTrusted === true;
      const scopeChoices: Array<{ label: string; description: string; value: 'global' | 'project' }> = [];
      if (selected.server.scope === 'project') {
        scopeChoices.push({ label: 'This workspace', description: 'Change the project Pi MCP configuration', value: 'project' });
      } else {
        scopeChoices.push({
          label: 'User configuration',
          description: selected.server.hasOverride
            ? `Change the global entry (currently ${selected.server.globalEnabled === false ? 'disabled' : 'enabled'} · ${selected.server.globalExposure ?? 'codemode'}); a workspace override may still take precedence`
            : 'Apply this setting to Pi sessions using your global configuration',
          value: 'global',
        });
        if (trusted) scopeChoices.push({
          label: 'This workspace only',
          description: `Save a project override for this trusted workspace (currently ${selected.server.enabled ? 'enabled' : 'disabled'} · ${selected.server.exposure})`,
          value: 'project',
        });
      }
      let scope = scopeChoices[0]?.value;
      if (scopeChoices.length > 1) {
        const choice = await vscode.window.showQuickPick(scopeChoices, { placeHolder: `Where should ${selected.server.name} change?` });
        if (!choice || this.worker !== worker) return;
        scope = choice.value;
      }
      if (!scope) return;

      let patch: { enabled?: boolean; exposure?: McpServerChoice['exposure'] };
      let expected: { expectedEnabled?: boolean; expectedExposure?: McpServerChoice['exposure'] };
      let changeDescription: string;
      if (action.action === 'enabled') {
        const currentEnabled = scope === 'global' ? selected.server.globalEnabled ?? selected.server.enabled : selected.server.enabled;
        const enabled = !currentEnabled;
        patch = { enabled };
        expected = { expectedEnabled: currentEnabled };
        changeDescription = enabled ? 'enable the server' : 'disable the server';
      } else {
        const exposureOptions: Array<{ label: string; description: string; value: McpServerChoice['exposure'] }> = [
          { label: 'Code mode', description: 'Available to Pi code mode scripts', value: 'codemode' },
          { label: 'Deferred', description: 'Loaded when Pi searches for tools, then callable by the model', value: 'deferred' },
          { label: 'Direct', description: 'Declared to the model like other tools', value: 'direct' },
          { label: 'Hidden', description: 'Registered but unavailable to the model', value: 'hidden' },
        ];
        const exposure = await vscode.window.showQuickPick(exposureOptions, { placeHolder: `Choose tool exposure for ${selected.server.name}` });
        if (!exposure || this.worker !== worker) return;
        const currentExposure = scope === 'global' ? selected.server.globalExposure ?? selected.server.exposure : selected.server.exposure;
        if (exposure.value === currentExposure) return;
        patch = { exposure: exposure.value };
        expected = { expectedExposure: currentExposure };
        changeDescription = `change tool exposure to ${exposure.value}`;
      }
      const scopeLabel = scope === 'project' ? 'this workspace' : 'your user configuration';
      const impact = patch.enabled === true
        ? ' Enabling may launch a local server process or contact a remote service.'
        : patch.exposure === 'direct'
          ? ' Direct tools are available to the model.'
          : patch.exposure === 'hidden'
            ? ' Hidden tools cannot be called by the model.'
            : '';
      const confirmationLabel = 'Apply MCP setting';
      const answer = await vscode.window.showWarningMessage(
        `Confirm ${changeDescription} for MCP server “${selected.server.name}” in ${scopeLabel}?${impact}`,
        { modal: true },
        confirmationLabel,
      );
      if (answer !== confirmationLabel) return;
      if (this.worker !== worker || this.runtimeBusy || this.queuedWorkCount > 0) {
        void vscode.window.showInformationMessage('The Pi runtime changed or became busy. Reopen the MCP manager and try again.');
        return;
      }
      const result = await this.requestMcpServerWorker(worker, 'updateMcpServer', {
        name: selected.server.name,
        scope,
        ...expected,
        ...patch,
      });
      if (!result || this.worker !== worker) {
        void vscode.window.showErrorMessage('Pi did not confirm the MCP setting change.');
        return;
      }
      if (result.success !== true) {
        void vscode.window.showErrorMessage(typeof result.error === 'string' ? result.error.slice(0, 300) : 'Pi could not update that MCP setting.');
        return;
      }
      const successMessage = `Updated ${selected.server.name} in ${scopeLabel}.${result.reloaded === true ? ' Pi reloaded MCP resources.' : ' The change takes effect when MCP is enabled or a new Pi session opens.'}`;
      if (this.view?.visible) this.post({ type: 'notice', message: successMessage });
      else void vscode.window.showInformationMessage(successMessage);
    } finally {
      this.mcpServerManagementInFlight = false;
    }
  }

  private requestMcpServerWorker(worker: Worker, type: 'listMcpServers' | 'updateMcpServer', payload: Record<string, unknown> = {}): Promise<RuntimeMessage | undefined> {
    const requestId = randomBytes(12).toString('hex');
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pendingMcpServerRequests.delete(requestId);
        resolve(undefined);
      }, type === 'updateMcpServer' ? 90_000 : 15_000);
      this.pendingMcpServerRequests.set(requestId, { worker, resolve, timer });
      try {
        worker.postMessage({ type, ...payload, requestId });
      } catch {
        clearTimeout(timer);
        this.pendingMcpServerRequests.delete(requestId);
        resolve(undefined);
      }
    });
  }

  private resolveMcpServerRequest(message: RuntimeMessage, worker: Worker): void {
    const requestId = typeof message.requestId === 'string' && /^[a-f0-9]{24}$/.test(message.requestId) ? message.requestId : '';
    const pending = requestId ? this.pendingMcpServerRequests.get(requestId) : undefined;
    if (!pending || pending.worker !== worker || this.worker !== worker) return;
    clearTimeout(pending.timer);
    this.pendingMcpServerRequests.delete(requestId);
    pending.resolve(message);
  }

  private failPendingMcpServerRequests(worker?: Worker): void {
    for (const [requestId, pending] of this.pendingMcpServerRequests) {
      if (worker && pending.worker !== worker) continue;
      clearTimeout(pending.timer);
      this.pendingMcpServerRequests.delete(requestId);
      pending.resolve(undefined);
    }
  }

  private recordDiagnostic(category: DiagnosticCategory): void {
    const at = new Date().toISOString();
    this.diagnosticEvents.push({ at, category });
    if (this.diagnosticEvents.length > 50) this.diagnosticEvents.splice(0, this.diagnosticEvents.length - 50);
    const line = `${at} ${category}`;
    this.outputChannel.appendLine(line);
    this.logWriteQueue = this.logWriteQueue
      .then(() => appendDiagnosticLog(this.context.globalStorageUri.fsPath, at, category))
      .catch(() => this.outputChannel.appendLine('Could not write the local diagnostic log.'));
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

  private async handleContextFileSelectionResult(message: RuntimeMessage, worker: Worker): Promise<void> {
    const pending = this.pendingContextFileSelection;
    if (!pending || pending.worker !== worker || pending.requestId !== message.requestId || this.worker !== worker) return;
    this.pendingContextFileSelection = undefined;
    if (message.type === 'context-files-failed') {
      try { await this.context.workspaceState.update('piChat.context.disabledFiles', pending.previousDisabled); } catch { /* Keep the confirmed selection if state rollback is unavailable. */ }
      this.post({
        type: 'notice',
        message: typeof message.message === 'string' ? message.message.slice(0, 300) : 'Pi could not apply the context-file selection.',
        isError: true,
      });
      return;
    }

    const rawDisabled = message.disabledContextFiles;
    if (!Array.isArray(rawDisabled) || rawDisabled.length > 2000
      || rawDisabled.some((item) => typeof item !== 'string' || item.length > 4096 || !path.isAbsolute(item) || /[\u0000-\u001f\u007f]/.test(item))) {
      try { await this.context.workspaceState.update('piChat.context.disabledFiles', pending.previousDisabled); } catch { /* Keep the confirmed selection if state rollback is unavailable. */ }
      this.post({ type: 'notice', message: 'Pi returned an invalid context-file selection. The previous setting was restored.', isError: true });
      return;
    }
    const disabledPaths = [...new Set(rawDisabled as string[])];
    try {
      await this.context.workspaceState.update('piChat.context.disabledFiles', disabledPaths);
      this.post({ type: 'notice', message: 'Pi context files updated. Future prompts will use the selected files.' });
    } catch {
      try { await this.context.workspaceState.update('piChat.context.disabledFiles', pending.previousDisabled); } catch { /* Keep the already-applied setting if rollback is unavailable. */ }
      this.post({ type: 'notice', message: 'Pi applied the selection, but VS Code could not save it for this workspace.', isError: true });
    }
  }

  private openDiagramPanel(value: unknown): void {
    if (typeof value !== 'string' || value.length > 300_000) {
      this.post({ type: 'notice', message: 'That diagram is too large to open separately.', isError: true });
      return;
    }
    const svg = value.trim();
    if (!/^<svg(?:\s|>)/i.test(svg)
      || /<\s*(?:script|foreignObject)\b|\son[a-z0-9_-]+\s*=|javascript\s*:|(?:href|xlink:href)\s*=\s*["'](?:https?:|\/\/)/i.test(svg)) {
      this.post({ type: 'notice', message: 'The diagram output failed the safety check.', isError: true });
      return;
    }
    const nonce = randomBytes(16).toString('base64');
    const imageUri = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
    const panel = vscode.window.createWebviewPanel('piChat.diagram', 'Pi Diagram', vscode.ViewColumn.Beside, {
      enableScripts: false,
      retainContextWhenHidden: true,
      localResourceRoots: [],
    });
    panel.webview.html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'nonce-${nonce}'">
<style nonce="${nonce}">html,body{width:100%;height:100%;margin:0;background:var(--vscode-editor-background,#fff);overflow:auto}body{display:grid;place-items:center}img{display:block;max-width:100%;max-height:100%;object-fit:contain}</style>
</head><body><img alt="Rendered Mermaid diagram" src="${imageUri}"></body></html>`;
  }

  private async openWorkspaceSymbol(value: unknown): Promise<void> {
    if (typeof value !== 'string' || value.length > 128
      || !/^[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*){0,3}$/.test(value)) {
      this.post({ type: 'notice', message: 'That code symbol could not be opened.', isError: true });
      return;
    }
    const query = value.split('.').at(-1) || value;
    try {
      const results = await vscode.commands.executeCommand<vscode.SymbolInformation[]>(
        'vscode.executeWorkspaceSymbolProvider',
        query,
      );
      const matches = (results ?? [])
        .filter((symbol) => symbol.name === query || symbol.name === value)
        .map((symbol) => ({ name: symbol.name, location: symbol.location }))
        .filter((symbol) => Boolean(vscode.workspace.getWorkspaceFolder(symbol.location.uri)))
        .slice(0, 40);
      if (!matches.length) {
        this.post({ type: 'notice', message: `No workspace definition found for “${value}”.` });
        return;
      }
      const choices = matches.map((symbol) => {
        const location = symbol.location;
        const folder = vscode.workspace.getWorkspaceFolder(location.uri);
        const fileName = folder && location.uri.scheme === 'file'
          ? path.relative(folder.uri.fsPath, location.uri.fsPath).replaceAll('\\', '/')
          : location.uri.scheme;
        return {
          label: `$(symbol-method) ${symbol.name}`,
          description: `${fileName}:${location.range.start.line + 1}`,
          location,
        };
      });
      const selected = choices.length === 1
        ? choices[0]
        : await vscode.window.showQuickPick(choices, { placeHolder: `Open definition of ${value}`, matchOnDescription: true });
      if (!selected) return;
      const document = await vscode.workspace.openTextDocument(selected.location.uri);
      await vscode.window.showTextDocument(document, { preview: true, selection: selected.location.range });
    } catch {
      this.post({ type: 'notice', message: 'Could not resolve that code symbol in the workspace.', isError: true });
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

  private async addCustomEndpoint(): Promise<void> {
    const providerIdInput = await vscode.window.showInputBox({
      title: 'Add custom Pi endpoint · 1/9',
      prompt: 'Choose a new provider ID using lowercase letters, numbers, dots, underscores, or hyphens.',
      placeHolder: 'my-local-models',
      validateInput: (value) => /^[a-z][a-z0-9._-]{1,63}$/.test(value.trim())
        ? undefined
        : 'Use 2–64 lowercase characters; start with a letter.',
    });
    if (providerIdInput === undefined) return;
    const providerId = providerIdInput.trim();
    if (this.availableProviderIds.some((id) => id.toLowerCase() === providerId.toLowerCase())) {
      void vscode.window.showErrorMessage('That provider ID is already registered in Pi. Choose a new ID to avoid changing an existing provider.');
      return;
    }

    const providerNameInput = await vscode.window.showInputBox({
      title: 'Add custom Pi endpoint · 2/9',
      prompt: 'Display name for this provider.',
      value: providerId,
      validateInput: (value) => value.trim().length > 0 && value.trim().length <= 128 && !/[\u0000-\u001f\u007f]/.test(value)
        ? undefined
        : 'Enter a display name of 1–128 characters.',
    });
    if (providerNameInput === undefined) return;
    const providerName = providerNameInput.trim();

    const baseUrlInput = await vscode.window.showInputBox({
      title: 'Add custom Pi endpoint · 3/9',
      prompt: 'API base URL. Use HTTPS for remote services; plain HTTP is limited to localhost.',
      placeHolder: 'https://api.example.com/v1',
      validateInput: (value) => this.validateCustomEndpointUrl(value) ? undefined
        : 'Enter an HTTPS URL, or an HTTP URL on localhost, 127.0.0.1, or ::1. User info, query strings, and fragments are not allowed.',
    });
    if (baseUrlInput === undefined) return;
    const baseUrl = this.validateCustomEndpointUrl(baseUrlInput);
    if (!baseUrl) return;

    const apiChoice = await vscode.window.showQuickPick([
      { label: 'OpenAI Chat Completions', description: 'openai-completions', api: 'openai-completions' },
      { label: 'OpenAI Responses', description: 'openai-responses', api: 'openai-responses' },
      { label: 'Azure OpenAI Responses', description: 'azure-openai-responses · Model ID is the Azure deployment name', api: 'azure-openai-responses' },
      { label: 'Anthropic Messages', description: 'anthropic-messages', api: 'anthropic-messages' },
      { label: 'Google Generative AI', description: 'google-generative-ai', api: 'google-generative-ai' },
      { label: 'Mistral Conversations', description: 'mistral-conversations', api: 'mistral-conversations' },
      { label: 'Other registered Pi API', description: 'Use an API identifier registered by a loaded Pi extension', api: '__custom__' },
    ], { title: 'Add custom Pi endpoint · 4/9', placeHolder: 'Choose the API format supported by the endpoint' });
    if (!apiChoice) return;
    let api = apiChoice.api;
    if (api === '__custom__') {
      const apiInput = await vscode.window.showInputBox({
        title: 'Registered Pi API identifier',
        prompt: 'Enter the identifier registered by a loaded Pi extension. This is not an arbitrary URL or code entry.',
        placeHolder: 'my-custom-api',
        validateInput: (value) => /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(value.trim())
          ? undefined
          : 'Use 1–128 letters, numbers, dots, underscores, or hyphens.',
      });
      if (apiInput === undefined) return;
      api = apiInput.trim();
    }

    const modelIdInput = await vscode.window.showInputBox({
      title: 'Add custom Pi endpoint · 5/9',
      prompt: 'Model ID sent to the endpoint.',
      placeHolder: 'model-name',
      validateInput: (value) => /^[a-zA-Z0-9][a-zA-Z0-9._:/+-]{0,127}$/.test(value.trim())
        ? undefined
        : 'Use 1–128 letters, numbers, dots, underscores, colons, slashes, plus signs, or hyphens.',
    });
    if (modelIdInput === undefined) return;
    const modelId = modelIdInput.trim();

    const modelNameInput = await vscode.window.showInputBox({
      title: 'Add custom Pi endpoint · 6/9',
      prompt: 'Optional display name. Leave blank to use the model ID.',
      value: modelId,
      validateInput: (value) => value.length <= 128 && !/[\u0000-\u001f\u007f]/.test(value)
        ? undefined
        : 'Use at most 128 characters.',
    });
    if (modelNameInput === undefined) return;
    const modelName = modelNameInput.trim() || modelId;

    const contextInput = await vscode.window.showInputBox({
      title: 'Add custom Pi endpoint · 7/9',
      prompt: 'Context window size in tokens.',
      value: '128000',
      validateInput: (value) => {
        const size = Number(value.trim());
        return Number.isSafeInteger(size) && size >= 1024 && size <= 10_000_000
          ? undefined
          : 'Enter a whole number from 1,024 to 10,000,000.';
      },
    });
    if (contextInput === undefined) return;
    const contextWindow = Number(contextInput.trim());

    const maxTokensInput = await vscode.window.showInputBox({
      title: 'Add custom Pi endpoint · 8/9',
      prompt: 'Maximum output tokens; must not exceed the context window.',
      value: String(Math.min(16_384, contextWindow)),
      validateInput: (value) => {
        const size = Number(value.trim());
        return Number.isSafeInteger(size) && size >= 1 && size <= contextWindow
          ? undefined
          : `Enter a whole number from 1 to ${contextWindow}.`;
      },
    });
    if (maxTokensInput === undefined) return;
    const maxTokens = Number(maxTokensInput.trim());

    const capabilities = await vscode.window.showQuickPick([
      { label: 'Text only', description: 'The model does not accept image input.', input: ['text'], reasoning: false },
      { label: 'Text and images', description: 'The model accepts image input.', input: ['text', 'image'], reasoning: false },
      { label: 'Reasoning model', description: 'The model accepts text and supports reasoning.', input: ['text'], reasoning: true },
      { label: 'Reasoning with images', description: 'The model accepts images and supports reasoning.', input: ['text', 'image'], reasoning: true },
    ], { title: 'Add custom Pi endpoint · 9/9', placeHolder: 'Choose the model capabilities' });
    if (!capabilities) return;

    const defaultEnvironmentName = `PI_${providerId.replace(/[^a-zA-Z0-9]/g, '_').toUpperCase()}_API_KEY`.slice(0, 128);
    const environmentNameInput = await vscode.window.showInputBox({
      title: 'Optional API key',
      prompt: 'Optional SecretStorage variable name. The key will not be written to Pi’s models.json; leave blank for unauthenticated local endpoints.',
      placeHolder: defaultEnvironmentName,
      validateInput: (value) => !value.trim() || isAllowedRuntimeEnvironmentName(value.trim())
        ? undefined
        : 'Use an allowed uppercase environment variable name, such as PI_LOCAL_API_KEY.',
    });
    if (environmentNameInput === undefined) return;
    const environmentName = environmentNameInput.trim();
    let apiKey: string | undefined;
    let secretStorageKey: string | undefined;
    let previousSecret: string | undefined;
    if (environmentName) {
      secretStorageKey = `${RUNTIME_ENV_SECRET_PREFIX}${environmentName}`;
      try {
        previousSecret = await this.context.secrets.get(secretStorageKey);
      } catch {
        this.post({ type: 'notice', message: 'Could not read the existing Pi runtime secret. No endpoint was added.', isError: true });
        return;
      }
      apiKey = await vscode.window.showInputBox({
        title: 'Optional API key',
        prompt: `Enter the API key for ${baseUrl}. It will be stored in VS Code SecretStorage and sent to this endpoint when you use the model.`,
        password: true,
        ignoreFocusOut: true,
        validateInput: (value) => value.length > MAX_RUNTIME_ENV_VALUE_CHARS || value.includes('\0') || (value.length > 0 && !value.trim())
          ? `Enter a non-empty API key up to ${MAX_RUNTIME_ENV_VALUE_CHARS} characters, or cancel to stop setup.`
          : undefined,
      });
      if (apiKey === undefined || !apiKey.trim()) return;
    }

    const confirmation = [
      `Add ${providerName} (${providerId}) to Pi’s machine-level models.json?`,
      `Endpoint: ${baseUrl}`,
      `API format: ${api}`,
      `Model: ${modelName} (${modelId})`,
      'No provider request is made during setup. Prompts and attached context will be sent to this endpoint only when you later use this model.',
      secretStorageKey
        ? previousSecret === undefined
          ? `Store its API key in VS Code SecretStorage as ${environmentName}?`
          : `Replace the stored value for ${environmentName} in VS Code SecretStorage?`
        : 'No API key will be stored.',
    ].join('\n');
    const answer = await vscode.window.showWarningMessage(confirmation, { modal: true }, 'Add endpoint');
    if (answer !== 'Add endpoint') return;

    let secretUpdated = false;
    try {
      if (secretStorageKey && apiKey !== undefined) {
        await this.validateRuntimeEnvironmentSecret(environmentName, apiKey);
        await this.context.secrets.store(secretStorageKey, apiKey);
        secretUpdated = true;
      }
      await this.writeCustomProviderToModelsConfig(this.modelsConfigPath, providerId, {
        name: providerName,
        baseUrl,
        api,
        ...(environmentName ? { apiKey: `$${environmentName}` } : {}),
        models: [{
          id: modelId,
          name: modelName,
          contextWindow,
          maxTokens,
          reasoning: capabilities.reasoning,
          input: capabilities.input,
        }],
      });
      this.post({
        type: 'notice',
        message: secretStorageKey
          ? 'Custom endpoint added. Restart the Pi runtime to apply its SecretStorage API key; the model list will then refresh from Pi’s configuration.'
          : 'Custom endpoint added. The model list will refresh from Pi’s configuration.',
      });
    } catch {
      if (secretUpdated && secretStorageKey) {
        try {
          if (previousSecret === undefined) await this.context.secrets.delete(secretStorageKey);
          else await this.context.secrets.store(secretStorageKey, previousSecret);
        } catch {
          this.post({ type: 'notice', message: `Could not restore the previous value for ${environmentName} in VS Code SecretStorage. Review that variable before restarting Pi.`, isError: true });
        }
      }
      this.recordDiagnostic('Pi operation error');
      this.post({ type: 'notice', message: 'Could not add the custom endpoint. Review the Pi models file and try again.', isError: true });
    } finally {
      apiKey = undefined;
      previousSecret = undefined;
    }
  }

  private validateCustomEndpointUrl(value: string): string | undefined {
    if (typeof value !== 'string' || value.length > 2048) return undefined;
    try {
      const url = new URL(value.trim());
      const localHost = /^(?:localhost|127\.0\.0\.1|\[::1\]|::1)$/i.test(url.hostname);
      if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && localHost))
        || !url.hostname || url.username || url.password || url.search || url.hash) return undefined;
      return url.toString().replace(/\/+$/, '');
    } catch {
      return undefined;
    }
  }

  private async writeCustomProviderToModelsConfig(filePath: string, providerId: string, provider: Record<string, unknown>): Promise<void> {
    const targetPath = path.resolve(filePath);
    if (!path.isAbsolute(filePath) || path.basename(targetPath).toLowerCase() !== 'models.json') {
      throw new Error('Invalid Pi models file path.');
    }
    const comparisonPath = (value: string) => process.platform === 'win32' ? value.toLocaleLowerCase() : value;
    const parentPath = path.dirname(targetPath);
    if (comparisonPath(await realpath(parentPath)) !== comparisonPath(parentPath)) {
      throw new Error('The Pi models directory resolves through a symbolic link.');
    }

    try {
      await lstat(targetPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      let file;
      let createdFileStats;
      try {
        file = await openFile(targetPath, 'wx', 0o600);
        createdFileStats = await file.stat();
        await file.writeFile(`${JSON.stringify({ $schema: 'https://pi.dev/schemas/models.schema.json', providers: {} }, null, 2)}\n`, 'utf8');
      } catch (createError) {
        if (file && createdFileStats) {
          try {
            await file.close();
          } catch {
            // Continue with identity-checked cleanup of a partially created file.
          }
          file = undefined;
          try {
            const currentStats = await lstat(targetPath);
            if (currentStats.isFile() && !currentStats.isSymbolicLink() && currentStats.nlink === 1
              && currentStats.dev === createdFileStats.dev && currentStats.ino === createdFileStats.ino) {
              await unlink(targetPath);
            }
          } catch {
            // Preserve the original creation error; never remove a replacement file.
          }
        }
        if ((createError as NodeJS.ErrnoException).code !== 'EEXIST') throw createError;
      } finally {
        await file?.close();
      }
    }

    const stats = await lstat(targetPath);
    if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink > 1 || stats.size > 1_000_000
      || comparisonPath(await realpath(targetPath)) !== comparisonPath(targetPath)) {
      throw new Error('The Pi models file is not a safe regular file.');
    }
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(targetPath));
    if (document.isDirty) throw new Error('Save or discard unsaved changes in models.json before adding a provider.');
    const text = document.getText();
    const documentVersion = document.version;
    const [currentStats, diskText] = await Promise.all([lstat(targetPath), readFile(targetPath, 'utf8')]);
    if (!currentStats.isFile() || currentStats.isSymbolicLink() || currentStats.nlink > 1
      || currentStats.dev !== stats.dev || currentStats.ino !== stats.ino
      || comparisonPath(await realpath(targetPath)) !== comparisonPath(targetPath)
      || diskText.replace(/\r\n/g, '\n') !== text.replace(/\r\n/g, '\n')) {
      throw new Error('The Pi models file changed while it was being opened.');
    }
    if (Buffer.byteLength(text, 'utf8') > 1_000_000) throw new Error('The Pi models file is too large to update safely.');
    const errors: ParseError[] = [];
    const config = parse(text, errors, { allowTrailingComma: true, disallowComments: false });
    if (errors.length || !config || typeof config !== 'object' || Array.isArray(config)) {
      throw new Error('The Pi models file contains invalid JSONC.');
    }
    const existingProviders = config.providers;
    if (existingProviders !== undefined
      && (!existingProviders || typeof existingProviders !== 'object' || Array.isArray(existingProviders))) {
      throw new Error('The providers field in models.json is invalid.');
    }
    if (Object.prototype.hasOwnProperty.call(existingProviders ?? {}, providerId)
      || this.availableProviderIds.some((id) => id.toLowerCase() === providerId.toLowerCase())) {
      throw new Error('The provider ID already exists.');
    }

    const edits = modify(text, ['providers', providerId], provider, {
      formattingOptions: {
        insertSpaces: true,
        tabSize: 2,
        eol: document.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n',
        insertFinalNewline: true,
      },
    });
    const updatedText = applyEdits(text, edits);
    if (Buffer.byteLength(updatedText, 'utf8') > 1_000_000) throw new Error('The updated Pi models file would exceed the size limit.');
    if (document.isDirty || document.version !== documentVersion || document.getText() !== text) {
      throw new Error('The Pi models file changed while the endpoint was being prepared.');
    }
    const edit = new vscode.WorkspaceEdit();
    edit.replace(document.uri, new vscode.Range(document.positionAt(0), document.positionAt(text.length)), updatedText);
    if (!await vscode.workspace.applyEdit(edit)) throw new Error('VS Code could not update the Pi models document.');
    try {
      if (!await document.save()) throw new Error('VS Code could not save the Pi models document.');
    } catch (saveError) {
      if (document.getText() === updatedText) {
        const rollback = new vscode.WorkspaceEdit();
        rollback.replace(document.uri, new vscode.Range(document.positionAt(0), document.positionAt(updatedText.length)), text);
        if (!await vscode.workspace.applyEdit(rollback)) {
          throw new Error('The Pi models save failed and VS Code could not roll back the in-memory edit.');
        }
      }
      throw saveError;
    }
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

  private readDisabledContextFiles(): string[] {
    const value = this.context.workspaceState.get<unknown>('piChat.context.disabledFiles', []);
    if (!Array.isArray(value)) return [];
    return [...new Set(value.filter((item): item is string => typeof item === 'string'
      && item.length <= 4096 && path.isAbsolute(item) && !/[\u0000-\u001f\u007f]/.test(item)))].slice(0, 2000);
  }

  private readNewSessionToolNames(): string[] {
    const value = vscode.workspace.getConfiguration('piChat.tools').get<unknown>('defaultToolNames', ['*']);
    if (!Array.isArray(value) || value.length > 256) return ['*'];
    if (value.length === 1 && value[0] === '*') return ['*'];
    return [...new Set(value.filter((name): name is string => typeof name === 'string'
      && name.length > 0 && name.length <= 128 && name !== '*' && !/[\u0000-\u001f\u007f]/.test(name)))].slice(0, 256);
  }

  private async manageContextFiles(): Promise<void> {
    const worker = this.worker;
    if (!worker) {
      this.post({ type: 'notice', message: 'Open a Pi session before choosing context files.' });
      return;
    }
    if (this.runtimeBusy || this.queuedWorkCount > 0) {
      this.post({ type: 'notice', message: 'Finish running and queued work before changing context files.', isError: true });
      return;
    }
    if (!this.contextFileChoices.length) {
      this.post({ type: 'notice', message: 'Pi did not discover any AGENTS.md context files for this workspace.' });
      return;
    }

    const workspacePath = this.workerWorkspace ?? '';
    const choices = this.contextFileChoices.map((choice) => {
      const relativePath = workspacePath ? path.relative(workspacePath, choice.path) : '';
      const description = relativePath && !path.isAbsolute(relativePath) && relativePath !== '..'
        && !relativePath.startsWith(`..${path.sep}`) ? relativePath : choice.path;
      return {
        label: `$(file) ${path.basename(choice.path)}`,
        description,
        picked: choice.enabled,
        path: choice.path,
      };
    });
    const selected = await vscode.window.showQuickPick(choices, {
      canPickMany: true,
      ignoreFocusOut: true,
      placeHolder: this.contextFilesTruncated
        ? 'Choose Pi context files (showing the first 500)'
        : 'Choose AGENTS.md files included in Pi’s system context',
      title: 'Pi context files',
    });
    if (selected === undefined) return;
    if (this.worker !== worker || this.runtimeBusy || this.queuedWorkCount > 0) {
      this.post({ type: 'notice', message: 'The Pi runtime changed or became busy while choosing context files. Nothing was applied.', isError: true });
      return;
    }

    const managedPaths = new Set(this.contextFileChoices.map((choice) => choice.path));
    const selectedPaths = new Set(selected.map((choice) => choice.path));
    const disabledPaths = new Set(this.readDisabledContextFiles().filter((filePath) => !managedPaths.has(filePath)));
    for (const choice of this.contextFileChoices) {
      if (!selectedPaths.has(choice.path)) disabledPaths.add(choice.path);
    }
    const previousDisabled = this.readDisabledContextFiles();
    const nextDisabled = [...disabledPaths].slice(0, 2000);
    if (nextDisabled.length === previousDisabled.length
      && nextDisabled.every((filePath) => previousDisabled.includes(filePath))) return;

    const enabledCount = this.contextFileChoices.length - this.contextFileChoices.filter((choice) => disabledPaths.has(choice.path)).length;
    const prompt = this.contextFilesTruncated
      ? `Apply this selection to the displayed ${this.contextFileChoices.length} discovered Pi context files? Other undisplayed files stay enabled. Pi will reload resources; enabled extensions may run during reload.`
      : `Use ${enabledCount} discovered Pi context file${enabledCount === 1 ? '' : 's'} for future prompts? Pi will reload resources; enabled extensions may run during reload.`;
    const answer = await vscode.window.showWarningMessage(
      prompt,
      { modal: true },
      'Apply context selection',
    );
    if (answer !== 'Apply context selection') return;
    if (this.worker !== worker || this.runtimeBusy || this.queuedWorkCount > 0) {
      this.post({ type: 'notice', message: 'Pi work started while confirmation was open. Nothing was applied.', isError: true });
      return;
    }

    try {
      await this.context.workspaceState.update('piChat.context.disabledFiles', nextDisabled);
    } catch {
      this.post({ type: 'notice', message: 'Could not save the context-file selection for this workspace.', isError: true });
      return;
    }
    if (this.worker !== worker || this.runtimeBusy || this.queuedWorkCount > 0) {
      try { await this.context.workspaceState.update('piChat.context.disabledFiles', previousDisabled); } catch { /* The worker will still apply the last confirmed selection on restart. */ }
      this.post({ type: 'notice', message: 'Pi work started while saving the selection. Nothing was applied.', isError: true });
      return;
    }

    const requestId = randomBytes(12).toString('hex');
    this.pendingContextFileSelection = { worker, requestId, previousDisabled };
    try {
      worker.postMessage({ type: 'setContextFiles', requestId, disabledContextFiles: nextDisabled });
    } catch {
      this.pendingContextFileSelection = undefined;
      try { await this.context.workspaceState.update('piChat.context.disabledFiles', previousDisabled); } catch { /* Keep the already-confirmed setting if rollback is unavailable. */ }
      this.post({ type: 'notice', message: 'Could not send the context-file selection to Pi.', isError: true });
    }
  }

  onAgentDirConfigurationChanged(): void {
    const currentAgentDir = vscode.workspace.getConfiguration('piChat').get<string>('agentDir', '').trim();
    if (currentAgentDir === this.workerAgentDirSetting) return;
    this.post({ type: 'notice', message: this.runtimeBusy || this.queuedWorkCount > 0
      ? 'The Pi configuration folder setting changed. Finish running and queued work, then use Pi Chat: Restart Pi Runtime to apply it.'
      : 'The Pi configuration folder setting changed. Use Pi Chat: Restart Pi Runtime to apply it.' });
  }

  onOfflineModeConfigurationChanged(): void {
    const currentMode = readPiOfflineMode();
    this.post({ type: 'offline-mode-setting', mode: currentMode });
    if (currentMode === this.workerOfflineModeSetting) return;
    this.post({ type: 'notice', message: this.runtimeBusy || this.queuedWorkCount > 0
      ? 'Pi startup network mode changed. Finish running and queued work, then use Pi Chat: Restart Pi Runtime to apply it.'
      : 'Pi startup network mode changed. Use Pi Chat: Restart Pi Runtime to apply it.' });
  }

  onExtensionUiModeConfigurationChanged(): void {
    const currentMode = readPiExtensionUiMode();
    if (currentMode === this.workerExtensionUiModeSetting) return;
    this.post({ type: 'notice', message: this.runtimeBusy || this.queuedWorkCount > 0
      ? 'Pi extension UI mode changed. Finish running and queued work, then use Pi Chat: Restart Pi Runtime to apply it.'
      : 'Pi extension UI mode changed. Use Pi Chat: Restart Pi Runtime to apply it.' });
  }

  onExtensionStatusConfigurationChanged(): void {
    this.postExtensionStatusPreferences();
    this.updateExtensionStatusBar();
  }

  onNotificationSoundConfigurationChanged(): void {
    this.post({
      type: 'notification-sound-setting',
      enabled: vscode.workspace.getConfiguration('piChat.notifications').get<boolean>('sound', false),
    });
  }

  onModelRefreshConfigurationChanged(): void {
    this.post({
      type: 'model-refresh-setting',
      enabled: vscode.workspace.getConfiguration('piChat.models').get<boolean>('autoRefresh', false),
    });
  }

  private cancelPackageSearch(notify: boolean): void {
    const pending = this.pendingPackageSearch;
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pendingPackageSearch = undefined;
    pending.controller.abort();
    if (notify) this.post({ type: 'package-search-results', status: 'Search cancelled.', results: [] });
  }

  private async searchPiPackages(message: RuntimeMessage): Promise<void> {
    const popular = message.popular === true;
    const query = popular ? 'keywords:pi-package' : typeof message.query === 'string' ? message.query.trim() : '';
    if (!query || query.length > 128 || /[\u0000-\u001f\u007f]/.test(query)) {
      this.post({ type: 'package-search-results', status: 'Enter a search term up to 128 characters.', results: [] });
      return;
    }
    const now = Date.now();
    this.packageSearchesAt = this.packageSearchesAt.filter((at) => now - at < 60_000);
    if (this.packageSearchesAt.length >= MAX_PACKAGE_SEARCHES_PER_MINUTE) {
      this.post({ type: 'package-search-results', status: 'Search limit reached. Wait a minute and try again.', results: [] });
      return;
    }
    this.packageSearchesAt.push(now);
    this.cancelPackageSearch(false);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    this.pendingPackageSearch = { controller, timer };
    this.post({
      type: 'package-search-state',
      status: popular ? 'Loading popular Pi packages from npm…' : 'Searching the public npm registry…',
    });
    try {
      const url = new URL('https://registry.npmjs.org/-/v1/search');
      url.searchParams.set('text', query);
      url.searchParams.set('size', popular ? '20' : '50');
      url.searchParams.set('from', '0');
      if (popular) {
        url.searchParams.set('quality', '0');
        url.searchParams.set('popularity', '1');
        url.searchParams.set('maintenance', '0');
      }
      const response = await fetch(url, {
        method: 'GET',
        headers: { accept: 'application/json' },
        redirect: 'error',
        credentials: 'omit',
        signal: controller.signal,
      });
      const responseUrl = new URL(response.url);
      if (responseUrl.origin !== 'https://registry.npmjs.org' || responseUrl.pathname !== '/-/v1/search') {
        throw new Error('Unexpected package registry response.');
      }
      if (!response.ok) {
        this.post({
          type: 'package-search-results',
          status: `The npm registry returned HTTP ${response.status}.`,
          results: [],
        });
        return;
      }
      const payload = await readBoundedJsonResponse(response, MAX_PACKAGE_SEARCH_RESPONSE_BYTES);
      if (this.pendingPackageSearch?.controller !== controller) return;
      const results = parsePiPackageSearchResults(payload);
      this.post({
        type: 'package-search-results',
        status: results.length
          ? popular
            ? `${results.length} results. Popularity is not a security review; select Use to fill a version-pinned source.`
            : `${results.length} results. Select Use to fill a version-pinned source.`
          : 'No eligible Pi packages were found.',
        results,
      });
    } catch {
      if (this.pendingPackageSearch?.controller !== controller) return;
      this.post({
        type: 'package-search-results',
        status: controller.signal.aborted
          ? 'Search timed out. Try again.'
          : 'Could not reach the public npm registry. Check your connection and try again.',
        results: [],
      });
    } finally {
      if (this.pendingPackageSearch?.controller === controller) {
        clearTimeout(timer);
        this.pendingPackageSearch = undefined;
      }
    }
  }

  private postExtensionStatusPreferences(): void {
    const preferences = readPiExtensionStatusPreferences();
    this.post({
      type: 'extension-status-display',
      ...preferences,
      statuses: [...this.extensionStatuses].map(([key, text]) => ({ key, text })),
    });
  }

  private updateExtensionStatus(message: RuntimeMessage): void {
    const key = typeof message.key === 'string' && message.key.length > 0 && message.key.length <= 128
      && !/[\u0000-\u001f\u007f]/.test(message.key) ? message.key : 'extension';
    const text = typeof message.text === 'string'
      ? message.text.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 512).trim()
      : '';
    if (text) this.extensionStatuses.set(key, text);
    else this.extensionStatuses.delete(key);
    this.updateExtensionStatusBar();
  }

  private updateExtensionStatusBar(): void {
    const item = this.extensionStatusBarItem;
    if (!item) return;
    const preferences = readPiExtensionStatusPreferences();
    if (preferences.display !== 'statusBar' && preferences.display !== 'both') {
      item.text = '';
      item.tooltip = undefined;
      item.hide();
      return;
    }
    const filter = new Set(preferences.keys);
    const entries = [...this.extensionStatuses].filter(([key]) => filter.size === 0 || filter.has(key));
    if (entries.length === 0) {
      item.text = '';
      item.tooltip = undefined;
      item.hide();
      return;
    }
    const safeText = entries.map(([, text]) => text.replace(/\$\(/g, '\\$(').replace(/[\r\n]+/g, ' '));
    item.text = safeText.join(' · ').slice(0, 120);
    item.tooltip = entries.map(([key, text]) => `${key}: ${text}`).join('\n').slice(0, 2_000);
    item.show();
  }

  private async setPiOfflineMode(message: RuntimeMessage): Promise<void> {
    const mode = message.mode;
    if (mode !== 'inherit' && mode !== 'offline' && mode !== 'online') return;
    try {
      await vscode.workspace.getConfiguration('piChat').update('offlineMode', mode, vscode.ConfigurationTarget.Global);
      this.post({ type: 'offline-mode-setting', mode });
    } catch {
      this.post({ type: 'offline-mode-setting', mode: readPiOfflineMode() });
      this.post({ type: 'notice', message: 'Could not update Pi startup network mode.', isError: true });
    }
  }

  private async setAutoRefreshModels(message: RuntimeMessage): Promise<void> {
    if (typeof message.enabled !== 'boolean') return;
    const configuration = vscode.workspace.getConfiguration('piChat.models');
    const current = configuration.get<boolean>('autoRefresh', false);
    if (message.enabled === current) {
      this.onModelRefreshConfigurationChanged();
      return;
    }
    if (message.enabled) {
      const answer = await vscode.window.showWarningMessage(
        'Automatically refresh Pi model catalogs when the runtime starts? This can contact configured provider endpoints and run API-key commands from Pi model settings. Refresh is skipped when Pi is offline.',
        { modal: true },
        'Enable automatic refresh',
      );
      if (answer !== 'Enable automatic refresh') {
        this.onModelRefreshConfigurationChanged();
        return;
      }
    }
    try {
      await configuration.update('autoRefresh', message.enabled, vscode.ConfigurationTarget.Global);
      this.onModelRefreshConfigurationChanged();
      this.post({ type: 'notice', message: message.enabled
        ? 'Automatic model catalog refresh will start after Pi runtime restarts.'
        : 'Automatic model catalog refresh is disabled.' });
    } catch {
      this.onModelRefreshConfigurationChanged();
      this.post({ type: 'notice', message: 'Could not update automatic model catalog refresh.', isError: true });
    }
  }

  async manageRuntimeEnvironment(): Promise<void> {
    let names: string[];
    try {
      names = (await this.context.secrets.keys())
        .filter((key) => key.startsWith(RUNTIME_ENV_SECRET_PREFIX))
        .map((key) => key.slice(RUNTIME_ENV_SECRET_PREFIX.length))
        .filter(isAllowedRuntimeEnvironmentName)
        .sort();
    } catch {
      void vscode.window.showErrorMessage('Could not read Pi runtime environment variable names from VS Code SecretStorage.');
      return;
    }

    type RuntimeEnvironmentChoice = vscode.QuickPickItem & { action: 'add' | 'existing'; name?: string };
    const items: RuntimeEnvironmentChoice[] = [
      { label: '$(add) Add a variable', description: 'Store a value securely for the Pi runtime', action: 'add' },
      ...names.map((name): RuntimeEnvironmentChoice => ({
        label: name,
        description: 'Stored in VS Code SecretStorage',
        action: 'existing',
        name,
      })),
    ];
    const selected = await vscode.window.showQuickPick(items, {
      title: 'Pi runtime environment',
      placeHolder: names.length ? 'Choose a variable to replace or remove' : 'Add a secure runtime variable',
      ignoreFocusOut: true,
    });
    if (!selected) return;

    let name = selected.name;
    let operation: 'store' | 'remove' = 'store';
    if (selected.action === 'add') {
      if (names.length >= MAX_RUNTIME_ENV_VARIABLES) {
        void vscode.window.showErrorMessage(`Pi runtime environment is limited to ${MAX_RUNTIME_ENV_VARIABLES} variables.`);
        return;
      }
      const enteredName = await vscode.window.showInputBox({
        title: 'Add a Pi runtime variable',
        prompt: 'Use an uppercase environment name such as OPENAI_API_KEY. Runtime-control and process-loader variables are blocked.',
        placeHolder: 'OPENAI_API_KEY',
        ignoreFocusOut: true,
        validateInput: (input) => input.length > 128 || !isAllowedRuntimeEnvironmentName(input.trim())
          ? 'Use an allowed uppercase environment name. PATH, NODE_OPTIONS, and runtime-control variables are reserved.'
          : undefined,
      });
      if (enteredName === undefined) return;
      name = enteredName.trim();
      if (!isAllowedRuntimeEnvironmentName(name)) return;
    } else {
      if (!name || !isAllowedRuntimeEnvironmentName(name)) return;
      const action = await vscode.window.showQuickPick([
        { label: 'Replace value', action: 'store' as const },
        { label: 'Remove variable', action: 'remove' as const },
      ], { title: name, placeHolder: 'Choose what to do with this stored variable', ignoreFocusOut: true });
      if (!action) return;
      operation = action.action;
    }

    let value: string | undefined;
    if (operation === 'store') {
      value = await vscode.window.showInputBox({
        title: `Set ${name}`,
        prompt: 'The value is hidden and will be stored in VS Code SecretStorage. Pi, its tools, and loaded extensions can read it from the worker environment.',
        password: true,
        ignoreFocusOut: true,
        validateInput: (input) => input.length > MAX_RUNTIME_ENV_VALUE_CHARS
          ? `Values are limited to ${MAX_RUNTIME_ENV_VALUE_CHARS} characters.`
          : input.includes('\0') ? 'Environment values cannot contain a null character.' : undefined,
      });
      if (value === undefined) return;
    }

    const confirmation = operation === 'store'
      ? await vscode.window.showWarningMessage(
        `Store ${name} in VS Code SecretStorage? Its value will override the inherited environment value for this name inside Pi, its tools, and loaded extensions after the next runtime start. Use “Pi Chat: Restart Pi Runtime” when you are ready to apply it.`,
        { modal: true },
        'Store securely',
      )
      : await vscode.window.showWarningMessage(
        `Remove ${name} from VS Code SecretStorage? The active Pi worker keeps its current value until it stops. A later runtime will use the inherited environment value, if one exists.`,
        { modal: true },
        'Remove variable',
      );
    if (confirmation !== (operation === 'store' ? 'Store securely' : 'Remove variable')) return;

    const secretKey = `${RUNTIME_ENV_SECRET_PREFIX}${name}`;
    try {
      if (operation === 'store') await this.context.secrets.store(secretKey, value ?? '');
      else await this.context.secrets.delete(secretKey);
    } catch {
      void vscode.window.showErrorMessage('Could not update this value in VS Code SecretStorage.');
      return;
    }

    void vscode.window.showInformationMessage(operation === 'store'
      ? `${name} was saved securely. Restart the Pi runtime when you are ready to apply it.`
      : `${name} was removed from SecretStorage. The active worker keeps its old value until it stops.`);
  }

  async chooseAgentDir(): Promise<void> {
    if (this.runtimeBusy || this.queuedWorkCount > 0) {
      this.post({ type: 'notice', message: 'Finish the current Pi run and queued work before changing its configuration folder.', isError: true });
      return;
    }

    const configuration = vscode.workspace.getConfiguration('piChat');
    const configuredPath = configuration.get<string>('agentDir', '').trim();
    const environmentPath = process.env.PI_CODING_AGENT_DIR?.trim() ?? '';
    const preferredPath = configuredPath || environmentPath || path.join(homedir(), '.pi', 'agent');
    const expandedPreferredPath = preferredPath === '~'
      ? homedir()
      : /^~[\\/]/.test(preferredPath) ? path.join(homedir(), preferredPath.slice(2)) : preferredPath;
    const selected = await vscode.window.showOpenDialog({
      canSelectFiles: false,
      canSelectFolders: true,
      canSelectMany: false,
      openLabel: 'Use Pi configuration folder',
      defaultUri: vscode.Uri.file(path.resolve(expandedPreferredPath)),
      title: 'Choose Pi configuration folder',
    });
    const selectedUri = selected?.[0];
    if (!selectedUri) return;
    if (this.runtimeBusy || this.queuedWorkCount > 0) {
      this.post({ type: 'notice', message: 'Pi work started while the folder picker was open. Finish running and queued work before changing configuration.', isError: true });
      return;
    }

    let targetPath = '';
    try {
      targetPath = await realpath(selectedUri.fsPath);
      if (!path.isAbsolute(targetPath) || targetPath.length > 4096 || /[\u0000-\u001f\u007f]/.test(targetPath)) throw new Error('invalid path');
      const stats = await vscode.workspace.fs.stat(vscode.Uri.file(targetPath));
      if ((stats.type & vscode.FileType.Directory) === 0) throw new Error('not a folder');
    } catch {
      this.post({ type: 'notice', message: 'Choose an existing local folder for Pi configuration.', isError: true });
      return;
    }

    const answer = await vscode.window.showWarningMessage(
      `Use this Pi configuration folder?\n${targetPath}\nPi will read models, credentials, extensions, skills, prompts, and sessions from this folder. Enabled extensions can run code. The current chat will close.`,
      { modal: true },
      'Use this folder',
    );
    if (answer !== 'Use this folder') return;
    if (this.runtimeBusy || this.queuedWorkCount > 0) {
      this.post({ type: 'notice', message: 'Pi work started while confirmation was open. Finish running and queued work before changing configuration.', isError: true });
      return;
    }

    try {
      await configuration.update('agentDir', targetPath, vscode.ConfigurationTarget.Global);
      if (this.runtimeBusy || this.queuedWorkCount > 0) {
        this.post({ type: 'notice', message: 'Pi configuration folder saved. Finish running and queued work, then use Pi Chat: Restart Pi Runtime to apply it.' });
      } else {
        this.restartRuntime();
        this.post({ type: 'notice', message: 'Pi configuration folder updated and Pi is restarting.' });
      }
    } catch {
      this.post({ type: 'notice', message: 'Could not update the Pi configuration folder setting.', isError: true });
    }
  }

  async restartPiRuntime(): Promise<void> {
    if (this.runtimeBusy || this.queuedWorkCount > 0) {
      this.post({ type: 'notice', message: 'Finish the current Pi run and queued work before restarting the runtime.', isError: true });
      return;
    }
    const answer = await vscode.window.showWarningMessage(
      'Restart the Pi runtime? The current chat will close. No running or queued work will be interrupted.',
      { modal: true },
      'Restart Pi',
    );
    if (answer !== 'Restart Pi') return;
    if (this.runtimeBusy || this.queuedWorkCount > 0) {
      this.post({ type: 'notice', message: 'Pi work started while confirmation was open. Finish it before restarting.', isError: true });
      return;
    }
    this.restartRuntime();
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

  private refreshSessions(): void {
    this.worker?.postMessage({
      type: 'listSessions',
      query: this.sessionQuery,
      allWorkspaces: this.sessionSearchAllWorkspaces,
    });
  }

  private runningSessionKey(sessionPath: string, workspacePath: string): string | undefined {
    if (!path.isAbsolute(sessionPath) || sessionPath.length > 4096 || /[\u0000-\u001f\u007f]/.test(sessionPath)
      || !path.isAbsolute(workspacePath) || workspacePath.length > 4096 || /[\u0000-\u001f\u007f]/.test(workspacePath)) return undefined;
    try {
      const workspaceKey = this.normalizeSessionPath(workspacePath);
      const sessionKey = this.normalizeSessionPath(sessionPath);
      return createHash('sha256').update(workspaceKey).update('\0').update(sessionKey).digest('hex');
    } catch {
      return undefined;
    }
  }

  private runningWorkspaceKey(workspacePath: string): string | undefined {
    if (!path.isAbsolute(workspacePath) || workspacePath.length > 4096 || /[\u0000-\u001f\u007f]/.test(workspacePath)) return undefined;
    try {
      return createHash('sha256').update(this.normalizeSessionPath(workspacePath)).digest('hex');
    } catch {
      return undefined;
    }
  }

  private safeRunningActivity(value: unknown): string {
    if (typeof value !== 'string') return 'Working in Pi';
    const activity = value.trim();
    if (activity === 'Pi is thinking' || activity === 'Managing Pi packages' || activity === 'Reloading Pi resources') return activity;
    if (/^Running [A-Za-z0-9_.:-]{1,80}$/.test(activity)) return activity;
    if (/^Connecting [A-Za-z0-9_. -]{1,80}$/.test(activity)) return activity;
    if (/^Queued work \([1-9]\d{0,3}\)$/.test(activity)) return activity;
    return 'Working in Pi';
  }

  private makeRunningSessionRecord(): RunningSessionRecord | undefined {
    if ((!this.runtimeBusy && this.queuedWorkCount <= 0) || !this.activeSessionPath || !this.workerWorkspace) return undefined;
    const sessionKey = this.runningSessionKey(this.activeSessionPath, this.workerWorkspace);
    const workspaceKey = this.runningWorkspaceKey(this.workerWorkspace);
    if (!sessionKey || !workspaceKey) return undefined;
    return { version: 1, sessionKey, workspaceKey, activity: this.safeRunningActivity(this.runtimeActivity), updatedAt: Date.now() };
  }

  private refreshRunningSessionLease(): void {
    const record = this.makeRunningSessionRecord();
    if (!record) {
      if (!this.runningSessionLeasePublished) return;
      this.runningSessionLeasePublished = false;
      this.runningSessionLeaseSignature = '';
      this.runningSessionOperation = this.runningSessionOperation.then(async () => {
        try { await unlink(this.runningSessionRecordPath); } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
      }).catch(() => undefined);
      return;
    }

    const signature = `${record.sessionKey}\0${record.workspaceKey}\0${record.activity}`;
    const now = Date.now();
    if (this.runningSessionLeasePublished && signature === this.runningSessionLeaseSignature
      && now - this.runningSessionLeaseWrittenAt < 4000) return;
    this.runningSessionLeasePublished = true;
    this.runningSessionLeaseSignature = signature;
    this.runningSessionLeaseWrittenAt = now;
    this.runningSessionOperation = this.runningSessionOperation.then(async () => {
      let tempPath = '';
      try {
        await mkdir(this.runningSessionsDirectory, { recursive: true, mode: 0o700 });
        const directoryStats = await lstat(this.runningSessionsDirectory);
        if (!directoryStats.isDirectory() || directoryStats.isSymbolicLink()) throw new Error('Invalid running-session registry directory.');
        tempPath = `${this.runningSessionRecordPath}.${randomBytes(8).toString('hex')}.tmp`;
        const handle = await openFile(tempPath, 'wx', 0o600);
        try {
          await handle.writeFile(JSON.stringify(record), { encoding: 'utf8' });
        } finally {
          await handle.close();
        }
        await rename(tempPath, this.runningSessionRecordPath);
        tempPath = '';
      } catch {
        this.runningSessionLeasePublished = false;
      } finally {
        if (tempPath) {
          try { await unlink(tempPath); } catch { /* Best-effort removal of the private temporary record. */ }
        }
      }
    }).catch(() => { this.runningSessionLeasePublished = false; });
  }

  private clearRunningSessionLease(): void {
    this.runningSessionLeasePublished = false;
    this.runningSessionLeaseSignature = '';
    this.runningSessionOperation = this.runningSessionOperation.then(async () => {
      try { await unlink(this.runningSessionRecordPath); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }).catch(() => undefined);
  }

  private async readRunningSessionRecords(): Promise<RunningSessionRecord[]> {
    let names: string[];
    try {
      const directoryStats = await lstat(this.runningSessionsDirectory);
      if (!directoryStats.isDirectory() || directoryStats.isSymbolicLink()) return [];
      names = [];
      const directory = await opendir(this.runningSessionsDirectory);
      try {
        let scanned = 0;
        while (scanned < MAX_RUNNING_SESSION_RECORDS * 5 && names.length < MAX_RUNNING_SESSION_RECORDS) {
          const entry = await directory.read();
          if (!entry) break;
          scanned += 1;
          if (/^[a-f0-9]{32}\.json$/.test(entry.name)) names.push(entry.name);
        }
      } finally {
        await directory.close();
      }
    } catch {
      return [];
    }

    const records: RunningSessionRecord[] = [];
    const now = Date.now();
    for (const name of names) {
      const filePath = path.join(this.runningSessionsDirectory, name);
      try {
        const fileStats = await lstat(filePath);
        if (!fileStats.isFile() || fileStats.isSymbolicLink()) continue;
        if (fileStats.size > MAX_RUNNING_SESSION_RECORD_BYTES) continue;
        if (now - fileStats.mtimeMs > RUNNING_SESSION_RECORD_TTL_MS) {
          try { await unlink(filePath); } catch { /* A stale lease is harmless if it cannot be removed. */ }
          continue;
        }
        const handle = await openFile(filePath, 'r');
        let text: string;
        try {
          const openedStats = await handle.stat();
          if (!openedStats.isFile() || openedStats.size > MAX_RUNNING_SESSION_RECORD_BYTES) continue;
          text = await handle.readFile({ encoding: 'utf8' });
        } finally {
          await handle.close();
        }
        const value = JSON.parse(text) as Partial<RunningSessionRecord>;
        if (value.version !== 1 || typeof value.sessionKey !== 'string' || !/^[a-f0-9]{64}$/.test(value.sessionKey)
          || (value.workspaceKey !== undefined && (typeof value.workspaceKey !== 'string' || !/^[a-f0-9]{64}$/.test(value.workspaceKey)))
          || typeof value.activity !== 'string' || this.safeRunningActivity(value.activity) !== value.activity
          || !Number.isSafeInteger(value.updatedAt) || Number(value.updatedAt) > now + 2000
          || now - Number(value.updatedAt) > RUNNING_SESSION_RECORD_TTL_MS) continue;
        records.push({
          version: 1,
          sessionKey: value.sessionKey,
          workspaceKey: typeof value.workspaceKey === 'string' ? value.workspaceKey : undefined,
          activity: value.activity,
          updatedAt: Number(value.updatedAt),
        });
      } catch {
        // A partially-written or malformed local status record is ignored.
      }
    }
    return records;
  }

  private async refreshRunningSessionStatuses(): Promise<void> {
    const records = await this.readRunningSessionRecords();
    const bySession = new Map<string, { count: number; activity: string; updatedAt: number }>();
    for (const record of records) {
      const previous = bySession.get(record.sessionKey);
      if (previous) {
        previous.count = Math.min(100, previous.count + 1);
        if (record.updatedAt > previous.updatedAt) {
          previous.activity = record.activity;
          previous.updatedAt = record.updatedAt;
        }
      } else {
        bySession.set(record.sessionKey, { count: 1, activity: record.activity, updatedAt: record.updatedAt });
      }
    }
    const statuses = this.sessionListForRunningStatus.flatMap((session) => {
      const sessionPath = session['path'];
      if (typeof sessionPath !== 'string' || sessionPath.length > 4096) return [];
      const workspacePath = typeof session['workspacePath'] === 'string' && session['workspacePath']
        ? session['workspacePath']
        : this.workerWorkspace;
      if (!workspacePath) return [];
      const sessionKey = this.runningSessionKey(sessionPath, workspacePath);
      const status = sessionKey ? bySession.get(sessionKey) : undefined;
      return status ? [{ path: sessionPath, count: status.count, activity: status.activity }] : [];
    });
    this.post({ type: 'running-session-status', statuses });
  }

  private async isSessionRunning(value: unknown): Promise<boolean> {
    if (!this.isKnownSessionPath(value)) return false;
    let normalizedPath: string;
    try { normalizedPath = this.normalizeSessionPath(value); } catch { return false; }
    const workspacePath = this.sessionWorkspaceByPath.get(normalizedPath) ?? this.workerWorkspace;
    if (!workspacePath) return false;
    const sessionKey = this.runningSessionKey(value, workspacePath);
    if (!sessionKey) return false;
    return (await this.readRunningSessionRecords()).some((record) => record.sessionKey === sessionKey);
  }

  private async openSessionInWorkspace(sessionPath: string, cwd: string): Promise<void> {
    if (!path.isAbsolute(cwd) || cwd.length > 4096 || /[\u0000-\u001f\u007f]/.test(cwd)) {
      this.post({ type: 'notice', message: 'This session has an invalid workspace path and cannot be opened.', isError: true });
      return;
    }
    const workspaceUri = vscode.Uri.file(cwd);
    try {
      const stats = await vscode.workspace.fs.stat(workspaceUri);
      if ((stats.type & vscode.FileType.Directory) === 0) {
        this.post({ type: 'notice', message: 'This session workspace folder no longer exists.', isError: true });
        return;
      }
    } catch {
      this.post({ type: 'notice', message: 'This session workspace folder cannot be accessed.', isError: true });
      return;
    }

    const answer = await vscode.window.showWarningMessage(
      `Open this Pi session in a new VS Code window?\n${cwd}\nThe folder's VS Code settings, tasks, and extensions may load there. Pi will still apply its workspace trust checks.`,
      { modal: true },
      'Open new window',
    );
    if (answer !== 'Open new window') return;
    if (!this.isKnownSessionPath(sessionPath)
      || this.sessionWorkspaceByPath.get(this.normalizeSessionPath(sessionPath)) !== cwd) {
      this.post({ type: 'notice', message: 'The session changed while confirmation was open. Refresh history and try again.', isError: true });
      return;
    }

    const prior = this.context.globalState.get<unknown>(PENDING_SESSION_HANDOFF_KEY);
    const priorAge = isPendingSessionHandoff(prior) ? Date.now() - prior.createdAt : Number.POSITIVE_INFINITY;
    if (isPendingSessionHandoff(prior) && priorAge >= 0 && priorAge <= SESSION_HANDOFF_MAX_AGE_MS) {
      this.post({ type: 'notice', message: 'Another session is already opening in a VS Code workspace. Finish that switch before starting another.', isError: true });
      return;
    }
    if (prior !== undefined) await this.context.globalState.update(PENDING_SESSION_HANDOFF_KEY, undefined);

    const handoff: PendingSessionHandoff = {
      sessionPath,
      cwd,
      createdAt: Date.now(),
      token: randomBytes(16).toString('hex'),
    };
    await this.context.globalState.update(PENDING_SESSION_HANDOFF_KEY, handoff);
    try {
      const opened = await vscode.commands.executeCommand<boolean>('vscode.openFolder', workspaceUri, { forceNewWindow: true });
      if (opened === false) {
        await this.clearSessionHandoff(handoff.token);
        this.post({ type: 'notice', message: 'VS Code did not open the session workspace.', isError: true });
      }
    } catch {
      await this.clearSessionHandoff(handoff.token);
      this.post({ type: 'notice', message: 'Could not open the session workspace in a new VS Code window.', isError: true });
    }
  }

  private consumePendingSessionHandoff(worker: Worker): void {
    const candidate = this.context.globalState.get<unknown>(PENDING_SESSION_HANDOFF_KEY);
    if (candidate === undefined) return;
    if (!isPendingSessionHandoff(candidate)) {
      void this.clearInvalidSessionHandoff(candidate);
      return;
    }
    const handoff = candidate;
    const age = Date.now() - handoff.createdAt;
    if (age < 0 || age > SESSION_HANDOFF_MAX_AGE_MS) {
      void this.clearSessionHandoff(handoff.token);
      return;
    }
    if (typeof this.workerWorkspace !== 'string') return;
    try {
      if (this.normalizeSessionPath(handoff.cwd) !== this.normalizeSessionPath(this.workerWorkspace)) return;
    } catch {
      void this.clearSessionHandoff(handoff.token);
      return;
    }
    if (this.worker !== worker) return;
    if (!this.isKnownSessionPath(handoff.sessionPath)) {
      void this.clearSessionHandoff(handoff.token);
      this.post({ type: 'notice', message: 'The requested Pi session is no longer available in this workspace.', isError: true });
      return;
    }

    this.sessionInteractionStarted = true;
    void (async () => {
      await this.clearSessionHandoff(handoff.token);
      if (this.worker === worker && this.isKnownSessionPath(handoff.sessionPath)) {
        worker.postMessage({ type: 'openSession', path: handoff.sessionPath });
      }
    })().catch(() => this.post({ type: 'notice', message: 'Could not restore the selected Pi session.', isError: true }));
  }

  private async clearSessionHandoff(token: string): Promise<void> {
    if (!/^[a-f0-9]{32}$/.test(token)) return;
    const current = this.context.globalState.get<PendingSessionHandoff>(PENDING_SESSION_HANDOFF_KEY);
    if (current && typeof current.token === 'string' && current.token === token) {
      await this.context.globalState.update(PENDING_SESSION_HANDOFF_KEY, undefined);
    }
  }

  private async clearInvalidSessionHandoff(candidate: unknown): Promise<void> {
    const current = this.context.globalState.get<unknown>(PENDING_SESSION_HANDOFF_KEY);
    if (current === candidate) {
      await this.context.globalState.update(PENDING_SESSION_HANDOFF_KEY, undefined);
      return;
    }
    if (!current || typeof current !== 'object') return;
    if (!candidate || typeof candidate !== 'object') return;
    const expected = candidate as Record<string, unknown>;
    const actual = current as Record<string, unknown>;
    if (actual.sessionPath === expected.sessionPath
      && actual.cwd === expected.cwd
      && actual.createdAt === expected.createdAt
      && actual.token === expected.token) {
      await this.context.globalState.update(PENDING_SESSION_HANDOFF_KEY, undefined);
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
          && isValidBase64ImageData(image.data)
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

  private cancelPendingExtensionUiRequests(worker: Worker | undefined): void {
    if (worker) {
      for (const requestId of this.pendingExtensionUiRequestIds) {
        try {
          worker.postMessage({ type: 'extensionUiResponse', requestId, value: undefined });
        } catch {
          // The worker may already be stopping; its own shutdown resolves remaining requests.
        }
      }
    }
    this.pendingExtensionUiRequestIds.clear();
  }

  private failPendingMcpSetting(worker?: Worker): void {
    const pending = this.pendingMcpSetting;
    if (!pending || (worker && pending.worker !== worker)) return;
    this.pendingMcpSetting = undefined;
    this.post({ type: 'mcp-setting-result', enabled: pending.previous, error: 'The Pi runtime stopped before the MCP setting was applied.' });
  }

  private getHtml(webview: vscode.Webview): string {
    const nonce = randomBytes(16).toString('base64');
    const cssUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'chat.css'))
      .with({ query: `v=${Date.now()}` });
    const rendererUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview-renderers.js'));
    const draftStoreUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'draft-store.js'));
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
        <button id="focus-transcript-toggle" class="icon-button" type="button" title="Hide tool activity" aria-label="Hide tool activity" aria-pressed="false">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 12s3.2-6 9-6 9 6 9 6-3.2 6-9 6-9-6-9-6Z"/><circle cx="12" cy="12" r="2.5"/></svg>
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
        <div class="session-search-row">
          <input id="session-search" class="session-search" type="search" aria-label="Search sessions" placeholder="Search chats, thinking, and tool activity">
          <label class="session-search-scope" title="Search Pi session history from every workspace on this machine"><input id="session-search-all" type="checkbox"><span>All workspaces</span></label>
        </div>
        <div class="session-list-options">
          <label class="session-running-group"><input id="session-group-running" type="checkbox"><span>Group running sessions</span></label>
          <label class="session-sort-order"><span>Order</span><select id="session-sort-order" aria-label="Session order"><option value="manual">Manual</option><option value="updated">Recently updated</option><option value="name">Title</option></select></label>
        </div>
        <div id="session-results-note" class="session-results-note" aria-live="polite" hidden></div>
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
      <section id="extension-custom-layer" class="extension-custom-layer" aria-label="Interactive Pi extension" hidden>
        <div class="extension-custom-dialog" role="dialog" aria-modal="true" aria-labelledby="extension-custom-title">
          <h2 id="extension-custom-title">Pi extension</h2>
          <p id="extension-custom-hint">Use the component controls, or cancel to close it.</p>
          <div id="extension-custom-content" class="extension-custom-content"></div>
          <div class="extension-dialog-actions">
            <button id="extension-custom-cancel" class="text-button" type="button">Cancel</button>
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
        <div id="extension-header" class="extension-chrome extension-chrome-header" aria-label="Pi extension header" hidden></div>
        <div id="extension-widgets-pinned" class="extension-widgets extension-widgets-pinned" aria-label="Pinned Pi extension widgets"></div>
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
        <div id="extension-widgets-above" class="extension-widgets" aria-label="Pi extension widgets above the editor"></div>
        <div id="attachments" class="attachments" aria-label="Attached workspace context"></div>
        <div id="mention-panel" class="mention-panel" role="listbox" aria-label="Workspace files" hidden></div>
        <div class="composer">
          <div id="model-presets" class="model-presets" aria-label="Model presets"></div>
          <div class="composer-controls" aria-label="Session controls">
            <button id="model-toggle" class="control-button model-toggle" type="button" aria-expanded="false" aria-label="Choose model" title="Choose model" disabled>Choose model</button>
            <button id="cycle-model" class="control-button model-cycle" type="button" aria-label="Cycle to next model" title="Cycle to next model" hidden disabled><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 7v5h-5M4 17v-5h5M5.6 9a7 7 0 0 1 11.8-2L20 12M4 12l2.6 5a7 7 0 0 0 11.8-2"/></svg></button>
            <select id="thinking-choice" class="control-select thinking-select" aria-label="Reasoning level" title="Reasoning level" hidden disabled></select>
            <button id="tools-toggle" class="control-button" type="button" aria-expanded="false" disabled>Tools</button>
            <button id="skills-toggle" class="control-button" type="button" aria-expanded="false" disabled>Resources</button>
            <button id="delivery-mode" class="control-button delivery-mode" type="button" aria-label="Queued message mode" title="Click to switch between queue and steer" hidden>Queue next</button>
            <section id="model-popover" class="control-popover model-popover" aria-label="Choose a model" hidden>
              <div class="model-search-row"><input id="model-search" class="session-search" type="search" aria-label="Search models" placeholder="Search models, providers, or vision"><button id="refresh-models" class="icon-button small" type="button" title="Refresh models; may contact providers and run configured API-key commands" aria-label="Refresh model catalog"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 11a8 8 0 0 0-14.8-3L4 10M4 5v5h5M4 13a8 8 0 0 0 14.8 3L20 14m0 5v-5h-5"/></svg></button></div>
              <div class="provider-actions"><span id="provider-status" class="provider-status"></span><button id="connect-provider" class="text-button" type="button">Connect</button><button id="runtime-settings-toggle" class="text-button" type="button" aria-expanded="false">Runtime</button><button id="add-model-endpoint" class="text-button" type="button" title="Add a custom endpoint to Pi's model configuration">Add endpoint</button><button id="edit-models-config" class="text-button" type="button" title="Edit Pi's custom models and providers">Models</button><button id="edit-pi-settings" class="text-button" type="button" title="Open Pi's user settings">Pi settings</button><button id="make-default-model" class="text-button" type="button" title="Use the current model as Pi's default for new sessions" hidden disabled>Set as default</button></div>
              <div class="model-scope-toolbar"><button id="model-scope-toggle" class="text-button" type="button" aria-expanded="false">Model cycling scope</button></div>
              <section id="model-scope-panel" class="model-scope-panel" aria-label="Models available for cycling" hidden>
                <div class="popover-heading"><strong>Models for cycling</strong><span id="model-scope-summary">All models are enabled.</span></div>
                <div class="model-scope-actions"><button id="model-scope-all" class="text-button" type="button">All models</button><button id="save-model-scope" class="text-button" type="button">Save to Pi settings</button></div>
                <div id="model-scope-list" class="option-list model-scope-list"></div>
                <div id="model-scope-status" class="model-scope-status" role="status" aria-live="polite"></div>
              </section>
              <section id="runtime-settings" class="runtime-settings" aria-label="Pi runtime settings" hidden>
                <div class="popover-heading"><strong>Pi runtime settings</strong><span>Saved in global Pi settings</span></div>
                <button id="choose-pi-home" class="text-button" type="button" title="Change the Pi configuration directory and restart Pi when idle">Choose Pi configuration folder</button>
                <button id="restart-pi-runtime" class="text-button" type="button" title="Apply runtime setting changes after running and queued work is finished">Restart Pi runtime</button>
                <label class="runtime-setting"><input id="auto-refresh-models" type="checkbox"><span>Refresh model catalogs at Pi startup</span></label>
                <p class="runtime-settings-note">Requires confirmation. It may contact provider endpoints and run configured API-key commands; skipped in Pi offline mode. Applies after restarting Pi.</p>
                <label class="runtime-setting"><input id="enable-install-telemetry" type="checkbox"><span>Allow Pi anonymous install/update reporting</span></label>
                <p class="runtime-settings-note">Controls Pi install/update reports and selected provider attribution headers. It does not disable update checks; applies after restarting Pi.</p>
                <label class="runtime-setting"><input id="auto-compaction" type="checkbox"><span>Automatic context compaction</span></label>
                <label class="runtime-setting"><input id="auto-retry" type="checkbox"><span>Automatic retry</span></label>
                <label class="runtime-setting"><input id="notification-sound" type="checkbox"><span>Local sound when Pi finishes or needs input while hidden</span></label>
                <button id="test-notification-sound" class="text-button" type="button" disabled>Test sound</button>
                <label class="runtime-setting cache-warming-setting" for="cache-warming"><span>Cache warming</span><select id="cache-warming"><option value="off">Off</option><option value="streaming">While streaming</option><option value="idle">Between runs</option></select></label>
                <label class="runtime-setting cache-warming-setting" for="offline-mode"><span>Startup network mode</span><select id="offline-mode"><option value="inherit">Use Pi environment</option><option value="offline">Offline startup</option><option value="online">Allow startup checks</option></select></label>
                <p class="runtime-settings-note">Offline mode disables automatic startup network operations. Model requests still need a connection. Restart Pi to apply changes.</p>
                <p class="runtime-settings-note">These choices affect Pi sessions using your global settings. Cache warming sends extra provider requests and may cost money.</p>
                <div class="popover-heading extension-command-heading"><strong>Conversation behavior</strong><span>Global Pi defaults</span></div>
                <label class="runtime-setting" for="steering-mode"><span>Queued steering messages</span><select id="steering-mode"><option value="one-at-a-time">One at a time</option><option value="all">All at once</option></select></label>
                <label class="runtime-setting" for="follow-up-mode"><span>Queued follow-ups</span><select id="follow-up-mode"><option value="one-at-a-time">One at a time</option><option value="all">All at once</option></select></label>
                <label class="runtime-setting"><input id="hide-thinking-blocks" type="checkbox"><span>Hide thinking blocks in chat</span></label>
                <label class="runtime-setting"><input id="show-cache-miss-notices" type="checkbox"><span>Show Pi cache-miss notices</span></label>
                <label class="runtime-setting" for="session-share-destination"><span>Pi /share destination</span><select id="session-share-destination"><option value="auto">Automatic</option><option value="gist">GitHub Gist</option><option value="radius">Radius</option></select></label>
                <p class="runtime-settings-note">Project-level <code>.pi/settings.json</code> values can override global defaults. Selecting a destination does not share a session; running Pi’s <code>/share</code> command sends its content there.</p>
                <div class="popover-heading extension-command-heading"><strong>Context files</strong><span>Discovered AGENTS.md instructions</span></div>
                <button id="manage-context-files" class="text-button" type="button" title="Choose discovered Pi context files for this workspace">Choose context files</button>
                <p class="runtime-settings-note">The selection is saved per workspace and applies to future prompts. Applying it reloads Pi resources; enabled extensions may run during reload.</p>
                <div class="popover-heading extension-command-heading"><strong>MCP servers</strong><span>Configured connections are off until you enable them here</span></div>
                <label class="runtime-setting"><input id="mcp-enabled" type="checkbox"><span>Connect configured MCP servers</span></label>
                <button id="manage-mcp-servers" class="text-button" type="button" title="Manage configured server connections and tool exposure">Manage configured servers</button>
                <button id="edit-mcp-config" class="text-button" type="button">Open global mcp.json</button>
                <p class="runtime-settings-note">Enabling a server can launch a local program or contact a remote service. Workspace settings require Pi project trust. Use <code>/mcp</code> to inspect connections and sign in.</p>
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
              <div class="tool-default-actions">
                <span id="new-chat-tool-default-label" aria-live="polite">New chats: Pi defaults</span>
                <div>
                  <button id="save-tool-default" class="text-button" type="button" title="Use the current tool selection for new chats">Save current</button>
                  <button id="reset-tool-default" class="text-button" type="button" title="Use Pi’s configured default tools for new chats">Pi defaults</button>
                </div>
              </div>
              <div id="tool-list" class="option-list"></div>
              <div class="tool-display-preference">
                <span class="tool-display-title">Transcript</span>
                <label><input id="expand-successful-tools" type="checkbox"><span>Expand successful calls by default</span></label>
                <small>Errors always open. Manual changes to a tool card are remembered.</small>
              </div>
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
              <div class="package-heading"><strong>Pi packages</strong><div class="package-heading-actions"><button id="manage-pi-resources" class="text-button" type="button" title="Enable or disable configured Pi extensions, skills, prompts, and themes">Resources</button><button id="refresh-packages" class="text-button" type="button" title="Refresh the configured package list">Refresh</button><button id="update-packages" class="text-button" type="button" title="Update configured packages">Update all</button></div></div>
              <div class="package-install-form"><input id="package-source" type="text" maxlength="512" aria-label="Package source" placeholder="npm:@scope/package or git:host/path"><select id="package-scope" aria-label="Package installation scope"><option value="user">User</option><option value="project">Project</option></select><button id="install-package" class="text-button" type="button">Install</button></div>
              <p class="package-safety-note">Review package sources before installing. Package managers may run code, and enabled extensions can execute inside Pi. Project scope requires workspace trust.</p>
              <div id="package-status" class="package-status" aria-live="polite"></div>
              <div id="package-list" class="package-list"></div>
              <div id="package-empty" class="package-empty">Package manager is unavailable until a Pi session is ready.</div>
              <div class="package-gallery">
                <div class="package-gallery-heading"><strong>Discover packages</strong><button id="popular-packages" class="text-button" type="button" title="Browse Pi packages ranked by npm popularity">Popular</button></div>
                <div class="package-search-form"><input id="package-search" type="search" maxlength="128" autocomplete="off" aria-label="Search Pi packages on npm" placeholder="Search Pi packages on npm"><button id="package-search-button" class="text-button" type="button" disabled>Search</button></div>
                <p class="package-safety-note">Search sends your terms to npm. Popular shows packages tagged for Pi, sorted by npm's popularity signal; popularity is not a safety review. Review sources before installing.</p>
                <div id="package-search-status" class="package-status" aria-live="polite"></div>
                <div id="package-search-results" class="package-list"></div>
              </div>
            </section>
          </div>
          <section id="drafts-panel" class="drafts-panel" aria-label="Saved drafts" hidden>
            <div class="drafts-panel-heading"><strong>Saved drafts</strong><button id="save-draft" class="text-button" type="button" title="Save the current message and attachments, then clear the composer">Save &amp; clear</button></div>
            <div id="drafts-list" class="drafts-list"></div>
            <div id="draft-undo" class="draft-undo" hidden><span>Draft deleted</span><button id="undo-draft" class="text-button" type="button">Undo</button></div>
          </section>
          <div id="extension-editor-view" class="extension-editor-view" role="textbox" aria-label="Pi extension editor" aria-multiline="true" tabindex="0" hidden></div>
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
              <button id="drafts-toggle" class="text-button drafts-toggle" type="button" aria-expanded="false" aria-controls="drafts-panel">Drafts</button>
            </div>
            <button id="send" class="send-button" type="button" title="Send message" aria-label="Send message">
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 19V5m-6 6 6-6 6 6"/></svg>
            </button>
          </div>
        </div>
        <div id="extension-widgets-below" class="extension-widgets extension-widgets-below" aria-label="Pi extension widgets below the editor"></div>
        <div id="extension-footer" class="extension-chrome extension-chrome-footer" aria-label="Pi extension footer" hidden></div>
        <div id="context-meter" class="context-meter" role="meter" aria-label="Pi context usage" aria-valuemin="0" aria-valuemax="100" hidden>
          <span id="context-meter-fill" class="context-meter-fill"></span>
          <span id="context-meter-label" class="context-meter-label"></span>
          <button id="compact-session" class="context-meter-action" type="button" hidden>Compact</button>
        </div>
        <div class="composer-note"><span>Pi uses your existing configuration</span><span id="extension-status" class="extension-status"></span><span id="session-usage" aria-label="Session token and cost usage"></span><span id="model-label"></span></div>
      </footer>
    </section>
  </div>
  <script nonce="${nonce}" src="${rendererUri}"></script>
  <script nonce="${nonce}" src="${draftStoreUri}"></script>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}
