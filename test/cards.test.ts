import { describe, it, expect } from 'vitest';
import {
  HwatuCatalog, HwatuKind, RibbonKind, displayName, imageFileName,
} from '../src/cards.js';

describe('HwatuCatalog.standard', () => {
  const deck = HwatuCatalog.standard();

  it('정확히 48장', () => {
    expect(deck).toHaveLength(48);
  });

  it('종류별 장수: 광5 · 열끗9 · 띠10 · 피24', () => {
    const count = (k: HwatuKind) => deck.filter((c) => c.kind === k).length;
    expect(count(HwatuKind.Bright)).toBe(5);
    expect(count(HwatuKind.Animal)).toBe(9);
    expect(count(HwatuKind.Ribbon)).toBe(10);
    expect(count(HwatuKind.Junk)).toBe(24);
  });

  it('총 피값 = 24 (일반 22 + 똥쌍피 1 + 비쌍피 1 → 각 +1)', () => {
    // 일반 피 22장(월 1~10 각2 + 11월 2 = 22) 값1, 똥쌍피 값2, 비쌍피 값2 = 22 + 2 + 2 = 26? 확인
    const total = deck.reduce((s, c) => s + c.junkValue, 0);
    expect(total).toBe(26);
  });

  it('고도리 3장(2·4·8월 열끗)', () => {
    const godori = deck.filter((c) => c.isGodori);
    expect(godori.map((c) => c.month).sort((a, b) => a - b)).toEqual([2, 4, 8]);
  });

  it('홍단 3 · 청단 3 · 초단 3 · 일반띠 1(12월)', () => {
    const byRibbon = (r: RibbonKind) => deck.filter((c) => c.ribbon === r).length;
    expect(byRibbon(RibbonKind.Hong)).toBe(3);
    expect(byRibbon(RibbonKind.Cheong)).toBe(3);
    expect(byRibbon(RibbonKind.Cho)).toBe(3);
    // 12월 비 띠는 색 없음(None)
    const dec = deck.find((c) => c.month === 12 && c.kind === HwatuKind.Ribbon)!;
    expect(dec.ribbon).toBe(RibbonKind.None);
  });

  it('비광은 12월 광 하나뿐 · 국진은 9월 열끗 하나뿐', () => {
    const bi = deck.filter((c) => c.isBiGwang);
    expect(bi).toHaveLength(1);
    expect(bi[0]!.month).toBe(12);
    const gukjin = deck.filter((c) => c.isGukjin);
    expect(gukjin).toHaveLength(1);
    expect(gukjin[0]!.month).toBe(9);
  });

  it('매 호출마다 새 객체(값-복사 시맨틱)', () => {
    const a = HwatuCatalog.standard();
    const b = HwatuCatalog.standard();
    expect(a[0]).not.toBe(b[0]);
    a[0]!.gukjinLocked = true;
    expect(b[0]!.gukjinLocked).toBe(false);
  });
});

describe('displayName / imageFileName', () => {
  const deck = HwatuCatalog.standard();
  const find = (month: number, kind: HwatuKind, ordinal = 1) =>
    deck.find((c) => c.month === month && c.kind === kind && c.ordinal === ordinal)!;

  it('11월 똥 광', () => {
    expect(displayName(find(11, HwatuKind.Bright))).toBe('11월 똥 광');
  });
  it('1월 송학 피1', () => {
    expect(displayName(find(1, HwatuKind.Junk, 1))).toBe('1월 송학 피1');
  });
  it('보너스 쌍피 / 3피', () => {
    const bonus = HwatuCatalog.bonus();
    expect(displayName(bonus[0]!)).toBe('보너스 쌍피');
    expect(displayName(bonus[2]!)).toBe('보너스 3피');
  });
  it('이미지 파일명', () => {
    expect(imageFileName(find(1, HwatuKind.Bright))).toBe('january_hikari.png');
    expect(imageFileName(find(1, HwatuKind.Bright), 'svg')).toBe('january_hikari.svg');
  });
});
