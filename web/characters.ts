// 캐릭터(아바타) 데이터 로더 + AI 능력치 파생.
// 원본 Gostop.Characters.pas는 데이터 기반이라 characters.json을 그대로 로드하고,
// 능력치 파생 공식만 옮긴다.

export type Emotion = 'normal' | 'cheer' | 'sad' | 'angry';

export interface Character {
  index: number;
  name: string;
  ageJob: string;
  personality: string;
  playstyle: string;
  goStars: number;
  recommendedDifficulty: string;
  stats: { insight: number; composure: number; nerve: number; greed: number; luck: number };
  quotes: string[];
  images: Record<Emotion, string>;
}

let characters: Character[] = [];

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

export async function loadCharacters(): Promise<Character[]> {
  if (characters.length) return characters;
  const res = await fetch(`${import.meta.env.BASE_URL}avatars/characters.json`);
  characters = (await res.json()) as Character[];
  return characters;
}

export const allCharacters = (): Character[] => characters;
export const characterAt = (i: number): Character => characters[i % characters.length]!;

/** 파생 실력(0~100) = clamp(round((수읽기+침착)×1.25)). */
export const derivedSkill = (c: Character): number =>
  clamp(Math.round((c.stats.insight + c.stats.composure) * 1.25), 0, 100);

/** 배짱 바이어스(고 성향, 0~100) = clamp(배짱×2 + 10). */
export const nerveBias = (c: Character): number => clamp(c.stats.nerve * 2 + 10, 0, 100);

/** 욕심 바이어스(0~100) = clamp(욕심×2 + 10). */
export const greedBias = (c: Character): number => clamp(c.stats.greed * 2 + 10, 0, 100);

/** 감정별 아바타 이미지 URL. */
export const avatarUrl = (c: Character, emotion: Emotion): string => `${import.meta.env.BASE_URL}avatars/${c.images[emotion]}`;

/** 임의 대사 하나(rng 주입 가능). */
export function randomQuote(c: Character, rnd: () => number = Math.random): string {
  if (!c.quotes.length) return '';
  return c.quotes[Math.floor(rnd() * c.quotes.length)]!;
}
