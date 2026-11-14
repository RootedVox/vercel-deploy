// Use the current deployment first. Preview hosts stay on their own origin.
const PRODUCTION_HOSTS = ['https://rv.celestivast.com', 'https://rv-vc.celestivast.com'];
const PRIMARY_API = location.origin;
const BACKUP_API = PRODUCTION_HOSTS.includes(PRIMARY_API)
  ? PRODUCTION_HOSTS.find(host => host !== PRIMARY_API)
  : PRIMARY_API;
let fallbackUntil = 0;
async function request(path, options = {}) {
  if (!/^\/(api|auth)\//.test(path)) throw new Error('invalid_api_path');
  const method = (options.method || 'GET').toUpperCase();
  const read = method === 'GET' || method === 'HEAD';
  const init = { credentials: 'include', ...options, method };
  if (options.signal?.aborted) throw options.signal.reason || new DOMException('Aborted', 'AbortError');
  async function attempt(origin, timeout) {
    const controller = new AbortController();
    const abort = () => controller.abort(options.signal.reason);
    if (options.signal?.aborted) throw options.signal.reason;
    options.signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const response = await fetch(origin + path, { ...init, signal: controller.signal });
      const body = response.body ? await response.arrayBuffer() : null;
      return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', abort);
    }
  }
  const timeout = read ? 20000 : 60000;
  const deadline = Date.now() + timeout;
  const backup = () => attempt(BACKUP_API, Math.max(1, deadline - Date.now()));
  if (Date.now() < fallbackUntil) return backup();
  let response;
  try {
    response = await attempt(PRIMARY_API, read && PRIMARY_API !== BACKUP_API ? timeout / 2 : timeout);
  } catch (error) {
    if (options.signal?.aborted || !read || PRIMARY_API === BACKUP_API) throw error;
    return backup();
  }
  if (PRIMARY_API !== BACKUP_API && response.status === 429) fallbackUntil = Date.now() + 60000;
  if (PRIMARY_API !== BACKUP_API && (response.status === 429 || (read && response.status >= 500))) return backup();
  return response;
}
window.request = request;
