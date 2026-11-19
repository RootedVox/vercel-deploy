import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { getBusinessSession, destroyBusinessSession } from '../functions/_lib/session.js';
import { sha256Base64Url } from '../functions/_lib/crypto.js';

test('a lost renewal response can be retried until original expiry, then confirmed exactly once', async t => {
  const start = Date.parse('2026-01-01T12:00:00Z');
  t.mock.timers.enable({ apis: ['Date'], now: start });
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  for (const migration of ['0001_auth_sessions', '0002_session_rotation']) {
    db.exec(readFileSync(new URL('../migrations/' + migration + '.sql', import.meta.url), 'utf8'));
  }
  const env = { AUTH_DB: { prepare(sql) {
    return { bind(...args) {
      const statement = db.prepare(sql);
      return { first: () => statement.get(...args), run: () => ({ meta: statement.run(...args) }) };
    } };
  } } };
  const old = 'original';
  const config = { rotateAfter: 1800, sessionTtl: 28800 };
  const iso = delta => new Date(start + delta).toISOString();
  db.prepare('insert into business_sessions(session_hash,user_id,identity_provider,identity_subject,created_at,last_seen_at,expires_at,absolute_expires_at) values(?,?,?,?,?,?,?,?)')
    .run(await sha256Base64Url(old), 'user', 'issuer', 'sub', iso(-3600000), iso(-3600000), iso(180000), iso(86400000));
  const req = token => new Request('https://forum.example/auth/session', { headers: { Cookie: '__Secure-rv_session=' + token } });
  const read = token => getBusinessSession(req(token), env, config, true);
  const issued = await read(old);
  const candidate = issued.setCookie.match(/session=([^;]+)/)[1];
  t.mock.timers.tick(90000);
  assert.ok((await read(old)).setCookie.includes('session=' + candidate + ';'));
  t.mock.timers.tick(100000);
  assert.equal((await read(old)).session, null);
  const confirmations = await Promise.all([read(candidate), read(candidate)]);
  assert.ok(confirmations.every(result => result.session?.user_id === 'user'));
  await destroyBusinessSession(req(candidate), env, true);
  assert.equal((await read(candidate)).session, null);
  assert.equal((await read(old)).session, null);
});
