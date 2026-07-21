// Gostop.Play.pas → TS 이식.
// 고스톱 한 판의 턴 엔진: 손패 내기 · 뒷패 뒤집기 · 먹기 · 뻑/쪽/따닥/쓸 · 피 이동 ·
// 고/스톱 · 폭탄/흔들기 · 총통 · 국진 처리 · 최종 정산(피박/광박/멍박/고박/역고).
//
// Delphi 값 타입(record)은 데이터 객체로, 클래스는 TS 클래스로 옮겼다. 핵심 주의점:
//   - 카드 객체는 리스트 간 "이동"(같은 참조 이동)으로 다루되, GameState.clone()은 시뮬레이션
//     격리를 위해 모든 카드를 깊은 복사한다(원본과 참조 공유 금지).
//   - 뻑 더미에 묻는 보너스패는 월을 바꾼 복제본을 만들어 바닥에 넣는다.

import {
  HwatuCard, HwatuKind, HwatuError,
} from './cards.js';
import {
  ScoreOptions, ScoreBreakdown, Scorer,
} from './score.js';

// [0, bound) 정수 난수(운 보정용). 결정적 테스트를 위해 주입 가능.
// (deal.ts가 동명의 타입을 export 하므로 여기서는 로컬 타입으로 둔다.)
type RandomBelow = (bound: number) => number;
const defaultRandomBelow: RandomBelow = (bound) => Math.floor(Math.random() * bound);

/** 한 턴 진행 중 발생한 사건의 종류. */
export enum PlayEventKind {
  Place = 'place',             // 매칭 없이 바닥에 놓음
  Capture = 'capture',         // 카드를 먹음
  BonusCapture = 'bonusCapture', // 보너스패 획득
  Bbeok = 'bbeok',             // 뻑
  Jabbeok = 'jabbeok',         // 자뻑
  Yeonbbeok = 'yeonbbeok',     // 연뻑
  Cheotbbeok = 'cheotbbeok',   // 첫뻑
  Sambbeok = 'sambbeok',       // 쓰리뻑
  Jjok = 'jjok',               // 쪽
  Ttadak = 'ttadak',           // 따닥
  Sseul = 'sseul',             // 쓸(싹쓸이)
  Bomb = 'bomb',               // 폭탄
  Shake = 'shake',             // 흔들기
  Chongtong = 'chongtong',     // 총통
  PiSteal = 'piSteal',         // 피 이동
  GoStop = 'goStop',           // 고/스톱 선택 가능
  Go = 'go',                   // 고 선언
  ReverseGo = 'reverseGo',     // 역고
  Stop = 'stop',               // 스톱 선언
  TurnPass = 'turnPass',       // 턴 넘어감
  Finished = 'finished',       // 게임 종료
}

/** 턴 진행 사건 1건. */
export interface PlayEvent {
  kind: PlayEventKind;
  /** 사건 주체 플레이어 인덱스(해당 없으면 -1). */
  playerIndex: number;
  /** 관련 월(해당 없으면 0). */
  month: number;
  text: string;
  /** 피를 뺏긴 플레이어 인덱스(PiSteal 전용, 해당 없으면 -1). */
  victimIndex: number;
}

/** 게임 진행 단계. */
export enum GamePhase {
  Playing = 'playing',
  AwaitingGoStop = 'awaitingGoStop',
  AwaitingFlipChoice = 'awaitingFlipChoice',
  AwaitingBonusDraw = 'awaitingBonusDraw',
  Finished = 'finished',
}

/** 플레이어 1명의 상태(손패·먹은 패·고 횟수). */
export class Player {
  hand: HwatuCard[] = [];
  captured: HwatuCard[] = [];
  name: string;
  goCount = 0;
  lastGoScore = 0;
  shakeCount = 0;
  cardDebt = 0;
  pendingShakeMonth = 0;
  bbeokCount = 0;
  reverseGo = false;

  constructor(name: string) {
    this.name = name;
  }
}

const cloneCard = (c: HwatuCard): HwatuCard => ({ ...c });

/** 게임 전체 상태(플레이어들·바닥·뒷패·차례·단계·사건 로그). */
export class GameState {
  readonly players: Player[];
  floor: HwatuCard[] = [];
  stock: HwatuCard[] = [];
  current = 0;
  phase: GamePhase = GamePhase.Playing;
  winner = -1;
  events: PlayEvent[] = [];
  /** 바닥에 남은 뻑 더미의 월→생성자(플레이어 인덱스, -1=바닥) 매핑. */
  bbeokCreator = new Map<number, number>();
  /** 지금까지 손패를 낸(플레이한) 총 횟수. 첫뻑 판정에 사용. */
  playCount = 0;
  /** 쓰리뻑으로 즉시 승리한 판인지. */
  threeBbeok = false;

  constructor(playerNames: readonly string[]) {
    this.players = playerNames.map((n) => new Player(n));
  }

  /** 현재 상태를 깊은 복사한 독립 인스턴스(사건 로그는 비운 채). AI 시뮬레이션용. */
  clone(): GameState {
    const copy = new GameState(this.players.map((p) => p.name));
    for (let i = 0; i < this.players.length; i++) {
      const src = this.players[i]!;
      const dst = copy.players[i]!;
      dst.hand = src.hand.map(cloneCard);
      dst.captured = src.captured.map(cloneCard);
      dst.goCount = src.goCount;
      dst.lastGoScore = src.lastGoScore;
      dst.shakeCount = src.shakeCount;
      dst.cardDebt = src.cardDebt;
      dst.pendingShakeMonth = src.pendingShakeMonth;
      dst.bbeokCount = src.bbeokCount;
      dst.reverseGo = src.reverseGo;
    }
    copy.floor = this.floor.map(cloneCard);
    copy.stock = this.stock.map(cloneCard);
    copy.current = this.current;
    copy.phase = this.phase;
    copy.winner = this.winner;
    copy.playCount = this.playCount;
    copy.threeBbeok = this.threeBbeok;
    copy.bbeokCreator = new Map(this.bbeokCreator);
    return copy;
  }

