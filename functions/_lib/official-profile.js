export const OFFICIAL_USER_ID = '3ec4494f-05a7-5033-809a-ba9a66ee6383';
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
