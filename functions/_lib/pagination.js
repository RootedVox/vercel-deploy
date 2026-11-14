// Keep old page-number URLs working while new clients seek from the last visible row.
const timestamp = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/;
const idPattern = /^(?:\d+|[a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12})$/i;

export function applyPage(params, url, page, limit, direction = 'desc') {
  params.set('order', `created_at.${direction},id.${direction}`);
  params.set('limit', String(limit + 1));
  const cursor = url.searchParams.get('cursor');
  if (!cursor) {
    params.set('offset', String(page * limit));
    return true;
  }
  const [time, id, extra] = cursor.split('|');
  if (extra !== undefined || !timestamp.test(time) || !idPattern.test(id || '')) return false;
  const comparison = direction === 'asc' ? 'gt' : 'lt';
  params.set('or', `(created_at.${comparison}.${time},and(created_at.eq.${time},id.${comparison}.${id}))`);
  return true;
}

export function pageResult(rows, limit, key) {
  const items = rows.slice(0, limit);
  const last = items.at(-1);
  const hasMore = rows.length > limit;
  return { [key]: items, hasMore, nextCursor: hasMore ? `${last.created_at}|${last.id}` : null };
}
