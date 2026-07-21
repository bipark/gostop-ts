// Gostop.AI.pas → TS 이식.
// 능력치(0~100) 하나로 실수율·고스톱 판단·수읽기·방어를 함께 조절하는 결정화 몬테카를로 AI.
// 능력이 높으면 안 보이는 카드를 크기 맞춰 무작위 분배한 가상 세계에서 게임 끝까지 시뮬레이션(롤아웃)하고,
// 낮으면 1-플라이 휴리스틱 + 무작위로 둔다. 시드 LCG로 완전히 결정론적.

import {
  HwatuCard, HwatuKind, RibbonKind,
} from './cards.js';
import { ScoreOptions, Scorer } from './score.js';
import {
  GameState, GamePhase, TurnEngine, PlayerAgent, RuleSet,
} from './play.js';

const LCG_MULTIPLIER = 6364136223846793005n;
const LCG_INCREMENT = 1442695040888963407n;
const U64_MASK = (1n << 64n) - 1n;

const MAX_DETERMINIZATIONS = 12; // 능력 100일 때 후보당 시뮬 세계 수
const TOP_K = 3;                 // 몬테카를로로 정밀 평가할 상위 후보 수
const ROLLOUT_ITER_CAP = 4000;   // 롤아웃 안전 상한
// 수읽기 값이 이 폭 안이면 사실상 동점으로 보고, 상대 족보를 덜 완성시키는 쪽을 고른다.
const DENY_TIE_EPS = 0.3;

/** AI가 선택할 행동의 종류. */
export enum AiMoveKind {
  PlayHand = 'playHand',
  Bomb = 'bomb',
  FlipOnly = 'flipOnly',
}

/** AI가 평가한 하나의 후보 수. */
export interface AiMove {
  kind: AiMoveKind;
  handIndex: number;   // PlayHand
  floorChoice: number; // PlayHand: 바닥 2장 매칭 시 선택(0/1)
  month: number;       // Bomb
  value: number;       // 1-플라이 휴리스틱 평가값
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

// 채점은 항상 표준 옵션으로(위협·기프트 평가는 룰셋 편차와 무관하게 일관되게).
const STD_SCORE = ScoreOptions.default();

/**
 * 능력치 기반 결정화 몬테카를로 컴퓨터 플레이어. (Delphi TAiPlayer)
 */
export class AiPlayer implements PlayerAgent {
  skill: number;
  /** 배짱(0~100, 기본 50): 높을수록 고를 외치는 성향. */
  goBias = 50;
  /** 욕심(0~100, 기본 50): 높을수록 득점 우선, 낮을수록 방어(견제) 우선. */
  greed = 50;
  /** 수읽기 동점 시 상대 족보 완성을 피할지(기본 켬). */
  denyTieBreak = true;
  /** 동점 갈림으로 선택이 바뀐 누적 횟수(검증용). */
  denyTieCount = 0;

  private seed: bigint;

  constructor(skill: number, seed: bigint = 88172645463325252n) {
    this.skill = clamp(Math.trunc(skill), 0, 100);
    this.seed = seed === 0n ? 88172645463325252n : seed;
  }

  private nextRandom(bound: number): number {
    if (bound <= 1) return 0;
    this.seed = (this.seed * LCG_MULTIPLIER + LCG_INCREMENT) & U64_MASK;
    return Number((this.seed >> 33n) % BigInt(bound));
  }

  private nextFloat(): number {
    this.seed = (this.seed * LCG_MULTIPLIER + LCG_INCREMENT) & U64_MASK;
    return Number(this.seed >> 11n) / 9007199254740992.0;
  }

  private skillFactor(): number {
    return this.skill / 100.0;
  }

  private simCount(): number {
    return Math.round(this.skillFactor() * MAX_DETERMINIZATIONS);
  }

  private cardValue(card: HwatuCard): number {
    switch (card.kind) {
      case HwatuKind.Bright:
        return 20;
      case HwatuKind.Animal:
        if (card.isGodori) return 13;
        if (card.isGukjin) return 11;
        return 8;
      case HwatuKind.Ribbon:
        return card.ribbon === RibbonKind.None ? 5 : 8;
      case HwatuKind.Junk:
        return card.junkValue >= 2 ? 4 : 2;
      case HwatuKind.Bonus:
        return 2 + card.junkValue;
      default:
        return 1;
    }
  }

  private opponentThreat(state: GameState, selfIndex: number): number {
    let result = 0;
    for (let p = 0; p < state.playerCount(); p++) {
      if (p === selfIndex) continue;
      const brk = Scorer.evaluate(state.player(p).captured, STD_SCORE);
      let threat = brk.total;
      if (brk.brightCount === 2) threat += 3;
      if (brk.brightCount === 4) threat += 2;
      result = Math.max(result, threat);
    }
    return result;
  }

