export type SessionSortOrder = 'manual' | 'updated' | 'name';

export declare function sortSessionItems<T extends Record<string, unknown>>(
  items: T[],
  orderedPaths: string[],
  sortOrder: SessionSortOrder,
): T[];
