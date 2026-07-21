import { describe, it, expect } from 'vitest';
import { HwatuCard, HwatuKind, HwatuCatalog } from '../src/cards.js';
import { ScoreOptions } from '../src/score.js';
import {
  GameState, TurnEngine, GamePhase, PlayEventKind,
} from '../src/play.js';

const CAT = HwatuCatalog.standard();
function card(month: number, kind: HwatuKind, ordinal = 1): HwatuCard {
  const c = CAT.find((x) => x.month === month && x.kind === kind && x.ordinal === ordinal);
  if (!c) throw new Error(`no card ${month}/${kind}/${ordinal}`);
  return { ...c };
}
const K = HwatuKind;

// 손패/바닥/뒷패를 직접 세팅한 엔진. stock의 마지막 원소가 다음 뒤집힐 카드(맨 위).
function engine(
  hands: HwatuCard[][], floor: HwatuCard[], stock: HwatuCard[], nPlayers = 3,
): TurnEngine {
  const names = Array.from({ length: nPlayers }, (_, i) => `P${i}`);
  const st = new GameState(names);
  hands.forEach((h, i) => { st.players[i]!.hand = h; });
  st.floor = floor;
  st.stock = stock;
  return new TurnEngine(st, ScoreOptions.default());
}
const kinds = (e: TurnEngine) => e.state.events.map((ev) => ev.kind);

describe('기본 내기/먹기', () => {
  it('바닥 1장과 매칭 → 먹기', () => {
    const e = engine(
      [[card(1, K.Bright)], [card(9, K.Junk, 1)], []], // P1 필러 → 턴 진행 가능
      [card(1, K.Ribbon)],
      [card(6, K.Junk, 1)], // 뒤집으면 매칭 없음 → 바닥
    );
    const stop = e.playHandCard(0);
    expect(stop).toBe(false);
    expect(e.state.players[0]!.captured).toHaveLength(2); // 광 + 띠
    expect(e.state.current).toBe(1); // 턴 넘어감
  });

  it('매칭 없음 → 바닥에 놓기(Place)', () => {
    const e = engine(
      [[card(5, K.Junk, 1)], [], []],
      [card(6, K.Junk, 1)],
      [card(7, K.Junk, 1)],
    );
    e.playHandCard(0);
    expect(e.state.players[0]!.captured).toHaveLength(0);
    expect(kinds(e)).toContain(PlayEventKind.Place);
    expect(e.state.floor.map((c) => c.month).sort()).toEqual([5, 6, 7]);
  });
});

describe('뻑', () => {
  it('손패 1매칭 + 뒤집기 같은 월 → 뻑(3장 바닥, 아무도 못 먹음)', () => {
    const e = engine(
      [[card(1, K.Bright)], [], []],
      [card(1, K.Ribbon)],
      [card(1, K.Junk, 1)], // 뒤집으면 1월
    );
    e.playHandCard(0);
    expect(kinds(e)).toContain(PlayEventKind.Bbeok);
    expect(e.state.players[0]!.captured).toHaveLength(0);
    expect(e.state.floor.filter((c) => c.month === 1)).toHaveLength(3);
    expect(e.state.bbeokCreator.get(1)).toBe(0);
    expect(e.state.players[0]!.bbeokCount).toBe(1);
  });
});

describe('쪽 / 따닥 / 쓸', () => {
  it('쪽: 빈 월에 놓은 카드를 뒤집어 먹음', () => {
    const e = engine(
      [[card(5, K.Junk, 1), card(12, K.Junk, 1)], [], []], // 필러로 마지막장 회피
      [card(6, K.Junk, 1)],
      [card(5, K.Junk, 2)], // 뒤집으면 5월 → 방금 놓은 5월 먹음
    );
    e.playHandCard(0);
    expect(kinds(e)).toContain(PlayEventKind.Jjok);
  });

  it('따닥: 손패로 먹고 뒤집은 것도 같은 월로 먹음', () => {
    const e = engine(
      [[card(5, K.Junk, 1), card(12, K.Junk, 1)], [], []],
      [card(5, K.Ribbon), card(5, K.Animal), card(6, K.Junk, 1)], // 6월은 바닥 잔류용
      [card(5, K.Junk, 2)],
    );
    e.playHandCard(0);
    expect(kinds(e)).toContain(PlayEventKind.Ttadak);
    expect(kinds(e)).not.toContain(PlayEventKind.Sseul); // 바닥에 6월 잔류
  });

  it('쓸: 손패로 먹고 뒤집어 바닥을 마저 비우면 싹쓸이', () => {
    // 손패 6으로 6띠를 먹어 바닥엔 7피만 남고, 뒤집은 7띠가 그 7피를 먹어 바닥이 빈다.
    // (뻑 조건은 손패 월과 뒤집기 월이 같아야 하므로 6≠7 → 뻑 아님)
    const e = engine(
      [[card(6, K.Junk, 1), card(12, K.Junk, 1)], [], []],
      [card(6, K.Ribbon), card(7, K.Junk, 1)],
      [card(7, K.Ribbon)], // 뒤집으면 7월 → 바닥 7피 먹고 바닥 비움
    );
    e.playHandCard(0);
    expect(kinds(e)).toContain(PlayEventKind.Sseul);
  });
});

