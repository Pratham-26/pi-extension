/* global acquireVsCodeApi */
const vscode = acquireVsCodeApi();
const persistedWebviewState = vscode.getState() || {};
const state = {
  hasWorkspace: false,
  workspaceName: '',
  sessionPath: typeof persistedWebviewState.sessionPath === 'string'
    && persistedWebviewState.sessionPath.length <= 4096
    && !/[\u0000-\u001f\u007f]/.test(persistedWebviewState.sessionPath)
    ? persistedWebviewState.sessionPath
    : '',
  sessions: [],
  sessionQuery: '',
  sessionSearchAllWorkspaces: persistedWebviewState.sessionSearchAllWorkspaces === true,
  drafts: persistedWebviewState.drafts && typeof persistedWebviewState.drafts === 'object' ? persistedWebviewState.drafts : {},
  promptHistory: persistedWebviewState.promptHistory && typeof persistedWebviewState.promptHistory === 'object' ? persistedWebviewState.promptHistory : {},
  toolExpansion: Object.fromEntries(Object.entries(persistedWebviewState.toolExpansion || {})
    .filter(([name, open]) => typeof name === 'string' && name.length > 0 && name.length <= 128 && typeof open === 'boolean')
    .slice(-200)),
  promptSuggestions: undefined,
  focusedTranscript: persistedWebviewState.focusedTranscript === true,
  promptHistoryIndex: -1,
  promptHistoryDraft: '',
  mentionQuery: '',
  mentionResults: [],
  mentionRange: undefined,
  mentionIndex: 0,
  mentionTimer: undefined,
  sessionSearchTimer: undefined,
  messages: [],
  bookmarks: [],
  attachments: [],
  expandedContextId: '',
  pinnedFile: undefined,
  pinnedFileEnabled: false,
  hasSession: false,
  switchingSession: false,
  busy: false,
  stopAllowed: true,
  streamIndex: -1,
  model: '',
  currentModel: undefined,
  providers: [],
  extensionCommands: [],
  commandCompletionRequestId: '',
  commandCompletionContext: undefined,
  commandCompletionSequence: 0,
  mcpEnabled: false,
  mcpSettingPending: false,
  runtimeSettings: { autoCompaction: false, autoRetry: false, cacheWarming: 'off', offlineMode: 'inherit' },
  models: [],
  modelSearch: '',
  chatSearch: '',
  chatSearchHits: [],
  chatSearchIndex: -1,
  presets: [],
  thinkingLevel: '',
  thinkingLevels: [],
  supportsThinking: false,
  skills: [],
  prompts: [],
  resourceDiagnostics: [],
  packages: [],
  packagesAvailable: false,
  projectTrusted: false,
  packageStatus: '',
  promptTemplateForm: undefined,
  tools: [],
  activeTools: [],
  defaultTools: [],
  disabledSkills: [],
  branchPoints: [],
  gitChanges: [],
  gitSummary: undefined,
  gitReviewAvailable: false,
  gitChangesTruncated: false,
  deliverAs: 'followUp',
  queue: { steering: [], followUp: [] },
  toolMessagesBySession: new Map(),
  thinkingExpansion: new Map(),
  extensionWidgets: new Map(),
  extensionStatuses: new Map(),
  extensionRequest: undefined,
  extensionRequestQueue: [],
  extensionQueueFullNotified: false,
  extensionDialogTimer: undefined,
  showWorking: true,
  contextUsage: undefined,
  sessionStats: undefined,
  noticeTimer: undefined,
};

const el = (id) => document.getElementById(id);
const ui = {
  title: el('conversation-title'),
  workspace: el('workspace-name'),
  messageArea: el('messages'),
  messageList: el('message-list'),
  chatSearchBar: el('chat-search-bar'),
  chatSearchInput: el('chat-search-input'),
  chatSearchCount: el('chat-search-count'),
  chatSearchToggle: el('chat-search-toggle'),
  gitReviewToggle: el('git-review-toggle'),
  gitReviewPanel: el('git-review-panel'),
  gitChangeSummary: el('git-change-summary'),
  gitChangeList: el('git-change-list'),
  gitChangeEmpty: el('git-change-empty'),
  gitDraftCommit: el('draft-git-commit'),
  gitDraftPr: el('draft-git-pr'),
  empty: el('empty-state'),
  prompt: el('prompt'),
  send: el('send'),
  stop: el('stop'),
  activity: el('activity'),
  activityText: el('activity-text'),
  queueToggle: el('queue-toggle'),
  queuePanel: el('queue-panel'),
  queueList: el('queue-list'),
  queueEmpty: el('queue-empty'),
  notice: el('notice'),
  extensionWidgets: el('extension-widgets'),
  extensionStatus: el('extension-status'),
  dialogLayer: el('extension-dialog-layer'),
  dialogTitle: el('extension-dialog-title'),
  dialogMessage: el('extension-dialog-message'),
  dialogOptions: el('extension-dialog-options'),
  dialogInput: el('extension-dialog-input'),
  dialogCancel: el('extension-dialog-cancel'),
  dialogSubmit: el('extension-dialog-submit'),
  promptTemplateLayer: el('prompt-template-layer'),
  promptTemplateTitle: el('prompt-template-title'),
  promptTemplateDescription: el('prompt-template-description'),
  promptTemplateFields: el('prompt-template-fields'),
  promptTemplatePreview: el('prompt-template-preview'),
  history: el('history-panel'),
  historyToggle: el('history-toggle'),
  branchHistoryToggle: el('branch-history-toggle'),
  focusTranscriptToggle: el('focus-transcript-toggle'),
  branchPanel: el('branch-panel'),
  branchList: el('branch-list'),
  branchEmpty: el('branch-empty'),
  sessions: el('session-list'),
  sessionsEmpty: el('session-empty'),
  sessionsResults: el('session-results-note'),
  sessionSearch: el('session-search'),
  sessionSearchAll: el('session-search-all'),
  renameSession: el('rename-session'),
  railSessions: el('rail-sessions'),
  attachments: el('attachments'),
  mentionPanel: el('mention-panel'),
  model: el('model-label'),
  modelToggle: el('model-toggle'),
  modelPopover: el('model-popover'),
  modelSearch: el('model-search'),
  modelList: el('model-list'),
  providerStatus: el('provider-status'),
  connectProvider: el('connect-provider'),
  editModelsConfig: el('edit-models-config'),
  addModelEndpoint: el('add-model-endpoint'),
  editPiSettings: el('edit-pi-settings'),
  choosePiAgentDir: el('choose-pi-home'),
  restartPiRuntime: el('restart-pi-runtime'),
  runtimeSettingsToggle: el('runtime-settings-toggle'),
  runtimeSettings: el('runtime-settings'),
  autoCompaction: el('auto-compaction'),
  autoRetry: el('auto-retry'),
  cacheWarming: el('cache-warming'),
  offlineMode: el('offline-mode'),
  manageContextFiles: el('manage-context-files'),
  mcpEnabled: el('mcp-enabled'),
  editMcpConfig: el('edit-mcp-config'),
  contextMeter: el('context-meter'),
  contextMeterFill: el('context-meter-fill'),
  contextMeterLabel: el('context-meter-label'),
  sessionUsage: el('session-usage'),
  compactSession: el('compact-session'),
  bookmarkToggle: el('bookmark-toggle'),
  bookmarkPanel: el('bookmark-panel'),
  bookmarkList: el('bookmark-list'),
  bookmarkEmpty: el('bookmark-empty'),
  presets: el('model-presets'),
  thinkingChoice: el('thinking-choice'),
  toolsToggle: el('tools-toggle'),
  toolsPopover: el('tools-popover'),
  toolList: el('tool-list'),
  skillsToggle: el('skills-toggle'),
  skillsPopover: el('skills-popover'),
  skillList: el('skill-list'),
  extensionCommandList: el('extension-command-list'),
  extensionCommandSuggestions: el('extension-command-suggestions'),
  promptList: el('prompt-list'),
  resourceDiagnostics: el('resource-diagnostics'),
  packageList: el('package-list'),
  packageEmpty: el('package-empty'),
  packageStatus: el('package-status'),
  packageSource: el('package-source'),
  packageScope: el('package-scope'),
  installPackage: el('install-package'),
  managePiResources: el('manage-pi-resources'),
  updatePackages: el('update-packages'),
  newPromptTemplate: el('new-prompt-template'),
  reloadResources: el('reload-pi-resources'),
  deliveryMode: el('delivery-mode'),
  pinActiveFile: el('pin-active-file'),
};

function syncFocusTranscriptToggle() {
  const active = state.focusedTranscript;
  ui.focusTranscriptToggle.title = active ? 'Show tool activity' : 'Hide tool activity';
  ui.focusTranscriptToggle.setAttribute('aria-label', ui.focusTranscriptToggle.title);
  ui.focusTranscriptToggle.setAttribute('aria-pressed', String(active));
}

syncFocusTranscriptToggle();
ui.sessionSearchAll.checked = state.sessionSearchAllWorkspaces;

function post(type, payload = {}) {
  vscode.postMessage({ type, ...payload });
}

function createRequestId() {
  return Array.from(crypto.getRandomValues(new Uint8Array(12)), (value) => value.toString(16).padStart(2, '0')).join('');
}

function persistWebviewState() {
  vscode.setState({ sessionPath: state.sessionPath, drafts: state.drafts, promptHistory: state.promptHistory, toolExpansion: state.toolExpansion, focusedTranscript: state.focusedTranscript, sessionSearchAllWorkspaces: state.sessionSearchAllWorkspaces });
}

function isTranscriptMessageVisible(message) {
  return !state.focusedTranscript || message.role !== 'tool';
}

const EXPLORATION_TOOL_NAMES = new Set(['read', 'grep', 'find', 'ls']);

function isExplorationToolMessage(message) {
  return message?.role === 'tool' && EXPLORATION_TOOL_NAMES.has(String(message.toolName || '').toLowerCase());
}

function toolExpansionPreference(toolName, isError = false) {
  const name = String(toolName || 'tool').slice(0, 128);
  return Object.prototype.hasOwnProperty.call(state.toolExpansion, name) ? state.toolExpansion[name] : isError;
}

function currentSessionKey() {
  return state.switchingSession ? '__new' : (state.sessionPath || '__new');
}

function rememberDraft() {
  const key = currentSessionKey();
  const draft = String(ui.prompt.value || '').slice(0, 20000);
  if (draft) state.drafts[key] = draft;
  else delete state.drafts[key];
  persistWebviewState();
}

function rememberPrompt(text) {
  const key = currentSessionKey();
  const history = Array.isArray(state.promptHistory[key]) ? state.promptHistory[key] : [];
  if (history.at(-1) !== text) history.push(text);
  state.promptHistory[key] = history.slice(-50);
  state.promptHistoryIndex = -1;
  persistWebviewState();
}

function browsePromptHistory(direction) {
  const key = currentSessionKey();
  const history = Array.isArray(state.promptHistory[key]) ? state.promptHistory[key] : [];
  if (!history.length) return;
  if (state.promptHistoryIndex < 0) state.promptHistoryDraft = ui.prompt.value;
  state.promptHistoryIndex = Math.max(-1, Math.min(history.length - 1, state.promptHistoryIndex + direction));
  const historyIndex = history.length - 1 - state.promptHistoryIndex;
  ui.prompt.value = state.promptHistoryIndex < 0 ? state.promptHistoryDraft : history[historyIndex];
  ui.prompt.dispatchEvent(new Event('input'));
  ui.prompt.setSelectionRange(ui.prompt.value.length, ui.prompt.value.length);
}

function updateMentionSearch() {
  const cursor = ui.prompt.selectionStart;
  const beforeCaret = ui.prompt.value.slice(0, cursor);
  const match = beforeCaret.match(/(?:^|\s)@([^\s@]*)$/);
  if (!match) {
    state.mentionRange = undefined;
    ui.mentionPanel.hidden = true;
    return;
  }
  const atOffset = match[0].lastIndexOf('@');
  state.mentionRange = { start: match.index + atOffset, end: cursor };
  state.mentionQuery = match[1];
  state.mentionResults = [];
  state.mentionIndex = 0;
  renderMentionResults();
  clearTimeout(state.mentionTimer);
  state.mentionTimer = setTimeout(() => post('searchMentions', { query: state.mentionQuery }), 160);
}

function renderMentionResults() {
  ui.mentionPanel.replaceChildren();
  if (!state.mentionResults.length) {
    const empty = document.createElement('div');
    empty.className = 'option-empty';
    empty.textContent = state.mentionQuery ? 'Searching workspace files…' : 'Type to search workspace files.';
    ui.mentionPanel.append(empty);
    ui.mentionPanel.hidden = false;
    return;
  }
  state.mentionResults.forEach((item, index) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `mention-result${index === state.mentionIndex ? ' selected' : ''}`;
    button.setAttribute('role', 'option');
    button.setAttribute('aria-selected', String(index === state.mentionIndex));
    button.textContent = `@${item.path}`;
    button.title = item.path;
    button.addEventListener('mousedown', (event) => event.preventDefault());
    button.addEventListener('click', () => chooseMention(index));
    ui.mentionPanel.append(button);
  });
  ui.mentionPanel.hidden = false;
}

function chooseMention(index) {
  const item = state.mentionResults[index];
  const range = state.mentionRange;
  if (!item || !range) return;
  const value = ui.prompt.value;
  const inserted = `@${item.path} `;
  ui.prompt.value = `${value.slice(0, range.start)}${inserted}${value.slice(range.end)}`;
  const caret = range.start + inserted.length;
  ui.prompt.setSelectionRange(caret, caret);
  state.mentionRange = undefined;
  ui.mentionPanel.hidden = true;
  post('attachUris', { uris: [item.uri] });
  ui.prompt.dispatchEvent(new Event('input'));
  ui.prompt.focus();
}

function escapeText(value) {
  return String(value ?? '');
}

function showNotice(message, isError = false) {
  clearTimeout(state.noticeTimer);
  ui.notice.textContent = message;
  ui.notice.classList.toggle('error', isError);
  ui.notice.hidden = !message;
  if (message) {
    state.noticeTimer = setTimeout(() => { ui.notice.hidden = true; }, isError ? 10000 : 6000);
  }
}

function updateWorkspace(name, hasWorkspace) {
  state.workspaceName = name || '';
  state.hasWorkspace = Boolean(hasWorkspace);
  ui.workspace.textContent = state.workspaceName || 'No workspace open';
  ui.workspace.title = state.workspaceName;
  if (!state.hasWorkspace) {
    showNotice('Open a workspace folder to start a Pi chat.');
  } else if (ui.notice.textContent === 'Open a workspace folder to start a Pi chat.') {
    ui.notice.hidden = true;
  }
  updateControls();
}

function updateControls() {
  const hasText = Boolean(ui.prompt.value.trim() || state.attachments.length || state.pinnedFile);
  const hasQueuedWork = state.queue.steering.length + state.queue.followUp.length > 0;
  ui.send.disabled = !state.hasWorkspace || !hasText;
  ui.prompt.disabled = !state.hasWorkspace || state.switchingSession;
  ui.stop.hidden = !state.busy || !state.stopAllowed;
  ui.activity.hidden = !state.busy || !state.showWorking;
  ui.empty.hidden = state.messages.length > 0;
  ui.model.textContent = state.model;
  ui.modelToggle.disabled = !state.hasWorkspace || !state.hasSession || state.busy || state.models.length === 0;
  ui.modelList.querySelectorAll('button').forEach((button) => { button.disabled = state.busy; });
  el('refresh-models').disabled = state.busy;
  ui.presets.querySelectorAll('.preset-choice').forEach((button) => { button.disabled = button.dataset.available !== 'true' || state.busy; });
  ui.thinkingChoice.disabled = !state.hasSession || state.busy || state.thinkingLevels.length === 0;
  ui.compactSession.disabled = !state.hasSession || state.busy;
  ui.bookmarkToggle.disabled = !state.hasSession;
  ui.connectProvider.disabled = !state.hasWorkspace || state.busy || state.providers.length === 0;
  ui.editModelsConfig.disabled = !state.hasWorkspace || state.busy;
  ui.addModelEndpoint.disabled = !state.hasWorkspace || state.busy;
  ui.editPiSettings.disabled = !state.hasWorkspace || state.busy;
  ui.choosePiAgentDir.disabled = !state.hasWorkspace || state.busy || hasQueuedWork;
  ui.restartPiRuntime.disabled = !state.hasWorkspace || state.busy || hasQueuedWork;
  ui.runtimeSettingsToggle.disabled = !state.hasSession || state.busy;
  ui.autoCompaction.disabled = !state.hasSession || state.busy;
  ui.autoRetry.disabled = !state.hasSession || state.busy;
  ui.cacheWarming.disabled = !state.hasSession || state.busy;
  ui.offlineMode.disabled = !state.hasWorkspace || state.busy || hasQueuedWork;
  ui.manageContextFiles.disabled = !state.hasSession || state.busy || hasQueuedWork;
  ui.mcpEnabled.disabled = !state.hasSession || state.busy || state.mcpSettingPending;
  ui.editMcpConfig.disabled = !state.hasWorkspace || state.busy;
  ui.gitReviewToggle.disabled = !state.hasWorkspace;
  el('refresh-git-changes').disabled = !state.hasWorkspace;
  ui.pinActiveFile.disabled = !state.hasWorkspace;
  for (const button of ui.messageList.querySelectorAll('.context-action')) button.disabled = state.busy;
  ui.newPromptTemplate.disabled = !state.hasWorkspace || state.busy;
  ui.reloadResources.disabled = !state.hasSession || state.busy;
  ui.packageSource.disabled = !state.hasSession || state.busy;
  ui.packageScope.disabled = !state.hasSession || state.busy;
  ui.installPackage.disabled = !state.hasSession || state.busy || !ui.packageSource.value.trim();
  ui.managePiResources.disabled = !state.hasSession || state.busy;
  ui.updatePackages.disabled = !state.hasSession || state.busy || state.packages.length === 0;
  ui.packageList.querySelectorAll('button').forEach((button) => { button.disabled = state.busy; });
  ui.toolsToggle.disabled = !state.hasSession || state.busy || state.tools.length === 0;
  ui.skillsToggle.disabled = !state.hasSession;
  ui.toolsPopover.querySelectorAll('input').forEach((input) => { input.disabled = state.busy; });
  ui.skillsPopover.querySelectorAll('.skill-auto-toggle').forEach((input) => {
    const skill = state.skills.find((item) => item.name === input.getAttribute('data-skill-name'));
    input.disabled = state.busy || !skill?.canEnableAutoInvoke;
  });
  ui.skillsPopover.querySelectorAll('.extension-command-suggest').forEach((button) => { button.disabled = state.busy; });
  ui.deliveryMode.hidden = !state.busy;
  ui.deliveryMode.textContent = state.deliverAs === 'steer' ? 'Steer now' : 'Queue next';
  ui.send.title = state.busy ? (state.deliverAs === 'steer' ? 'Send steering message' : 'Queue follow-up') : 'Send message';
  ui.send.setAttribute('aria-label', ui.send.title);
}

