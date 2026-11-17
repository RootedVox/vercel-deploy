import { withDeadline } from './fetch-timeout.js';
import { base64UrlEncode, utf8 } from './crypto.js';

const keyCache = new Map();

function required(env, name) {
  const value = String(env[name] || '').trim();
  if (!value) throw new Error(`missing_config:${name}`);
  return value;
}

function publicSupabaseConfig(env) {
  const url = required(env, 'BUSINESS_SUPABASE_URL').replace(/\/$/, '');
  const publishableKey = required(env, 'BUSINESS_SUPABASE_PUBLISHABLE_KEY');
  return { url, publishableKey };
}

function supabaseConfig(env) {
  const { url, publishableKey } = publicSupabaseConfig(env);
  const rawJwk = required(env, 'BUSINESS_SUPABASE_SIGNING_JWK');
  let jwk;
  try { jwk = JSON.parse(rawJwk); } catch { throw new Error('invalid_config:BUSINESS_SUPABASE_SIGNING_JWK'); }
  if (jwk.kty !== 'EC' || jwk.crv !== 'P-256' || !jwk.d || !jwk.kid) {
    throw new Error('invalid_config:BUSINESS_SUPABASE_SIGNING_JWK');
  }
  return { url, publishableKey, jwk };
}

async function signingKey(jwk) {
  const cacheKey = `${jwk.kid}:${jwk.x}:${jwk.y}`;
  if (!keyCache.has(cacheKey)) {
    keyCache.set(cacheKey, crypto.subtle.importKey(
      'jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']
    ));
  }
  return keyCache.get(cacheKey);
}