  player(index: number): Player {
    if (index < 0 || index >= this.players.length) {
      throw new HwatuError(`플레이어 인덱스 오류: ${index} (총 ${this.players.length}명)`);
    }
    return this.players[index]!;
  }

  currentPlayer(): Player {
    return this.players[this.current]!;
  }

  playerCount(): number {
    return this.players.length;
  }
}

/** 게임 종료 시 한 플레이어의 최종 정산 결과. */
export interface PlayerResult {
  playerIndex: number;
  /** 순손익(+받음 / −지불). 승자 양수, 패자 음수, 나가리 0. */
  net: number;
  pibak: boolean;
  gwangbak: boolean;
  meongbak: boolean;
  gobak: boolean;
  reverseGo: boolean;
  gukjinAsPi: boolean;
  goCount: number;
  goMultiplier: number;
}

/** 게임 룰 설정 묶음: 점수/정산 옵션에 엔진 동작 토글을 더한 것. */
export interface RuleSet {
  score: ScoreOptions;
  /** 쓸/따닥/쪽/자뻑 시 상대당 뺏는 피 장수(기본 1). */
  piStealPerEvent: number;
  /** 흔들면 그 월의 카드를 실제로 내야 하는가(기본 true). */
  enforceShakeMonth: boolean;
}

export const RuleSet = {
  default(): RuleSet {
    return {
      score: ScoreOptions.default(),
      piStealPerEvent: 1,
      enforceShakeMonth: true,
    };
  },
};

/** 턴 엔진 위에서 한 플레이어의 행동을 결정·실행하는 에이전트 계약. */
export interface PlayerAgent {
  act(engine: TurnEngine): void;
}

// 바닥의 월별(1~12) 장수(보너스패 제외). 0번 미사용.
function countFloorMonths(state: GameState): number[] {
  const result = new Array<number>(13).fill(0);
  for (const card of state.floor) {
    if (card.month >= 1 && card.month <= 12) result[card.month]!++;
  }
  return result;
}

/**
 * 고스톱 한 턴을 규칙대로 진행하는 엔진. (Delphi TTurnEngine)
 */
export class TurnEngine {
  readonly state: GameState;
  readonly rules: RuleSet;
  onEvent: ((e: PlayEvent) => void) | null = null;
  /** 뒤집은 패가 바닥 2장(다른 종류)과 매칭 시 선택을 요구할지(UI만 true). 기본 false. */
  flipChoiceEnabled = false;
  /** 보너스패를 낼 때 뒷패를 펼쳐 고르게 할지(UI만 true). 기본 false. */
  bonusDrawEnabled = false;
  /** 이벤트 기록·콜백 여부(기본 true). AI 롤아웃은 false. */
  collectEvents = true;
  /** 플레이어별 이번 판 운(0~100). 비어 있으면 보정 없음. */
  playerLuck: number[] = [];
  /** 운 보정용 난수원(주입 가능). */
  randomBelow: RandomBelow = defaultRandomBelow;

  // 이번 턴 임시 상태
  private pendingBonus: HwatuCard[] = []; // 손에서 내려놓은 보너스패(뻑이면 함께 묻힘)
  private flipBonus: HwatuCard[] = [];    // 뒷패 뒤집기에서 획득한 보너스패
  private flipCard: HwatuCard | null = null;
  private flipOpt0: HwatuCard | null = null;
  private flipOpt1: HwatuCard | null = null;
  private flipHandMonth = 0;
  private flipHandCaptured = false;
  private flipHandPlaced = false;

  constructor(state: GameState, rules: RuleSet | ScoreOptions) {
    this.state = state;
    // ScoreOptions만 넘어오면 기본 룰셋에 얹는다(Delphi 두 번째 생성자).
    if ('score' in rules && 'piStealPerEvent' in rules) {
      this.rules = rules as RuleSet;
    } else {
      this.rules = { ...RuleSet.default(), score: rules as ScoreOptions };
    }
  }

  private addEvent(
    kind: PlayEventKind, playerIndex: number, month: number, text: string, victimIndex = -1,
  ): void {
    if (!this.collectEvents) return;
    const e: PlayEvent = { kind, playerIndex, month, text, victimIndex };
    this.state.events.push(e);
    if (this.onEvent) this.onEvent(e);
  }

  // 바닥에서 지정 월과 매칭되는 인덱스 목록.
  private matchIndices(month: number): number[] {
    const result: number[] = [];
    const floor = this.state.floor;
    for (let i = 0; i < floor.length; i++) {
      if (floor[i]!.month === month) result.push(i);
    }
    return result;
  }

  private captureInto(captured: HwatuCard[], indices: number[], choice: number): void {
    if (indices.length === 0) return;
    const floor = this.state.floor;

    // 뻑 더미가 있거나 3장 이상이면 선택 없이 전부 가져간다.
    const month = floor[indices[0]!]!.month;
    if (indices.length >= 3 || (indices.length >= 2 && this.state.bbeokCreator.has(month))) {
      for (let k = indices.length - 1; k >= 0; k--) {
        captured.push(floor[indices[k]!]!);
        floor.splice(indices[k]!, 1);
      }
      return;
    }

    let pick = 0;
    if (indices.length === 2) {
      if (choice >= 0 && choice < 2) {
        pick = choice;
      } else if (this.captureRank(floor[indices[1]!]!) > this.captureRank(floor[indices[0]!]!)) {
        // choice < 0(자동): 값 높은 카드
        pick = 1;
      }
    }
    captured.push(floor[indices[pick]!]!);
    floor.splice(indices[pick]!, 1);
  }

