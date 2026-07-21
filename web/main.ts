// 웹 보드 UI: 2인(맞고) + 4인(광팔기). 인간은 항상 선(원좌석 0)으로 참여하고,
// 4인에서는 나머지 3명(AI)이 협상(포기/광팔기)한다. 엔진은 src/에서 그대로 import.

import {
  Deck, DeckOptions, DealConfig, Dealer,
  GameState, TurnEngine, GamePhase, ScoreOptions, Scorer,
  PlayEvent, PlayEventKind, HwatuCard, HwatuKind, displayName,
  FourPlayer, FourPlayerRound, Shodang, ShodangOutcome, ShodangDecision, ShodangThreat,
} from '../src/index.js';
import { AiPlayer } from '../src/ai.js';
import * as audio from './audio.js';
import {
  Character, Emotion, loadCharacters, allCharacters, characterAt,
  derivedSkill, nerveBias, greedBias, avatarUrl, randomQuote,
} from './characters.js';
import {
  SaveData, saveGame, loadGame, clearGame, hasSave, cardsToSave, cardsFromSave,
  loadProfile, saveProfile, GameSettings, loadSettings, saveSettings,
} from './save.js';

let settings: GameSettings = loadSettings();
// 룰 토글을 반영한 점수 옵션(원본 Settings.pas의 피박/광박/멍박/고박/역고 토글).
function buildScoreOptions(): ScoreOptions {
  const o = ScoreOptions.default();
  o.pibakEnabled = settings.pibak;
  o.gwangbakEnabled = settings.gwangbak;
  o.meongbakEnabled = settings.meongbak;
  o.reverseGoEnabled = settings.reverseGo;
  if (!settings.gobak) o.gobakMultiplier = 1;
  return o;
}
let OPT = buildScoreOptions();
const HUMAN_ORIG = 0;
const GWANG_UNIT = 1;   // 광 1개당 점수
const SEED_MONEY = 1_000_000; // 좌석별 시드머니(원본 TGostopConfig.SeedMoney)
const LOW_QUALITY = 6;  // 이보다 손패 품질이 낮으면 AI가 포기 고려

// ---- 게임 상태 ----
let mode: 2 | 3 | 4 = 2;
let engine: TurnEngine;
let gameToOrig: number[] = [];          // 게임 좌석 인덱스 → 원좌석(0..mode-1)
let charByOrig: Character[] = [];       // 원좌석별 캐릭터
const agentByOrig = new Map<number, AiPlayer>();
let round: FourPlayerRound | null = null;
let gwangNet: number[] = [];            // 원좌석별 광값 선불 손익
let seatMoney: number[] = [];           // 원좌석별 잔액(원). 세션 시작 시 시드머니(원본 SeedMoney)
let wins: number[] = [];                 // 원좌석별 승
let losses: number[] = [];               // 원좌석별 패
let moneyPerPoint = 100;                 // 점당 금액(원). 원본은 게임 레벨에서 파생(50/100/500/1000)
let pendingReplace: { orig: number; ch: Character }[] = []; // 오링 AI 교체(다음 판 시작 시 적용)
let shodangPushed: { caller: number; accepter: number; decliner: number } | null = null; // 3인 쇼당 밀어주기(게임 인덱스)
let shodangDone = false;                // 이번 판에 쇼당을 이미 시도했는가
let spectate = false;                   // 관전 모드(모든 좌석 AI, 자동 진행)
let paused = false;                     // 일시정지(원본 FPaused): 게임 진행 대기가 멈춘다
let autoPlay = false;                   // 자동 진행(원본 FAutoPlay): 이번 판만 내 차례를 AI가 대신
let stakes = 1;                          // 판돈 배수(나가리 시 다음 판으로 ×2 이월, 원본 NextStakes)
let gukjinAsPiSeats = new Set<number>(); // 정산 시 국진을 쌍피로 표시할 게임 좌석(이동 연출용)
let seonOrig = 0;                        // 이번 판 선(원좌석). 새 세션은 밤일낮장, 이후 승자가 선(나가리는 유지).
let gaveUpLast: boolean[] = [];          // 4인 연사 규칙: 직전 판에 포기했으면 이번 판은 포기 불가(원좌석별)
const emotionByOrig: Emotion[] = [];
const emotionTimers: number[] = [];
let busy = false;
let dealing = false;
// 게임 세대 토큰: 새 게임/이어하기마다 증가. 이전 세대의 비동기 루프(drive/셔플/기리/정산 대기)는
// await에서 깨어난 뒤 자기 세대가 아니면 즉시 종료한다 — "버려진 게임이 뒤에서 계속 돌던" 레이스 제거.
let epoch = 0;
let giriCancelFn: (() => void) | null = null; // 대기 중인 기리(떼기) 취소 훅

const AUTO = new URLSearchParams(location.search).has('auto');
const $ = (id: string) => document.getElementById(id)!;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// 게임 페이싱 대기: 게임속도 배속을 적용하고, 일시정지 중에는 풀릴 때까지 기다린다.
async function gameDelay(ms: number): Promise<void> {
  await sleep(ms / (settings.gameSpeed || 1));
  while (paused) await sleep(120);
}
const humanName = (): string => settings.nickname || '나';
const cardUrl = (assetId: string) => `${import.meta.env.BASE_URL}hwatu/${assetId}.png`;

// ---- 좌석 DOM(상대는 동적 생성, 인간은 고정 HTML) ----
interface SeatEls { root: HTMLElement; avatar: HTMLImageElement; name: HTMLElement; job: HTMLElement; score: HTMLElement; money: HTMLElement; bubble: HTMLElement; panel: HTMLElement; hand: HTMLElement; captured: HTMLElement }
const oppEls = new Map<number, SeatEls>();

function makeOppSeat(orig: number): SeatEls {
  const root = document.createElement('div');
  root.className = 'seat opp';
  root.innerHTML = `
    <div class="panel">
      <img class="avatar" alt="" />
      <div class="panel-info">
        <div class="pname"></div><div class="pjob"></div><div class="pscore">0점</div><div class="pmoney"></div>
      </div>
      <div class="bubble hidden"></div>
    </div>
    <div class="hand backs"></div>
    <div class="captured"></div>`;
  $('opponents').appendChild(root);
  return {
    root,
    avatar: root.querySelector('.avatar')!,
    name: root.querySelector('.pname')!,
    job: root.querySelector('.pjob')!,
    score: root.querySelector('.pscore')!,
    money: root.querySelector('.pmoney')!,
    bubble: root.querySelector('.bubble')!,
    panel: root.querySelector('.panel')!,
    hand: root.querySelector('.hand')!,
    captured: root.querySelector('.captured')!,
  };
}

const fmtWon = (n: number): string => `${n.toLocaleString('ko-KR')}원`;
const seatInfoText = (orig: number): string =>
  `${fmtWon(seatMoney[orig] ?? 0)} · ${wins[orig] ?? 0}승${losses[orig] ?? 0}패`;
const avatarOf = (orig: number): HTMLImageElement =>
  orig === HUMAN_ORIG ? ($('myAvatar') as HTMLImageElement) : oppEls.get(orig)!.avatar;
const bubbleOf = (orig: number): HTMLElement =>
  orig === HUMAN_ORIG ? $('myBubble') : oppEls.get(orig)!.bubble;

// ---- 카드 DOM + FLIP ----
function cardEl(card: HwatuCard | null, opts: { onClick?: () => void; cls?: string } = {}): HTMLElement {
  const el = document.createElement('div');
  el.className = 'card' + (opts.cls ? ` ${opts.cls}` : '');
  el.style.backgroundImage = `url(${cardUrl(card ? card.assetId : 'back_red')})`;
  if (card) { el.title = displayName(card); el.dataset.key = card.assetId; }
  if (opts.onClick) el.addEventListener('click', opts.onClick);
  return el;
}
function renderZone(container: HTMLElement, cards: readonly HwatuCard[], faceDown: boolean,
  mk: (c: HwatuCard, i: number) => { onClick?: () => void; cls?: string } = () => ({})): void {
  container.replaceChildren(...cards.map((c, i) => cardEl(faceDown ? null : c, faceDown ? {} : mk(c, i))));
}
function captureRects(): Map<string, DOMRect> {
  const m = new Map<string, DOMRect>();
  document.querySelectorAll<HTMLElement>('.board .card[data-key]').forEach((el) => m.set(el.dataset.key!, el.getBoundingClientRect()));
  return m;
}
function flip(prev: Map<string, DOMRect>): void {
  let stagger = 0;
  document.querySelectorAll<HTMLElement>('.board .card[data-key]').forEach((el) => {
    const key = el.dataset.key!;
    const now = el.getBoundingClientRect();
    const old = prev.get(key);
    if (old) {
      const dx = old.left - now.left; const dy = old.top - now.top;
      if (Math.abs(dx) > 2 || Math.abs(dy) > 2) {
        el.style.transition = 'none';
        el.style.transform = `translate(${dx}px, ${dy}px)`;
        el.style.zIndex = '5';
        requestAnimationFrame(() => {
          el.style.transition = 'transform 0.34s cubic-bezier(0.35,0,0.2,1)';
          el.style.transform = '';
          el.addEventListener('transitionend', () => { el.style.transition = ''; el.style.transform = ''; el.style.zIndex = ''; }, { once: true });
        });
      }
    } else {
      el.classList.add('enter');
      if (dealing) { el.style.animationDelay = `${stagger * 22}ms`; stagger++; }
    }
  });
}

