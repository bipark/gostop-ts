import { describe, it, expect } from 'vitest';
import { Deck, DeckOptions } from '../src/deck.js';
import { DealConfig, Dealer, TableState } from '../src/deal.js';
import {
  GameState, TurnEngine, GamePhase, ScoreOptions, PlayerResult,
} from '../src/index.js';
import { AiPlayer } from '../src/ai.js';

function toGameState(table: TableState, names: string[]): GameState {
  const st = new GameState(names);
  for (let p = 0; p < table.playerCount(); p++) st.players[p]!.hand = table.hand(p).slice();
  st.floor = table.floor.slice();
  st.stock = table.stock.slice();
  return st;
}

// AI끼리 한 판을 끝까지 진행하고 정산을 반환. 뒤집기/보너스 선택은 자동(AI는 UI 토글 off).
function playAiGame(nPlayers: number, dealSeed: number, aiSeeds: bigint[], skills: number[]): PlayerResult[] {
  const names = Array.from({ length: nPlayers }, (_, i) => `P${i}`);
  const deck = new Deck(DeckOptions.withBonus(3));
  deck.shuffleSeeded(dealSeed);
  const table = Dealer.deal(deck, DealConfig.forPlayers(nPlayers));
  const engine = new TurnEngine(toGameState(table, names), ScoreOptions.default());
  engine.flipChoiceEnabled = false;
  engine.bonusDrawEnabled = false;

  const agents = skills.map((s, i) => new AiPlayer(s, aiSeeds[i]!));

  if (!engine.applyHandChongtong() && !engine.applyFloorChongtong()) {
    engine.applyFloorBbeok();
    engine.applyFloorBonus();
  }

  let guard = 0;
  while (engine.state.phase !== GamePhase.Finished) {
    if (guard++ > 20000) throw new Error('AI 게임 미종료');
    const phase = engine.state.phase;
    if (phase === GamePhase.Playing || phase === GamePhase.AwaitingGoStop) {
      agents[engine.state.current]!.act(engine);
    } else {
      // AI 경로에선 도달하지 않아야 함(토글 off)
      throw new Error(`예상 못한 단계: ${phase}`);
    }
  }
  return engine.finalSettlement();
}

describe('AI 결정론', () => {
  it('같은 시드·실력·딜 → 같은 결과(완전 재현)', () => {
    const a = playAiGame(3, 12345, [1n, 2n, 3n], [80, 50, 20]);
    const b = playAiGame(3, 12345, [1n, 2n, 3n], [80, 50, 20]);
    expect(a.map((r) => r.net)).toEqual(b.map((r) => r.net));
  });

  it('AI 시드가 다르면 대체로 다른 전개', () => {
    const a = playAiGame(3, 999, [10n, 20n, 30n], [70, 70, 70]);
    const b = playAiGame(3, 999, [11n, 21n, 31n], [70, 70, 70]);
    // 반드시 다르라고 강제하진 않되(우연히 같을 수 있음), 최소한 크래시 없이 정산이 나온다.
    expect(a).toHaveLength(3);
    expect(b).toHaveLength(3);
  });
});

describe('AI 완주 · 제로섬', () => {
  it('저능력(0) 순수 휴리스틱도 완주', () => {
    const res = playAiGame(3, 55, [1n, 2n, 3n], [0, 0, 0]);
    expect(res.reduce((s, r) => s + r.net, 0)).toBe(0);
  });

  it('고능력(100) 몬테카를로도 완주', () => {
    const res = playAiGame(2, 77, [7n, 8n], [100, 100]);
    expect(res.reduce((s, r) => s + r.net, 0)).toBe(0);
  });

  it('여러 시드 AI 대전 — 항상 제로섬', () => {
    for (let s = 1; s <= 12; s++) {
      const n = (s % 2) + 2;
      const skills = Array.from({ length: n }, (_, i) => (i === 0 ? 90 : 30));
      const aiSeeds = Array.from({ length: n }, (_, i) => BigInt(s * 100 + i + 1));
      const res = playAiGame(n, s * 17 + 3, aiSeeds, skills);
      expect(res.reduce((sum, r) => sum + r.net, 0)).toBe(0);
    }
  });
});

describe('실력차(고수 vs 하수)', () => {
  it('2인 다판 누적: 고능력(85)이 하수(15)보다 이득', () => {
    // 2인 제로섬이므로 P0 누적 net > 0 이면 고수 우위.
    let p0net = 0;
    const GAMES = 40;
    for (let g = 0; g < GAMES; g++) {
      // 딜 시드마다 다르게, AI 시드도 게임별로 분리.
      const res = playAiGame(2, g * 31 + 5, [BigInt(g + 1), BigInt(1000 + g)], [85, 15]);
      p0net += res[0]!.net;
    }
    expect(p0net).toBeGreaterThan(0);
  });
});
