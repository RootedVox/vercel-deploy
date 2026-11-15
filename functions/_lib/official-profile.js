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

// Developer names carry a badge in the forum UI and "匿名用户" marks anonymous posts,
// so nobody may pick them. Entries are nicknameKey() forms.
const RESERVED_NICKNAMES = new Set([
  '匿名用户',
  'sam.li',
  'jerry',
  'maod1e',
  'bychhh',
  '曹颢喆 jerry'
]);
export const DEFAULT_NICKNAME = '校园用户';

export function isReservedNickname(nickname) {
  return RESERVED_NICKNAMES.has(nicknameKey(nickname));
}

export function resolveProfileNickname(userId, nickname, fallback) {
  if (userId === OFFICIAL_USER_ID && (!nickname || isOfficialNickname(nickname))) {
    return OFFICIAL_NICKNAME;
  }
  if (nickname || !fallback) return nickname || fallback;
  // The fallback is the identity provider's display name. It never went through the
  // nickname rules, so a protected or invisible name is replaced, not shown.
  return nicknameKey(fallback) && !isOfficialNickname(fallback) && !isReservedNickname(fallback)
    ? fallback : DEFAULT_NICKNAME;
}
