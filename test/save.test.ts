import { describe, it, expect } from 'vitest';
import { HwatuCatalog } from '../src/cards.js';
import { cardToSave, cardFromSave, cardsToSave, cardsFromSave } from '../web/save.js';

describe('카드 직렬화 round-trip', () => {
  it('assetId만 저장하고 카탈로그에서 전 메타 복원', () => {
    for (const c of [...HwatuCatalog.standard(), ...HwatuCatalog.bonus()]) {
      const restored = cardFromSave(cardToSave(c));
      expect(restored).toEqual(c);
    }
  });

  it('gukjinLocked 플래그 보존', () => {
    const gukjin = HwatuCatalog.standard().find((c) => c.isGukjin)!;
    const locked = { ...gukjin, gukjinLocked: true };
    expect(cardFromSave(cardToSave(locked)).gukjinLocked).toBe(true);
    expect(cardFromSave(cardToSave(gukjin)).gukjinLocked).toBe(false);
  });

  it('JSON 직렬화 후에도 복원(localStorage 왕복 모사)', () => {
    const hand = HwatuCatalog.standard().slice(0, 10);
    const wire = JSON.parse(JSON.stringify(cardsToSave(hand)));
    expect(cardsFromSave(wire)).toEqual(hand);
  });

  it('뻑 더미에 묻힌 보너스패의 변경된 월 보존(회귀)', () => {
    // 엔진은 뻑이 나면 보너스패를 {...bonus, month: 뻑월} 복제본으로 바닥에 묻는다.
    const bonus = HwatuCatalog.bonus()[0]!;
    const buried = { ...bonus, month: 7 }; // 7월 뻑 더미에 묻힘
    const restored = cardFromSave(cardToSave(buried));
    expect(restored.month).toBe(7); // 이걸 잃으면 복원 후 더미 캡처에서 미아가 된다
    expect(restored.kind).toBe(bonus.kind);
    // 정상 카드는 여전히 컴팩트(월 오버라이드 없음)
    expect(cardToSave(bonus)).toEqual({ a: bonus.assetId });
  });

  it('저장 크기: 카드당 assetId만 → 배열 컴팩트', () => {
    const saved = cardsToSave(HwatuCatalog.standard());
    // 각 항목은 {a: string} (국진 락 시 g:1) — 불필요한 메타 없음
    expect(saved.every((s) => Object.keys(s).every((k) => k === 'a' || k === 'g'))).toBe(true);
  });
});
