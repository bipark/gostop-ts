// 이벤트 → 효과음 매핑 + 재생. 원본 Gostop.Audio.pas의 매핑을 그대로 옮겼다.
// 브라우저 자동재생 정책 때문에 첫 사용자 제스처 이후에만 소리가 난다(unlock()).

import { PlayEvent, PlayEventKind } from '../src/index.js';

const SOUND_OF: Partial<Record<PlayEventKind, string>> = {
  [PlayEventKind.Capture]: 'card_capture',
  [PlayEventKind.Place]: 'card_place',
  [PlayEventKind.BonusCapture]: 'sfx_coin',
  [PlayEventKind.Jjok]: 'sfx_jjok',
  [PlayEventKind.Ttadak]: 'sfx_ttadak',
  [PlayEventKind.Sseul]: 'sfx_sseul',
  [PlayEventKind.Bomb]: 'sfx_bomb',
  [PlayEventKind.Shake]: 'sfx_shake',
  [PlayEventKind.Bbeok]: 'sfx_bbeok',
  [PlayEventKind.Jabbeok]: 'sfx_bbeok',
  [PlayEventKind.Yeonbbeok]: 'sfx_bbeok',
  [PlayEventKind.Cheotbbeok]: 'sfx_bbeok',
  [PlayEventKind.Sambbeok]: 'sfx_bbeok',
  [PlayEventKind.Chongtong]: 'sfx_chongtong',
  [PlayEventKind.PiSteal]: 'sfx_pi_steal',
  [PlayEventKind.Go]: 'sfx_go',
  [PlayEventKind.ReverseGo]: 'sfx_go',
  [PlayEventKind.Stop]: 'sfx_stop',
  [PlayEventKind.GoStop]: 'sfx_gostop_prompt',
};

const cache = new Map<string, HTMLAudioElement>();
let enabled = true;
let lastName = '';
let lastAt = 0;

function el(name: string): HTMLAudioElement {
  let a = cache.get(name);
  if (!a) {
    a = new Audio(`/audio/${name}.ogg`);
    a.preload = 'auto';
    cache.set(name, a);
  }
  return a;
}

export function setSoundEnabled(on: boolean): void {
  enabled = on;
}

/** 임의 사운드 재생(중복 억제: 같은 소리 120ms 내 반복은 생략). */
export function play(name: string): void {
  if (!enabled) return;
  const now = performance.now();
  if (name === lastName && now - lastAt < 120) return;
  lastName = name;
  lastAt = now;
  const a = el(name);
  try {
    a.currentTime = 0;
    void a.play();
  } catch {
    /* 자동재생 차단 등은 무시 */
  }
}

/** 게임 이벤트에 매핑된 효과음 재생. */
export function playForEvent(e: PlayEvent): void {
  const name = SOUND_OF[e.kind];
  if (name) play(name);
}

export function playResult(win: boolean): void {
  play(win ? 'win' : 'lose');
}

/** 첫 제스처에서 오디오 컨텍스트 잠금 해제(무음 1회 재생). */
export function unlock(): void {
  for (const name of ['ui_click']) {
    const a = el(name);
    a.muted = true;
    void a.play().then(() => { a.pause(); a.currentTime = 0; a.muted = false; }).catch(() => { a.muted = false; });
  }
}
