// Gostop.Cards.pas → TS 이식.
// 화투 카드 모델 · 종류/띠 분류 · 표준 48장 카탈로그 · 보너스패.
// Delphi record(값 타입)는 여기서 순수 데이터 객체(HwatuCard)로 옮기고,
// 카탈로그 팩토리는 호출할 때마다 새 객체 배열을 만들어 값-복사 시맨틱을 흉내낸다.

/** 화투 카드의 종류(족보 분류). */
export enum HwatuKind {
  Bright = 'bright', // 광(光)
  Animal = 'animal', // 열끗(십)
  Ribbon = 'ribbon', // 띠(단)
  Junk = 'junk',     // 피(껍데기)
  Bonus = 'bonus',   // 보너스패(조커)
}

/** 띠(단) 카드의 색 분류. */
export enum RibbonKind {
  None = 'none',     // 띠 아님 또는 일반 띠(예: 12월 비 띠)
  Hong = 'hong',     // 홍단
  Cheong = 'cheong', // 청단
  Cho = 'cho',       // 초단
}

// Delphi enum THwatuKind의 서수(정렬 기준). 손패 정렬 등에서 Ord(Kind)를 대신한다.
const KIND_ORDINAL: Record<HwatuKind, number> = {
  [HwatuKind.Bright]: 0,
  [HwatuKind.Animal]: 1,
  [HwatuKind.Ribbon]: 2,
  [HwatuKind.Junk]: 3,
  [HwatuKind.Bonus]: 4,
};

/** 종류의 정렬 서수(Delphi Ord(THwatuKind)와 동일). */
export function kindOrdinal(kind: HwatuKind): number {
  return KIND_ORDINAL[kind];
}

/** 종류의 한글 명칭. (광/열끗/띠/피/보너스) */
export function kindToString(kind: HwatuKind): string {
  switch (kind) {
    case HwatuKind.Bright: return '광';
    case HwatuKind.Animal: return '열끗';
    case HwatuKind.Ribbon: return '띠';
    case HwatuKind.Junk: return '피';
    case HwatuKind.Bonus: return '보너스';
    default: return '';
  }
}

/** 띠 색 분류의 한글 명칭. */
export function ribbonToString(ribbon: RibbonKind): string {
  switch (ribbon) {
    case RibbonKind.Hong: return '홍단';
    case RibbonKind.Cheong: return '청단';
    case RibbonKind.Cho: return '초단';
    default: return '';
  }
}

/**
 * 화투 카드 한 장. 식별 정보(월·종류·순번·에셋 ID)와 점수 계산에 필요한
 * 메타(피 값·고도리·비광·국진·띠 색)를 담는다. (Delphi THwatuCard record)
 */
export interface HwatuCard {
  /** 월(1~12). 보너스패는 0. */
  month: number;
  /** 카드 종류(족보 분류). */
  kind: HwatuKind;
  /** 같은 월·종류 내 구분 순번(피 1/2/3 등). 1부터 시작. */
  ordinal: number;
  /** 이미지 파일 stem(확장자 제외). 예: 'november_kasu_1', 'bonus_sampi'. */
  assetId: string;
  /** 피로 계산될 때의 값. 0=피 아님, 1=일반 피, 2=쌍피, 3=3피. */
  junkValue: number;
  /** 띠 색 분류(홍단/청단/초단). 띠가 아니면 None. */
  ribbon: RibbonKind;
  /** 고도리 새(2월 매조·4월 흑싸리·8월 공산 열끗)이면 true. */
  isGodori: boolean;
  /** 비광(12월 비의 광)이면 true. 3광 계산 시 특별 취급. */
  isBiGwang: boolean;
  /** 국진(9월 국화 열끗)이면 true. 룰에 따라 쌍피로 사용 가능. */
  isGukjin: boolean;
  /**
   * 국진 전용: 피 뺏기 대상인데 낼 일반 피가 하나도 없어 국진 자신도 넘기지 않고 버틴 경우 true.
   * 이후 이 판에서는 열끗↔쌍피 자동 전환 권한을 잃고 항상 열끗으로만 계산된다.
   */
  gukjinLocked: boolean;
}

// 월별 한글 명칭(1~12). 화투 관례: 11월=똥, 12월=비.
const MONTH_NAMES = [
  '송학', '매조', '벚꽃', '흑싸리', '난초', '모란',
  '홍싸리', '공산', '국화', '단풍', '똥', '비',
];