function shorten(value, max = 70) {
  const text = escapeText(value).replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function renderSessions() {
  ui.sessions.replaceChildren();
  ui.railSessions.replaceChildren();
  const sessions = state.sessions;
  const runningSessions = sessions.filter((session) => session.running === true);
  const recentSessions = sessions.filter((session) => session.running !== true);
  ui.sessionsEmpty.hidden = sessions.length > 0;
  ui.sessionsEmpty.textContent = state.sessionSearchAllWorkspaces
    ? (state.sessionQuery ? 'No sessions match across Pi workspaces.' : 'No saved Pi sessions were found across workspaces.')
    : (state.sessionQuery ? 'No sessions match this search.' : 'No saved sessions yet.');

  if (runningSessions.length) {
    const heading = document.createElement('div');
    heading.className = 'session-group-heading';
    heading.textContent = `Running sessions · ${runningSessions.length}`;
    ui.sessions.append(heading);
  }
  if (runningSessions.length && recentSessions.length) {
    const heading = document.createElement('div');
    heading.className = 'session-group-heading';
    heading.textContent = 'Recent sessions';
    ui.sessions.append(heading);
  }

  for (const session of [...runningSessions, ...recentSessions]) {
    const entry = document.createElement('div');
    entry.className = `session-entry${session.running === true ? ' running-session-entry' : ''}`;
    const row = document.createElement('button');
    row.type = 'button';
    row.className = `session-row${session.path === state.sessionPath ? ' active' : ''}${session.running === true ? ' running' : ''}`;
    row.title = session.workspacePath ? `${session.title}\n${session.workspacePath}` : session.title;
    const color = document.createElement('span');
    color.className = `session-color color-${['red', 'orange', 'yellow', 'green', 'blue', 'purple'].includes(session.color) ? session.color : 'default'}`;
    color.setAttribute('aria-hidden', 'true');
    const title = document.createElement('span');
    title.className = 'session-row-title';
    title.textContent = shorten(session.title, 76) || 'New chat';
    const id = document.createElement('span');
    id.className = 'session-row-id';
    id.textContent = session.id ? session.id.slice(0, 8) : 'Pi session';
    row.append(color, title, id);
    if (session.running === true) {
      const progress = document.createElement('span');
      progress.className = 'session-row-progress';
      const count = Number.isSafeInteger(session.runningCount) ? Math.max(1, Math.min(100, session.runningCount)) : 1;
      const activity = typeof session.runningActivity === 'string' ? session.runningActivity.slice(0, 96) : 'Working in Pi';
      progress.textContent = count > 1 ? `${count} windows · ${activity}` : activity;
      row.append(progress);
    }
    if (session.isCurrentWorkspace === false) {
      const workspace = document.createElement('span');
      workspace.className = 'session-row-workspace';
      workspace.textContent = `In ${session.workspaceName || 'unknown workspace'}`;
      workspace.title = session.workspacePath || 'Workspace path unavailable';
      row.append(workspace);
    }
    if (session.searchMatch === 'thinking-or-tool-activity') {
      const match = document.createElement('span');
      match.className = 'session-row-match';
      match.textContent = 'Matched thinking or tool activity';
      if (session.isCurrentWorkspace === false) match.classList.add('has-workspace');
      row.append(match);
    }
    row.addEventListener('click', () => {
      closeHistory();
      if (session.isCurrentWorkspace === false || (!session.workspacePath && state.sessionSearchAllWorkspaces)) {
        post('openSession', { path: session.path });
        return;
      }
      state.switchingSession = true;
      setBusy(true, 'Opening session');
      post('openSession', { path: session.path });
    });
    entry.append(row);
    const actions = document.createElement('div');
    actions.className = 'session-actions';
    const pin = document.createElement('button');
    pin.type = 'button';
    pin.className = 'session-action';
    pin.textContent = session.pinned ? 'Pinned' : 'Pin';
    pin.title = session.pinned ? 'Unpin session' : 'Pin session';
    pin.addEventListener('click', () => post('toggleSessionPin', { path: session.path }));
    const changeColor = document.createElement('button');
    changeColor.type = 'button';
    changeColor.className = 'session-action';
    changeColor.textContent = 'Color';
    changeColor.addEventListener('click', () => post('colorSession', { path: session.path }));
    const rename = document.createElement('button');
    rename.type = 'button';
    rename.className = 'session-action';
    rename.textContent = 'Rename';
    rename.disabled = session.running === true;
    rename.title = rename.disabled ? 'Wait for the session to finish before renaming it' : 'Rename session';
    rename.addEventListener('click', () => post('renameSession', { path: session.path, currentName: session.title }));
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'session-action danger-action';
    remove.textContent = 'Delete';
    remove.disabled = session.path === state.sessionPath || session.running === true;
    remove.title = session.running === true ? 'Wait for the session to finish before deleting it'
      : remove.disabled ? 'Switch to another session before deleting this one' : 'Permanently delete this session';
    remove.addEventListener('click', () => post('deleteSession', { path: session.path, title: session.title }));
    actions.append(pin, changeColor, rename, remove);
    entry.append(actions);
    entry.draggable = session.running !== true;
    entry.addEventListener('dragstart', (event) => {
      if (session.running === true) { event.preventDefault(); return; }
      event.dataTransfer?.setData('text/pi-session', session.path);
    });
    entry.addEventListener('dragover', (event) => { if (session.running !== true) event.preventDefault(); });
    entry.addEventListener('drop', (event) => {
      if (session.running === true) return;
      event.preventDefault();
      const fromPath = event.dataTransfer?.getData('text/pi-session');
      if (!fromPath || fromPath === session.path) return;
      const reordered = [...state.sessions];
      const fromIndex = reordered.findIndex((item) => item.path === fromPath);
      const toIndex = reordered.findIndex((item) => item.path === session.path);
      if (fromIndex < 0 || toIndex < 0 || reordered[fromIndex].running === true) return;
      const [moved] = reordered.splice(fromIndex, 1);
      reordered.splice(toIndex, 0, moved);
      state.sessions = reordered;
      renderSessions();
      post('reorderSessions', { paths: reordered.map((item) => item.path) });
    });
    ui.sessions.append(entry);

    const shortcut = document.createElement('button');
    shortcut.type = 'button';
    shortcut.className = `session-shortcut${session.path === state.sessionPath ? ' active' : ''}`;
    shortcut.textContent = (shorten(session.title, 1) || 'P').slice(0, 1).toUpperCase();
    shortcut.title = session.title;
    shortcut.setAttribute('aria-label', `Open session: ${session.title}`);
    shortcut.addEventListener('click', () => {
      state.switchingSession = true;
      setBusy(true, 'Opening session');
      post('openSession', { path: session.path });
    });
    if (session.isCurrentWorkspace !== false) ui.railSessions.append(shortcut);
  }
}

function contextLabels(context) {
  return String(context || '').split('\n').map((line) => line.trim()).filter((line) => line.startsWith('@'));
}

const MATHML_NAMESPACE = 'http://www.w3.org/1998/Math/MathML';
const MATHML_ELEMENTS = new Set([
  'math', 'semantics', 'mrow', 'mi', 'mn', 'mo', 'mtext', 'ms', 'mspace', 'menclose', 'mfrac', 'msqrt', 'mroot',
  'mstyle', 'msub', 'msup', 'msubsup', 'munder', 'mover', 'munderover', 'mmultiscripts', 'mprescripts', 'none',
  'mtable', 'mtr', 'mtd', 'malignmark', 'maligngroup', 'annotation',
]);
const MATHML_ATTRIBUTES = new Set([
  'xmlns', 'display', 'mathvariant', 'stretchy', 'fence', 'separator', 'form', 'accent', 'accentunder', 'largeop',
  'movablelimits', 'linethickness', 'notation', 'encoding', 'scriptlevel', 'width', 'height', 'depth', 'lspace',
  'rspace', 'voffset', 'columnalign', 'rowalign', 'columnspacing', 'rowspacing', 'rowlines', 'columnlines',
  'columnwidth', 'groupalign', 'align', 'bevelled', 'dir',
]);

function cloneSafeMathNode(source, budget, depth = 0) {
  budget.nodes += 1;
  if (budget.nodes > 5000 || depth > 64) throw new Error('Math output exceeds the rendering limit.');
  if (source.nodeType === 3) {
    const text = source.textContent || '';
    budget.text += text.length;
    if (budget.text > 80_000) throw new Error('Math output exceeds the rendering limit.');
    return document.createTextNode(text);
  }
  if (source.nodeType !== 1) return undefined;
  if (source.namespaceURI !== MATHML_NAMESPACE || !MATHML_ELEMENTS.has(source.localName)) {
    const text = source.textContent || '';
    budget.text += text.length;
    if (budget.text > 80_000) throw new Error('Math output exceeds the rendering limit.');
    return document.createTextNode(text);
  }
  const target = document.createElementNS(MATHML_NAMESPACE, source.localName);
  for (const attribute of Array.from(source.attributes)) {
    const name = attribute.name.toLowerCase();
    const value = attribute.value;
    if (!MATHML_ATTRIBUTES.has(name) || value.length > 64 || /[<>"';]/.test(value)) continue;
    if (name === 'xmlns' && value !== MATHML_NAMESPACE) continue;
    if (name === 'encoding' && value !== 'application/x-tex') continue;
    if (name === 'display' && !/^(?:inline|block)$/.test(value)) continue;
    target.setAttribute(name, value);
  }
  for (const child of Array.from(source.childNodes)) {
    const safeChild = cloneSafeMathNode(child, budget, depth + 1);
    if (safeChild) target.append(safeChild);
  }
  return target;
}

function createMathNode(source, displayMode) {
  const wrapper = document.createElement(displayMode ? 'div' : 'span');
  wrapper.className = displayMode ? 'math-block' : 'math-inline';
  try {
    if (typeof window.piChatRenderers?.renderMath !== 'function') throw new Error('Math renderer is unavailable.');
    const markup = window.piChatRenderers.renderMath(source, displayMode);
    if (typeof markup !== 'string' || markup.length > 100_000) throw new Error('Math output exceeds the rendering limit.');
    const parsed = new DOMParser().parseFromString(markup, 'text/html');
    const math = parsed.querySelector('math');
    if (!math || math.namespaceURI !== MATHML_NAMESPACE) throw new Error('Math output is invalid.');
    wrapper.append(cloneSafeMathNode(math, { nodes: 0, text: 0 }));
  } catch {
    wrapper.classList.add('math-render-error');
    const fallback = document.createElement('code');
    fallback.textContent = String(source).slice(0, 8_000);
    wrapper.title = 'Could not render this mathematical notation.';
    wrapper.append(fallback);
  }
  return wrapper;
}

function isSafeRenderedSvg(svg) {
  return typeof svg === 'string' && svg.length > 0 && svg.length <= 300_000
    && /^<svg(?:\s|>)/i.test(svg.trim())
    && !/<\s*(?:script|foreignObject)\b|\son[a-z0-9_-]+\s*=|javascript\s*:|(?:href|xlink:href)\s*=\s*["'](?:https?:|\/\/)/i.test(svg);
}

function createDiagramBlock(source) {
  const block = document.createElement('section');
  block.className = 'diagram-card';
  const toolbar = document.createElement('div');
  toolbar.className = 'diagram-toolbar';
  const label = document.createElement('span');
  label.className = 'diagram-label';
  label.textContent = 'Mermaid diagram';
  const controls = document.createElement('div');
  controls.className = 'diagram-controls';
  const sourceToggle = document.createElement('button');
  sourceToggle.type = 'button';
  sourceToggle.className = 'text-button';
  sourceToggle.textContent = 'Show source';
  sourceToggle.setAttribute('aria-expanded', 'false');
  const openDiagram = document.createElement('button');
  openDiagram.type = 'button';
  openDiagram.className = 'text-button';
  openDiagram.textContent = 'Open diagram';
  openDiagram.disabled = true;
  controls.append(sourceToggle, openDiagram);
  toolbar.append(label, controls);

  const view = document.createElement('div');
  view.className = 'diagram-view';
  view.setAttribute('aria-live', 'polite');
  const image = document.createElement('img');
  image.alt = 'Rendered Mermaid diagram';
  const error = document.createElement('p');
  error.className = 'diagram-error';
  error.hidden = true;
  error.textContent = 'The diagram could not be rendered. Check its syntax or view the source.';
  view.append(image, error);

  const sourceView = document.createElement('pre');
  sourceView.className = 'diagram-source';
  sourceView.hidden = true;
  const code = document.createElement('code');
  code.textContent = String(source).slice(0, 20_000);
  sourceView.append(code);
  block.append(toolbar, view, sourceView);

  let renderedSvg = '';
  let showingSource = false;
  sourceToggle.addEventListener('click', () => {
    showingSource = !showingSource;
    sourceView.hidden = !showingSource;
    view.hidden = showingSource;
    sourceToggle.textContent = showingSource ? 'Show diagram' : 'Show source';
    sourceToggle.setAttribute('aria-expanded', String(showingSource));
  });
  openDiagram.addEventListener('click', () => {
    if (renderedSvg) post('openDiagram', { svg: renderedSvg });
  });

  const render = window.piChatRenderers?.renderDiagram;
  if (typeof render !== 'function' || typeof source !== 'string' || source.length > 20_000) {
    error.hidden = false;
    return block;
  }
  Promise.resolve()
    .then(() => render(source))
    .then((svg) => {
      if (!isSafeRenderedSvg(svg)) throw new Error('Diagram output failed validation.');
      renderedSvg = svg;
      image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
      openDiagram.disabled = false;
    })
    .catch(() => {
      error.hidden = false;
      openDiagram.disabled = true;
    });
  image.addEventListener('error', () => {
    error.hidden = false;
    openDiagram.disabled = true;
  });
  return block;
}

function appendInlineText(parent, text, enableAssistantEnhancements = false) {
  const source = String(text);
  const tokens = /(`[^`\n]+`|\$\$[^$\n]{1,2000}\$\$|\$(?!\$)[^$\n]{1,2000}\$|\\\([^\\\n]{1,2000}\\\)|\*\*[^*\n]+\*\*|~~[^~\n]+~~|\*[^*\n]+\*|\[([^\]\n]{1,500})\]\(([^)\s]{1,2048})\))/g;
  let cursor = 0;
  for (const match of source.matchAll(tokens)) {
    const token = match[0];
    const start = match.index ?? cursor;
    if (start > cursor) parent.append(document.createTextNode(source.slice(cursor, start)));
    if (token.startsWith('`') && token.endsWith('`')) {
      const source = token.slice(1, -1);
      const symbol = enableAssistantEnhancements ? source.replace(/\(\)$/, '') : '';
      if (symbol && source.length <= 132 && /^[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*){0,3}(?:\(\))?$/.test(source)) {
        const link = document.createElement('button');
        link.type = 'button';
        link.className = 'symbol-link';
        link.textContent = source;
        link.setAttribute('aria-label', `Open definition of ${symbol}`);
        link.addEventListener('click', () => post('openSymbol', { name: symbol }));
        parent.append(link);
      } else {
        const code = document.createElement('code');
        code.textContent = source;
        parent.append(code);
      }
    } else if ((token.startsWith('$') && token.endsWith('$')) || (token.startsWith('\\(') && token.endsWith('\\)'))) {
      if (!enableAssistantEnhancements) {
        parent.append(document.createTextNode(token));
      } else {
        const displayMode = token.startsWith('$$');
        const delimiterSize = displayMode ? 2 : token.startsWith('$') ? 1 : 2;
        parent.append(createMathNode(token.slice(delimiterSize, -delimiterSize), displayMode));
      }
    } else if (token.startsWith('**') && token.endsWith('**')) {
      const strong = document.createElement('strong');
      strong.textContent = token.slice(2, -2);
      parent.append(strong);
    } else if (token.startsWith('~~') && token.endsWith('~~')) {
      const deleted = document.createElement('del');
      deleted.textContent = token.slice(2, -2);
      parent.append(deleted);
    } else if (token.startsWith('*') && token.endsWith('*')) {
      const emphasis = document.createElement('em');
      emphasis.textContent = token.slice(1, -1);
      parent.append(emphasis);
    } else if (match[2]) {
      const url = safeMarkdownLink(match[3]);
      if (!url) {
        parent.append(document.createTextNode(token));
      } else {
        const link = document.createElement('a');
        link.href = url;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.textContent = match[2];
        link.addEventListener('click', (event) => {
          event.preventDefault();
          post('openExternalLink', { url });
        });
        parent.append(link);
      }
    } else {
      parent.append(document.createTextNode(token));
    }
    cursor = start + token.length;
  }
  if (cursor < source.length) parent.append(document.createTextNode(source.slice(cursor)));
}

function safeMarkdownLink(value) {
  if (typeof value !== 'string' || value.length > 2048) return undefined;
  try {
    const url = new URL(value);
    if (url.username || url.password) return undefined;
    if (url.protocol === 'https:') return url.href;
    if (url.protocol === 'http:' && /^(localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?$/i.test(url.host)) return url.href;
  } catch {
    return undefined;
  }
  return undefined;
}

function splitMarkdownTableRow(line) {
  const source = String(line || '').trim();
  const leadingPipe = source.startsWith('|');
  const trailingPipe = source.endsWith('|');
  const cells = [];
  let cell = '';
  let escaped = false;
  for (const character of source) {
    if (character === '|' && !escaped) {
      cells.push(cell);
      cell = '';
    } else {
      cell += character;
    }
    if (character === '\\' && !escaped) escaped = true;
    else escaped = false;
  }
  cells.push(cell);
  if (leadingPipe) cells.shift();
  if (trailingPipe) cells.pop();
  return cells.map((value) => value.replace(/\\\|/g, '|').trim());
}

function isMarkdownTableDelimiter(line, columnCount) {
  if (!String(line || '').includes('|')) return false;
  const cells = splitMarkdownTableRow(line);
  return cells.length === columnCount && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
}

function createMarkdownTable(headers, rows, enableAssistantEnhancements = false) {
  const table = document.createElement('table');
  table.className = 'markdown-table';
  const head = document.createElement('thead');
  const headerRow = document.createElement('tr');
  for (const value of headers) {
    const cell = document.createElement('th');
    appendInlineText(cell, value, enableAssistantEnhancements);
    headerRow.append(cell);
  }
  head.append(headerRow);
  const body = document.createElement('tbody');
  for (const values of rows) {
    const row = document.createElement('tr');
    headers.forEach((_, index) => {
      const cell = document.createElement('td');
      appendInlineText(cell, values[index] || '', enableAssistantEnhancements);
      row.append(cell);
    });
    body.append(row);
  }
  table.append(head, body);
  return table;
}

function createCodeBlock(source, language = '') {
  const block = document.createElement('div');
  block.className = 'code-block';
  const toolbar = document.createElement('div');
  toolbar.className = 'code-toolbar';
  const languageLabel = document.createElement('span');
  languageLabel.className = 'code-language';
  languageLabel.textContent = language || 'Code';
  const copy = document.createElement('button');
  copy.type = 'button';
  copy.className = 'text-button code-copy';
  copy.textContent = source.length <= 100_000 ? 'Copy' : 'Too large to copy';
  copy.title = source.length <= 100_000 ? 'Copy code to clipboard' : 'Code block exceeds the 100,000 character clipboard limit';
  copy.disabled = source.length > 100_000;
  copy.addEventListener('click', () => post('copyText', { text: source }));
  toolbar.append(languageLabel, copy);
  const pre = document.createElement('pre');
  const code = document.createElement('code');
  code.textContent = source;
  pre.append(code);
  block.append(toolbar, pre);
  return block;
}

function renderMarkdown(container, text, enableAssistantEnhancements = false) {
  container.replaceChildren();
  const lines = String(text || '').split('\n');
  let paragraph = [];
  let list = undefined;
  let quoteLines = [];
  let codeLines = undefined;
  let language = '';

  const flushParagraph = () => {
    if (!paragraph.length) return;
    const p = document.createElement('p');
    appendInlineText(p, paragraph.join('\n'), enableAssistantEnhancements);
    container.append(p);
    paragraph = [];
  };
  const flushList = () => {
    if (list) container.append(list);
    list = undefined;
  };
  const flushQuote = () => {
    if (!quoteLines.length) return;
    const quote = document.createElement('blockquote');
    const p = document.createElement('p');
    appendInlineText(p, quoteLines.join('\n'), enableAssistantEnhancements);
    quote.append(p);
    container.append(quote);
    quoteLines = [];
  };

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex];
    const fence = line.match(/^\s*```\s*([\w.+-]*)/);
    if (fence) {
      flushParagraph();
      flushList();
      flushQuote();
      if (!codeLines) {
        codeLines = [];
        language = fence[1];
      } else {
        const code = codeLines.join('\n');
        if (enableAssistantEnhancements && language.toLowerCase() === 'mermaid') container.append(createDiagramBlock(code));
        else container.append(createCodeBlock(code, language));
        codeLines = undefined;
        language = '';
      }
      continue;
    }
    if (codeLines) {
      codeLines.push(line);
      continue;
    }

    const mathFence = enableAssistantEnhancements
      ? (line.trim() === '$$' ? '$$' : line.trim() === '\\[' ? '\\]' : '')
      : '';
    if (mathFence) {
      flushParagraph();
      flushList();
      flushQuote();
      const mathLines = [];
      let closingIndex = lineIndex + 1;
      let length = 0;
      while (closingIndex < lines.length && mathLines.length < 250) {
        if (lines[closingIndex].trim() === mathFence) break;
        length += lines[closingIndex].length;
        if (length > 8_000) break;
        mathLines.push(lines[closingIndex]);
        closingIndex += 1;
      }
      if (closingIndex < lines.length && lines[closingIndex].trim() === mathFence) {
        container.append(createMathNode(mathLines.join('\n'), true));
        lineIndex = closingIndex;
      } else {
        paragraph.push(line);
      }
      continue;
    }

    if (!line.trim()) {
      flushParagraph();
      flushList();
      flushQuote();
      continue;
    }

    const tableHeaders = line.includes('|') ? splitMarkdownTableRow(line).slice(0, 12) : [];
    if (tableHeaders.length && isMarkdownTableDelimiter(lines[lineIndex + 1], tableHeaders.length)) {
      flushParagraph();
      flushList();
      flushQuote();
      const rows = [];
      let rowIndex = lineIndex + 2;
      while (rowIndex < lines.length && lines[rowIndex].trim() && lines[rowIndex].includes('|') && rows.length < 50) {
        rows.push(splitMarkdownTableRow(lines[rowIndex]).slice(0, tableHeaders.length));
        rowIndex += 1;
      }
      container.append(createMarkdownTable(tableHeaders, rows, enableAssistantEnhancements));
      lineIndex = rowIndex - 1;
      continue;
    }

    const heading = line.match(/^(#{1,3})\s+(.+)$/);
    if (heading) {
      flushParagraph();
      flushList();
      flushQuote();
      const h = document.createElement(heading[1].length === 1 ? 'h2' : 'h3');
      appendInlineText(h, heading[2], enableAssistantEnhancements);
      container.append(h);
      continue;
    }

    if (/^\s*(?:---+|\*\*\*+|___+)\s*$/.test(line)) {
      flushParagraph();
      flushList();
      flushQuote();
      const rule = document.createElement('hr');
      rule.className = 'markdown-rule';
      container.append(rule);
      continue;
    }

    const quoted = line.match(/^\s{0,3}>\s?(.*)$/);
    if (quoted) {
      flushParagraph();
      flushList();
      quoteLines.push(quoted[1]);
      continue;
    }
    flushQuote();

    const task = line.match(/^\s*[-*]\s+\[([ xX])\]\s+(.+)$/);
    if (task) {
      flushParagraph();
      if (!list || list.tagName.toLowerCase() !== 'ul') {
        flushList();
        list = document.createElement('ul');
        list.className = 'task-list';
      }
      const item = document.createElement('li');
      item.className = 'task-list-item';
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.disabled = true;
      checkbox.checked = task[1].toLowerCase() === 'x';
      checkbox.setAttribute('aria-label', checkbox.checked ? 'Completed task' : 'Incomplete task');
      const content = document.createElement('span');
      appendInlineText(content, task[2], enableAssistantEnhancements);
      item.append(checkbox, content);
      list.append(item);
      continue;
    }

    const unordered = line.match(/^\s*[-*]\s+(.+)$/);
    const ordered = line.match(/^\s*\d+[.)]\s+(.+)$/);
    if (unordered || ordered) {
      flushParagraph();
      const tag = ordered ? 'ol' : 'ul';
      if (!list || list.tagName.toLowerCase() !== tag) {
        flushList();
        list = document.createElement(tag);
      }
      const item = document.createElement('li');
      appendInlineText(item, (unordered || ordered)[1], enableAssistantEnhancements);
      list.append(item);
      continue;
    }
    flushList();
    paragraph.push(line);
  }

  if (codeLines) {
    const code = codeLines.join('\n');
    if (enableAssistantEnhancements && language.toLowerCase() === 'mermaid') container.append(createDiagramBlock(code));
    else container.append(createCodeBlock(code, language));
  }
  flushParagraph();
  flushList();
  flushQuote();
}

function openMessageContextEditor(row, message) {
  if (state.busy || row.querySelector('.context-edit-form')) return;
  const form = document.createElement('div');
  form.className = 'context-edit-form';
  const input = document.createElement('textarea');
  input.className = 'context-edit-input';
  input.maxLength = 100000;
  input.rows = 6;
  input.setAttribute('aria-label', 'Text to include in Pi model context');
  input.value = message.contextStatus === 'edited' ? String(message.contextEditText || '') : String(message.text || '');
  const controls = document.createElement('div');
  controls.className = 'context-edit-controls';
  const save = document.createElement('button');
  save.type = 'button';
  save.className = 'branch-button context-action';
  save.textContent = 'Save context edit';
  save.addEventListener('click', () => {
    post('editMessageContext', { entryId: message.entryId, text: input.value });
    form.remove();
  });
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'branch-button';
  cancel.textContent = 'Cancel';
  cancel.addEventListener('click', () => form.remove());
  controls.append(save, cancel);
  form.append(input, controls);
  const actions = row.querySelector('.message-actions');
  if (actions) row.insertBefore(form, actions);
  else row.append(form);
  input.focus();
}

const TRANSCRIPT_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const MAX_TRANSCRIPT_IMAGE_DATA_LENGTH = 7_000_000;
const MAX_TRANSCRIPT_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_TRANSCRIPT_IMAGE_COUNT = 3;
const MAX_TRANSCRIPT_IMAGES_BYTES_PER_MESSAGE = 12 * 1024 * 1024;

function isValidTranscriptImageData(data) {
  if (typeof data !== 'string' || !data || data.length > MAX_TRANSCRIPT_IMAGE_DATA_LENGTH || data.length % 4 !== 0) return false;
  const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0;
  const contentLength = data.length - padding;
  if (data.indexOf('=') !== (padding ? contentLength : -1)) return false;
  for (let offset = 0; offset < contentLength; offset += 4096) {
    if (!/^[A-Za-z0-9+/]+$/.test(data.slice(offset, Math.min(offset + 4096, contentLength)))) return false;
  }
  return true;
}

function appendTranscriptImages(body, message) {
  const candidates = Array.isArray(message.images) ? message.images : [];
  const displayed = [];
  let totalBytes = 0;
  for (const candidate of candidates.slice(0, MAX_TRANSCRIPT_IMAGE_COUNT)) {
    const imageData = candidate && typeof candidate === 'object' ? candidate : {};
    const { data, mimeType } = imageData;
    if (typeof mimeType !== 'string' || !TRANSCRIPT_IMAGE_TYPES.has(mimeType) || !isValidTranscriptImageData(data)) continue;
    const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0;
    const decodedBytes = Math.floor(data.length * 3 / 4) - padding;
    if (decodedBytes <= 0 || decodedBytes > MAX_TRANSCRIPT_IMAGE_BYTES
      || totalBytes + decodedBytes > MAX_TRANSCRIPT_IMAGES_BYTES_PER_MESSAGE) continue;
    displayed.push({ data, mimeType });
    totalBytes += decodedBytes;
  }

  const reportedCount = Number.isFinite(Number(message.imageCount)) ? Math.max(0, Math.trunc(Number(message.imageCount))) : 0;
  const reportedOmitted = Number.isFinite(Number(message.imageDisplayOmitted)) ? Math.max(0, Math.trunc(Number(message.imageDisplayOmitted))) : 0;
  const totalImageCount = Math.min(1000, Math.max(reportedCount, candidates.length + reportedOmitted, message.hasImages ? 1 : 0));
  const hasImages = totalImageCount > 0;
  if (!hasImages) return false;

  if (displayed.length) {
    const grid = document.createElement('div');
    grid.className = 'message-image-grid';
    grid.setAttribute('aria-label', `${displayed.length} ${displayed.length === 1 ? 'image' : 'images'}`);
    for (let index = 0; index < displayed.length; index += 1) {
      const source = displayed[index];
      const image = document.createElement('img');
      image.className = 'message-transcript-image';
      image.alt = message.role === 'user' ? `Attached image ${index + 1}` : `Image output ${index + 1}`;
      image.loading = 'lazy';
      image.decoding = 'async';
      image.src = `data:${source.mimeType};base64,${source.data}`;
      image.addEventListener('error', () => {
        const fallback = document.createElement('span');
        fallback.className = 'message-image-unavailable';
        fallback.textContent = 'Image could not be displayed';
        image.replaceWith(fallback);
      }, { once: true });
      grid.append(image);
    }
    body.append(grid);
  }

  const omitted = Math.max(0, totalImageCount - displayed.length);
  if (omitted) {
    const imageSummary = document.createElement('div');
    imageSummary.className = 'message-image-summary';
    imageSummary.textContent = `${omitted} ${omitted === 1 ? 'image' : 'images'} not shown (unsupported format or display limit).`;
    body.append(imageSummary);
  }
  return true;
}

function renderToolImages(card, message) {
  card.querySelector('.tool-image-output')?.remove();
  if (!message || !(message.hasImages || Number(message.imageCount) > 0 || Array.isArray(message.images) && message.images.length)) return;
  const output = document.createElement('div');
  output.className = 'tool-image-output';
  appendTranscriptImages(output, { ...message, role: 'tool' });
  if (output.childNodes.length) card.append(output);
}

function renderMessages(shouldFollow = true) {
  const nearBottom = ui.messageArea.scrollHeight - ui.messageArea.scrollTop - ui.messageArea.clientHeight < 80;
  ui.messageList.replaceChildren();
  const latestAssistantIndex = state.busy ? -1 : state.messages.findLastIndex((message) =>
    message.role === 'assistant' && message.streaming !== true && typeof message.entryId === 'string');
  for (let messageIndex = 0; messageIndex < state.messages.length; messageIndex += 1) {
    const message = state.messages[messageIndex];
    if (!isTranscriptMessageVisible(message)) continue;
    if (message.role === 'tool') {
      const groupMessages = [];
      let groupEnd = messageIndex;
      while (groupEnd < state.messages.length
        && isTranscriptMessageVisible(state.messages[groupEnd])
        && isExplorationToolMessage(state.messages[groupEnd])) {
        groupMessages.push({ message: state.messages[groupEnd], index: groupEnd });
        groupEnd += 1;
      }
      if (groupMessages.length > 1) {
        const hasError = groupMessages.some(({ message: item }) => item.isError === true);
        const group = document.createElement('details');
        group.className = 'tool-exploration-group';
        group.open = toolExpansionPreference('exploration', hasError);
        const summary = document.createElement('summary');
        summary.textContent = `Explored ${groupMessages.length} items`;
        const toolNames = [...new Set(groupMessages.map(({ message: item }) => String(item.toolName || 'tool')))];
        summary.title = `Show ${groupMessages.length} file exploration calls: ${toolNames.join(', ')}`;
        group.append(summary);
        for (const item of groupMessages) {
          const node = item.message.node instanceof HTMLElement ? item.message.node : createHistoricalToolCard(item.message);
          item.message.node = node;
          node.dataset.messageIndex = String(item.index);
          group.append(node);
        }
        ui.messageList.append(group);
        messageIndex = groupEnd - 1;
      } else {
        const node = message.node instanceof HTMLElement ? message.node : createHistoricalToolCard(message);
        message.node = node;
        node.dataset.messageIndex = String(messageIndex);
        ui.messageList.append(node);
      }
      continue;
    }
    if (message.role !== 'user' && message.role !== 'assistant') continue;
    const row = document.createElement('article');
    row.className = `message-row ${message.role}`;
    row.dataset.messageIndex = String(messageIndex);
    if (typeof message.entryId === 'string') row.dataset.entryId = message.entryId;
    const role = document.createElement('div');
    role.className = 'message-role';
    role.textContent = message.role === 'user' ? 'YOU' : 'PI';
    row.append(role);
    if (message.contextStatus === 'omitted' || message.contextStatus === 'edited') {
      const status = document.createElement('span');
      status.className = `message-context-state ${message.contextStatus}`;
      status.textContent = message.contextStatus === 'omitted' ? 'Omitted from Pi context' : 'Edited for Pi context';
      row.append(status);
    }

    const labels = contextLabels(message.context);
    if (String(message.context || '').includes('<quote-context>')) labels.push('Quoted passage');
    if (labels.length) {
      const context = document.createElement('div');
      context.className = 'message-context';
      for (const label of labels) {
        const item = document.createElement('span');
        item.textContent = label;
        item.title = label;
        context.append(item);
      }
      row.append(context);
    }

    if (message.role === 'assistant' && typeof message.thinking === 'string' && message.thinking) {
      const thinking = document.createElement('details');
      thinking.className = 'thinking-block';
      const thinkingKey = `${state.sessionPath}:${messageIndex}`;
      thinking.open = state.thinkingExpansion.get(thinkingKey) === true;
      thinking.addEventListener('toggle', () => {
        state.thinkingExpansion.set(thinkingKey, thinking.open);
        if (state.thinkingExpansion.size > 200) state.thinkingExpansion.delete(state.thinkingExpansion.keys().next().value);
      });
      const summary = document.createElement('summary');
      summary.textContent = 'Thinking';
      const content = document.createElement('div');
      content.className = 'message-content thinking-content';
      if (message.streaming) content.textContent = message.thinking;
      else renderMarkdown(content, message.thinking);
      if (message.thinkingTruncated) {
        const note = document.createElement('p');
        note.className = 'thinking-truncated';
        note.textContent = 'Additional thinking omitted after reaching the display limit.';
        content.append(note);
      }
      thinking.append(summary, content);
      row.append(thinking);
    }

    const body = document.createElement('div');
    body.className = 'message-content';
    if (message.role === 'assistant' && !message.streaming) renderMarkdown(body, message.text, true);
    else body.textContent = message.text;
    const hasImages = appendTranscriptImages(body, message);
    if (message.text || hasImages) row.append(body);
    if (message.contextStatus === 'edited') row.append(createContextDiff(message.text, message.contextEditText));
    appendContextEditHistory(row, message);
    const quoteIds = quoteSourceIds(message.context);
    if (quoteIds.length) {
      const references = document.createElement('div');
      references.className = 'quote-references';
      quoteIds.forEach((entryId, index) => {
        const reference = document.createElement('button');
        reference.type = 'button';
        reference.className = 'quote-reference';
        reference.textContent = quoteIds.length === 1 ? 'Jump to quoted message' : `Jump to quote ${index + 1}`;
        reference.addEventListener('click', () => jumpToQuotedMessage(entryId));
        references.append(reference);
      });
      row.append(references);
    }
    const actions = document.createElement('div');
    actions.className = 'message-actions';
    if (message.role === 'user' && message.entryId) {
      const branch = document.createElement('button');
      branch.type = 'button';
      branch.className = 'branch-button';
      branch.textContent = 'Branch from here';
      branch.title = 'Create a new Pi session from this message';
      branch.addEventListener('click', () => post('forkSession', { entryId: message.entryId }));
      actions.append(branch);

      if (String(message.text || '').trim() || message.context || message.hasImages) {
        const edit = document.createElement('button');
        edit.type = 'button';
        edit.className = 'branch-button';
        edit.textContent = 'Edit & branch';
        edit.title = 'Put this prompt, its text context, and image attachments back in the composer and continue from a new branch';
        edit.addEventListener('click', () => post('editUserMessage', { entryId: message.entryId }));
        actions.append(edit);
      }
    }
    if (message.entryId) {
      const contextMenu = document.createElement('details');
      contextMenu.className = 'message-context-menu';
      const summary = document.createElement('summary');
      summary.className = 'branch-button';
      summary.textContent = 'Context';
      summary.title = 'Change what Pi receives from this message';
      const contextControls = document.createElement('div');
      contextControls.className = 'message-context-controls';
      const contextAction = document.createElement('button');
      contextAction.type = 'button';
      contextAction.className = 'branch-button context-action';
      contextAction.textContent = message.contextStatus === 'omitted' ? 'Restore context' : 'Omit from context';
      contextAction.title = message.contextStatus === 'omitted'
        ? 'Include this original message in future Pi requests'
        : 'Keep this transcript message but exclude it from future Pi requests';
      contextAction.disabled = state.busy;
      contextAction.addEventListener('click', () => post('setMessageContext', {
        entryId: message.entryId,
        action: message.contextStatus === 'omitted' ? 'restore' : 'omit',
      }));
      contextControls.append(contextAction);

      if (!message.hasImages) {
        const editContext = document.createElement('button');
        editContext.type = 'button';
        editContext.className = 'branch-button context-action';
        editContext.textContent = 'Edit for context';
        editContext.title = 'Change the text Pi receives while preserving the transcript';
        editContext.disabled = state.busy;
        editContext.addEventListener('click', () => openMessageContextEditor(row, message));
        contextControls.append(editContext);
      }
      if (message.contextStatus === 'edited') {
        const resetContext = document.createElement('button');
        resetContext.type = 'button';
        resetContext.className = 'branch-button context-action';
        resetContext.textContent = 'Reset context edit';
        resetContext.title = 'Use this message’s original content in future Pi requests';
        resetContext.disabled = state.busy;
        resetContext.addEventListener('click', () => post('setMessageContext', { entryId: message.entryId, action: 'restore' }));
        contextControls.append(resetContext);
      }
      contextMenu.append(summary, contextControls);
      actions.append(contextMenu);
    }
    const quote = document.createElement('button');
    quote.type = 'button';
    quote.className = 'branch-button quote-button';
    quote.textContent = 'Quote';
    quote.title = 'Quote selected text, or this whole message';
    quote.addEventListener('click', () => {
      const selection = window.getSelection();
      const selected = selection?.toString().trim();
      const chosen = selected && body.contains(selection.anchorNode) ? selected : message.text;
      const sourceId = String(message.entryId || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      const source = sourceId ? ` source="${sourceId}"` : '';
      state.attachments.push({
        id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
        label: `Quote · ${message.role === 'user' ? 'you' : 'Pi'}`,
        path: 'transcript quote',
        context: `<quote-context>\n<quote${source}>\n${String(chosen || '').slice(0, 4000)}\n</quote>\n</quote-context>`,
      });
      renderAttachments();
      ui.prompt.focus();
    });
    actions.append(quote);
    if (message.entryId) {
      const bookmarked = state.bookmarks.includes(message.entryId);
      const bookmark = document.createElement('button');
      bookmark.type = 'button';
      bookmark.className = `branch-button bookmark-message${bookmarked ? ' bookmarked' : ''}`;
      bookmark.textContent = bookmarked ? '★ Bookmarked' : '☆ Bookmark';
      bookmark.title = bookmarked ? 'Remove bookmark' : 'Bookmark this message';
      bookmark.setAttribute('aria-pressed', String(bookmarked));
      bookmark.addEventListener('click', () => {
        state.bookmarks = bookmarked
          ? state.bookmarks.filter((entryId) => entryId !== message.entryId)
          : [...state.bookmarks, message.entryId].slice(-500);
        renderMessages(false);
        renderBookmarks();
        post('setBookmarks', { entryIds: state.bookmarks });
      });
      actions.append(bookmark);
    }
    if (message.role === 'assistant' && messageIndex === latestAssistantIndex) {
      const suggestionState = state.promptSuggestions?.entryId === message.entryId ? state.promptSuggestions : undefined;
      const suggest = document.createElement('button');
      suggest.type = 'button';
      suggest.className = 'branch-button prompt-suggestion-trigger';
      suggest.textContent = suggestionState?.loading
        ? suggestionState.requestId ? 'Cancel suggestions' : 'Starting…'
        : 'Suggest follow-ups';
      suggest.title = 'Ask the current Pi model for follow-up prompts. This sends a separate provider request and may incur usage.';
      suggest.disabled = Boolean(suggestionState?.loading && !suggestionState.requestId);
      suggest.addEventListener('click', () => {
        if (suggestionState?.loading) {
          if (suggestionState.requestId) post('cancelPromptSuggestions', { requestId: suggestionState.requestId });
          return;
        }
        const requestId = createRequestId();
        state.promptSuggestions = { entryId: message.entryId, loading: true, requestId, suggestions: [] };
        renderMessages(false);
        post('suggestFollowUps', { entryId: message.entryId, requestId });
      });
      actions.append(suggest);
    }
    row.append(actions);
    const promptSuggestions = state.promptSuggestions?.entryId === message.entryId ? state.promptSuggestions : undefined;
    if (message.role === 'assistant' && promptSuggestions && (promptSuggestions.loading || promptSuggestions.suggestions?.length)) {
      const suggestions = document.createElement('div');
      suggestions.className = 'prompt-suggestions';
      suggestions.setAttribute('aria-label', 'Model-generated follow-up prompts');
      if (promptSuggestions.loading) {
        const loading = document.createElement('span');
        loading.className = 'prompt-suggestions-status';
        loading.textContent = 'Generating with the current model…';
        suggestions.append(loading);
      } else {
        for (const value of promptSuggestions.suggestions.slice(0, 3)) {
          const chip = document.createElement('button');
          chip.type = 'button';
          chip.className = 'prompt-suggestion-chip';
          chip.textContent = value;
          chip.title = 'Add this prompt to the composer; it will not be sent automatically';
          chip.addEventListener('click', () => {
            ui.prompt.value = value;
            ui.prompt.style.height = 'auto';
            ui.prompt.style.height = `${Math.min(ui.prompt.scrollHeight, 170)}px`;
            rememberDraft();
            ui.prompt.focus();
          });
          suggestions.append(chip);
        }
      }
      row.append(suggestions);
    }
    ui.messageList.append(row);
  }

  renderBookmarks();
  updateChatSearch();
  ui.empty.hidden = state.messages.some(isTranscriptMessageVisible);
  if (shouldFollow && nearBottom) ui.messageArea.scrollTop = ui.messageArea.scrollHeight;
  updateControls();
}

const SAFE_TUI_STYLES = new Set([
  'bold', 'dim', 'italic', 'underline', 'inverse', 'strike',
  ...Array.from({ length: 8 }, (_, index) => `fg-${index}`),
  ...Array.from({ length: 8 }, (_, index) => `fg-bright-${index}`),
  ...Array.from({ length: 8 }, (_, index) => `bg-${index}`),
  ...Array.from({ length: 8 }, (_, index) => `bg-bright-${index}`),
]);

function appendTuiSegments(parent, line) {
  if (!Array.isArray(line)) return;
  for (const segment of line.slice(0, 256)) {
    if (!segment || typeof segment.text !== 'string') continue;
    const text = segment.text.replace(/[\u0000-\u001f\u007f-\u009f]/g, (character) => character === '\t' ? '  ' : '').slice(0, 2000);
    if (!text) continue;
    const span = document.createElement('span');
    const styles = Array.isArray(segment.styles)
      ? segment.styles.slice(0, 16).filter((style) => typeof style === 'string' && SAFE_TUI_STYLES.has(style))
      : [];
    if (styles.length) span.className = styles.map((style) => `pi-tui-${style}`).join(' ');
    span.textContent = text;
    parent.append(span);
  }
}

function createTuiOutput(lines, className) {
  if (!Array.isArray(lines) || !lines.length) return undefined;
  const output = document.createElement('pre');
  output.className = `tool-output tool-renderer-output ${className}`;
  for (const line of lines.slice(0, 120)) {
    const row = document.createElement('span');
    row.className = 'tool-renderer-line';
    appendTuiSegments(row, line);
    output.append(row);
  }
  return output;
}

function createTuiPreview(lines) {
  if (!Array.isArray(lines) || !lines.length) return undefined;
  const preview = document.createElement('span');
  preview.className = 'tool-renderer-summary';
  appendTuiSegments(preview, lines[0]);
  return preview;
}

function createRawToolDisclosure(title, text, className) {
  if (!text) return undefined;
  const disclosure = document.createElement('details');
  disclosure.className = `tool-renderer-fallback ${className}`;
  const summary = document.createElement('summary');
  summary.textContent = title;
  const output = document.createElement('pre');
  output.className = 'tool-output';
  output.textContent = text;
  disclosure.append(summary, output);
  return disclosure;
}

function updateToolRendererCard(card, message, statusText) {
  card.querySelectorAll('.tool-renderer-call, .tool-renderer-result, .tool-renderer-fallback, .tool-renderer-preview, .tool-arguments, .tool-result-output')
    .forEach((node) => node.remove());
  const summary = card.querySelector('summary');
  if (!(summary instanceof HTMLElement)) return;
  summary.replaceChildren(document.createTextNode(statusText));

  const callOutput = createTuiOutput(message.rendererCall, 'tool-renderer-call');
  if (callOutput) {
    summary.after(callOutput);
    const rawArgs = typeof message.argsPreview === 'string' ? message.argsPreview.slice(0, 12000) : '';
    const disclosure = createRawToolDisclosure('Arguments', rawArgs && rawArgs !== '{}' ? rawArgs : '', 'tool-renderer-arguments');
    if (disclosure) callOutput.after(disclosure);
  } else {
    const argsPreview = typeof message.argsPreview === 'string' ? message.argsPreview.slice(0, 12000) : '';
    if (argsPreview && argsPreview !== '{}') {
      const args = document.createElement('pre');
      args.className = 'tool-output tool-arguments';
      args.textContent = `Arguments\n${argsPreview}`;
      summary.after(args);
    }
  }

  let resultText = String(message.result || '').slice(-12000);
  if (message.hasImages) resultText = resultText.split('\n').filter((line) => line.trim() !== '[image output]').join('\n').trim();
  const rendererResult = message.rendererResult && typeof message.rendererResult === 'object' ? message.rendererResult : undefined;
  const collapsedOutput = rendererResult ? createTuiPreview(rendererResult.collapsed) : undefined;
  const expandedOutput = rendererResult ? createTuiOutput(rendererResult.expanded, 'tool-renderer-result') : undefined;
  if (collapsedOutput) summary.append(collapsedOutput);
  if (expandedOutput) card.append(expandedOutput);
  if (resultText) {
    const disclosure = rendererResult && expandedOutput
      ? createRawToolDisclosure('Raw result', resultText, 'tool-renderer-raw')
      : undefined;
    if (disclosure) card.append(disclosure);
    else {
      const output = document.createElement('pre');
      output.className = 'tool-output tool-result-output';
      output.textContent = resultText;
      card.append(output);
    }
  }
}

function createHistoricalToolCard(message) {
  const detail = document.createElement('details');
  detail.className = `tool-card historical-tool-card${message.isError ? ' tool-error' : ''}`;
  const toolName = String(message.toolName || 'tool').slice(0, 128);
  detail.open = toolExpansionPreference(toolName, Boolean(message.isError));
  detail.dataset.toolId = String(message.toolCallId || '').slice(0, 256);
  detail.dataset.toolName = toolName;
  const summary = document.createElement('summary');
  detail.append(summary);
  updateToolRendererCard(detail, message, `${message.isError ? 'Failed' : 'Finished'} ${toolName}`);
  renderToolImages(detail, message);
  appendStructuredToolDetails(detail, message.details);
  return detail;
}

function structuredChecklist(details) {
  if (!details || typeof details !== 'object' || Array.isArray(details)) return undefined;
  const keys = ['todos', 'tasks', 'checklist', 'steps', 'items'];
  for (const key of keys) {
    const entries = details[key];
    if (!Array.isArray(entries)) continue;
    const items = entries.slice(0, 100).flatMap((entry) => {
      if (typeof entry === 'string') {
        const text = entry.trim().slice(0, 1000);
        if (!text || text.startsWith('[') && text.endsWith('omitted]')) return [];
        return [{ text, done: /^\s*\[[xX]\]\s*/.test(text), status: '' }];
      }
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return [];
      const rawText = [entry.text, entry.title, entry.label, entry.name, entry.description]
        .find((value) => typeof value === 'string' && value.trim());
      if (typeof rawText !== 'string') return [];
      const status = typeof entry.status === 'string' ? entry.status.trim().slice(0, 64) : '';
      const normalizedStatus = status.toLocaleLowerCase();
      return [{
        text: rawText.trim().slice(0, 1000),
        done: entry.done === true || entry.completed === true || ['done', 'complete', 'completed', 'success'].includes(normalizedStatus),
        status,
      }];
    });
    const title = [details.title, details.name, details.label]
      .find((value) => typeof value === 'string' && value.trim());
    return { title: typeof title === 'string' ? title.trim().slice(0, 120) : 'Checklist', items };
  }
  return undefined;
}

function subagentDetails(details) {
  if (!details || typeof details !== 'object' || Array.isArray(details)) return undefined;
  if (!['single', 'parallel', 'chain'].includes(details.mode) || !Array.isArray(details.results)) return undefined;
  const results = details.results.filter((run) => run && typeof run === 'object' && !Array.isArray(run)).slice(0, 8);
  if (results.length && !results.some((run) => typeof run.agent === 'string' && Array.isArray(run.messages))) return undefined;
  const omittedResults = Number.isFinite(details.omittedResults) ? Math.max(0, Math.floor(details.omittedResults)) : 0;
  return { mode: details.mode, results, omittedResults };
}

function appendSubagentDetails(card, details, partial) {
  const section = document.createElement('section');
  section.className = 'tool-structured-result subagent-results';
  const heading = document.createElement('div');
  heading.className = 'tool-checklist-heading';
  const title = document.createElement('strong');
  title.textContent = `Subagents · ${details.mode}`;
  const count = document.createElement('span');
  const runCount = `${details.results.length} run${details.results.length === 1 ? '' : 's'}`;
  count.textContent = details.omittedResults ? `${runCount} shown · ${details.omittedResults} more omitted` : runCount;
  heading.append(title, count);
  section.append(heading);
  if (!details.results.length) {
    const empty = document.createElement('p');
    empty.className = 'tool-checklist-empty';
    empty.textContent = partial ? 'Waiting for subagent results.' : 'No subagent results were recorded.';
    section.append(empty);
    card.append(section);
    return;
  }

  for (const run of details.results) {
    const failed = (typeof run.exitCode === 'number' && run.exitCode !== 0)
      || ['error', 'aborted'].includes(String(run.stopReason || '').toLocaleLowerCase());
    const runDetails = document.createElement('details');
    runDetails.className = `subagent-run${failed ? ' subagent-run-error' : ''}`;
    runDetails.open = details.results.length === 1;
    const summary = document.createElement('summary');
    const name = typeof run.agent === 'string' ? run.agent.slice(0, 128) : 'Subagent';
    const source = typeof run.agentSource === 'string' ? ` · ${run.agentSource.slice(0, 64)}` : '';
    const status = partial ? 'Running' : failed ? 'Failed' : 'Finished';
    summary.textContent = `${name}${source} · ${status}`;
    runDetails.append(summary);

    if (typeof run.task === 'string' && run.task.trim()) {
      const task = document.createElement('p');
      task.className = 'subagent-task';
      task.textContent = run.task.slice(0, 8000);
      runDetails.append(task);
    }
    if (typeof run.errorMessage === 'string' && run.errorMessage) {
      const error = document.createElement('p');
      error.className = 'subagent-error';
      error.textContent = run.errorMessage.slice(0, 2000);
      runDetails.append(error);
    } else if (failed && typeof run.stderr === 'string' && run.stderr) {
      const error = document.createElement('p');
      error.className = 'subagent-error';
      error.textContent = run.stderr.slice(0, 2000);
      runDetails.append(error);
    }

    const transcript = document.createElement('details');
    transcript.className = 'subagent-transcript';
    const transcriptSummary = document.createElement('summary');
    transcriptSummary.textContent = 'Transcript';
    transcript.append(transcriptSummary);
    let transcriptItems = 0;
    const messages = Array.isArray(run.messages) ? run.messages.slice(-30) : [];
    for (const message of messages) {
      const parts = Array.isArray(message?.content) ? message.content.slice(-40) : [];
      for (const part of parts) {
        if (part?.type === 'text' && typeof part.text === 'string' && part.text) {
          const output = document.createElement('div');
          output.className = 'subagent-transcript-text';
          renderMarkdown(output, part.text.slice(-8000));
          transcript.append(output);
          transcriptItems += 1;
        } else if (part?.type === 'toolCall') {
          const call = document.createElement('div');
          call.className = 'subagent-transcript-call';
          const label = document.createElement('strong');
          label.textContent = `Tool · ${String(part.name || 'tool').slice(0, 128)}`;
          const args = document.createElement('pre');
          args.textContent = JSON.stringify(part.arguments ?? {}, null, 2).slice(0, 4000);
          call.append(label, args);
          transcript.append(call);
          transcriptItems += 1;
        }
      }
    }
    if (!transcriptItems) {
      const empty = document.createElement('p');
      empty.className = 'tool-checklist-empty';
      empty.textContent = 'No transcript entries were recorded.';
      transcript.append(empty);
    }
    runDetails.append(transcript);

    const usage = run.usage && typeof run.usage === 'object' ? run.usage : undefined;
    if (usage) {
      const metrics = [];
      for (const [key, label] of [['turns', 'turns'], ['input', 'input'], ['output', 'output']]) {
        const value = Number(usage[key]);
        if (Number.isFinite(value) && value > 0) metrics.push(`${label} ${Math.round(value).toLocaleString()}`);
      }
      const cost = Number(usage.cost);
      if (Number.isFinite(cost) && cost > 0) metrics.push(`$${cost.toFixed(4)}`);
      if (typeof run.model === 'string' && run.model) metrics.push(run.model.slice(0, 128));
      if (metrics.length) {
        const footer = document.createElement('small');
        footer.className = 'subagent-usage';
        footer.textContent = metrics.join(' · ');
        runDetails.append(footer);
      }
    }
    section.append(runDetails);
  }
  card.append(section);
}

function appendStructuredToolDetails(card, details, partial = false) {
  card.querySelector('.tool-structured-result')?.remove();
  if (details === undefined || details === null) return;
  let serialized;
  try {
    serialized = JSON.stringify(details, null, 2);
  } catch {
    return;
  }
  if (typeof serialized !== 'string' || serialized === '{}' || serialized === '[]' || serialized.length > 24000) return;

  const subagents = subagentDetails(details);
  if (subagents) {
    appendSubagentDetails(card, subagents, partial);
    return;
  }

  const checklist = structuredChecklist(details);
  if (checklist) {
    const section = document.createElement('section');
    section.className = 'tool-structured-result tool-checklist-result';
    const heading = document.createElement('div');
    heading.className = 'tool-checklist-heading';
    const title = document.createElement('strong');
    title.textContent = checklist.title;
    const progress = document.createElement('span');
    const completed = checklist.items.filter((item) => item.done).length;
    progress.textContent = `${completed} of ${checklist.items.length} complete`;
    heading.append(title, progress);
    section.append(heading);
    if (!checklist.items.length) {
      const empty = document.createElement('p');
      empty.className = 'tool-checklist-empty';
      empty.textContent = 'No tasks in this list.';
      section.append(empty);
    } else {
      const list = document.createElement('ul');
      list.className = 'tool-checklist';
      for (const item of checklist.items) {
        const row = document.createElement('li');
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.checked = item.done;
        checkbox.disabled = true;
        checkbox.tabIndex = -1;
        checkbox.setAttribute('aria-label', item.done ? 'Completed' : 'Not completed');
        const label = document.createElement('span');
        label.textContent = item.text;
        if (item.done) label.className = 'tool-checklist-done';
        const taskLabel = document.createElement('label');
        taskLabel.className = 'tool-checklist-label';
        taskLabel.append(checkbox, label);
        row.append(taskLabel);
        if (item.status) {
          const status = document.createElement('small');
          status.textContent = item.status;
          row.append(status);
        }
        list.append(row);
      }
      section.append(list);
    }
    card.append(section);
    return;
  }

  const disclosure = document.createElement('details');
  disclosure.className = 'tool-structured-result tool-structured-disclosure';
  const summary = document.createElement('summary');
  summary.textContent = 'Structured details';
  const content = document.createElement('pre');
  content.className = 'tool-output';
  content.textContent = serialized;
  disclosure.append(summary, content);
  card.append(disclosure);
}

ui.messageList.addEventListener('click', (event) => {
  if (!(event.target instanceof Element)) return;
  const groupSummary = event.target.closest('.tool-exploration-group > summary');
  const group = groupSummary?.parentElement;
  if (group instanceof HTMLDetailsElement) {
    const open = !group.open;
    state.toolExpansion.exploration = open;
    persistWebviewState();
    for (const peer of ui.messageList.querySelectorAll('.tool-exploration-group')) {
      if (peer !== group) peer.open = open;
    }
    return;
  }
  const summary = event.target.closest('.tool-card > summary');
  const card = summary?.parentElement;
  if (!(card instanceof HTMLDetailsElement)) return;
  const toolName = String(card.dataset.toolName || '').slice(0, 128);
  if (!toolName) return;
  const open = !card.open;
  state.toolExpansion[toolName] = open;
  const toolNames = Object.keys(state.toolExpansion);
  if (toolNames.length > 200) delete state.toolExpansion[toolNames[0]];
  persistWebviewState();
  for (const peer of ui.messageList.querySelectorAll('.tool-card')) {
    if (peer !== card && peer.dataset.toolName === toolName) peer.open = open;
  }
});

function updateChatSearch(moveToCurrent = false) {
  const query = state.chatSearch.trim().toLocaleLowerCase();
  state.chatSearchHits = [];
  if (query) {
    state.messages.forEach((message, index) => {
      if (!isTranscriptMessageVisible(message)) return;
      const content = message.role === 'tool' && message.node instanceof HTMLElement
        ? message.node.textContent || ''
        : `${message.text || ''}\n${message.thinking || ''}\n${message.context || ''}`;
      if (content.toLocaleLowerCase().includes(query)) state.chatSearchHits.push(index);
    });
  }
  if (!state.chatSearchHits.length) state.chatSearchIndex = -1;
  else if (state.chatSearchIndex < 0 || state.chatSearchIndex >= state.chatSearchHits.length) state.chatSearchIndex = 0;

  ui.messageList.querySelectorAll('.search-match, .search-current').forEach((item) => item.classList.remove('search-match', 'search-current'));
  state.chatSearchHits.forEach((messageIndex, index) => {
    const row = ui.messageList.querySelector(`[data-message-index="${messageIndex}"]`);
    if (!row) return;
    row.classList.add(index === state.chatSearchIndex ? 'search-current' : 'search-match');
  });
  ui.chatSearchCount.textContent = state.chatSearchIndex < 0 ? (query ? '0 of 0' : '') : `${state.chatSearchIndex + 1} of ${state.chatSearchHits.length}`;
  if (moveToCurrent && state.chatSearchIndex >= 0) {
    const row = ui.messageList.querySelector(`[data-message-index="${state.chatSearchHits[state.chatSearchIndex]}"]`);
    const explorationGroup = row?.closest('.tool-exploration-group');
    if (explorationGroup instanceof HTMLDetailsElement) explorationGroup.open = true;
    const toolCard = row?.closest('.tool-card');
    if (toolCard instanceof HTMLDetailsElement) toolCard.open = true;
    row?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }
}

function createContextDiff(originalText, editedText) {
  const originalSource = String(originalText || '');
  const editedSource = String(editedText || '');
  const maxChars = 12000;
  const maxLines = 160;
  const originalLines = originalSource.slice(0, maxChars).split('\n');
  const editedLines = editedSource.slice(0, maxChars).split('\n');
  const truncated = originalSource.length > maxChars || editedSource.length > maxChars
    || originalLines.length > maxLines || editedLines.length > maxLines;
  originalLines.length = Math.min(originalLines.length, maxLines);
  editedLines.length = Math.min(editedLines.length, maxLines);

  const lengths = Array.from({ length: originalLines.length + 1 }, () => new Uint16Array(editedLines.length + 1));
  for (let originalIndex = originalLines.length - 1; originalIndex >= 0; originalIndex -= 1) {
    for (let editedIndex = editedLines.length - 1; editedIndex >= 0; editedIndex -= 1) {
      lengths[originalIndex][editedIndex] = originalLines[originalIndex] === editedLines[editedIndex]
        ? lengths[originalIndex + 1][editedIndex + 1] + 1
        : Math.max(lengths[originalIndex + 1][editedIndex], lengths[originalIndex][editedIndex + 1]);
    }
  }

  const diff = document.createElement('details');
  diff.className = 'context-diff';
  const summary = document.createElement('summary');
  const output = document.createElement('pre');
  output.className = 'context-diff-output';
  const lines = document.createDocumentFragment();
  let originalIndex = 0;
  let editedIndex = 0;
  let changes = 0;
  const addLine = (kind, prefix, text) => {
    const line = document.createElement('span');
    line.className = `context-diff-line ${kind}`;
    line.textContent = `${prefix} ${text}\n`;
    lines.append(line);
  };

  while (originalIndex < originalLines.length || editedIndex < editedLines.length) {
    if (originalIndex < originalLines.length && editedIndex < editedLines.length
      && originalLines[originalIndex] === editedLines[editedIndex]) {
      addLine('unchanged', ' ', originalLines[originalIndex]);
      originalIndex += 1;
      editedIndex += 1;
    } else if (originalIndex < originalLines.length
      && (editedIndex >= editedLines.length || lengths[originalIndex + 1][editedIndex] >= lengths[originalIndex][editedIndex + 1])) {
      addLine('removed', '−', originalLines[originalIndex]);
      originalIndex += 1;
      changes += 1;
    } else {
      addLine('added', '+', editedLines[editedIndex]);
      editedIndex += 1;
      changes += 1;
    }
  }
  if (truncated) addLine('truncated', '…', 'Diff preview is truncated');
  summary.textContent = `Pi context diff · ${changes} ${changes === 1 ? 'change' : 'changes'}`;
  output.append(lines);
  diff.append(summary, output);
  return diff;
}

function appendContextEditHistory(row, message) {
  const history = Array.isArray(message.contextHistory) ? message.contextHistory.slice(-12) : [];
  const truncated = message.contextHistoryTruncated === true;
  if (!history.length && !truncated) return;

  const details = document.createElement('details');
  details.className = 'context-edit-history';
  const summary = document.createElement('summary');
  summary.textContent = `Context edit history (${history.length}${truncated ? '+' : ''})`;
  details.append(summary);

  const revisions = document.createElement('div');
  revisions.className = 'context-edit-history-revisions';
  history.forEach((revision, index) => {
    if (!revision || (revision.status !== 'omitted' && revision.status !== 'edited')) return;
    const item = document.createElement('section');
    item.className = 'context-edit-history-revision';
    const heading = document.createElement('div');
    heading.className = 'context-edit-history-heading';
    const date = typeof revision.timestamp === 'string' ? Date.parse(revision.timestamp) : Number.NaN;
    heading.textContent = `${revision.status === 'omitted' ? 'Omitted from Pi context' : `Revision ${index + 1}`}${Number.isFinite(date) ? ` · ${new Date(date).toLocaleString()}` : ''}`;
    item.append(heading);
    if (revision.status === 'edited' && typeof revision.text === 'string' && revision.text) {
      const content = document.createElement('pre');
      content.className = 'context-edit-history-content';
      content.textContent = revision.text.slice(0, 8000);
      item.append(content);
    }
    revisions.append(item);
  });
  if (truncated) {
    const note = document.createElement('div');
    note.className = 'context-edit-history-note';
    note.textContent = 'Some earlier revisions were omitted from this preview.';
    revisions.append(note);
  }
  details.append(revisions);
  row.append(details);
}

function stepChatSearch(direction) {
  if (!state.chatSearchHits.length) return;
  state.chatSearchIndex = (state.chatSearchIndex + direction + state.chatSearchHits.length) % state.chatSearchHits.length;
  updateChatSearch(true);
}

function quoteSourceIds(context) {
  const ids = [];
  const blocks = /<quote-context>\s*<quote\b([^>]*)>[\s\S]*?<\/quote>\s*<\/quote-context>/g;
  let match;
  while ((match = blocks.exec(String(context || ''))) !== null && ids.length < 8) {
    const source = /(?:^|\s)source="([^"\r\n<>]{1,256})"/.exec(match[1]);
    if (!source) continue;
    const id = source[1].replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
    if (!ids.includes(id)) ids.push(id);
  }
  return ids;
}

function jumpToQuotedMessage(entryId) {
  const sourceIndex = state.messages.findIndex((item) => item.entryId === entryId);
  if (sourceIndex < 0) {
    showNotice('The quoted message is outside the active session branch.');
    return;
  }
  const row = ui.messageList.querySelector(`article[data-message-index="${sourceIndex}"]`);
  if (!row) {
    showNotice('The quoted message is not visible in this transcript.');
    return;
  }
  row.scrollIntoView({ block: 'center', behavior: 'smooth' });
  row.classList.add('quote-reference-target');
  setTimeout(() => row.classList.remove('quote-reference-target'), 1800);
}

function renderAttachments() {
  ui.attachments.replaceChildren();
  const visibleAttachmentIds = new Set([
    ...(state.pinnedFile ? [state.pinnedFile.id] : []),
    ...state.attachments.map((attachment) => attachment.id),
  ]);
  if (!visibleAttachmentIds.has(state.expandedContextId)) state.expandedContextId = '';
  const appendChip = (attachment, isPinned = false) => {
    const chip = document.createElement('span');
    chip.className = `attachment-chip${isPinned ? ' pinned' : ''}`;
    chip.title = attachment.path;
    const name = document.createElement('span');
    name.className = 'attachment-name';
    name.textContent = attachment.label;
    if (attachment.image?.data && attachment.image?.mimeType) {
      const preview = document.createElement('img');
      preview.className = 'attachment-preview';
      preview.src = `data:${attachment.image.mimeType};base64,${attachment.image.data}`;
      preview.alt = attachment.label;
      chip.prepend(preview);
    }
    let previewContext;
    if (typeof attachment.context === 'string' && attachment.context) {
      const expanded = state.expandedContextId === attachment.id;
      previewContext = document.createElement('button');
      previewContext.type = 'button';
      previewContext.className = 'attachment-context-toggle';
      previewContext.dataset.attachmentId = String(attachment.id || '');
      previewContext.textContent = expanded ? 'Hide' : 'View';
      previewContext.title = expanded ? 'Hide attached text context' : 'Preview attached text context';
      previewContext.setAttribute('aria-expanded', String(expanded));
      previewContext.addEventListener('click', () => {
        state.expandedContextId = expanded ? '' : attachment.id;
        renderAttachments();
        const replacement = Array.from(ui.attachments.querySelectorAll('.attachment-context-toggle'))
          .find((button) => button.dataset.attachmentId === String(attachment.id || ''));
        replacement?.focus();
      });
    }
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'attachment-remove';
    remove.title = isPinned ? 'Unpin active file' : 'Remove attachment';
    remove.setAttribute('aria-label', `Remove ${attachment.label}`);
    remove.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg>';
    remove.addEventListener('click', () => {
      if (isPinned) {
        state.pinnedFile = undefined;
        state.pinnedFileEnabled = false;
        post('unpinActiveFile');
      } else {
        state.attachments = state.attachments.filter((item) => item.id !== attachment.id);
      }
      renderAttachments();
    });
    chip.append(name);
    if (previewContext) chip.append(previewContext);
    chip.append(remove);
    ui.attachments.append(chip);
    if (state.expandedContextId === attachment.id && typeof attachment.context === 'string' && attachment.context) {
      const preview = document.createElement('pre');
      preview.className = 'attachment-context-preview';
      preview.tabIndex = 0;
      preview.setAttribute('aria-label', `Attached context for ${String(attachment.label || 'item').slice(0, 160)}`);
      preview.textContent = attachment.context.slice(0, 100_000);
      if (attachment.context.length > 100_000) preview.textContent += '\n[Preview truncated after 100,000 characters]';
      ui.attachments.append(preview);
    }
  };
  if (state.pinnedFile) appendChip(state.pinnedFile, true);
  for (const attachment of state.attachments) {
    appendChip(attachment);
  }
  updateControls();
}

function attachImageFile(file) {
  if (!file || !String(file.type || '').startsWith('image/')) return false;
  if (file.size > 5 * 1024 * 1024) {
    showNotice('This image is over 5 MB. Choose a smaller image.', true);
    return true;
  }
  const reader = new FileReader();
  reader.addEventListener('load', () => {
    const result = String(reader.result || '');
    const base64 = result.includes(',') ? result.slice(result.indexOf(',') + 1) : '';
    if (!base64) return;
    state.attachments.push({
      id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
      label: file.name || 'Pasted image',
      path: file.name || 'pasted-image',
      context: '',
      image: { data: base64, mimeType: file.type },
    });
    renderAttachments();
    updateControls();
  });
  reader.readAsDataURL(file);
  return true;
}

function isValidBase64ImageData(data) {
  if (!data || data.length % 4 !== 0) return false;
  const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0;
  const contentLength = data.length - padding;
  if (data.indexOf('=') !== (padding ? contentLength : -1)) return false;
  for (let offset = 0; offset < contentLength; offset += 4096) {
    if (!/^[A-Za-z0-9+/]+$/.test(data.slice(offset, Math.min(offset + 4096, contentLength)))) return false;
  }
  return true;
}

function restoreImageAttachments(value) {
  if (!Array.isArray(value)) return { attachments: [], skipped: 0 };
  const allowedTypes = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
  const candidates = value.slice(0, 5);
  const attachments = [];
  let skipped = Math.max(0, value.length - candidates.length);
  let totalBytes = 0;
  for (const candidate of candidates) {
    const image = candidate && typeof candidate === 'object' ? candidate : {};
    const data = image.data;
    const mimeType = image.mimeType;
    if (typeof data !== 'string' || data.length > 7_000_000 || !isValidBase64ImageData(data)
      || typeof mimeType !== 'string' || !allowedTypes.has(mimeType)) {
      skipped += 1;
      continue;
    }
    const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0;
    const decodedBytes = Math.floor(data.length * 3 / 4) - padding;
    if (decodedBytes <= 0 || decodedBytes > 5 * 1024 * 1024 || totalBytes + decodedBytes > 25 * 1024 * 1024) {
      skipped += 1;
      continue;
    }
    const index = attachments.length + 1;
    attachments.push({
      id: `restored-image-${Date.now()}-${index}-${Math.random().toString(16).slice(2)}`,
      label: `Restored image ${index}`,
      path: 'transcript image',
      context: '',
      image: { data, mimeType },
    });
    totalBytes += decodedBytes;
  }
  return { attachments, skipped };
}

function setBusy(busy, activityText, stopAllowed = true) {
  state.busy = Boolean(busy);
  state.stopAllowed = state.busy && stopAllowed;
  if (activityText) ui.activityText.textContent = activityText;
  updateControls();
}

function closeHistory() {
  ui.history.hidden = true;
  ui.historyToggle.setAttribute('aria-expanded', 'false');
}

function sendPrompt(value = ui.prompt.value) {
  const text = String(value || '').trim();
  const attachments = [...state.attachments, ...(state.pinnedFile ? [{ ...state.pinnedFile }] : [])];
  if ((!text && !attachments.length) || !state.hasWorkspace) return;
  const promptText = text || (attachments.some((item) => item.image)
    ? 'Please inspect the attached image.'
    : attachments.some((item) => item.context) ? 'Please inspect the attached context.' : '');
  if (text) rememberPrompt(text);
  const context = attachments.map((item) => item.context).join('\n');
  if (state.busy) {
    ui.prompt.value = '';
    ui.prompt.style.height = 'auto';
    rememberDraft();
    state.attachments = [];
    renderAttachments();
    post('send', { text: promptText, attachments, deliverAs: state.deliverAs });
    const queueKey = state.deliverAs === 'steer' ? 'steering' : 'followUp';
    state.queue[queueKey].push(promptText);
    renderQueue();
    return;
  }
  state.messages.push({ role: 'user', text: promptText, context });
  state.attachments = [];
  ui.prompt.value = '';
  ui.prompt.style.height = 'auto';
  rememberDraft();
  renderAttachments();
  renderMessages();
  setBusy(true, 'Starting Pi');
  post('send', { text: promptText, attachments, deliverAs: state.deliverAs });
  ui.prompt.focus();
}

function renderModelChoices(data) {
  state.models = Array.isArray(data.models) ? data.models : [];
  state.providers = Array.isArray(data.providers) ? data.providers.slice(0, 200).filter((provider) => provider
    && typeof provider.id === 'string' && typeof provider.name === 'string'
    && (provider.supportsApiKey === true || provider.supportsOAuth === true)).map((provider) => ({
      ...provider,
      id: provider.id.slice(0, 128),
      name: provider.name.slice(0, 128),
      authLabel: typeof provider.authLabel === 'string' ? provider.authLabel.slice(0, 128) : '',
    })) : [];
  state.currentModel = data.currentModel;
  const runtimeSettings = data.runtimeSettings || {};
  state.runtimeSettings = {
    autoCompaction: runtimeSettings.autoCompaction === true,
    autoRetry: runtimeSettings.autoRetry === true,
    cacheWarming: ['off', 'streaming', 'idle'].includes(runtimeSettings.cacheWarming) ? runtimeSettings.cacheWarming : 'off',
    offlineMode: ['inherit', 'offline', 'online'].includes(runtimeSettings.offlineMode) ? runtimeSettings.offlineMode : 'inherit',
  };
  ui.autoCompaction.checked = state.runtimeSettings.autoCompaction;
  ui.autoRetry.checked = state.runtimeSettings.autoRetry;
  ui.cacheWarming.value = state.runtimeSettings.cacheWarming;
  ui.offlineMode.value = state.runtimeSettings.offlineMode;
  state.mcpEnabled = data.mcpEnabled === true;
  if (!state.mcpSettingPending) ui.mcpEnabled.checked = state.mcpEnabled;
  state.presets = Array.isArray(data.presets) ? data.presets : state.presets;
  const selectedKey = data.currentModel ? `${data.currentModel.provider}/${data.currentModel.id}` : '';
  const selectedModel = state.models.find((model) => `${model.provider}/${model.id}` === selectedKey);
  ui.modelToggle.textContent = selectedModel ? shorten(selectedModel.name || selectedModel.id, 30) : state.models.length ? 'Choose model' : 'No models';
  ui.modelToggle.title = selectedModel ? `${selectedModel.provider}/${selectedModel.id}` : 'Choose model';
  renderModelList();

  state.thinkingLevel = String(data.thinkingLevel || '');
  state.thinkingLevels = Array.isArray(data.thinkingLevels) ? data.thinkingLevels : [];
  state.supportsThinking = Boolean(data.supportsThinking && state.thinkingLevels.length);
  ui.thinkingChoice.hidden = !state.supportsThinking;
  ui.thinkingChoice.replaceChildren();
  for (const level of state.thinkingLevels) {
    const option = document.createElement('option');
    option.value = level;
    option.textContent = `${level[0].toUpperCase()}${level.slice(1)}`;
    ui.thinkingChoice.append(option);
  }
  if (state.thinkingLevel) ui.thinkingChoice.value = state.thinkingLevel;

  state.skills = Array.isArray(data.skills) ? data.skills : [];
  state.extensionCommands = Array.isArray(data.extensionCommands) ? data.extensionCommands.slice(0, 100).filter((command) => command
    && typeof command.name === 'string' && command.name.length > 0 && command.name.length <= 128
    && !/[\\/\s\u0000-\u001f\u007f]/.test(command.name)).map((command) => ({
      name: command.name,
      description: typeof command.description === 'string' ? command.description.slice(0, 500) : '',
      hasArgumentCompletions: command.hasArgumentCompletions === true,
    })) : [];
  state.prompts = Array.isArray(data.prompts) ? data.prompts : [];
  state.resourceDiagnostics = Array.isArray(data.resourceDiagnostics) ? data.resourceDiagnostics.slice(0, 100) : [];
  state.tools = Array.isArray(data.tools) ? data.tools : [];
  state.activeTools = Array.isArray(data.activeTools) ? data.activeTools : [];
  state.defaultTools = Array.isArray(data.defaultTools) ? data.defaultTools : [];
  state.disabledSkills = Array.isArray(data.disabledSkills) ? data.disabledSkills : [];
  state.branchPoints = Array.isArray(data.branchPoints) ? data.branchPoints : [];
  renderBranchPoints();
  renderPresets();
  renderTools();
  renderCommands();
  renderProviderStatus();
  renderResourceDiagnostics();
  updateControls();
}

function renderProviderStatus() {
  const configured = state.providers.filter((provider) => provider.configured).length;
  ui.providerStatus.textContent = state.providers.length
    ? `${configured} of ${state.providers.length} interactive providers configured`
    : 'No provider sign-in methods are available.';
  ui.providerStatus.title = state.providers.map((provider) => `${provider.name}: ${provider.configured ? provider.authLabel || 'configured' : 'not connected'}`).join('\n');
}

function renderModelList() {
  ui.modelList.replaceChildren();
  const terms = state.modelSearch.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const matches = state.models.filter((model) => {
    const searchable = `${model.provider} ${model.name || ''} ${model.id} ${model.supportsImages ? 'vision images' : ''}`.toLocaleLowerCase();
    return terms.every((term) => searchable.includes(term));
  });
  if (!matches.length) {
    const empty = document.createElement('div');
    empty.className = 'option-empty';
    empty.textContent = state.models.length ? 'No models match this search.' : 'No configured models are available.';
    ui.modelList.append(empty);
    return;
  }
  for (const model of matches) {
    const option = document.createElement('button');
    option.type = 'button';
    option.className = 'command-option model-option';
    option.setAttribute('role', 'option');
    const current = state.currentModel && model.provider === state.currentModel.provider && model.id === state.currentModel.id;
    option.setAttribute('aria-selected', String(Boolean(current)));
    const name = document.createElement('strong');
    name.textContent = model.name || model.id;
    const details = [model.provider, model.id];
    if (Number(model.contextWindow) > 0) details.push(`${Math.round(model.contextWindow / 1000)}k context`);
    if (model.supportsImages) details.push('vision');
    const description = document.createElement('small');
    description.textContent = details.join(' · ');
    option.append(name, description);
    option.addEventListener('click', () => {
      post('setModel', { provider: model.provider, modelId: model.id });
      ui.modelPopover.hidden = true;
      ui.modelToggle.setAttribute('aria-expanded', 'false');
    });
    ui.modelList.append(option);
  }
}

function renderContextUsage() {
  const usage = state.contextUsage;
  const percent = Number(usage?.percent);
  if (!usage || !Number.isFinite(percent) || percent < 0) {
    ui.contextMeter.hidden = true;
    ui.compactSession.hidden = true;
    return;
  }
  const bounded = Math.min(100, percent);
  ui.contextMeter.hidden = false;
  ui.contextMeter.setAttribute('aria-valuenow', String(Math.round(bounded)));
  ui.contextMeterFill.style.width = `${bounded}%`;
  ui.contextMeter.classList.toggle('near-limit', bounded >= 80);
  const tokens = Number(usage.tokens);
  const windowSize = Number(usage.contextWindow);
  const format = (value) => value >= 1_000_000 ? `${(value / 1_000_000).toFixed(1)}m` : `${Math.round(value / 1000)}k`;
  ui.contextMeterLabel.textContent = `${Number.isFinite(tokens) ? format(tokens) : '—'} / ${format(windowSize)} context · ${Math.round(bounded)}%`;
  ui.contextMeter.title = 'Estimated context currently in use';
  ui.compactSession.hidden = bounded < 80 || !state.hasSession;
  ui.compactSession.title = 'Ask Pi to summarize older context to free context window space';
}

function renderSessionUsage() {
  const stats = state.sessionStats;
  const cost = Number(stats?.cost);
  const tokens = Number(stats?.tokens?.total);
  if (!stats || !Number.isFinite(cost) || cost < 0) {
    ui.sessionUsage.textContent = '';
    ui.sessionUsage.title = '';
    return;
  }
  const tokenLabel = Number.isFinite(tokens) && tokens >= 0 ? `${Math.round(tokens).toLocaleString()} tokens` : 'usage';
  const costLabel = cost < 0.01 ? cost.toFixed(4) : cost.toFixed(2);
  ui.sessionUsage.textContent = `$${costLabel} · ${tokenLabel}`;
  ui.sessionUsage.title = 'Cumulative Pi usage for this session, including earlier turns and compacted history.';
}

function renderBookmarks() {
  ui.bookmarkList.replaceChildren();
  const bookmarkedMessages = state.bookmarks
    .map((entryId) => state.messages.find((message) => message.entryId === entryId))
    .filter((message) => message && (message.role === 'user' || message.role === 'assistant'));
  bookmarkedMessages.sort((left, right) => state.messages.indexOf(left) - state.messages.indexOf(right));
  ui.bookmarkEmpty.hidden = bookmarkedMessages.length > 0;
  for (const message of bookmarkedMessages) {
    const entry = document.createElement('div');
    entry.className = 'session-entry bookmark-entry';
    const jump = document.createElement('button');
    jump.type = 'button';
    jump.className = 'session-row branch-point';
    const title = document.createElement('span');
    title.className = 'session-row-title';
    title.textContent = `${message.role === 'user' ? 'You' : 'Pi'}: ${String(message.text || '').replace(/\s+/g, ' ').slice(0, 76)}`;
    const subtitle = document.createElement('span');
    subtitle.className = 'session-row-id';
    subtitle.textContent = 'Jump to bookmarked message';
    jump.append(title, subtitle);
    jump.addEventListener('click', () => {
      const row = [...ui.messageList.querySelectorAll('[data-entry-id]')]
        .find((item) => item.dataset.entryId === message.entryId);
      ui.bookmarkPanel.hidden = true;
      ui.bookmarkToggle.setAttribute('aria-expanded', 'false');
      row?.scrollIntoView({ block: 'center', behavior: 'smooth' });
      if (row) {
        row.classList.add('bookmark-flash');
        setTimeout(() => row.classList.remove('bookmark-flash'), 1400);
      }
    });
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'session-action';
    remove.textContent = '×';
    remove.title = 'Remove bookmark';
    remove.setAttribute('aria-label', 'Remove bookmark');
    remove.addEventListener('click', () => {
      state.bookmarks = state.bookmarks.filter((entryId) => entryId !== message.entryId);
      renderMessages(false);
      post('setBookmarks', { entryIds: state.bookmarks });
    });
    entry.append(jump, remove);
    ui.bookmarkList.append(entry);
  }
}

function renderGitChanges() {
  ui.gitChangeList.replaceChildren();
  ui.gitDraftCommit.disabled = !state.gitReviewAvailable || state.gitChanges.length === 0;
  ui.gitDraftPr.disabled = !state.gitReviewAvailable || state.gitChanges.length === 0;
  if (!state.gitReviewAvailable) {
    ui.gitChangeSummary.textContent = state.gitSummary?.message || 'Git status is unavailable.';
    ui.gitChangeEmpty.hidden = true;
    return;
  }
  const summary = state.gitSummary || {};
  const counts = [
    `${Number(summary.files) || 0} files`,
    `+${Number(summary.insertions) || 0}`,
    `−${Number(summary.deletions) || 0}`,
  ];
  const statuses = [
    Number(summary.staged) ? `${summary.staged} staged` : '',
    Number(summary.modified) ? `${summary.modified} modified` : '',
    Number(summary.untracked) ? `${summary.untracked} untracked` : '',
    Number(summary.conflicts) ? `${summary.conflicts} conflicts` : '',
  ].filter(Boolean);
  ui.gitChangeSummary.textContent = `${String(summary.branch || '(detached HEAD)')} · ${counts.join(' · ')}${statuses.length ? `\n${statuses.join(' · ')}` : ''}${state.gitChangesTruncated ? '\nSome files are omitted from this list.' : ''}`;
  ui.gitChangeEmpty.hidden = state.gitChanges.length > 0;
  for (const change of state.gitChanges) {
    const row = document.createElement('div');
    row.className = 'git-change-row';
    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'git-change-open';
    open.textContent = String(change.path || 'Unknown file').slice(0, 4096);
    open.title = change.isUntracked ? 'Open this untracked file' : 'Open the Git diff for this file';
    open.addEventListener('click', () => post('openGitDiff', { path: change.path }));
    const details = document.createElement('div');
    details.className = 'git-change-status';
    details.textContent = Array.isArray(change.status) ? change.status.map(String).join(' · ') : 'Changed';
    row.append(open, details);
    if (change.canDiscard === true) {
      const discard = document.createElement('button');
      discard.type = 'button';
      discard.className = 'git-change-discard';
      discard.textContent = 'Discard unstaged';
      discard.title = 'Discard only the unstaged change after confirmation';
      discard.addEventListener('click', () => post('discardGitChange', { path: change.path }));
      row.append(discard);
    }
    ui.gitChangeList.append(row);
  }
}

function renderBranchPoints() {
  ui.branchList.replaceChildren();
  ui.branchEmpty.hidden = state.branchPoints.length > 0;
  for (const point of [...state.branchPoints].reverse()) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `session-row branch-point${point.currentBranch ? ' active' : ''}`;
    button.title = point.text;
    const title = document.createElement('span');
    title.className = 'session-row-title';
    title.textContent = shorten(point.text || 'User message', 78);
    const status = document.createElement('span');
    status.className = 'session-row-id';
    status.textContent = point.currentBranch ? 'Current branch' : 'Switch to this branch point';
    button.append(title, status);
    button.addEventListener('click', () => {
      ui.branchPanel.hidden = true;
      ui.branchHistoryToggle.setAttribute('aria-expanded', 'false');
      post('navigateTree', { entryId: point.entryId });
    });
    ui.branchList.append(button);
  }
}

function renderPresets() {
  ui.presets.replaceChildren();
  for (const preset of state.presets) {
    const available = state.models.some((model) => model.provider === preset.provider && model.id === preset.modelId);
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'preset-choice';
    button.textContent = preset.name;
    button.title = available
      ? `${preset.provider}/${preset.modelId}${preset.thinkingLevel ? ` · ${preset.thinkingLevel}` : ''} · right-click to manage · drag to reorder`
      : `Model ${preset.provider}/${preset.modelId} is unavailable in the current Pi configuration`;
    button.dataset.available = String(available);
    button.disabled = !available || state.busy;
    button.addEventListener('click', () => post('usePreset', {
      provider: preset.provider,
      modelId: preset.modelId,
      thinkingLevel: preset.thinkingLevel,
    }));
    button.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      post('managePreset', { id: preset.id });
    });
    button.draggable = true;
    button.addEventListener('dragstart', (event) => {
      event.dataTransfer?.setData('text/pi-model-preset', preset.id);
    });
    button.addEventListener('dragover', (event) => event.preventDefault());
    button.addEventListener('drop', (event) => {
      event.preventDefault();
      const fromId = event.dataTransfer?.getData('text/pi-model-preset');
      if (!fromId || fromId === preset.id) return;
      const reordered = [...state.presets];
      const fromIndex = reordered.findIndex((item) => item.id === fromId);
      const toIndex = reordered.findIndex((item) => item.id === preset.id);
      if (fromIndex < 0 || toIndex < 0) return;
      const [moved] = reordered.splice(fromIndex, 1);
      reordered.splice(toIndex, 0, moved);
      state.presets = reordered;
      renderPresets();
      post('reorderPresets', { ids: reordered.map((item) => item.id) });
    });
    ui.presets.append(button);
  }
  const add = document.createElement('button');
  add.type = 'button';
  add.className = 'preset-add';
  add.textContent = '+ Add preset';
  add.disabled = !state.hasSession || !state.currentModel || state.busy;
  add.addEventListener('click', () => post('addPreset', {
    provider: state.currentModel?.provider,
    modelId: state.currentModel?.id,
    thinkingLevel: state.thinkingLevel,
  }));
  ui.presets.append(add);
}

