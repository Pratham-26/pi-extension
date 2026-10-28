import { parentPort, workerData } from 'node:worker_threads';
import { watch, type FSWatcher } from 'node:fs';
import { createAgentSession, getAgentDir, SessionManager } from '@earendil-works/pi-coding-agent';

type WorkerInput = {
  type: string;
  text?: string;
  path?: string;
  query?: string;
  name?: string;
  entryId?: string;
  entryIds?: unknown[];
  requestId?: string;
  value?: unknown;
  provider?: string;
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
    refresh: (options?: { allowNetwork?: boolean }) => Promise<unknown>;
  };
  resourceLoader?: {
    getSkills: () => { skills: Array<{ name: string; description?: string; disableModelInvocation?: boolean }>; diagnostics?: unknown[] };
    getPrompts: () => { prompts: Array<{ name: string; description?: string; argumentHint?: string }>; diagnostics?: unknown[] };
  };
  getAvailableThinkingLevels?: () => string[];
  supportsThinking?: () => boolean;
  getContextUsage?: () => { tokens: number | null; contextWindow: number; percent: number | null } | undefined;
  getSessionStats?: () => { tokens: { total: number }; cost: number };
  getAllTools?: () => Array<{ name: string; description?: string; namespace?: { name?: string } }>;
  getActiveToolNames?: () => string[];
  setActiveToolsByName?: (toolNames: string[]) => void;
  sessionManager?: {
    getEntries: () => Array<{ id?: string; type?: string; customType?: string; data?: unknown; message?: { role?: string; content?: unknown } }>;
    getBranch: () => Array<{ id: string }>;
    appendCustomEntry: (customType: string, data?: unknown) => string;
    createBranchedSession: (leafId: string) => string | undefined;
    appendSessionInfo: (name: string) => string;
    buildContextEntries: () => Array<{ type?: string; id: string; customType?: string; data?: unknown; message?: { role?: string; content?: unknown } }>;
  };
  sessionName?: string;
  setSessionName?: (name: string) => void;
  getUserMessagesForForking?: () => Array<{ entryId: string; text: string }>;
  navigateTree?: (targetId: string, options?: { summarize?: boolean }) => Promise<{ editorText?: string; cancelled: boolean }>;
  exportToHtml?: () => Promise<string>;
  exportToJsonl?: () => string;
  extensionRunner?: { setUIContext: (ui: any, mode?: 'tui' | 'rpc' | 'json' | 'print') => void };
  setModel?: (model: unknown) => Promise<void>;
  setThinkingLevel?: (level: any) => void;
  steer?: (text: string, images?: Array<{ type: 'image'; data: string; mimeType: string }>) => Promise<unknown>;
  followUp?: (text: string, images?: Array<{ type: 'image'; data: string; mimeType: string }>) => Promise<unknown>;
  clearQueue?: () => { steering: string[]; followUp: string[] };
  compact?: (customInstructions?: string) => Promise<unknown>;
  abortCompaction?: () => void;
  messages?: Array<{ role?: string; content?: unknown }>;
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
let defaultTools: string[] = [];
let disabledSkills = new Set<string>();
let skillsDisabledBySource = new Set<string>();
let sessionQuery = '';
let uiRequestSequence = 0;
let modelWatcher: FSWatcher | undefined;
let modelRefreshTimer: ReturnType<typeof setTimeout> | undefined;
const pendingUiRequests = new Map<string, (value: unknown) => void>();

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

function toUiMessage(message: { role?: string; content?: unknown }): { role: string; text: string; context?: string } | undefined {
  if (message.role !== 'user' && message.role !== 'assistant') return undefined;
  const raw = contentText(message.content).trim();
  if (!raw) return undefined;

  const start = '--- pi-extension-context:start ---';
  const end = '--- pi-extension-context:end ---';
  const startIndex = raw.indexOf(start);
  const endIndex = startIndex >= 0 ? raw.indexOf(end, startIndex + start.length) : -1;
  if (message.role === 'user' && startIndex >= 0 && endIndex > startIndex) {
    const context = raw.slice(startIndex + start.length, endIndex).trim();
    const text = `${raw.slice(0, startIndex)}\n${raw.slice(endIndex + end.length)}`.trim();
    return { role: message.role, text, context };
  }
  return { role: message.role, text: raw };
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
  const messages = (session.messages ?? [])
    .map((message) => toUiMessage(message))
    .filter((message): message is NonNullable<typeof message> => Boolean(message));
  const branchMessages = session.sessionManager?.buildContextEntries()
    .filter((entry) => entry.type === 'message' && (entry.message?.role === 'user' || entry.message?.role === 'assistant'))
    .map((entry) => ({
      entryId: entry.id,
      role: entry.message?.role,
      text: entry.message ? (toUiMessage(entry.message)?.text ?? contentText(entry.message.content)) : '',
    })) ?? [];
  const usedMessageEntries = new Set<string>();
  for (const message of messages) {
    const match = branchMessages.find((item) => item.role === message.role
      && !usedMessageEntries.has(item.entryId)
      && (item.text === message.text || (message.text.length > 0 && item.text.includes(message.text))));
    if (match) {
      (message as { entryId?: string }).entryId = match.entryId;
      usedMessageEntries.add(match.entryId);
    }
  }
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
  const skills = session.resourceLoader?.getSkills().skills.map((skill) => ({
    name: skill.name,
    description: skill.description ?? '',
    disabledForAutoInvoke: Boolean(skill.disableModelInvocation),
    canEnableAutoInvoke: !skillsDisabledBySource.has(skill.name),
  })) ?? [];
  const prompts = session.resourceLoader?.getPrompts().prompts.map((prompt) => ({
    name: prompt.name,
    description: prompt.description ?? '',
    argumentHint: prompt.argumentHint ?? '',
  })) ?? [];
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
    currentModel: currentModel ? { provider: currentModel.provider, id: currentModel.id } : undefined,
    thinkingLevel: session.thinkingLevel,
    thinkingLevels: session.getAvailableThinkingLevels?.() ?? [],
    supportsThinking: session.supportsThinking?.() ?? false,
    skills,
    prompts,
    tools,
    activeTools: session.getActiveToolNames?.() ?? [],
    defaultTools,
    disabledSkills: [...disabledSkills],
    branchPoints,
  });
}

function bindSession(next: SessionLike): void {
  for (const resolve of pendingUiRequests.values()) resolve(undefined);
  pendingUiRequests.clear();
  unsubscribe?.();
  session?.dispose();
  session = next;
  busy = false;
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
      case 'newSession':
        send('session-opening');
        await createSession();
        return;
      case 'openSession':
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
        if (!session?.modelRuntime?.refresh) return;
        await session.modelRuntime.refresh({ allowNetwork: false });
        sendOptions();
        return;
      }
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