  // 이 카드를 상대가 먹었을 때 오르는 점수(상대 중 최대). 실제 채점기로 규칙 그대로 반영.
  private opponentGiftRisk(state: GameState, selfIndex: number, card: HwatuCard): number {
    let result = 0;
    for (let p = 0; p < state.playerCount(); p++) {
      if (p === selfIndex) continue;
      const captured = state.player(p).captured;
      const base = Scorer.evaluate(captured, STD_SCORE).total;
      const withCard = Scorer.evaluate([...captured, card], STD_SCORE).total;
      result = Math.max(result, withCard - base);
    }
    return result;
  }

  // 이 수를 두면 상대에게 족보 완성 카드를 내주게 되는가(바닥에 남는 경우만).
  private moveGiftRisk(state: GameState, selfIndex: number, move: AiMove): number {
    if (move.kind !== AiMoveKind.PlayHand) return 0;
    const hand = state.player(selfIndex).hand;
    if (move.handIndex < 0 || move.handIndex >= hand.length) return 0;
    const card = hand[move.handIndex]!;
    if (card.kind === HwatuKind.Bonus) return 0;
    for (const f of state.floor) {
      if (f.month === card.month) return 0; // 짝이 있어 내가 먹는다
    }
    return this.opponentGiftRisk(state, selfIndex, card);
  }

  // 지정 월 매칭 중 가장 값 높은 것의 (매칭 목록 기준) 인덱스와 그 값.
  private bestFloorChoice(state: GameState, month: number): { index: number; value: number } {
    let index = 0;
    let value = 0;
    let seen = 0;
    for (const f of state.floor) {
      if (f.month === month) {
        const v = this.cardValue(f);
        if (v > value) {
          value = v;
          index = seen;
        }
        seen++;
      }
    }
    return { index, value };
  }

  private evaluateHandMove(
    state: GameState, selfIndex: number, handIndex: number, threat: number,
  ): { value: number; floorChoice: number } {
    const card = state.player(selfIndex).hand[handIndex]!;

    // 보너스패는 공짜 획득 + 재행동이므로 항상 우선 사용.
    if (card.kind === HwatuKind.Bonus) {
      return { value: this.cardValue(card) + 5, floorChoice: 0 };
    }

    let matchCount = 0;
    for (const f of state.floor) {
      if (f.month === card.month) matchCount++;
    }

    // 욕심이 높을수록 방어 가중을 줄이고 득점 우선.
    const defWeight = this.skillFactor() * (threat / 10.0) * ((100 - this.greed) / 50.0);

    if (matchCount === 0) {
      return { value: -this.cardValue(card) * (0.2 + defWeight), floorChoice: 0 };
    }

    let choice = this.bestFloorChoice(state, card.month);
    let choiceValue = choice.value;
    const floorChoice = choice.index;
    if (matchCount >= 3) {
      choiceValue = 0;
      for (const f of state.floor) {
        if (f.month === card.month) choiceValue += this.cardValue(f);
      }
    }

    return {
      value: choiceValue + this.cardValue(card) * 0.5 + choiceValue * defWeight,
      floorChoice,
    };
  }

  private generateMoves(engine: TurnEngine): AiMove[] {
    const state = engine.state;
    const self = state.current;
    const threat = this.opponentThreat(state, self);
    const list: AiMove[] = [];

    const hand = state.currentPlayer().hand;
    // 흔들기 커밋이 걸려 있으면 그 월(또는 보너스패)만 합법. 엔진이 거부하는 수는 애초에 생성하지 않는다.
    const mustMonth = engine.rules.enforceShakeMonth ? state.currentPlayer().pendingShakeMonth : 0;
    for (let i = 0; i < hand.length; i++) {
      const c = hand[i]!;
      if (mustMonth !== 0 && c.kind !== HwatuKind.Bonus && c.month !== mustMonth) continue;
      const { value, floorChoice } = this.evaluateHandMove(state, self, i, threat);
      list.push({ kind: AiMoveKind.PlayHand, handIndex: i, floorChoice, month: c.month, value });
    }

    const seenMonth = new Array<boolean>(13).fill(false);
    for (let i = 0; i < hand.length; i++) {
      const m = hand[i]!.month;
      if (m < 0 || m > 12 || seenMonth[m]) continue;
      seenMonth[m] = true;
      if (engine.canBomb(m)) {
        let bombValue = 6;
        for (const f of state.floor) {
          if (f.month === m) bombValue += this.cardValue(f);
        }
        list.push({ kind: AiMoveKind.Bomb, month: m, handIndex: -1, floorChoice: 0, value: bombValue });
      }
    }

    return list;
  }