function renderTools() {
  ui.toolList.replaceChildren();
  if (!state.tools.length) {
    const empty = document.createElement('div');
    empty.className = 'option-empty';
    empty.textContent = 'No tools are available in this session.';
    ui.toolList.append(empty);
    return;
  }
  for (const tool of state.tools) {
    const label = document.createElement('label');
    label.className = 'option-row';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = state.activeTools.includes(tool.name);
    checkbox.disabled = state.busy;
    checkbox.addEventListener('change', () => {
      const active = new Set(state.activeTools);
      if (checkbox.checked) active.add(tool.name);
      else active.delete(tool.name);
      state.activeTools = [...active];
      post('setTools', { toolNames: state.activeTools });
    });
    const copy = document.createElement('span');
    const title = document.createElement('strong');
    title.textContent = tool.name;
    const description = document.createElement('small');
    description.textContent = tool.description || tool.namespace || 'Pi tool';
    copy.append(title, description);
    label.append(checkbox, copy);
    ui.toolList.append(label);
  }
}

function insertCommand(command, closePopover = true) {
  const existing = ui.prompt.value.trim();
  ui.prompt.value = existing ? `${command} ${existing}` : `${command} `;
  ui.prompt.focus();
  ui.prompt.setSelectionRange(ui.prompt.value.length, ui.prompt.value.length);
  ui.prompt.style.height = 'auto';
  ui.prompt.style.height = `${Math.min(ui.prompt.scrollHeight, 170)}px`;
  if (closePopover) {
    ui.skillsPopover.hidden = true;
    ui.skillsToggle.setAttribute('aria-expanded', 'false');
  }
  updateControls();
}

