export const OFFICIAL_USER_ID = '2da104a0-6662-4cb8-ac95-7781383c98f2';
export const OFFICIAL_NICKNAME = 'RootedVox官方';

const OFFICIAL_ALIASES = new Set([OFFICIAL_NICKNAME.toLowerCase(), 'isa spectrum官方']);

export function isOfficialNickname(nickname) {
  return OFFICIAL_ALIASES.has(nickname.toLowerCase());
}

export function resolveProfileNickname(userId, nickname, fallback) {
  if (userId === OFFICIAL_USER_ID && (!nickname || isOfficialNickname(nickname))) {
    return OFFICIAL_NICKNAME;
  }
  return nickname || fallback;
}