  // 획득 우선순위: 광 > 열끗 > 띠 > 피(쌍피>피).
  private captureRank(card: HwatuCard): number {
    switch (card.kind) {
      case HwatuKind.Bright: return 100;
      case HwatuKind.Animal: return 80;
      case HwatuKind.Ribbon: return 60;
      case HwatuKind.Junk:
      case HwatuKind.Bonus: return 10 + card.junkValue;
      default: return 0;
    }
  }

  private stealOnePi(winnerIndex: number, victimIndex: number): boolean {
    if (winnerIndex === victimIndex) return false;

    const victim = this.state.player(victimIndex);
    // 가장 값 낮은 일반 피 1장(단피→쌍피). 쌍피만 있으면 쌍피.
    let bestIdx = -1;
    let bestValue = Number.MAX_SAFE_INTEGER;
    for (let i = 0; i < victim.captured.length; i++) {
      const card = victim.captured[i]!;
      if (card.kind === HwatuKind.Junk || card.kind === HwatuKind.Bonus) {
        if (card.junkValue < bestValue) {
          bestValue = card.junkValue;
          bestIdx = i;
        }
      }
    }

    // 낼 피가 없으면 국진도 넘기지 않고, 소유 국진은 열끗 고정(쌍피 전환권 상실).
    if (bestIdx < 0) {
      for (let i = 0; i < victim.captured.length; i++) {
        const c = victim.captured[i]!;
        if (c.isGukjin && !c.gukjinLocked) {
          c.gukjinLocked = true;
          this.addEvent(PlayEventKind.PiSteal, winnerIndex, 0,
            `${victim.name}: 낼 피가 없어 국진이 열끗 고정(쌍피 전환 불가)`, victimIndex);
          break;
        }
      }
      return false;
    }

    const winner = this.state.player(winnerIndex);
    const pi = victim.captured[bestIdx]!;
    victim.captured.splice(bestIdx, 1);
    winner.captured.push(pi);
    this.addEvent(PlayEventKind.PiSteal, winnerIndex, 0,
      `${winner.name} ← ${victim.name} 피 1장`, victimIndex);
    return true;
  }

  private stealPiFromOthers(winnerIndex: number): void {
    for (let p = 0; p < this.state.playerCount(); p++) {
      for (let k = 0; k < this.rules.piStealPerEvent; k++) {
        if (!this.stealOnePi(winnerIndex, p)) break;
      }
    }
  }

  private resolveBbeokCapture(month: number): void {
    const creator = this.state.bbeokCreator.get(month);
    if (creator === undefined) return;
    this.state.bbeokCreator.delete(month);

    const name = this.state.currentPlayer().name;
    if (creator === this.state.current) {
      // 자뻑: 상대 전원에게서 피 2장씩
      this.addEvent(PlayEventKind.Jabbeok, this.state.current, month, `${name} 자뻑! (${month}월)`);
      this.stealPiFromOthers(this.state.current);
      this.stealPiFromOthers(this.state.current);
    } else {
      // 남의 뻑 회수: 상대 전원에게서 피 1장씩
      this.addEvent(PlayEventKind.PiSteal, this.state.current, month, `${name} 뻑 회수 (${month}월)`);
      this.stealPiFromOthers(this.state.current);
    }
  }

  /** 딜 직후 바닥의 보너스패를 선이 자동 획득하고 뒷패로 보충. 딜 후 1회. */
  applyFloorBonus(): void {
    if (this.state.phase !== GamePhase.Playing || this.state.playCount > 0) return;

    let idx = 0;
    while (idx < this.state.floor.length) {
      if (this.state.floor[idx]!.kind === HwatuKind.Bonus) {
        const card = this.state.floor[idx]!;
        this.state.floor.splice(idx, 1);
        this.state.currentPlayer().captured.push(card);
        this.addEvent(PlayEventKind.BonusCapture, this.state.current, 0,
          `${this.state.currentPlayer().name} 바닥 보너스패 획득(선)`);
        const fill = this.drawNonBonus(this.state.currentPlayer());
        if (fill) this.state.floor.push(fill);
      } else {
        idx++;
      }
    }
  }

  /** 딜 직후 바닥 총통(같은 월 4장)이면 선의 즉시 승리로 종료. */
  applyFloorChongtong(): boolean {
    if (this.state.phase !== GamePhase.Playing || this.state.playCount > 0) return false;
    const counts = countFloorMonths(this.state);
    for (let m = 1; m <= 12; m++) {
      if (counts[m]! >= 4) {
        this.state.phase = GamePhase.Finished;
        this.state.winner = this.state.current;
        this.addEvent(PlayEventKind.Chongtong, this.state.current, m,
          `바닥에 ${m}월 4장 총통! ${this.state.currentPlayer().name}(선) 즉시 승리`);
        return true;
      }
    }
    return false;
  }

  /** 딜 직후 바닥에 같은 월 3장이면 뻑 더미(창조자 -1)로 등록. */
  applyFloorBbeok(): void {
    if (this.state.phase !== GamePhase.Playing || this.state.playCount > 0) return;
    const counts = countFloorMonths(this.state);
    for (let m = 1; m <= 12; m++) {
      if (counts[m] === 3 && !this.state.bbeokCreator.has(m)) {
        this.state.bbeokCreator.set(m, -1);
        this.addEvent(PlayEventKind.Bbeok, -1, m, `바닥에 ${m}월 3장이 겹쳐 뻑으로 쌓임`);
      }
    }
  }