function addCommandOption(parent, command, description, kind, hint = '') {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'command-option';
  button.title = `${description || kind}${hint ? ` · Usage: /${command} ${hint}` : ''}`;
  const name = document.createElement('strong');
  name.textContent = command;
  const detail = document.createElement('small');
  detail.textContent = `${description || kind}${hint ? ` · ${hint}` : ''}`;
  button.append(name, detail);
  button.addEventListener('click', () => insertCommand(`/${command}`));
  parent.append(button);
}

function argumentHintTokens(value) {
  return String(value || '').match(/<[^>]+>|\[[^\]]+\]|[^\s,]+/g)?.map((token) => token.replace(/^[<\[]|[>\]]$/g, '').trim()).filter(Boolean) || [];
}

function promptTemplateFields(prompt) {
  const positional = new Map();
  const content = String(prompt.content || '');
  const placeholder = /\$\{(\d+)(?::-([^}]*))?\}|\$(\d+)/g;
  let match;
  while ((match = placeholder.exec(content)) !== null) {
    const index = Number(match[1] || match[3]);
    if (index > 0 && index <= 20 && !positional.has(index)) positional.set(index, match[2] || '');
  }
  const hints = argumentHintTokens(prompt.argumentHint);
  if (positional.size) {
    const fields = [];
    const max = Math.max(...positional.keys());
    for (let index = 1; index <= max; index += 1) {
      fields.push({ index, label: hints[index - 1] || `Argument ${index}`, defaultValue: positional.get(index) || '' });
    }
    return fields;
  }
  if (prompt.argumentHint || /\$(?:ARGUMENTS|@)|\$\{(?:ARGUMENTS|@):-|\$\{@:\d+(?::\d+)?\}/.test(content)) {
    return [{ index: 1, label: prompt.argumentHint || 'Arguments', defaultValue: '', multiline: true }];
  }
  return [];
}

