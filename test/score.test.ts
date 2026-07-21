import { describe, it, expect } from 'vitest';
import {
  HwatuCard, HwatuKind, RibbonKind, HwatuCatalog,
} from '../src/cards.js';
import { Scorer, ScoreOptions } from '../src/score.js';

const OPT = ScoreOptions.default();
const catalog = HwatuCatalog.standard();

// 표준 카탈로그에서 조건에 맞는 카드를 뽑아오는 헬퍼(원본 메타 그대로 사용).
function pick(pred: (c: HwatuCard) => boolean): HwatuCard {
  const c = catalog.find(pred);
  if (!c) throw new Error('no such card');
  return { ...c };
}
const brights = () => catalog.filter((c) => c.kind === HwatuKind.Bright).map((c) => ({ ...c }));
const godoris = () => catalog.filter((c) => c.isGodori).map((c) => ({ ...c }));

describe('광 점수', () => {
  it('3광(비광 제외) = 3점', () => {
    const cards = brights().filter((c) => !c.isBiGwang).slice(0, 3);
    expect(Scorer.evaluate(cards, OPT).brightPoints).toBe(3);
  });
  it('3광(비광 포함) = 2점', () => {
    const nonBi = brights().filter((c) => !c.isBiGwang).slice(0, 2);
    const bi = pick((c) => c.isBiGwang);
    expect(Scorer.evaluate([...nonBi, bi], OPT).brightPoints).toBe(2);
  });
  it('4광 = 4점, 5광 = 15점', () => {
    expect(Scorer.evaluate(brights().slice(0, 4), OPT).brightPoints).toBe(4);
    expect(Scorer.evaluate(brights(), OPT).brightPoints).toBe(15);
  });
});

describe('열끗 · 고도리', () => {
  it('열끗 5장부터 1점(4장=0)', () => {
    const animals = catalog.filter((c) => c.kind === HwatuKind.Animal && !c.isGukjin).map((c) => ({ ...c }));
    expect(Scorer.evaluate(animals.slice(0, 4), OPT).animalPoints).toBe(0);
    expect(Scorer.evaluate(animals.slice(0, 5), OPT).animalPoints).toBe(1);
    expect(Scorer.evaluate(animals.slice(0, 7), OPT).animalPoints).toBe(3);
  });
  it('고도리 3마리 = 5점', () => {
    expect(Scorer.evaluate(godoris(), OPT).godoriPoints).toBe(5);
  });
  it('고도리 2마리 = 0점', () => {
    expect(Scorer.evaluate(godoris().slice(0, 2), OPT).godoriPoints).toBe(0);
  });
});

describe('띠 · 홍/청/초단', () => {
  it('홍단 3장 = 3점', () => {
    const hong = catalog.filter((c) => c.ribbon === RibbonKind.Hong).map((c) => ({ ...c }));
    const bd = Scorer.evaluate(hong, OPT);
    expect(bd.hongdanPoints).toBe(3);
  });
  it('띠 5장부터 개수점 1점', () => {
    const ribbons = catalog.filter((c) => c.kind === HwatuKind.Ribbon).map((c) => ({ ...c }));
    expect(Scorer.evaluate(ribbons.slice(0, 4), OPT).ribbonPoints).toBe(0);
    expect(Scorer.evaluate(ribbons.slice(0, 5), OPT).ribbonPoints).toBe(1);
  });
});

describe('피 점수', () => {
  it('피값 10부터 1점(9=0)', () => {
    const junk = catalog.filter((c) => c.junkValue === 1).map((c) => ({ ...c }));
    expect(Scorer.evaluate(junk.slice(0, 9), OPT).junkPoints).toBe(0);
    expect(Scorer.evaluate(junk.slice(0, 10), OPT).junkPoints).toBe(1);
    expect(Scorer.evaluate(junk.slice(0, 12), OPT).junkPoints).toBe(3);
  });
});

