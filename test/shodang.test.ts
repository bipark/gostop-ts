import { describe, it, expect } from 'vitest';
import { HwatuCatalog, HwatuKind, RibbonKind, HwatuCard } from '../src/cards.js';
import { GameState, PlayerResult } from '../src/play.js';
import { Shodang, ShodangOutcome } from '../src/shodang.js';

const CAT = HwatuCatalog.standard();
const brights = () => CAT.filter((c) => c.kind === HwatuKind.Bright).map((c) => ({ ...c }));
const ribbons = (r: RibbonKind) => CAT.filter((c) => c.ribbon === r).map((c) => ({ ...c }));

describe('Shodang.detect', () => {
  it('3인이 아니면 판정 안 함', () => {
    const g = new GameState(['a', 'b']);
    expect(Shodang.detect(g, 0).callable).toBe(false);
  });

  it('두 상대 모두 미완성 광(2장) + 호출자 완성 광 보유 → 쇼당 가능', () => {
    const g = new GameState(['나', 'A', 'B']);
    const b = brights(); // 5장: month 1,3,8,11,12
    // 상대A: 광 2장(1,3월), 상대B: 광 2장(8,11월)
    g.player(1).captured.push(b[0]!, b[1]!);
    g.player(2).captured.push(b[2]!, b[3]!);
    // 호출자: 남은 광(12월) 보유 → 양쪽 다 완성 위협(상대에 없는 월)
    g.player(0).hand.push(b[4]!);
    const r = Shodang.detect(g, 0);
    expect(r.callable).toBe(true);
    expect(r.threats.length).toBe(2);
  });

  it('한 상대만 위협하면 쇼당 불가', () => {
    const g = new GameState(['나', 'A', 'B']);
    const b = brights();
    g.player(1).captured.push(b[0]!, b[1]!); // A만 미완성 광
    g.player(0).hand.push(b[4]!);
    expect(Shodang.detect(g, 0).callable).toBe(false);
  });

  it('완성패의 월이 상대가 이미 가진 월이면 위협 아님', () => {
    const g = new GameState(['나', 'A', 'B']);
    const hong = ribbons(RibbonKind.Hong); // 홍단 3장(1,2,3월)
    g.player(1).captured.push(hong[0]!, hong[1]!); // 1,2월 홍단
    g.player(2).captured.push(hong[0]!, hong[1]!);
    // 호출자가 1월 홍단(이미 A가 가진 월)만 있으면 완성 위협 아님
    g.player(0).hand.push({ ...hong[0]! });
    expect(Shodang.detect(g, 0).callable).toBe(false);
  });
});

describe('Shodang.resolve', () => {
  it('둘 다 수락 → 나가리', () => {
    expect(Shodang.resolve(0, 1, 2, true, true).outcome).toBe(ShodangOutcome.Nagari);
  });
  it('둘 다 거절 → 계속', () => {
    expect(Shodang.resolve(0, 1, 2, false, false).outcome).toBe(ShodangOutcome.Continue);
  });
  it('A만 수락 → 밀어주기(수락 A, 거절 B)', () => {
    const d = Shodang.resolve(0, 1, 2, true, false);
    expect(d.outcome).toBe(ShodangOutcome.Pushed);
    expect(d.accepter).toBe(1);
    expect(d.decliner).toBe(2);
  });
});

describe('Shodang.applyDokbak', () => {
  const mk = (net: number): PlayerResult => ({
    playerIndex: 0, net, pibak: false, gwangbak: false, meongbak: false, gobak: false, reverseGo: false, gukjinAsPi: false, goCount: 0, goMultiplier: 0,
  });

  it('수락자가 이기면 거절자가 호출자+거절자 몫 전액 독박, 호출자 면제', () => {
    // 승자=수락자(1) +14, 호출자(0) -7, 거절자(2) -7
    const settle = [mk(-7), mk(14), mk(-7)];
    const dokbak = Shodang.applyDokbak(settle, 3, 1, 0, 1, 2);
    expect(dokbak).toBe(2);
    expect(settle[0]!.net).toBe(0);   // 호출자 면제
    expect(settle[2]!.net).toBe(-14); // 거절자 독박(7+7)
    expect(settle[1]!.net).toBe(14);  // 승자 그대로
  });

  it('수락자가 못 이기면 재분배 없음', () => {
    const settle = [mk(-7), mk(-7), mk(14)]; // 승자=거절자(2)
    expect(Shodang.applyDokbak(settle, 3, 2, 0, 1, 2)).toBe(-1);
    expect(settle[0]!.net).toBe(-7);
  });
});
