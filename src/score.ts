// Gostop.Score.pas → TS 이식.
// 먹은 패의 족보 점수 계산(광/열끗/띠/피 + 고도리/홍청초단) · 국진 이중 해석 · 고/박 정산.

import { HwatuCard, HwatuKind, RibbonKind } from './cards.js';

/** 점수 계산 규칙 옵션(지역 룰 편차 흡수용). */
export interface ScoreOptions {
  /** 일반 3광 점수(기본 3). */
  bright3: number;
  /** 비광 포함 3광 점수(기본 2). */
  bright3WithBi: number;
  /** 4광 점수(기본 4). */
  bright4: number;
  /** 5광 점수(기본 15). */
  bright5: number;
  /** 열끗 점수 시작 장수(기본 5 → 5장부터 1점). */
  animalThreshold: number;
  /** 띠 점수 시작 장수(기본 5). */
  ribbonThreshold: number;
  /** 피 점수 시작 값(기본 10 → 피값 10부터 1점). */
  junkThreshold: number;
  /** 고도리 점수(기본 5). */
  godoriPoints: number;
  /** 홍단/청단/초단 각 점수(기본 3). */
  danPoints: number;
  /** 고 1회당 추가 점수(기본 1). */
  goBonusPerGo: number;
  /** 이 고 횟수부터 점수를 2배씩 불린다(기본 3 → 3고=×2, 4고=×4...). */
  goDoubleFromCount: number;
  /** 피박 활성화(기본 true). */
  pibakEnabled: boolean;
  /** 피박 판정 기준: 패자의 피값이 이 값 이하면 피박(기본 7). */
  pibakMaxJunk: number;
  /** 광박 활성화(기본 true). */
  gwangbakEnabled: boolean;
  /** 멍박(열끗박) 활성화(기본 true). */
  meongbakEnabled: boolean;
  /** 멍박 판정 기준: 승자 열끗이 이 장수 이상이어야 성립(기본 7). */
  meongbakMinAnimal: number;
  /** 고박 배수(기본 2). 1이면 배수 없음. */
  gobakMultiplier: number;
  /** 역고 활성화(기본 true). */
  reverseGoEnabled: boolean;
  /** 역고 배수(기본 4, '따따블'). */
  reverseGoMultiplier: number;
}

export const ScoreOptions = {
  /** 널리 쓰이는 표준 규칙값. */
  default(): ScoreOptions {
    return {
      bright3: 3,
      bright3WithBi: 2,
      bright4: 4,
      bright5: 15,
      animalThreshold: 5,
      ribbonThreshold: 5,
      junkThreshold: 10,
      godoriPoints: 5,
      danPoints: 3,
      goBonusPerGo: 1,
      goDoubleFromCount: 3,
      pibakEnabled: true,
      pibakMaxJunk: 7,
      gwangbakEnabled: true,
      meongbakEnabled: true,
      meongbakMinAnimal: 7,
      gobakMultiplier: 2,
      reverseGoEnabled: true,
      reverseGoMultiplier: 4,
    };
  },
};

/** 한 플레이어가 먹은 패의 점수 상세 내역(고·박 적용 전 족보 점수). */
export interface ScoreBreakdown {
  brightCount: number;
  brightPoints: number;
  /** 열끗 장수(피로 지급된 국진은 쌍피로 계산되어 제외). */
  animalCount: number;
  animalPoints: number;
  /** 고도리 점수(성립 시 godoriPoints, 아니면 0). */
  godoriPoints: number;
  ribbonCount: number;
  ribbonPoints: number;
  hongdanPoints: number;
  cheongdanPoints: number;
  chodanPoints: number;
  /** 피 총값(쌍피=2·3피=3). */
  junkValue: number;
  junkPoints: number;
  /** 족보 합계 점수(고·박 적용 전). */
  total: number;
  /** 이 내역이 소유 국진을 쌍피로 해석해 계산된 것이면 true. */
  gukjinAsPi: boolean;
}

/** 정산 결과(한 패자가 승자에게 지불할 점수와 배수·박 정보). */
export interface Settlement {
  points: number;
  multiplier: number;
  goBonus: number;
  /** 고로만 적용된 배수(표시용). 3고 미만이면 1. */
  goMultiplier: number;
  pibak: boolean;
  gwangbak: boolean;
  meongbak: boolean;
  reverseGo: boolean;
}

