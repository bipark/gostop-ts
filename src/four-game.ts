// Gostop.FourGame.pas → TS 이식.
// 4인 한 라운드를 조립·진행: 4인 딜 → 광팔기 협상 → 3인 플레이 → 광값(선불)과 게임 정산을
// 합쳐 좌석별 순손익(제로섬)을 낸다.

import { HwatuError } from './cards.js';
import { ScoreOptions } from './score.js';
import { Deck } from './deck.js';
import { DealConfig, Dealer, RandomBelow } from './deal.js';
import {
  GamePhase, TurnEngine, PlayerAgent,
} from './play.js';
import {
  FourPlayer, GwangSale,
} from './four-player.js';

/** 제한시간 내 한 플레이어의 결정. 타이머는 UI가 관리, 만료 시 responded=false. */
export interface TimedDecision {
  responded: boolean;
  /** P2·P3는 '포기 여부', P4는 '광팔기 여부'. */
  choice: boolean;
}

export const TimedDecision = {
  answered(choice: boolean): TimedDecision {
    return { responded: true, choice };
  },
  timedOut(): TimedDecision {
    return { responded: false, choice: false };
  },
};

/** 4인 라운드의 협상 결정(포기·광팔기). */
export interface FourDecisions {
  p2GiveUp: boolean;
  p3GiveUp: boolean;
  p4Sell: boolean;
}

export const FourDecisions = {
  /** 표준: 아무도 포기하지 않고 P4가 광을 판다. */
  standard(): FourDecisions {
    return { p2GiveUp: false, p3GiveUp: false, p4Sell: true };
  },
  /** 제한시간 결정에서 최종 결정. 미응답 시 P2·P3 자동 참가, P4 자동 광팔기. */
  fromTimed(p2: TimedDecision, p3: TimedDecision, p4: TimedDecision): FourDecisions {
    return {
      p2GiveUp: p2.responded && p2.choice,
      p3GiveUp: p3.responded && p3.choice,
      p4Sell: p4.responded ? p4.choice : true,
    };
  },
};

/** 4인 한 라운드의 최종 결과. */
export interface FourGameResult {
  /** 좌석별 순손익(+받음/−지불). 광값 선불 + 게임 정산 합산. 합은 0. */
  net: [number, number, number, number];
  /** 이긴 좌석(0~3) 또는 -1(나가리). */
  winnerSeat: number;
  /** 빠진 좌석(광 판 P4 또는 포기한 P2/P3). */
  sitOutSeat: number;
  gwang: GwangSale;
  /** 실제 진행한 수(디버그/통계용). */
  plays: number;
}

/** 4인 고스톱 한 라운드를 조립·진행하는 관리자. (Delphi TFourGame) */
export const FourGame = {
  /**
   * 주어진 덱·에이전트 4명·결정으로 한 라운드를 끝까지 진행하고 결과를 반환.
   * @param stakes 판돈 배수(게임 정산에만 곱함, 광값은 배수 미적용).
   */
  run(
    deck: Deck, ais: readonly PlayerAgent[], decisions: FourDecisions,
    gwangUnitPrice: number, options: ScoreOptions, stakes = 1,
    randomBelow?: RandomBelow,
  ): FourGameResult {
    if (ais.length !== 4) {
      throw new HwatuError(`4인 게임에는 에이전트 4명이 필요합니다(전달 ${ais.length}명).`);
    }

    const result: FourGameResult = {
      net: [0, 0, 0, 0], winnerSeat: -1, sitOutSeat: -1,
      gwang: { sold: false, sellerSeat: -1, gwangCount: 0, valuePerPayer: 0, payerSeats: [] },
      plays: 0,
    };

    // 1) 4인 딜
    const table = Dealer.deal(deck, DealConfig.custom(4, 7, 6));

    // 2) 광팔기 협상
    const round = FourPlayer.resolve(
      table, decisions.p2GiveUp, decisions.p3GiveUp, decisions.p4Sell, gwangUnitPrice, options,
    );
    result.sitOutSeat = round.sitOutSeat;
    result.gwang = round.gwang;

    // 3) 광값 선불(선 제외, P2·P3 → P4)
    if (round.gwang.sold) {
      for (const payer of round.gwang.payerSeats) {
        result.net[payer]! -= round.gwang.valuePerPayer;
        result.net[round.gwang.sellerSeat]! += round.gwang.valuePerPayer;
      }
    }

    // 4) 실제 치는 3인 게임 구성·진행
    const game = FourPlayer.buildGame(table, round, ['P0', 'P1', 'P2'], randomBelow);
    const engine = new TurnEngine(game, options);
    engine.applyFloorBonus();
    engine.applyHandChongtong();
    while (game.phase !== GamePhase.Finished && result.plays < 8000) {
      const seat = round.playSeats[game.current]!; // 게임 좌석 → 원래 좌석 AI
      ais[seat]!.act(engine);
      result.plays++;
    }

    // 5) 게임 정산 → 원래 좌석에 합산(판돈 배수는 게임 정산에만)
    const settle = engine.finalSettlement();
    for (let i = 0; i < round.playSeats.length; i++) {
      const seat = round.playSeats[i]!;
      result.net[seat]! += settle[i]!.net * stakes;
    }
    if (game.winner >= 0) {
      result.winnerSeat = round.playSeats[game.winner]!;
    }

    return result;
  },

  /** 표준 결정(광팔기)으로 한 라운드 진행. */
  runAuto(
    deck: Deck, ais: readonly PlayerAgent[], gwangUnitPrice: number,
    options: ScoreOptions, stakes = 1, randomBelow?: RandomBelow,
  ): FourGameResult {
    return FourGame.run(deck, ais, FourDecisions.standard(), gwangUnitPrice, options, stakes, randomBelow);
  },

  /** 나가리 판돈 이월: 나가리이고 전원 동의면 다음 판돈 2배, 아니면 1로 리셋. */
  nextStakes(currentStakes: number, wasNagari: boolean, allAgree: boolean): number {
    return wasNagari && allAgree ? currentStakes * 2 : 1;
  },
};