  private resolveThreePileSteal(month: number): void {
    if (this.state.bbeokCreator.has(month)) {
      this.resolveBbeokCapture(month);
    } else {
      this.addEvent(PlayEventKind.PiSteal, this.state.current, month,
        `${this.state.currentPlayer().name} 바닥 ${month}월 3장 쓸어먹기 — 피 받기`);
      this.stealPiFromOthers(this.state.current);
    }
  }

  // 뒤집었을 때의 이득 점수(운 보정 판단용).
  private flipBenefit(card: HwatuCard): number {
    if (card.kind === HwatuKind.Bonus) return 6;
    let result = 0;
    for (const c of this.state.floor) {
      if (c.month === card.month) {
        const gain = 5 + Math.floor(this.captureRank(c) / 10);
        if (gain > result) result = gain;
      }
    }
    return result;
  }

  // 뒷패에서 일반패 1장을 뽑아 반환(보너스패는 즉시 획득하고 계속 뒤집음). 없으면 null.
  private drawNonBonus(player: Player): HwatuCard | null {
    const stock = this.state.stock;
    // 운 보정: 위 2장 은밀 교환.
    if (stock.length >= 2 && this.state.current >= 0 && this.state.current < this.playerLuck.length) {
      const bias = this.playerLuck[this.state.current]! - 50;
      if (bias !== 0 && this.randomBelow(100) < Math.abs(bias)) {
        const topIdx = stock.length - 1;
        const topBen = this.flipBenefit(stock[topIdx]!);
        const secBen = this.flipBenefit(stock[topIdx - 1]!);
        const wantSwap = bias > 0 ? secBen > topBen : secBen < topBen;
        if (wantSwap) {
          const tmp = stock[topIdx]!;
          stock[topIdx] = stock[topIdx - 1]!;
          stock[topIdx - 1] = tmp;
        }
      }
    }

    this.flipBonus = [];
    while (stock.length > 0) {
      const top = stock.pop()!;
      if (top.kind === HwatuKind.Bonus) {
        player.captured.push(top);
        this.flipBonus.push(top);
        this.addEvent(PlayEventKind.BonusCapture, this.state.current, 0,
          `${player.name} 보너스패 획득(뒤집기)`);
        continue;
      }
      return top;
    }
    return null;
  }

  private flipStockAndResolve(player: Player): boolean {
    const draw = this.drawNonBonus(player);
    if (!draw) return false;

    const captured: HwatuCard[] = [];
    const matches = this.matchIndices(draw.month);
    if (matches.length === 0) {
      this.state.floor.push(draw);
    } else {
      captured.push(draw);
      this.captureInto(captured, matches, -1);
      if (matches.length >= 3 || this.state.bbeokCreator.has(draw.month)) {
        this.resolveThreePileSteal(draw.month);
      }
    }

    if (captured.length > 0) {
      player.captured.push(...captured);
      this.addEvent(PlayEventKind.Capture, this.state.current, draw.month,
        `${player.name} 뒤집어 ${captured.length}장 먹음`);
    } else {
      this.addEvent(PlayEventKind.Place, this.state.current, draw.month,
        `${player.name} 뒤집은 카드 바닥에 놓음`);
    }

    // 뒤집기로 바닥 비움 → 쓸(마지막 장 제외)
    if (this.state.floor.length === 0 && captured.length > 0 && player.hand.length > 0) {
      this.addEvent(PlayEventKind.Sseul, this.state.current, draw.month, `${player.name} 싹쓸이!`);
      this.stealPiFromOthers(this.state.current);
    }

    return captured.length > 0;
  }

  private canAct(playerIndex: number): boolean {
    const player = this.state.player(playerIndex);
    return player.hand.length > 0 || (player.cardDebt > 0 && this.state.stock.length > 0);
  }

  private advanceTurn(): void {
    this.pendingBonus = [];
    this.flipBonus = [];

    let anyActive = false;
    for (let p = 0; p < this.state.playerCount(); p++) {
      if (this.canAct(p)) { anyActive = true; break; }
    }
    if (!anyActive) {
      this.state.phase = GamePhase.Finished;
      this.state.winner = -1;
      this.addEvent(PlayEventKind.Finished, -1, 0, '나가리(손패 소진)');
      return;
    }

    do {
      this.state.current = (this.state.current + 1) % this.state.playerCount();
    } while (!this.canAct(this.state.current));

    this.state.phase = GamePhase.Playing;
    this.addEvent(PlayEventKind.TurnPass, this.state.current, 0, `${this.state.currentPlayer().name} 차례`);
  }