/** 내역을 사람이 읽을 수 있는 문자열로. */
export function breakdownToString(b: ScoreBreakdown): string {
  return (
    `총 ${b.total}점 [광 ${b.brightCount}장=${b.brightPoints}, ` +
    `열끗 ${b.animalCount}장=${b.animalPoints}(고도리 ${b.godoriPoints}), ` +
    `띠 ${b.ribbonCount}장=${b.ribbonPoints}(홍${b.hongdanPoints} 청${b.cheongdanPoints} 초${b.chodanPoints}), ` +
    `피값 ${b.junkValue}=${b.junkPoints}]`
  );
}

function emptyBreakdown(): ScoreBreakdown {
  return {
    brightCount: 0, brightPoints: 0,
    animalCount: 0, animalPoints: 0, godoriPoints: 0,
    ribbonCount: 0, ribbonPoints: 0,
    hongdanPoints: 0, cheongdanPoints: 0, chodanPoints: 0,
    junkValue: 0, junkPoints: 0,
    total: 0, gukjinAsPi: false,
  };
}

// 먹은 패의 족보 점수를 단일-패스로 계산(내부용).
// 국진: GukjinLocked면 항상 열끗. 그 외 소유 국진은 gukjinAsPi에 따라 열끗/쌍피로 계산.
function doEvaluate(captured: readonly HwatuCard[], options: ScoreOptions, gukjinAsPi: boolean): ScoreBreakdown {
  const r = emptyBreakdown();
  let hasBi = false;
  let godoriCount = 0;
  let hong = 0;
  let cheong = 0;
  let cho = 0;

  for (const card of captured) {
    switch (card.kind) {
      case HwatuKind.Bright:
        r.brightCount++;
        if (card.isBiGwang) hasBi = true;
        break;

      case HwatuKind.Animal:
        // 쌍피 전환권을 잃은 국진은 항상 열끗. 그 외 소유 국진은 호출자가 정한 해석을 따른다.
        if (card.isGukjin && !card.gukjinLocked && gukjinAsPi) {
          r.junkValue += 2;
        } else {
          r.animalCount++;
          if (card.isGodori) godoriCount++;
        }
        break;

      case HwatuKind.Ribbon:
        r.ribbonCount++;
        if (card.ribbon === RibbonKind.Hong) hong++;
        else if (card.ribbon === RibbonKind.Cheong) cheong++;
        else if (card.ribbon === RibbonKind.Cho) cho++;
        break;

      case HwatuKind.Junk:
      case HwatuKind.Bonus:
        r.junkValue += card.junkValue;
        break;
    }
  }

  // 광
  if (r.brightCount >= 5) {
    r.brightPoints = options.bright5;
  } else if (r.brightCount === 4) {
    r.brightPoints = options.bright4;
  } else if (r.brightCount === 3) {
    r.brightPoints = hasBi ? options.bright3WithBi : options.bright3;
  }

  // 열끗(개수) + 고도리
  if (r.animalCount >= options.animalThreshold) {
    r.animalPoints = r.animalCount - (options.animalThreshold - 1);
  }
  if (godoriCount >= 3) {
    r.godoriPoints = options.godoriPoints;
  }

  // 띠(개수) + 홍/청/초단
  if (r.ribbonCount >= options.ribbonThreshold) {
    r.ribbonPoints = r.ribbonCount - (options.ribbonThreshold - 1);
  }
  if (hong >= 3) r.hongdanPoints = options.danPoints;
  if (cheong >= 3) r.cheongdanPoints = options.danPoints;
  if (cho >= 3) r.chodanPoints = options.danPoints;

  // 피
  if (r.junkValue >= options.junkThreshold) {
    r.junkPoints = r.junkValue - (options.junkThreshold - 1);
  }

  r.total =
    r.brightPoints +
    r.animalPoints + r.godoriPoints +
    r.ribbonPoints + r.hongdanPoints + r.cheongdanPoints + r.chodanPoints +
    r.junkPoints;

  return r;
}

// 이 피값이면 피박을 면하는지(0장이면 면제, 기준 초과면 면제).
function isPibakSafe(junkValue: number, options: ScoreOptions): boolean {
  return junkValue === 0 || junkValue > options.pibakMaxJunk;
}

