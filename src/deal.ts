// Gostop.Deal.pas → TS 이식.
// 딜 구성 · 딜 직후 테이블 상태(손패/바닥/뒷패) · 딜러(분배·재분배·손패 품질·운 가중 배정).

import {
  HwatuCard, HwatuKind, HwatuError, kindOrdinal,
} from './cards.js';
import { Deck, DeckOptions } from './deck.js';

/** [0, bound) 정수 난수. 결정적 테스트를 위해 주입 가능. */
export type RandomBelow = (bound: number) => number;
const defaultRandomBelow: RandomBelow = (bound) => Math.floor(Math.random() * bound);

/** 딜(분배) 구성: 인원수·플레이어당 손패·바닥 장수. */
export interface DealConfig {
  /** 플레이어 수(2 이상). */
  playerCount: number;
  /** 플레이어당 손패 장수. */
  handSize: number;
  /** 바닥에 까는 장수. */
  floorSize: number;
}

export const DealConfig = {
  /** 인원수에 맞는 표준 구성. 2인=10/8, 3인=7/6. */
  forPlayers(playerCount: number): DealConfig {
    switch (playerCount) {
      case 2: return { playerCount: 2, handSize: 10, floorSize: 8 };
      case 3: return { playerCount: 3, handSize: 7, floorSize: 6 };
      default:
        throw new HwatuError(
          `${playerCount}인 표준 딜 구성이 정의되지 않았습니다. DealConfig.custom을 사용하세요.`,
        );
    }
  },
  /** 사용자 지정 구성. */
  custom(playerCount: number, handSize: number, floorSize: number): DealConfig {
    return { playerCount, handSize, floorSize };
  },
  /** 이 구성이 나눠 주는 총 장수(손패 합계 + 바닥). */
  dealtCount(config: DealConfig): number {
    return config.playerCount * config.handSize + config.floorSize;
  },
};

// 카드 목록에서 같은 월 AThreshold장 이상인 첫 월을 반환(없으면 null).
function monthWithCount(cards: readonly HwatuCard[], threshold: number): number | null {
  const counts = new Array<number>(13).fill(0); // 1..12
  for (const card of cards) {
    if (card.month >= 1 && card.month <= 12) counts[card.month]!++;
  }
  for (let m = 1; m <= 12; m++) {
    if (counts[m]! >= threshold) return m;
  }
  return null;
}

/**
 * 딜 직후의 게임 테이블 상태. 플레이어별 손패·바닥·뒷패를 담는다.
 * 각 목록에서 끝이 '맨 위(다음 뽑을 카드)'.
 */
export class TableState {
  private readonly hands: HwatuCard[][];
  readonly floor: HwatuCard[] = [];
  readonly stock: HwatuCard[] = [];

  /** 플레이어 수만큼 빈 손패를 준비. */
  constructor(playerCount: number) {
    this.hands = Array.from({ length: playerCount }, () => [] as HwatuCard[]);
  }

  /** 지정 플레이어의 손패 목록(0-기반, 참조). */
  hand(playerIndex: number): HwatuCard[] {
    return this.hands[playerIndex]!;
  }

  /** 플레이어 수. */
  playerCount(): number {
    return this.hands.length;
  }

  /** 바닥에 보너스패가 깔려 있으면 true. */
  floorHasBonus(): boolean {
    return this.floor.some((c) => c.kind === HwatuKind.Bonus);
  }

  /** 바닥에 같은 월 4장(총통)이 있으면 그 월, 없으면 null. */
  floorFourOfAKind(): number | null {
    return monthWithCount(this.floor, 4);
  }

  /** 지정 플레이어 손패에 같은 월 4장(총통)이 있으면 그 월, 없으면 null. */
  handFourOfAKind(playerIndex: number): number | null {
    return monthWithCount(this.hands[playerIndex]!, 4);
  }

  /** 모든 손패를 월→종류→순번 순으로 정렬(표시용). */
  sortHands(): void {
    const cmp = (a: HwatuCard, b: HwatuCard): number => {
      let r = a.month - b.month;
      if (r === 0) r = kindOrdinal(a.kind) - kindOrdinal(b.kind);
      if (r === 0) r = a.ordinal - b.ordinal;
      return r;
    };
    for (const h of this.hands) h.sort(cmp);
  }

  /** 사람이 읽을 수 있는 상태 요약(손패/바닥/뒷패 장수). */
  summary(): string {
    let s = '';
    this.hands.forEach((h, i) => {
      s += `P${i + 1} 손패=${h.length}  `;
    });
    s += `바닥=${this.floor.length}  뒷패=${this.stock.length}`;
    return s;
  }
}

/** dealFresh 옵션. */
export interface DealFreshOptions {
  /** 셔플 전략(테스트 결정화용). 기본은 비결정적 shuffle(). */
  shuffle?: (deck: Deck) => void;
}

