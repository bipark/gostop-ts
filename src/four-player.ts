// Gostop.FourPlayer.pas → TS 이식.
// 4인 광팔기 협상: 선(P1)은 항상 참가, P2→P3 순으로 포기 가능, 한 명 빠지면 아래 순번 자동 참가해
// 항상 3명이 친다. P2·P3 모두 참가할 때만 P4가 광을 팔 수 있고, 광값은 선을 뺀 P2·P3가 선불로 낸다.

import {
  HwatuCard, HwatuKind, RibbonKind, HwatuError,
} from './cards.js';
import { ScoreOptions, Scorer } from './score.js';
import { TableState, RandomBelow } from './deal.js';
import { GameState } from './play.js';

const defaultRandomBelow: RandomBelow = (bound) => Math.floor(Math.random() * bound);

/** 광팔기 정산 결과(선불). */
export interface GwangSale {
  sold: boolean;
  /** 판 사람 좌석(P4=3). 안 팔았으면 -1. */
  sellerSeat: number;
  /** 판 광 개수(5광 + 쌍피 인정). */
  gwangCount: number;
  /** 지불자 1인당 광값 = 단가 × 광개수. */
  valuePerPayer: number;
  /** 광값을 선불로 내는 좌석들(P2·P3). 선(0) 제외. */
  payerSeats: number[];
}

/** 4인 광팔기 협상 결과: 실제 치는 3명과 광 정산. */
export interface FourPlayerRound {
  /** 실제 게임을 치는 3좌석(선 먼저, 원래 좌석 인덱스). */
  playSeats: number[];
  /** 빠지는 좌석(광 판 P4 또는 포기한 P2/P3). */
  sitOutSeat: number;
  gwang: GwangSale;
}

/** 4인 고스톱 광팔기 규칙 처리. (Delphi TFourPlayer) */
export const FourPlayer = {
  /**
   * 광값: 광(밝은 패)+조커 장수 + 실제 완성된 족보(고도리·홍단·청단·초단) 점수.
   * 같은 월 3장 이상(흔들기 가능)이면 전체 값 ×2.
   */
  gwangCount(hand: readonly HwatuCard[], options: ScoreOptions): number {
    let result = 0;
    for (const c of hand) {
      if (c.kind === HwatuKind.Bright || c.kind === HwatuKind.Bonus) result++;
    }

    const brk = Scorer.evaluate(hand, options);
    result += brk.godoriPoints + brk.hongdanPoints + brk.cheongdanPoints + brk.chodanPoints;

    const monthCount = new Array<number>(13).fill(0);
    for (const c of hand) {
      if (c.month >= 1 && c.month <= 12) monthCount[c.month]!++;
    }
    for (let m = 1; m <= 12; m++) {
      if (monthCount[m]! >= 3) { result *= 2; break; }
    }
    return result;
  },

  /** 광팔기 다이얼로그에 보여줄 패: 광+조커 + 완성된 족보(고도리·홍청초단)의 카드. */
  saleCards(hand: readonly HwatuCard[], options: ScoreOptions): HwatuCard[] {
    const result: HwatuCard[] = [];
    for (const c of hand) {
      if (c.kind === HwatuKind.Bright || c.kind === HwatuKind.Bonus) result.push(c);
    }

    const brk = Scorer.evaluate(hand, options);
    for (const c of hand) {
      if (brk.godoriPoints > 0 && c.kind === HwatuKind.Animal && c.isGodori) {
        result.push(c);
      } else if (c.kind === HwatuKind.Ribbon
        && ((brk.hongdanPoints > 0 && c.ribbon === RibbonKind.Hong)
          || (brk.cheongdanPoints > 0 && c.ribbon === RibbonKind.Cheong)
          || (brk.chodanPoints > 0 && c.ribbon === RibbonKind.Cho))) {
        result.push(c);
      }
    }
    return result;
  },

  /** 포기·광팔기 결정을 적용해 실제 치는 3명과 광 정산을 계산. */
  resolve(
    table4: TableState, p2GiveUp: boolean, p3GiveUp: boolean, p4Sell: boolean,
    gwangUnitPrice: number, options: ScoreOptions,
  ): FourPlayerRound {
    if (table4.playerCount() !== 4) {
      throw new HwatuError(`4인 딜이 아닙니다(플레이어 ${table4.playerCount()}명).`);
    }

    const gwang: GwangSale = {
      sold: false, sellerSeat: -1, gwangCount: 0, valuePerPayer: 0, payerSeats: [],
    };

    if (p2GiveUp) {
      return { sitOutSeat: 1, playSeats: [0, 2, 3], gwang };
    }
    if (p3GiveUp) {
      return { sitOutSeat: 2, playSeats: [0, 1, 3], gwang };
    }

    // P2·P3 모두 참가 → P4는 광을 팔거나 그냥 빠진다.
    const round: FourPlayerRound = { sitOutSeat: 3, playSeats: [0, 1, 2], gwang };
    if (p4Sell) {
      gwang.sold = true;
      gwang.sellerSeat = 3;
      gwang.gwangCount = FourPlayer.gwangCount(table4.hand(3), options);
      gwang.valuePerPayer = gwang.gwangCount * gwangUnitPrice;
      gwang.payerSeats = [1, 2]; // 선(0) 제외
    }
    return round;
  },

  /** 협상 결과로 실제 치는 3인 게임 상태를 만든다. 선이 0번, 빠진 좌석 손패는 뒷패로 편입·재셔플. */
  buildGame(
    table4: TableState, round: FourPlayerRound, playerNames: readonly string[],
    randomBelow: RandomBelow = defaultRandomBelow,
  ): GameState {
    const state = new GameState(playerNames);

    for (let i = 0; i < round.playSeats.length; i++) {
      state.player(i).hand.push(...table4.hand(round.playSeats[i]!));
    }
    state.floor.push(...table4.floor);
    state.stock.push(...table4.stock);
    // 빠진 좌석의 손패를 뒷패로 편입(카드 경제 유지: 3인 7/6/21).
    state.stock.push(...table4.hand(round.sitOutSeat));

    // 편입한 죽은 패가 곧바로 다음 뒤집기로 몰려나오지 않도록 뒷패 전체를 다시 섞는다.
    const stock = state.stock;
    for (let i = stock.length - 1; i >= 1; i--) {
      const j = randomBelow(i + 1);
      if (j !== i) {
        const tmp = stock[i]!;
        stock[i] = stock[j]!;
        stock[j] = tmp;
      }
    }

    state.current = 0;
    return state;
  },
};
