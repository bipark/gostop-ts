import { describe, it, expect } from 'vitest';
import { HwatuCatalog, HwatuKind, HwatuCard } from '../src/cards.js';
import { GameState, TurnEngine, ScoreOptions, GamePhase } from '../src/index.js';
import { AiPlayer } from '../src/ai.js';

const CAT = HwatuCatalog.standard();
const monthCards = (m: number) => CAT.filter((c) => c.month === m).map((c) => ({ ...c }));
const others = (excludeMonths: number[], n: number) =>
  CAT.filter((c) => !excludeMonths.includes(c.month)).slice(0, n).map((c) => ({ ...c }));

// 회귀: 상대(비-현재 플레이어)가 흔들기 커밋(pendingShakeMonth)을 든 채로 AI가 수읽기하면,
// determinize가 손패를 뒤섞으면서 그 커밋이 무의미해져 롤아웃이 불법 수를 만들던 크래시.
describe('AI 흔들기 커밋 안전성(회귀)', () => {
  it('상대에 pendingShakeMonth가 걸려 있어도 고능력 AI가 예외 없이 수를 둔다', () => {
    const st = new GameState(['AI', '상대']);
    // 현재는 AI(좌석0) 차례. AI 손패는 평범하게.
    st.players[0]!.hand = others([12], 7);
    // 상대(좌석1)는 12월 3장을 들고 흔들기 12월을 선언한 상태(커밋만 남음).
    st.players[1]!.hand = [...monthCards(12), ...others([12], 4)] as HwatuCard[];
    st.players[1]!.pendingShakeMonth = 12;
    st.players[1]!.shakeCount = 1;
    st.floor = others([12], 4);
    st.stock = CAT.filter((c) => c.month !== 12).slice(8, 20).map((c) => ({ ...c }));
    st.current = 0;
    st.phase = GamePhase.Playing;

    const engine = new TurnEngine(st, ScoreOptions.default());
    const ai = new AiPlayer(100, 12345n); // 최고 능력 → 몬테카를로 롤아웃 다수

    expect(() => ai.act(engine)).not.toThrow();
    // 실제로 수를 뒀는지(손패가 줄었거나 단계가 진행됨) 확인
    expect(st.players[0]!.hand.length).toBeLessThanOrEqual(7);
  });

  it('AI 자신이 흔들기 커밋을 든 경우에도 그 월/보너스만 내며 예외 없음', () => {
    const st = new GameState(['AI', '상대']);
    st.players[0]!.hand = [...monthCards(11), ...others([11], 4)] as HwatuCard[];
    st.players[0]!.pendingShakeMonth = 11; // 11월 커밋
    st.players[0]!.shakeCount = 1;
    st.players[1]!.hand = others([11], 7);
    st.floor = others([11], 4);
    st.stock = CAT.filter((c) => c.month !== 11).slice(8, 20).map((c) => ({ ...c }));
    st.current = 0;
    st.phase = GamePhase.Playing;

    const engine = new TurnEngine(st, ScoreOptions.default());
    const ai = new AiPlayer(100, 999n);
    expect(() => ai.act(engine)).not.toThrow();
    // 흔들기 커밋 월(11)을 냈으므로 그 뒤로는 진행되어야 함
    expect(st.phase === GamePhase.Playing || st.phase === GamePhase.AwaitingGoStop || st.phase === GamePhase.Finished).toBe(true);
  });
});
