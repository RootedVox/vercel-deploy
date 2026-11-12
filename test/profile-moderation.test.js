import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { isOfficialNickname, OFFICIAL_USER_ID, resolveProfileNickname } from '../functions/_lib/official-profile.js';
import { normalizeNickname } from '../functions/api/profile.js';

test('profile nickname normalization is stable and conservative', () => {
  assert.equal(normalizeNickname('  校园   小星  '), '校园 小星');
  assert.equal(normalizeNickname('ＩＳＡ'), 'ISA');
});

test('pending moderation exposes delete and preserves the selected action', async () => {
  const source = await readFile(new URL('../checker-ui.js', import.meta.url), 'utf8');
  assert.match(source, /status === 'pending'.*data-action="delete"/);
  assert.match(source, /selectedAction = nextAction/);
  assert.match(source, /moderate\(selectedId, selectedAction, reason\)/);
});

test('profile UI exposes nickname and avatar editing from the account menu', async () => {
  const source = await readFile(new URL('../messages.html', import.meta.url), 'utf8');
  assert.match(source, /id="openProfile">个人资料/);
  assert.match(source, /id="profileNickname"/);
  assert.match(source, /id="profileAvatarButton"/);
  assert.match(source, /JSON\.stringify\(\{ nickname \}\)/);
});

test('database migration keeps user updates behind RLS and checker deletes audited', async () => {
  const sql = await readFile(new URL('../supabase/20261111_profile_and_pending_delete.sql', import.meta.url), 'utf8');
  assert.match(sql, /grant update \(nickname, avatar_url\)\s+on table public\.business_users to authenticated/);
  assert.match(sql, /u\.user_id = auth\.uid\(\) and u\.is_checker = true/);
  assert.match(sql, /p_action = 'delete' and flag in \(0, 1\)/);
  assert.match(sql, /insert into public\.business_moderation_logs/);
  assert.doesNotMatch(sql, /service_role/i);
});

test('official nickname uses canonical casing and applies the legacy alias only to the official account', () => {
  assert.equal(isOfficialNickname('rootedvox官方'), true);
  assert.equal(isOfficialNickname('RootedVox官方'), true);
  assert.equal(resolveProfileNickname(OFFICIAL_USER_ID, 'ISA Spectrum官方'), 'RootedVox官方');
  assert.equal(resolveProfileNickname(OFFICIAL_USER_ID, 'rootedvox官方'), 'RootedVox官方');
  assert.equal(resolveProfileNickname(OFFICIAL_USER_ID, null, '旧名'), 'RootedVox官方');
  assert.equal(resolveProfileNickname(OFFICIAL_USER_ID, '自定义昵称'), '自定义昵称');
  assert.equal(resolveProfileNickname('another-user', null, '普通用户'), '普通用户');
});
