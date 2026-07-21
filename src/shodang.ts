// Gostop.Shodang.pas → TS 이식.
// 쇼당(3인): 상대가 먹은 패로 미완성 족보(정확히 2장)를 가졌고, 호출자가 그 족보를 완성시키는
// 패(같은 족보이면서 상대에게 없는 월)를 손에 들고 있으면 위협. 두 상대 모두 위협하면 쇼당 가능.

import { HwatuCard, HwatuKind, RibbonKind } from './cards.js';
import { GameState, PlayerResult } from './play.js';

/** 쇼당 판정 대상 족보. */
export enum ShodangGroup { Gwang, Godori, Hong, Cheong, Cho }
const ALL_GROUPS = [ShodangGroup.Gwang, ShodangGroup.Godori, ShodangGroup.Hong, ShodangGroup.Cheong, ShodangGroup.Cho];

/** 쇼당 위협 1건. */
export interface ShodangThreat { opponent: number; group: string; cardId: string }
/** 쇼당 판정 결과. */
export interface ShodangResult { callable: boolean; threats: ShodangThreat[] }

/** 쇼당 응답 결과 종류. */
export enum ShodangOutcome {
  Nagari = 'nagari',     // 두 상대 모두 수락 → 나가리
  Continue = 'continue', // 두 상대 모두 거절 → 계속
  Pushed = 'pushed',     // 한 명 수락 → 밀어주기(거절자 독박 대기)
}
/** 쇼당 응답을 종합한 결정. */
export interface ShodangDecision {
  outcome: ShodangOutcome; caller: number; accepter: number; decliner: number;
}

function inGroup(card: HwatuCard, group: ShodangGroup): boolean {
  switch (group) {
    case ShodangGroup.Gwang: return card.kind === HwatuKind.Bright;
    case ShodangGroup.Godori: return card.kind === HwatuKind.Animal && card.isGodori;
    case ShodangGroup.Hong: return card.kind === HwatuKind.Ribbon && card.ribbon === RibbonKind.Hong;
    case ShodangGroup.Cheong: return card.kind === HwatuKind.Ribbon && card.ribbon === RibbonKind.Cheong;
    default: return card.kind === HwatuKind.Ribbon && card.ribbon === RibbonKind.Cho;
  }
}
function groupName(group: ShodangGroup): string {
  return ['광', '고도리', '홍단', '청단', '초단'][group]!;
}

export const Shodang = {
  /** ACaller가 쇼당을 걸 수 있는지 판정. */
  detect(game: GameState, caller: number): ShodangResult {
    const result: ShodangResult = { callable: false, threats: [] };
    if (game.playerCount() !== 3) return result;

    let threatenedCount = 0;
    for (let opp = 0; opp < game.playerCount(); opp++) {
      if (opp === caller) continue;
      let oppThreat = false;
      for (const group of ALL_GROUPS) {
        // 상대 먹은패에서 이 족보 장수 + 월 수집
        const months: number[] = [];
        for (const c of game.player(opp).captured) {
          if (inGroup(c, group)) months.push(c.month);
        }
        // 미완성(정확히 2장)이고, 호출자가 완성패(그 족보이면서 상대가 없는 월)를 보유?
        if (months.length === 2) {
          for (const h of game.player(caller).hand) {
            if (inGroup(h, group) && !months.includes(h.month)) {
              result.threats.push({ opponent: opp, group: groupName(group), cardId: h.assetId });
              oppThreat = true;
              break;
            }
          }
        }
        if (oppThreat) break; // 이 상대는 한 건이면 충분
      }
      if (oppThreat) threatenedCount++;
    }
    result.callable = threatenedCount === 2;
    return result;
  },

  /** 두 상대의 수락 여부를 종합해 쇼당 결정을 반환. */
  resolve(caller: number, oppA: number, oppB: number, accA: boolean, accB: boolean): ShodangDecision {
    const d: ShodangDecision = { outcome: ShodangOutcome.Continue, caller, accepter: -1, decliner: -1 };
    if (accA && accB) { d.outcome = ShodangOutcome.Nagari; return d; }
    if (!accA && !accB) { d.outcome = ShodangOutcome.Continue; return d; }
    d.outcome = ShodangOutcome.Pushed;
    if (accA) { d.accepter = oppA; d.decliner = oppB; }
    else { d.accepter = oppB; d.decliner = oppA; }
    return d;
  },

  /**
   * 독박 재분배: 수락자가 이겼으면 거절자가 호출자+거절자 두 몫 전액을 부담, 호출자는 면제.
   * settle을 제자리 수정. 재분배 시 거절자 인덱스, 아니면 -1 반환.
   */
  applyDokbak(settle: PlayerResult[], playerCount: number, winner: number, caller: number, accepter: number, decliner: number): number {
    if (playerCount === 3 && winner >= 0 && winner === accepter
      && caller >= 0 && decliner >= 0 && caller !== winner && decliner !== winner) {
      const callerLoss = -settle[caller]!.net;
      const declinerLoss = -settle[decliner]!.net;
      settle[caller]!.net = 0;
      settle[decliner]!.net = -(callerLoss + declinerLoss);
      return decliner;
    }
    return -1;
  },
};