  private greedyBest(moves: AiMove[]): AiMove {
    let best = 0;
    for (let i = 1; i < moves.length; i++) {
      if (moves[i]!.value > moves[best]!.value) best = i;
    }
    return moves[best]!;
  }

  private pickWithMistakes(moves: AiMove[], best: AiMove): AiMove {
    // 능력 0 → 15%만 최선수, 능력 100 → 항상 최선수.
    const bestProb = 0.15 + 0.85 * this.skillFactor();
    if (moves.length === 1 || this.nextFloat() <= bestProb) return best;
    return moves[this.nextRandom(moves.length)]!;
  }

  private chooseMove(moves: AiMove[]): AiMove {
    return this.pickWithMistakes(moves, this.greedyBest(moves));
  }

  private topKMoves(moves: AiMove[], k: number): AiMove[] {
    const sorted = moves.slice();
    // 값 내림차순 선택 정렬(후보 수가 적음).
    for (let i = 0; i < sorted.length - 1; i++) {
      for (let j = i + 1; j < sorted.length; j++) {
        if (sorted[j]!.value > sorted[i]!.value) {
          const tmp = sorted[i]!;
          sorted[i] = sorted[j]!;
          sorted[j] = tmp;
        }
      }
    }
    return sorted.slice(0, Math.min(k, sorted.length));
  }

  private executeMove(engine: TurnEngine, move: AiMove): void {
    switch (move.kind) {
      case AiMoveKind.Bomb:
        engine.playBomb(move.month);
        break;
      case AiMoveKind.FlipOnly:
        engine.flipOnly();
        break;
      default:
        engine.playHandCard(move.handIndex, move.floorChoice);
    }
  }

  // 안 보이는 카드(다른 플레이어 손패 + 뒷패)를 크기 맞춰 무작위 재분배한 가상 세계.
  private determinize(real: GameState, selfIndex: number): GameState {
    const result = real.clone();

    // 시뮬 격리: 손패를 뒤섞으므로 "그 월을 내야 한다"는 흔들기 커밋은 무의미해진다.
    // (남겨두면 뒤섞인 손패에 해당 월이 없어 롤아웃이 합법 수를 못 만드는 상황이 생긴다.)
    for (const p of result.players) p.pendingShakeMonth = 0;

    const pool: HwatuCard[] = [];
    const sizes: number[] = [];
    for (let p = 0; p < result.playerCount(); p++) {
      if (p === selfIndex) {
        sizes.push(-1);
        continue;
      }
      sizes.push(result.player(p).hand.length);
      pool.push(...result.player(p).hand);
      result.player(p).hand.length = 0;
    }
    pool.push(...result.stock);
    result.stock.length = 0;

    for (let i = pool.length - 1; i >= 1; i--) {
      const j = this.nextRandom(i + 1);
      const tmp = pool[i]!;
      pool[i] = pool[j]!;
      pool[j] = tmp;
    }

    let idx = 0;
    for (let p = 0; p < result.playerCount(); p++) {
      if (p === selfIndex) continue;
      for (let k = 0; k < sizes[p]!; k++) {
        result.player(p).hand.push(pool[idx]!);
        idx++;
      }
    }
    while (idx < pool.length) {
      result.stock.push(pool[idx]!);
      idx++;
    }

    return result;
  }

  private rolloutStep(engine: TurnEngine): void {
    const state = engine.state;

    if (state.phase === GamePhase.AwaitingGoStop) {
      const me = state.current;
      const score = engine.scoreOf(me).total;
      if (state.currentPlayer().hand.length >= 2 && score < 7) {
        engine.declareGo();
      } else {
        engine.declareStop();
      }
      return;
    }

    if (state.phase !== GamePhase.Playing) return;

    if (state.currentPlayer().hand.length === 0) {
      if (engine.canFlipOnly()) engine.flipOnly();
      return;
    }

    const moves = this.generateMoves(engine);
    if (moves.length === 0) return;
    this.executeMove(engine, this.greedyBest(moves));
  }

  private runToTerminal(engine: TurnEngine): void {
    let iter = 0;
    while (engine.state.phase !== GamePhase.Finished && iter < ROLLOUT_ITER_CAP) {
      this.rolloutStep(engine);
      iter++;
    }
  }

