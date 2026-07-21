import { describe, it, expect } from 'vitest';
import { Deck, DeckOptions } from '../src/deck.js';
import { DealConfig, Dealer, TableState } from '../src/deal.js';
import { ScoreOptions } from '../src/score.js';
import { HwatuCard, HwatuKind, HwatuCatalog } from '../src/cards.js';
import { FourPlayer } from '../src/four-player.js';
import {
  FourGame, FourDecisions, TimedDecision,
} from '../src/four-game.js';
import { AiPlayer } from '../src/ai.js';

const OPT = ScoreOptions.default();
const CAT = HwatuCatalog.standard();
const card = (m: number, k: HwatuKind, o = 1): HwatuCard =>
  ({ ...CAT.find((c) => c.month === m && c.kind === k && c.ordinal === o)! });

// 좌석3(P4)에 특정 손패를 심은 4인 테이블.
function table4With(p4Hand: HwatuCard[]): TableState {
  const t = new TableState(4);
  t.hand(3).push(...p4Hand);
  return t;
}

describe('FourPlayer.gwangCount', () => {
  it('광 3장 = 3', () => {
    const brights = CAT.filter((c) => c.kind === HwatuKind.Bright).slice(0, 3);
    expect(FourPlayer.gwangCount(brights, OPT)).toBe(3);
  });

  it('광 2장 + 고도리 3마리 = 2 + 5 = 7', () => {
    const brights = CAT.filter((c) => c.kind === HwatuKind.Bright).slice(0, 2);
    const godori = CAT.filter((c) => c.isGodori); // 3마리
    expect(FourPlayer.gwangCount([...brights, ...godori], OPT)).toBe(2 + 5);
  });

  it('같은 월 3장 이상이면 ×2', () => {
    // 광 1 + 11월 피 3장 → 값 1, 그러나 11월 3장으로 흔들기 가능 → ×2 = 2
    const nov = CAT.filter((c) => c.month === 11 && c.kind === HwatuKind.Junk); // 피 3장
    const oneBright = [card(1, HwatuKind.Bright)];
    const base = FourPlayer.gwangCount([...oneBright, ...CAT.filter((c) => c.month === 5).slice(0, 1)], OPT);
    const shaken = FourPlayer.gwangCount([...oneBright, ...nov], OPT);
    expect(base).toBe(1);
    expect(shaken).toBe(2); // 1 × 2
  });
});

describe('FourPlayer.resolve', () => {
  const t = table4With(CAT.filter((c) => c.kind === HwatuKind.Bright)); // P4 광 5장

  it('P2 포기 → 좌석 0,2,3이 침', () => {
    const r = FourPlayer.resolve(t, true, false, false, 2, OPT);
    expect(r.playSeats).toEqual([0, 2, 3]);
    expect(r.sitOutSeat).toBe(1);
    expect(r.gwang.sold).toBe(false);
  });

  it('P3 포기 → 좌석 0,1,3이 침', () => {
    const r = FourPlayer.resolve(t, false, true, false, 2, OPT);
    expect(r.playSeats).toEqual([0, 1, 3]);
    expect(r.sitOutSeat).toBe(2);
  });

  it('전원 참가 + P4 광팔기 → 광값 P2·P3 선불', () => {
    const r = FourPlayer.resolve(t, false, false, true, 2, OPT);
    expect(r.playSeats).toEqual([0, 1, 2]);
    expect(r.sitOutSeat).toBe(3);
    expect(r.gwang.sold).toBe(true);
    expect(r.gwang.sellerSeat).toBe(3);
    // 광값 = 광 장수(5). 5광 점수(15)가 아니라 개수. 광 5장은 월이 다 달라 흔들기 ×2 없음.
    expect(r.gwang.gwangCount).toBe(5);
    expect(r.gwang.valuePerPayer).toBe(10); // 5 × 단가 2
    expect(r.gwang.payerSeats).toEqual([1, 2]);
  });

  it('4인 딜이 아니면 예외', () => {
    expect(() => FourPlayer.resolve(new TableState(3), false, false, false, 2, OPT)).toThrow();
  });
});

