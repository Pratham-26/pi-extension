import { parentPort, workerData } from 'node:worker_threads';
import { watch, type FSWatcher } from 'node:fs';
import { join } from 'node:path';
import { createAgentSession, getAgentDir, SessionManager } from '@earendil-works/pi-coding-agent';

type WorkerInput = {
  type: string;
  text?: string;
  path?: string;
  query?: string;
  name?: string;
  entryId?: string;
  entryIds?: unknown[];
  action?: string;
  setting?: string;
  commandName?: string;
  argumentPrefix?: string;
  requestId?: string;
  value?: unknown;
  provider?: string;
  providerId?: string;
  authType?: 'api_key' | 'oauth';
  modelId?: string;
  thinkingLevel?: string;
  presetName?: string;
  toolNames?: string[];
  disabledSkills?: string[];
  steering?: string[];
  followUp?: string[];
  deliverAs?: 'steer' | 'followUp';
  images?: Array<{ data: string; mimeType: string }>;
};

type SessionLike = {
  sessionId?: string;
  sessionFile?: string;
  model?: { provider?: string; id?: string };
  thinkingLevel?: string;
  modelRuntime?: {
    getAvailableSnapshot: () => Array<{ provider: string; id: string; name?: string; contextWindow?: number; input?: string[] }>;
    getModel: (provider: string, id: string) => unknown;
    refresh: (options?: { allowNetwork?: boolean; providers?: readonly string[] }) => Promise<unknown>;
    getProviders?: () => ReadonlyArray<{
      id: string;
      name: string;
      auth?: {
        apiKey?: { name?: string; login?: unknown };
        oauth?: { name?: string; loginLabel?: string; login?: unknown };
      };
    }>;
    getProvider?: (providerId: string) => { id: string; name: string; auth?: { apiKey?: { name?: string; login?: unknown }; oauth?: { name?: string; loginLabel?: string; login?: unknown } } } | undefined;
    getProviderAuthStatus?: (providerId: string) => { configured: boolean; label?: string };
    login?: (providerId: string, type: 'api_key' | 'oauth', interaction: unknown) => Promise<unknown>;
  };
  resourceLoader?: {
    getExtensions?: () => { errors?: Array<{ path?: string; error?: string }>; warnings?: Array<{ path?: string; warning?: string }> };
    getSkills: () => { skills: Array<{ name: string; description?: string; disableModelInvocation?: boolean }>; diagnostics?: Array<{ type?: string; path?: string; message?: string }> };
    getPrompts: () => { prompts: Array<{ name: string; description?: string; argumentHint?: string; content?: string; filePath?: string }>; diagnostics?: Array<{ type?: string; path?: string; message?: string }> };
    getThemes?: () => { diagnostics?: Array<{ type?: string; path?: string; message?: string }> };
  };
  getAvailableThinkingLevels?: () => string[];
  supportsThinking?: () => boolean;
  getContextUsage?: () => { tokens: number | null; contextWindow: number; percent: number | null } | undefined;
  getSessionStats?: () => { tokens: { total: number }; cost: number };
  getAllTools?: () => Array<{ name: string; description?: string; namespace?: { name?: string } }>;
  getActiveToolNames?: () => string[];
  setActiveToolsByName?: (toolNames: string[]) => void;
  sessionManager?: {
    getEntries: () => Array<{ id?: string; type?: string; customType?: string; data?: unknown; message?: { role?: string; content?: unknown }; targetId?: string; replacement?: { content?: unknown } | null }>;
    getBranch: () => Array<{ id: string; type?: string; targetId?: string; replacement?: { content?: unknown } | null; message?: { role?: string; content?: unknown } }>;
    getLeafId: () => string | null;
    appendCustomEntry: (customType: string, data?: unknown) => string;
    createBranchedSession: (leafId: string) => string | undefined;
    appendSessionInfo: (name: string) => string;
    appendContextEdit?: (targetId: string, replacement: { content: unknown } | null) => string;
    buildContextEntries: () => Array<{ type?: string; id: string; customType?: string; data?: unknown; message?: { role?: string; content?: unknown }; targetId?: string; replacement?: { content?: unknown } | null }>;
  };
  sessionName?: string;
  setSessionName?: (name: string) => void;
  autoCompactionEnabled?: boolean;
  setAutoCompactionEnabled?: (enabled: boolean) => void;
  autoRetryEnabled?: boolean;
  setAutoRetryEnabled?: (enabled: boolean) => void;
  setCacheWarmingMode?: (mode: 'off' | 'streaming' | 'idle') => void;
  settingsManager?: { getCacheWarmingMode?: () => 'off' | 'streaming' | 'idle' };
  getUserMessagesForForking?: () => Array<{ entryId: string; text: string }>;
  navigateTree?: (targetId: string, options?: { summarize?: boolean }) => Promise<{ editorText?: string; cancelled: boolean }>;
  exportToHtml?: () => Promise<string>;
  exportToJsonl?: () => string;
  extensionRunner?: {
    setUIContext: (ui: any, mode?: 'tui' | 'rpc' | 'json' | 'print') => void;
    getRegisteredCommands?: () => Array<{
      invocationName: string;
      description?: string;
      getArgumentCompletions?: (prefix: string) => unknown;
    }>;
  };
  setModel?: (model: unknown) => Promise<void>;
  setThinkingLevel?: (level: any) => void;
  steer?: (text: string, images?: Array<{ type: 'image'; data: string; mimeType: string }>) => Promise<unknown>;
  followUp?: (text: string, images?: Array<{ type: 'image'; data: string; mimeType: string }>) => Promise<unknown>;
  clearQueue?: () => { steering: string[]; followUp: string[] };
  compact?: (customInstructions?: string) => Promise<unknown>;
  abortCompaction?: () => void;
  reload?: () => Promise<void>;
  messages?: Array<{ role?: string; content?: unknown }>;
  refreshContext?: () => void;
  subscribe: (listener: (event: any) => void) => () => void;
  prompt: (text: string, options?: { images?: Array<{ type: 'image'; data: string; mimeType: string }> }) => Promise<void>;
  abort: () => Promise<void>;
  dispose: () => void;
};

