import { parentPort, workerData } from 'node:worker_threads';
import { statSync, watch, type FSWatcher } from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, dirname, isAbsolute, join, relative } from 'node:path';
import { isPiPackageSource } from './package-source';
import {
  createAgentSession,
  createCodemodeExtension,
  createMcpExtension,
  createToolSearchExtension,
  DefaultResourceLoader,
  DefaultPackageManager,
  getAgentDir,
  hasTrustRequiringProjectResources,
  ProjectTrustStore,
  SessionManager,
  SettingsManager,
} from '@earendil-works/pi-coding-agent';

type WorkerInput = {
  type: string;
  text?: string;
  path?: string;
  query?: string;
  allWorkspaces?: boolean;
  name?: string;
  entryId?: string;
  entryIds?: unknown[];
  action?: string;
  setting?: string;
  commandName?: string;
  argumentPrefix?: string;
  requestId?: string;
  enabled?: boolean;
  value?: unknown;
  provider?: string;
  providerId?: string;
  authType?: 'api_key' | 'oauth';
  modelId?: string;
  thinkingLevel?: string;
  presetName?: string;
  toolNames?: string[];
  disabledSkills?: string[];
  source?: string;
  scope?: string;
  resourceChanges?: unknown[];
  autoNameSessions?: boolean;
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
    getEntries: () => Array<{ id?: string; type?: string; customType?: string; data?: unknown; message?: { role?: string; content?: unknown; toolCallId?: string; toolName?: string; isError?: boolean; details?: unknown }; targetId?: string; replacement?: { content?: unknown } | null }>;
    getBranch: () => Array<{ id: string; type?: string; targetId?: string; replacement?: { content?: unknown } | null; message?: { role?: string; content?: unknown } }>;
    getLeafId: () => string | null;
    appendCustomEntry: (customType: string, data?: unknown) => string;
    createBranchedSession: (leafId: string) => string | undefined;
    appendSessionInfo: (name: string) => string;
    appendContextEdit?: (targetId: string, replacement: { content: unknown } | null) => string;
    buildContextEntries: () => Array<{ type?: string; id: string; customType?: string; data?: unknown; message?: { role?: string; content?: unknown; toolCallId?: string; toolName?: string; isError?: boolean; details?: unknown }; targetId?: string; replacement?: { content?: unknown } | null }>;
  };
  sessionName?: string;
  setSessionName?: (name: string) => void;
  autoCompactionEnabled?: boolean;
  setAutoCompactionEnabled?: (enabled: boolean) => void;
  autoRetryEnabled?: boolean;
  setAutoRetryEnabled?: (enabled: boolean) => void;
  setCacheWarmingMode?: (mode: 'off' | 'streaming' | 'idle') => void;
  settingsManager?: SettingsManager;
  getUserMessagesForForking?: () => Array<{ entryId: string; text: string }>;
  navigateTree?: (targetId: string, options?: { summarize?: boolean }) => Promise<{ editorText?: string; cancelled: boolean }>;
  exportToHtml?: () => Promise<string>;
  exportToJsonl?: () => string;
  extensionRunner?: {
    setUIContext: (ui: any, mode?: 'tui' | 'rpc' | 'json' | 'print') => void;
    emit?: (event: { type: 'session_shutdown'; reason: 'quit' | 'reload' }) => Promise<unknown>;
    getRegisteredCommands?: () => Array<{
      invocationName: string;
      description?: string;
      getArgumentCompletions?: (prefix: string) => unknown;
    }>;
  };
  bindExtensions?: (bindings: Record<string, unknown>) => Promise<void>;
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

const workerOptions = workerData as { cwd?: string; mcpEnabled?: boolean; autoNameSessions?: boolean } | undefined;
const cwd = String(workerOptions?.cwd ?? process.cwd());
let mcpEnabled = workerOptions?.mcpEnabled === true;
let autoNameSessions = workerOptions?.autoNameSessions !== false;
const MAX_TOOL_UI_CHARS = 100_000;
const MAX_TOOL_DETAILS_CHARS = 24_000;
const PI_RESOURCE_TYPES = ['extensions', 'skills', 'prompts', 'themes'] as const;
type PiResourceType = typeof PI_RESOURCE_TYPES[number];
type ConfiguredPiResource = {
  id: string;
  type: PiResourceType;
  path: string;
  pattern: string;
  source: string;
  scope: 'user' | 'project';
  origin: 'package' | 'top-level';
  enabled: boolean;
  label: string;
  sourceLabel: string;
};
let session: SessionLike | undefined;
let packageManager: DefaultPackageManager | undefined;
let configuredPiResources = new Map<string, ConfiguredPiResource>();
let unsubscribe: (() => void) | undefined;
let busy = false;
let compacting = false;
let reloadingResources = false;
let authenticatingProvider = false;
let providerAuthController: AbortController | undefined;
let defaultTools: string[] = [];
let sessionExtensionsBound = false;
let disabledSkills = new Set<string>();
let skillsDisabledBySource = new Set<string>();
let sessionQuery = '';
let sessionSearchAllWorkspaces = false;
let sessionListController: AbortController | undefined;
const MAX_CROSS_WORKSPACE_SESSION_RESULTS = 500;
const sessionSearchCache = new Map<string, { modified: number; text: string }>();
let sessionSearchCacheChars = 0;
const MAX_SESSION_SEARCH_CACHE_ENTRIES = 32;
const MAX_SESSION_SEARCH_CACHE_CHARS = 2_000_000;
const MAX_SESSION_SEARCH_INDEX_CHARS = 128_000;
const MAX_PENDING_UI_REQUESTS = 64;
let uiRequestSequence = 0;
let modelWatcher: FSWatcher | undefined;
let modelRefreshTimer: ReturnType<typeof setTimeout> | undefined;
let disposing = false;
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

const RESTORABLE_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const MAX_RESTORED_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_RESTORED_IMAGE_COUNT = 5;
const MAX_TRANSCRIPT_IMAGE_BYTES = 12 * 1024 * 1024;
const MAX_TRANSCRIPT_IMAGE_COUNT = 8;
const MAX_TRANSCRIPT_IMAGES_PER_MESSAGE = 3;

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