/** 사람이 읽을 수 있는 한글 카드 이름. 예: '11월 똥 광'. */
export function displayName(card: HwatuCard): string {
  if (card.kind === HwatuKind.Bonus) {
    switch (card.junkValue) {
      case 3: return '보너스 3피';
      case 2: return '보너스 쌍피';
      default: return '보너스패';
    }
  }

  if (card.month < 1 || card.month > 12) {
    return card.assetId;
  }

  const name = MONTH_NAMES[card.month - 1];
  if (card.kind === HwatuKind.Junk) {
    return `${card.month}월 ${name} 피${card.ordinal}`;
  }

  return `${card.month}월 ${name} ${kindToString(card.kind)}`;
}

/** 이미지 파일명. 예: imageFileName(card, 'png') → 'january_hikari.png'. */
export function imageFileName(card: HwatuCard, ext = 'png'): string {
  return `${card.assetId}.${ext}`;
}

// 카탈로그 헬퍼: 기본값으로 채운 카드에 지정 필드만 덮어써 생성.
function makeCard(partial: Partial<HwatuCard>): HwatuCard {
  return {
    month: 0,
    kind: HwatuKind.Junk,
    ordinal: 0,
    assetId: '',
    junkValue: 0,
    ribbon: RibbonKind.None,
    isGodori: false,
    isBiGwang: false,
    isGukjin: false,
    gukjinLocked: false,
    ...partial,
  };
}