const cwd = String((workerData as { cwd?: string } | undefined)?.cwd ?? process.cwd());
let session: SessionLike | undefined;
let unsubscribe: (() => void) | undefined;
let busy = false;
let compacting = false;
let reloadingResources = false;
let authenticatingProvider = false;
let providerAuthController: AbortController | undefined;
let defaultTools: string[] = [];
let disabledSkills = new Set<string>();
let skillsDisabledBySource = new Set<string>();
let sessionQuery = '';
let uiRequestSequence = 0;
let modelWatcher: FSWatcher | undefined;
let modelRefreshTimer: ReturnType<typeof setTimeout> | undefined;
const pendingUiRequests = new Map<string, (value: unknown) => void>();
const pendingProviderAuthRequests = new Set<string>();

function send(type: string, payload: Record<string, unknown> = {}): void {
  parentPort?.postMessage({ type, ...payload });
}

function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((part: any) => part && part.type === 'text' && typeof part.text === 'string')
    .map((part: any) => part.text as string)
    .join('');
}

function toolOutput(result: unknown): string {
  if (typeof result === 'string') return result;
  if (result && typeof result === 'object' && Array.isArray((result as { content?: unknown[] }).content)) {
    return (result as { content: Array<{ type?: string; text?: string }> }).content
      .map((part) => part.type === 'text' ? part.text ?? '' : part.type === 'image' ? '[image output]' : '')
      .filter(Boolean)
      .join('\n');
  }
  try {
    return JSON.stringify(result ?? '', null, 2);
  } catch {
    return String(result);
  }
}

function requestExtensionUi(kind: string, title: string, payload: Record<string, unknown> = {}): Promise<unknown> {
  const requestId = `pi-ui-${++uiRequestSequence}`;
  return new Promise((resolve) => {
    pendingUiRequests.set(requestId, resolve);
    send('extension-ui-request', { requestId, kind, title, ...payload });
  });
}

function requestProviderAuthPrompt(prompt: any): Promise<unknown> {
  const signal = prompt.signal as AbortSignal | undefined;
  if (signal?.aborted) return Promise.resolve(undefined);
  const requestId = `pi-auth-${++uiRequestSequence}`;
  return new Promise((resolve) => {
    const cancel = () => {
      if (!pendingProviderAuthRequests.delete(requestId)) return;
      pendingUiRequests.delete(requestId);
      send('provider-auth-prompt-cancel', { requestId });
      resolve(undefined);
    };
    pendingUiRequests.set(requestId, (value) => {
      pendingProviderAuthRequests.delete(requestId);
      signal?.removeEventListener('abort', cancel);
      resolve(value);
    });
    pendingProviderAuthRequests.add(requestId);
    signal?.addEventListener('abort', cancel, { once: true });
    send('provider-auth-prompt', {
      requestId,
      message: String(prompt.message ?? 'Provider sign-in').slice(0, 1000),
      promptType: String(prompt.type ?? 'text').slice(0, 32),
      placeholder: typeof prompt.placeholder === 'string' ? prompt.placeholder.slice(0, 256) : undefined,
      options: Array.isArray(prompt.options)
        ? prompt.options.slice(0, 100).map((option: any) => ({
          id: String(option.id ?? '').slice(0, 256),
          label: String(option.label ?? option.id ?? '').slice(0, 256),
          description: typeof option.description === 'string' ? option.description.slice(0, 500) : undefined,
        }))
        : undefined,
    });
  });
}

function installExtensionUi(current: SessionLike): void {
  const ui = {
    select: (title: string, options: string[]) => requestExtensionUi('select', title, { options }),
    confirm: (title: string, message: string) => requestExtensionUi('confirm', title, { message }).then(Boolean),
    input: (title: string, placeholder?: string) => requestExtensionUi('input', title, { placeholder }),
    editor: (title: string, prefill?: string) => requestExtensionUi('editor', title, { prefill }),
    notify: (message: string, level?: string) => send('extension-ui-notice', { message, level: level ?? 'info' }),
    setStatus: (key: string, text?: string) => send('extension-status', { key, text }),
    setWorkingMessage: (message?: string) => send('activity', { message: message || 'Pi is working' }),
    setWorkingVisible: (visible: boolean) => send('working-visible', { visible }),
    setTitle: (title: string) => send('extension-title', { title }),
    setWidget: (key: string, content: string[] | undefined, options?: unknown) => {
      if (content === undefined) send('extension-widget-remove', { key });
      else send('extension-widget', { key, content, options });
    },
    setEditorText: (text: string) => send('extension-editor-text', { text }),
    pasteToEditor: (text: string) => send('extension-editor-text', { text, append: true }),
    getEditorText: () => '',
    onTerminalInput: () => () => undefined,
    custom: async () => {
      send('extension-ui-notice', { message: 'This extension requests a terminal custom component, which the sidebar cannot display yet.', level: 'warning' });
      return undefined;
    },
    setWidgetPlacement: () => undefined,
    setFooter: () => undefined,
    setHeader: () => undefined,
    setEditorComponent: () => undefined,
    getEditorComponent: () => undefined,
    getTheme: () => undefined,
    setTheme: () => ({ success: false, error: 'Themes are not available in this sidebar.' }),
    getAllThemes: () => [],
    getToolsExpanded: () => true,
    setToolsExpanded: () => undefined,
  };
  current.extensionRunner?.setUIContext(ui, 'rpc');
}