// ---- 획득패 정렬(원본 CapturedSequence) ----
// asPi=true면 (전환권 남은) 국진을 피 무리로 본다 — 정산에서 쌍피로 해석됐을 때의 이동 연출용.
function capturedGroup(c: HwatuCard, asPi = false): number {
  if (asPi && c.isGukjin && !c.gukjinLocked) return 3;
  switch (c.kind) { case HwatuKind.Bright: return 0; case HwatuKind.Animal: return 1; case HwatuKind.Ribbon: return 2; default: return 3; }
}
function cardSortKey(c: HwatuCard): number {
  const month = c.month <= 0 ? 13 : c.month;
  const kr = { [HwatuKind.Bright]: 0, [HwatuKind.Animal]: 1, [HwatuKind.Ribbon]: 2, [HwatuKind.Junk]: 3, [HwatuKind.Bonus]: 4 }[c.kind];
  return month * 100 + kr * 10 + c.ordinal;
}
function renderCaptured(container: HTMLElement, cards: readonly HwatuCard[], asPi = false): void {
  const groups = [0, 1, 2, 3].map((g) => cards.filter((c) => capturedGroup(c, asPi) === g).sort((a, b) => cardSortKey(a) - cardSortKey(b)));
  const nodes: HTMLElement[] = [];
  groups.forEach((gcards, g) => {
    if (!gcards.length) return;
    const grp = document.createElement('div');
    grp.className = `cap-group g${g}`;
    gcards.forEach((c) => grp.appendChild(cardEl(c, { cls: 'cap' })));
    const badge = document.createElement('span');
    badge.className = 'cap-badge';
    // 피 무리 배지는 피값 합(국진을 쌍피로 볼 땐 2로 계산).
    badge.textContent = String(g === 3
      ? gcards.reduce((s, c) => s + (asPi && c.isGukjin && !c.gukjinLocked ? 2 : (c.junkValue || 0)), 0)
      : gcards.length);
    grp.appendChild(badge);
    nodes.push(grp);
  });
  container.replaceChildren(...nodes);
}

function scoreText(captured: HwatuCard[]): string {
  const b = Scorer.evaluate(captured, OPT);
  const parts: string[] = [];
  if (b.brightPoints) parts.push(`광${b.brightPoints}`);
  if (b.animalPoints) parts.push(`열끗${b.animalPoints}`);
  if (b.godoriPoints) parts.push('고도리');
  if (b.ribbonPoints) parts.push(`띠${b.ribbonPoints}`);
  if (b.hongdanPoints) parts.push('홍단');
  if (b.cheongdanPoints) parts.push('청단');
  if (b.chodanPoints) parts.push('초단');
  if (b.junkPoints) parts.push(`피${b.junkPoints}`);
  return `${b.total}점` + (parts.length ? ` · ${parts.join(' ')}` : '');
}

// ---- 감정 · 말풍선 ----
const charOfOrig = (orig: number): Character => charByOrig[orig]!;
function applyAvatar(orig: number): void {
  avatarOf(orig).src = avatarUrl(charOfOrig(orig), emotionByOrig[orig] ?? 'normal');
}
function setEmotion(orig: number, e: Emotion, holdMs = 1800): void {
  emotionByOrig[orig] = e;
  applyAvatar(orig);
  if (emotionTimers[orig]) clearTimeout(emotionTimers[orig]);
  if (e !== 'normal') emotionTimers[orig] = window.setTimeout(() => { emotionByOrig[orig] = 'normal'; applyAvatar(orig); }, holdMs);
}
function showBubble(orig: number, text: string): void {
  if (!text || !settings.bubbles) return;
  const b = bubbleOf(orig);
  b.textContent = text; b.classList.remove('hidden');
  window.setTimeout(() => b.classList.add('hidden'), 1900);
}

const CHEER = new Set([PlayEventKind.Sseul, PlayEventKind.Ttadak, PlayEventKind.Jjok, PlayEventKind.Bomb, PlayEventKind.Chongtong, PlayEventKind.Go, PlayEventKind.ReverseGo, PlayEventKind.Stop]);
// 원본 EventEffectLabel: 중앙 배너를 띄우는 이벤트(하나씩 큐잉).
const BANNER_OF: Partial<Record<PlayEventKind, string>> = {
  [PlayEventKind.Bbeok]: '뻑!', [PlayEventKind.Jabbeok]: '자뻑!', [PlayEventKind.Yeonbbeok]: '연뻑!',
  [PlayEventKind.Cheotbbeok]: '첫뻑!', [PlayEventKind.Sambbeok]: '쓰리뻑!', [PlayEventKind.Jjok]: '쪽!',
  [PlayEventKind.Ttadak]: '따닥!', [PlayEventKind.Sseul]: '싹쓸이!', [PlayEventKind.Bomb]: '폭탄!',
  [PlayEventKind.Shake]: '흔들기!', [PlayEventKind.Chongtong]: '총통!', [PlayEventKind.Go]: '고!',
  [PlayEventKind.ReverseGo]: '역고!',
};
const QUOTE_EVENTS = new Set([PlayEventKind.Go, PlayEventKind.ReverseGo, PlayEventKind.Stop, PlayEventKind.Bbeok, PlayEventKind.Sseul, PlayEventKind.Chongtong]);

function onGameEvent(e: PlayEvent): void {
  audio.playForEvent(e);
  const label = BANNER_OF[e.kind];
  if (label) queueBanner(label);

  // 흔들기·폭탄: 판 흔들림 + 전용 대사(사람·AI 공통).
  if (e.kind === PlayEventKind.Shake) shakeBoard(false);
  else if (e.kind === PlayEventKind.Bomb) shakeBoard(true);

  if (e.playerIndex >= 0 && e.playerIndex < gameToOrig.length) {
    const orig = gameToOrig[e.playerIndex]!;
    if (CHEER.has(e.kind)) setEmotion(orig, 'cheer');
    else if (e.kind === PlayEventKind.Bbeok || e.kind === PlayEventKind.Jabbeok) setEmotion(orig, 'angry');
    if (e.kind === PlayEventKind.Shake) showBubble(orig, '흔들어써~~!');
    else if (e.kind === PlayEventKind.Bomb) showBubble(orig, '폭탄이야!!');
    else if (orig !== HUMAN_ORIG && QUOTE_EVENTS.has(e.kind)) showBubble(orig, randomQuote(charOfOrig(orig)));
  }
  if (e.kind === PlayEventKind.PiSteal && e.victimIndex >= 0 && e.victimIndex < gameToOrig.length) {
    setEmotion(gameToOrig[e.victimIndex]!, 'sad');
  }
}

// ---- 이벤트 배너(하나씩 큐잉) + 판 흔들림 ----
const bannerQ: string[] = [];
let bannerBusy = false;
function queueBanner(text: string): void {
  bannerQ.push(text);
  if (!bannerBusy) void runBanner();
}
async function runBanner(): Promise<void> {
  bannerBusy = true;
  const el = $('banner');
  while (bannerQ.length) {
    el.textContent = bannerQ.shift()!;
    el.classList.remove('hidden', 'show');
    void el.offsetWidth; // 리플로우로 애니메이션 재시작
    el.classList.add('show');
    await gameDelay(1050);
  }
  el.classList.add('hidden');
  el.classList.remove('show');
  bannerBusy = false;
}
function shakeBoard(strong: boolean): void {
  const c = document.querySelector<HTMLElement>('.center');
  if (!c) return;
  const cls = strong ? 'shake-2' : 'shake-1';
  c.classList.remove('shake-1', 'shake-2');
  void c.offsetWidth;
  c.classList.add(cls);
  setTimeout(() => c.classList.remove(cls), 560);
}
function showToast(text: string): void {
  const t = document.createElement('div');
  t.className = 'toast'; t.textContent = text;
  $('toasts').appendChild(t);
  setTimeout(() => t.remove(), 1400);
}

// ---- 특수수 버튼(인간) ----
function distinctHandMonths(): number[] {
  const seen = new Set<number>();
  for (const c of engine.state.player(humanGi()).hand) if (c.month >= 1 && c.month <= 12) seen.add(c.month);
  return [...seen];
}
function renderSpecials(): void {
  const box = $('specials');
  box.replaceChildren();
  const st = engine.state;
  if (spectate || !(st.current === humanGi() && st.phase === GamePhase.Playing && !busy)) return;
  const pending = st.player(humanGi()).pendingShakeMonth;
  for (const m of distinctHandMonths()) {
    if (engine.canBomb(m)) {
      const b = document.createElement('button');
      b.textContent = `💣 폭탄 ${m}월`;
      b.addEventListener('click', () => void doBomb(m));
      box.appendChild(b);
    }
    if (pending === 0 && engine.canShake(m)) {
      const s = document.createElement('button');
      s.className = 'secondary'; s.textContent = `🤝 흔들기 ${m}월`;
      s.addEventListener('click', () => { engine.declareShake(m); render(); });
      box.appendChild(s);
    }
  }
  // 3인 쇼당: 두 상대의 미완성 족보를 내가 완성시킬 수 있으면 쇼당을 걸 수 있다.
  if (mode === 3 && !shodangDone && Shodang.detect(st, 0).callable) {
    const s = document.createElement('button');
    s.textContent = '🎴 쇼당!';
    s.addEventListener('click', callShodang);
    box.appendChild(s);
  }
}

// 상대(AI)의 쇼당 수락 판정 — 원본(Board.pas): Random(100) < 60, 60% 확률 수락.
function aiAcceptsShodang(): boolean {
  return Math.random() < 0.6;
}

// 쇼당 결정 공통 처리(사람이 걸든 AI가 걸든). Nagari면 게임을 끝내는 declareNagari까지 수행한다.
function applyShodangDecision(dec: ShodangDecision, react: string): void {
  const nameOf = (gi: number) => (gameToOrig[gi] === HUMAN_ORIG ? humanName() : charOfOrig(gameToOrig[gi]!).name);
  if (dec.outcome === ShodangOutcome.Nagari) {
    queueBanner('쇼당 — 나가리!');
    $('status').textContent = `쇼당! ${react} → 나가리`;
    engine.declareNagari();
  } else if (dec.outcome === ShodangOutcome.Continue) {
    showToast('쇼당 거절 — 계속');
    $('status').textContent = `쇼당! ${react} → 계속 진행`;
  } else {
    shodangPushed = { caller: dec.caller, accepter: dec.accepter, decliner: dec.decliner };
    showToast('쇼당 — 밀어주기!');
    $('status').textContent = `쇼당! ${react} → ${nameOf(dec.accepter)} 밀어주기(${nameOf(dec.decliner)} 독박 대기)`;
  }
}

function callShodang(): void {
  if (busy || shodangDone || shodangPushed) return;
  shodangDone = true;
  const hg = humanGi();
  const opps = gameToOrig.map((_, gi) => gi).filter((gi) => gi !== hg);
  const accA = aiAcceptsShodang();
  const accB = aiAcceptsShodang();
  const dec = Shodang.resolve(hg, opps[0]!, opps[1]!, accA, accB);
  const nameOf = (gi: number) => charOfOrig(gameToOrig[gi]!).name;
  const react = `${nameOf(opps[0]!)}: ${accA ? '수락' : '거절'} · ${nameOf(opps[1]!)}: ${accB ? '수락' : '거절'}`;
  applyShodangDecision(dec, react);
  render();
  if (engine.state.phase === GamePhase.Finished) void drive(); // 나가리 → 정산 흐름
}