export async function identityUserId(issuer, subject) {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', utf8(`${issuer}\u0000${subject}`)));
  const bytes = digest.slice(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map(value => value.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export async function createDatabaseToken(env, identity, { url, jwk } = supabaseConfig(env)) {
  const now = Math.floor(Date.now() / 1000);
  const header = base64UrlEncode(utf8(JSON.stringify({ alg: 'ES256', kid: jwk.kid, typ: 'JWT' })));
  const payload = base64UrlEncode(utf8(JSON.stringify({
    iss: `${url}/auth/v1`,
    sub: identity.user_id,
    aud: 'authenticated',
    role: 'authenticated',
    iat: now,
    exp: now + 300,
    email: identity.email || undefined,
    provider_iss: identity.identity_provider,
    provider_sub: identity.identity_subject
  })));
  const input = `${header}.${payload}`;
  const signature = new Uint8Array(await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' }, await signingKey(jwk), utf8(input)
  ));
  return `${input}.${base64UrlEncode(signature)}`;
}

// Session objects are created for one inbound request by the session store.
const requestTokens = new WeakMap();
function requestToken(env, session) {
  if (!requestTokens.has(session)) requestTokens.set(session, createDatabaseToken(env, session));
  return requestTokens.get(session);
}

// Headers for the server-only secret key (session store, moderation queue, anonymous
// media). Legacy service_role JWTs need Authorization; sb_secret keys use apikey alone.
export function serviceKeyHeaders(env, headers = {}) {
  const key = String(env.AUTH_STORE_SUPABASE_SECRET_KEY || '').trim();
  if (!key) return null;
  return key.startsWith('sb_secret_') ? { apikey: key, ...headers } : { apikey: key, Authorization: `Bearer ${key}`, ...headers };
}

async function parseBody(response) {
  if (response.status === 204) return null;
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

async function databaseError(response, route, method) {
  const body = await response.text().catch(() => '');
  let code, storageStatus, reason;
  try {
    const parsed = JSON.parse(body);
    code = parsed?.code || parsed?.error;
    // Storage often answers HTTP 400 and puts the real status and reason in the body.
    storageStatus = Number(parsed?.statusCode) || undefined;
    reason = parsed?.message || parsed?.error;
  } catch {}
  const detail = body.replace(/\s+/g, ' ').slice(0, 200);
  if (route) {
    // Never log the query string: it carries user ids and filters.
    console.error(`[supabase] ${method || 'GET'} ${route.split('?')[0]} -> ${response.status} ${detail}`);
  }
  const error = new Error(route ? `business_store_failure:${response.status}:${detail}` : 'business_store_failure');
  error.code = code;
  error.status = response.status;
  error.storageStatus = storageStatus;
  error.reason = reason;
  return error;
}

export function isMissingRpc(error) {
  return error?.status === 404 && error.code === 'PGRST202';
}

async function requestSupabase(env, session, route, init = {}) {
  const { url, publishableKey } = publicSupabaseConfig(env);
  const token = await requestToken(env, session);
  return withDeadline(async signal => {
    const response = await fetch(`${url}/${route}`, {
      ...init,
      signal: init.signal ? AbortSignal.any([signal, init.signal]) : signal,
      headers: {
        apikey: publishableKey,
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...init.headers
      }
    });
    if (!response.ok) throw await databaseError(response, route, init.method);
    return parseBody(response);
  });
}

export function requestBusinessData(env, session, path, init = {}) {
  return requestSupabase(env, session, `rest/v1/${path}`, init);
}

export async function requestPublicData(env, path, init = {}, timeoutMs) {
  const { url, publishableKey } = publicSupabaseConfig(env);
  return withDeadline(async signal => {
    const response = await fetch(`${url}/rest/v1/${path}`, {
      ...init, signal,
      headers: {
        apikey: publishableKey,
        'Content-Type': 'application/json',
        ...init.headers
      }
    });
    if (!response.ok) throw await databaseError(response);
    return parseBody(response);
  }, timeoutMs);
}

export async function uploadBusinessObject(env, session, bucket, path, file, upsert = false, reuseExisting = false) {
  const { url, publishableKey } = publicSupabaseConfig(env);
  const token = await requestToken(env, session);
  await withDeadline(async signal => {
    const result = await fetch(`${url}/storage/v1/object/${bucket}/${path}`, {
      signal, method: 'POST',
      headers: {
        apikey: publishableKey, Authorization: `Bearer ${token}`,
        'Content-Type': file.type, 'x-upsert': upsert ? 'true' : 'false'
      },
      body: file
    });
    const text = await result.text();
    let error;
    try { error = JSON.parse(text); } catch {}
    if (result.ok) return;
    const code = error?.code || error?.error;
    const duplicate = ['Duplicate', 'ResourceAlreadyExists', 'KeyAlreadyExists'].includes(code)
      || ['The resource already exists', 'Asset already exists'].includes(error?.message);
    if (reuseExisting && (result.status === 400 || result.status === 409) && duplicate) return;
    const failure = new Error('upload_failed');
    failure.code = code;
    failure.status = result.status;
    failure.storageStatus = Number(error?.statusCode) || undefined;
    failure.reason = error?.message || error?.error;
    throw failure;
  });
  return `${url}/storage/v1/object/public/${bucket}/${path}`;
}

export async function resolveIdentity(env, claims) {
  const userId = await identityUserId(claims.issuer, claims.subject);
  const session = {
    user_id: userId,
    identity_provider: claims.issuer,
    identity_subject: claims.subject,
    email: claims.email,
    display_name: claims.displayName
  };
  const rows = await requestBusinessData(env, session, 'business_users?on_conflict=user_id&select=user_id,is_checker', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
    body: JSON.stringify({
      user_id: userId,
      identity_provider: claims.issuer,
      identity_subject: claims.subject,
      email: claims.email,
      display_name: claims.displayName,
      last_login_at: new Date().toISOString()
    })
  });
  if (!Array.isArray(rows) || rows.length !== 1) throw new Error('identity_mapping_failure');
  return { ...session, userId, is_checker: rows[0].is_checker === true };
}

// The signed-in account's own business_users row, or undefined when it has none.
export async function readOwnProfile(env, session, columns, init) {
  const rows = await requestBusinessData(env, session,
    `business_users?user_id=eq.${encodeURIComponent(session.user_id)}&select=${columns}&limit=1`, init
  );
  return rows?.[0];
}

export async function refreshChecker(env, session) {
  return (await readOwnProfile(env, session, 'is_checker'))?.is_checker === true;
}

export function listAvatarObjects(env, session, offset = 0) {
  return requestSupabase(env, session, 'storage/v1/object/list/avatars', {
    method: 'POST', body: JSON.stringify({ prefix: 'business/', search: session.user_id + '.', limit: 100, offset, sortBy: { column: 'name', order: 'asc' } })
  });
}
export function deleteAvatarObjects(env, session, paths) {
  return requestSupabase(env, session, 'storage/v1/object/avatars', {
    method: 'DELETE', body: JSON.stringify({ prefixes: paths })
  });
}