function toUiMessage(message: { role?: string; content?: unknown }): { role: string; text: string; context?: string; hasImages?: boolean } | undefined {
  if (message.role !== 'user' && message.role !== 'assistant') return undefined;
  const raw = contentText(message.content).trim();
  if (!raw) return undefined;
  const hasImages = Array.isArray(message.content) && message.content.some((part: any) => part?.type === 'image');

  const start = '--- pi-extension-context:start ---';
  const end = '--- pi-extension-context:end ---';
  const startIndex = raw.indexOf(start);
  const endIndex = startIndex >= 0 ? raw.indexOf(end, startIndex + start.length) : -1;
  if (message.role === 'user' && startIndex >= 0 && endIndex > startIndex) {
    const context = raw.slice(startIndex + start.length, endIndex).trim();
    const text = `${raw.slice(0, startIndex)}\n${raw.slice(endIndex + end.length)}`.trim();
    return { role: message.role, text, context, hasImages };
  }
  return { role: message.role, text: raw, hasImages };
}

function withContext(text: string, context?: string): string {
  if (!context) return text;
  const block = `--- pi-extension-context:start ---\n<workspace-context>\n${context}\n</workspace-context>\n--- pi-extension-context:end ---`;
  return text.startsWith('/') ? `${text}\n\n${block}` : `${block}\n\n${text}`;
}

function getSessionBookmarks(): string[] {
  const branchEntries = session?.sessionManager?.buildContextEntries() ?? [];
  const validBookmarkIds = new Set(branchEntries.filter((entry) => entry.type === 'message'
    && (entry.message?.role === 'user' || entry.message?.role === 'assistant')).map((entry) => entry.id));
  const bookmarkEntry = branchEntries
    .filter((entry) => entry.type === 'custom' && entry.customType === 'pi-chat.bookmarks')
    .at(-1)?.data as { entryIds?: unknown } | undefined;
  return Array.isArray(bookmarkEntry?.entryIds)
    ? [...new Set(bookmarkEntry.entryIds.slice(0, 1000).filter((id): id is string => typeof id === 'string' && id.length <= 256 && validBookmarkIds.has(id)))].slice(0, 500)
    : [];
}

function snapshot(): void {
  if (!session) return;
  const model = session.model;
  const branchEntries = session.sessionManager?.buildContextEntries() ?? [];
  const contextEdits = new Map<string, { content?: unknown } | null>();
  for (const entry of branchEntries) {
    if (entry.type === 'context_edit' && typeof entry.targetId === 'string') contextEdits.set(entry.targetId, entry.replacement ?? null);
  }
  const messages = branchEntries.flatMap((entry) => {
    if (entry.type !== 'message' || !entry.message || (entry.message.role !== 'user' && entry.message.role !== 'assistant')) return [];
    const display = toUiMessage(entry.message);
    if (!display) return [];
    if (!contextEdits.has(entry.id)) return [{ ...display, entryId: entry.id }];
    const replacement = contextEdits.get(entry.id);
    if (replacement === null) return [{ ...display, entryId: entry.id, contextStatus: 'omitted' }];
    const edited = replacement && 'content' in replacement
      ? toUiMessage({ role: entry.message.role, content: replacement.content })
      : undefined;
    return [{ ...display, entryId: entry.id, contextStatus: 'edited', contextEditText: edited?.text ?? contentText(replacement?.content) }];
  });
  send('snapshot', {
    sessionId: session.sessionId,
    sessionFile: session.sessionFile,
    title: session.sessionName || messages.find((message) => message.role === 'user')?.text || 'New chat',
    model: model?.id ? `${model.provider ?? ''} ${model.id}`.trim() : undefined,
    messages,
    busy,
    contextUsage: session.getContextUsage?.(),
    sessionStats: session.getSessionStats?.(),
    bookmarks: getSessionBookmarks(),
  });
  sendOptions();
}