// AI가 건 쇼당에 사람이 응답하는 다이얼로그(원본 FShodangPending):
// 위협 패(상대 족보를 완성시킬 AI 손패)를 공개하고 받기/거절을 묻는다.
function showAiShodangPrompt(callerGi: number, threats: ShodangThreat[]): Promise<boolean> {
  return new Promise((resolve) => {
    audio.play('sfx_negotiate');
    const name = charOfOrig(gameToOrig[callerGi]!).name;
    const wrap = document.createElement('div');
    wrap.className = 'pick-cards';
    for (const t of threats) {
      const el = document.createElement('div');
      el.className = 'card';
      el.style.backgroundImage = `url(${cardUrl(t.cardId)})`;
      el.title = `${t.group} 완성패`;
      wrap.appendChild(el);
    }
    const head = Object.assign(document.createElement('h2'), { textContent: `${name}의 쇼당!` });
    const desc = Object.assign(document.createElement('p'), {
      textContent: '상대가 족보 완성패를 들고 있습니다. 나가리를 받겠습니까?',
    });
    const btns = document.createElement('div');
    btns.className = 'buttons';
    const yes = Object.assign(document.createElement('button'), { textContent: '받기(나가리 수락)' });
    const no = Object.assign(document.createElement('button'), { textContent: '거절(계속 진행)', className: 'secondary' });
    yes.addEventListener('click', () => { hideOverlay(); resolve(true); });
    no.addEventListener('click', () => { hideOverlay(); resolve(false); });
    btns.append(yes, no);
    $('dialog').replaceChildren(head, desc, wrap, btns);
    $('overlay').classList.remove('hidden');
    if (AUTO) setTimeout(() => { hideOverlay(); resolve(Math.random() < 0.5); }, 150);
  });
}

// ---- 렌더 ----
const gameIndexOfOrig = (orig: number): number => gameToOrig.indexOf(orig);
// 인간의 게임 좌석 인덱스. 선 로테이션으로 0이 아닐 수 있고,
// 4인에서 포기/광팔기로 빠졌으면 -1(이번 판 불참 — 어떤 차례와도 일치하지 않음).
const humanGi = (): number => gameToOrig.indexOf(HUMAN_ORIG);

function render(): void {
  const prevRects = captureRects();
  const st = engine.state;
  const curOrig = st.phase !== GamePhase.Finished ? gameToOrig[st.current] : -1;

  // 상대 좌석
  for (const [orig, els] of oppEls) {
    const gi = gameIndexOfOrig(orig);
    els.root.classList.toggle('sitout', gi < 0);
    els.panel.classList.toggle('active', orig === curOrig);
    els.panel.classList.toggle('seon', orig === seonOrig);
    els.money.textContent = seatInfoText(orig);
    if (gi >= 0) {
      const p = st.player(gi);
      renderZone(els.hand, p.hand, true);
      renderCaptured(els.captured, p.captured, gukjinAsPiSeats.has(gi));
      els.score.textContent = scoreText(p.captured) + (p.goCount ? ` · ${p.goCount}고` : '');
    } else {
      els.hand.replaceChildren();
      els.captured.replaceChildren();
      els.score.textContent = round?.gwang.sold && logicalToOrig(round.gwang.sellerSeat) === orig ? '광 팔고 빠짐' : '포기';
    }
  }

  // 인간(게임 좌석 0)
  const hg = humanGi();
  const pending = hg >= 0 ? st.player(hg).pendingShakeMonth : 0;
  if (hg >= 0) {
    const me = st.player(hg);
    const myTurn = st.current === hg && st.phase === GamePhase.Playing && !busy && !spectate;
    $('myHand').classList.toggle('playable', myTurn);
    renderZone($('myHand'), me.hand, false, (c) => {
      const locked = myTurn && pending !== 0 && c.kind !== HwatuKind.Bonus && c.month !== pending;
      return { cls: locked ? 'dimmed' : undefined, onClick: () => { if (myTurn) void onHumanCard(c); } };
    });
    renderCaptured($('myCaptured'), me.captured, gukjinAsPiSeats.has(hg));
    $('myScore').textContent = scoreText(me.captured) + (me.goCount ? ` · ${me.goCount}고` : '');
  } else {
    // 4인에서 포기/광팔기로 이번 판 불참
    $('myHand').classList.remove('playable');
    $('myHand').replaceChildren();
    $('myCaptured').replaceChildren();
    $('myScore').textContent = round?.gwang.sold && logicalToOrig(round.gwang.sellerSeat) === HUMAN_ORIG
      ? '광 팔고 쉬는 중' : '이번 판 쉬는 중';
  }
  $('myMoney').textContent = seatInfoText(HUMAN_ORIG);
  $('myPanel').classList.toggle('active', curOrig === HUMAN_ORIG);
  $('myPanel').classList.toggle('seon', seonOrig === HUMAN_ORIG);

  renderZone($('floor'), st.floor, false);
  $('deckCount').textContent = `${st.stock.length}장`;
  ($('deckPile') as HTMLElement).style.visibility = st.stock.length ? 'visible' : 'hidden';

  renderSpecials();
  $('myName').textContent = humanName();
  const pauseTag = paused ? '⏸ 일시정지   ' : '';
  const stakeTag = (stakes > 1 ? `🔥판돈 ×${stakes}   ` : '') + pauseTag;
  const turnMsg = st.phase === GamePhase.Playing
    ? (curOrig === HUMAN_ORIG ? (pending ? `${pending}월 흔들기 — ${pending}월 카드를 내세요` : (spectate ? '관전 중…' : '내 차례')) : `${charOfOrig(curOrig).name} 차례…`)
    : '';
  $('status').textContent = stakeTag + turnMsg;

  flip(prevRects);
}

// ---- 좌석 구성 ----
// 캐릭터 선택(charByOrig 채우기) — 인간(0)은 상대와 겹치지 않게.
function pickChars(): void {
  const sel = $('charSel') as HTMLSelectElement;
  const n = allCharacters().length;
  const baseIdx = sel.value === '' ? Math.floor(Math.random() * n) : Number(sel.value);
  charByOrig = [];
  charByOrig[HUMAN_ORIG] = characterAt((baseIdx + 7) % n);
  const oppOffsets = [0, 3, 5];
  for (let orig = 1; orig < mode; orig++) charByOrig[orig] = characterAt((baseIdx + oppOffsets[orig - 1]!) % n);
}

// charByOrig를 바탕으로 상대 좌석 DOM·AI를 만든다(복원 시에도 재사용).
function buildSeatDom(): void {
  oppEls.clear();
  $('opponents').replaceChildren();
  agentByOrig.clear();
  emotionByOrig.length = 0;
  for (let orig = 1; orig < mode; orig++) {
    const ch = charByOrig[orig]!;
    const els = makeOppSeat(orig);
    els.avatar.src = avatarUrl(ch, 'normal');
    els.name.textContent = ch.name;
    els.job.textContent = `${ch.ageJob} · ${'★'.repeat(ch.goStars)}`;
    oppEls.set(orig, els);
    const agent = new AiPlayer(derivedSkill(ch), BigInt(Math.floor(Math.random() * 2 ** 52)) + BigInt(orig + 1));
    agent.goBias = nerveBias(ch); agent.greed = greedBias(ch);
    agentByOrig.set(orig, agent);
  }
  // 관전 모드: 좌석 0(나)도 AI가 대신 둔다.
  if (spectate) {
    const ch = charByOrig[HUMAN_ORIG]!;
    const a = new AiPlayer(derivedSkill(ch), BigInt(Math.floor(Math.random() * 2 ** 52)) + 1n);
    a.goBias = nerveBias(ch); a.greed = greedBias(ch);
    agentByOrig.set(HUMAN_ORIG, a);
  }
  for (let orig = 0; orig < mode; orig++) emotionByOrig[orig] = 'normal';
  applyAvatar(HUMAN_ORIG);
  $('board').classList.toggle('four', mode === 4);
}

// 새 세션: 상대·모드를 새로 정하고 누적 손익을 0으로 초기화한 뒤 첫 판 시작.
function startSession(): void {
  mode = Number(($('modeSel') as HTMLSelectElement).value) as 2 | 3 | 4;
  pickChars();
  moneyPerPoint = Number(($('rateSel') as HTMLSelectElement).value) || 100;
  seatMoney = new Array(mode).fill(SEED_MONEY);
  wins = new Array(mode).fill(0);
  losses = new Array(mode).fill(0);
  pendingReplace = [];
  stakes = 1;
  gaveUpLast = new Array(mode).fill(false);
  void startSessionAsync();
}
async function startSessionAsync(): Promise<void> {
  epoch++; // 선 뽑기 동안 이전 루프 무효화
  const myEpoch = epoch;
  clearTransientOverlays();
  hideOverlay();
  // 새 매치: 밤일낮장으로 선 결정(관전/AUTO는 자동 진행).
  const picked = await seonPick();
  if (myEpoch !== epoch) return; // 선 뽑기 중 다른 시작이 끼어듦 → 이 시퀀스 폐기
  seonOrig = picked;
  beginGame();
}
// 다음 판: 같은 상대·누적 손익을 유지한 채 새 판만 시작(선은 직전 승자).
function nextRound(): void {
  beginGame();
}

// ---- 밤일낮장 선 뽑기(원본 BeginSeonPick/SeonEvaluate) ----
// 각자 카드 1장을 뽑아 낮(06~17시)은 높은 월, 밤은 낮은 월이 선. 동월이면 그들끼리 재추첨.
async function seonPick(): Promise<number> {
  const myEpoch = epoch;
  const isDay = new Date().getHours() >= 6 && new Date().getHours() < 18;
  let contenders = Array.from({ length: mode }, (_, o) => o);

  for (let roundN = 0; roundN < 8 && contenders.length > 1; roundN++) {
    const deck = new Deck(DeckOptions.standard());
    deck.shuffleSecure();
    const draws = new Map<number, HwatuCard>();
    for (const o of contenders) draws.set(o, deck.draw());

    if (!AUTO && !spectate) {
      const ok = await showSeonPickDialog(contenders, draws, isDay, roundN);
      if (!ok || myEpoch !== epoch) return 0;
    }

    // 낮=최고 월 / 밤=최저 월. 동률이면 그들끼리 재추첨.
    let best = isDay ? -1 : 99;
    for (const o of contenders) {
      const m = draws.get(o)!.month;
      if (isDay ? m > best : m < best) best = m;
    }
    contenders = contenders.filter((o) => draws.get(o)!.month === best);
  }
  return contenders[0] ?? 0;
}

