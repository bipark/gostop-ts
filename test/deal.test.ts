import { describe, it, expect } from 'vitest';
import { Deck, DeckOptions } from '../src/deck.js';
import { DealConfig, Dealer, TableState } from '../src/deal.js';
import { HwatuCard, HwatuKind, HwatuCatalog } from '../src/cards.js';

const key = (c: HwatuCard) => `${c.month}:${c.kind}:${c.ordinal}`;
const seeded = (seed: number) => (d: Deck) => d.shuffleSeeded(seed);

describe('DealConfig', () => {
  it('2인=10/8, 3인=7/6', () => {
    expect(DealConfig.forPlayers(2)).toEqual({ playerCount: 2, handSize: 10, floorSize: 8 });
    expect(DealConfig.forPlayers(3)).toEqual({ playerCount: 3, handSize: 7, floorSize: 6 });
  });
  it('미정의 인원수는 예외', () => {
    expect(() => DealConfig.forPlayers(4)).toThrow();
  });
  it('dealtCount: 2인=28, 3인=27', () => {
    expect(DealConfig.dealtCount(DealConfig.forPlayers(2))).toBe(28);
    expect(DealConfig.dealtCount(DealConfig.forPlayers(3))).toBe(27);
  });
});

describe('Dealer.deal', () => {
  it('2인: 손패 10·10, 바닥 8, 뒷패 20, 덱 소진', () => {
    const deck = new Deck();
    deck.shuffleSeeded(42);
    const t = Dealer.deal(deck, DealConfig.forPlayers(2));
    expect(t.hand(0)).toHaveLength(10);
    expect(t.hand(1)).toHaveLength(10);
    expect(t.floor).toHaveLength(8);
    expect(t.stock).toHaveLength(48 - 28); // 20
    expect(deck.count()).toBe(0);
  });

  it('3인: 손패 7×3, 바닥 6, 뒷패 21', () => {
    const deck = new Deck();
    deck.shuffleSeeded(7);
    const t = Dealer.deal(deck, DealConfig.forPlayers(3));
    for (let p = 0; p < 3; p++) expect(t.hand(p)).toHaveLength(7);
    expect(t.floor).toHaveLength(6);
    expect(t.stock).toHaveLength(21);
  });

  it('분배된 48장이 원래 덱의 순열(중복·유실 없음)', () => {
    const orig = new Deck(); orig.shuffleSeeded(123);
    const snapshot = orig.cards.map(key).sort();
    const t = Dealer.deal(orig, DealConfig.forPlayers(2));
    const all = [...t.hand(0), ...t.hand(1), ...t.floor, ...t.stock].map(key).sort();
    expect(all).toEqual(snapshot);
  });

  it('덱 부족 시 예외', () => {
    const deck = new Deck();
    deck.drawMany(30); // 18장 남음 < 28
    expect(() => Dealer.deal(deck, DealConfig.forPlayers(2))).toThrow();
  });

  it('라운드로빈 순서: 첫 두 장이 P0/P1로 번갈아', () => {
    const deck = new Deck();
    deck.shuffleSeeded(5);
    const top = deck.cards.slice().reverse(); // 뽑히는 순서(끝이 맨 위)
    const t = Dealer.deal(deck, DealConfig.forPlayers(2));
    expect(key(t.hand(0)[0]!)).toBe(key(top[0]!));
    expect(key(t.hand(1)[0]!)).toBe(key(top[1]!));
    expect(key(t.hand(0)[1]!)).toBe(key(top[2]!));
  });
});

describe('TableState 판정', () => {
  it('총통(손패 4장 같은 월) 감지', () => {
    const t = new TableState(2);
    const cat = HwatuCatalog.standard();
    // 인위적으로 1월 카드를 손에 몰아넣기엔 3장뿐 → 4장짜리 11월(피3+광1) 사용
    const nov = cat.filter((c) => c.month === 11);
    expect(nov).toHaveLength(4);
    nov.forEach((c) => t.hand(0).push(c));
    expect(t.handFourOfAKind(0)).toBe(11);
    expect(t.handFourOfAKind(1)).toBeNull();
  });

  it('바닥 보너스 감지 → needsRedeal', () => {
    const t = new TableState(2);
    t.floor.push(...HwatuCatalog.bonus());
    expect(t.floorHasBonus()).toBe(true);
    expect(Dealer.needsRedeal(t)).toBe(true);
  });

  it('sortHands: 월→종류 순 정렬', () => {
    const t = new TableState(1);
    const cat = HwatuCatalog.standard();
    const shuffled = [cat[10]!, cat[0]!, cat[5]!]; // 임의 순서
    shuffled.forEach((c) => t.hand(0).push({ ...c }));
    t.sortHands();
    const months = t.hand(0).map((c) => c.month);
    expect(months).toEqual([...months].sort((a, b) => a - b));
  });
});

describe('Dealer.dealFresh', () => {
  it('시드 셔플 주입 시 재현 가능', () => {
    const a = Dealer.dealFresh(DealConfig.forPlayers(2), DeckOptions.standard(), 0, { shuffle: seeded(999) });
    const b = Dealer.dealFresh(DealConfig.forPlayers(2), DeckOptions.standard(), 0, { shuffle: seeded(999) });
    expect(a.hand(0).map(key)).toEqual(b.hand(0).map(key));
    expect(a.floor.map(key)).toEqual(b.floor.map(key));
  });

  it('재분배 0회면 바닥 무효라도 그대로 반환', () => {
    const t = Dealer.dealFresh(DealConfig.forPlayers(2), DeckOptions.withBonus(3), 0, { shuffle: seeded(1) });
    expect(t).toBeInstanceOf(TableState);
  });
});

describe('Dealer.handQuality / luckReassign', () => {
  it('광이 많은 손패가 피만 있는 손패보다 품질이 높다', () => {
    const cat = HwatuCatalog.standard();
    const brights = cat.filter((c) => c.kind === HwatuKind.Bright);
    const junks = cat.filter((c) => c.junkValue === 1).slice(0, 5);
    expect(Dealer.handQuality(brights)).toBeGreaterThan(Dealer.handQuality(junks));
  });

  it('바닥 매칭이 품질을 가산한다', () => {
    const cat = HwatuCatalog.standard();
    const hand = cat.filter((c) => c.month === 1).slice(0, 2);
    const floorMatch = cat.filter((c) => c.month === 1).slice(2, 3);
    const floorNo = cat.filter((c) => c.month === 5).slice(0, 1);
    expect(Dealer.handQuality(hand, floorMatch)).toBeGreaterThan(Dealer.handQuality(hand, floorNo));
  });

  it('luckReassign: 손패 집합은 보존, 재현 가능(rng 주입)', () => {
    const deck = new Deck(); deck.shuffleSeeded(321);
    const t = Dealer.deal(deck, DealConfig.forPlayers(3));
    const before = [t.hand(0), t.hand(1), t.hand(2)].map((h) => h.map(key).sort());
    // 결정적 rng: 항상 0 반환 → 첫 남은 플레이어 선택
    Dealer.luckReassign(t, [90, 50, 10], () => 0);
    const after = [t.hand(0), t.hand(1), t.hand(2)].map((h) => h.map(key).sort());
    // 전체 카드 집합(모든 손패 합집합)은 변하지 않아야 함
    const flatBefore = before.flat().sort();
    const flatAfter = after.flat().sort();
    expect(flatAfter).toEqual(flatBefore);
    // 각 손패 크기 유지
    expect(after.map((h) => h.length)).toEqual([7, 7, 7]);
  });
});