/** 덱을 받아 고스톱 규칙대로 분배하는 정적 딜러. (Delphi TDealer) */
export const Dealer = {
  /**
   * 주어진 덱을 구성대로 분배. 손패는 카드 단위 라운드로빈, 이어서 바닥, 남은 것은 뒷패.
   * 덱은 이 호출로 소진된다.
   */
  deal(deck: Deck, config: DealConfig): TableState {
    if (config.playerCount < 2) {
      throw new HwatuError(`플레이어 수는 2명 이상이어야 합니다(요청: ${config.playerCount}).`);
    }
    const need = DealConfig.dealtCount(config);
    if (deck.count() < need) {
      throw new HwatuError(`덱이 ${deck.count()}장뿐이라 ${need}장을 분배할 수 없습니다.`);
    }

    const table = new TableState(config.playerCount);

    // 손패: 카드 단위 라운드로빈(실제 분배 방식 모사)
    for (let round = 0; round < config.handSize; round++) {
      for (let p = 0; p < config.playerCount; p++) {
        table.hand(p).push(deck.draw());
      }
    }
    // 바닥
    for (let i = 0; i < config.floorSize; i++) {
      table.floor.push(deck.draw());
    }
    // 뒷패: 남은 카드를 순서 그대로(끝=맨 위) 이관
    table.stock.push(...deck.drainAll());

    return table;
  },

  /** 바닥에 보너스패 또는 총통이 있어 재분배가 필요한지. */
  needsRedeal(state: TableState): boolean {
    return state.floorHasBonus() || state.floorFourOfAKind() !== null;
  },

  /**
   * 덱을 새로 만들어 셔플·분배. 바닥이 무효(보너스/총통)면 maxRedeals까지 다시 섞어 분배.
   */
  dealFresh(
    config: DealConfig,
    deckOptions: DeckOptions,
    maxRedeals = 0,
    options: DealFreshOptions = {},
  ): TableState {
    const shuffle = options.shuffle ?? ((d: Deck) => d.shuffle());
    const deck = new Deck(deckOptions);
    let attempt = 0;
    let result: TableState;
    for (;;) {
      deck.build(deckOptions);
      shuffle(deck);
      result = Dealer.deal(deck, config);
      if (attempt >= maxRedeals || !Dealer.needsRedeal(result)) break;
      attempt++;
    }
    return result;
  },

  /**
   * 손패의 시작 잠재력(광·고도리·쌍피·페어)을 점수화. floor를 주면 바닥과의 월 매칭을 크게 가산.
   * 운 보정용 품질 지표.
   */
  handQuality(hand: readonly HwatuCard[], floor?: readonly HwatuCard[]): number {
    let result = 0;
    const monthCount = new Array<number>(13).fill(0);
    const floorMonth = new Array<number>(13).fill(0);

    if (floor) {
      for (const card of floor) {
        if (card.month >= 1 && card.month <= 12) floorMonth[card.month]!++;
      }
    }

    for (const card of hand) {
      switch (card.kind) {
        case HwatuKind.Bright:
          result += 3.0;
          break;
        case HwatuKind.Animal:
          result += card.isGodori ? 2.5 : 1.2;
          break;
        case HwatuKind.Ribbon:
          result += 1.2;
          break;
        case HwatuKind.Junk:
        case HwatuKind.Bonus:
          result += card.junkValue * 0.6;
          break;
      }
      if (card.month >= 1 && card.month <= 12) monthCount[card.month]!++;
    }

    for (let m = 1; m <= 12; m++) {
      if (monthCount[m] === 2) {
        result += 0.8;
      } else if (monthCount[m]! >= 3) {
        result += 2.0;
      }
      // 바닥과의 월 매칭: 첫 턴부터 먹을 수 있는 기회(가장 실효적인 이점)
      if (monthCount[m]! > 0 && floorMonth[m]! > 0) {
        result += 1.5 * Math.min(monthCount[m]!, floorMonth[m]!);
      }
    }

    return result;
  },

  /**
   * 운 가중 손패 배정: 손패들을 품질 순으로 정렬해, 운이 높은 플레이어가 좋은 손패를 받을
   * 확률이 높아지도록 가중 추첨으로 재배정. 운이 전원 동일하면 균등 추첨과 같다.
   */
  luckReassign(table: TableState, luck: readonly number[], randomBelow: RandomBelow = defaultRandomBelow): void {
    const count = table.playerCount();
    if (count < 2 || luck.length < count) return;

    // 손패 스냅샷 + 품질 내림차순 정렬(order 배열)
    const snapshots: HwatuCard[][] = [];
    const quality: number[] = [];
    const order: number[] = [];
    for (let i = 0; i < count; i++) {
      snapshots.push(table.hand(i).slice());
      quality.push(Dealer.handQuality(table.hand(i), table.floor)); // 바닥 시너지 포함
      order.push(i);
    }

    // 선택 정렬(원본과 동일한 안정성·순서 유지)
    for (let i = 0; i < count - 1; i++) {
      for (let j = i + 1; j < count; j++) {
        if (quality[order[j]!]! > quality[order[i]!]!) {
          const tmp = order[i]!;
          order[i] = order[j]!;
          order[j] = tmp;
        }
      }
    }

    // 좋은 손패부터, 남은 플레이어 중 운 가중 추첨으로 주인 결정
    const taken = new Array<boolean>(count).fill(false);
    for (let d = 0; d < count; d++) {
      let total = 0;
      for (let p = 0; p < count; p++) {
        if (!taken[p]) total += luck[p]! + 10; // +10: 운 0도 최소 확률 보장
      }

      let pickValue = randomBelow(total);
      let winner = -1;
      for (let p = 0; p < count; p++) {
        if (taken[p]) continue;
        pickValue -= luck[p]! + 10;
        if (pickValue < 0) {
          winner = p;
          break;
        }
      }
      if (winner < 0) {
        for (let p = 0; p < count; p++) {
          if (!taken[p]) { winner = p; break; }
        }
      }

      taken[winner] = true;
      const dst = table.hand(winner);
      dst.length = 0;
      dst.push(...snapshots[order[d]!]!);
    }
  },
};