function expandPromptPreview(content, args) {
  const allArgs = args.join(' ');
  return String(content || '').replace(/\$\{(\d+|ARGUMENTS|@):-([^}]*)\}|\$\{@:(\d+)(?::(\d+))?\}|\$(ARGUMENTS|@|\d+)/g,
    (_whole, defaultTarget, defaultValue, sliceStart, sliceLength, simple) => {
      if (defaultTarget) {
        const value = defaultTarget === '@' || defaultTarget === 'ARGUMENTS' ? allArgs : args[Number(defaultTarget) - 1];
        return value || defaultValue;
      }
      if (sliceStart) {
        const start = Math.max(0, Number(sliceStart) - 1);
        return args.slice(start, sliceLength ? start + Number(sliceLength) : undefined).join(' ');
      }
      if (simple === 'ARGUMENTS' || simple === '@') return allArgs;
      return args[Number(simple) - 1] ?? '';
    });
}

function renderPromptTemplatePreview() {
  const form = state.promptTemplateForm;
  if (!form) return;
  const args = form.fields.map((field) => field.input.value.replaceAll('\0', '').slice(0, 1000));
  const content = typeof form.prompt.content === 'string' ? form.prompt.content : '';
  if (!content) {
    ui.promptTemplatePreview.textContent = 'Preview unavailable for this template.';
    return;
  }
  const preview = expandPromptPreview(content, args);
  const previewText = preview.length > 20_000 ? `${preview.slice(0, 20_000)}\n\n[Preview truncated]` : preview;
  ui.promptTemplatePreview.textContent = form.prompt.contentTruncated
    ? `${previewText}\n\n[The source template is longer than the preview limit]`
    : previewText;
}