// 밤일낮장 다이얼로그: 인간 카드는 클릭해 공개(5초 방치 시 자동), AI는 차례로 자동 공개.
function showSeonPickDialog(
  contenders: number[], draws: Map<number, HwatuCard>, isDay: boolean, roundN: number,
): Promise<boolean> {
  return new Promise((resolve) => {
    const myEpoch = epoch;
    const wrap = document.createElement('div');
    wrap.className = 'seon-row';
    const flips: (() => void)[] = [];
    let humanFlip: (() => void) | null = null;
    let revealed = 0;
    const finish = () => setTimeout(() => { hideOverlay(); resolve(myEpoch === epoch); }, 1100);

    for (const o of contenders) {
      const cell = document.createElement('div');
      cell.className = 'seon-cell';
      const card = document.createElement('div');
      card.className = 'card';
      card.style.backgroundImage = `url(${cardUrl('back_red')})`;
      const label = document.createElement('div');
      label.className = 'seon-name';
      label.textContent = o === HUMAN_ORIG ? humanName() : charByOrig[o]!.name;
      const flip = () => {
        if (card.dataset.done) return;
        card.dataset.done = '1';
        card.style.backgroundImage = `url(${cardUrl(draws.get(o)!.assetId)})`;
        audio.play('card_flip');
        if (++revealed === contenders.length) finish();
      };
      flips.push(flip);
      if (o === HUMAN_ORIG) { humanFlip = flip; card.classList.add('clickable'); card.addEventListener('click', flip); }
      cell.append(card, label);
      wrap.appendChild(cell);
    }

    const head = Object.assign(document.createElement('h2'), {
      textContent: roundN === 0 ? `밤일낮장 — ${isDay ? '낮장(높은 월이 선)' : '밤일(낮은 월이 선)'}` : '동월! 재추첨',
    });
    const tip = Object.assign(document.createElement('p'), {
      textContent: humanFlip ? '내 카드를 눌러 공개하세요' : '',
    });
    $('dialog').replaceChildren(head, tip, wrap);
    $('overlay').classList.remove('hidden');

    // AI 카드는 차례로 자동 공개, 인간은 5초 방치 시 자동(원본 idle auto-reveal)
    let delay = 500;
    for (const [i, f] of flips.entries()) {
      const isHumanCard = f === humanFlip;
      if (!isHumanCard) { setTimeout(f, delay); delay += 600; }
      else setTimeout(f, 5000);
      void i;
    }
  });
}

// 이전 게임이 남긴 전이 오버레이(셔플·기리)를 정리하고, 대기 중인 기리 선택을 취소한다.
function clearTransientOverlays(): void {
  if (giriCancelFn) { giriCancelFn(); giriCancelFn = null; }
  document.querySelectorAll('.giri-overlay, .shuffle-overlay').forEach((el) => el.remove());
}

function beginGame(): void {
  epoch++; // 이전 세대 루프 전부 무효화
  clearTransientOverlays();
  audio.unlock();
  busy = false;
  // 오링 AI 교체 적용(원본 좌석 교체): 캐릭터·잔액·전적 리셋 후 입장.
  for (const r of pendingReplace) {
    charByOrig[r.orig] = r.ch;
    seatMoney[r.orig] = SEED_MONEY;
    wins[r.orig] = 0; losses[r.orig] = 0;
    gaveUpLast[r.orig] = false;
    showToast(`🙋 ${r.ch.name} 등장!`);
  }
  pendingReplace = [];
  OPT = buildScoreOptions(); // 설정의 룰 토글을 이번 판부터 반영
  autoPlay = false;          // 자동 진행은 원본처럼 '이번 판' 한정
  updateHeaderButtons();
  buildSeatDom();
  gwangNet = new Array(mode).fill(0);
  round = null;
  shodangPushed = null;
  shodangDone = false;
  gukjinAsPiSeats = new Set();
  hideOverlay();
  void startSequence(epoch);
}

// 셔플 연출 → 기리(떼기/컷) → 딜 → 공개 → 진행.
async function startSequence(myEpoch: number): Promise<void> {
  const deck = new Deck(settings.bonusCards ? DeckOptions.withBonus(3) : DeckOptions.standard());
  deck.shuffleSecure();
  if (!AUTO) {
    await playShuffle();
    if (myEpoch !== epoch) return;
    await giriStep(deck);   // 셔플한 덱을 떼기(컷)
    if (myEpoch !== epoch) return;
  }
  await dealAndStart(deck, myEpoch);
}

// 논리 좌석(0=선/P1 .. n-1) → 원좌석. 선 기준 시계 순환(원본 PhysicalPos 대응).
const logicalToOrig = (l: number): number => (seonOrig + l) % mode;

// (기리로 컷된) 덱으로 딜하고 엔진을 세팅한 뒤 공개·진행. 4인은 협상(인간 P2/P3 선택 포함)까지.
async function dealAndStart(deck: Deck, myEpoch: number): Promise<void> {
  let game: GameState;
  if (mode === 2 || mode === 3) {
    const table = Dealer.deal(deck, DealConfig.forPlayers(mode));
    // 선 로테이션: 게임 좌석 순서 = 선부터 시계 방향(원좌석 회전).
    const order = Array.from({ length: mode }, (_, l) => logicalToOrig(l));
    game = new GameState(order.map((o) => charByOrig[o]!.name));
    order.forEach((_, gi) => { game.players[gi]!.hand = table.hand(gi).slice(); });
    game.floor = table.floor.slice();
    game.stock = table.stock.slice();
    gameToOrig = order;
  } else {
    const table = Dealer.deal(deck, DealConfig.custom(4, 7, 6));
    // 논리 좌석: P1(선)=logicalToOrig(0) … P4=logicalToOrig(3). 원본은 선 기준으로 역할이 돈다.
    // P2·P3 결정: 인간이면 다이얼로그(연사 규칙: 직전 판 포기했으면 포기 불가), AI면 손패 품질.
    const decideGiveUp = async (l: number, other2give: boolean): Promise<boolean> => {
      if (other2give) return false; // 앞 순번이 포기하면 자동 참가(원본 Resolve 체인)
      const o = logicalToOrig(l);
      if (gaveUpLast[o]) return false; // 연사: 연속 포기 금지
      if (o === HUMAN_ORIG && !spectate && !AUTO) {
        return showJoinPrompt(l, table.hand(l));
      }
      return Dealer.handQuality(table.hand(l), table.floor) < LOW_QUALITY;
    };
    const p2give = await decideGiveUp(1, false);
    if (myEpoch !== epoch) return;
    const p3give = await decideGiveUp(2, p2give);
    if (myEpoch !== epoch) return;
    // P4는 광값이 있으면 판다(원본: 인간 P4도 자동 광팔기).
    const p4sell = FourPlayer.gwangCount(table.hand(3), OPT) > 0;
    round = FourPlayer.resolve(table, p2give, p3give, p4sell, GWANG_UNIT, OPT);
    // 연사 기록 갱신: 이번에 포기한 좌석 true, 참가한 좌석 false.
    for (let l = 1; l <= 2; l++) {
      const o = logicalToOrig(l);
      gaveUpLast[o] = (l === 1 && p2give) || (l === 2 && p3give);
    }
    // 광값 선불(원좌석 기준으로 합산).
    if (round.gwang.sold) {
      for (const payerL of round.gwang.payerSeats) {
        gwangNet[logicalToOrig(payerL)]! -= round.gwang.valuePerPayer;
        gwangNet[logicalToOrig(round.gwang.sellerSeat)]! += round.gwang.valuePerPayer;
      }
    }
    game = FourPlayer.buildGame(table, round, round.playSeats.map((l) => charByOrig[logicalToOrig(l)]!.name));
    gameToOrig = round.playSeats.map((l) => logicalToOrig(l));
  }

  engine = new TurnEngine(game, OPT);
  engine.bonusDrawEnabled = false;
  engine.flipChoiceEnabled = false;
  engine.onEvent = onGameEvent;
  // 운 배선(원본 RollSeatLuck): 매판 캐릭터 운×2 + Random(31)-15를 5..99로 클램프해
  // 게임 좌석 순서로 주입 → 뒷패 뒤집기 바이어스(운 좋으면 유리한 카드가 올라올 확률↑).
  engine.playerLuck = gameToOrig.map((orig) => {
    const roll = charByOrig[orig]!.stats.luck * 2 + Math.floor(Math.random() * 31) - 15;
    return Math.max(5, Math.min(99, roll));
  });
  if (!engine.applyHandChongtong() && !engine.applyFloorChongtong()) {
    engine.applyFloorBbeok();
    engine.applyFloorBonus();
  }

  dealing = true;
  render();
  setTimeout(() => { dealing = false; }, 900);
  if (mode === 4 && round) showNegotiation(round);
  else void drive();
}

// 4인 협상: 인간이 P2/P3일 때 참가/포기를 묻는다(원본 BeginNegotiationPrompt). 손패를 보고 결정.
function showJoinPrompt(logicalSeat: number, hand: readonly HwatuCard[]): Promise<boolean> {
  return new Promise((resolve) => {
    audio.play('sfx_negotiate');
    const wrap = document.createElement('div');
    wrap.className = 'pick-cards';
    for (const c of hand) {
      const el = document.createElement('div');
      el.className = 'card';
      el.style.backgroundImage = `url(${cardUrl(c.assetId)})`;
      el.title = displayName(c);
      wrap.appendChild(el);
    }
    const head = Object.assign(document.createElement('h2'), { textContent: `P${logicalSeat + 1} — 참가하시겠습니까?` });
    const desc = Object.assign(document.createElement('p'), { textContent: '포기하면 이번 판을 쉽니다(다음 판은 연속 포기 불가).' });
    const btns = document.createElement('div');
    btns.className = 'buttons';
    const join = Object.assign(document.createElement('button'), { textContent: '참가' });
    const fold = Object.assign(document.createElement('button'), { textContent: '포기', className: 'secondary' });
    join.addEventListener('click', () => { hideOverlay(); resolve(false); });
    fold.addEventListener('click', () => { hideOverlay(); resolve(true); });
    btns.append(join, fold);
    $('dialog').replaceChildren(head, desc, wrap, btns);
    $('overlay').classList.remove('hidden');
  });
}