describe('국진 이중 해석', () => {
  const gukjin = pick((c) => c.isGukjin);
  const nineJunk = catalog.filter((c) => c.junkValue === 1).map((c) => ({ ...c })).slice(0, 9); // 피값 9

  it('evaluate: 쌍피 해석 총점이 높으면 그쪽 선택(gukjinAsPi)', () => {
    // 피 9 + 국진: 열끗 해석 → 피9(0점)·열끗1(0점)=0 / 쌍피 해석 → 피11(2점)=2
    const bd = Scorer.evaluate([...nineJunk, gukjin], OPT);
    expect(bd.total).toBe(2);
    expect(bd.gukjinAsPi).toBe(true);
    expect(bd.junkValue).toBe(11);
  });

  it('evaluateAsLoser: 피박 회피가 총점보다 우선', () => {
    // 피 6 + 국진: 열끗 해석 → 피값6(0<6<=7 → 피박 위험) / 쌍피 해석 → 피값8(>7 → 안전)
    const sixJunk = catalog.filter((c) => c.junkValue === 1).map((c) => ({ ...c })).slice(0, 6);
    const bd = Scorer.evaluateAsLoser([...sixJunk, gukjin], OPT);
    expect(bd.gukjinAsPi).toBe(true);
    expect(bd.junkValue).toBe(8); // 쌍피로 해석해 피박 면함
  });

  it('GukjinLocked면 항상 열끗(쌍피 전환 불가)', () => {
    const locked = { ...gukjin, gukjinLocked: true };
    const bd = Scorer.evaluate([...nineJunk, locked], OPT);
    expect(bd.gukjinAsPi).toBe(false);
    expect(bd.animalCount).toBe(1);
    expect(bd.junkValue).toBe(9);
  });
});

describe('정산(Settle)', () => {
  const winner = Scorer.evaluate([
    ...brights().slice(0, 3), // 광 3점
  ], OPT);

  it('기본 정산: 배수 1, 고 보너스 0', () => {
    const loser = Scorer.evaluate([pick((c) => c.kind === HwatuKind.Bright)], OPT);
    const s = Scorer.settle(winner, loser, 0, 0, OPT);
    expect(s.multiplier).toBe(1);
    expect(s.points).toBe(3);
  });

  it('고 보너스: 2고 → +2점, 배수 1', () => {
    const loser = Scorer.evaluate([pick((c) => c.kind === HwatuKind.Bright)], OPT);
    const s = Scorer.settle(winner, loser, 2, 0, OPT);
    expect(s.goBonus).toBe(2);
    expect(s.points).toBe((3 + 2) * 1);
  });

  it('3고 → ×2 배수', () => {
    const loser = Scorer.evaluate([pick((c) => c.kind === HwatuKind.Bright)], OPT);
    const s = Scorer.settle(winner, loser, 3, 0, OPT);
    expect(s.goMultiplier).toBe(2);
    expect(s.points).toBe((3 + 3) * 2);
  });

  it('흔들기 1회 → ×2', () => {
    const loser = Scorer.evaluate([pick((c) => c.kind === HwatuKind.Bright)], OPT);
    const s = Scorer.settle(winner, loser, 0, 1, OPT);
    expect(s.multiplier).toBe(2);
  });

  it('광박: 승자 광점수 + 패자 광 0장 → ×2', () => {
    const loser = Scorer.evaluate([pick((c) => c.junkValue === 1)], OPT); // 광 없음
    const s = Scorer.settle(winner, loser, 0, 0, OPT);
    expect(s.gwangbak).toBe(true);
    expect(s.points).toBe(3 * 2);
  });

  it('피박: 승자 피점수 + 패자 피값 기준 이하 → ×2', () => {
    const junk = catalog.filter((c) => c.junkValue === 1).map((c) => ({ ...c }));
    const win = Scorer.evaluate(junk.slice(0, 10), OPT); // 피 1점
    const loser = Scorer.evaluate(junk.slice(10, 13), OPT); // 피값 3 (<=7)
    const s = Scorer.settle(win, loser, 0, 0, OPT);
    expect(s.pibak).toBe(true);
  });

  it('역고: 고 배수 대신 역고 배수(4) 사용', () => {
    const loser = Scorer.evaluate([pick((c) => c.kind === HwatuKind.Bright)], OPT);
    const s = Scorer.settle(winner, loser, 5, 0, OPT, true);
    expect(s.reverseGo).toBe(true);
    expect(s.goMultiplier).toBe(4);
  });
});