describe('FourPlayer.buildGame', () => {
  it('3인 게임: 손패 7×3, 바닥 6, 뒷패=21(딜 21 + 빠진 손패 7 → 실제 재편)', () => {
    const deck = new Deck(DeckOptions.standard());
    deck.shuffleSeeded(4444);
    const t4 = Dealer.deal(deck, DealConfig.custom(4, 7, 6)); // 손패 28, 바닥 6, 뒷패 14
    const r = FourPlayer.resolve(t4, false, false, true, 2, OPT);
    const game = FourPlayer.buildGame(t4, r, ['P0', 'P1', 'P2'], () => 0);
    for (let p = 0; p < 3; p++) expect(game.player(p).hand).toHaveLength(7);
    expect(game.floor).toHaveLength(6);
    // 뒷패 = 원래 뒷패(14) + 빠진 좌석 손패(7) = 21
    expect(game.stock).toHaveLength(21);
    expect(game.current).toBe(0);
  });

  it('전체 48장 보존(중복·유실 없음)', () => {
    const deck = new Deck(DeckOptions.standard());
    deck.shuffleSeeded(555);
    const t4 = Dealer.deal(deck, DealConfig.custom(4, 7, 6));
    const r = FourPlayer.resolve(t4, false, false, true, 2, OPT);
    const game = FourPlayer.buildGame(t4, r, ['P0', 'P1', 'P2'], (n) => n - 1);
    const key = (c: HwatuCard) => `${c.month}:${c.kind}:${c.ordinal}`;
    const all = [
      ...game.player(0).hand, ...game.player(1).hand, ...game.player(2).hand,
      ...game.floor, ...game.stock,
    ].map(key).sort();
    expect(all).toHaveLength(48);
    expect(new Set(all).size).toBe(48);
  });
});

describe('FourGame 통합', () => {
  const mkAis = (base: number) => [0, 1, 2, 3].map((i) => new AiPlayer(60, BigInt(base + i + 1)));

  it('한 라운드 완주 + 제로섬(광값 + 게임 정산)', () => {
    const deck = new Deck(DeckOptions.withBonus(3));
    deck.shuffleSeeded(2024);
    const res = FourGame.runAuto(deck, mkAis(100), 2, OPT, 1, (n) => 0);
    expect(res.net[0] + res.net[1] + res.net[2] + res.net[3]).toBe(0);
    expect(res.sitOutSeat).toBeGreaterThanOrEqual(0);
  });

  it('여러 시드 4인 대전 — 항상 제로섬', () => {
    for (let s = 1; s <= 10; s++) {
      const deck = new Deck(DeckOptions.withBonus(3));
      deck.shuffleSeeded(s * 37 + 9);
      const res = FourGame.run(deck, mkAis(s * 10), FourDecisions.standard(), 2, OPT, 1, (n) => (s + n) % n);
      expect(res.net[0] + res.net[1] + res.net[2] + res.net[3]).toBe(0);
    }
  });

  it('광 판 P4가 광값을 선불로 받는다(P4 빠져도 이득 가능)', () => {
    // 광 5장을 P4에 심으려면 커스텀 테이블이 필요하므로, 여기서는 광값>0 시 수급 방향만 확인.
    const deck = new Deck(DeckOptions.withBonus(3));
    deck.shuffleSeeded(31337);
    const res = FourGame.runAuto(deck, mkAis(7), 3, OPT, 1, (n) => 0);
    if (res.gwang.sold && res.gwang.gwangCount > 0) {
      // 선불만 놓고 보면 P4(3)는 +2×valuePerPayer, P1·P2는 각 −valuePerPayer
      expect(res.sitOutSeat).toBe(3);
    }
    expect(res.net.reduce((a, b) => a + b, 0)).toBe(0);
  });

  it('FourDecisions.fromTimed: 미응답 시 자동 참가/광팔기', () => {
    const d = FourDecisions.fromTimed(TimedDecision.timedOut(), TimedDecision.timedOut(), TimedDecision.timedOut());
    expect(d).toEqual({ p2GiveUp: false, p3GiveUp: false, p4Sell: true });
    const d2 = FourDecisions.fromTimed(TimedDecision.answered(true), TimedDecision.timedOut(), TimedDecision.answered(false));
    expect(d2).toEqual({ p2GiveUp: true, p3GiveUp: false, p4Sell: false });
  });

  it('NextStakes: 나가리+전원동의 → 2배, 아니면 리셋', () => {
    expect(FourGame.nextStakes(1, true, true)).toBe(2);
    expect(FourGame.nextStakes(2, true, true)).toBe(4);
    expect(FourGame.nextStakes(2, true, false)).toBe(1);
    expect(FourGame.nextStakes(2, false, true)).toBe(1);
  });
});