// ---- 기리(떼기/컷): 셔플 후 덱을 잘라 위아래를 바꾼다(원본 RequestGiri/ResolveGiri) ----
// 원본 규칙: 컷은 말번(선 바로 앞 차례) 몫 — 선 로테이션에 따라 인간이 말번이면 직접 클릭한다.
async function giriStep(deck: Deck): Promise<void> {
  const count = deck.count();
  if (count <= 10) return; // 자를 여지가 적으면 그대로
  const malbeonOrig = logicalToOrig(mode - 1); // 선 바로 앞 = 마지막 논리 좌석
  const humanCuts = malbeonOrig === HUMAN_ORIG && !spectate;
  const cut = humanCuts ? await humanGiriChoice(count) : await aiGiriChoice(count);
  if (cut >= 0) deck.cut(cut);
}

// 덱을 뒷면 카드 부채로 그리는 오버레이 생성.
function makeGiriFan(count: number): { ov: HTMLElement; cards: HTMLElement[]; tung: HTMLElement } {
  const ov = document.createElement('div');
  ov.className = 'giri-overlay';
  const fan = document.createElement('div');
  fan.className = 'giri-fan';
  const cards: HTMLElement[] = [];
  for (let i = 0; i < count; i++) {
    const c = document.createElement('div');
    c.className = 'giri-card';
    fan.appendChild(c);
    cards.push(c);
  }
  const tip = document.createElement('div');
  tip.className = 'giri-tip';
  tip.textContent = '떼기 — 어디서 자를까요?';
  const tung = document.createElement('button');
  tung.className = 'giri-tung'; tung.textContent = '그대로(퉁)';
  ov.append(tip, fan, tung);
  $('board').appendChild(ov);
  return { ov, cards, tung };
}

function humanGiriChoice(count: number): Promise<number> {
  return new Promise((resolve) => {
    const { ov, cards, tung } = makeGiriFan(count);
    const done = (cut: number) => { giriCancelFn = null; audio.play('ui_click'); ov.remove(); resolve(cut); };
    giriCancelFn = () => { ov.remove(); resolve(-1); }; // 새 게임 등으로 취소(시퀀스는 epoch로 중단됨)
    cards.forEach((c, i) => {
      c.addEventListener('mouseenter', () => audio.play('ui_hover'));
      c.addEventListener('click', () => done(i));
    });
    tung.addEventListener('click', () => done(-1));
  });
}

async function aiGiriChoice(count: number): Promise<number> {
  const myEpoch = epoch;
  const { ov, cards } = makeGiriFan(count);
  // 훑어보기 3회
  let last = -1;
  for (let k = 0; k < 3; k++) {
    let n = Math.floor(Math.random() * cards.length);
    if (n === last && cards.length > 1) n = (n + 1) % cards.length;
    last = n;
    cards.forEach((c, i) => c.classList.toggle('hover', i === n));
    audio.play('ui_hover');
    await gameDelay(360);
    if (myEpoch !== epoch) { ov.remove(); return -1; }
  }
  // 컷 60% / 퉁 40%
  const cut = Math.random() < 0.6 ? 4 + Math.floor(Math.random() * (count - 8)) : -1;
  cards.forEach((c, i) => c.classList.toggle('hover', i === cut));
  audio.play('ui_click');
  await gameDelay(400);
  ov.remove();
  return myEpoch === epoch ? cut : -1;
}

// 원본 BeginShuffleEffect: 뒷면 카드가 무작위 배치로 깜빡이며 "섞는" 느낌을 준 뒤 딜.
async function playShuffle(): Promise<void> {
  const board = $('board');
  const ov = document.createElement('div');
  ov.className = 'shuffle-overlay';
  const cards: HTMLElement[] = [];
  for (let i = 0; i < 16; i++) {
    const c = document.createElement('div');
    c.className = 'shuffle-card';
    ov.appendChild(c);
    cards.push(c);
  }
  board.appendChild(ov);
  $('status').textContent = '패를 섞는 중...';
  const scatter = () => cards.forEach((c) => {
    c.style.left = `${14 + Math.random() * 68}%`;
    c.style.top = `${18 + Math.random() * 56}%`;
    c.style.transform = `rotate(${(Math.random() - 0.5) * 55}deg)`;
  });
  scatter();
  audio.play('card_deal');
  for (let k = 0; k < 3; k++) { await sleep(190); scatter(); audio.play('card_flip'); }
  await sleep(200);
  ov.remove();
}

function showNegotiation(r: FourPlayerRound): void {
  const lines: string[] = [];
  const nameOfOrig = (o: number) => (o === HUMAN_ORIG ? humanName() : charOfOrig(o).name);
  const sitO = logicalToOrig(r.sitOutSeat); // 좌석 표기는 논리(P1~P4), 인물은 원좌석
  if (r.gwang.sold) {
    lines.push(`${nameOfOrig(sitO)}(P${r.sitOutSeat + 1})가 광 ${r.gwang.gwangCount}개를 팔았습니다.`);
    lines.push(`→ P2·P3가 각 ${r.gwang.valuePerPayer}점씩 선불`);
  } else {
    lines.push(`${nameOfOrig(sitO)}(P${r.sitOutSeat + 1})가 빠집니다.`);
  }
  lines.push(`치는 사람: ${r.playSeats.map((l) => nameOfOrig(logicalToOrig(l))).join(', ')}`);

  // 빠지는 자리의 손패(뒷면)를 잠깐 보여줬다가, 시작 시 뒷패로 합쳐지는 연출.
  const sitEls = oppEls.get(sitO);
  if (sitEls) {
    sitEls.root.classList.remove('sitout');
    sitEls.hand.replaceChildren(...Array.from({ length: 7 }, () => cardEl(null)));
  }

  showOverlay(`<h2>🃏 광팔기 협상</h2><p style="line-height:1.7">${lines.join('<br>')}</p>
    <div class="buttons"><button id="startBtn">시작</button></div>`);
  const myEpoch = epoch;
  const start = async (): Promise<void> => {
    if (myEpoch !== epoch) return;
    hideOverlay();
    if (sitEls && !AUTO) { sitEls.hand.classList.add('folding'); await gameDelay(600); sitEls.hand.classList.remove('folding'); }
    if (myEpoch !== epoch) return;
    render();
    void drive();
  };
  $('startBtn').addEventListener('click', () => void start());
  if (AUTO) setTimeout(() => void start(), 200);
}

// ---- 저장 / 이어하기 ----
// 안정 시점(뒤집기·보너스 대기가 아닌 Playing/AwaitingGoStop)에서만 저장한다.
function persist(): void {
  if (spectate) return; // 관전은 저장하지 않음
  const st = engine.state;
  if (st.phase !== GamePhase.Playing && st.phase !== GamePhase.AwaitingGoStop) return;
  const data: SaveData = {
    v: 1, mode, charByOrig: charByOrig.map((c) => c.index), gameToOrig: gameToOrig.slice(), gwangNet: gwangNet.slice(),
    seatMoney: seatMoney.slice(), wins: wins.slice(), losses: losses.slice(), moneyPerPoint, stakes,
    shodangDone, shodangPushed: shodangPushed ? { ...shodangPushed } : null,
    playerLuck: engine.playerLuck.slice(),
    seonOrig, gaveUpLast: gaveUpLast.slice(),
    round: round ? { playSeats: round.playSeats.slice(), sitOutSeat: round.sitOutSeat, gwang: { ...round.gwang, payerSeats: round.gwang.payerSeats.slice() } } : null,
    state: {
      names: st.players.map((p) => p.name),
      current: st.current, phase: st.phase, winner: st.winner,
      playCount: st.playCount, threeBbeok: st.threeBbeok,
      bbeokCreator: [...st.bbeokCreator.entries()],
      players: st.players.map((p) => ({
        name: p.name, hand: cardsToSave(p.hand), captured: cardsToSave(p.captured),
        goCount: p.goCount, lastGoScore: p.lastGoScore, shakeCount: p.shakeCount, cardDebt: p.cardDebt,
        pendingShakeMonth: p.pendingShakeMonth, bbeokCount: p.bbeokCount, reverseGo: p.reverseGo,
      })),
      floor: cardsToSave(st.floor), stock: cardsToSave(st.stock),
    },
  };
  saveGame(data);
}

// 판 사이 매치 스냅샷: 게임 상태 없이 매치 변수만 저장(복원 시 곧바로 다음 판 시작, 원본 MatchOnly).
function saveMatchSnapshot(): void {
  const data: SaveData = {
    v: 1, mode, charByOrig: charByOrig.map((c) => c.index),
    gameToOrig: [], gwangNet: [],
    seatMoney: seatMoney.slice(), wins: wins.slice(), losses: losses.slice(), moneyPerPoint, stakes,
    seonOrig, gaveUpLast: gaveUpLast.slice(),
    matchOnly: true, round: null, state: null,
  };
  saveGame(data);
}