function sendOptions(): void {
  if (!session) return;
  const currentModel = session.model;
  const models = session.modelRuntime?.getAvailableSnapshot().map((model) => ({
    provider: model.provider,
    id: model.id,
    name: model.name ?? model.id,
    contextWindow: model.contextWindow,
    supportsImages: Boolean(model.input?.includes('image')),
  })) ?? [];
  const loadedSkills = session.resourceLoader?.getSkills();
  const loadedPrompts = session.resourceLoader?.getPrompts();
  const loadedExtensions = session.resourceLoader?.getExtensions?.();
  let extensionCommands: Array<{ name: string; description: string; hasArgumentCompletions: boolean }> = [];
  try {
    extensionCommands = (session.extensionRunner?.getRegisteredCommands?.() ?? []).slice(0, 100).flatMap((command) => {
      if (typeof command.invocationName !== 'string' || !command.invocationName || command.invocationName.length > 128) return [];
      return [{
        name: command.invocationName,
        description: typeof command.description === 'string' ? command.description.slice(0, 500) : '',
        hasArgumentCompletions: typeof command.getArgumentCompletions === 'function',
      }];
    });
  } catch {
    // A broken extension command should not block the rest of the controls.
  }
  const providers: Array<Record<string, unknown>> = [];
  try {
    for (const provider of (session.modelRuntime?.getProviders?.() ?? []).slice(0, 200)) {
      try {
        const status = session.modelRuntime?.getProviderAuthStatus?.(provider.id);
        providers.push({
          id: provider.id.slice(0, 128),
          name: provider.name.slice(0, 128),
          supportsApiKey: typeof provider.auth?.apiKey?.login === 'function',
          apiKeyName: (provider.auth?.apiKey?.name ?? 'API key').slice(0, 128),
          supportsOAuth: typeof provider.auth?.oauth?.login === 'function',
          oauthLabel: (provider.auth?.oauth?.loginLabel ?? provider.auth?.oauth?.name ?? 'Sign in').slice(0, 128),
          configured: Boolean(status?.configured),
          authLabel: (status?.label ?? '').slice(0, 128),
        });
      } catch {
        // A broken optional provider should not prevent the remaining model controls from rendering.
      }
    }
  } catch {
    // The model catalog remains usable if a provider registry cannot be enumerated.
  }
  const skills = loadedSkills?.skills.slice(0, 200).map((skill) => ({
    name: skill.name.slice(0, 128),
    description: (skill.description ?? '').slice(0, 1000),
    disabledForAutoInvoke: Boolean(skill.disableModelInvocation),
    canEnableAutoInvoke: !skillsDisabledBySource.has(skill.name),
  })) ?? [];
  let promptContentBudget = 300_000;
  const prompts = loadedPrompts?.prompts.slice(0, 100).map((prompt) => {
    const content = (prompt.content ?? '').slice(0, Math.min(20_000, promptContentBudget));
    promptContentBudget -= content.length;
    return {
      name: prompt.name.slice(0, 128),
      description: (prompt.description ?? '').slice(0, 1000),
      argumentHint: (prompt.argumentHint ?? '').slice(0, 300),
      content,
      contentTruncated: content.length < (prompt.content ?? '').length,
      filePath: (prompt.filePath ?? '').slice(0, 4096),
    };
  }) ?? [];
  const resourceDiagnostics: Array<{ resource: string; type: string; message: string; path?: string }> = [];
  for (const item of (loadedExtensions?.errors ?? []).slice(0, 100)) {
    resourceDiagnostics.push({ resource: 'Extension', type: 'error', message: (item.error ?? 'Extension failed to load').slice(0, 1000), path: item.path?.slice(0, 4096) });
  }
  for (const item of (loadedExtensions?.warnings ?? []).slice(0, 100)) {
    resourceDiagnostics.push({ resource: 'Extension', type: 'warning', message: (item.warning ?? 'Extension warning').slice(0, 1000), path: item.path?.slice(0, 4096) });
  }
  for (const [resource, items] of [
    ['Skill', loadedSkills?.diagnostics ?? []],
    ['Prompt', loadedPrompts?.diagnostics ?? []],
    ['Theme', session.resourceLoader?.getThemes?.().diagnostics ?? []],
  ] as const) {
    for (const item of items.slice(0, 100)) {
      resourceDiagnostics.push({
        resource,
        type: item.type === 'error' ? 'error' : item.type === 'collision' ? 'warning' : 'warning',
        message: (item.message ?? 'Resource diagnostic').slice(0, 1000),
        path: item.path?.slice(0, 4096),
      });
    }
  }
  const tools = session.getAllTools?.().map((tool) => ({
    name: tool.name,
    description: tool.description ?? '',
    namespace: tool.namespace?.name ?? '',
  })) ?? [];
  const currentBranchIds = new Set(session.sessionManager?.getBranch().map((entry) => entry.id) ?? []);
  const branchPoints = session.sessionManager?.getEntries()
    .filter((entry) => entry.type === 'message' && entry.message?.role === 'user')
    .map((entry) => ({
      entryId: entry.id ?? '',
      text: entry.message ? (toUiMessage(entry.message)?.text ?? contentText(entry.message.content)) : '',
      currentBranch: Boolean(entry.id && currentBranchIds.has(entry.id)),
    })) ?? [];
  send('options', {
    models,
    runtimeSettings: {
      autoCompaction: Boolean(session.autoCompactionEnabled),
      autoRetry: Boolean(session.autoRetryEnabled),
      cacheWarming: session.settingsManager?.getCacheWarmingMode?.() ?? 'off',
    },
    providers: providers.filter((provider) => provider.supportsApiKey || provider.supportsOAuth),
    extensionCommands,
    modelsConfigPath: join(getAgentDir(), 'models.json'),
    settingsConfigPath: join(getAgentDir(), 'settings.json'),
    currentModel: currentModel ? { provider: currentModel.provider, id: currentModel.id } : undefined,
    thinkingLevel: session.thinkingLevel,
    thinkingLevels: session.getAvailableThinkingLevels?.() ?? [],
    supportsThinking: session.supportsThinking?.() ?? false,
    skills,
    prompts,
    resourceDiagnostics: resourceDiagnostics.slice(0, 100),
    tools,
    activeTools: session.getActiveToolNames?.() ?? [],
    defaultTools,
    disabledSkills: [...disabledSkills],
    branchPoints,
  });
}

