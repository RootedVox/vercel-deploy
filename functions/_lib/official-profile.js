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

export function resolveProfileNickname(userId, nickname, fallback) {
  if (userId === OFFICIAL_USER_ID && (!nickname || isOfficialNickname(nickname))) {
    return OFFICIAL_NICKNAME;
  }
  return nickname || fallback;
}