function resumeSaved(): void {
  const s = loadGame();
  if (!s) return;
  epoch++; // 진행 중이던 어떤 루프도 무효화
  clearTransientOverlays();
  spectate = false; // 관전 상태가 남아 복원 게임을 AI가 대신 두는 사고 방지
  busy = false;
  audio.unlock();
  mode = s.mode;
  ($('modeSel') as HTMLSelectElement).value = String(mode);
  charByOrig = s.charByOrig.map((i) => characterAt(i));

  if (s.matchOnly || !s.state) {
    // 판 사이 스냅샷 → 매치 변수만 복원하고 다음 판 시작.
    seatMoney = (s.seatMoney ?? new Array(mode).fill(SEED_MONEY)).slice();
    wins = (s.wins ?? new Array(mode).fill(0)).slice();
    losses = (s.losses ?? new Array(mode).fill(0)).slice();
    moneyPerPoint = s.moneyPerPoint ?? 100;
    stakes = s.stakes ?? 1;
    seonOrig = s.seonOrig ?? 0;
    gaveUpLast = (s.gaveUpLast ?? new Array(mode).fill(false)).slice();
    pendingReplace = [];
    hideTitle();
    beginGame();
    return;
  }

  buildSeatDom();
  gameToOrig = s.gameToOrig.slice();
  gwangNet = s.gwangNet.slice();
  seatMoney = (s.seatMoney ?? new Array(mode).fill(SEED_MONEY)).slice();
  wins = (s.wins ?? new Array(mode).fill(0)).slice();
  losses = (s.losses ?? new Array(mode).fill(0)).slice();
  moneyPerPoint = s.moneyPerPoint ?? 100;
  stakes = s.stakes ?? 1;
  shodangDone = s.shodangDone ?? false;
  shodangPushed = s.shodangPushed ?? null;
  seonOrig = s.seonOrig ?? 0;
  gaveUpLast = (s.gaveUpLast ?? new Array(mode).fill(false)).slice();
  gukjinAsPiSeats = new Set();
  round = s.round;

  const st = new GameState(s.state.names);
  s.state.players.forEach((sp, i) => {
    const p = st.players[i]!;
    p.hand = cardsFromSave(sp.hand); p.captured = cardsFromSave(sp.captured);
    p.goCount = sp.goCount; p.lastGoScore = sp.lastGoScore; p.shakeCount = sp.shakeCount;
    p.cardDebt = sp.cardDebt; p.pendingShakeMonth = sp.pendingShakeMonth; p.bbeokCount = sp.bbeokCount; p.reverseGo = sp.reverseGo;
  });
  st.floor = cardsFromSave(s.state.floor);
  st.stock = cardsFromSave(s.state.stock);
  st.current = s.state.current;
  st.phase = s.state.phase as GamePhase;
  st.winner = s.state.winner;
  st.playCount = s.state.playCount;
  st.threeBbeok = s.state.threeBbeok;
  st.bbeokCreator = new Map(s.state.bbeokCreator);

  OPT = buildScoreOptions();
  engine = new TurnEngine(st, OPT);
  engine.bonusDrawEnabled = false;
  engine.flipChoiceEnabled = false;
  engine.onEvent = onGameEvent;
  engine.playerLuck = (s.playerLuck ?? []).slice(); // 이번 판 운 롤 복원

  hideTitle();
  render();
  void drive();
}

// ---- 입력 ----
// 바닥 같은 월 2장이 서로 다른 종류일 때만 사람에게 묻는다. 그 외(같은 종류·뻑더미)는
// -1(자동 최적: captureRank 높은 쪽)로 넘긴다 — 0을 넘기면 단피/쌍피 중 단피를 집는 손해가 났었다.
function handFloorChoice(card: HwatuCard): Promise<number> {
  const st = engine.state;
  const matches = st.floor.filter((f) => f.month === card.month);
  if (matches.length !== 2 || matches[0]!.kind === matches[1]!.kind || st.bbeokCreator.has(card.month)) return Promise.resolve(-1);
  return pickCard('어느 패를 가져올까요?', [matches[0]!, matches[1]!]);
}
async function onHumanCard(card: HwatuCard): Promise<void> {
  const st = engine.state;
  if (busy || paused || st.phase !== GamePhase.Playing || st.current !== humanGi()) return;
  const idx = st.player(humanGi()).hand.indexOf(card);
  if (idx < 0) return;
  const myEpoch = epoch;
  busy = true; // 처리 중 재진입(빠른 더블클릭·자동틱) 차단 → drive()가 사람 대기 시점에 해제
  render();
  let choice = -1;
  if (card.kind !== HwatuKind.Bonus) choice = await handFloorChoice(card);
  if (myEpoch !== epoch) return; // 다이얼로그 대기 중 새 게임/이어하기
  engine.flipChoiceEnabled = true;
  engine.bonusDrawEnabled = true; // 사람이 보너스패를 내면 뒷패에서 고르게(원본 BonusDrawEnabled)
  try { engine.playHandCard(idx, choice); } catch (e) { $('status').textContent = String(e); busy = false; render(); return; }
  render(); await gameDelay(320);
  if (myEpoch !== epoch) return;
  void drive();
}
async function doBomb(month: number): Promise<void> {
  if (busy) return;
  const myEpoch = epoch;
  busy = true;
  engine.flipChoiceEnabled = true;
  try { engine.playBomb(month); } catch (e) { $('status').textContent = String(e); busy = false; return; }
  render(); await gameDelay(320);
  if (myEpoch !== epoch) return;
  void drive();
}

async function drive(): Promise<void> {
  const myEpoch = epoch;
  busy = true; render();
  try {
    while (engine.state.phase !== GamePhase.Finished) {
      if (myEpoch !== epoch) return; // 새 게임/이어하기로 세대 교체 → 이 루프는 버려진 게임
      const st = engine.state;
      const humanControlled = st.current === humanGi() && !spectate && !autoPlay;
      if (st.phase === GamePhase.AwaitingFlipChoice) {
        if (humanControlled) {
          busy = false;
          const ord = await pickCard(`뒤집은 «${displayName(engine.flipDrawnCard())}» — 가져올 패`, engine.flipChoiceOptions());
          if (myEpoch !== epoch) return;
          engine.resolveFlipChoice(ord); render(); await gameDelay(240);
          if (myEpoch !== epoch) return;
          busy = true; continue;
        }
        engine.resolveFlipChoice(0); render(); await gameDelay(300); continue;
      }
      if (st.phase === GamePhase.AwaitingBonusDraw) {
        // 보너스패를 손에서 낸 뒤 뒷패에서 가져올 패 고르기(원본 StartBonusPick).
        if (humanControlled) {
          busy = false;
          const idx = await pickStockCard();
          if (myEpoch !== epoch) return;
          engine.resolveBonusDraw(idx);
          render(); await gameDelay(200);
          if (myEpoch !== epoch) return;
          busy = true; continue;
        }
        // AI 경로(도달 안 함 — AI 턴은 bonusDrawEnabled=false): 방어적으로 맨 위를 집는다.
        engine.resolveBonusDraw(engine.state.stock.length - 1);
        render(); continue;
      }
      if (humanControlled) { // 인간
        if (st.phase === GamePhase.Playing) {
          if (st.player(humanGi()).hand.length === 0) {
            if (engine.canFlipOnly()) { engine.flipOnly(); render(); await gameDelay(400); continue; }
            break;
          }
          busy = false; render(); persist(); return;
        }
        if (st.phase === GamePhase.AwaitingGoStop) { busy = false; showGoStop(); persist(); return; }
      } else { // AI (관전 모드에선 인간 좌석도 포함)
        // AI 쇼당(원본 AiTimerTick): 3인·진행 단계·미시도·밀어주기 없음이면 쇼당 가능성 검사.
        if (mode === 3 && !shodangDone && !shodangPushed && st.phase === GamePhase.Playing) {
          const det = Shodang.detect(st, st.current);
          if (det.callable) {
            shodangDone = true;
            const caller = st.current;
            const opps = gameToOrig.map((_, gi) => gi).filter((gi) => gi !== caller);
            const hg = humanGi();
            let accA: boolean;
            let accB: boolean;
            if (!spectate && opps.includes(hg)) {
              // 사람이 상대 → 다이얼로그로 결정, 다른 AI 상대는 60% 선결정(원본).
              busy = false;
              const humanAcc = await showAiShodangPrompt(caller, det.threats);
              if (myEpoch !== epoch) return;
              busy = true;
              accA = opps[0] === hg ? humanAcc : aiAcceptsShodang();
              accB = opps[1] === hg ? humanAcc : aiAcceptsShodang();
            } else {
              accA = aiAcceptsShodang();
              accB = aiAcceptsShodang();
            }
            const dec = Shodang.resolve(caller, opps[0]!, opps[1]!, accA, accB);
            const nm = (gi: number) => (gameToOrig[gi] === HUMAN_ORIG ? humanName() : charOfOrig(gameToOrig[gi]!).name);
            applyShodangDecision(dec, `${nm(opps[0]!)}: ${accA ? '수락' : '거절'} · ${nm(opps[1]!)}: ${accB ? '수락' : '거절'}`);
            render();
            continue; // Nagari면 while 조건에서 종료, 아니면 이 AI가 이어서 수를 둔다
          }
        }
        engine.flipChoiceEnabled = false;
        engine.bonusDrawEnabled = false;
        if (AUTO) await sleep(30); else await gameDelay(620);
        if (myEpoch !== epoch) return;
        const actorOrig = gameToOrig[st.current]!;
        let agent = agentByOrig.get(actorOrig);
        if (!agent && actorOrig === HUMAN_ORIG) {
          // 자동 진행(원본 FAutoPlay): 내 캐릭터 능력치의 대리 AI가 이번 판을 대신 둔다.
          const ch = charByOrig[HUMAN_ORIG]!;
          agent = new AiPlayer(derivedSkill(ch), BigInt(Math.floor(Math.random() * 2 ** 52)) + 1n);
          agent.goBias = nerveBias(ch); agent.greed = greedBias(ch);
          agentByOrig.set(HUMAN_ORIG, agent);
        }
        if (!agent) break; // 방어: 좌석 재구성 중 접근(정상 경로에선 발생하지 않음)
        agent.act(engine);
        render();
        persist();
      }
    }
  } catch (e) {
    console.error('[drive] 예외:', e);
    $('status').textContent = '오류: ' + String(e);
    busy = false; return;
  }
  if (myEpoch !== epoch) return;
  busy = false; render();
  if (engine.state.phase === GamePhase.Finished) {
    if (!spectate) clearGame(); // 관전이 진짜 게임의 세이브를 지우면 안 된다
    void finishGame();
  }
}

// 정산: 국진→쌍피 이동 연출(있으면)을 보드에서 먼저 보여준 뒤 결과창을 띄운다.
async function finishGame(): Promise<void> {
  const myEpoch = epoch;
  const settle = engine.finalSettlement();
  const gseats = settle.map((r, i) => (r.gukjinAsPi ? i : -1)).filter((i) => i >= 0);
  if (gseats.length && !AUTO) {
    gukjinAsPiSeats = new Set(gseats); // 국진이 피 무리로 재배치 → FLIP이 카드를 미끄러뜨림
    showToast('국진 → 쌍피');
    render();
    await gameDelay(1000);
    if (myEpoch !== epoch) return; // 연출 중 새 게임 → 버려진 게임의 결과창을 띄우지 않는다
  }
  showResult(settle);
}

// 보너스패 뽑기: 뒷패를 뒷면 그대로 펼쳐 한 장을 고르게 한다.
function pickStockCard(): Promise<number> {
  return new Promise((resolve) => {
    const wrap = document.createElement('div');
    wrap.className = 'stock-pick';
    engine.state.stock.forEach((_, i) => {
      const el = document.createElement('div');
      el.className = 'card';
      el.style.backgroundImage = `url(${cardUrl('back_red')})`;
      el.addEventListener('click', () => { hideOverlay(); resolve(i); });
      wrap.appendChild(el);
    });
    $('dialog').replaceChildren(
      Object.assign(document.createElement('h2'), { textContent: '보너스! 뒷패에서 한 장 고르세요' }), wrap);
    $('overlay').classList.remove('hidden');
  });
}