function hasOwnedGukjin(captured: readonly HwatuCard[]): boolean {
  return captured.some((c) => c.isGukjin && !c.gukjinLocked);
}

/** 먹은 패로부터 점수를 계산하고 고·박 정산을 수행하는 정적 계산기. (Delphi TScorer) */
export const Scorer = {
  /**
   * 먹은 패의 족보 점수 내역을 계산(고·박 적용 전).
   * 소유 국진이 있으면 열끗/쌍피 두 해석 중 총점이 높은 쪽을 자동 선택한다.
   */
  evaluate(captured: readonly HwatuCard[], options: ScoreOptions): ScoreBreakdown {
    let result = doEvaluate(captured, options, false);
    if (hasOwnedGukjin(captured)) {
      const asPi = doEvaluate(captured, options, true);
      if (asPi.total > result.total) {
        result = asPi;
        result.gukjinAsPi = true;
      }
    }
    return result;
  },

  /**
   * 패자 관점 족보 내역. 소유 국진이 있으면 총점이 아니라 "피박을 면하는지"를 우선 기준으로
   * 열끗/쌍피 해석을 고른다. 피박 면부가 두 해석에서 같으면 총점 높은 쪽.
   */
  evaluateAsLoser(captured: readonly HwatuCard[], options: ScoreOptions): ScoreBreakdown {
    let result = doEvaluate(captured, options, false);
    if (!hasOwnedGukjin(captured)) {
      return result;
    }

    const asPi = doEvaluate(captured, options, true);
    const animalSafe = isPibakSafe(result.junkValue, options);
    const piSafe = isPibakSafe(asPi.junkValue, options);

    if (piSafe && !animalSafe) {
      // 쌍피로 봐야만 피박을 면함 → 총점이 낮아져도 그쪽 선택(패자 총점은 정산에 안 쓰임).
      result = asPi;
      result.gukjinAsPi = true;
    } else if (animalSafe === piSafe && asPi.total > result.total) {
      result = asPi;
      result.gukjinAsPi = true;
    }
    return result;
  },

  /**
   * 승자가 한 패자로부터 받을 점수를 고·흔들기·피박·광박·멍박을 반영해 정산.
   * reverseGo가 true면 고 횟수 배수 대신 역고 배수를 쓴다.
   */
  settle(
    winner: ScoreBreakdown,
    loser: ScoreBreakdown,
    goCount: number,
    shakeCount: number,
    options: ScoreOptions,
    reverseGo = false,
  ): Settlement {
    const result: Settlement = {
      points: 0, multiplier: 1, goBonus: 0, goMultiplier: 1,
      pibak: false, gwangbak: false, meongbak: false, reverseGo: false,
    };

    // 고 보너스(가산) + 고 배수
    result.goBonus = goCount * options.goBonusPerGo;
    const base = winner.total + result.goBonus;

    if (reverseGo && options.reverseGoEnabled) {
      result.reverseGo = true;
      result.multiplier = options.reverseGoMultiplier;
    } else if (goCount >= options.goDoubleFromCount) {
      result.multiplier *= 1 << Math.min(goCount - (options.goDoubleFromCount - 1), 10);
    }
    result.goMultiplier = result.multiplier;

    // 흔들기: 각 ×2
    if (shakeCount > 0) {
      result.multiplier *= 1 << Math.min(shakeCount, 10);
    }

    // 광박: 승자가 광 점수를 냈고 패자 광 0장
    if (options.gwangbakEnabled && winner.brightPoints > 0 && loser.brightCount === 0) {
      result.gwangbak = true;
      result.multiplier *= 2;
    }

    // 피박: 승자가 피 점수를 냈고 패자 피값이 기준 이하(단 0장이면 면제)
    if (options.pibakEnabled && winner.junkPoints > 0 && loser.junkValue > 0
      && loser.junkValue <= options.pibakMaxJunk) {
      result.pibak = true;
      result.multiplier *= 2;
    }

    // 멍박(열끗박): 승자가 멍따로 열끗 점수를 냈고 패자 열끗 0장
    if (options.meongbakEnabled && winner.animalPoints > 0
      && winner.animalCount >= options.meongbakMinAnimal && loser.animalCount === 0) {
      result.meongbak = true;
      result.multiplier *= 2;
    }

    result.points = base * result.multiplier;
    return result;
  },
};