function openPromptTemplateForm(prompt) {
  if (!/^[\w.-]{1,128}$/.test(String(prompt.name || ''))) {
    showNotice('Pi cannot invoke this prompt template by slash command because its name contains unsupported characters.', true);
    return;
  }
  const fields = promptTemplateFields(prompt);
  if (!fields.length) {
    insertCommand(`/${prompt.name}`);
    return;
  }
  state.promptTemplateForm = { prompt, fields: [] };
  ui.promptTemplateTitle.textContent = `/${prompt.name}`;
  ui.promptTemplateDescription.textContent = prompt.description || prompt.argumentHint || 'Fill in the arguments, review the expansion, then insert it in the composer.';
  ui.promptTemplateFields.replaceChildren();
  for (const field of fields) {
    const label = document.createElement('label');
    label.className = 'prompt-template-field';
    const name = document.createElement('strong');
    name.textContent = field.label;
    const input = document.createElement(field.multiline ? 'textarea' : 'input');
    if (!field.multiline) input.type = 'text';
    input.maxLength = 1000;
    input.value = field.defaultValue.slice(0, 1000);
    input.addEventListener('input', renderPromptTemplatePreview);
    label.append(name, input);
    ui.promptTemplateFields.append(label);
    state.promptTemplateForm.fields.push({ ...field, input });
  }
  ui.promptTemplateLayer.hidden = false;
  renderPromptTemplatePreview();
  state.promptTemplateForm.fields[0]?.input.focus();
}

function closePromptTemplateForm() {
  ui.promptTemplateLayer.hidden = true;
  state.promptTemplateForm = undefined;
  ui.promptTemplateFields.replaceChildren();
}

function quotePiCommandArgument(value) {
  if (!value) return "''";
  return [...value.replaceAll('\0', '')].map((character) => character === '"' ? `'"'` : `"${character}"`).join('');
}

function usePromptTemplate() {
  const form = state.promptTemplateForm;
  if (!form) return;
  const args = form.fields.map((field) => quotePiCommandArgument(field.input.value.slice(0, 1000)));
  const command = `/${form.prompt.name}${args.length ? ` ${args.join(' ')}` : ''}`;
  closePromptTemplateForm();
  insertCommand(command);
}

function renderResourceDiagnostics() {
  ui.resourceDiagnostics.replaceChildren();
  if (!state.resourceDiagnostics.length) return;
  const details = document.createElement('details');
  const summary = document.createElement('summary');
  summary.textContent = `Resource diagnostics · ${state.resourceDiagnostics.length}`;
  details.append(summary);
  for (const diagnostic of state.resourceDiagnostics) {
    const row = document.createElement('div');
    row.className = 'resource-diagnostic';
    const title = document.createElement('strong');
    title.textContent = `${String(diagnostic.resource || 'Pi resource')} · ${String(diagnostic.type || 'warning')}`;
    const message = document.createElement('p');
    message.textContent = String(diagnostic.message || 'Resource diagnostic');
    row.append(title, message);
    if (typeof diagnostic.path === 'string' && diagnostic.path) {
      const source = document.createElement('small');
      source.textContent = diagnostic.path;
      const open = document.createElement('button');
      open.type = 'button';
      open.className = 'session-action';
      open.textContent = 'Open source';
      open.addEventListener('click', () => post('openResourceFile', { filePath: diagnostic.path }));
      row.append(source, open);
    }
    details.append(row);
  }
  ui.resourceDiagnostics.append(details);
}

function renderPackages() {
  ui.packageList.replaceChildren();
  ui.packageStatus.textContent = state.packageStatus;
  const projectScope = ui.packageScope.querySelector('option[value="project"]');
  projectScope.disabled = !state.projectTrusted;
  if (!state.projectTrusted && ui.packageScope.value === 'project') ui.packageScope.value = 'user';
  ui.packageEmpty.textContent = !state.packagesAvailable
    ? 'Package manager is unavailable until a Pi session is ready.'
    : !state.projectTrusted ? 'No visible user packages. Trust this workspace to manage project-scoped packages.' : 'No configured Pi packages.';
  for (const item of state.packages) {
    if (!item || typeof item.source !== 'string' || (item.scope !== 'user' && item.scope !== 'project')) continue;
    const row = document.createElement('div');
    row.className = 'package-row';
    const details = document.createElement('div');
    details.className = 'package-details';
    const source = document.createElement('strong');
    source.textContent = item.source.slice(0, 512);
    source.title = item.source.slice(0, 512);
    const scope = document.createElement('small');
    scope.textContent = `${item.scope === 'project' ? 'Project' : 'User'} scope${item.filtered ? ' · resource filters' : ''}`;
    details.append(source, scope);
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'session-action';
    remove.textContent = 'Remove';
    remove.title = `Remove this package from ${item.scope} Pi settings`;
    remove.addEventListener('click', () => post('managePackage', { action: 'remove', source: item.source, scope: item.scope }));
    row.append(details, remove);
    ui.packageList.append(row);
  }
  ui.packageEmpty.hidden = state.packages.length > 0;
  updateControls();
}

function addPromptOption(parent, prompt) {
  const row = document.createElement('div');
  row.className = 'prompt-option-row';
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'command-option';
  button.title = `${prompt.description || 'prompt template'}${prompt.argumentHint ? ` · Usage: /${prompt.name} ${prompt.argumentHint}` : ''}`;
  const name = document.createElement('strong');
  name.textContent = prompt.name;
  const detail = document.createElement('small');
  detail.textContent = `${prompt.description || 'prompt template'}${prompt.argumentHint ? ` · ${prompt.argumentHint}` : ''}`;
  button.append(name, detail);
  button.addEventListener('click', () => openPromptTemplateForm(prompt));
  row.append(button);
  if (typeof prompt.filePath === 'string' && prompt.filePath) {
    const edit = document.createElement('button');
    edit.type = 'button';
    edit.className = 'session-action';
    edit.textContent = 'Edit';
    edit.title = 'Open this prompt template for editing';
    edit.addEventListener('click', () => post('openPromptTemplate', { filePath: prompt.filePath }));
    row.append(edit);
  }
  parent.append(row);
}

function renderCommands() {
  state.commandCompletionRequestId = '';
  state.commandCompletionContext = undefined;
  ui.skillList.replaceChildren();
  ui.extensionCommandList.replaceChildren();
  ui.extensionCommandSuggestions.replaceChildren();
  ui.extensionCommandSuggestions.hidden = true;
  ui.promptList.replaceChildren();
  if (!state.skills.length) {
    const empty = document.createElement('div');
    empty.className = 'option-empty';
    empty.textContent = 'No skills found in Pi configuration.';
    ui.skillList.append(empty);
  }
  for (const skill of state.skills) {
    const row = document.createElement('div');
    row.className = 'skill-option';
    addCommandOption(row, `skill:${skill.name}`, skill.description, 'skill');
    const automatic = document.createElement('input');
    automatic.type = 'checkbox';
    automatic.className = 'skill-auto-toggle';
    automatic.dataset.skillName = skill.name;
    automatic.checked = Boolean(skill.canEnableAutoInvoke && !skill.disabledForAutoInvoke);
    automatic.disabled = !skill.canEnableAutoInvoke || state.busy;
    automatic.title = skill.canEnableAutoInvoke ? 'Allow Pi to choose this skill automatically' : 'This skill disables automatic invocation in its own metadata';
    automatic.setAttribute('aria-label', `Allow automatic invocation of ${skill.name}`);
    automatic.addEventListener('change', () => {
      const disabled = new Set(state.disabledSkills);
      if (automatic.checked) disabled.delete(skill.name);
      else disabled.add(skill.name);
      state.disabledSkills = [...disabled];
      state.skills = state.skills.map((item) => item.name === skill.name
        ? { ...item, disabledForAutoInvoke: !automatic.checked }
        : item);
      post('setSkills', { disabledSkills: state.disabledSkills });
    });
    row.append(automatic);
    ui.skillList.append(row);
  }
  if (!state.extensionCommands.length) {
    const empty = document.createElement('div');
    empty.className = 'option-empty';
    empty.textContent = 'No Pi extension commands are registered.';
    ui.extensionCommandList.append(empty);
  }
  for (const command of state.extensionCommands) {
    const row = document.createElement('div');
    row.className = 'extension-command-row';
    const choose = document.createElement('button');
    choose.type = 'button';
    choose.className = 'command-option';
    choose.title = `${command.description || 'extension command'} · Insert /${command.name} into the composer`;
    const name = document.createElement('strong');
    name.textContent = `/${command.name}`;
    const description = document.createElement('small');
    description.textContent = command.description || 'Extension command';
    choose.append(name, description);
    choose.addEventListener('click', () => insertCommand(`/${command.name}`));
    row.append(choose);
    if (command.hasArgumentCompletions) {
      const suggest = document.createElement('button');
      suggest.type = 'button';
      suggest.className = 'session-action extension-command-suggest';
      suggest.textContent = 'Suggest args';
      suggest.title = 'Call this configured extension command’s argument completion function. Suggestions are inserted into the composer and are not sent.';
      suggest.disabled = state.busy;
      suggest.addEventListener('click', () => requestExtensionCommandCompletions(command));
      row.append(suggest);
    }
    ui.extensionCommandList.append(row);
  }
  if (!state.prompts.length) {
    const empty = document.createElement('div');
    empty.className = 'option-empty';
    empty.textContent = 'No prompt templates found.';
    ui.promptList.append(empty);
  }
  for (const prompt of state.prompts) {
    addPromptOption(ui.promptList, prompt);
  }
}

function requestExtensionCommandCompletions(command) {
  const commandText = `/${command.name}`;
  const existing = ui.prompt.value;
  const startsWithCommand = existing.startsWith(commandText)
    && (existing.length === commandText.length || /\s/.test(existing[commandText.length]));
  if (!startsWithCommand) insertCommand(commandText, false);
  const value = ui.prompt.value;
  const commandEnd = commandText.length;
  let argumentStart = commandEnd;
  while (value[argumentStart] === ' ' || value[argumentStart] === '\t') argumentStart++;
  if (ui.prompt.selectionStart < argumentStart) {
    ui.prompt.setSelectionRange(argumentStart, argumentStart);
  }
  const cursor = ui.prompt.selectionStart;
  const argumentPrefix = value.slice(Math.min(argumentStart, cursor), cursor);
  const requestId = `${Date.now()}-${++state.commandCompletionSequence}`;
  state.commandCompletionRequestId = requestId;
  state.commandCompletionContext = { commandName: command.name, promptValue: value, cursor, argumentStart, argumentPrefix };
  ui.extensionCommandSuggestions.replaceChildren();
  ui.extensionCommandSuggestions.hidden = false;
  const loading = document.createElement('div');
  loading.className = 'option-empty';
  loading.textContent = 'Loading argument suggestions…';
  ui.extensionCommandSuggestions.append(loading);
  post('completeExtensionCommand', { requestId, commandName: command.name, argumentPrefix });
}

function renderExtensionCommandCompletions(data) {
  if (typeof data.requestId !== 'string' || data.requestId !== state.commandCompletionRequestId) return;
  const context = state.commandCompletionContext;
  if (!context || ui.prompt.value !== context.promptValue || ui.prompt.selectionStart !== context.cursor) {
    ui.extensionCommandSuggestions.replaceChildren();
    ui.extensionCommandSuggestions.hidden = true;
    state.commandCompletionRequestId = '';
    state.commandCompletionContext = undefined;
    return;
  }
  ui.extensionCommandSuggestions.replaceChildren();
  const items = Array.isArray(data.items) ? data.items.slice(0, 100).filter((item) => item
    && typeof item.value === 'string' && item.value.length <= 512).map((item) => ({
      value: item.value,
      label: typeof item.label === 'string' ? item.label.slice(0, 256) : item.value.slice(0, 256),
      description: typeof item.description === 'string' ? item.description.slice(0, 500) : '',
    })) : [];
  if (!items.length) {
    const empty = document.createElement('div');
    empty.className = 'option-empty';
    empty.textContent = data.error ? 'The extension could not provide suggestions.' : 'No argument suggestions are available.';
    ui.extensionCommandSuggestions.append(empty);
  } else {
    for (const item of items) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'command-option extension-command-completion';
      const label = document.createElement('strong');
      label.textContent = item.label;
      const description = document.createElement('small');
      description.textContent = item.description;
      button.append(label, description);
      button.addEventListener('click', () => {
        if (ui.prompt.value !== context.promptValue || ui.prompt.selectionStart !== context.cursor) return;
        ui.prompt.value = `${context.promptValue.slice(0, context.argumentStart)}${item.value}${context.promptValue.slice(context.cursor)}`;
        ui.prompt.focus();
        const nextCursor = context.argumentStart + item.value.length;
        ui.prompt.setSelectionRange(nextCursor, nextCursor);
        ui.prompt.dispatchEvent(new Event('input'));
        ui.extensionCommandSuggestions.replaceChildren();
        ui.extensionCommandSuggestions.hidden = true;
      });
      ui.extensionCommandSuggestions.append(button);
    }
  }
  ui.extensionCommandSuggestions.hidden = false;
  state.commandCompletionRequestId = '';
  state.commandCompletionContext = undefined;
}

function renderQueue() {
  ui.queueList.replaceChildren();
  if (!state.queue.steering.length && !state.queue.followUp.length) {
    ui.activityText.textContent = 'Pi is working';
  } else {
    const count = state.queue.steering.length + state.queue.followUp.length;
    ui.activityText.textContent = `Pi is working · ${count} queued`;
  }
  const total = state.queue.steering.length + state.queue.followUp.length;
  ui.queueToggle.textContent = `Queue${total ? ` · ${total}` : ''}`;
  ui.queueEmpty.hidden = total > 0;
  for (const [kind, items, label] of [
    ['steering', state.queue.steering, 'Steer during this run'],
    ['followUp', state.queue.followUp, 'Send after this run'],
  ]) {
    if (!items.length) continue;
    const heading = document.createElement('div');
    heading.className = 'queue-group-heading';
    heading.textContent = label;
    ui.queueList.append(heading);
    items.forEach((text, index) => {
      const row = document.createElement('div');
      row.className = 'queued-item';
      const content = document.createElement('div');
      content.className = 'queued-item-text';
      content.textContent = text;
      const actions = document.createElement('div');
      actions.className = 'queued-item-actions';
      const move = (delta) => {
        const next = { steering: [...state.queue.steering], followUp: [...state.queue.followUp] };
        const list = next[kind];
        const target = index + delta;
        if (target < 0 || target >= list.length) return;
        [list[index], list[target]] = [list[target], list[index]];
        replaceQueue(next);
      };
      const up = document.createElement('button');
      up.type = 'button'; up.className = 'session-action'; up.textContent = '↑'; up.title = 'Move up'; up.disabled = index === 0;
      up.addEventListener('click', () => move(-1));
      const down = document.createElement('button');
      down.type = 'button'; down.className = 'session-action'; down.textContent = '↓'; down.title = 'Move down'; down.disabled = index === items.length - 1;
      down.addEventListener('click', () => move(1));
      const edit = document.createElement('button');
      edit.type = 'button'; edit.className = 'session-action'; edit.textContent = 'Edit'; edit.title = 'Edit queued message';
      edit.addEventListener('click', () => {
        const input = document.createElement('textarea');
        input.className = 'queue-edit-input'; input.value = text; input.rows = 3;
        const save = document.createElement('button'); save.type = 'button'; save.className = 'session-action'; save.textContent = 'Save';
        save.addEventListener('click', () => {
          const next = { steering: [...state.queue.steering], followUp: [...state.queue.followUp] };
          next[kind][index] = input.value.trim();
          replaceQueue(next);
        });
        content.replaceChildren(input, save);
        input.focus();
      });
      const remove = document.createElement('button');
      remove.type = 'button'; remove.className = 'session-action danger-action'; remove.textContent = 'Remove'; remove.title = 'Remove queued message';
      remove.addEventListener('click', () => {
        const next = { steering: [...state.queue.steering], followUp: [...state.queue.followUp] };
        next[kind].splice(index, 1);
        replaceQueue(next);
      });
      actions.append(up, down, edit, remove);
      row.append(content, actions);
      ui.queueList.append(row);
    });
  }
}