// ---- 다이얼로그 ----
function pickCard(title: string, cards: HwatuCard[]): Promise<number> {
  return new Promise((resolve) => {
    const wrap = document.createElement('div');
    wrap.className = 'pick-cards';
    cards.forEach((c, i) => {
      const el = document.createElement('div');
      el.className = 'card'; el.style.backgroundImage = `url(${cardUrl(c.assetId)})`; el.title = displayName(c);
      el.addEventListener('click', () => { hideOverlay(); resolve(i); });
      wrap.appendChild(el);
    });
    $('dialog').replaceChildren(Object.assign(document.createElement('h2'), { textContent: title }), wrap);
    $('overlay').classList.remove('hidden');
  });
}
function showGoStop(): void {
  const total = engine.scoreOf(humanGi()).total;
  showOverlay(`<h2>${total}점 — 고 / 스톱?</h2><p>지금 멈추면 승리로 정산됩니다.</p>
    <div class="buttons"><button id="goBtn">고!</button><button id="stopBtn" class="secondary">스톱</button></div>`);
  $('goBtn').addEventListener('click', () => { hideOverlay(); engine.declareGo(); render(); void drive(); });
  $('stopBtn').addEventListener('click', () => { hideOverlay(); engine.declareStop(); render(); void drive(); });
}

// ---- 정산 ----
function scorePartBadges(cards: HwatuCard[]): string[] {
  const b = Scorer.evaluate(cards, OPT);
  const out: string[] = [];
  if (b.brightPoints) out.push(`광(${b.brightPoints})`);
  if (b.animalPoints) out.push(`열끗(${b.animalPoints})`);
  if (b.godoriPoints) out.push(`고도리(${b.godoriPoints})`);
  if (b.ribbonPoints) out.push(`띠(${b.ribbonPoints})`);
  if (b.hongdanPoints) out.push(`홍단(${b.hongdanPoints})`);
  if (b.cheongdanPoints) out.push(`청단(${b.cheongdanPoints})`);
  if (b.chodanPoints) out.push(`초단(${b.chodanPoints})`);
  if (b.junkPoints) out.push(`피(${b.junkPoints})`);
  return out;
}
function flagBadges(r: { reverseGo: boolean; goMultiplier: number; goCount: number; gobak: boolean; pibak: boolean; gwangbak: boolean; meongbak: boolean }, winnerShake: number): string[] {
  const out: string[] = [];
  if (r.reverseGo) out.push(`역고×${r.goMultiplier}`);
  else if (r.goMultiplier > 1) out.push(`${r.goCount}고×${r.goMultiplier}`);
  else if (r.goCount > 0) out.push(`${r.goCount}고`);
  if (winnerShake > 0) out.push(`흔들기×${2 ** winnerShake}`);
  if (r.gobak) out.push('고박');
  if (r.pibak) out.push('피박');
  if (r.gwangbak) out.push('광박');
  if (r.meongbak) out.push('멍박');
  return out;
}
function seatRowHtml(orig: number, net: number, won: number, balance: number, isWinner: boolean, badges: string[], note: string): string {
  const ch = charOfOrig(orig);
  const name = orig === HUMAN_ORIG ? humanName() : ch.name;
  const sign = net > 0 ? '+' : '';
  const cls = net > 0 ? 'win' : net < 0 ? 'lose' : 'even';
  return `<div class="settle-row ${isWinner ? 'winner' : ''}">
    <img class="savatar" src="${avatarUrl(ch, isWinner ? 'cheer' : (net < 0 ? 'sad' : 'normal'))}" alt="" />
    <div class="sinfo"><div class="sname">${name}${isWinner ? ' 👑' : ''}${note ? ` <small>${note}</small>` : ''}</div>
      ${badges.length ? `<div class="sbadges">${badges.map((b) => `<span>${b}</span>`).join('')}</div>` : ''}</div>
    <div class="sright"><div class="snet ${cls}">${sign}${net}<small>점</small><small class="swon"> ${sign}${won.toLocaleString('ko-KR')}원</small></div>
      <div class="scumul">잔액 ${fmtWon(balance)}</div></div></div>`;
}

function showResult(settle: ReturnType<typeof engine.finalSettlement>): void {
  const st = engine.state;
  // 3인 쇼당 밀어주기: 수락자가 이겼으면 거절자가 호출자+거절자 몫 전액 독박.
  if (mode === 3 && shodangPushed) {
    Shodang.applyDokbak(settle, 3, st.winner, shodangPushed.caller, shodangPushed.accepter, shodangPushed.decliner);
  }
  // 원좌석별 순손익 = 광값 선불 + 게임 정산×판돈배수
  const net = gwangNet.slice();
  for (let gi = 0; gi < settle.length; gi++) net[gameToOrig[gi]!]! += settle[gi]!.net * stakes;

  // 누적 손익에 이번 판 결과를 더한다.
  // 머니 반영(원본: 손익 × 점당 금액) + 전적 갱신.
  const wonDelta: number[] = new Array(mode).fill(0);
  for (let orig = 0; orig < mode; orig++) {
    wonDelta[orig] = net[orig]! * moneyPerPoint;
    seatMoney[orig] = (seatMoney[orig] ?? 0) + wonDelta[orig]!;
  }
  if (st.winner >= 0) {
    const wOrig = gameToOrig[st.winner]!;
    wins[wOrig] = (wins[wOrig] ?? 0) + 1;
    for (let orig = 0; orig < mode; orig++) if (net[orig]! < 0) losses[orig] = (losses[orig] ?? 0) + 1;
  }

  // 오링(파산) 처리(원본 BeginSeatReplacement / RefillCount / KillCount).
  const brokeNotes: string[] = [];
  const profile = loadProfile();
  let profileDirty = false;
  for (let orig = 0; orig < mode; orig++) {
    if ((seatMoney[orig] ?? 0) > 0) continue;
    if (orig === HUMAN_ORIG) {
      // 인간 오링: 시드머니 자동 충전(영구 RefillCount 기록 — 원본은 타이틀 복귀 + 리필)
      seatMoney[orig] = SEED_MONEY;
      profile.refillCount++; profileDirty = true;
      brokeNotes.push(`💸 오링! 시드머니 충전 (누적 ${profile.refillCount}회)`);
    } else {
      // AI 오링: 다음 판에 새 도전자로 교체(원본 좌석 교체). 결과창엔 예고만.
      const used = new Set(charByOrig.map((c) => c.index));
      const pool = allCharacters().filter((c) => !used.has(c.index));
      const ch = pool[Math.floor(Math.random() * pool.length)] ?? charByOrig[orig]!;
      pendingReplace.push({ orig, ch });
      if (winnerOrig === HUMAN_ORIG) { profile.killCount++; profileDirty = true; }
      brokeNotes.push(`💥 ${charByOrig[orig]!.name} 오링! 다음 판 ${ch.name} 등장${winnerOrig === HUMAN_ORIG ? ` (킬 ${profile.killCount})` : ''}`);
    }
  }
  if (profileDirty) saveProfile(profile);

  // 판돈 이월: 나가리면 다음 판 ×2, 승부가 나면 1로 복귀(원본 NextStakes, 전원 동의 가정).
  const wasNagari = st.winner < 0;
  stakes = wasNagari ? stakes * 2 : 1;

  const winnerOrig = st.winner >= 0 ? gameToOrig[st.winner]! : -1;
  const humanWin = winnerOrig === HUMAN_ORIG;
  // 선 로테이션(원본 GameOverContinue): 다음 판은 승자가 선, 나가리는 유지.
  if (winnerOrig >= 0) seonOrig = winnerOrig;
  const title = st.winner < 0 ? '🤝 나가리 (무승부)' : humanWin ? '🎉 승리!' : '😢 패배';
  const instant = st.threeBbeok ? '쓰리뻑! — 즉시 승리 (기본 점수)'
    : st.events.some((e) => e.kind === PlayEventKind.Chongtong) ? '총통! — 즉시 승리 (기본 점수)' : '';

  if (st.winner >= 0) {
    audio.playResult(humanWin);
    for (let orig = 0; orig < mode; orig++) setEmotion(orig, orig === winnerOrig ? 'cheer' : 'sad', 8000);
    if (!humanWin && winnerOrig >= 0) showBubble(winnerOrig, randomQuote(charOfOrig(winnerOrig)));
  }

  // 좌석 줄: 승자 먼저, 그다음 나머지
  const order = [...Array(mode).keys()].sort((a, b) => (b === winnerOrig ? 1 : 0) - (a === winnerOrig ? 1 : 0));
  const winnerShake = st.winner >= 0 ? st.player(st.winner).shakeCount : 0;
  let rows = '';
  for (const orig of order) {
    const isWin = orig === winnerOrig;
    const gi = gameIndexOfOrig(orig);
    let badges: string[] = [];
    let note = '';
    if (!instant && st.winner >= 0) {
      if (isWin) badges = scorePartBadges(st.player(gi).captured);
      else if (gi >= 0) badges = flagBadges(settle[gi]!, winnerShake);
    }
    if (gi < 0) note = round?.gwang.sold && logicalToOrig(round.gwang.sellerSeat) === orig ? '광 팔기' : '포기';
    rows += seatRowHtml(orig, net[orig]!, wonDelta[orig]!, seatMoney[orig] ?? 0, isWin, badges, note);
  }

  // 나가리로 판돈이 이월되면(다음 판 stakes>1) 안내 + 오링 예고.
  const stakesNote = wasNagari && stakes > 1 ? `<div class="instant">🔥 다음 판 판돈 ×${stakes}!</div>` : '';
  const brokeNote = brokeNotes.length ? `<div class="instant">${brokeNotes.join('<br>')}</div>` : '';
  showOverlay(`<h2 class="result-title">${title}</h2>${instant ? `<div class="instant">${instant}</div>` : ''}${stakesNote}${brokeNote}
    <div class="settle">${rows}</div><div class="buttons"><button id="againBtn">다음 판 ▶</button></div>`);
  // 판 사이 매치 스냅샷(원본 SaveMatchSnapshot): 결과창에서 브라우저를 닫아도 이어하기 가능.
  if (!spectate && !AUTO) saveMatchSnapshot();
  if (humanWin) burstCoins();
  $('againBtn').addEventListener('click', nextRound);
  // 관전은 자동으로 다음 판(단, 메뉴로 나갔으면 중단)
  const resultEpoch = epoch; // "다음 판" 클릭이나 새 게임으로 세대가 바뀌면 자동 진행 취소(이중 실행 방지)
  if (spectate) setTimeout(() => {
    if (spectate && resultEpoch === epoch && $('title').classList.contains('hidden')) nextRound();
  }, 2800);
  // 정산 팝업 방치 시 자동 다음 판(원본 GameOverTimer 5초 카운트다운). 일시정지 중엔 멈춘다.
  if (!spectate && !AUTO && settings.autoAdvance) {
    let left = 5;
    const btn = document.getElementById('againBtn');
    const iv = setInterval(() => {
      if (resultEpoch !== epoch || $('overlay').classList.contains('hidden') || !btn) { clearInterval(iv); return; }
      if (paused) return;
      btn.textContent = `다음 판 ▶ (${left})`;
      if (--left < 0) { clearInterval(iv); nextRound(); }
    }, 1000);
  }
}
function burstCoins(): void {
  const layer = $('toasts');
  for (let i = 0; i < 14; i++) {
    const c = document.createElement('div');
    c.className = 'coin'; c.textContent = '🪙';
    c.style.left = `${45 + Math.random() * 10}%`;
    c.style.animationDelay = `${Math.random() * 0.4}s`;
    c.style.setProperty('--dx', `${(Math.random() - 0.5) * 320}px`);
    layer.appendChild(c);
    setTimeout(() => c.remove(), 1600);
  }
}

