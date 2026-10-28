(function exposeDraftStore(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.PiChatDraftStore = api;
})(globalThis, () => {
  const MAX_DRAFTS_PER_SESSION = 20;
  const MAX_SESSIONS = 10_000;
  const MAX_STORAGE_CHARS = 16 * 1024 * 1024;
  const MAX_ATTACHMENTS = 8;
  const MAX_CONTEXT_CHARS = 100_000;
  const MAX_IMAGE_DATA_CHARS = 7_000_000;
  const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
  const MAX_TOTAL_IMAGE_BYTES = 25 * 1024 * 1024;
  const ALLOWED_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

  function createId() {
    const random = Math.random().toString(36).slice(2, 12);
    return `draft-${Date.now().toString(36)}-${random}`;
  }

  function cleanLabel(value, maxLength) {
    return String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, '').slice(0, maxLength);
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

  function normalizeAttachment(candidate, index, imageBudget) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return undefined;
    const label = cleanLabel(candidate.label, 256);
    const path = cleanLabel(candidate.path, 4096);
    const context = typeof candidate.context === 'string' ? candidate.context.slice(0, MAX_CONTEXT_CHARS) : '';
    const attachment = {
      id: cleanLabel(candidate.id, 128) || `draft-attachment-${index + 1}`,
      label: label || `Attachment ${index + 1}`,
      path,
      context,
    };
    const image = candidate.image;
    if (image && typeof image === 'object' && !Array.isArray(image)) {
      const data = image.data;
      const mimeType = image.mimeType;
      if (typeof data === 'string' && data.length <= MAX_IMAGE_DATA_CHARS
        && isValidBase64ImageData(data) && typeof mimeType === 'string' && ALLOWED_IMAGE_TYPES.has(mimeType)) {
        const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0;
        const bytes = Math.floor(data.length * 3 / 4) - padding;
        if (bytes > 0 && bytes <= MAX_IMAGE_BYTES && imageBudget.total + bytes <= MAX_TOTAL_IMAGE_BYTES) {
          attachment.image = { data, mimeType };
          imageBudget.total += bytes;
        }
      }
    }
    if (!attachment.path && !attachment.context && !attachment.image) return undefined;
    return attachment;
  }

  function normalizeDraft(candidate) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return undefined;
    const text = typeof candidate.text === 'string' ? candidate.text.slice(0, 100_000) : '';
    const imageBudget = { total: 0 };
    const attachments = [];
    if (Array.isArray(candidate.attachments)) {
      for (const item of candidate.attachments.slice(0, MAX_ATTACHMENTS)) {
        const attachment = normalizeAttachment(item, attachments.length, imageBudget);
        if (attachment) attachments.push(attachment);
      }
    }
    if (!text.trim() && !attachments.length) return undefined;
    const createdAt = Number(candidate.createdAt);
    return {
      id: cleanLabel(candidate.id, 128) || createId(),
      text,
      attachments,
      createdAt: Number.isFinite(createdAt) && createdAt > 0 ? Math.min(createdAt, Date.now()) : Date.now(),
    };
  }

  function estimateDraftSize(draft) {
    const textSize = (value) => value.length * 3;
    return 160 + textSize(draft.text) + draft.attachments.reduce((total, attachment) => total
      + textSize(attachment.id) + textSize(attachment.label) + textSize(attachment.path) + textSize(attachment.context)
      + (attachment.image?.data.length || 0) + textSize(attachment.image?.mimeType || ''), 0);
  }

  function estimateStoreSize(store) {
    return Object.entries(store).reduce((total, [key, drafts]) => total + key.length + 16
      + (Array.isArray(drafts) ? drafts.reduce((sum, draft) => sum + estimateDraftSize(draft), 0) : 0), 0);
  }

  function validSessionKey(key) {
    return typeof key === 'string' && key.length > 0 && key.length <= 4096 && !/[\u0000-\u001f\u007f]/.test(key);
  }

  function copyStore(store) {
    const copy = Object.create(null);
    for (const [key, drafts] of Object.entries(store || {})) {
      if (validSessionKey(key) && Array.isArray(drafts) && drafts.length) copy[key] = [...drafts];
    }
    return copy;
  }

  function normalizeStore(value) {
    const store = Object.create(null);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return store;
    const entries = Object.entries(value).slice(-MAX_SESSIONS).reverse();
    for (const [key, candidates] of entries) {
      if (!validSessionKey(key) || !Array.isArray(candidates)) continue;
      const drafts = candidates.slice(0, MAX_DRAFTS_PER_SESSION)
        .map(normalizeDraft).filter(Boolean);
      if (!drafts.length) continue;
      store[key] = drafts;
      if (estimateStoreSize(store) > MAX_STORAGE_CHARS) delete store[key];
    }
    return store;
  }

  function makeDraft(text, attachments) {
    return normalizeDraft({ id: createId(), text, attachments, createdAt: Date.now() });
  }

  function getDrafts(store, key) {
    return Array.isArray(store?.[key]) ? store[key] : [];
  }

  function saveDraft(store, key, draft) {
    if (!validSessionKey(key) || !draft) return { ok: false, reason: 'invalid' };
    const normalized = normalizeDraft(draft);
    if (!normalized) return { ok: false, reason: 'empty' };
    const next = copyStore(store);
    if (!Object.hasOwn(next, key) && Object.keys(next).length >= MAX_SESSIONS) return { ok: false, reason: 'sessions' };
    const existing = getDrafts(next, key);
    delete next[key];
    next[key] = [normalized, ...existing].slice(0, MAX_DRAFTS_PER_SESSION);
    if (estimateStoreSize(next) > MAX_STORAGE_CHARS) return { ok: false, reason: 'storage' };
    return { ok: true, store: next, draft: normalized };
  }

  function restoreDraft(store, key, index, currentDraft) {
    const existing = getDrafts(store, key);
    if (!Number.isInteger(index) || index < 0 || index >= existing.length) return { ok: false, reason: 'missing' };
    const selected = existing[index];
    const current = normalizeDraft(currentDraft);
    const next = copyStore(store);
    const drafts = [...existing];
    if (current) drafts[index] = current;
    else drafts.splice(index, 1);
    if (drafts.length) next[key] = drafts;
    else delete next[key];
    if (estimateStoreSize(next) > MAX_STORAGE_CHARS) return { ok: false, reason: 'storage' };
    return { ok: true, store: next, draft: selected, swapped: Boolean(current) };
  }

  function deleteDraft(store, key, index) {
    const existing = getDrafts(store, key);
    if (!Number.isInteger(index) || index < 0 || index >= existing.length) return { ok: false, reason: 'missing' };
    const next = copyStore(store);
    const drafts = [...existing];
    const [draft] = drafts.splice(index, 1);
    if (drafts.length) next[key] = drafts;
    else delete next[key];
    return { ok: true, store: next, draft, index };
  }

  function undoDelete(store, key, draft, index) {
    if (!validSessionKey(key)) return { ok: false, reason: 'invalid' };
    const normalized = normalizeDraft(draft);
    if (!normalized) return { ok: false, reason: 'invalid' };
    const next = copyStore(store);
    const drafts = [...getDrafts(next, key)];
    drafts.splice(Math.max(0, Math.min(Number(index) || 0, drafts.length)), 0, normalized);
    next[key] = drafts.slice(0, MAX_DRAFTS_PER_SESSION);
    if (estimateStoreSize(next) > MAX_STORAGE_CHARS) return { ok: false, reason: 'storage' };
    return { ok: true, store: next };
  }

  return {
    MAX_DRAFTS_PER_SESSION,
    normalizeStore,
    makeDraft,
    getDrafts,
    saveDraft,
    restoreDraft,
    deleteDraft,
    undoDelete,
  };
});