/** 표준 화투 카드 정본 테이블을 제공하는 정적 카탈로그. (Delphi THwatuCatalog) */
export const HwatuCatalog = {
  /** 표준 48장 카드 배열을 생성해 반환(월 1→12, 종류 순). 매 호출마다 새 객체. */
  standard(): HwatuCard[] {
    const K = HwatuKind;
    const R = RibbonKind;
    return [
      // 1월 송학: 광 · 홍단 · 피2
      makeCard({ month: 1, kind: K.Bright, ordinal: 1, assetId: 'january_hikari' }),
      makeCard({ month: 1, kind: K.Ribbon, ordinal: 1, assetId: 'january_tanzaku', ribbon: R.Hong }),
      makeCard({ month: 1, kind: K.Junk, ordinal: 1, assetId: 'january_kasu_1', junkValue: 1 }),
      makeCard({ month: 1, kind: K.Junk, ordinal: 2, assetId: 'january_kasu_2', junkValue: 1 }),

      // 2월 매조: 열끗(고도리) · 홍단 · 피2
      makeCard({ month: 2, kind: K.Animal, ordinal: 1, assetId: 'february_tane', isGodori: true }),
      makeCard({ month: 2, kind: K.Ribbon, ordinal: 1, assetId: 'february_tanzaku', ribbon: R.Hong }),
      makeCard({ month: 2, kind: K.Junk, ordinal: 1, assetId: 'february_kasu_1', junkValue: 1 }),
      makeCard({ month: 2, kind: K.Junk, ordinal: 2, assetId: 'february_kasu_2', junkValue: 1 }),

      // 3월 벚꽃: 광 · 홍단 · 피2
      makeCard({ month: 3, kind: K.Bright, ordinal: 1, assetId: 'march_hikari' }),
      makeCard({ month: 3, kind: K.Ribbon, ordinal: 1, assetId: 'march_tanzaku', ribbon: R.Hong }),
      makeCard({ month: 3, kind: K.Junk, ordinal: 1, assetId: 'march_kasu_1', junkValue: 1 }),
      makeCard({ month: 3, kind: K.Junk, ordinal: 2, assetId: 'march_kasu_2', junkValue: 1 }),

      // 4월 흑싸리: 열끗(고도리) · 초단 · 피2
      makeCard({ month: 4, kind: K.Animal, ordinal: 1, assetId: 'april_tane', isGodori: true }),
      makeCard({ month: 4, kind: K.Ribbon, ordinal: 1, assetId: 'april_tanzaku', ribbon: R.Cho }),
      makeCard({ month: 4, kind: K.Junk, ordinal: 1, assetId: 'april_kasu_1', junkValue: 1 }),
      makeCard({ month: 4, kind: K.Junk, ordinal: 2, assetId: 'april_kasu_2', junkValue: 1 }),

      // 5월 난초: 열끗 · 초단 · 피2
      makeCard({ month: 5, kind: K.Animal, ordinal: 1, assetId: 'may_tane' }),
      makeCard({ month: 5, kind: K.Ribbon, ordinal: 1, assetId: 'may_tanzaku', ribbon: R.Cho }),
      makeCard({ month: 5, kind: K.Junk, ordinal: 1, assetId: 'may_kasu_1', junkValue: 1 }),
      makeCard({ month: 5, kind: K.Junk, ordinal: 2, assetId: 'may_kasu_2', junkValue: 1 }),

      // 6월 모란: 열끗 · 청단 · 피2
      makeCard({ month: 6, kind: K.Animal, ordinal: 1, assetId: 'june_tane' }),
      makeCard({ month: 6, kind: K.Ribbon, ordinal: 1, assetId: 'june_tanzaku', ribbon: R.Cheong }),
      makeCard({ month: 6, kind: K.Junk, ordinal: 1, assetId: 'june_kasu_1', junkValue: 1 }),
      makeCard({ month: 6, kind: K.Junk, ordinal: 2, assetId: 'june_kasu_2', junkValue: 1 }),

      // 7월 홍싸리: 열끗 · 초단 · 피2
      makeCard({ month: 7, kind: K.Animal, ordinal: 1, assetId: 'july_tane' }),
      makeCard({ month: 7, kind: K.Ribbon, ordinal: 1, assetId: 'july_tanzaku', ribbon: R.Cho }),
      makeCard({ month: 7, kind: K.Junk, ordinal: 1, assetId: 'july_kasu_1', junkValue: 1 }),
      makeCard({ month: 7, kind: K.Junk, ordinal: 2, assetId: 'july_kasu_2', junkValue: 1 }),

      // 8월 공산: 광 · 열끗(고도리) · 피2
      makeCard({ month: 8, kind: K.Bright, ordinal: 1, assetId: 'august_hikari' }),
      makeCard({ month: 8, kind: K.Animal, ordinal: 1, assetId: 'august_tane', isGodori: true }),
      makeCard({ month: 8, kind: K.Junk, ordinal: 1, assetId: 'august_kasu_1', junkValue: 1 }),
      makeCard({ month: 8, kind: K.Junk, ordinal: 2, assetId: 'august_kasu_2', junkValue: 1 }),

      // 9월 국화: 열끗(국진) · 청단 · 피2
      makeCard({ month: 9, kind: K.Animal, ordinal: 1, assetId: 'september_tane', isGukjin: true }),
      makeCard({ month: 9, kind: K.Ribbon, ordinal: 1, assetId: 'september_tanzaku', ribbon: R.Cheong }),
      makeCard({ month: 9, kind: K.Junk, ordinal: 1, assetId: 'september_kasu_1', junkValue: 1 }),
      makeCard({ month: 9, kind: K.Junk, ordinal: 2, assetId: 'september_kasu_2', junkValue: 1 }),

      // 10월 단풍: 열끗 · 청단 · 피2
      makeCard({ month: 10, kind: K.Animal, ordinal: 1, assetId: 'october_tane' }),
      makeCard({ month: 10, kind: K.Ribbon, ordinal: 1, assetId: 'october_tanzaku', ribbon: R.Cheong }),
      makeCard({ month: 10, kind: K.Junk, ordinal: 1, assetId: 'october_kasu_1', junkValue: 1 }),
      makeCard({ month: 10, kind: K.Junk, ordinal: 2, assetId: 'october_kasu_2', junkValue: 1 }),

      // 11월 똥: 똥광 · 똥피2 · 똥쌍피
      makeCard({ month: 11, kind: K.Bright, ordinal: 1, assetId: 'november_hikari' }),
      makeCard({ month: 11, kind: K.Junk, ordinal: 1, assetId: 'november_kasu_1', junkValue: 1 }),
      makeCard({ month: 11, kind: K.Junk, ordinal: 2, assetId: 'november_kasu_2', junkValue: 1 }),
      makeCard({ month: 11, kind: K.Junk, ordinal: 3, assetId: 'november_kasu_3', junkValue: 2 }), // 똥쌍피

      // 12월 비: 광(비광) · 열끗 · 띠 · 쌍피(비쌍피=2피)
      makeCard({ month: 12, kind: K.Bright, ordinal: 1, assetId: 'december_hikari', isBiGwang: true }),
      makeCard({ month: 12, kind: K.Animal, ordinal: 1, assetId: 'december_tane' }),
      makeCard({ month: 12, kind: K.Ribbon, ordinal: 1, assetId: 'december_tanzaku' }),
      makeCard({ month: 12, kind: K.Junk, ordinal: 1, assetId: 'december_kasu', junkValue: 2 }), // 비쌍피
    ];
  },

  /** 보너스패 3장(쌍피 2 · 3피 1). 실물 정통 구성. 매 호출마다 새 객체. */
  bonus(): HwatuCard[] {
    return [
      makeCard({ month: 0, kind: HwatuKind.Bonus, ordinal: 1, assetId: 'bonus_ssangpi_1', junkValue: 2 }),
      makeCard({ month: 0, kind: HwatuKind.Bonus, ordinal: 2, assetId: 'bonus_ssangpi_2', junkValue: 2 }),
      makeCard({ month: 0, kind: HwatuKind.Bonus, ordinal: 3, assetId: 'bonus_sampi', junkValue: 3 }),
    ];
  },
};

/** 화투/고스톱 도메인 공통 베이스 예외. (Delphi EHwatuError) */
export class HwatuError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HwatuError';
  }
}