function bindSession(next: SessionLike): void {
  providerAuthController?.abort();
  providerAuthController = undefined;
  for (const resolve of pendingUiRequests.values()) resolve(undefined);
  pendingUiRequests.clear();
  pendingProviderAuthRequests.clear();
  unsubscribe?.();
  session?.dispose();
  session = next;
  busy = false;
  compacting = false;
  reloadingResources = false;
  authenticatingProvider = false;
  defaultTools = next.getActiveToolNames?.() ?? [];
  const skillData = next.sessionManager?.getEntries()
    .filter((entry) => entry.type === 'custom' && entry.customType === 'pi-chat.session-settings')
    .at(-1)?.data as { disabledSkills?: unknown } | undefined;
  disabledSkills = new Set(Array.isArray(skillData?.disabledSkills)
    ? skillData.disabledSkills.filter((name): name is string => typeof name === 'string')
    : []);
  const loadedSkills = next.resourceLoader?.getSkills().skills ?? [];
  skillsDisabledBySource = new Set(loadedSkills.filter((skill) => skill.disableModelInvocation).map((skill) => skill.name));
  for (const skill of loadedSkills) skill.disableModelInvocation = skillsDisabledBySource.has(skill.name) || disabledSkills.has(skill.name);
  next.setActiveToolsByName?.(next.getActiveToolNames?.() ?? []);
  installExtensionUi(next);
  unsubscribe = next.subscribe((event: any) => {
    if (event.type === 'message_start' && event.message?.role === 'assistant') {
      send('assistant-start');
    } else if (event.type === 'message_update') {
      const update = event.assistantMessageEvent;
      if (update?.type === 'text_delta' && typeof update.delta === 'string') {
        send('assistant-delta', { text: update.delta });
      } else if (update?.type === 'thinking_start' || update?.type === 'thinking_delta') {
        send('activity', { message: 'Pi is thinking' });
      }
    } else if (event.type === 'tool_execution_start') {
      send('tool-start', {
        id: String(event.toolCallId ?? `${Date.now()}`),
        name: String(event.toolName ?? 'tool'),
        args: event.args ?? {},
      });
      send('activity', { message: `Running ${String(event.toolName ?? 'tool')}` });
    } else if (event.type === 'tool_execution_update') {
      send('tool-update', {
        id: String(event.toolCallId ?? ''),
        name: String(event.toolName ?? 'tool'),
        result: toolOutput(event.partialResult),
      });
    } else if (event.type === 'tool_execution_end') {
      send('tool-end', {
        id: String(event.toolCallId ?? ''),
        name: String(event.toolName ?? 'tool'),
        result: toolOutput(event.result),
        isError: Boolean(event.isError),
      });
    } else if (event.type === 'thinking_level_changed' || event.type === 'model_change') {
      sendOptions();
      snapshot();
    } else if (event.type === 'queue_update') {
      send('queue', {
        steering: event.steering ?? [],
        followUp: event.followUp ?? [],
      });
    } else if (event.type === 'agent_settled') {
      busy = false;
      send('run-finished', { aborted: Boolean(event.aborted) });
      snapshot();
      void listSessions();
    }
  });
  snapshot();
}

async function listSessions(query = sessionQuery): Promise<void> {
  try {
    sessionQuery = query;
    const sessions = await SessionManager.list(cwd);
    const normalizedQuery = query.trim().toLocaleLowerCase();
    send('sessions', {
      sessionPaths: sessions.map((item: any) => String(item.path ?? '')),
      sessions: sessions.filter((item: any) => !normalizedQuery || `${item.name ?? ''}\n${item.firstMessage ?? ''}\n${item.allMessagesText ?? ''}`.toLocaleLowerCase().includes(normalizedQuery)).map((item: any) => ({
        id: String(item.id ?? ''),
        path: String(item.path ?? ''),
        title: String(item.name ?? item.firstMessage ?? 'New chat').replace(/\s+/g, ' ').slice(0, 96),
        modified: item.modified instanceof Date ? item.modified.getTime() : 0,
      })),
    });
  } catch (error) {
    send('runtime-error', { message: error instanceof Error ? error.message : 'Could not read Pi sessions.' });
  }
}

async function createSession(path?: string): Promise<void> {
  try {
    const manager = path ? SessionManager.open(path) : SessionManager.create(cwd);
    const result = await createAgentSession({ cwd, sessionManager: manager });
    bindSession(result.session as unknown as SessionLike);
    watchModelConfig();
    if (result.modelFallbackMessage) send('notice', { message: result.modelFallbackMessage });
    await listSessions();
  } catch (error) {
    send('runtime-error', { message: error instanceof Error ? error.message : 'Could not open a Pi session.' });
    snapshot();
  }
}

function watchModelConfig(): void {
  if (modelWatcher) return;
  try {
    // Watch the directory so creating models.json after the first run is detected too.
    modelWatcher = watch(getAgentDir(), (_event, filename) => {
      if (filename && filename.toString() !== 'models.json') return;
      clearTimeout(modelRefreshTimer);
      modelRefreshTimer = setTimeout(() => {
        if (!session?.modelRuntime?.refresh) return;
        void session.modelRuntime.refresh({ allowNetwork: false }).then(() => sendOptions()).catch((error) => {
          send('notice', { message: `Could not refresh Pi models: ${error instanceof Error ? error.message : String(error)}` });
        });
      }, 160);
    });
  } catch {
    // The models file is still loaded when a session starts; the picker also offers manual refresh.
  }
}

