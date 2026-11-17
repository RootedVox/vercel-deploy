import { getConfig } from '../_lib/config.js';
import { cookieNames, json, methodNotAllowed, parseCookies } from '../_lib/http.js';
import { withDeadline } from '../_lib/fetch-timeout.js';
import { profileNickname } from '../_lib/official-profile.js';
import { getBusinessSession } from '../_lib/session.js';
import { readOwnProfile, requestBusinessData } from '../_lib/supabase.js';

// The session keeps the name Keycloak gave at sign-in, but a nickname changed on the site
// lives in business_users, so pages showed the old name until /api/profile answered.
// Answer with the current nickname, resolved exactly as /api/profile does. The read uses
// the same Functions request; if it is slow or fails, the sign-in name is used rather
// than failing the session check.
// The same row read also returns the avatar, so the forum page needs no separate
// /api/profile request (one Functions request less per signed-in page view).
// avatarUrl is left out when the read failed, telling the page to ask /api/profile.
const NICKNAME_DEADLINE_MS = 1500;
async function currentProfile(env, session) {
  try {
    const row = await withDeadline(signal => readOwnProfile(env, session, 'nickname,display_name,avatar_url', { signal }),
      NICKNAME_DEADLINE_MS) || {};
    return { name: profileNickname(session, row), avatarUrl: row.avatar_url || null };
  } catch {
    return { name: profileNickname(session) };
  }
}

// The forum page's unread dot, read alongside the profile so it costs no extra
// Functions request. Left out on failure, and the page then asks /api/notifications.
async function unreadNotifications(env, session) {
  const params = new URLSearchParams({ user_id: `eq.${session.user_id}`, read: 'eq.false', select: 'id', limit: '1' });
  try {
    const rows = await withDeadline(signal => requestBusinessData(env, session,
      `business_notifications?${params}`, { signal }
    ), NICKNAME_DEADLINE_MS);
    return Array.isArray(rows) ? { hasUnread: rows.length > 0 } : {};
  } catch {
    return {};
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
    const [profile, unread] = await Promise.all([currentProfile(env, session), unreadNotifications(env, session)]);
    return json({
      authenticated: true,
      user: {
        id: session.user_id,
        issuer: session.identity_provider,
        subject: session.identity_subject,
        email: session.email,
        ...profile,
        ...unread,
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
