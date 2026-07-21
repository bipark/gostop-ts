// Gostop.Deck.pas → TS 이식.
// 표준 48장(+선택적 보너스패) 덱 생성 · 셔플 · 드로우 · 컷.
// 배열의 끝이 '맨 위(다음에 뽑을 카드)'다 — Delphi 구현과 동일.

import { HwatuCard, HwatuCatalog, HwatuError } from './cards.js';

/** 덱이 비었을 때 카드를 뽑으려 하면 발생하는 예외. */
export class HwatuDeckEmpty extends HwatuError {
  constructor(message: string) {
    super(message);
    this.name = 'HwatuDeckEmpty';
  }
}

/** 덱 구성 옵션. */
export interface DeckOptions {
  /** 보너스패(조커)를 덱에 포함할지 여부. */
  includeBonus: boolean;
  /** 포함할 보너스패 장수(0~4). includeBonus가 false면 무시. */
  bonusCount: number;
}

export const DeckOptions = {
  /** 표준 구성(48장, 보너스 없음). */
  standard(): DeckOptions {
    return { includeBonus: false, bonusCount: 0 };
  },
  /** 보너스패 포함 구성. 기본 3(쌍피 2 · 3피 1). */
  withBonus(count = 3): DeckOptions {
    return { includeBonus: true, bonusCount: count };
  },
};

// 64비트 LCG(PCG류) 상수. Delphi UInt64 연산을 BigInt로 그대로 재현.
const LCG_MULTIPLIER = 6364136223846793005n;
const LCG_INCREMENT = 1442695040888963407n;
const U64_MASK = (1n << 64n) - 1n;

/**
 * 화투 덱. 표준 48장(+선택적 보너스패)을 생성하고 셔플·드로우 등 기본 조작을 제공한다.
 * cards 배열의 끝이 '맨 위(다음에 뽑을 카드)'.
 */
export class Deck {
  private fCards: HwatuCard[] = [];

  constructor(options: DeckOptions = DeckOptions.standard()) {
    this.build(options);
  }

  /** 옵션에 따라 덱을 다시 구성(기존 카드는 모두 대체). */
  build(options: DeckOptions): void {
    this.fCards = HwatuCatalog.standard();

    if (options.includeBonus) {
      const bonus = HwatuCatalog.bonus();
      const count = Math.min(options.bonusCount, bonus.length);
      for (let i = 0; i < count; i++) {
        this.fCards.push(bonus[i]!);
      }
    }
  }

  // Fisher–Yates: 뒤에서부터 앞쪽의 임의 위치와 교환.
  // nextIndex(bound)는 [0, bound) 정수를 반환.
  private doShuffle(nextIndex: (bound: number) => number): void {
    for (let i = this.fCards.length - 1; i >= 1; i--) {
      const j = nextIndex(i + 1);
      const tmp = this.fCards[i]!;
      this.fCards[i] = this.fCards[j]!;
      this.fCards[j] = tmp;
    }
  }

  /** 비결정적 셔플(Math.random). */
  shuffle(): void {
    this.doShuffle((bound) => Math.floor(Math.random() * bound));
  }

  /**
   * 결정적·재현 가능한 시드 셔플. Delphi의 LCG 셔플과 비트 단위로 동일한 순열을 만든다
   * (UInt64 오버플로를 BigInt 64비트 마스킹으로 재현).
   */
  shuffleSeeded(seed: number | bigint): void {
    let state = BigInt(seed) & U64_MASK;
    this.doShuffle((bound) => {
      state = (state * LCG_MULTIPLIER + LCG_INCREMENT) & U64_MASK;
      return Number((state >> 33n) % BigInt(bound));
    });
  }

  /**
   * 암호학적 난수(crypto.getRandomValues)로 셔플. rejection sampling으로 모듈로 편향 제거.
   * 브라우저·Node 공통으로 동작하는, Delphi ShuffleSecure(BCryptGenRandom)의 웹 대체.
   */
  shuffleSecure(): void {
    const g: Crypto | undefined = (globalThis as { crypto?: Crypto }).crypto;
    if (!g || typeof g.getRandomValues !== 'function') {
      throw new HwatuError('shuffleSecure: crypto.getRandomValues를 사용할 수 없습니다.');
    }
    this.doShuffle((bound) => secureRandomBelow(g, bound));
  }

  /** 맨 위(배열 끝) 카드를 한 장 뽑아 제거하고 반환. */
  draw(): HwatuCard {
    if (this.isEmpty()) {
      throw new HwatuDeckEmpty('덱이 비어 있어 카드를 뽑을 수 없습니다.');
    }
    return this.fCards.pop()!;
  }

  /** 맨 위에서 지정 장수만큼 뽑아 제거하고 배열로 반환(뽑은 순서). */
  drawMany(count: number): HwatuCard[] {
    if (count > this.fCards.length) {
      throw new HwatuDeckEmpty(
        `덱에 ${this.fCards.length}장만 남아 ${count}장을 뽑을 수 없습니다.`,
      );
    }
    const result: HwatuCard[] = [];
    for (let i = 0; i < count; i++) {
      result.push(this.draw());
    }
    return result;
  }

  /**
   * 덱을 지정 위치에서 컷(기리). index 위치와 그 위(끝쪽)를 통째로 아래(앞쪽)로 내려 위아래를 바꾼다.
   * index가 0 이하거나 끝이면 변화 없음.
   */
  cut(index: number): void {
    if (index <= 0 || index >= this.fCards.length) {
      return;
    }
    const upper = this.fCards.slice(index); // [index..end]
    const lower = this.fCards.slice(0, index); // [0..index-1]
    this.fCards = upper.concat(lower);
  }

  /**
   * 남은 카드 전체를 순서 그대로(끝=맨 위) 반환하고 덱을 비운다.
   * Delphi의 `Stock.AddRange(Deck.Cards); Deck.Cards.Clear;` 이관 패턴에 대응.
   */
  drainAll(): HwatuCard[] {
    const rest = this.fCards;
    this.fCards = [];
    return rest;
  }

  isEmpty(): boolean {
    return this.fCards.length === 0;
  }

  count(): number {
    return this.fCards.length;
  }

  /** 덱의 카드 목록(읽기용 스냅샷). 끝이 맨 위. */
  get cards(): readonly HwatuCard[] {
    return this.fCards;
  }
}

// [0, bound) 균일 정수. rejection sampling으로 32비트 모듈로 편향 제거.
function secureRandomBelow(g: Crypto, bound: number): number {
  if (bound <= 1) return 0;
  const range = 1n << 32n;
  const limit = range - (range % BigInt(bound));
  const buf = new Uint32Array(1);
  let raw: bigint;
  do {
    g.getRandomValues(buf);
    raw = BigInt(buf[0]!);
  } while (raw >= limit);
  return Number(raw % BigInt(bound));
}