  // 가상세계에서 한 수(또는 고/스톱)를 두고 끝까지 굴려 내 순손익을 낸다.
  // 시뮬 세계는 결정화로 만들어져 이론상 불가능한 상태가 나올 수 있으므로, 예외는 0으로 흡수해
  // 실제 턴이 죽지 않게 한다(엔진 자체는 견고하며 정상 경로에선 던지지 않는다).
  private simulate(world: GameState, rules: RuleSet, apply: (e: TurnEngine) => void, selfIndex: number): number {
    try {
      const e = new TurnEngine(world, rules);
      e.collectEvents = false;
      apply(e);
      this.runToTerminal(e);
      return this.outcomeFromEngine(e, selfIndex);
    } catch {
      return 0;
    }
  }

  // 정산 순손익(고 보너스·배수·박 반영)을 결과값으로.
  private outcomeFromEngine(engine: TurnEngine, selfIndex: number): number {
    if (engine.state.winner < 0) return 0;
    const settle = engine.finalSettlement();
    if (selfIndex >= 0 && selfIndex < settle.length) return settle[selfIndex]!.net;
    return 0;
  }

  private doPlay(engine: TurnEngine): void {
    const state = engine.state;
    const self = state.current;

    // 낼 손패가 없으면 카드빚을 뒤집기로 갚는다(강제).
    if (state.currentPlayer().hand.length === 0) {
      if (engine.canFlipOnly()) engine.flipOnly();
      return;
    }

    const moves = this.generateMoves(engine);
    if (moves.length === 0) return;

    const sims = this.simCount();
    if (sims === 0) {
      // 저능력: 1-플라이 휴리스틱 + 무작위(실수)
      this.executeMove(engine, this.chooseMove(moves));
      return;
    }

    // 고능력: 상위 후보를 결정화 몬테카를로로 정밀 평가.
    const topK = this.topKMoves(moves, TOP_K);
    let bestValue = -1.0e18;
    let bestMove = topK[0]!;
    let bestGift = 1.0e18;
    for (let c = 0; c < topK.length; c++) {
      let sum = 0;
      const move = topK[c]!;
      for (let d = 0; d < sims; d++) {
        sum += this.simulate(this.determinize(state, self), engine.rules, (e) => this.executeMove(e, move), self);
      }
      const avg = sum / sims;

      const gift = this.denyTieBreak ? this.moveGiftRisk(state, self, topK[c]!) : 0;

      if (avg > bestValue + DENY_TIE_EPS) {
        bestValue = avg;
        bestMove = topK[c]!;
        bestGift = gift;
      } else if (this.denyTieBreak && avg >= bestValue - DENY_TIE_EPS && gift < bestGift) {
        // 동점 갈림 — 값은 그대로 두고 수만 바꾼다.
        bestValue = Math.max(bestValue, avg);
        bestMove = topK[c]!;
        bestGift = gift;
        this.denyTieCount++;
      } else if (avg > bestValue) {
        bestValue = avg;
        bestMove = topK[c]!;
        bestGift = gift;
      }
    }

    // MC 최선수에도 능력치 비례 실수를 적용.
    this.executeMove(engine, this.pickWithMistakes(moves, bestMove));
  }

  private doGoStop(engine: TurnEngine): void {
    const state = engine.state;
    const self = state.current;
    const score = engine.scoreOf(self).total;
    const sims = this.simCount();

    if (sims === 0) {
      // 저능력: 단순 휴리스틱 + 무작위(배짱이 높으면 고 쪽으로).
      const growth = state.currentPlayer().hand.length;
      const threat = this.opponentThreat(state, self) * this.skillFactor();
      const wantGo = growth >= 2 && threat < score + 2 + (this.goBias - 50) / 12.5 && score < 7;
      const quality = 0.4 + 0.6 * this.skillFactor();
      const decideGo = this.nextFloat() <= quality ? wantGo : this.nextRandom(2) === 0;
      if (decideGo) engine.declareGo();
      else engine.declareStop();
      return;
    }

    // 고능력: 스톱(지금 승리) vs 고(롤아웃 기대값)를 실제 정산 손익으로 비교.
    const stopValue = this.simulate(this.determinize(state, self), engine.rules, (e) => e.declareStop(), self);

    let goSum = 0;
    for (let d = 0; d < sims; d++) {
      goSum += this.simulate(this.determinize(state, self), engine.rules, (e) => e.declareGo(), self);
    }

    // 배짱 보정: 높으면 고 기대값을 후하게(±2점).
    if (goSum / sims + (this.goBias - 50) / 25.0 > stopValue) {
      engine.declareGo();
    } else {
      engine.declareStop();
    }
  }

  /** 현재 게임 단계에 맞는 행동을 1회 수행. */
  act(engine: TurnEngine): void {
    switch (engine.state.phase) {
      case GamePhase.Playing:
        this.doPlay(engine);
        break;
      case GamePhase.AwaitingGoStop:
        this.doGoStop(engine);
        break;
    }
  }
}