function replaceQueue(next) {
  state.queue = {
    steering: next.steering.filter((text) => String(text).trim()),
    followUp: next.followUp.filter((text) => String(text).trim()),
  };
  renderQueue();
  post('replaceQueue', state.queue);
}

function renderExtensionWidgets() {
  ui.extensionWidgets.replaceChildren();
  for (const [key, widget] of state.extensionWidgets) {
    const details = document.createElement('details');
    details.className = 'extension-widget';
    details.open = Boolean(widget.options?.alwaysVisible);
    const summary = document.createElement('summary');
    summary.textContent = widget.options?.title || key;
    const content = document.createElement('div');
    content.className = 'extension-widget-content';
    content.textContent = widget.content.join('\n');
    details.append(summary, content);
    ui.extensionWidgets.append(details);
  }
}

function renderExtensionStatuses() {
  ui.extensionStatus.textContent = [...state.extensionStatuses.values()].join(' · ');
  ui.extensionStatus.title = [...state.extensionStatuses.entries()].map(([key, value]) => `${key}: ${value}`).join('\n');
}

function finishExtensionDialog(value) {
  const request = state.extensionRequest;
  if (!request) return;
  if (state.extensionDialogTimer) clearInterval(state.extensionDialogTimer);
  state.extensionDialogTimer = undefined;
  state.extensionRequest = undefined;
  ui.dialogLayer.hidden = true;
  post('extensionUiResponse', { requestId: request.requestId, value });
  const next = state.extensionRequestQueue.shift();
  if (state.extensionRequestQueue.length < MAX_QUEUED_EXTENSION_DIALOGS) state.extensionQueueFullNotified = false;
  if (next) showExtensionDialog(next);
}

const MAX_QUEUED_EXTENSION_DIALOGS = 20;
const EXTENSION_DIALOG_KINDS = new Set(['select', 'confirm', 'input', 'editor']);

function formatDialogCountdown(milliseconds) {
  const seconds = Math.max(0, Math.ceil(milliseconds / 1000));
  if (seconds >= 3600) return `${Math.floor(seconds / 3600)}h ${Math.ceil((seconds % 3600) / 60)}m`;
  if (seconds >= 60) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  return `${seconds}s`;
}

function showExtensionDialog(data) {
  const requestId = typeof data?.requestId === 'string' ? data.requestId : '';
  if (!requestId || requestId.length > 128 || !EXTENSION_DIALOG_KINDS.has(data.kind)) {
    if (requestId && requestId.length <= 128) post('extensionUiResponse', { requestId, value: undefined });
    return;
  }
  if (state.extensionRequest) {
    if (state.extensionRequestQueue.length >= MAX_QUEUED_EXTENSION_DIALOGS) {
      post('extensionUiResponse', { requestId, value: undefined });
      if (!state.extensionQueueFullNotified) {
        state.extensionQueueFullNotified = true;
        showNotice('Too many Pi extension dialogs are waiting. The extra request was cancelled.', true);
      }
      return;
    }
    state.extensionRequestQueue.push(data);
    return;
  }
  state.extensionRequest = {
    requestId: data.requestId,
    kind: data.kind,
    title: typeof data.title === 'string' ? data.title.slice(0, 256) : 'Pi extension',
    timeoutAt: Number.isSafeInteger(data.timeoutAt) && data.timeoutAt > Date.now() ? data.timeoutAt : 0,
  };
  const renderDialogTitle = () => {
    const request = state.extensionRequest;
    if (!request || request.requestId !== data.requestId) return;
    const remaining = request.timeoutAt ? request.timeoutAt - Date.now() : 0;
    ui.dialogTitle.textContent = remaining > 0
      ? `${request.title} (${formatDialogCountdown(remaining)})`
      : request.title;
  };
  if (state.extensionDialogTimer) clearInterval(state.extensionDialogTimer);
  state.extensionDialogTimer = undefined;
  renderDialogTitle();
  if (state.extensionRequest.timeoutAt) state.extensionDialogTimer = setInterval(renderDialogTitle, 1000);
  ui.dialogMessage.textContent = data.message || '';
  ui.dialogMessage.hidden = !data.message;
  ui.dialogOptions.replaceChildren();
  ui.dialogInput.value = String(data.prefill || '');
  ui.dialogInput.placeholder = String(data.placeholder || '');
  ui.dialogInput.hidden = data.kind !== 'input' && data.kind !== 'editor';
  ui.dialogInput.rows = data.kind === 'editor' ? 12 : 3;
  ui.dialogSubmit.textContent = data.kind === 'confirm' ? 'Confirm' : 'Continue';
  ui.dialogCancel.hidden = false;
  if (data.kind === 'select') {
    for (const [index, optionText] of (Array.isArray(data.options) ? data.options : []).entries()) {
      const label = document.createElement('label');
      label.className = 'extension-dialog-option';
      const radio = document.createElement('input');
      radio.type = 'radio';
      radio.name = 'pi-extension-choice';
      radio.value = String(optionText);
      radio.checked = index === 0;
      const text = document.createElement('span');
      text.textContent = String(optionText);
      label.append(radio, text);
      ui.dialogOptions.append(label);
    }
  }
  ui.dialogLayer.hidden = false;
  if (data.kind === 'input' || data.kind === 'editor') ui.dialogInput.focus();
  else if (data.kind === 'select') ui.dialogOptions.querySelector('input')?.focus();
  else ui.dialogSubmit.focus();
}

function cancelExtensionDialog(requestId) {
  if (!requestId || typeof requestId !== 'string') return;
  state.extensionRequestQueue = state.extensionRequestQueue.filter((request) => request?.requestId !== requestId);
  if (state.extensionRequest?.requestId !== requestId) return;
  if (state.extensionDialogTimer) clearInterval(state.extensionDialogTimer);
  state.extensionDialogTimer = undefined;
  state.extensionRequest = undefined;
  ui.dialogLayer.hidden = true;
  ui.dialogOptions.replaceChildren();
  ui.dialogInput.value = '';
  ui.dialogTitle.textContent = '';
  ui.dialogMessage.textContent = '';
  ui.dialogMessage.hidden = true;
  const next = state.extensionRequestQueue.shift();
  if (state.extensionRequestQueue.length < MAX_QUEUED_EXTENSION_DIALOGS) state.extensionQueueFullNotified = false;
  if (next) showExtensionDialog(next);
}

function resetExtensionDialogs() {
  if (state.extensionDialogTimer) clearInterval(state.extensionDialogTimer);
  state.extensionDialogTimer = undefined;
  state.extensionRequest = undefined;
  state.extensionRequestQueue = [];
  state.extensionQueueFullNotified = false;
  ui.dialogLayer.hidden = true;
  ui.dialogOptions.replaceChildren();
  ui.dialogInput.value = '';
  ui.dialogTitle.textContent = '';
  ui.dialogMessage.textContent = '';
  ui.dialogMessage.hidden = true;
}

function beginAssistantMessage() {
  state.messages.push({ role: 'assistant', text: '', thinking: '', streaming: true });
  state.streamIndex = state.messages.length - 1;
  renderMessages();
}

function applySnapshot(data) {
  const nextSessionPath = data.sessionFile || '';
  if (nextSessionPath !== state.sessionPath) {
    state.promptSuggestions = undefined;
    const previousKey = state.sessionPath || '__new';
    const currentDraft = String(ui.prompt.value || '').slice(0, 20000);
    if (currentDraft) state.drafts[previousKey] = currentDraft;
    if (previousKey === '__new' && currentDraft && !state.drafts[nextSessionPath]) state.drafts[nextSessionPath] = currentDraft;
    if (!state.drafts[nextSessionPath] && state.drafts.__new) state.drafts[nextSessionPath] = state.drafts.__new;
    if (!state.promptHistory[nextSessionPath] && state.promptHistory.__new) state.promptHistory[nextSessionPath] = state.promptHistory.__new;
    delete state.drafts.__new;
    delete state.promptHistory.__new;
    state.sessionPath = nextSessionPath;
    ui.prompt.value = state.drafts[nextSessionPath] || '';
    state.switchingSession = false;
    state.promptHistoryIndex = -1;
    persistWebviewState();
  }
  state.hasSession = Boolean(data.sessionId || data.sessionFile);
  state.bookmarks = Array.isArray(data.bookmarks)
    ? [...new Set(data.bookmarks.slice(0, 500).filter((entryId) => typeof entryId === 'string' && entryId.length <= 256))]
    : [];
  state.model = data.model || '';
  const messages = Array.isArray(data.messages) ? [...data.messages] : [];
  const toolMessages = state.toolMessagesBySession.get(state.sessionPath) || [];
  const recordedToolCalls = new Set(messages.filter((message) => message.role === 'tool')
    .map((message) => typeof message.toolCallId === 'string' ? message.toolCallId : '')
    .filter(Boolean));
  const unrecordedLiveTools = toolMessages.filter((message) => {
    const id = typeof message.toolCallId === 'string'
      ? message.toolCallId
      : message.node instanceof HTMLElement ? message.node.dataset.toolId : '';
    return !id || !recordedToolCalls.has(id);
  });
  state.toolMessagesBySession.set(state.sessionPath, unrecordedLiveTools);
  const lastAssistant = messages.findLastIndex((message) => message.role === 'assistant');
  if (lastAssistant >= 0) messages.splice(lastAssistant, 0, ...unrecordedLiveTools);
  else messages.push(...unrecordedLiveTools);
  state.messages = messages;
  const latestAssistant = messages.findLast((message) => message.role === 'assistant' && typeof message.entryId === 'string');
  if (state.promptSuggestions && latestAssistant?.entryId !== state.promptSuggestions.entryId) state.promptSuggestions = undefined;
  state.busy = Boolean(data.busy);
  state.contextUsage = data.contextUsage;
  state.sessionStats = data.sessionStats;
  renderContextUsage();
  renderSessionUsage();
  state.streamIndex = state.busy ? state.messages.findLastIndex((message) => message.role === 'assistant') : -1;
  ui.title.textContent = shorten(data.title || 'New chat', 48) || 'New chat';
  ui.title.title = data.title || 'New chat';
  renderSessions();
  renderMessages();
  renderBookmarks();
  if (state.busy) setBusy(true, 'Pi is working');
}

window.addEventListener('message', (event) => {
  const data = event.data || {};
  switch (data.type) {
    case 'workspace':
      updateWorkspace(data.name, data.hasWorkspace);
      break;
    case 'git-changes':
      state.gitReviewAvailable = data.available === true;
      state.gitSummary = state.gitReviewAvailable && data.summary && typeof data.summary === 'object'
        ? data.summary
        : { message: String(data.message || 'Git status is unavailable.') };
      state.gitChanges = Array.isArray(data.files) ? data.files.slice(0, 500) : [];
      state.gitChangesTruncated = data.truncated === true;
      renderGitChanges();
      break;
    case 'git-review-open':
      ui.gitReviewPanel.hidden = false;
      ui.gitReviewToggle.setAttribute('aria-expanded', 'true');
      post('refreshGitChanges');
      break;
    case 'packages':
      state.packagesAvailable = data.available === true;
      state.projectTrusted = data.projectTrusted === true;
      state.packages = Array.isArray(data.packages)
        ? data.packages.slice(0, 200).filter((item) => item && typeof item.source === 'string' && (item.scope === 'user' || item.scope === 'project'))
        : [];
      state.packageStatus = '';
      renderPackages();
      break;
    case 'package-progress':
      state.packageStatus = String(data.message || 'Managing Pi packages…').slice(0, 240);
      renderPackages();
      break;
    case 'sessions':
      state.sessions = Array.isArray(data.sessions) ? data.sessions : [];
      {
        const total = Number.isSafeInteger(data.total) && data.total >= 0 ? data.total : state.sessions.length;
        const allWorkspaces = data.allWorkspaces === true;
        const scope = allWorkspaces ? ' across workspaces' : '';
        const truncated = data.truncated === true;
        ui.sessionsResults.hidden = total === 0;
        ui.sessionsResults.textContent = total === 0 ? '' : truncated
          ? `${total} matching sessions${scope}; showing the first ${state.sessions.length}.`
          : `${total} matching session${total === 1 ? '' : 's'}${scope}.`;
      }
      renderSessions();
      break;
    case 'running-session-status': {
      const statuses = Array.isArray(data.statuses) ? data.statuses.slice(0, 500) : [];
      const byPath = new Map(statuses.flatMap((status) => status && typeof status.path === 'string'
        && status.path.length <= 4096
        && Number.isSafeInteger(status.count) && status.count > 0
        && typeof status.activity === 'string'
        ? [[status.path, status]]
        : []));
      let changed = false;
      state.sessions = state.sessions.map((session) => {
        const status = byPath.get(session.path);
        const running = Boolean(status);
        const runningCount = status ? Math.min(100, status.count) : 0;
        const runningActivity = status ? status.activity.slice(0, 96) : '';
        if (session.running === running && session.runningCount === runningCount && session.runningActivity === runningActivity) return session;
        changed = true;
        return { ...session, running, runningCount, runningActivity };
      });
      if (changed) renderSessions();
      break;
    }
    case 'snapshot':
      applySnapshot(data);
      break;
    case 'options':
      renderModelChoices(data);
      break;
    case 'offline-mode-setting':
      if (['inherit', 'offline', 'online'].includes(data.mode)) {
        state.runtimeSettings.offlineMode = data.mode;
        ui.offlineMode.value = data.mode;
        updateControls();
      }
      break;
    case 'command-completions':
      renderExtensionCommandCompletions(data);
      break;
    case 'prompt-suggestions-started':
      if (state.promptSuggestions?.entryId === data.entryId
        && typeof data.requestId === 'string' && data.requestId === state.promptSuggestions.requestId) {
        renderMessages(false);
      }
      break;
    case 'prompt-suggestions-result': {
      const current = state.promptSuggestions;
      if (!current || current.entryId !== data.entryId || typeof data.requestId !== 'string' || current.requestId !== data.requestId) break;
      const suggestions = Array.isArray(data.suggestions) ? data.suggestions.slice(0, 3).flatMap((value) => {
        if (typeof value !== 'string') return [];
        const text = value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
        return text.length >= 8 && text.length <= 240 ? [text] : [];
      }) : [];
      state.promptSuggestions = { entryId: current.entryId, requestId: '', loading: false, suggestions };
      if (typeof data.error === 'string' && data.error) showNotice(data.error.slice(0, 300), true);
      renderMessages(false);
      break;
    }
    case 'mcp-setting-pending':
      state.mcpSettingPending = true;
      updateControls();
      break;
    case 'mcp-setting-result':
      state.mcpSettingPending = false;
      if (typeof data.enabled === 'boolean') {
        state.mcpEnabled = data.enabled;
        ui.mcpEnabled.checked = data.enabled;
      }
      if (typeof data.error === 'string' && data.error) showNotice(data.error, true);
      else if (data.enabled === true) showNotice('Configured Pi MCP servers are enabled for the active session.', false);
      else if (data.enabled === false) showNotice('Configured Pi MCP servers are disabled for the active session.', false);
      updateControls();
      break;
    case 'presets':
      state.presets = Array.isArray(data.presets) ? data.presets : [];
      renderPresets();
      break;
    case 'queue':
      state.queue = {
        steering: Array.isArray(data.steering) ? data.steering : [],
        followUp: Array.isArray(data.followUp) ? data.followUp : [],
      };
      renderQueue();
      break;
    case 'extension-ui-request':
      showExtensionDialog(data);
      break;
    case 'extension-ui-cancel':
      cancelExtensionDialog(data.requestId);
      break;
    case 'extension-ui-reset':
      resetExtensionDialogs();
      break;
    case 'extension-ui-notice':
      showNotice(data.message || 'Pi extension notification', data.level === 'error' || data.level === 'warning');
      break;
    case 'extension-widget':
      state.extensionWidgets.set(String(data.key || 'extension'), {
        content: Array.isArray(data.content) ? data.content.map(String) : [String(data.content || '')],
        options: data.options || {},
      });
      renderExtensionWidgets();
      break;
    case 'extension-widget-remove':
      state.extensionWidgets.delete(String(data.key || ''));
      renderExtensionWidgets();
      break;
    case 'extension-status':
      if (typeof data.text === 'string' && data.text) state.extensionStatuses.set(String(data.key || 'extension'), data.text);
      else state.extensionStatuses.delete(String(data.key || 'extension'));
      renderExtensionStatuses();
      break;
    case 'extension-title':
      if (data.title) ui.title.textContent = shorten(data.title, 48);
      break;
    case 'extension-editor-text':
      ui.prompt.value = data.append ? `${ui.prompt.value}${String(data.text || '')}` : String(data.text || '');
      if (!data.append && typeof data.context === 'string' && data.context.trim()) {
        state.attachments.push({
          id: `restored-context-${Date.now()}`,
          label: 'Restored prompt context',
          path: 'transcript context',
          context: data.context.slice(0, 100_000),
        });
      }
      if (!data.append && Array.isArray(data.images)) {
        const restored = restoreImageAttachments(data.images);
        state.attachments.push(...restored.attachments);
        const skipped = restored.skipped + Math.max(0, Number(data.imageRestoreSkipped) || 0);
        if (skipped) showNotice(`Could not restore ${skipped} image ${skipped === 1 ? 'attachment' : 'attachments'}; supported images must be PNG, JPEG, WebP, or GIF up to 5 MB each.`);
      }
      if (!data.append && (typeof data.context === 'string' && data.context.trim() || Array.isArray(data.images))) renderAttachments();
      ui.prompt.focus();
      updateControls();
      break;
    case 'working-visible':
      state.showWorking = data.visible !== false;
      updateControls();
      break;
    case 'session-opening':
      state.switchingSession = true;
      setBusy(true, 'Opening session');
      break;
    case 'attachment':
      if (data.attachment && !state.attachments.some((item) => item.id === data.attachment.id)) {
        state.attachments.push(data.attachment);
        ui.notice.hidden = true;
        renderAttachments();
      }
      if (typeof data.draftPrompt === 'string') {
        const current = ui.prompt.value;
        const prompt = data.draftPrompt.slice(0, 2000);
        ui.prompt.value = `${current}${current.trim() ? '\n\n' : ''}${prompt}`.slice(0, 20_000);
        ui.prompt.dispatchEvent(new Event('input'));
        ui.prompt.focus();
      }
      break;
    case 'pinned-file':
      state.pinnedFileEnabled = Boolean(data.enabled);
      state.pinnedFile = data.enabled && data.attachment && typeof data.attachment.path === 'string'
        ? data.attachment
        : undefined;
      ui.pinActiveFile.textContent = state.pinnedFileEnabled ? 'Unpin active file' : 'Pin active file';
      ui.pinActiveFile.setAttribute('aria-pressed', String(state.pinnedFileEnabled));
      renderAttachments();
      break;
    case 'mention-results':
      if (data.query === state.mentionQuery && Array.isArray(data.results)) {
        state.mentionResults = data.results;
        renderMentionResults();
      }
      break;
    case 'assistant-start':
      beginAssistantMessage();
      setBusy(true, 'Pi is writing');
      break;
    case 'assistant-delta': {
      if (state.streamIndex < 0 || !state.messages[state.streamIndex]) beginAssistantMessage();
      state.messages[state.streamIndex].text += String(data.text || '');
      renderMessages();
      break;
    }
    case 'thinking-delta': {
      if (state.streamIndex < 0 || !state.messages[state.streamIndex]) beginAssistantMessage();
      const message = state.messages[state.streamIndex];
      const current = String(message.thinking || '');
      const delta = String(data.text || '');
      const remaining = Math.max(0, 50_000 - current.length);
      if (remaining > 0) message.thinking = `${current}${delta.slice(0, remaining)}`;
      if (delta.length > remaining) message.thinkingTruncated = true;
      renderMessages();
      break;
    }
    case 'activity':
      setBusy(true, data.message || 'Pi is working');
      break;
    case 'tool-start': {
      const detail = document.createElement('details');
      detail.className = 'tool-card';
      const toolName = String(data.name || 'tool').slice(0, 128);
      detail.open = toolExpansionPreference(toolName);
      detail.dataset.toolId = String(data.id || '');
      detail.dataset.toolName = toolName;
      const summary = document.createElement('summary');
      detail.append(summary);
      const toolMessage = {
        role: 'tool',
        toolCallId: String(data.id || '').slice(0, 256),
        toolName,
        argsPreview: typeof data.argsPreview === 'string' ? data.argsPreview.slice(0, 100000) : '{}',
        result: '',
        details: undefined,
        isError: false,
        rendererCall: Array.isArray(data.rendererCall) ? data.rendererCall : undefined,
        rendererResult: undefined,
        node: detail,
      };
      updateToolRendererCard(detail, toolMessage, `Running ${toolName}`);
      state.messages.push(toolMessage);
      const currentTools = state.toolMessagesBySession.get(state.sessionPath) || [];
      currentTools.push(toolMessage);
      state.toolMessagesBySession.set(state.sessionPath, currentTools);
      renderMessages();
      setBusy(true, `Running ${data.name || 'tool'}`);
      break;
    }
    case 'tool-update':
    case 'tool-end': {
      const toolId = String(data.id || '').slice(0, 256);
      const toolMessage = [...state.messages].reverse().find((message) => message.role === 'tool' && message.toolCallId === toolId);
      const card = [...ui.messageList.querySelectorAll('.tool-card')].find((item) => item.dataset.toolId === toolId)
        || (toolMessage?.node instanceof HTMLElement ? toolMessage.node : undefined);
      const result = data.result;
      let text = typeof result === 'string' ? result : JSON.stringify(result ?? '', null, 2);
      if (data.hasImages) text = text.split('\n').filter((line) => line.trim() !== '[image output]').join('\n').trim();
      if (toolMessage) {
        toolMessage.result = text.slice(-12000);
        toolMessage.details = data.details;
        if (Object.prototype.hasOwnProperty.call(data, 'rendererResult')) {
          toolMessage.rendererResult = data.rendererResult && typeof data.rendererResult === 'object' ? data.rendererResult : undefined;
        }
        if (Object.prototype.hasOwnProperty.call(data, 'rendererCall')) {
          toolMessage.rendererCall = Array.isArray(data.rendererCall) ? data.rendererCall : undefined;
        }
        if (data.type === 'tool-end') {
          toolMessage.hasImages = data.hasImages === true;
          toolMessage.imageCount = Number.isFinite(Number(data.imageCount)) ? Math.max(0, Math.trunc(Number(data.imageCount))) : 0;
          toolMessage.images = Array.isArray(data.images) ? data.images : [];
          toolMessage.imageDisplayOmitted = Number.isFinite(Number(data.imageDisplayOmitted))
            ? Math.max(0, Math.trunc(Number(data.imageDisplayOmitted)))
            : 0;
        }
      }
      if (card) {
        const currentTool = toolMessage || {
          role: 'tool',
          toolCallId: toolId,
          toolName: String(data.name || card.dataset.toolName || 'tool').slice(0, 128),
          argsPreview: '',
          result: text.slice(-12000),
          details: data.details,
          isError: Boolean(data.isError),
          rendererCall: Array.isArray(data.rendererCall) ? data.rendererCall : undefined,
          rendererResult: data.rendererResult && typeof data.rendererResult === 'object' ? data.rendererResult : undefined,
        };
        if (data.type === 'tool-end') {
          currentTool.isError = Boolean(data.isError);
          currentTool.toolName = String(data.name || card.dataset.toolName || 'tool').slice(0, 128);
        }
        updateToolRendererCard(card, currentTool, data.type === 'tool-end'
          ? `${data.isError ? 'Failed' : 'Finished'} ${currentTool.toolName}`
          : `Running ${currentTool.toolName}`);
        if (data.type === 'tool-end') renderToolImages(card, currentTool);
        appendStructuredToolDetails(card, data.details, data.type === 'tool-update');
        if (data.type === 'tool-end') {
          card.classList.toggle('tool-error', Boolean(data.isError));
          const toolName = String(data.name || card.dataset.toolName || 'tool').slice(0, 128);
          card.dataset.toolName = toolName;
          card.open = toolExpansionPreference(toolName, Boolean(data.isError));
        }
      }
      break;
    }
    case 'run-started':
      state.showWorking = true;
      setBusy(true, data.activity || 'Pi is working', data.canStop !== false);
      break;
    case 'run-finished':
      if (state.streamIndex >= 0 && state.messages[state.streamIndex]) state.messages[state.streamIndex].streaming = false;
      state.streamIndex = -1;
      setBusy(false);
      if (data.packageOperation) state.packageStatus = '';
      state.queue = { steering: [], followUp: [] };
      renderQueue();
      renderMessages();
      break;
    case 'runtime-error':
      showNotice(data.message || 'Pi could not complete the request.', true);
      break;
    case 'notice':
      showNotice(data.message || '', Boolean(data.isError));
      break;
  }
});