  /**
   * 현재 플레이어가 손패의 카드를 내고 한 턴을 끝까지 진행.
   * 3점 이상 도달해 고/스톱 선택이 필요하면 true(단계가 대기로 전환).
   */
  playHandCard(handIndex: number, floorChoice = 0): boolean {
    if (this.state.phase !== GamePhase.Playing) {
      throw new HwatuError('지금은 손패를 낼 단계가 아닙니다.');
    }
    const player = this.state.currentPlayer();
    if (handIndex < 0 || handIndex >= player.hand.length) {
      throw new HwatuError(`손패 인덱스 오류: ${handIndex} (손패 ${player.hand.length}장)`);
    }

    const handCard = player.hand[handIndex]!;
    // 흔들기 커밋: 흔든 월을 내야 함(보너스패 예외).
    if (this.rules.enforceShakeMonth && player.pendingShakeMonth !== 0
      && handCard.kind !== HwatuKind.Bonus && handCard.month !== player.pendingShakeMonth) {
      throw new HwatuError(`${player.pendingShakeMonth}월을 흔들었으므로 그 월의 카드를 내야 합니다.`);
    }

    const wasPendingShake = player.pendingShakeMonth !== 0;
    let monthInHand = 0;
    for (const c of player.hand) {
      if (c.month === handCard.month) monthInHand++;
    }

    player.hand.splice(handIndex, 1);
    const month = handCard.month;

    const captured: HwatuCard[] = [];
    const handMatches = this.matchIndices(month);

    // 자동 흔들기: 같은 월 3장 + 바닥 없음 + 미커밋.
    if (!wasPendingShake && handCard.kind !== HwatuKind.Bonus && monthInHand >= 3 && handMatches.length === 0) {
      player.shakeCount++;
      this.addEvent(PlayEventKind.Shake, this.state.current, month, `${player.name} 흔들기! (${month}월)`);
    }

    // 보너스패: 즉시 획득 후 손 보충하고 같은 차례 계속.
    if (handCard.kind === HwatuKind.Bonus) {
      player.captured.push(handCard);
      this.pendingBonus.push(handCard);
      this.addEvent(PlayEventKind.BonusCapture, this.state.current, 0, `${player.name} 보너스패 획득`);

      if (this.bonusDrawEnabled && this.state.stock.length > 0) {
        this.state.phase = GamePhase.AwaitingBonusDraw;
        return false;
      }
      const refill = this.drawNonBonus(player);
      if (refill) player.hand.push(refill);
      return false;
    }

    // 실제 패를 낸 시점에만 흔들기 커밋 소모 · 판 수 카운트.
    player.pendingShakeMonth = 0;
    const firstPlay = this.state.playCount === 0;
    this.state.playCount++;

    const draw = this.drawNonBonus(player);
    const hasDraw = draw !== null;

    // 뻑: 손패가 바닥 1장과 매칭인데 뒤집은 것도 같은 월.
    if (hasDraw && handMatches.length === 1 && draw!.month === month) {
      this.state.floor.push(handCard);
      this.state.floor.push(draw!);
      this.addEvent(PlayEventKind.Bbeok, this.state.current, month, `${player.name} 뻑! (${month}월)`);

      // 이번 턴 획득한 보너스패는 뻑 무더기에 함께 묻힘(월을 뻑 월로 바꾼 복제본).
      const buryBonus = [...this.pendingBonus, ...this.flipBonus];
      if (buryBonus.length > 0) {
        for (const b of buryBonus) {
          for (let j = player.captured.length - 1; j >= 0; j--) {
            if (player.captured[j]!.assetId === b.assetId) {
              player.captured.splice(j, 1);
              break;
            }
          }
          this.state.floor.push({ ...b, month });
        }
        this.addEvent(PlayEventKind.Place, this.state.current, month, `${player.name} 보너스패도 뻑 더미에 묻힘`);
        this.pendingBonus = [];
        this.flipBonus = [];
      }

      // 연뻑(증가 전 bbeokCount=1 → 이번이 2번째)
      if (player.bbeokCount === 1) {
        this.addEvent(PlayEventKind.Yeonbbeok, this.state.current, month, `${player.name} 연뻑!`);
      }
      // 첫뻑
      if (firstPlay) {
        this.addEvent(PlayEventKind.Cheotbbeok, this.state.current, month, `${player.name} 첫뻑!`);
      }

      this.state.bbeokCreator.set(month, this.state.current);

      // 쓰리뻑: 뻑 3회 → 즉시 승리.
      player.bbeokCount++;
      if (player.bbeokCount >= 3) {
        this.state.threeBbeok = true;
        this.state.winner = this.state.current;
        this.state.phase = GamePhase.Finished;
        this.addEvent(PlayEventKind.Sambbeok, this.state.current, month, `${player.name} 쓰리뻑! 즉시 승리`);
        return false;
      }

      this.advanceTurn();
      return false;
    }

    // 손패 처리
    let playedCaptured = false;
    if (handMatches.length === 0) {
      this.state.floor.push(handCard);
    } else {
      playedCaptured = true;
      captured.push(handCard);
      this.captureInto(captured, handMatches, floorChoice);
      if (handMatches.length >= 3 || this.state.bbeokCreator.has(month)) {
        this.resolveThreePileSteal(month);
      }
    }

    // 뒷패 카드 처리
    let ttadak = false;
    let jjok = false;
    if (hasDraw) {
      const drawMatches = this.matchIndices(draw!.month);
      if (drawMatches.length === 0) {
        this.state.floor.push(draw!);
      } else if (this.flipChoiceEnabled && drawMatches.length === 2
        && this.state.floor[drawMatches[0]!]!.kind !== this.state.floor[drawMatches[1]!]!.kind
        && !this.state.bbeokCreator.has(draw!.month)) {
        // 뒤집은 패가 바닥 2장(다른 종류)과 매칭 → 선택 대기.
        if (captured.length > 0) {
          player.captured.push(...captured);
          this.addEvent(PlayEventKind.Capture, this.state.current, month,
            `${player.name} ${captured.length}장 먹음`);
          captured.length = 0;
        }
        this.flipCard = draw!;
        this.flipOpt0 = this.state.floor[drawMatches[0]!]!;
        this.flipOpt1 = this.state.floor[drawMatches[1]!]!;
        this.flipHandMonth = month;
        this.flipHandCaptured = playedCaptured;
        this.flipHandPlaced = handMatches.length === 0;
        this.state.floor.push(draw!); // 뒤집은 패 노출
        this.state.phase = GamePhase.AwaitingFlipChoice;
        return false;
      } else {
        captured.push(draw!);
        this.captureInto(captured, drawMatches, -1);
        if (drawMatches.length >= 3 || this.state.bbeokCreator.has(draw!.month)) {
          this.resolveThreePileSteal(draw!.month);
        }
        if (playedCaptured && draw!.month === month) {
          ttadak = true; // 손패로 먹고 뒤집은 것도 같은 월 → 따닥
        } else if (handMatches.length === 0 && draw!.month === month) {
          jjok = true; // 빈 바닥에 놓은 카드를 뒤집어 먹음 → 쪽
        }
      }
    }

    // 획득 이관
    if (captured.length > 0) {
      player.captured.push(...captured);
      this.addEvent(PlayEventKind.Capture, this.state.current, month, `${player.name} ${captured.length}장 먹음`);
    } else {
      this.addEvent(PlayEventKind.Place, this.state.current, month, `${player.name} 못 먹고 바닥에 놓음`);
    }

    // 마지막 장(손패 소진)에선 쪽·따닥·쓸 불인정.
    const notLast = player.hand.length > 0;
    const sseul = this.state.floor.length === 0 && captured.length > 0 && notLast;

    if (ttadak && notLast) {
      this.addEvent(PlayEventKind.Ttadak, this.state.current, month, `${player.name} 따닥!`);
      this.stealPiFromOthers(this.state.current);
    }
    if (jjok && notLast) {
      this.addEvent(PlayEventKind.Jjok, this.state.current, month, `${player.name} 쪽!`);
      this.stealPiFromOthers(this.state.current);
    }
    if (sseul) {
      this.addEvent(PlayEventKind.Sseul, this.state.current, month, `${player.name} 싹쓸이!`);
      this.stealPiFromOthers(this.state.current);
    }

    return this.scoreAndFinish(player);
  }

