export type DraftAttachment = {
  id: string;
  label: string;
  path: string;
  context: string;
  image?: { data: string; mimeType: string };
};

export type SavedDraft = {
  id: string;
  text: string;
  attachments: DraftAttachment[];
  createdAt: number;
};

export type DraftStore = Record<string, SavedDraft[]>;

export const MAX_DRAFTS_PER_SESSION: number;
export function normalizeStore(value: unknown): DraftStore;
export function makeDraft(text: unknown, attachments: unknown): SavedDraft | undefined;
export function getDrafts(store: DraftStore, key: string): SavedDraft[];
export function saveDraft(store: DraftStore, key: string, draft: unknown): { ok: boolean; reason?: string; store?: DraftStore };
export function restoreDraft(store: DraftStore, key: string, index: number, currentDraft: unknown): { ok: boolean; reason?: string; store?: DraftStore; draft?: SavedDraft; swapped?: boolean };
export function deleteDraft(store: DraftStore, key: string, index: number): { ok: boolean; reason?: string; store?: DraftStore; draft?: SavedDraft; index?: number };
export function undoDelete(store: DraftStore, key: string, draft: unknown, index: number): { ok: boolean; reason?: string; store?: DraftStore };