el('new-session').addEventListener('click', () => {
  if (state.hasSession) {
    rememberDraft();
    ui.prompt.value = '';
  }
  state.switchingSession = true;
  state.messages = [];
  state.bookmarks = [];
  state.model = '';
  setBusy(true, 'Starting a new chat');
  ui.title.textContent = 'New chat';
  renderMessages();
  post('newSession');
});

el('history-toggle').addEventListener('click', () => {
  const open = ui.history.hidden;
  ui.history.hidden = !open;
  ui.historyToggle.setAttribute('aria-expanded', String(open));
  if (open) post('listSessions', { query: state.sessionQuery, allWorkspaces: state.sessionSearchAllWorkspaces });
});
ui.gitReviewToggle.addEventListener('click', () => {
  const open = ui.gitReviewPanel.hidden;
  ui.gitReviewPanel.hidden = !open;
  ui.gitReviewToggle.setAttribute('aria-expanded', String(open));
  if (open) {
    ui.history.hidden = true;
    ui.historyToggle.setAttribute('aria-expanded', 'false');
    ui.bookmarkPanel.hidden = true;
    ui.bookmarkToggle.setAttribute('aria-expanded', 'false');
    ui.branchPanel.hidden = true;
    ui.branchHistoryToggle.setAttribute('aria-expanded', 'false');
    ui.queuePanel.hidden = true;
    ui.queueToggle.setAttribute('aria-expanded', 'false');
    post('refreshGitChanges');
  }
});
el('refresh-git-changes').addEventListener('click', () => post('refreshGitChanges'));
el('quote-git-diff-selection').addEventListener('click', () => post('quoteGitDiffSelection'));
ui.gitDraftCommit.addEventListener('click', () => post('draftGitChanges', { kind: 'commit' }));
ui.gitDraftPr.addEventListener('click', () => post('draftGitChanges', { kind: 'pullRequest' }));
el('close-git-review').addEventListener('click', () => {
  ui.gitReviewPanel.hidden = true;
  ui.gitReviewToggle.setAttribute('aria-expanded', 'false');
});
ui.focusTranscriptToggle.addEventListener('click', () => {
  state.focusedTranscript = !state.focusedTranscript;
  syncFocusTranscriptToggle();
  persistWebviewState();
  renderMessages(false);
});
ui.bookmarkToggle.addEventListener('click', () => {
  const open = ui.bookmarkPanel.hidden;
  ui.bookmarkPanel.hidden = !open;
  ui.bookmarkToggle.setAttribute('aria-expanded', String(open));
  ui.history.hidden = true;
  ui.historyToggle.setAttribute('aria-expanded', 'false');
  ui.branchPanel.hidden = true;
  ui.branchHistoryToggle.setAttribute('aria-expanded', 'false');
  if (open) renderBookmarks();
});
el('close-bookmarks').addEventListener('click', () => {
  ui.bookmarkPanel.hidden = true;
  ui.bookmarkToggle.setAttribute('aria-expanded', 'false');
});
ui.compactSession.addEventListener('click', () => post('compactSession'));
el('close-history').addEventListener('click', closeHistory);
el('close-branches').addEventListener('click', () => {
  ui.branchPanel.hidden = true;
  ui.branchHistoryToggle.setAttribute('aria-expanded', 'false');
});
el('queue-toggle').addEventListener('click', () => {
  const open = ui.queuePanel.hidden;
  ui.queuePanel.hidden = !open;
  el('queue-toggle').setAttribute('aria-expanded', String(open));
});
el('close-queue').addEventListener('click', () => {
  ui.queuePanel.hidden = true;
  el('queue-toggle').setAttribute('aria-expanded', 'false');
});
el('clear-queue').addEventListener('click', () => replaceQueue({ steering: [], followUp: [] }));
ui.branchHistoryToggle.addEventListener('click', () => {
  const open = ui.branchPanel.hidden;
  ui.branchPanel.hidden = !open;
  ui.branchHistoryToggle.setAttribute('aria-expanded', String(open));
  ui.history.hidden = true;
  ui.historyToggle.setAttribute('aria-expanded', 'false');
});
el('refresh-sessions').addEventListener('click', () => post('listSessions', { query: state.sessionQuery, allWorkspaces: state.sessionSearchAllWorkspaces }));
el('export-session').addEventListener('click', () => {
  if (state.hasSession) post('exportSession');
  else showNotice('Start or open a session before exporting.');
});
ui.sessionSearch.addEventListener('input', () => {
  state.sessionQuery = ui.sessionSearch.value;
  clearTimeout(state.sessionSearchTimer);
  state.sessionSearchTimer = setTimeout(() => post('listSessions', { query: state.sessionQuery, allWorkspaces: state.sessionSearchAllWorkspaces }), 220);
});
ui.sessionSearchAll.addEventListener('change', () => {
  state.sessionSearchAllWorkspaces = ui.sessionSearchAll.checked;
  persistWebviewState();
  post('listSessions', { query: state.sessionQuery, allWorkspaces: state.sessionSearchAllWorkspaces });
});
ui.renameSession.addEventListener('click', () => {
  if (state.sessionPath) post('renameSession', { path: state.sessionPath, currentName: ui.title.title });
});
el('open-settings').addEventListener('click', () => post('openSettings'));
ui.chatSearchToggle.addEventListener('click', () => {
  ui.chatSearchBar.hidden = !ui.chatSearchBar.hidden;
  ui.chatSearchToggle.setAttribute('aria-expanded', String(!ui.chatSearchBar.hidden));
  if (!ui.chatSearchBar.hidden) ui.chatSearchInput.focus();
});
ui.chatSearchInput.addEventListener('input', () => {
  state.chatSearch = ui.chatSearchInput.value;
  state.chatSearchIndex = 0;
  updateChatSearch(true);
});
el('chat-search-prev').addEventListener('click', () => stepChatSearch(-1));
el('chat-search-next').addEventListener('click', () => stepChatSearch(1));
el('chat-search-close').addEventListener('click', () => {
  ui.chatSearchBar.hidden = true;
  ui.chatSearchToggle.setAttribute('aria-expanded', 'false');
  state.chatSearch = '';
  ui.chatSearchInput.value = '';
  updateChatSearch();
});
el('attach-file').addEventListener('click', () => post('attachFile'));
ui.pinActiveFile.addEventListener('click', () => post('togglePinActiveFile'));
el('attach-editor').addEventListener('click', () => post('attachEditor'));
el('attach-range').addEventListener('click', () => post('attachRange'));
el('attach-folder').addEventListener('click', () => post('attachFolder'));
el('attach-diagnostics').addEventListener('click', () => post('attachDiagnostics'));
el('attach-git').addEventListener('click', () => post('attachGit'));
ui.newPromptTemplate.addEventListener('click', () => post('createPromptTemplate'));
ui.reloadResources.addEventListener('click', () => post('reloadResources'));
ui.packageSource.addEventListener('input', updateControls);
ui.packageSource.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !ui.installPackage.disabled) {
    event.preventDefault();
    post('installPackage', { source: ui.packageSource.value.slice(0, 512), scope: ui.packageScope.value });
  }
});
ui.installPackage.addEventListener('click', () => post('installPackage', {
  source: ui.packageSource.value.slice(0, 512),
  scope: ui.packageScope.value,
}));
ui.managePiResources.addEventListener('click', () => post('managePiResources'));
ui.updatePackages.addEventListener('click', () => post('managePackage', { action: 'update' }));
el('refresh-packages').addEventListener('click', () => post('listPackages'));
el('prompt-template-cancel').addEventListener('click', closePromptTemplateForm);
el('prompt-template-use').addEventListener('click', usePromptTemplate);
el('send').addEventListener('click', () => sendPrompt());
el('stop').addEventListener('click', () => post('stop'));
ui.dialogSubmit.addEventListener('click', () => {
  if (!state.extensionRequest) return;
  const { kind } = state.extensionRequest;
  if (kind === 'confirm') finishExtensionDialog(true);
  else if (kind === 'select') finishExtensionDialog(ui.dialogOptions.querySelector('input:checked')?.value);
  else finishExtensionDialog(ui.dialogInput.value);
});
ui.dialogCancel.addEventListener('click', () => finishExtensionDialog(undefined));
ui.dialogInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey && state.extensionRequest?.kind === 'input') {
    event.preventDefault();
    finishExtensionDialog(ui.dialogInput.value);
  }
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !ui.promptTemplateLayer.hidden) closePromptTemplateForm();
  if (event.key === 'Escape' && !ui.dialogLayer.hidden) finishExtensionDialog(undefined);
  if (event.key === 'Escape' && !ui.chatSearchBar.hidden) {
    ui.chatSearchBar.hidden = true;
    ui.chatSearchToggle.setAttribute('aria-expanded', 'false');
  }
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') {
    event.preventDefault();
    ui.chatSearchBar.hidden = false;
    ui.chatSearchToggle.setAttribute('aria-expanded', 'true');
    ui.chatSearchInput.focus();
  }
  if (!ui.chatSearchBar.hidden && event.key === 'Enter') {
    if (event.shiftKey) stepChatSearch(-1);
    else stepChatSearch(1);
  }
});
ui.modelToggle.addEventListener('click', () => {
  const open = ui.modelPopover.hidden;
  ui.modelPopover.hidden = !open;
  ui.toolsPopover.hidden = true;
  ui.skillsPopover.hidden = true;
  ui.modelToggle.setAttribute('aria-expanded', String(open));
  ui.toolsToggle.setAttribute('aria-expanded', 'false');
  ui.skillsToggle.setAttribute('aria-expanded', 'false');
  if (open) {
    renderModelList();
    ui.modelSearch.focus();
  }
});
ui.modelSearch.addEventListener('input', () => {
  state.modelSearch = ui.modelSearch.value;
  renderModelList();
});
el('refresh-models').addEventListener('click', () => post('refreshModels'));
ui.connectProvider.addEventListener('click', () => post('connectProvider'));
ui.runtimeSettingsToggle.addEventListener('click', () => {
  const open = ui.runtimeSettings.hidden;
  ui.runtimeSettings.hidden = !open;
  ui.runtimeSettingsToggle.setAttribute('aria-expanded', String(open));
});
ui.autoCompaction.addEventListener('change', () => {
  ui.autoCompaction.disabled = true;
  post('updatePiSetting', { setting: 'autoCompaction', value: ui.autoCompaction.checked });
});
ui.autoRetry.addEventListener('change', () => {
  ui.autoRetry.disabled = true;
  post('updatePiSetting', { setting: 'autoRetry', value: ui.autoRetry.checked });
});
ui.cacheWarming.addEventListener('change', () => {
  ui.cacheWarming.disabled = true;
  post('updatePiSetting', { setting: 'cacheWarming', value: ui.cacheWarming.value });
});
ui.offlineMode.addEventListener('change', () => {
  ui.offlineMode.disabled = true;
  post('setPiOfflineMode', { mode: ui.offlineMode.value });
});
ui.manageContextFiles.addEventListener('click', () => post('manageContextFiles'));
ui.editModelsConfig.addEventListener('click', () => post('openModelsConfig'));
ui.addModelEndpoint.addEventListener('click', () => post('addCustomEndpoint'));
ui.editPiSettings.addEventListener('click', () => post('openPiSettings'));
ui.choosePiAgentDir.addEventListener('click', () => post('choosePiAgentDir'));
ui.restartPiRuntime.addEventListener('click', () => post('restartPiRuntime'));
ui.editMcpConfig.addEventListener('click', () => post('openMcpConfig'));
el('manage-mcp-servers').addEventListener('click', () => post('manageMcpServers'));
el('export-diagnostics').addEventListener('click', () => post('exportDiagnostics'));
ui.mcpEnabled.addEventListener('change', () => {
  state.mcpSettingPending = true;
  updateControls();
  post('setMcpEnabled', { enabled: ui.mcpEnabled.checked });
});
ui.thinkingChoice.addEventListener('change', () => post('setThinkingLevel', { thinkingLevel: ui.thinkingChoice.value }));
ui.toolsToggle.addEventListener('click', () => {
  const open = ui.toolsPopover.hidden;
  ui.toolsPopover.hidden = !open;
  ui.skillsPopover.hidden = true;
  ui.modelPopover.hidden = true;
  ui.toolsToggle.setAttribute('aria-expanded', String(open));
  ui.skillsToggle.setAttribute('aria-expanded', 'false');
  ui.modelToggle.setAttribute('aria-expanded', 'false');
});
ui.skillsToggle.addEventListener('click', () => {
  const open = ui.skillsPopover.hidden;
  ui.skillsPopover.hidden = !open;
  ui.toolsPopover.hidden = true;
  ui.modelPopover.hidden = true;
  ui.skillsToggle.setAttribute('aria-expanded', String(open));
  ui.toolsToggle.setAttribute('aria-expanded', 'false');
  ui.modelToggle.setAttribute('aria-expanded', 'false');
  if (open) post('listPackages');
});
document.querySelectorAll('[data-tool-preset]').forEach((button) => {
  button.addEventListener('click', () => {
    const preset = button.getAttribute('data-tool-preset');
    const names = preset === 'default'
      ? state.defaultTools
      : preset === 'readonly'
        ? state.tools.map((tool) => tool.name).filter((name) => ['read', 'find', 'grep', 'ls'].includes(name))
        : [];
    state.activeTools = [...names];
    renderTools();
    post('setTools', { toolNames: names });
  });
});
ui.deliveryMode.addEventListener('click', () => {
  state.deliverAs = state.deliverAs === 'steer' ? 'followUp' : 'steer';
  updateControls();
});
ui.prompt.addEventListener('input', () => {
  ui.prompt.style.height = 'auto';
  ui.prompt.style.height = `${Math.min(ui.prompt.scrollHeight, 170)}px`;
  if (state.promptHistoryIndex < 0) state.promptHistoryDraft = ui.prompt.value;
  rememberDraft();
  updateMentionSearch();
  updateControls();
});
ui.prompt.addEventListener('keydown', (event) => {
  if (!ui.mentionPanel.hidden) {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const direction = event.key === 'ArrowDown' ? 1 : -1;
      if (state.mentionResults.length) {
        state.mentionIndex = (state.mentionIndex + direction + state.mentionResults.length) % state.mentionResults.length;
        renderMentionResults();
      }
      return;
    }
    if (event.key === 'Enter' && state.mentionResults.length) {
      event.preventDefault();
      chooseMention(state.mentionIndex);
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      ui.mentionPanel.hidden = true;
      state.mentionRange = undefined;
      return;
    }
  }
  if (event.key === 'ArrowUp' && !event.shiftKey && ui.prompt.selectionStart === 0 && ui.prompt.selectionEnd === 0) {
    event.preventDefault();
    browsePromptHistory(1);
    return;
  }
  if (event.key === 'ArrowDown' && !event.shiftKey && ui.prompt.selectionStart === ui.prompt.value.length && ui.prompt.selectionEnd === ui.prompt.value.length && state.promptHistoryIndex >= 0) {
    event.preventDefault();
    browsePromptHistory(-1);
    return;
  }
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    sendPrompt();
  }
});
ui.prompt.addEventListener('paste', (event) => {
  const items = Array.from(event.clipboardData?.items || []);
  const images = items.map((item) => item.getAsFile()).filter(Boolean);
  if (!images.length) return;
  event.preventDefault();
  for (const file of images) attachImageFile(file);
});
document.body.addEventListener('dragover', (event) => {
  event.preventDefault();
  el('attachments').classList.add('drop-active');
});
document.body.addEventListener('dragleave', (event) => {
  if (!event.relatedTarget || !document.body.contains(event.relatedTarget)) el('attachments').classList.remove('drop-active');
});
document.body.addEventListener('drop', (event) => {
  event.preventDefault();
  el('attachments').classList.remove('drop-active');
  const uriList = event.dataTransfer?.getData('text/uri-list') || '';
  const uris = uriList.split(/\r?\n/).map((item) => item.trim()).filter((item) => item && !item.startsWith('#'));
  if (uris.length) post('attachUris', { uris });
  for (const file of Array.from(event.dataTransfer?.files || [])) attachImageFile(file);
});
document.querySelectorAll('[data-prompt]').forEach((button) => {
  button.addEventListener('click', () => sendPrompt(button.getAttribute('data-prompt')));
});

post('ready', { allWorkspaces: state.sessionSearchAllWorkspaces });