function restoreImageContent(content: unknown): { images: Array<{ data: string; mimeType: string }>; skipped: number } {
  if (!Array.isArray(content)) return { images: [], skipped: 0 };
  const images: Array<{ data: string; mimeType: string }> = [];
  let skipped = 0;
  let totalBytes = 0;
  for (const part of content) {
    if (!part || typeof part !== 'object' || (part as Record<string, unknown>).type !== 'image') continue;
    const image = part as Record<string, unknown>;
    const data = image.data;
    const mimeType = image.mimeType;
    if (typeof data !== 'string' || data.length > 7_000_000 || !isValidBase64ImageData(data)
      || typeof mimeType !== 'string' || !RESTORABLE_IMAGE_TYPES.has(mimeType)) {
      skipped += 1;
      continue;
    }
    const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0;
    const decodedBytes = Math.floor(data.length * 3 / 4) - padding;
    if (decodedBytes <= 0 || decodedBytes > MAX_RESTORED_IMAGE_BYTES
      || totalBytes + decodedBytes > MAX_RESTORED_IMAGE_BYTES * MAX_RESTORED_IMAGE_COUNT
      || images.length >= MAX_RESTORED_IMAGE_COUNT) {
      skipped += 1;
      continue;
    }
    images.push({ data, mimeType });
    totalBytes += decodedBytes;
  }
  return { images, skipped };
}

function addBoundedTranscriptImages(messages: Array<{ imageContent?: unknown; imageCount?: number; [key: string]: unknown }>): void {
  let totalBytes = 0;
  let totalImages = 0;
  for (let messageIndex = messages.length - 1; messageIndex >= 0; messageIndex -= 1) {
    const message = messages[messageIndex];
    const content = message.imageContent;
    delete message.imageContent;
    if (!Array.isArray(content)) continue;
    const parts = content.filter((part: any) => part && part.type === 'image');
    if (!parts.length) continue;
    const images: Array<{ data: string; mimeType: string }> = [];
    let omitted = 0;
    for (let index = parts.length - 1; index >= 0; index -= 1) {
      const image = parts[index] as Record<string, unknown>;
      const data = image.data;
      const mimeType = image.mimeType;
      if (typeof data !== 'string' || data.length > 7_000_000 || !isValidBase64ImageData(data)
        || typeof mimeType !== 'string' || !RESTORABLE_IMAGE_TYPES.has(mimeType)) {
        omitted += 1;
        continue;
      }
      const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0;
      const decodedBytes = Math.floor(data.length * 3 / 4) - padding;
      if (decodedBytes <= 0 || decodedBytes > MAX_RESTORED_IMAGE_BYTES
        || totalBytes + decodedBytes > MAX_TRANSCRIPT_IMAGE_BYTES
        || totalImages >= MAX_TRANSCRIPT_IMAGE_COUNT
        || images.length >= MAX_TRANSCRIPT_IMAGES_PER_MESSAGE) {
        omitted += 1;
        continue;
      }
      images.push({ data, mimeType });
      totalBytes += decodedBytes;
      totalImages += 1;
    }
    images.reverse();
    if (images.length) message.images = images;
    if (omitted) message.imageDisplayOmitted = omitted;
  }
}

function boundedTranscriptImageFields(content: unknown): Record<string, unknown> {
  const imageCount = Array.isArray(content) ? content.filter((part: any) => part?.type === 'image').length : 0;
  if (!imageCount) return {};
  const message: { imageContent?: unknown; imageCount: number; hasImages: boolean; [key: string]: unknown } = {
    imageContent: content,
    imageCount,
    hasImages: true,
  };
  addBoundedTranscriptImages([message]);
  const { images, imageDisplayOmitted } = message;
  return {
    hasImages: true,
    imageCount,
    ...(images ? { images } : {}),
    ...(imageDisplayOmitted ? { imageDisplayOmitted } : {}),
  };
}

function boundedToolValue(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return value.length <= 8000 ? value : `${value.slice(0, 8000)}\n[value truncated]`;
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (depth >= 5) return '[nested value omitted]';
  if (Array.isArray(value)) {
    const result = value.slice(0, 50).map((item) => boundedToolValue(item, depth + 1));
    if (value.length > result.length) result.push(`[${value.length - result.length} more items omitted]`);
    return result;
  }
  if (typeof value === 'object') {
    const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    let count = 0;
    for (const key in value) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
      if (count >= 50) {
        result['[remaining properties]'] = 'omitted';
        break;
      }
      result[key.slice(0, 128)] = boundedToolValue((value as Record<string, unknown>)[key], depth + 1);
      count += 1;
    }
    return result;
  }
  return String(value).slice(0, 8000);
}

function toolOutput(result: unknown): string {
  if (typeof result === 'string') return limitToolUiText(result);
  if (result && typeof result === 'object' && Array.isArray((result as { content?: unknown[] }).content)) {
    const output: string[] = [];
    let remaining = MAX_TOOL_UI_CHARS;
    const content = (result as { content: unknown[] }).content;
    const parts = content.slice(0, 1000);
    for (const item of parts) {
      if (!item || typeof item !== 'object') continue;
      const part = item as { type?: string; text?: string };
      const text = part.type === 'text' && typeof part.text === 'string' ? part.text : part.type === 'image' ? '[image output]' : '';
      if (!text) continue;
      if (text.length > remaining) {
        output.push(`${text.slice(0, remaining)}\n[tool output truncated]`);
        break;
      }
      output.push(text);
      remaining -= text.length + 1;
      if (remaining <= 0) {
        output.push('[tool output truncated]');
        break;
      }
    }
    if (content.length > parts.length && remaining > 0) output.push(`[${content.length - parts.length} more output parts omitted]`);
    return output.join('\n');
  }
  try {
    return limitToolUiText(JSON.stringify(boundedToolValue(result ?? ''), null, 2));
  } catch {
    return '[tool output unavailable]';
  }
}

function boundedStructuredToolValue(value: unknown, budget: { remaining: number }, depth = 0): unknown {
  if (value === undefined) return undefined;
  if (budget.remaining <= 0) return '[details truncated]';
  if (typeof value === 'string') {
    const available = Math.max(0, budget.remaining - 24);
    const text = value.length <= available ? value : `${value.slice(0, available)}[truncated]`;
    budget.remaining -= text.length;
    return text;
  }
  if (value === null || typeof value === 'boolean' || typeof value === 'number') {
    budget.remaining -= 16;
    return value;
  }
  if (depth >= 9) return '[nested value omitted]';
  if (Array.isArray(value)) {
    const result: unknown[] = [];
    const length = Math.min(value.length, 50);
    for (let index = 0; index < length; index += 1) {
      if (budget.remaining <= 32) {
        result.push('[details truncated]');
        break;
      }
      result.push(boundedStructuredToolValue(value[index], budget, depth + 1));
    }
    if (value.length > length && budget.remaining > 32) result.push(`[${value.length - length} more items omitted]`);
    return result;
  }
  if (typeof value === 'object') {
    const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    let count = 0;
    for (const key in value) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
      if (count >= 50 || budget.remaining <= 32) {
        result['[remaining properties]'] = 'omitted';
        break;
      }
      const safeKey = key.slice(0, Math.min(128, Math.max(1, budget.remaining - 32)));
      budget.remaining -= safeKey.length;
      try {
        result[safeKey] = boundedStructuredToolValue((value as Record<string, unknown>)[key], budget, depth + 1);
      } catch {
        result[safeKey] = '[value unavailable]';
      }
      count += 1;
    }
    return result;
  }
  return '[value omitted]';
}