function updateHeaderButtons(): void {
  $('pauseBtn').classList.toggle('on', paused);
  $('autoBtn').classList.toggle('on', autoPlay);
}

// 설정 다이얼로그(원본 Settings 다이얼로그: 닉네임·게임속도·룰 토글·말풍선 — localStorage 영속).
function showSettings(): void {
  const st = settings;
  const chk = (id: string, label: string, v: boolean) =>
    `<label class="set-row"><input type="checkbox" id="${id}" ${v ? 'checked' : ''}/> ${label}</label>`;
  showOverlay(`<h2>⚙️ 설정</h2>
    <div class="set-form">
      <label class="set-row">닉네임 <input type="text" id="setNick" maxlength="8" value="${st.nickname}" /></label>
      <label class="set-row">게임속도 <input type="range" id="setSpeed" min="0.5" max="2" step="0.25" value="${st.gameSpeed}" />
        <span id="setSpeedVal">×${st.gameSpeed}</span></label>
      ${chk('setBubbles', '말풍선 표시', st.bubbles)}
      ${chk('setBonus', '보너스패(조커) 포함 — 다음 판부터', st.bonusCards)}
      ${chk('setPibak', '피박', st.pibak)}
      ${chk('setGwangbak', '광박', st.gwangbak)}
      ${chk('setMeongbak', '멍박', st.meongbak)}
      ${chk('setGobak', '고박', st.gobak)}
      ${chk('setReverseGo', '역고(따따블)', st.reverseGo)}
      ${chk('setAutoAdv', '정산 후 자동 다음 판(5초)', st.autoAdvance)}
      <div class="set-note">룰 토글은 다음 판부터 적용됩니다.</div>
    </div>
    <div class="buttons"><button id="setSave">저장</button><button id="setClose" class="secondary">닫기</button></div>`);
  const spd = $('setSpeed') as HTMLInputElement;
  spd.addEventListener('input', () => { $('setSpeedVal').textContent = `×${spd.value}`; });
  $('setClose').addEventListener('click', hideOverlay);
  $('setSave').addEventListener('click', () => {
    settings = {
      nickname: ($('setNick') as HTMLInputElement).value.trim() || '나',
      gameSpeed: Number(spd.value) || 1,
      bubbles: ($('setBubbles') as HTMLInputElement).checked,
      bonusCards: ($('setBonus') as HTMLInputElement).checked,
      pibak: ($('setPibak') as HTMLInputElement).checked,
      gwangbak: ($('setGwangbak') as HTMLInputElement).checked,
      meongbak: ($('setMeongbak') as HTMLInputElement).checked,
      gobak: ($('setGobak') as HTMLInputElement).checked,
      reverseGo: ($('setReverseGo') as HTMLInputElement).checked,
      autoAdvance: ($('setAutoAdv') as HTMLInputElement).checked,
    };
    saveSettings(settings);
    hideOverlay();
    if (engine) render();
  });
}

function showOverlay(html: string): void { $('dialog').innerHTML = html; $('overlay').classList.remove('hidden'); }
function hideOverlay(): void { $('overlay').classList.add('hidden'); }

// 진단용 자동 플레이(?auto=1)
function autoTick(): void {
  const overlay = $('overlay');
  if (!overlay.classList.contains('hidden')) {
    const pick = overlay.querySelector<HTMLElement>('.pick-cards .card, .stock-pick .card');
    const btn = document.getElementById('startBtn') || document.getElementById('stopBtn')
      || document.getElementById('goBtn') || document.getElementById('againBtn');
    (pick ?? btn)?.click();
    return;
  }
  if (busy) return;
  const hand = $('myHand');
  if (hand.classList.contains('playable')) {
    const cards = hand.querySelectorAll<HTMLElement>('.card:not(.dimmed)');
    if (cards.length) cards[Math.floor(Math.random() * cards.length)]!.click();
  }
}

// ---- 타이틀 화면 ----
let selectedChar = 0;
let titleModeVal: 2 | 3 | 4 = 2;
let maxStat = 50;

function renderGallery(): void {
  const g = $('charGallery');
  g.replaceChildren(...allCharacters().map((c) => {
    const t = document.createElement('button');
    t.className = 'char-thumb' + (c.index === selectedChar ? ' on' : '');
    t.innerHTML = `<img src="${avatarUrl(c, 'normal')}" alt="" /><span>${c.name}</span>`;
    t.addEventListener('click', () => selectChar(c.index));
    return t;
  }));
}
function statBar(label: string, v: number): string {
  return `<div class="stat"><span class="stat-l">${label}</span><span class="stat-track"><span class="stat-fill" style="width:${Math.min(100, (v / maxStat) * 100)}%"></span></span></div>`;
}
function renderDetail(idx: number): void {
  const c = characterAt(idx);
  const s = c.stats;
  $('charDetail').innerHTML = `
    <img class="detail-avatar" src="${avatarUrl(c, 'normal')}" alt="" />
    <div class="detail-name">${c.name} <span class="stars">${'★'.repeat(c.goStars)}${'☆'.repeat(5 - c.goStars)}</span></div>
    <div class="detail-job">${c.ageJob} · 난이도 ${c.recommendedDifficulty}</div>
    <div class="detail-persona">${c.personality}</div>
    <div class="detail-play">🎯 ${c.playstyle}</div>
    <div class="detail-stats">
      ${statBar('수읽기', s.insight)}${statBar('침착', s.composure)}${statBar('배짱', s.nerve)}${statBar('욕심', s.greed)}${statBar('운', s.luck)}
    </div>
    <div class="detail-derived">실력 ${derivedSkill(c)} · 배짱성향 ${nerveBias(c)} · 욕심성향 ${greedBias(c)}</div>
    <div class="detail-quote">“${c.quotes[0] ?? ''}”</div>`;
}
function selectChar(idx: number): void {
  selectedChar = idx;
  document.querySelectorAll('.char-thumb').forEach((t, i) => t.classList.toggle('on', i === idx));
  renderDetail(idx);
}
function showTitle(): void {
  $('resumeBtn').classList.toggle('hidden', !hasSave());
  $('title').classList.remove('hidden');
}
function hideTitle(): void { $('title').classList.add('hidden'); }
function startFromTitle(random: boolean): void {
  ($('modeSel') as HTMLSelectElement).value = String(titleModeVal);
  ($('charSel') as HTMLSelectElement).value = random ? '' : String(selectedChar);
  spectate = false;
  hideTitle();
  startSession();
}

// ---- 초기화 ----
async function init(): Promise<void> {
  await loadCharacters();
  maxStat = Math.max(...allCharacters().flatMap((c) => Object.values(c.stats)));

  const sel = $('charSel') as HTMLSelectElement;
  sel.replaceChildren(new Option('랜덤', ''), ...allCharacters().map((c) => new Option(`${c.name} (${'★'.repeat(c.goStars)})`, String(c.index))));
  sel.addEventListener('change', startSession);
  ($('modeSel') as HTMLSelectElement).addEventListener('change', startSession);
  ($('sound') as HTMLInputElement).addEventListener('change', (e) => audio.setSoundEnabled((e.target as HTMLInputElement).checked));
  $('newGame').addEventListener('click', nextRound);
  $('menuBtn').addEventListener('click', showTitle);
  $('settingsBtn').addEventListener('click', showSettings);
  $('pauseBtn').addEventListener('click', () => {
    paused = !paused;
    updateHeaderButtons();
    if (engine) render();
  });
  $('autoBtn').addEventListener('click', () => {
    autoPlay = !autoPlay;
    updateHeaderButtons();
    if (engine) { render(); if (autoPlay && !busy && !paused) void drive(); }
  });

  // 타이틀 배선
  renderGallery();
  selectChar(0);
  $('titleMode').querySelectorAll('button').forEach((b) => b.addEventListener('click', () => {
    titleModeVal = Number(b.dataset.m) as 2 | 3 | 4;
    $('titleMode').querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
  }));
  $('startBtnT').addEventListener('click', () => startFromTitle(false));
  $('randomStart').addEventListener('click', () => startFromTitle(true));
  $('resumeBtn').addEventListener('click', resumeSaved);
  $('spectateBtn').addEventListener('click', () => {
    ($('charSel') as HTMLSelectElement).value = ''; // 관전은 랜덤 캐릭터
    spectate = true; hideTitle(); startSession();
  });

  const players = new URLSearchParams(location.search).get('players');
  if (players === '2' || players === '3' || players === '4') {
    ($('modeSel') as HTMLSelectElement).value = players;
    titleModeVal = Number(players) as 2 | 3 | 4;
    $('titleMode').querySelectorAll('button').forEach((x) => x.classList.toggle('on', x.dataset.m === players));
  }

  const wantSpectate = new URLSearchParams(location.search).has('spectate');
  if (AUTO || wantSpectate) {
    if (wantSpectate) spectate = true;
    hideTitle();
    startSession();
    if (AUTO) setInterval(autoTick, 60);
  } else showTitle();
}
void init();