  /** 보너스 뽑기 대기에서 뒷패의 지정 위치 카드를 가져온다. */
  resolveBonusDraw(stockIndex: number): void {
    if (this.state.phase !== GamePhase.AwaitingBonusDraw) {
      throw new HwatuError('보너스 뽑기 대기 단계가 아닙니다.');
    }
    if (stockIndex < 0 || stockIndex >= this.state.stock.length) {
      throw new HwatuError(`뒷패 범위를 벗어난 선택입니다(${stockIndex}).`);
    }

    const player = this.state.currentPlayer();
    const card = this.state.stock[stockIndex]!;
    this.state.stock.splice(stockIndex, 1);

    if (card.kind === HwatuKind.Bonus) {
      player.captured.push(card);
      this.addEvent(PlayEventKind.BonusCapture, this.state.current, 0, `${player.name} 보너스패 획득(뒷패)`);
      if (this.state.stock.length > 0) return;
      this.state.phase = GamePhase.Playing;
      return;
    }

    player.hand.push(card);
    this.state.phase = GamePhase.Playing; // 같은 차례 계속
  }

  private removeFloorByAsset(assetId: string): void {
    const floor = this.state.floor;
    for (let i = 0; i < floor.length; i++) {
      if (floor[i]!.assetId === assetId) {
        floor.splice(i, 1);
        return;
      }
    }
  }

  private scoreAndFinish(player: Player): boolean {
    // 고/스톱 최소 점수: 2인=7, 3인+=3.
    const minScore = this.state.playerCount() === 2 ? 7 : 3;
    const score = Scorer.evaluate(player.captured, this.rules.score);
    if (score.total >= minScore && score.total > player.lastGoScore) {
      this.state.phase = GamePhase.AwaitingGoStop;
      this.addEvent(PlayEventKind.GoStop, this.state.current, 0, `${player.name} ${score.total}점 — 고/스톱 선택`);
      return true;
    }
    this.advanceTurn();
    return false;
  }

  /** 뒤집기 선택 대기 중, 가져갈 후보 2장. */
  flipChoiceOptions(): HwatuCard[] {
    return [this.flipOpt0!, this.flipOpt1!];
  }

  /** 뒤집기로 가져올 뒤집은 패(선택 대기 중). */
  flipDrawnCard(): HwatuCard {
    return this.flipCard!;
  }

  /** 뒤집기 선택 대기에서 가져갈 바닥패를 선택해 턴을 마친다. */
  resolveFlipChoice(ordinal: number): boolean {
    if (this.state.phase !== GamePhase.AwaitingFlipChoice) {
      throw new HwatuError('뒤집기 선택 대기 단계가 아닙니다.');
    }
    if (ordinal < 0 || ordinal > 1) {
      throw new HwatuError(`뒤집기 선택지는 0/1이어야 합니다(${ordinal}).`);
    }

    const player = this.state.currentPlayer();
    const flipCard = this.flipCard!;
    const chosen = ordinal === 1 ? this.flipOpt1! : this.flipOpt0!;

    this.removeFloorByAsset(flipCard.assetId);
    this.removeFloorByAsset(chosen.assetId);
    player.captured.push(flipCard);
    player.captured.push(chosen);
    this.addEvent(PlayEventKind.Capture, this.state.current, flipCard.month, `${player.name} 뒤집어 2장 먹음`);

    // 따닥/쪽(마지막 장 제외)
    if (player.hand.length > 0 && this.flipHandCaptured && flipCard.month === this.flipHandMonth) {
      this.addEvent(PlayEventKind.Ttadak, this.state.current, flipCard.month, `${player.name} 따닥!`);
      this.stealPiFromOthers(this.state.current);
    } else if (player.hand.length > 0 && this.flipHandPlaced && flipCard.month === this.flipHandMonth) {
      this.addEvent(PlayEventKind.Jjok, this.state.current, flipCard.month, `${player.name} 쪽!`);
      this.stealPiFromOthers(this.state.current);
    }

    // 쓸(마지막 장 제외)
    if (this.state.floor.length === 0 && player.hand.length > 0) {
      this.addEvent(PlayEventKind.Sseul, this.state.current, flipCard.month, `${player.name} 싹쓸이!`);
      this.stealPiFromOthers(this.state.current);
    }

    this.flipCard = null;
    this.flipOpt0 = null;
    this.flipOpt1 = null;

    return this.scoreAndFinish(player);
  }

