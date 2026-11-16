export const OFFICIAL_USER_ID = '3ec4494f-05a7-5033-809a-ba9a66ee6383';
export const OFFICIAL_NICKNAME = 'RootedVox官方';

const OFFICIAL_ALIASES = new Set([OFFICIAL_NICKNAME.toLowerCase(), 'isa spectrum官方']);

// Names are compared without invisible format characters (zero-width space, joiners,
// word joiner). Otherwise "Rooted\u200bVox官方" would look identical and pass as free.
export function nicknameKey(value) {
  return String(value ?? '').normalize('NFKC').replace(/\p{Cf}/gu, '').replace(/\s+/g, ' ').trim().toLowerCase();
}

export function isOfficialNickname(nickname) {
  return OFFICIAL_ALIASES.has(nicknameKey(nickname));
}

// Developer names carry a Dev badge in the forum UI, so each belongs to one account (its
// business_users.user_id): the owner may set and show it, nobody else may. "匿名用户"
// marks anonymous posts and belongs to nobody. Keys are nicknameKey() forms.
const RESERVED_NICKNAMES = new Map([
  ['匿名用户', null],
  ['jerry', '1d850588-d352-52f8-99bd-b0d8ae8b9343'],
  ['maod1e', '3f5e0348-52ee-5366-8706-71a15aee3de0'],
  ['bychhh', '7376359f-3f5f-5b7d-b005-48777fb32b42'],
  ['yzxzyz', 'ce424600-49b0-5fe9-a000-30ece8db38cc'],
  ['sam.li', 'e1b791d0-5815-5c02-97f2-4d331351d715'],
  ['曹颢喆 jerry', '1d850588-d352-52f8-99bd-b0d8ae8b9343']
]);
export const DEFAULT_NICKNAME = '校园用户';

// True when this account may not use the name: it is reserved and not the account's own.
export function isReservedNickname(nickname, userId = null) {
  const key = nicknameKey(nickname);
  if (!RESERVED_NICKNAMES.has(key)) return false;
  const owner = RESERVED_NICKNAMES.get(key);
  return owner === null || owner !== userId;
}

export function resolveProfileNickname(userId, nickname, fallback) {
  if (userId === OFFICIAL_USER_ID && (!nickname || isOfficialNickname(nickname))) {
    return OFFICIAL_NICKNAME;
  }
  if (nickname || !fallback) return nickname || fallback;
  // The fallback is the identity provider's display name. It never went through the
  // nickname rules, so a protected or invisible name is replaced, not shown.
  return nicknameKey(fallback) && !isOfficialNickname(fallback) && !isReservedNickname(fallback, userId)
    ? fallback : DEFAULT_NICKNAME;
}