async function handle(input: WorkerInput): Promise<void> {
  try {
    switch (input.type) {
      case 'listSessions':
        await listSessions(typeof input.query === 'string' ? input.query : sessionQuery);
        return;
      case 'getOptions':
        sendOptions();
        return;
      case 'completeExtensionCommand': {
        const requestId = input.requestId;
        const commandName = input.commandName;
        const prefix = input.argumentPrefix;
        if (typeof requestId !== 'string' || requestId.length > 128
          || typeof commandName !== 'string' || commandName.length > 128
          || typeof prefix !== 'string' || prefix.length > 512) return;
        let command: { invocationName: string; getArgumentCompletions?: (prefix: string) => unknown } | undefined;
        try {
          command = session?.extensionRunner?.getRegisteredCommands?.().find((item) => item.invocationName === commandName);
        } catch {
          send('command-completions', { requestId, commandName, items: [], error: true });
          return;
        }
        if (!command?.getArgumentCompletions) {
          send('command-completions', { requestId, commandName, items: [] });
          return;
        }
        let timeout: ReturnType<typeof setTimeout> | undefined;
        try {
          const result = await Promise.race([
            Promise.resolve(command.getArgumentCompletions(prefix)),
            new Promise<never>((_resolve, reject) => {
              timeout = setTimeout(() => reject(new Error('Argument suggestions timed out')), 3000);
            }),
          ]);
          const items = Array.isArray(result) ? result.slice(0, 100).flatMap((item: any) => {
            if (!item || typeof item.value !== 'string' || item.value.length > 512) return [];
            return [{
              value: item.value,
              label: typeof item.label === 'string' ? item.label.slice(0, 256) : item.value.slice(0, 256),
              description: typeof item.description === 'string' ? item.description.slice(0, 500) : '',
            }];
          }) : [];
          send('command-completions', { requestId, commandName, argumentPrefix: prefix, items });
        } catch {
          send('command-completions', { requestId, commandName, argumentPrefix: prefix, items: [], error: true });
        } finally {
          if (timeout) clearTimeout(timeout);
        }
        return;
      }
      case 'newSession':
        if (authenticatingProvider) {
          send('notice', { message: 'Finish or cancel provider sign-in before switching sessions.' });
          return;
        }
        send('session-opening');
        await createSession();
        return;
      case 'cloneSession': {
        if (busy || authenticatingProvider || !session?.sessionManager) return;
        const leafId = session.sessionManager.getLeafId();
        if (!leafId) {
          send('notice', { message: 'Send a message before cloning this session.' });
          return;
        }
        const carriedBookmarks = getSessionBookmarks();
        const clonedPath = session.sessionManager.createBranchedSession(leafId);
        if (!clonedPath) {
          send('notice', { message: 'Pi could not create a copy of this session.' });
          return;
        }
        send('session-opening');
        await createSession(clonedPath);
        if (carriedBookmarks.length && session?.sessionFile === clonedPath && session.sessionManager) {
          const branchIds = new Set(session.sessionManager.buildContextEntries()
            .filter((entry) => entry.type === 'message' && (entry.message?.role === 'user' || entry.message?.role === 'assistant'))
            .map((entry) => entry.id));
          const inherited = carriedBookmarks.filter((entryId) => branchIds.has(entryId));
          if (inherited.length) {
            session.sessionManager.appendCustomEntry('pi-chat.bookmarks', { entryIds: inherited });
            snapshot();
          }
        }
        return;
      }
      case 'openSession':
        if (authenticatingProvider) {
          send('notice', { message: 'Finish or cancel provider sign-in before switching sessions.' });
          return;
        }
        if (input.path) {
          send('session-opening');
          await createSession(input.path);
        }
        return;
      case 'setModel': {
        if (!session || busy || !input.provider || !input.modelId) return;
        const model = session.modelRuntime?.getModel(input.provider, input.modelId);
        if (!model || !session.setModel) throw new Error('That model is not available with the current Pi configuration.');
        await session.setModel(model);
        snapshot();
        return;
      }
      case 'refreshModels': {
        if (!session?.modelRuntime?.refresh || busy) return;
        try {
          const result = await session.modelRuntime.refresh({ allowNetwork: true });
          if (result && typeof result === 'object' && 'errors' in result && result.errors instanceof Map && result.errors.size) {
            send('notice', { message: `Some model catalogs could not refresh: ${[...result.errors.keys()].slice(0, 8).join(', ')}.` });
          }
        } catch (error) {
          send('notice', { message: 'Model catalog refresh failed. Check your Pi provider settings and try again.', isError: true });
        }
        sendOptions();
        return;
      }
      case 'updatePiSetting': {
        if (!session || busy) return;
        if (input.setting === 'autoCompaction' && typeof input.value === 'boolean' && session.setAutoCompactionEnabled) {
          session.setAutoCompactionEnabled(input.value);
        } else if (input.setting === 'autoRetry' && typeof input.value === 'boolean' && session.setAutoRetryEnabled) {
          session.setAutoRetryEnabled(input.value);
        } else if (input.setting === 'cacheWarming'
          && (input.value === 'off' || input.value === 'streaming' || input.value === 'idle')
          && session.setCacheWarmingMode) {
          session.setCacheWarmingMode(input.value);
        } else {
          send('notice', { message: 'That Pi runtime setting is unavailable or invalid.', isError: true });
          sendOptions();
          return;
        }
        send('notice', { message: 'Pi runtime setting saved to global Pi settings.' });
        sendOptions();
        return;
      }
      case 'providerLogin': {
        const runtime = session?.modelRuntime;
        if (!runtime?.getProvider || !runtime.login || busy) return;
        if (typeof input.providerId !== 'string' || input.providerId.length > 128) return;
        const provider = runtime.getProvider(input.providerId);
        const authType = input.authType;
        if (authType !== 'oauth' && authType !== 'api_key') return;
        const canLogin = authType === 'oauth'
          ? typeof provider?.auth?.oauth?.login === 'function'
          : authType === 'api_key' && typeof provider?.auth?.apiKey?.login === 'function';
        if (!provider || !canLogin) throw new Error('That provider sign-in method is unavailable. Refresh providers and try again.');

        busy = true;
        authenticatingProvider = true;
        providerAuthController = new AbortController();
        const controller = providerAuthController;
        send('run-started', { canStop: false, activity: `Connecting ${provider.name}` });
        try {
          await runtime.login(input.providerId, authType, {
            signal: controller.signal,
            prompt: async (prompt: any) => {
              const value = await requestProviderAuthPrompt(prompt);
              if (typeof value !== 'string') {
                controller.abort();
                throw new Error('Provider sign-in cancelled.');
              }
              return value;
            },
            notify: (event: any) => {
              send('provider-auth-event', {
                providerName: provider.name.slice(0, 128),
                eventType: String(event.type ?? 'info').slice(0, 32),
                message: typeof event.message === 'string' ? event.message.slice(0, 1000) : undefined,
                instructions: typeof event.instructions === 'string' ? event.instructions.slice(0, 1000) : undefined,
                url: typeof event.url === 'string' ? event.url.slice(0, 2048) : undefined,
                verificationUri: typeof event.verificationUri === 'string' ? event.verificationUri.slice(0, 2048) : undefined,
                userCode: typeof event.userCode === 'string' ? event.userCode.slice(0, 128) : undefined,
              });
            },
          });
          await runtime.refresh({ allowNetwork: false, providers: [input.providerId] });
          send('notice', { message: `Connected to ${provider.name}. Pi saved the credential in its existing configuration.` });
        } catch (error) {
          if (controller.signal.aborted || (error instanceof Error && error.message === 'Provider sign-in cancelled.')) {
            send('notice', { message: `Sign-in to ${provider.name} was cancelled.` });
          } else {
            send('notice', { message: `Sign-in to ${provider.name} failed. Check your provider settings and try again.`, isError: true });
          }
        } finally {
          if (providerAuthController === controller) providerAuthController = undefined;
          authenticatingProvider = false;
          if (busy) {
            busy = false;
            send('run-finished', { aborted: false, providerLogin: true });
          }
          snapshot();
          sendOptions();
        }
        return;
      }
      case 'cancelProviderLogin':
        providerAuthController?.abort();
        for (const requestId of pendingProviderAuthRequests) {
          send('provider-auth-prompt-cancel', { requestId });
          pendingProviderAuthRequests.delete(requestId);
          const resolve = pendingUiRequests.get(requestId);
          pendingUiRequests.delete(requestId);
          resolve?.(undefined);
        }
        return;
      case 'usePreset': {
        if (!session || busy || !input.provider || !input.modelId) return;
        const model = session.modelRuntime?.getModel(input.provider, input.modelId);
        if (!model || !session.setModel) throw new Error('This preset model is not available in the current Pi configuration.');
        await session.setModel(model);
        if (input.thinkingLevel && session.setThinkingLevel) session.setThinkingLevel(input.thinkingLevel);
        snapshot();
        return;
      }
      case 'setThinkingLevel':
        if (!session || busy || !input.thinkingLevel || !session.setThinkingLevel) return;
        session.setThinkingLevel(input.thinkingLevel);
        snapshot();
        return;
      case 'setTools':
        if (!session || busy || !Array.isArray(input.toolNames) || !session.setActiveToolsByName) return;
        session.setActiveToolsByName(input.toolNames);
        sendOptions();
        return;
      case 'replaceQueue': {
        if (!session || !busy || !session.clearQueue || !session.steer || !session.followUp) return;
        const steering = Array.isArray(input.steering) ? input.steering.filter((text): text is string => typeof text === 'string') : [];
        const followUp = Array.isArray(input.followUp) ? input.followUp.filter((text): text is string => typeof text === 'string') : [];
        session.clearQueue();
        for (const text of steering) await session.steer(text);
        for (const text of followUp) await session.followUp(text);
        return;
      }
      case 'setSkills': {
        if (!session || busy || !Array.isArray(input.disabledSkills)) return;
        disabledSkills = new Set(input.disabledSkills.filter((name): name is string => typeof name === 'string'));
        for (const skill of session.resourceLoader?.getSkills().skills ?? []) {
          skill.disableModelInvocation = skillsDisabledBySource.has(skill.name) || disabledSkills.has(skill.name);
        }
        session.setActiveToolsByName?.(session.getActiveToolNames?.() ?? []);
        session.sessionManager?.appendCustomEntry('pi-chat.session-settings', { disabledSkills: [...disabledSkills] });
        sendOptions();
        return;
      }
      case 'renameSession': {
        if (!input.path || typeof input.name !== 'string') return;
        const cleanName = input.name.trim();
        if (session?.sessionFile === input.path && session.setSessionName) session.setSessionName(cleanName);
        else SessionManager.open(input.path).appendSessionInfo(cleanName);
        snapshot();
        await listSessions();
        return;
      }
      case 'forkSession': {
        if (!input.entryId || busy || !session?.sessionManager) return;
        const carriedBookmarks = getSessionBookmarks();
        const branchedPath = session.sessionManager.createBranchedSession(input.entryId);
        if (!branchedPath) throw new Error('Pi could not create a branch from that message.');
        send('session-opening');
        await createSession(branchedPath);
        if (carriedBookmarks.length && session?.sessionFile === branchedPath && session.sessionManager) {
          const branchIds = new Set(session.sessionManager.buildContextEntries()
            .filter((entry) => entry.type === 'message' && (entry.message?.role === 'user' || entry.message?.role === 'assistant'))
            .map((entry) => entry.id));
          const inherited = carriedBookmarks.filter((entryId) => branchIds.has(entryId));
          if (inherited.length) {
            session.sessionManager.appendCustomEntry('pi-chat.bookmarks', { entryIds: inherited });
            snapshot();
          }
        }
        return;
      }
      case 'navigateTree': {
        if (!input.entryId || busy || !session?.navigateTree) return;
        const result = await session.navigateTree(input.entryId, { summarize: false });
        if (!result.cancelled && result.editorText) send('extension-editor-text', { text: result.editorText });
        snapshot();
        return;
      }
      case 'editUserMessage': {
        if (!input.entryId || busy || !session?.navigateTree || !session.sessionManager) return;
        const entry = session.sessionManager.getEntries().find((candidate) => candidate.id === input.entryId);
        if (entry?.type !== 'message' || entry.message?.role !== 'user') return;
        const result = await session.navigateTree(input.entryId, { summarize: false });
        if (result.cancelled) return;
        const restored = toUiMessage(entry.message);
        const text = restored?.text ?? contentText(entry.message.content);
        send('extension-editor-text', { text, context: restored?.context });
        snapshot();
        return;
      }
      case 'setMessageContext': {
        const manager = session?.sessionManager;
        if (!manager?.appendContextEdit || busy || typeof input.entryId !== 'string' || input.entryId.length > 256) return;
        const entry = manager.buildContextEntries().find((candidate) => candidate.id === input.entryId);
        if (entry?.type !== 'message' || !entry.message || (entry.message.role !== 'user' && entry.message.role !== 'assistant')) return;
        const replacement = input.action === 'omit' ? null
          : input.action === 'restore' ? { content: entry.message.content }
            : undefined;
        if (replacement === undefined) return;
        manager.appendContextEdit(input.entryId, replacement);
        session?.refreshContext?.();
        snapshot();
        return;
      }
      case 'editMessageContext': {
        const manager = session?.sessionManager;
        if (!manager?.appendContextEdit || busy || typeof input.entryId !== 'string' || input.entryId.length > 256
          || typeof input.text !== 'string') return;
        if (input.text.length > 100_000) {
          send('notice', { message: 'Edited context is too long; keep it under 100,000 characters.', isError: true });
          return;
        }
        const entry = manager.buildContextEntries().find((candidate) => candidate.id === input.entryId);
        if (entry?.type !== 'message' || !entry.message || (entry.message.role !== 'user' && entry.message.role !== 'assistant')) return;
        if (toUiMessage(entry.message)?.hasImages) {
          send('notice', { message: 'Messages with images cannot be edited for model context.' });
          return;
        }
        const edits = manager.buildContextEntries().filter((candidate) => candidate.type === 'context_edit' && candidate.targetId === input.entryId);
        const latest = edits.at(-1);
        const currentContent = latest && latest.replacement !== null && latest.replacement && 'content' in latest.replacement
          ? latest.replacement.content
          : entry.message.content;
        const currentMessage = toUiMessage({ role: entry.message.role, content: currentContent });
        const replacementText = entry.message.role === 'user'
          ? withContext(input.text, currentMessage?.context ?? toUiMessage(entry.message)?.context)
          : input.text;
        manager.appendContextEdit(input.entryId, { content: replacementText });
        session?.refreshContext?.();
        snapshot();
        return;
      }
      case 'setBookmarks': {
        if (!session?.sessionManager || !Array.isArray(input.entryIds)) return;
        const valid = new Set(session.sessionManager.buildContextEntries().filter((entry) => entry.type === 'message'
          && (entry.message?.role === 'user' || entry.message?.role === 'assistant')).map((entry) => entry.id));
        const entryIds = [...new Set(input.entryIds.slice(0, 500).filter((id): id is string => typeof id === 'string' && id.length <= 256 && valid.has(id)))];
        session.sessionManager.appendCustomEntry('pi-chat.bookmarks', { entryIds });
        snapshot();
        return;
      }
      case 'compactSession': {
        if (!session?.compact || busy) return;
        busy = true;
        compacting = true;
        send('run-started');
        try {
          await session.compact();
          send('notice', { message: 'Pi compacted the session context.' });
        } finally {
          compacting = false;
          if (busy) {
            busy = false;
            send('run-finished', { aborted: false, compact: true });
          }
          snapshot();
        }
        return;
      }
      case 'reloadResources': {
        if (!session?.reload || busy) return;
        busy = true;
        reloadingResources = true;
        send('run-started', { canStop: false, activity: 'Reloading Pi resources' });
        try {
          await session.reload();
          send('notice', { message: 'Pi resources reloaded.' });
        } finally {
          reloadingResources = false;
          if (busy) {
            busy = false;
            send('run-finished', { aborted: false, resourceReload: true });
          }
          snapshot();
          sendOptions();
        }
        return;
      }
      case 'exportSession': {
        if (!session) return;
        if (input.name === 'html' && session.exportToHtml) {
          const path = await session.exportToHtml();
          send('session-exported', { path, format: 'html' });
        } else if (input.name === 'jsonl' && session.exportToJsonl) {
          const path = session.exportToJsonl();
          send('session-exported', { path, format: 'jsonl' });
        }
        return;
      }
      case 'extensionUiResponse': {
        if (!input.requestId) return;
        const resolve = pendingUiRequests.get(input.requestId);
        if (resolve) {
          pendingUiRequests.delete(input.requestId);
          resolve(input.value);
        }
        return;
      }
      case 'prompt':
        if (!session) await createSession();
        if (!session || !input.text) return;
        const images = (input.images ?? [])
          .filter((image) => typeof image.data === 'string' && typeof image.mimeType === 'string')
          .map((image) => ({ type: 'image' as const, data: image.data, mimeType: image.mimeType }));
        if (busy) {
          if (input.deliverAs === 'steer' && session.steer) await session.steer(input.text, images);
          else if (session.followUp) await session.followUp(input.text, images);
          else throw new Error('This Pi runtime cannot queue messages while a turn is running.');
          return;
        }
        if (!session.prompt) {
          send('runtime-error', { message: 'The Pi session is not ready to accept a prompt.' });
          return;
        }
        busy = true;
        send('run-started');
        await session.prompt(input.text, { images });
        if (busy) {
          busy = false;
          send('run-finished', { aborted: false });
        }
        snapshot();
        await listSessions();
        return;
      case 'stop':
        if (compacting) {
          session?.abortCompaction?.();
          return;
        }
        if (authenticatingProvider) return;
        if (reloadingResources) return;
        if (session && busy) await session.abort();
        if (busy) {
          busy = false;
          send('run-finished', { aborted: true });
          snapshot();
        }
        return;
    }
  } catch (error) {
    if (busy) {
      busy = false;
      send('run-finished', { aborted: false });
    }
    send('runtime-error', { message: error instanceof Error ? error.message : 'The Pi request failed.' });
    snapshot();
  }
}

parentPort?.on('message', (input: WorkerInput) => void handle(input));
send('worker-ready');
