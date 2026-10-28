/* global acquireVsCodeApi */
const vscode = acquireVsCodeApi();
const persistedWebviewState = vscode.getState() || {};
const state = {
  hasWorkspace: false,
  workspaceName: '',
  sessionPath: '',
  sessions: [],
  sessionQuery: '',
  drafts: persistedWebviewState.drafts && typeof persistedWebviewState.drafts === 'object' ? persistedWebviewState.drafts : {},
  promptHistory: persistedWebviewState.promptHistory && typeof persistedWebviewState.promptHistory === 'object' ? persistedWebviewState.promptHistory : {},
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
  promptTemplateForm: undefined,
  tools: [],
  activeTools: [],
  defaultTools: [],
  disabledSkills: [],
  branchPoints: [],
  deliverAs: 'followUp',
  queue: { steering: [], followUp: [] },
  toolMessagesBySession: new Map(),
  extensionWidgets: new Map(),
  extensionStatuses: new Map(),
  extensionRequest: undefined,
  showWorking: true,
  contextUsage: undefined,
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
  branchPanel: el('branch-panel'),
  branchList: el('branch-list'),
  branchEmpty: el('branch-empty'),
  sessions: el('session-list'),
  sessionsEmpty: el('session-empty'),
  sessionSearch: el('session-search'),
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
  editPiSettings: el('edit-pi-settings'),
  contextMeter: el('context-meter'),
  contextMeterFill: el('context-meter-fill'),
  contextMeterLabel: el('context-meter-label'),
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
  promptList: el('prompt-list'),
  resourceDiagnostics: el('resource-diagnostics'),
  newPromptTemplate: el('new-prompt-template'),
  reloadResources: el('reload-pi-resources'),
  deliveryMode: el('delivery-mode'),
  pinActiveFile: el('pin-active-file'),
};

function post(type, payload = {}) {
  vscode.postMessage({ type, ...payload });
}

