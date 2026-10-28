function sortSessionItems(items, orderedPaths, sortOrder) {
  const orderIndex = new Map((Array.isArray(orderedPaths) ? orderedPaths : []).map((sessionPath, index) => [sessionPath, index]));
  const selectedOrder = sortOrder === 'updated' || sortOrder === 'name' ? sortOrder : 'manual';
  const modifiedTime = (item) => {
    const value = Number(item.modified ?? 0);
    return Number.isFinite(value) ? value : 0;
  };
  const title = (item) => String(item.title ?? '');
  const sessionPath = (item) => String(item.path ?? '');

  return [...items].sort((a, b) => {
    const pinOrder = Number(b.pinned === true) - Number(a.pinned === true);
    if (pinOrder) return pinOrder;

    const titleOrder = title(a).localeCompare(title(b), undefined, { sensitivity: 'base', numeric: true });
    const pathOrder = sessionPath(a).localeCompare(sessionPath(b));
    if (selectedOrder === 'name') return titleOrder || pathOrder;

    const recentOrder = modifiedTime(b) - modifiedTime(a);
    if (selectedOrder === 'updated') return recentOrder || titleOrder || pathOrder;

    const manualOrder = (orderIndex.get(sessionPath(a)) ?? Number.MAX_SAFE_INTEGER)
      - (orderIndex.get(sessionPath(b)) ?? Number.MAX_SAFE_INTEGER);
    return manualOrder || recentOrder || titleOrder || pathOrder;
  });
}

module.exports = { sortSessionItems };