  /** 고를 선언하고 다음 차례로. */
  declareGo(): void {
    if (this.state.phase !== GamePhase.AwaitingGoStop) {
      throw new HwatuError('고/스톱 대기 단계가 아닙니다.');
    }
    const player = this.state.currentPlayer();

    // 역고: 이미 고를 부른 상대가 있으면 성립(한 번 성립하면 유지).
    if (!player.reverseGo) {
      for (let p = 0; p < this.state.playerCount(); p++) {
        if (p !== this.state.current && this.state.player(p).goCount > 0) {
          player.reverseGo = true;
          break;
        }
      }
    }

    player.goCount++;
    player.lastGoScore = this.scoreOf(this.state.current).total;
    if (player.reverseGo) {
      this.addEvent(PlayEventKind.ReverseGo, this.state.current, 0, `${player.name} 역고! (${player.goCount}고)`);
    } else {
      this.addEvent(PlayEventKind.Go, this.state.current, 0, `${player.name} ${player.goCount}고!`);
    }

    this.advanceTurn();
  }

  /** 스톱을 선언하고 현재 플레이어를 승자로 종료. */
  declareStop(): void {
    if (this.state.phase !== GamePhase.AwaitingGoStop) {
      throw new HwatuError('고/스톱 대기 단계가 아닙니다.');
    }
    this.state.phase = GamePhase.Finished;
    this.state.winner = this.state.current;
    this.addEvent(PlayEventKind.Stop, this.state.current, 0, `${this.state.currentPlayer().name} 스톱! 승리`);
  }

  /** 쇼당(둘 다 수락)으로 나가리(무효) 처리. */
  declareNagari(): void {
    this.state.phase = GamePhase.Finished;
    this.state.winner = -1;
    this.addEvent(PlayEventKind.Place, this.state.current, 0, '쇼당 — 나가리');
  }

  scoreOf(playerIndex: number): ScoreBreakdown {
    return Scorer.evaluate(this.state.player(playerIndex).captured, this.rules.score);
  }

  /** 게임 종료 시 각 플레이어의 최종 정산. 미종료/나가리면 전원 0. */
  finalSettlement(): PlayerResult[] {
    const result: PlayerResult[] = [];
    for (let p = 0; p < this.state.playerCount(); p++) {
      result.push({
        playerIndex: p, net: 0, pibak: false, gwangbak: false, meongbak: false,
        gobak: false, reverseGo: false, gukjinAsPi: false, goCount: 0, goMultiplier: 0,
      });
    }

    if (this.state.winner < 0) return result;

    const winner = this.state.winner;

    // 쓰리뻑·총통 즉시 승리: 고정 점수, 박·고 배수 미적용.
    let instantWin = this.state.threeBbeok;
    if (!instantWin) {
      instantWin = this.state.events.some((e) => e.kind === PlayEventKind.Chongtong);
    }
    if (instantWin) {
      const fixed = this.state.playerCount() === 2 ? 7 : 3;
      let tot = 0;
      for (let p = 0; p < this.state.playerCount(); p++) {
        if (p !== winner) {
          result[p]!.net = -fixed;
          tot += fixed;
        }
      }
      result[winner]!.net = tot;
      return result;
    }

    const winnerP = this.state.player(winner);
    const winBreak = Scorer.evaluate(winnerP.captured, this.rules.score);
    result[winner]!.gukjinAsPi = winBreak.gukjinAsPi;

    let totalToWinner = 0;
    // 피박 기준: 2인=≤7, 3인+=≤5.
    const scoreOpt: ScoreOptions = { ...this.rules.score, pibakMaxJunk: this.state.playerCount() >= 3 ? 5 : 7 };

    let gobakLoser = -1;
    for (let p = 0; p < this.state.playerCount(); p++) {
      if (p === winner) continue;

      const loserBreak = Scorer.evaluateAsLoser(this.state.player(p).captured, scoreOpt);
      const settle = Scorer.settle(winBreak, loserBreak, winnerP.goCount, winnerP.shakeCount, scoreOpt, winnerP.reverseGo);
      const r = result[p]!;
      r.net = -settle.points;
      r.pibak = settle.pibak;
      r.gwangbak = settle.gwangbak;
      r.meongbak = settle.meongbak;
      r.goCount = winnerP.goCount;
      r.goMultiplier = settle.goMultiplier;
      r.reverseGo = settle.reverseGo;
      r.gukjinAsPi = loserBreak.gukjinAsPi;
      totalToWinner += settle.points;

      if (this.state.player(p).goCount > 0) gobakLoser = p;
    }

    // 고박: 고를 부르고 진 사람이 전액(×배수) 부담, 나머지 패자 면제.
    if (gobakLoser >= 0) {
      for (let p = 0; p < this.state.playerCount(); p++) {
        if (p !== winner) result[p]!.net = 0;
      }
      const gobakTotal = totalToWinner * this.rules.score.gobakMultiplier;
      result[gobakLoser]!.net = -gobakTotal;
      result[gobakLoser]!.gobak = true;
      totalToWinner = gobakTotal;
    }

    result[winner]!.net = totalToWinner;
    result[winner]!.reverseGo = winnerP.reverseGo;
    return result;
  }

  /** 지정 플레이어가 손패에 같은 월 4장이면 그 월, 아니면 null. */
  canDeclareChongtong(playerIndex: number): number | null {
    const counts = new Array<number>(13).fill(0);
    for (const c of this.state.player(playerIndex).hand) {
      if (c.month >= 1 && c.month <= 12) counts[c.month]!++;
    }
    for (let m = 1; m <= 12; m++) {
      if (counts[m]! >= 4) return m;
    }
    return null;
  }