describe('피 뺏기', () => {
  it('쪽 성립 시 상대 피 1장씩 가져옴', () => {
    const e = engine(
      [[card(5, K.Junk, 1), card(12, K.Junk, 1)], [], []],
      [card(6, K.Junk, 1)],
      [card(5, K.Junk, 2)],
    );
    // 상대에게 피 지급
    e.state.players[1]!.captured.push(card(7, K.Junk, 1));
    e.state.players[2]!.captured.push(card(8, K.Junk, 1));
    e.playHandCard(0);
    // P0가 쪽으로 상대 2명 피 1장씩 회수
    const p0junk = e.state.players[0]!.captured.filter((c) => c.kind === K.Junk).length;
    expect(p0junk).toBeGreaterThanOrEqual(4); // 5-1,5-2 + 뺏은 2장
    expect(e.state.players[1]!.captured).toHaveLength(0);
  });
});

describe('고/스톱 · 최소 점수', () => {
  it('3인: 3점 도달 → 고/스톱 대기(true)', () => {
    const e = engine(
      [[card(8, K.Bright)], [], []],
      [card(8, K.Junk, 1)],
      [card(6, K.Junk, 1)],
    );
    // 광 2장 미리 보유 → 이번에 3광
    e.state.players[0]!.captured.push(card(1, K.Bright), card(3, K.Bright));
    const stop = e.playHandCard(0);
    expect(stop).toBe(true);
    expect(e.state.phase).toBe(GamePhase.AwaitingGoStop);
  });

  it('2인: 3점은 부족(7점 필요) → 그냥 턴 넘김(false)', () => {
    const e = engine(
      [[card(8, K.Bright)], [card(9, K.Junk, 1)]], // P1 필러 → 턴 진행 가능
      [card(8, K.Junk, 1)],
      [card(6, K.Junk, 1)],
      2,
    );
    e.state.players[0]!.captured.push(card(1, K.Bright), card(3, K.Bright));
    const stop = e.playHandCard(0);
    expect(stop).toBe(false);
    expect(e.state.phase).toBe(GamePhase.Playing);
  });

  it('스톱 선언 → 승자 확정 + 정산(3광 광박 ×2)', () => {
    const e = engine(
      [[card(8, K.Bright)], [], []],
      [card(8, K.Junk, 1)],
      [card(6, K.Junk, 1)],
    );
    e.state.players[0]!.captured.push(card(1, K.Bright), card(3, K.Bright));
    e.playHandCard(0);
    e.declareStop();
    const res = e.finalSettlement();
    expect(res[0]!.net).toBe(12); // 3점 × 광박2 × 2명
    expect(res[1]!.net).toBe(-6);
    expect(res[2]!.net).toBe(-6);
    expect(res[1]!.gwangbak).toBe(true);
  });
});

describe('총통', () => {
  it('손패 같은 월 4장 → 즉시 승리 + 고정 점수', () => {
    const nov = CAT.filter((c) => c.month === 11).map((c) => ({ ...c })); // 광+피3 = 4장
    const e = engine([nov, [], []], [], []);
    expect(e.applyHandChongtong()).toBe(true);
    expect(e.state.phase).toBe(GamePhase.Finished);
    expect(e.state.winner).toBe(0);
    const res = e.finalSettlement();
    expect(res[0]!.net).toBe(6); // 3인 고정 3점 × 2명
    expect(res[1]!.net).toBe(-3);
  });
});

describe('흔들기', () => {
  it('흔든 월과 다른 카드를 내면 예외', () => {
    const e = engine(
      [[card(9, K.Animal), card(9, K.Ribbon), card(9, K.Junk, 1), card(1, K.Bright)], [], []],
      [],
      [card(6, K.Junk, 1)],
    );
    e.declareShake(9);
    expect(e.state.players[0]!.shakeCount).toBe(1);
    expect(e.state.players[0]!.pendingShakeMonth).toBe(9);
    expect(() => e.playHandCard(3)).toThrow(); // 1월 카드 → 위반
  });
});

describe('폭탄 · 카드빚', () => {
  it('폭탄: 손패 3장 + 바닥 회수, 배수 증가, 카드빚 2', () => {
    const e = engine(
      [[card(1, K.Bright), card(1, K.Ribbon), card(1, K.Junk, 2), card(12, K.Junk, 1)], [], []],
      [card(1, K.Junk, 1)],
      [card(6, K.Junk, 1)],
    );
    expect(e.canBomb(1)).toBe(true);
    e.playBomb(1);
    expect(e.state.players[0]!.captured.filter((c) => c.month === 1)).toHaveLength(4);
    expect(e.state.players[0]!.shakeCount).toBe(1);
    expect(e.state.players[0]!.cardDebt).toBe(2);
  });
});

describe('GameState.clone 격리', () => {
  it('복제본을 바꿔도 원본 불변(깊은 복사)', () => {
    const e = engine([[card(1, K.Bright)], [], []], [card(3, K.Bright)], []);
    const clone = e.state.clone();
    clone.players[0]!.hand[0]!.gukjinLocked = true;
    clone.players[0]!.hand.push(card(5, K.Junk, 1));
    clone.floor.pop();
    expect(e.state.players[0]!.hand).toHaveLength(1);
    expect(e.state.players[0]!.hand[0]!.gukjinLocked).toBe(false);
    expect(e.state.floor).toHaveLength(1);
  });
});
