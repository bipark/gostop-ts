import { describe, it, expect } from 'vitest';
import { Deck, DeckOptions, HwatuDeckEmpty } from '../src/deck.js';
import { HwatuCard } from '../src/cards.js';

const key = (c: HwatuCard) => `${c.month}:${c.kind}:${c.ordinal}`;
const isPermutationOf = (a: readonly HwatuCard[], b: readonly HwatuCard[]) => {
  const sa = a.map(key).sort();
  const sb = b.map(key).sort();
  return JSON.stringify(sa) === JSON.stringify(sb);
};

describe('Deck 구성', () => {
  it('표준 48장', () => {
    expect(new Deck().count()).toBe(48);
  });
  it('보너스 포함 51장', () => {
    expect(new Deck(DeckOptions.withBonus(3)).count()).toBe(51);
  });
  it('보너스 장수 클램프(요청 10 → 실제 3)', () => {
    expect(new Deck(DeckOptions.withBonus(10)).count()).toBe(51);
  });
});

describe('셔플', () => {
  it('시드 셔플은 재현 가능(같은 시드 → 같은 결과)', () => {
    const a = new Deck(); a.shuffleSeeded(12345);
    const b = new Deck(); b.shuffleSeeded(12345);
    expect(a.cards.map(key)).toEqual(b.cards.map(key));
  });

  it('다른 시드 → 다른 결과', () => {
    const a = new Deck(); a.shuffleSeeded(1);
    const b = new Deck(); b.shuffleSeeded(2);
    expect(a.cards.map(key)).not.toEqual(b.cards.map(key));
  });

  it('셔플 후에도 원래 48장 순열이 보존됨', () => {
    const orig = new Deck().cards.slice();
    const d = new Deck(); d.shuffleSeeded(999);
    expect(isPermutationOf(orig, d.cards)).toBe(true);
  });

  it('시드 셔플이 Delphi LCG(UInt64)와 동일한 순열을 만든다(독립 참조 구현 대조)', () => {
    // Fisher–Yates + Delphi Shuffle(seed)의 LCG를 참조로 재구현해 인덱스 교환열을 비교.
    const MULT = 6364136223846793005n;
    const INC = 1442695040888963407n;
    const MASK = (1n << 64n) - 1n;
    const ref = new Deck().cards.map(key); // 미셔플 초기 배열의 키
    let state = BigInt(777) & MASK;
    for (let i = ref.length - 1; i >= 1; i--) {
      state = (state * MULT + INC) & MASK;
      const j = Number((state >> 33n) % BigInt(i + 1));
      const t = ref[i]!; ref[i] = ref[j]!; ref[j] = t;
    }
    const d = new Deck(); d.shuffleSeeded(777);
    expect(d.cards.map(key)).toEqual(ref);
  });

  it('보안 셔플도 순열 보존(crypto)', () => {
    const orig = new Deck().cards.slice();
    const d = new Deck(); d.shuffleSecure();
    expect(isPermutationOf(orig, d.cards)).toBe(true);
  });
});

describe('드로우 · 컷', () => {
  it('draw는 맨 위(끝) 카드를 반환하고 장수 감소', () => {
    const d = new Deck();
    const top = d.cards[d.count() - 1]!;
    const drawn = d.draw();
    expect(key(drawn)).toBe(key(top));
    expect(d.count()).toBe(47);
  });

  it('drawMany(7) → 7장, 43장 남음(51 덱)', () => {
    const d = new Deck(DeckOptions.withBonus(3));
    const many = d.drawMany(7);
    expect(many).toHaveLength(7);
    expect(d.count()).toBe(44);
  });

  it('빈 덱에서 draw → HwatuDeckEmpty', () => {
    const d = new Deck();
    d.drawMany(48);
    expect(() => d.draw()).toThrow(HwatuDeckEmpty);
  });

  it('과다 drawMany → HwatuDeckEmpty', () => {
    expect(() => new Deck().drawMany(49)).toThrow(HwatuDeckEmpty);
  });

  it('cut은 위아래를 맞바꾼다', () => {
    const d = new Deck();
    const before = d.cards.map(key);
    d.cut(20);
    const after = d.cards.map(key);
    // [20..47] + [0..19]
    expect(after).toEqual(before.slice(20).concat(before.slice(0, 20)));
  });

  it('cut(0)·cut(count)은 변화 없음', () => {
    const d = new Deck();
    const before = d.cards.map(key);
    d.cut(0); d.cut(48);
    expect(d.cards.map(key)).toEqual(before);
  });
});