function toolDetails(result: unknown): unknown {
  if (!result || typeof result !== 'object') return undefined;
  try {
    const details = (result as { details?: unknown }).details;
    if (details === undefined) return undefined;
    if (details && typeof details === 'object' && !Array.isArray(details)) {
      const source = details as Record<string, unknown>;
      const modes = new Set(['single', 'parallel', 'chain']);
      if (typeof source.mode === 'string' && modes.has(source.mode) && Array.isArray(source.results)) {
        const runs = source.results.slice(0, 8).flatMap((value) => {
          if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
          const run = value as Record<string, unknown>;
          const transcript = Array.isArray(run.messages)
            ? run.messages.slice(-120).filter((message) => message && typeof message === 'object' && (message as Record<string, unknown>).role === 'assistant').slice(-30).map((message) => {
              const content = (message as Record<string, unknown>).content;
              const blocks: Array<Record<string, unknown>> = Array.isArray(content) ? content.slice(-80).flatMap((part): Array<Record<string, unknown>> => {
                if (!part || typeof part !== 'object') return [];
                const block = part as Record<string, unknown>;
                if (block.type === 'text' && typeof block.text === 'string') return [{ type: 'text', text: block.text }];
                if (block.type === 'toolCall') return [{ type: 'toolCall', name: block.name, arguments: block.arguments }];
                return [];
              }).slice(-40) : [];
              return { content: blocks };
            })
            : [];
          return [{
            agent: run.agent,
            agentSource: run.agentSource,
            task: run.task,
            exitCode: run.exitCode,
            stderr: run.stderr,
            usage: run.usage,
            model: run.model,
            stopReason: run.stopReason,
            errorMessage: run.errorMessage,
            step: run.step,
            messages: transcript,
          }];
        });
        return boundedStructuredToolValue({ mode: source.mode, results: runs, omittedResults: Math.max(0, source.results.length - runs.length) }, { remaining: MAX_TOOL_DETAILS_CHARS });
      }
    }
    return boundedStructuredToolValue(details, { remaining: MAX_TOOL_DETAILS_CHARS });
  } catch {
    return undefined;
  }
}

function limitToolUiText(value: string): string {
  return value.length <= MAX_TOOL_UI_CHARS ? value : `${value.slice(0, MAX_TOOL_UI_CHARS)}\n[tool output truncated]`;
}

function toolArgsPreview(args: unknown): string {
  try {
    return limitToolUiText(JSON.stringify(boundedToolValue(args ?? {}), null, 2));
  } catch {
    return '[tool arguments unavailable]';
  }
}

function boundedUiText(value: unknown, maxLength: number): string {
  try {
    return String(value ?? '').slice(0, maxLength);
  } catch {
    return '';
  }
}

function requestExtensionUi(kind: string, title: string, payload: Record<string, unknown> = {}): Promise<unknown> {
  if (pendingUiRequests.size >= MAX_PENDING_UI_REQUESTS) return Promise.resolve(undefined);
  const requestId = `pi-ui-${++uiRequestSequence}`;
  let boundedPayload: Record<string, unknown>;
  try {
    if (kind === 'select') {
      boundedPayload = {
        options: Array.isArray(payload.options)
          ? payload.options.slice(0, 100).map((option) => boundedUiText(option, 512))
          : [],
      };
    } else if (kind === 'confirm') {
      boundedPayload = { message: boundedUiText(payload.message, 4000) };
    } else if (kind === 'input') {
      boundedPayload = { placeholder: boundedUiText(payload.placeholder, 256) };
    } else if (kind === 'editor') {
      boundedPayload = { prefill: boundedUiText(payload.prefill, 8000) };
    } else {
      return Promise.resolve(undefined);
    }
  } catch {
    return Promise.resolve(undefined);
  }
  return new Promise((resolve) => {
    pendingUiRequests.set(requestId, resolve);
    send('extension-ui-request', { requestId, kind, title: boundedUiText(title, 256), ...boundedPayload });
  });
}