function persistWebviewState() {
  vscode.setState({ drafts: state.drafts, promptHistory: state.promptHistory });
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
  ui.editPiSettings.disabled = !state.hasWorkspace || state.busy;
  ui.pinActiveFile.disabled = !state.hasWorkspace;
  ui.newPromptTemplate.disabled = !state.hasWorkspace || state.busy;
  ui.reloadResources.disabled = !state.hasSession || state.busy;
  ui.toolsToggle.disabled = !state.hasSession || state.busy || state.tools.length === 0;
  ui.skillsToggle.disabled = !state.hasSession || (state.skills.length === 0 && state.prompts.length === 0);
  ui.toolsPopover.querySelectorAll('input').forEach((input) => { input.disabled = state.busy; });
  ui.skillsPopover.querySelectorAll('.skill-auto-toggle').forEach((input) => {
    const skill = state.skills.find((item) => item.name === input.getAttribute('data-skill-name'));
    input.disabled = state.busy || !skill?.canEnableAutoInvoke;
  });
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
  ui.sessionsEmpty.hidden = sessions.length > 0;
  ui.sessionsEmpty.textContent = state.sessionQuery ? 'No sessions match this search.' : 'No saved sessions yet.';

  for (const session of sessions) {
    const entry = document.createElement('div');
    entry.className = 'session-entry';
    const row = document.createElement('button');
    row.type = 'button';
    row.className = `session-row${session.path === state.sessionPath ? ' active' : ''}`;
    row.title = session.title;
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
    row.addEventListener('click', () => {
      closeHistory();
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
    rename.addEventListener('click', () => post('renameSession', { path: session.path, currentName: session.title }));
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'session-action danger-action';
    remove.textContent = 'Delete';
    remove.disabled = session.path === state.sessionPath;
    remove.title = remove.disabled ? 'Switch to another session before deleting this one' : 'Permanently delete this session';
    remove.addEventListener('click', () => post('deleteSession', { path: session.path, title: session.title }));
    actions.append(pin, changeColor, rename, remove);
    entry.append(actions);
    entry.draggable = true;
    entry.addEventListener('dragstart', (event) => event.dataTransfer?.setData('text/pi-session', session.path));
    entry.addEventListener('dragover', (event) => event.preventDefault());
    entry.addEventListener('drop', (event) => {
      event.preventDefault();
      const fromPath = event.dataTransfer?.getData('text/pi-session');
      if (!fromPath || fromPath === session.path) return;
      const reordered = [...state.sessions];
      const fromIndex = reordered.findIndex((item) => item.path === fromPath);
      const toIndex = reordered.findIndex((item) => item.path === session.path);
      if (fromIndex < 0 || toIndex < 0) return;
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
    ui.railSessions.append(shortcut);
  }
}

function contextLabels(context) {
  return String(context || '').split('\n').map((line) => line.trim()).filter((line) => line.startsWith('@'));
}

function appendInlineText(parent, text) {
  const pieces = String(text).split(/(`[^`]+`)/g);
  for (const piece of pieces) {
    if (piece.startsWith('`') && piece.endsWith('`') && piece.length > 2) {
      const code = document.createElement('code');
      code.textContent = piece.slice(1, -1);
      parent.append(code);
    } else {
      parent.append(document.createTextNode(piece));
    }
  }
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

function renderMarkdown(container, text) {
  container.replaceChildren();
  const lines = String(text || '').split('\n');
  let paragraph = [];
  let list = undefined;
  let codeLines = undefined;
  let language = '';

  const flushParagraph = () => {
    if (!paragraph.length) return;
    const p = document.createElement('p');
    appendInlineText(p, paragraph.join('\n'));
    container.append(p);
    paragraph = [];
  };
  const flushList = () => {
    if (list) container.append(list);
    list = undefined;
  };

  for (const line of lines) {
    const fence = line.match(/^\s*```\s*([\w.+-]*)/);
    if (fence) {
      flushParagraph();
      flushList();
      if (!codeLines) {
        codeLines = [];
        language = fence[1];
      } else {
        container.append(createCodeBlock(codeLines.join('\n'), language));
        codeLines = undefined;
        language = '';
      }
      continue;
    }
    if (codeLines) {
      codeLines.push(line);
      continue;
    }

    if (!line.trim()) {
      flushParagraph();
      flushList();
      continue;
    }

    const heading = line.match(/^(#{1,3})\s+(.+)$/);
    if (heading) {
      flushParagraph();
      flushList();
      const h = document.createElement(heading[1].length === 1 ? 'h2' : 'h3');
      appendInlineText(h, heading[2]);
      container.append(h);
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
      appendInlineText(item, (unordered || ordered)[1]);
      list.append(item);
      continue;
    }
    flushList();
    paragraph.push(line);
  }

  if (codeLines) {
    container.append(createCodeBlock(codeLines.join('\n'), language));
  }
  flushParagraph();
  flushList();
}

function renderMessages(shouldFollow = true) {
  const nearBottom = ui.messageArea.scrollHeight - ui.messageArea.scrollTop - ui.messageArea.clientHeight < 80;
  ui.messageList.replaceChildren();
  for (let messageIndex = 0; messageIndex < state.messages.length; messageIndex += 1) {
    const message = state.messages[messageIndex];
    if (message.role === 'tool' && message.node instanceof HTMLElement) {
      message.node.dataset.messageIndex = String(messageIndex);
      ui.messageList.append(message.node);
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

    const body = document.createElement('div');
    body.className = 'message-content';
    if (message.role === 'assistant' && !message.streaming) renderMarkdown(body, message.text);
    else body.textContent = message.text;
    row.append(body);
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
      const source = message.entryId ? ` source="${message.entryId}"` : '';
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
    row.append(actions);
    ui.messageList.append(row);
  }

  renderBookmarks();
  updateChatSearch();
  ui.empty.hidden = state.messages.length > 0;
  if (shouldFollow && nearBottom) ui.messageArea.scrollTop = ui.messageArea.scrollHeight;
  updateControls();
}

function updateChatSearch(moveToCurrent = false) {
  const query = state.chatSearch.trim().toLocaleLowerCase();
  state.chatSearchHits = [];
  if (query) {
    state.messages.forEach((message, index) => {
      const content = message.role === 'tool' && message.node instanceof HTMLElement
        ? message.node.textContent || ''
        : `${message.text || ''}\n${message.context || ''}`;
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
    row?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }
}

function stepChatSearch(direction) {
  if (!state.chatSearchHits.length) return;
  state.chatSearchIndex = (state.chatSearchIndex + direction + state.chatSearchHits.length) % state.chatSearchHits.length;
  updateChatSearch(true);
}

function renderAttachments() {
  ui.attachments.replaceChildren();
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
    chip.append(name, remove);
    ui.attachments.append(chip);
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

function insertCommand(command) {
  const existing = ui.prompt.value.trim();
  ui.prompt.value = existing ? `${command} ${existing}` : `${command} `;
  ui.prompt.focus();
  ui.prompt.setSelectionRange(ui.prompt.value.length, ui.prompt.value.length);
  ui.prompt.style.height = 'auto';
  ui.prompt.style.height = `${Math.min(ui.prompt.scrollHeight, 170)}px`;
  ui.skillsPopover.hidden = true;
  ui.skillsToggle.setAttribute('aria-expanded', 'false');
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
  ui.skillList.replaceChildren();
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
  state.extensionRequest = undefined;
  ui.dialogLayer.hidden = true;
  post('extensionUiResponse', { requestId: request.requestId, value });
}

function showExtensionDialog(data) {
  state.extensionRequest = { requestId: data.requestId, kind: data.kind };
  ui.dialogTitle.textContent = data.title || 'Pi extension';
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

function beginAssistantMessage() {
  state.messages.push({ role: 'assistant', text: '', streaming: true });
  state.streamIndex = state.messages.length - 1;
  renderMessages();
}

function applySnapshot(data) {
  const nextSessionPath = data.sessionFile || '';
  if (nextSessionPath !== state.sessionPath) {
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
  const lastAssistant = messages.findLastIndex((message) => message.role === 'assistant');
  if (lastAssistant >= 0) messages.splice(lastAssistant, 0, ...toolMessages);
  else messages.push(...toolMessages);
  state.messages = messages;
  state.busy = Boolean(data.busy);
  state.contextUsage = data.contextUsage;
  renderContextUsage();
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
    case 'sessions':
      state.sessions = Array.isArray(data.sessions) ? data.sessions : [];
      renderSessions();
      break;
    case 'snapshot':
      applySnapshot(data);
      break;
    case 'options':
      renderModelChoices(data);
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
    case 'activity':
      setBusy(true, data.message || 'Pi is working');
      break;
    case 'tool-start': {
      const detail = document.createElement('details');
      detail.className = 'tool-card';
      detail.open = false;
      detail.dataset.toolId = String(data.id || '');
      const summary = document.createElement('summary');
      summary.textContent = `Running ${data.name || 'tool'}`;
      const output = document.createElement('pre');
      output.className = 'tool-output';
      output.textContent = JSON.stringify(data.args || {}, null, 2);
      detail.append(summary, output);
      const toolMessage = { role: 'tool', node: detail };
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
      const card = [...ui.messageList.querySelectorAll('.tool-card')].find((item) => item.dataset.toolId === String(data.id || ''));
      if (card) {
        const output = card.querySelector('.tool-output');
        const result = data.result;
        const text = typeof result === 'string' ? result : JSON.stringify(result ?? '', null, 2);
        if (output) output.textContent = text.slice(-12000);
        if (data.type === 'tool-end') {
          card.classList.toggle('tool-error', Boolean(data.isError));
          card.querySelector('summary').textContent = `${data.isError ? 'Failed' : 'Finished'} ${data.name || 'tool'}`;
          card.open = Boolean(data.isError);
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
  if (open) post('listSessions', { query: state.sessionQuery });
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
el('refresh-sessions').addEventListener('click', () => post('listSessions', { query: state.sessionQuery }));
el('export-session').addEventListener('click', () => {
  if (state.hasSession) post('exportSession');
  else showNotice('Start or open a session before exporting.');
});
ui.sessionSearch.addEventListener('input', () => {
  state.sessionQuery = ui.sessionSearch.value;
  clearTimeout(state.sessionSearchTimer);
  state.sessionSearchTimer = setTimeout(() => post('listSessions', { query: state.sessionQuery }), 220);
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
  if (event.key === 'Escape') finishExtensionDialog(undefined);
  else if (event.key === 'Enter' && !event.shiftKey && state.extensionRequest?.kind === 'input') {
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
ui.editModelsConfig.addEventListener('click', () => post('openModelsConfig'));
ui.editPiSettings.addEventListener('click', () => post('openPiSettings'));
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

post('ready');
