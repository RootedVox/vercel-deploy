import { withDeadline } from './fetch-timeout.js';
import { serviceKeyHeaders } from './supabase.js';
// Server-only shared session store. Never use a browser publishable key here.
async function call(env, operation, args = {}) {
  const url = String(env.BUSINESS_SUPABASE_URL || '').replace(/\/$/, '');
  const headers = serviceKeyHeaders(env, { 'Content-Type': 'application/json' });
  if (!url.startsWith('https://') || !headers) throw new Error('auth_store_not_configured');
  return withDeadline(async signal => {
    const response = await fetch(`${url}/rest/v1/rpc/isa_auth_store`, {
      method: 'POST', headers, signal, body: JSON.stringify({ operation, args })
    });
    if (!response.ok) throw new Error(`auth_store_unavailable:${response.status}`);
    return response.json();
  });
}
export const createTransaction = (env, value) => call(env, 'create_transaction', value);
export const pruneAuthState = env => call(env, 'prune');
export const consumeTransaction = (env, state, binding) => call(env, 'consume_transaction', { state, binding });
export const createSession = (env, value) => call(env, 'create_session', value);
export const readSession = (env, hash) => call(env, 'read_session', { hash });
export const rotateSession = (env, previous, next, expires, nonce) => call(env, 'stage_rotation', { previous, next, expires, nonce });
export const revokeSession = (env, hash) => call(env, 'revoke_session', { hash });
