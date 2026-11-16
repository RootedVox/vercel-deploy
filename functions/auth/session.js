import { getConfig } from '../_lib/config.js';
import { cookieNames, json, methodNotAllowed, parseCookies } from '../_lib/http.js';
import { withDeadline } from '../_lib/fetch-timeout.js';
import { resolveProfileNickname } from '../_lib/official-profile.js';
import { getBusinessSession } from '../_lib/session.js';
import { requestBusinessData } from '../_lib/supabase.js';

// The session keeps the name Keycloak gave at sign-in, but a nickname changed on the site
// lives in business_users, so pages showed the old name until /api/profile answered.
// Answer with the current nickname, resolved exactly as /api/profile does. The read uses
// the same Functions request; if it is slow or fails, the sign-in name is used rather
// than failing the session check.
const NICKNAME_DEADLINE_MS = 1500;
async function currentNickname(env, session) {
  const fallback = session.display_name || session.email?.split('@')[0] || '校园用户';
  try {
    const rows = await withDeadline(() => requestBusinessData(env, session,
      `business_users?user_id=eq.${encodeURIComponent(session.user_id)}&select=nickname,display_name&limit=1`
    ), NICKNAME_DEADLINE_MS);
    const row = rows?.[0] || {};
    return resolveProfileNickname(session.user_id, row.nickname, row.display_name || fallback);
  } catch {
    return resolveProfileNickname(session.user_id, null, fallback);
  }
}

export async function onRequestGet({ request, env }) {
  const names = cookieNames(request);
  if (!parseCookies(request)[names.session]) return json({ authenticated: false }, 401);
  let config;
  try { config = getConfig(env); } catch { return json({ authenticated: false, error: 'configuration_error' }, 503); }
  try {
    const result = await getBusinessSession(request, env, config, true);
    const headers = result.setCookie ? { 'Set-Cookie': result.setCookie } : {};
    if (!result.session) return json({ authenticated: false }, 401, headers);
    const session = result.session;
    const name = await currentNickname(env, session);
    return json({
      authenticated: true,
      user: {
        id: session.user_id,
        issuer: session.identity_provider,
        subject: session.identity_subject,
        email: session.email,
        name,
        checker: session.is_checker === true
      },
      assurance: {
        acr: session.acr,
        amr: session.amr || [],
        authTime: session.auth_time
      },
      expiresAt: session.expires_at
    }, 200, headers);
  } catch {
    return json({ authenticated: false, error: 'session_unavailable' }, 503);
  }
}

export function onRequest() {
  return methodNotAllowed('GET');
}
