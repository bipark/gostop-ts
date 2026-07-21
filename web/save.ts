// 진행 중인 게임을 localStorage에 저장/복원. 카드는 원본 TSaveCard처럼 assetId + gukjinLocked만
// 저장하고, 나머지 메타데이터는 카탈로그에서 복원한다(불변이므로).

import { HwatuCard, HwatuCatalog } from '../src/index.js';

const KEY = 'gostop-save-v1';

const CARD_BY_ASSET = new Map<string, HwatuCard>();
for (const c of [...HwatuCatalog.standard(), ...HwatuCatalog.bonus()]) CARD_BY_ASSET.set(c.assetId, c);

// m: 카탈로그와 다른 월(뻑 더미에 묻힌 보너스패는 엔진이 월을 뻑 월로 바꾼 복제본을 바닥에 둔다 —
// 이걸 잃으면 복원 후 그 더미를 먹을 때 보너스패가 바닥에 미아로 남는다).
export interface SaveCard { a: string; g?: 1; m?: number }
export interface SavePlayer {
  name: string; hand: SaveCard[]; captured: SaveCard[];
  goCount: number; lastGoScore: number; shakeCount: number; cardDebt: number;
  pendingShakeMonth: number; bbeokCount: number; reverseGo: boolean;
}
export interface SaveState {
  names: string[]; current: number; phase: string; winner: number;
  playCount: number; threeBbeok: boolean; bbeokCreator: [number, number][];
  players: SavePlayer[]; floor: SaveCard[]; stock: SaveCard[];
}
export interface SaveGwang { sold: boolean; sellerSeat: number; gwangCount: number; valuePerPayer: number; payerSeats: number[] }
export interface SaveData {
  v: 1; mode: 2 | 3 | 4; charByOrig: number[]; gameToOrig: number[]; gwangNet: number[];
  stakes: number;           // 판돈 배수(나가리 이월)
  shodangDone?: boolean;    // 3인: 이번 판 쇼당 시도 여부
  shodangPushed?: { caller: number; accepter: number; decliner: number } | null; // 3인: 밀어주기(독박 대기)
  playerLuck?: number[];    // 이번 판 좌석별 운 롤(뒤집기 바이어스)
  seonOrig?: number;        // 이번 판 선(원좌석)
  gaveUpLast?: boolean[];   // 4인 연사 규칙 기록
  moneyPerPoint?: number;   // 점당 금액(원)
  seatMoney?: number[];     // 좌석별 잔액(원)
  wins?: number[]; losses?: number[]; // 좌석별 전적
  matchOnly?: boolean;      // true면 판 사이 스냅샷(state 없음) — 복원 시 곧바로 다음 판 시작(원본 MatchOnly)
  round: { playSeats: number[]; sitOutSeat: number; gwang: SaveGwang } | null;
  state: SaveState | null;
}

// ---- 게임 설정(원본 gostop.ini의 룰 토글·게임속도·닉네임 대응) ----
const SETTINGS_KEY = 'gostop-settings-v1';
export interface GameSettings {
  nickname: string;     // 인간 표시 이름
  gameSpeed: number;    // 0.5~2.0 — 연출·AI 딜레이 배속(원본 FGameSpeed)
  bubbles: boolean;     // 말풍선 표시
  bonusCards: boolean;  // 보너스패(조커) 덱 포함
  pibak: boolean; gwangbak: boolean; meongbak: boolean; gobak: boolean; reverseGo: boolean;
  autoAdvance: boolean; // 정산 팝업 방치 시 자동 다음 판(원본 5초 카운트다운)
}
export const defaultSettings = (): GameSettings => ({
  nickname: '나', gameSpeed: 1, bubbles: true, bonusCards: true,
  pibak: true, gwangbak: true, meongbak: true, gobak: true, reverseGo: true,
  autoAdvance: true,
});
export function loadSettings(): GameSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) return { ...defaultSettings(), ...JSON.parse(raw) as Partial<GameSettings> };
  } catch { /* 무시 */ }
  return defaultSettings();
}
export function saveSettings(s: GameSettings): void {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)); } catch { /* 무시 */ }
}

// ---- 영구 프로필(원본 gostop.ini의 RefillCount/KillCount 대응) ----
const PROFILE_KEY = 'gostop-profile-v1';
export interface Profile { refillCount: number; killCount: number }
export function loadProfile(): Profile {
  try {
    const raw = localStorage.getItem(PROFILE_KEY);
    if (raw) return { refillCount: 0, killCount: 0, ...JSON.parse(raw) as Partial<Profile> };
  } catch { /* 무시 */ }
  return { refillCount: 0, killCount: 0 };
}
export function saveProfile(p: Profile): void {
  try { localStorage.setItem(PROFILE_KEY, JSON.stringify(p)); } catch { /* 무시 */ }
}

export const cardToSave = (c: HwatuCard): SaveCard => {
  const out: SaveCard = { a: c.assetId };
  if (c.gukjinLocked) out.g = 1;
  const base = CARD_BY_ASSET.get(c.assetId)!;
  if (c.month !== base.month) out.m = c.month; // 뻑 더미에 묻힌 보너스패의 변경된 월 보존
  return out;
};
export const cardFromSave = (s: SaveCard): HwatuCard => ({
  ...CARD_BY_ASSET.get(s.a)!,
  gukjinLocked: !!s.g,
  ...(s.m !== undefined ? { month: s.m } : {}),
});
export const cardsToSave = (cs: readonly HwatuCard[]): SaveCard[] => cs.map(cardToSave);
export const cardsFromSave = (ss: readonly SaveCard[]): HwatuCard[] => ss.map(cardFromSave);

export function saveGame(data: SaveData): void {
  try { localStorage.setItem(KEY, JSON.stringify(data)); } catch { /* 용량 초과 등 무시 */ }
}
export function loadGame(): SaveData | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const d = JSON.parse(raw) as SaveData;
    return d.v === 1 ? d : null;
  } catch { return null; }
}
export function clearGame(): void {
  try { localStorage.removeItem(KEY); } catch { /* 무시 */ }
}
export const hasSave = (): boolean => loadGame() !== null;