async function resolveProjectTrust(settingsManager: SettingsManager): Promise<boolean> {
  if (!hasTrustRequiringProjectResources(cwd)) return true;
  const trustStore = new ProjectTrustStore(getAgentDir());
  const storedDecision = trustStore.get(cwd);
  if (storedDecision !== null) return storedDecision;
  const defaultDecision = settingsManager.getDefaultProjectTrust();
  if (defaultDecision === 'always') return true;
  if (defaultDecision === 'never') return false;

  const requestId = `pi-project-trust-${++uiRequestSequence}`;
  const choice = await new Promise<string | undefined>((resolve) => {
    pendingUiRequests.set(requestId, (value) => resolve(typeof value === 'string' ? value : undefined));
    send('project-trust-request', { requestId, cwd });
  });
  if (choice === 'trust') {
    trustStore.set(cwd, true);
    return true;
  }
  if (choice === 'trust-parent') {
    const parent = join(cwd, '..');
    trustStore.setMany([
      { path: parent, decision: true },
      { path: cwd, decision: null },
    ]);
    return true;
  }
  if (choice === 'trust-session') return true;
  if (choice === 'deny') {
    trustStore.set(cwd, false);
    return false;
  }
  return false;
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

function toUiMessage(message: { role?: string; content?: unknown }): { role: string; text: string; thinking?: string; context?: string; hasImages?: boolean; imageCount?: number } | undefined {
  if (message.role !== 'user' && message.role !== 'assistant') return undefined;
  const raw = contentText(message.content).trim();
  const rawThinking = message.role === 'assistant' && Array.isArray(message.content)
    ? message.content
      .filter((part: any) => part?.type === 'thinking' && part.redacted !== true && typeof part.thinking === 'string')
      .map((part: any) => part.thinking as string)
      .filter(Boolean)
      .join('\n\n')
    : '';
  const thinking = rawThinking.length > 50_000
    ? `[Earlier thinking truncated]\n${rawThinking.slice(-(50_000 - 29))}`
    : rawThinking;
  const imageCount = Array.isArray(message.content)
    ? message.content.filter((part: any) => part?.type === 'image').length
    : 0;
  const hasImages = imageCount > 0;
  if (!raw && !hasImages && !thinking) return undefined;

  const start = '--- pi-extension-context:start ---';
  const end = '--- pi-extension-context:end ---';
  const startIndex = raw.indexOf(start);
  const endIndex = startIndex >= 0 ? raw.indexOf(end, startIndex + start.length) : -1;
  if (message.role === 'user' && startIndex >= 0 && endIndex > startIndex) {
    const context = raw.slice(startIndex + start.length, endIndex).trim();
    const text = `${raw.slice(0, startIndex)}\n${raw.slice(endIndex + end.length)}`.trim();
    return { role: message.role, text, context, hasImages, imageCount };
  }
  return { role: message.role, text: raw, ...(thinking ? { thinking } : {}), hasImages, imageCount };
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
  const usageStats = session.getSessionStats?.();
  const branchEntries = session.sessionManager?.buildContextEntries() ?? [];
  const contextEdits = new Map<string, { content?: unknown } | null>();
  for (const entry of branchEntries) {
    if (entry.type === 'context_edit' && typeof entry.targetId === 'string') contextEdits.set(entry.targetId, entry.replacement ?? null);
  }
  const toolCalls = new Map<string, { name: string; argsPreview: string }>();
  for (const entry of branchEntries) {
    if (entry.type !== 'message' || entry.message?.role !== 'assistant' || !Array.isArray(entry.message.content)) continue;
    for (const part of entry.message.content as Array<Record<string, unknown>>) {
      if (part.type !== 'toolCall' || typeof part.id !== 'string' || !part.id || part.id.length > 256) continue;
      toolCalls.set(part.id, {
        name: typeof part.name === 'string' ? part.name.slice(0, 128) : 'tool',
        argsPreview: toolArgsPreview(part.arguments),
      });
    }
  }
  type SnapshotMessage = { role: string; text?: string; imageContent?: unknown; [key: string]: unknown };
  const userAssistantSnapshot = (
    display: NonNullable<ReturnType<typeof toUiMessage>>,
    entryId: string,
    content: unknown,
  ): SnapshotMessage => ({
    ...display,
    entryId,
    ...(display.hasImages ? { imageContent: content } : {}),
  });
  const messages: SnapshotMessage[] = branchEntries.flatMap((entry): SnapshotMessage[] => {
    if (entry.type !== 'message' || !entry.message) return [];
    if (entry.message.role === 'toolResult') {
      const toolCallId = typeof entry.message.toolCallId === 'string' ? entry.message.toolCallId.slice(0, 256) : '';
      const call = toolCalls.get(toolCallId);
      const imageCount = Array.isArray(entry.message.content)
        ? entry.message.content.filter((part: any) => part?.type === 'image').length
        : 0;
      return [{
        role: 'tool',
        toolCallId,
        toolName: typeof entry.message.toolName === 'string' ? entry.message.toolName.slice(0, 128) : call?.name ?? 'tool',
        argsPreview: call?.argsPreview ?? '{}',
        result: toolOutput(entry.message),
        details: toolDetails(entry.message),
        isError: entry.message.isError === true,
        ...(imageCount ? { imageContent: entry.message.content, imageCount, hasImages: true } : {}),
      }];
    }
    if (entry.message.role !== 'user' && entry.message.role !== 'assistant') return [];
    const display = toUiMessage(entry.message);
    if (!display) return [];
    if (!contextEdits.has(entry.id)) return [userAssistantSnapshot(display, entry.id, entry.message.content)];
    const replacement = contextEdits.get(entry.id);
    if (replacement === null) return [{ ...userAssistantSnapshot(display, entry.id, entry.message.content), contextStatus: 'omitted' }];
    const edited = replacement && 'content' in replacement
      ? toUiMessage({ role: entry.message.role, content: replacement.content })
      : undefined;
    return [{
      ...userAssistantSnapshot(display, entry.id, entry.message.content),
      contextStatus: 'edited',
      contextEditText: edited?.text ?? contentText(replacement?.content),
    }];
  });
  addBoundedTranscriptImages(messages);
  send('snapshot', {
    sessionId: session.sessionId,
    sessionFile: session.sessionFile,
    title: session.sessionName || messages.find((message) => message.role === 'user')?.text || 'New chat',
    model: model?.id ? `${model.provider ?? ''} ${model.id}`.trim() : undefined,
    messages,
    busy,
    contextUsage: session.getContextUsage?.(),
    sessionStats: usageStats ? { tokens: { total: usageStats.tokens.total }, cost: usageStats.cost } : undefined,
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
  const tools = session.getAllTools?.().slice(0, 1000).flatMap((tool) => {
    if (typeof tool.name !== 'string' || !tool.name || tool.name.length > 128) return [];
    return [{
      name: tool.name,
      description: (tool.description ?? '').slice(0, 1000),
      namespace: (tool.namespace?.name ?? '').slice(0, 128),
    }];
  }) ?? [];
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
    mcpEnabled,
    modelsConfigPath: join(getAgentDir(), 'models.json'),
    settingsConfigPath: join(getAgentDir(), 'settings.json'),
    mcpConfigPath: join(getAgentDir(), 'mcp.json'),
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

async function bindSession(next: SessionLike, extensionsBound = false): Promise<void> {
  sessionListController?.abort();
  sessionListController = undefined;
  providerAuthController?.abort();
  providerAuthController = undefined;
  if (pendingUiRequests.size) send('extension-ui-reset');
  for (const resolve of pendingUiRequests.values()) resolve(undefined);
  pendingUiRequests.clear();
  pendingProviderAuthRequests.clear();
  if (session && sessionExtensionsBound) {
    try {
      await session.extensionRunner?.emit?.({ type: 'session_shutdown', reason: 'reload' });
    } catch {
      // Dispose the old session even if an extension shutdown hook fails.
    }
  }
  unsubscribe?.();
  session?.dispose();
  session = next;
  sessionExtensionsBound = extensionsBound;
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
      } else if (update?.type === 'thinking_delta' && typeof update.delta === 'string') {
        send('thinking-delta', { text: update.delta.slice(0, 50_000) });
        send('activity', { message: 'Pi is thinking' });
      } else if (update?.type === 'thinking_start') {
        send('activity', { message: 'Pi is thinking' });
      }
    } else if (event.type === 'tool_execution_start') {
      const toolName = String(event.toolName ?? 'tool').slice(0, 128);
      send('tool-start', {
        id: String(event.toolCallId ?? `${Date.now()}`).slice(0, 256),
        name: toolName,
        argsPreview: toolArgsPreview(event.args),
      });
      send('activity', { message: `Running ${toolName}` });
    } else if (event.type === 'tool_execution_update') {
      send('tool-update', {
        id: String(event.toolCallId ?? '').slice(0, 256),
        name: String(event.toolName ?? 'tool').slice(0, 128),
        result: toolOutput(event.partialResult),
        details: toolDetails(event.partialResult),
      });
    } else if (event.type === 'tool_execution_end') {
      send('tool-end', {
        id: String(event.toolCallId ?? '').slice(0, 256),
        name: String(event.toolName ?? 'tool').slice(0, 128),
        result: toolOutput(event.result),
        details: toolDetails(event.result),
        isError: Boolean(event.isError),
        ...boundedTranscriptImageFields(event.result?.content),
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

function removeSessionSearchCacheEntry(path: string): void {
  const cached = sessionSearchCache.get(path);
  if (!cached) return;
  sessionSearchCache.delete(path);
  sessionSearchCacheChars = Math.max(0, sessionSearchCacheChars - cached.text.length);
}

function sessionSupplementalSearchMatches(path: string, query: string): boolean {
  let modified: number;
  try {
    modified = statSync(path).mtimeMs;
  } catch {
    return false;
  }
  const cached = sessionSearchCache.get(path);
  if (cached?.modified === modified) {
    sessionSearchCache.delete(path);
    sessionSearchCache.set(path, cached);
    return cached.text.includes(query);
  }
  removeSessionSearchCacheEntry(path);

  let matches = false;
  let cacheable = true;
  let indexChars = 0;
  const indexParts: string[] = [];
  const addSearchText = (value: unknown): void => {
    if (typeof value !== 'string' || !value) return;
    const normalized = value.toLocaleLowerCase();
    if (normalized.includes(query)) matches = true;
    if (!cacheable) return;
    if (indexChars + normalized.length + 1 > MAX_SESSION_SEARCH_INDEX_CHARS) {
      cacheable = false;
      indexParts.length = 0;
      indexChars = 0;
      return;
    }
    indexParts.push(normalized);
    indexChars += normalized.length + 1;
  };

  try {
    const entries = SessionManager.open(path).getEntries() as Array<Record<string, any>>;
    for (const entry of entries) {
      if (entry.type !== 'message' || !entry.message || typeof entry.message !== 'object') continue;
      const message = entry.message as Record<string, any>;
      if (message.role === 'assistant' && Array.isArray(message.content)) {
        for (const part of message.content) {
          if (!part || typeof part !== 'object') continue;
          if (part.type === 'thinking' && part.redacted !== true) addSearchText(part.thinking);
          else if (part.type === 'toolCall') {
            addSearchText(part.name);
            if (part.arguments !== undefined) {
              try {
                addSearchText(JSON.stringify(part.arguments));
              } catch {
                // Skip malformed extension or legacy tool arguments.
              }
            }
          }
        }
      } else if (message.role === 'toolResult') {
        addSearchText(message.toolName);
        if (Array.isArray(message.content)) {
          for (const part of message.content) {
            if (part?.type === 'text') addSearchText(part.text);
          }
        }
        if (message.details !== undefined) {
          try {
            addSearchText(JSON.stringify(boundedStructuredToolValue(message.details, { remaining: MAX_TOOL_DETAILS_CHARS })));
          } catch {
            // Details are optional and may be malformed in legacy session data.
          }
        }
      }
    }
  } catch {
    return false;
  }

  if (cacheable) {
    const text = indexParts.join('\n');
    if (text.length <= MAX_SESSION_SEARCH_CACHE_CHARS) {
      while (sessionSearchCache.size >= MAX_SESSION_SEARCH_CACHE_ENTRIES
        || sessionSearchCacheChars + text.length > MAX_SESSION_SEARCH_CACHE_CHARS) {
        const oldestPath = sessionSearchCache.keys().next().value as string | undefined;
        if (!oldestPath) break;
        removeSessionSearchCacheEntry(oldestPath);
      }
      sessionSearchCache.set(path, { modified, text });
      sessionSearchCacheChars += text.length;
    }
  }
  return matches;
}

async function listSessions(query = sessionQuery, allWorkspaces = sessionSearchAllWorkspaces): Promise<void> {
  sessionListController?.abort();
  const controller = new AbortController();
  sessionListController = controller;
  try {
    sessionQuery = query;
    sessionSearchAllWorkspaces = allWorkspaces;
    const sessions = allWorkspaces
      ? await SessionManager.listAll(undefined, undefined, controller.signal)
      : await SessionManager.list(cwd, undefined, undefined, controller.signal);
    if (controller.signal.aborted) return;
    const normalizedQuery = query.trim().toLocaleLowerCase();
    const matchingSessions = sessions.flatMap((item: any) => {
      if (controller.signal.aborted) return [];
      if (!normalizedQuery) return [{ item, supplementalMatch: false }];
      const primaryText = `${item.name ?? ''}\n${item.firstMessage ?? ''}\n${item.allMessagesText ?? ''}`.toLocaleLowerCase();
      const primaryMatch = primaryText.includes(normalizedQuery);
      const supplementalMatch = !primaryMatch && typeof item.path === 'string'
        && sessionSupplementalSearchMatches(item.path, normalizedQuery);
      return primaryMatch || supplementalMatch ? [{ item, supplementalMatch }] : [];
    });
    if (controller.signal.aborted) return;
    const visibleSessions = allWorkspaces
      ? matchingSessions.slice(0, MAX_CROSS_WORKSPACE_SESSION_RESULTS)
      : matchingSessions;
    send('sessions', {
      allWorkspaces,
      total: matchingSessions.length,
      truncated: visibleSessions.length < matchingSessions.length,
      sessionPaths: visibleSessions.map(({ item }) => String(item.path ?? '')),
      sessions: visibleSessions.map(({ item, supplementalMatch }) => ({
        id: String(item.id ?? ''),
        path: String(item.path ?? ''),
        cwd: typeof item.cwd === 'string' ? item.cwd.slice(0, 4096) : '',
        title: String(item.name ?? item.firstMessage ?? 'New chat').replace(/\s+/g, ' ').slice(0, 96),
        modified: item.modified instanceof Date ? item.modified.getTime() : 0,
        ...(supplementalMatch ? { searchMatch: 'thinking-or-tool-activity' } : {}),
      })),
    });
  } catch (error) {
    if (!controller.signal.aborted) {
      send('runtime-error', { message: error instanceof Error ? error.message : 'Could not read Pi sessions.' });
    }
  } finally {
    if (sessionListController === controller) sessionListController = undefined;
  }
}

function sendConfiguredPackages(): void {
  const projectTrusted = session?.settingsManager?.isProjectTrusted() === true;
  const packages = packageManager?.listConfiguredPackages()
    .filter((item) => item.scope === 'user' || projectTrusted)
    .slice(0, 200).map((item) => ({
    source: String(item.source).slice(0, 512),
    scope: item.scope,
    filtered: item.filtered === true,
  })) ?? [];
  send('packages', { available: Boolean(packageManager), projectTrusted, packages });
}

async function collectConfiguredPiResources(): Promise<ConfiguredPiResource[]> {
  const manager = packageManager;
  if (!manager) return [];
  const resolved = await manager.resolve(async () => 'skip');
  const resources = new Map<string, ConfiguredPiResource>();
  for (const type of PI_RESOURCE_TYPES) {
    for (const item of resolved[type]) {
      const { path: resourcePath, enabled, metadata } = item;
      if (typeof resourcePath !== 'string' || !resourcePath || resourcePath.length > 4096
        || (metadata.scope !== 'user' && metadata.scope !== 'project')
        || (metadata.origin !== 'package' && metadata.origin !== 'top-level')) continue;
      const scope = metadata.scope;
      const source = String(metadata.source ?? '').slice(0, 512);
      const baseDir = metadata.origin === 'package'
        ? metadata.packageRoot ?? metadata.baseDir ?? dirname(resourcePath)
        : metadata.baseDir ?? (scope === 'project' ? join(cwd, '.pi') : getAgentDir());
      const rawPattern = metadata.source === 'builtin' ? resourcePath : relative(baseDir, resourcePath);
      const pattern = rawPattern || basename(resourcePath);
      const normalizedPattern = pattern.replace(/\\/g, '/');
      if (metadata.origin === 'package'
        && (isAbsolute(pattern) || normalizedPattern === '..' || normalizedPattern.startsWith('../'))) continue;
      const id = createHash('sha256')
        .update(`${type}\0${scope}\0${metadata.origin}\0${source}\0${resourcePath}`)
        .digest('hex')
        .slice(0, 24);
      const sourceLabel = source === 'auto' ? 'Auto-discovered'
        : source === 'local' ? 'Pi settings'
          : source === 'builtin' ? 'Built-in'
            : /^(?:npm:|git:|https?:\/\/)/.test(source) ? source : basename(source) || 'Local package';
      resources.set(id, {
        id,
        type,
        path: resourcePath,
        pattern,
        source,
        scope,
        origin: metadata.origin,
        enabled: enabled === true,
        label: (resourcePath.startsWith('builtin:') ? resourcePath.slice('builtin:'.length)
          : type === 'skills' && basename(resourcePath).toLowerCase() === 'skill.md' ? basename(dirname(resourcePath))
            : basename(resourcePath)).slice(0, 160),
        sourceLabel: sourceLabel.slice(0, 180),
      });
    }
  }
  const typeOrder = new Map(PI_RESOURCE_TYPES.map((type, index) => [type, index]));
  const result = [...resources.values()].sort((left, right) =>
    (typeOrder.get(left.type) ?? 0) - (typeOrder.get(right.type) ?? 0)
      || left.label.localeCompare(right.label));
  configuredPiResources = new Map(result.map((resource) => [resource.id, resource]));
  return result.slice(0, 500);
}

async function sendPiResources(requestId?: string): Promise<void> {
  const settingsManager = session?.settingsManager;
  if (!packageManager || !settingsManager) {
    send('pi-resources', { ...(requestId ? { requestId } : {}), available: false, projectTrusted: false, resources: [] });
    return;
  }
  try {
    const resources = await collectConfiguredPiResources();
    send('pi-resources', {
      ...(requestId ? { requestId } : {}),
      available: true,
      projectTrusted: settingsManager.isProjectTrusted(),
      resources: resources.map(({ id, type, scope, enabled, label, sourceLabel, pattern }) => ({ id, type, scope, enabled, label, sourceLabel, pattern })),
    });
  } catch (error) {
    configuredPiResources.clear();
    send('pi-resources', {
      ...(requestId ? { requestId } : {}),
      available: false,
      projectTrusted: settingsManager.isProjectTrusted(),
      resources: [],
      error: error instanceof Error ? error.message.slice(0, 500) : 'Could not read configured Pi resources.',
    });
  }
}

function updateResourcePatterns(current: unknown, pattern: string, enabled: boolean): string[] {
  const entries = Array.isArray(current)
    ? current.filter((entry): entry is string => typeof entry === 'string' && entry.length <= 4096)
    : [];
  const updated = entries.filter((entry) => {
    const target = /^[!+-]/.test(entry) ? entry.slice(1) : entry;
    return target.replace(/\\/g, '/') !== pattern.replace(/\\/g, '/');
  });
  updated.push(`${enabled ? '+' : '-'}${pattern}`);
  return updated;
}

function persistPiResourceState(settingsManager: SettingsManager, resource: ConfiguredPiResource, enabled: boolean): void {
  const settings = (resource.scope === 'project' ? settingsManager.getProjectSettings() : settingsManager.getGlobalSettings()) as unknown as Record<string, unknown>;
  if (resource.origin === 'package') {
    const packages = Array.isArray(settings.packages) ? [...settings.packages] : [];
    const packageIndex = packages.findIndex((entry) => {
      if (typeof entry === 'string') return entry === resource.source;
      return Boolean(entry && typeof entry === 'object' && (entry as Record<string, unknown>).source === resource.source);
    });
    if (packageIndex < 0) throw new Error('That Pi package is no longer configured. Refresh the resource list and try again.');
    const existing = packages[packageIndex];
    const packageSettings: Record<string, unknown> = typeof existing === 'string'
      ? { source: existing }
      : { ...(existing as Record<string, unknown>) };
    const existingPatterns = packageSettings[resource.type];
    if (enabled && Array.isArray(existingPatterns) && existingPatterns.length === 0) {
      const excludeOthers = [...configuredPiResources.values()]
        .filter((candidate) => candidate.id !== resource.id
          && candidate.type === resource.type
          && candidate.scope === resource.scope
          && candidate.origin === 'package'
          && candidate.source === resource.source)
        .map((candidate) => `-${candidate.pattern}`);
      packageSettings[resource.type] = [`+${resource.pattern}`, ...excludeOthers];
    } else {
      packageSettings[resource.type] = updateResourcePatterns(existingPatterns, resource.pattern, enabled);
    }
    const hasResourceFilters = PI_RESOURCE_TYPES.some((type) => packageSettings[type] !== undefined);
    packages[packageIndex] = !hasResourceFilters && packageSettings.autoload !== false
      ? resource.source
      : packageSettings;
    if (resource.scope === 'project') settingsManager.setProjectPackages(packages as never);
    else settingsManager.setPackages(packages as never);
    return;
  }

  const updated = updateResourcePatterns(settings[resource.type], resource.pattern, enabled);
  if (resource.scope === 'project') {
    if (resource.type === 'extensions') settingsManager.setProjectExtensionPaths(updated);
    else if (resource.type === 'skills') settingsManager.setProjectSkillPaths(updated);
    else if (resource.type === 'prompts') settingsManager.setProjectPromptTemplatePaths(updated);
    else settingsManager.setProjectThemePaths(updated);
  } else {
    if (resource.type === 'extensions') settingsManager.setExtensionPaths(updated);
    else if (resource.type === 'skills') settingsManager.setSkillPaths(updated);
    else if (resource.type === 'prompts') settingsManager.setPromptTemplatePaths(updated);
    else settingsManager.setThemePaths(updated);
  }
}

async function setPiResourceStates(input: WorkerInput): Promise<void> {
  if (busy || reloadingResources) {
    send('notice', { message: 'Wait for the current Pi operation to finish before changing resource settings.' });
    return;
  }
  const settingsManager = session?.settingsManager;
  if (!packageManager || !settingsManager) {
    send('notice', { message: 'Open a Pi session before changing resource settings.', isError: true });
    return;
  }
  const rawChanges = Array.isArray(input.resourceChanges) ? input.resourceChanges : [];
  if (rawChanges.length === 0 || rawChanges.length > 500) return;
  const changes: Array<{ id: string; enabled: boolean; expectedEnabled: boolean }> = [];
  const seen = new Set<string>();
  for (const value of rawChanges) {
    if (!value || typeof value !== 'object') return;
    const item = value as Record<string, unknown>;
    if (typeof item.id !== 'string' || !/^[a-f0-9]{24}$/.test(item.id)
      || typeof item.enabled !== 'boolean' || typeof item.expectedEnabled !== 'boolean'
      || seen.has(item.id)) return;
    seen.add(item.id);
    changes.push({ id: item.id, enabled: item.enabled, expectedEnabled: item.expectedEnabled });
  }
  try {
    await collectConfiguredPiResources();
    const validated = changes.map((change) => {
      const resource = configuredPiResources.get(change.id);
      if (!resource || resource.enabled !== change.expectedEnabled) {
        throw new Error('The Pi resource list changed. Reopen it and try again.');
      }
      if (resource.scope === 'project' && !settingsManager.isProjectTrusted()) {
        throw new Error('Trust this workspace before changing project-scoped Pi resources.');
      }
      return { resource, enabled: change.enabled };
    }).filter(({ resource, enabled }) => resource.enabled !== enabled);
    for (const { resource, enabled } of validated) persistPiResourceState(settingsManager, resource, enabled);
    if (validated.length === 0) return;
    await settingsManager.flush();
    send('notice', {
      message: `Saved ${validated.length} Pi resource setting${validated.length === 1 ? '' : 's'}. Reload Pi resources or open a new session to apply the changes.`,
    });
    sendConfiguredPackages();
  } catch (error) {
    send('notice', { message: error instanceof Error ? error.message.slice(0, 500) : 'Could not update Pi resource settings.', isError: true });
  }
}

async function manageConfiguredPackage(input: WorkerInput): Promise<void> {
  if (busy) {
    send('notice', { message: 'Wait for the current Pi operation to finish before managing packages.' });
    return;
  }
  const manager = packageManager;
  const activeSession = session;
  const action = input.action;
  const source = typeof input.source === 'string' ? input.source.trim() : '';
  const scope = input.scope === 'project' ? 'project' : input.scope === 'user' ? 'user' : undefined;
  if (!manager || !activeSession) {
    send('notice', { message: 'Open a Pi session before managing packages.' });
    sendConfiguredPackages();
    return;
  }
  if (action !== 'install' && action !== 'remove' && action !== 'update') return;
  if (source.length > 512 || /[\u0000-\u001f\u007f]/.test(source)
    || ((action === 'install' || action === 'remove') && (!source || !scope || !isPiPackageSource(source)))) {
    send('notice', { message: 'The package source or scope is invalid.' });
    return;
  }
  if (scope === 'project' && activeSession.settingsManager?.isProjectTrusted() !== true) {
    send('notice', { message: 'Project package changes are available only after you trust this workspace.' });
    return;
  }

  busy = true;
  reloadingResources = true;
  send('run-started', { canStop: false, activity: 'Managing Pi packages' });
  const sessionSettings = activeSession.settingsManager;
  const updatingUserPackagesOnly = action === 'update' && sessionSettings?.isProjectTrusted() !== true;
  let operationManager = manager;
  try {
    if (updatingUserPackagesOnly && sessionSettings) {
      operationManager = new DefaultPackageManager({
        cwd,
        agentDir: getAgentDir(),
        settingsManager: SettingsManager.inMemory(sessionSettings.getGlobalSettings(), { projectTrusted: false }),
      });
    }
    operationManager.setProgressCallback((event) => {
      send('package-progress', { message: String(event.message ?? `${event.action} ${event.source}`).slice(0, 240) });
    });
    if (action === 'install') {
      await manager.installAndPersist(source, { local: scope === 'project' });
    } else if (action === 'remove') {
      const removed = await manager.removeAndPersist(source, { local: scope === 'project' });
      if (!removed) throw new Error('No matching package was configured in that scope.');
    } else {
      await operationManager.update();
    }
    await activeSession.reload?.();
    const message = action === 'update'
      ? updatingUserPackagesOnly
        ? 'User Pi packages were updated and resources reloaded. Trust this workspace to update project-scoped packages.'
        : 'Configured Pi packages were updated and resources reloaded.'
      : `Pi package ${action === 'install' ? 'installed' : 'removed'} and resources reloaded.`;
    send('notice', { message });
  } catch (error) {
    send('notice', { message: `Could not ${action} Pi package${source ? ` ${source}` : 's'}: ${error instanceof Error ? error.message.slice(0, 500) : 'unknown error'}`, isError: true });
  } finally {
    operationManager.setProgressCallback(undefined);
    reloadingResources = false;
    busy = false;
    send('run-finished', { aborted: false, packageOperation: true });
    sendConfiguredPackages();
    snapshot();
    sendOptions();
  }
}

function titleFromFirstPrompt(prompt: string): string {
  const normalized = prompt.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (normalized.length <= 64) return normalized;
  const shortened = normalized.slice(0, 64).replace(/\s+\S*$/, '').trim();
  return shortened || normalized.slice(0, 64).trim();
}

async function createSession(path?: string): Promise<boolean> {
  let createdSession: SessionLike | undefined;
  let createdExtensionsBound = false;
  try {
    const manager = path ? SessionManager.open(path) : SessionManager.create(cwd);
    const settingsManager = SettingsManager.create(cwd, getAgentDir(), { projectTrusted: false });
    const extensionFactories = mcpEnabled
      ? [createCodemodeExtension(), createToolSearchExtension(), createMcpExtension({
        openUrl: (url) => send('mcp-open-url', { url: String(url).slice(0, 2048) }),
      })]
      : [];
    const resourceLoader = new DefaultResourceLoader({
      cwd,
      agentDir: getAgentDir(),
      settingsManager,
      extensionFactories,
      disabledBuiltinExtensions: ['mcp'],
    });
    await resourceLoader.reload({ resolveProjectTrust: () => resolveProjectTrust(settingsManager) });
    const result = await createAgentSession({ cwd, sessionManager: manager, settingsManager, resourceLoader });
    createdSession = result.session as unknown as SessionLike;
    packageManager = createdSession.settingsManager
      ? new DefaultPackageManager({ cwd, agentDir: getAgentDir(), settingsManager: createdSession.settingsManager })
      : undefined;
    if (mcpEnabled) {
      installExtensionUi(createdSession);
      createdExtensionsBound = true;
      await createdSession.bindExtensions?.({});
    }
    await bindSession(createdSession, createdExtensionsBound);
    if (mcpEnabled) {
      defaultTools = createdSession.getActiveToolNames?.() ?? defaultTools;
      snapshot();
    }
    watchModelConfig();
    if (result.modelFallbackMessage) send('notice', { message: result.modelFallbackMessage });
    await listSessions();
    sendConfiguredPackages();
    return true;
  } catch (error) {
    if (createdSession && createdSession !== session) {
      if (createdExtensionsBound) {
        try {
          await createdSession.extensionRunner?.emit?.({ type: 'session_shutdown', reason: 'quit' });
        } catch {
          // Dispose a partially opened session even if shutdown fails.
        }
      }
      createdSession.dispose();
    }
    send('runtime-error', { message: error instanceof Error ? error.message : 'Could not open a Pi session.' });
    snapshot();
    return false;
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
  if (disposing && input.type !== 'dispose') return;
  try {
    switch (input.type) {
      case 'dispose': {
        if (disposing) return;
        disposing = true;
        sessionListController?.abort();
        sessionListController = undefined;
        providerAuthController?.abort();
        for (const resolve of pendingUiRequests.values()) resolve(undefined);
        pendingUiRequests.clear();
        pendingProviderAuthRequests.clear();
        clearTimeout(modelRefreshTimer);
        modelWatcher?.close();
        modelWatcher = undefined;
        if (busy) await session?.abort();
        if (session && sessionExtensionsBound) {
          try {
            await session.extensionRunner?.emit?.({ type: 'session_shutdown', reason: 'quit' });
          } catch {
            // Still dispose the session and close the worker.
          }
        }
        unsubscribe?.();
        unsubscribe = undefined;
        session?.dispose();
        session = undefined;
        parentPort?.close();
        return;
      }
      case 'listSessions':
        await listSessions(
          typeof input.query === 'string' ? input.query : sessionQuery,
          typeof input.allWorkspaces === 'boolean' ? input.allWorkspaces : sessionSearchAllWorkspaces,
        );
        return;
      case 'getOptions':
        sendOptions();
        return;
      case 'setMcpEnabled': {
        const requestId = input.requestId;
        if (typeof requestId !== 'string' || requestId.length > 128 || typeof input.enabled !== 'boolean') return;
        if (busy || authenticatingProvider) {
          send('mcp-setting-failed', { requestId, enabled: input.enabled, message: 'Finish the current Pi operation before changing MCP connections.' });
          return;
        }
        if (mcpEnabled === input.enabled) {
          send('mcp-setting-applied', { requestId, enabled: mcpEnabled });
          return;
        }
        const previous = mcpEnabled;
        const activePath = session?.sessionFile;
        mcpEnabled = input.enabled;
        if (activePath) {
          send('session-opening');
          const reopened = await createSession(activePath);
          if (!reopened) {
            mcpEnabled = previous;
            send('mcp-setting-failed', { requestId, enabled: input.enabled, message: 'The active Pi session could not be reopened with the selected MCP setting.' });
            return;
          }
        }
        send('mcp-setting-applied', { requestId, enabled: mcpEnabled });
        return;
      }
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
        autoNameSessions = input.autoNameSessions !== false;
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
        const imageRestore = restoreImageContent(entry.message.content);
        send('extension-editor-text', {
          text,
          context: restored?.context,
          images: imageRestore.images,
          imageRestoreSkipped: imageRestore.skipped,
        });
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
      case 'listPackages':
        sendConfiguredPackages();
        return;
      case 'listPiResources': {
        const requestId = typeof input.requestId === 'string' && input.requestId.length <= 128 ? input.requestId : undefined;
        await sendPiResources(requestId);
        return;
      }
      case 'setPiResourceStates':
        await setPiResourceStates(input);
        return;
      case 'managePackage':
        await manageConfiguredPackage(input);
        return;
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
        const hasPriorNonCommandPrompt = (session.getUserMessagesForForking?.() ?? [])
          .some((message) => typeof message.text === 'string' && !message.text.trimStart().startsWith('/'));
        if (autoNameSessions && !session.sessionName?.trim() && !input.text.trimStart().startsWith('/')
          && !hasPriorNonCommandPrompt) {
          const title = titleFromFirstPrompt(input.text);
          if (title) session.setSessionName?.(title);
        }
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