  /** 지정 플레이어가 총통을 선언해 즉시 승리로 종료. */
  declareChongtong(playerIndex: number): void {
    const month = this.canDeclareChongtong(playerIndex);
    if (month === null) {
      throw new HwatuError(`${playerIndex}번 플레이어는 총통 조건(같은 월 4장)이 아닙니다.`);
    }
    if (this.state.phase !== GamePhase.Playing) {
      throw new HwatuError('총통은 플레이 중에만 선언할 수 있습니다.');
    }
    this.state.phase = GamePhase.Finished;
    this.state.winner = playerIndex;
    this.addEvent(PlayEventKind.Chongtong, playerIndex, month,
      `${this.state.player(playerIndex).name} 총통 선언! (${month}월 4장) — 즉시 승리`);
  }

  /** 딜 직후 손패 총통을 검사해 있으면 즉시 승리로 종료. */
  applyHandChongtong(): boolean {
    if (this.state.phase !== GamePhase.Playing) return false;
    for (let p = 0; p < this.state.playerCount(); p++) {
      const month = this.canDeclareChongtong(p);
      if (month !== null) {
        this.state.phase = GamePhase.Finished;
        this.state.winner = p;
        this.addEvent(PlayEventKind.Chongtong, p, month,
          `${this.state.player(p).name} 총통! (${month}월 4장) — 즉시 승리`);
        return true;
      }
    }
    return false;
  }

  /** 현재 플레이어가 지정 월 3장을 들고 있어 흔들 수 있으면 true. */
  canShake(month: number): boolean {
    let count = 0;
    for (const c of this.state.currentPlayer().hand) {
      if (c.month === month) count++;
    }
    return count >= 3;
  }

  /** 현재 플레이어가 지정 월을 흔든다(같은 월 3장 필요). 배수 ×2. */
  declareShake(month: number): void {
    if (this.state.phase !== GamePhase.Playing) {
      throw new HwatuError('지금은 흔들 수 있는 단계가 아닙니다.');
    }
    if (!this.canShake(month)) {
      throw new HwatuError(`${month}월 3장을 들고 있지 않아 흔들 수 없습니다.`);
    }
    const player = this.state.currentPlayer();
    if (player.pendingShakeMonth !== 0) {
      throw new HwatuError('이미 흔들기를 선언했습니다(중복 선언으로 배수를 불릴 수 없음).');
    }
    player.shakeCount++;
    player.pendingShakeMonth = month;
    this.addEvent(PlayEventKind.Shake, this.state.current, month, `${player.name} 흔들기! (${month}월)`);
  }

  /** 현재 플레이어가 같은 월 3장 보유 + 바닥에 그 월이 있어 폭탄이 가능하면 true. */
  canBomb(month: number): boolean {
    if (!this.canShake(month)) return false;
    return this.matchIndices(month).length >= 1;
  }

  /** 현재 플레이어가 지정 월로 폭탄을 친다. */
  playBomb(month: number): boolean {
    if (this.state.phase !== GamePhase.Playing) {
      throw new HwatuError('지금은 폭탄을 칠 단계가 아닙니다.');
    }
    if (!this.canBomb(month)) {
      throw new HwatuError(`폭탄 조건 미충족: ${month}월 손패 3장 + 바닥 같은 월이 필요합니다.`);
    }

    this.state.playCount++;
    const player = this.state.currentPlayer();
    const captured: HwatuCard[] = [];

    // 손패에서 해당 월 3장 제거(높은 인덱스부터).
    let taken = 0;
    for (let i = player.hand.length - 1; i >= 0; i--) {
      if (player.hand[i]!.month === month && taken < 3) {
        captured.push(player.hand[i]!);
        player.hand.splice(i, 1);
        taken++;
      }
    }

    // 바닥의 같은 월 모두 획득(선택 없이 전부).
    const bombFloorIdx = this.matchIndices(month);
    for (let k = bombFloorIdx.length - 1; k >= 0; k--) {
      captured.push(this.state.floor[bombFloorIdx[k]!]!);
      this.state.floor.splice(bombFloorIdx[k]!, 1);
    }

    player.captured.push(...captured);
    this.addEvent(PlayEventKind.Bomb, this.state.current, month, `${player.name} 폭탄! (${month}월)`);

    player.shakeCount++;
    this.stealPiFromOthers(this.state.current);

    // 카드빚: 여분 (낸 장수 - 1)장 → '뒤집기만' 턴으로 상환.
    player.cardDebt += taken - 1;

    this.flipStockAndResolve(player);
    return this.scoreAndFinish(player);
  }

  /** 현재 플레이어가 카드빚이 남아 '뒤집기만' 턴을 쓸 수 있으면 true. */
  canFlipOnly(): boolean {
    return this.state.phase === GamePhase.Playing
      && this.state.currentPlayer().cardDebt > 0
      && this.state.stock.length > 0;
  }

  /** 카드빚을 갚는다: 손패 대신 뒷패 1장만 뒤집어 처리하고 턴을 넘긴다. */
  flipOnly(): boolean {
    if (this.state.phase !== GamePhase.Playing) {
      throw new HwatuError('지금은 뒤집기만 할 단계가 아닙니다.');
    }
    const player = this.state.currentPlayer();
    if (player.cardDebt <= 0) {
      throw new HwatuError('갚을 카드빚이 없어 뒤집기만 할 수 없습니다.');
    }
    player.cardDebt--;
    this.addEvent(PlayEventKind.TurnPass, this.state.current, 0,
      `${player.name} 뒤집기만(카드빚 갚기, ${player.cardDebt} 남음)`);
    this.flipStockAndResolve(player);
    return this.scoreAndFinish(player);
  }
}
