import { methodNotAllowed, redirect } from '../_lib/http.js';

// The provider sends the browser here after RP-initiated logout. POST /auth/logout has
// already revoked the session and cleared its cookie before the browser left, so this
// GET only redirects. It must not end a session itself: any other site could link here
// and sign a visitor out.
export function onRequestGet() {
  return redirect('https://rv.celestivast.com/main', 302);
}

export function onRequest() {
  return methodNotAllowed('GET');
}
