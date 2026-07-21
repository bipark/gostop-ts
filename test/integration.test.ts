import { describe, it, expect } from 'vitest';
import { Deck, DeckOptions } from '../src/deck.js';
import { DealConfig, Dealer, TableState } from '../src/deal.js';
import {
  GameState, TurnEngine, GamePhase, ScoreOptions,
} from '../src/index.js';

// 딜 결과(TableState)를 턴 엔진이 쓰는 GameState로 옮긴다(Board가 하던 배선).
function toGameState(table: TableState, names: string[]): GameState {
  const st = new GameState(names);
  for (let p = 0; p < table.playerCount(); p++) {
    st.players[p]!.hand = table.hand(p).slice();
  }
  st.floor = table.floor.slice();
  st.stock = table.stock.slice();
  return st;
}

// 아주 단순한 자동 플레이어로 한 판을 끝까지 진행(항상 첫 수, 항상 스톱).
function playToEnd(engine: TurnEngine): void {
  let guard = 0;
  while (engine.state.phase !== GamePhase.Finished) {
    if (guard++ > 5000) throw new Error('게임이 끝나지 않음(무한 루프 방지)');
    switch (engine.state.phase) {
      case GamePhase.AwaitingGoStop:
        engine.declareStop();
        break;
      case GamePhase.AwaitingFlipChoice:
        engine.resolveFlipChoice(0);
        break;
      case GamePhase.AwaitingBonusDraw:
        engine.resolveBonusDraw(0);
        break;
      case GamePhase.Playing:
        if (engine.canFlipOnly()) engine.flipOnly();
        else engine.playHandCard(0);
        break;
    }
  }
}

describe('풀 게임 통합(Deal → Play → 정산)', () => {
  for (const [nPlayers, seed] of [[2, 111], [3, 222], [3, 777], [2, 999]] as const) {
    it(`${nPlayers}인 시드 ${seed}: 크래시 없이 종료 + 정산 합계 0`, () => {
      const names = Array.from({ length: nPlayers }, (_, i) => `P${i}`);
      const deck = new Deck(DeckOptions.withBonus(3));
      deck.shuffleSeeded(seed);
      const table = Dealer.deal(deck, DealConfig.forPlayers(nPlayers));
      const engine = new TurnEngine(toGameState(table, names), ScoreOptions.default());

      // 딜 직후 자동 처리(보너스/총통/바닥뻑)
      if (!engine.applyHandChongtong() && !engine.applyFloorChongtong()) {
        engine.applyFloorBbeok();
        engine.applyFloorBonus();
      }

      playToEnd(engine);
      expect(engine.state.phase).toBe(GamePhase.Finished);

      const res = engine.finalSettlement();
      // 제로섬: 모든 순손익 합계는 0.
      const sum = res.reduce((s, r) => s + r.net, 0);
      expect(sum).toBe(0);
      // 승자가 있으면 정확히 한 명만 양수.
      if (engine.state.winner >= 0) {
        const positives = res.filter((r) => r.net > 0);
        expect(positives.length).toBeLessThanOrEqual(1);
      }
    });
  }

  it('여러 시드 연속 실행 — 항상 종료(안정성)', () => {
    for (let seed = 1; seed <= 40; seed++) {
      const n = (seed % 2) + 2; // 2 또는 3인
      const names = Array.from({ length: n }, (_, i) => `P${i}`);
      const deck = new Deck(DeckOptions.withBonus(3));
      deck.shuffleSeeded(seed * 13 + 1);
      const table = Dealer.deal(deck, DealConfig.forPlayers(n));
      const engine = new TurnEngine(toGameState(table, names), ScoreOptions.default());
      if (!engine.applyHandChongtong() && !engine.applyFloorChongtong()) {
        engine.applyFloorBbeok();
        engine.applyFloorBonus();
      }
      playToEnd(engine);
      const sum = engine.finalSettlement().reduce((s, r) => s + r.net, 0);
      expect(sum).toBe(0);
    }
  });
});
