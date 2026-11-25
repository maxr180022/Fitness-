'use strict';
/* Фитнес: личное приложение. Данные тренировок хранятся на телефоне (localStorage),
   контент (data/*.json и видео) подтягивается из репозитория и обновляется без пересборки. */

const KEY = 'fit.v1';
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g,
  (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pad = (n) => String(n).padStart(2, '0');
const dateStr = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const shortDate = (s) => { const [y, m, d] = s.split('-'); return `${d}.${m}.${y.slice(2)}`; };
const WD = ['воскресенье', 'понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота'];
const MONTHS = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
const num = (v) => { const n = parseFloat(String(v).replace(',', '.')); return isNaN(n) ? null : n; };

let DB = loadDB();
let P = null; // программа
let BODY = null; // стартовые замеры и контрольные точки
let N = null; // питание
let foodTab = 'menu';
let foodWeek = 0;
function cycleWeek(d = new Date()) {
  const a = new Date(2026, 10, 16), x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const n = Math.floor(Math.round((x - a) / 86400000) / 7);
  return ((n % 2) + 2) % 2 + 1;
}
function menuFor(wd, wk) { return (N.menu || []).find((x) => [].concat(x.weekday).includes(wd) && (x.week === 0 || x.week === wk)); }
let installEvt = null;
let swReg = null;
let wakeLock = null;
let lastRoute = '';

function blank() { return { logs: {}, measures: [], water: {}, shop: {}, settings: { split: true } }; }
function loadDB() {
  try {
    const d = JSON.parse(localStorage.getItem(KEY));
    if (d && typeof d === 'object') { const x = Object.assign(blank(), d); x.settings = Object.assign({ split: true }, x.settings); return x; }
  } catch (e) { /* пусто */ }
  return blank();
}
function save() {
  try { localStorage.setItem(KEY, JSON.stringify(DB)); } catch (e) { toast('Не удалось сохранить данные'); }
  scheduleSync();
}

/* ---------- копия журнала на сервере (приватный репозиторий GitHub) ---------- */
const SYNC_KEY = 'fit.sync', SYNC_FILE = 'fitness.json';
let syncT = null, syncBusy = false;
function syncCfg() { try { const c = JSON.parse(localStorage.getItem(SYNC_KEY)); return c && c.repo && c.token ? c : null; } catch (e) { return null; } }
function syncStat() { try { return JSON.parse(localStorage.getItem('fit.syncstat')) || null; } catch (e) { return null; } }
function syncStatText() {
  const c = syncCfg(), st = syncStat();
  if (!c) return 'Сервер не подключён: записи лежат только на телефоне.';
  if (!st) return 'Подключено, ещё не сохраняли.';
  const t = new Date(st.t), hm = `${pad(t.getHours())}:${pad(t.getMinutes())}`;
  return st.ok ? `Сохранено на сервере в ${hm}.` : `Не удалось (${hm}): ${st.msg}`;
}
function setSyncStat(ok, msg) {
  try { localStorage.setItem('fit.syncstat', JSON.stringify({ t: Date.now(), ok, msg })); } catch (e) { /* ok */ }
  const el = $('#sync-status'); if (el) el.textContent = syncStatText();
}
function b64enc(str) { const b = new TextEncoder().encode(str); let r = ''; b.forEach((x) => { r += String.fromCharCode(x); }); return btoa(r); }
function b64dec(b) { const r = atob(String(b).replace(/\s/g, '')), u = new Uint8Array(r.length); for (let i = 0; i < r.length; i++) u[i] = r.charCodeAt(i); return new TextDecoder().decode(u); }
// Слияние: ничего не удаляется. Из двух версий одного дня берётся та, где отмечено больше подходов.
function mergeDB(remote) {
  let changed = false; const r = remote || {};
  Object.entries(r.logs || {}).forEach(([d, day]) => Object.entries(day || {}).forEach(([wid, sess]) => {
    DB.logs[d] = DB.logs[d] || {};
    const mine = DB.logs[d][wid];
    if (!mine || doneCount(sess) > doneCount(mine)) { DB.logs[d][wid] = sess; changed = true; }
  }));
  const ids = new Set(DB.measures.map((m) => m.id));
  (r.measures || []).forEach((m) => { if (!ids.has(m.id)) { DB.measures.push(m); changed = true; } });
  Object.entries(r.water || {}).forEach(([d, v]) => { if (!(DB.water[d] >= v)) { DB.water[d] = v; changed = true; } });
  Object.keys(r.shop || {}).forEach((k) => { if (!(k in DB.shop)) { DB.shop[k] = r.shop[k]; changed = true; } });
  Object.keys(r.settings || {}).forEach((k) => { if (!(k in DB.settings)) { DB.settings[k] = r.settings[k]; changed = true; } });
  return changed;
}
async function ghApi(cfg, method, body) {
  const r = await fetch(`https://api.github.com/repos/${cfg.repo}/contents/${SYNC_FILE}${method === 'GET' ? '?t=' + Date.now() : ''}`, {
    method, headers: { Authorization: `Bearer ${cfg.token}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  return r;
}
async function syncNow(manual) {
  const cfg = syncCfg(); if (!cfg) { if (manual) toast('Сначала подключи сервер'); return; }
  if (syncBusy) return; syncBusy = true;
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      let sha = null, remote = null;
      const g = await ghApi(cfg, 'GET');
      if (g.status === 401 || g.status === 403) throw new Error('токен не подходит или нет прав на запись');
      if (g.status === 404) {
        const t = await fetch(`https://api.github.com/repos/${cfg.repo}`, { headers: { Authorization: `Bearer ${cfg.token}` } });
        if (t.status === 404) throw new Error('репозиторий не найден: проверь название и доступ токена');
      } else if (g.ok) { const j = await g.json(); sha = j.sha; try { remote = JSON.parse(b64dec(j.content)).data; } catch (e) { remote = null; } }
      else throw new Error('ошибка сервера ' + g.status);
      if (remote && mergeDB(remote)) { try { localStorage.setItem(KEY, JSON.stringify(DB)); } catch (e) { /* ok */ } if (!/^#\/w\/[^/]+\/\d/.test(location.hash)) render(true); }
      if (remote && JSON.stringify(remote) === JSON.stringify(DB)) { setSyncStat(true); return; }
      const p = await ghApi(cfg, 'PUT', {
        message: `Журнал ${dateStr()} ${pad(new Date().getHours())}:${pad(new Date().getMinutes())}`,
        content: b64enc(JSON.stringify({ app: 'fitness', savedAt: new Date().toISOString(), data: DB }, null, 1)), sha: sha || undefined,
      });
      if (p.status === 409 || p.status === 422) continue;
      if (p.status === 401 || p.status === 403 || p.status === 404) throw new Error('нет прав на запись в репозиторий');
      if (!p.ok) throw new Error('ошибка сервера ' + p.status);
      setSyncStat(true); if (manual) toast('Сохранено на сервере'); return;
    }
    throw new Error('конфликт версий, попробуй ещё раз');
  } catch (e) {
    setSyncStat(false, /Failed to fetch|Network/i.test(String(e.message)) ? 'нет связи' : e.message);
    if (manual) toast('Не получилось: ' + (syncStat() || {}).msg);
  } finally { syncBusy = false; }
}
function scheduleSync(ms) { if (!syncCfg()) return; clearTimeout(syncT); syncT = setTimeout(() => syncNow(false), ms == null ? 20000 : ms); }
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') scheduleSync(300); });

/* ---------- загрузка контента ---------- */
async function getJSON(path) {
  const ck = 'fit.cache.' + path;
  try {
    const r = await fetch(path, { cache: 'no-cache' });
    if (!r.ok) throw new Error('http ' + r.status);
    const j = await r.json();
    try { localStorage.setItem(ck, JSON.stringify(j)); } catch (e) { /* ok */ }
    return j;
  } catch (e) {
    const c = localStorage.getItem(ck);
    if (c) return JSON.parse(c);
    throw e;
  }
}
// data/history.json: записи тренировок, добавленные в репозиторий вручную.
// Вставляются на телефон один раз и только если на эту дату и тренировку записи ещё нет.
async function mergeHistory() {
  let h;
  try { h = await getJSON('data/history.json'); } catch (e) { return; }
  let added = 0;
  Object.entries((h && h.logs) || {}).forEach(([d, day]) => Object.entries(day).forEach(([wid, sess]) => {
    DB.logs[d] = DB.logs[d] || {};
    if (!DB.logs[d][wid]) { DB.logs[d][wid] = sess; added++; }
  }));
  if (added) save();
}
// Стартовые замеры из data/body.json добавляются в журнал замеров один раз (по id), удалять их нельзя.
function seedBaseline() {
  if (!BODY || !Array.isArray(BODY.baseline)) return;
  const ids = new Set(DB.measures.map((m) => m.id)); let added = false;
  BODY.baseline.forEach((m) => { if (!ids.has(m.id)) { DB.measures.push(Object.assign({}, m)); added = true; } });
  if (added) { try { localStorage.setItem(KEY, JSON.stringify(DB)); } catch (e) { /* ok */ } scheduleSync(); }
}
async function loadContent() {
  const [p, n] = await Promise.all([getJSON('data/program.json'), getJSON('data/nutrition.json')]);
  const changed = JSON.stringify(p) !== JSON.stringify(P) || JSON.stringify(n) !== JSON.stringify(N);
  P = p; N = n;
  try { BODY = await getJSON('data/body.json'); seedBaseline(); } catch (e) { /* без стартовых замеров */ }
  return changed;
}

/* ---------- утилиты данных ---------- */
const workoutById = (id) => (P.workouts || []).find((w) => w.id === id);
const setsCount = (w, exId) => (w.setsOverride && w.setsOverride[exId]) || w.setsPerExercise || 3;

function getSession(wid, create) {
  const d = dateStr();
  if (!DB.logs[d]) { if (!create) return null; DB.logs[d] = {}; }
  if (!DB.logs[d][wid]) { if (!create) return null; DB.logs[d][wid] = { sets: {}, finished: false }; }
  return DB.logs[d][wid];
}
function baseOf(id) { const e = P && P.exercises && P.exercises[id]; return (e && e.base) || 0; }
function fmtKgNum(n) { return String(Math.round(n * 100) / 100).replace('.', ','); }

// Рекомендация по весу: считается по последнему разу, иначе стартовое значение (поле rec в program.json)
function recFor(exId) {
  const ex = P && P.exercises && P.exercises[exId];
  if (!ex || !ex.weighted) return null;
  const base = baseOf(exId); const hands = ex.hands || 1;
  const m = String(ex.target || '').match(/(\d+)\s*[–-]\s*(\d+)/); const hi = m ? +m[2] : 0;
  const step = base >= 5 ? 5 : 2.5;
  const num = (x) => parseFloat(String(x.kg).replace(',', '.'));
  const today = dateStr(); let last = null;
  Object.keys((DB && DB.logs) || {}).sort().reverse().some((d) => {
    if (d >= today) return false;
    return Object.values(DB.logs[d]).some((sess) => {
      const a = sess && sess.sets && sess.sets[exId];
      const done = a ? a.filter((x) => x.done && String(x.kg) !== '' && !isNaN(num(x))) : [];
      if (done.length) { last = { d, sets: done }; return true; }
      return false;
    });
  });
  let plates; let why = '';
  if (last) {
    const top = Math.max(...last.sets.map(num));
    const reps = last.sets.filter((x) => num(x) === top).map((x) => parseInt(x.reps, 10) || 0);
    const allTop = hi && reps.length >= 2 && reps.every((r) => r >= hi);
    plates = allTop ? top + step : top;
    why = `Прошлый раз (${shortDate(last.d)}): ${fmtKgNum(top)} × ${reps.join(', ')}. ` + (allTop ? 'Все подходы на верху диапазона, поэтому прибавляем.' : `Вес оставляем, добей до ${hi || 'верха диапазона'} повторов во всех подходах.`);
  } else if (ex.rec != null) {
    plates = +ex.rec; why = 'Стартовый вес. Если останется больше 3 повторов в запасе, в следующий раз прибавим.';
  } else return null;
  const total = plates + base;
  const tail = base >= 5 ? 'с грифом' : (hands > 1 ? 'в каждой руке' : 'на гантели');
  return { plates, total, tail, why };
}
function kgPre(id, kg) {
  const b = baseOf(id), e = P && P.exercises && P.exercises[id], pair = e && e.hands > 1 ? `${e.hands} × ` : '';
  if (!b) return kg ? `${pair}${kg} кг × ` : '';
  const k = parseFloat(String(kg).replace(',', '.'));
  return `${pair}${fmtKgNum((isNaN(k) ? 0 : k) + b)} кг × `;
}
function getSets(wid, exId, n) {
  const s = getSession(wid, true);
  if (!s.sets[exId]) s.sets[exId] = [];
  const arr = s.sets[exId];
  while (arr.length < n) arr.push({ kg: '', reps: '', done: false });
  return arr;
}
function doneCount(sess) {
  if (!sess) return 0;
  let c = 0;
  Object.values(sess.sets || {}).forEach((a) => a.forEach((s) => { if (s.done) c++; }));
  return c;
}
function lastTime(exId, wid) {
  const today = dateStr();
  const dates = Object.keys(DB.logs).filter((d) => d < today).sort().reverse();
  for (const d of dates) {
    for (const [k, sess] of Object.entries(DB.logs[d])) {
      const arr = sess.sets && sess.sets[exId];
      if (arr && arr.some((s) => s.done)) {
        const parts = arr.filter((s) => s.done).map((s) => kgPre(exId, s.kg) + s.reps);
        return `${shortDate(d)}: ${parts.join(', ')}`;
      }
    }
  }
  return '';
}
function weekStats() {
  const now = new Date(); let c = 0, sec = 0;
  for (let i = 0; i < 7; i++) {
    const d = new Date(now); d.setDate(now.getDate() - i);
    const day = DB.logs[dateStr(d)];
    if (day) Object.entries(day).forEach(([k, s]) => {
      if (doneCount(s) > 0) { c++; if (s.finished) sec += sessionSeconds(s); }
    });
  }
  return { c, sec };
}
function lastMeasure(field) {
  const arr = DB.measures.filter((m) => m[field] != null).sort((a, b) => (a.date < b.date ? 1 : -1));
  return arr[0] ? { v: arr[0][field], d: arr[0].date } : null;
}

/* ---------- UI helpers ---------- */
let toastT = null;
function toast(msg) {
  const el = $('#toast'); el.textContent = msg; el.classList.remove('hidden');
  clearTimeout(toastT); toastT = setTimeout(() => el.classList.add('hidden'), 3500);
}
function fmtTime(s) { return `${Math.floor(s / 60)}:${pad(s % 60)}`; }
function fmtLong(s) { const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60); return h ? `${h} ч ${pad(m)} мин` : `${m} мин`; }
function sessionSeconds(sess) {
  if (!sess || !sess.startedAt) return 0;
  if (sess.durationSec != null && sess.endedAt) return sess.durationSec;
  return Math.max(0, Math.round((Date.now() - sess.startedAt) / 1000));
}
function startSession(wid) {
  const s = getSession(wid, true);
  if (!s.startedAt) { s.startedAt = Date.now(); s.endedAt = null; s.durationSec = null; save(); }
  return s;
}
setInterval(() => {
  const el = $('#wclock'); if (!el) return;
  const s = getSession(el.dataset.w, false);
  el.textContent = s && s.startedAt ? fmtTime(sessionSeconds(s)) : '0:00';
}, 1000);

/* ---------- таймер ---------- */
let T = null;
function startTimer(sec, label) {
  stopTimer();
  T = { end: Date.now() + sec * 1000, label, iv: null };
  const el = $('#timer'); el.classList.remove('hidden'); document.body.classList.add('has-timer');
  el.innerHTML = `<div class="grow"><div class="small muted">${esc(label)}</div><div class="t">${fmtTime(sec)}</div></div>
    <button data-act="t+">+15 с</button><button data-act="tstop" class="ghost">Стоп</button>`;
  T.iv = setInterval(tick, 250);
}
function tick() {
  if (!T) return;
  const left = Math.ceil((T.end - Date.now()) / 1000);
  if (left <= 0) { finishTimer(); return; }
  const t = $('#timer .t'); if (t) t.textContent = fmtTime(left);
}
function finishTimer() {
  const label = T ? T.label : '';
  clearInterval(T && T.iv); T = null;
  beep();
  const el = $('#timer');
  el.innerHTML = `<div class="grow"><div class="small muted">${esc(label)}</div><div class="t">Готово ✓</div></div><button data-act="tstop">Ок</button>`;
  setTimeout(() => { if (!T) { el.classList.add('hidden'); document.body.classList.remove('has-timer'); } }, 5000);
}
function stopTimer() {
  if (T) clearInterval(T.iv);
  T = null; $('#timer').classList.add('hidden'); document.body.classList.remove('has-timer');
}
function beep() {
  try {
    const a = new (window.AudioContext || window.webkitAudioContext)();
    const o = a.createOscillator(), g = a.createGain();
    o.connect(g); g.connect(a.destination); o.frequency.value = 880; g.gain.value = 0.15;
    o.start(); setTimeout(() => { o.stop(); a.close(); }, 350);
  } catch (e) { /* без звука */ }
  try { if (navigator.vibrate) navigator.vibrate([200, 100, 200]); } catch (e) { /* без вибрации */ }
}

/* ---------- экраны ---------- */
function viewToday() {
  const now = new Date();
  const wd = now.getDay();
  const title = `${WD[wd][0].toUpperCase()}${WD[wd].slice(1)}, ${now.getDate()} ${MONTHS[now.getMonth()]}`;
  const w = (P.workouts || []).find((x) => x.weekday === wd);
  let h = `<h1>${esc(title)}</h1>`;
  if (w) {
    const s = getSession(w.id, false); const dc = doneCount(s);
    const pending = w.status === 'pending';
    h += `<div class="card ${dc ? 'done' : 'accent'} today"><div class="row between"><h3>${esc(w.title)}</h3>
      ${pending ? '<span class="tag">скоро</span>' : dc ? `<span class="tag ok">${dc} подх.${s && s.finished ? ' · ' + fmtLong(sessionSeconds(s)) : ''}</span>` : '<span class="tag acc">сегодня</span>'}</div>
      <div class="muted small" style="margin:2px 0 10px">${w.items.length} ${plural(w.items.length, 'упражнение', 'упражнения', 'упражнений')}${s && s.finished ? ' · день закончен' : ''}</div>
      <a class="btn primary block" href="#/w/${esc(w.id)}">${s && s.finished ? 'Открыть' : dc ? 'Продолжить' : pending ? 'Открыть' : 'Начать тренировку'}</a></div>`;
  } else {
    h += `<div class="card"><h3>Сегодня без силовой</h3><p class="muted">День восстановления: прогулка и лёгкая растяжка по желанию.</p></div>`;
  }
  // питание сегодня
  const m = menuFor(wd, cycleWeek());
  const water = DB.water[dateStr()] || 0, goal = N.targets.waterGoalMl;
  h += `<div class="card"><div class="row between"><h3>Питание сегодня</h3><a href="#/food">всё меню</a></div>`;
  if (m) h += `<table>${m.meals.map(([a, b]) => `<tr><th>${esc(a)}</th><td>${esc(b)}</td></tr>`).join('')}</table>`;
  h += `<p class="muted small">Цель: ${esc(N.targets.kcal)} ккал, белок ${esc(N.targets.protein)}.</p></div>`;
  h += `<div class="card"><div class="row between"><h3>Вода</h3><span class="muted">${water} / ${goal} мл</span></div>
    <div class="bar"><i style="width:${Math.min(100, Math.round(water / goal * 100))}%"></i></div>
    <div class="row"><button class="grow" data-act="water" data-ml="${N.targets.waterGlassMl}">+ стакан ${N.targets.waterGlassMl} мл</button>
    <button class="ghost" data-act="water" data-ml="-${N.targets.waterGlassMl}">−</button></div></div>`;
  const waist = lastMeasure('waist'); const ws = weekStats();
  h += `<div class="grid2"><div class="card"><div class="muted small">За 7 дней</div><h1>${ws.c}</h1><div class="muted small">${ws.sec ? fmtLong(ws.sec) : 'тренировок'}</div></div>
    <a class="card" href="#/body" style="color:inherit;text-decoration:none"><div class="muted small">Талия${waist ? ' · ' + shortDate(waist.d) : ''}</div><h1>${waist ? String(waist.v).replace('.', ',') + ' см' : '—'}</h1></a></div>`;
  if (wd === 0) h += `<div class="card accent"><h3>Воскресенье: замер талии</h3><p class="muted small">Утром, натощак, на уровне пупка, на выдохе.</p><a class="btn block" href="#/body">Записать замер</a></div>`;
  return h;
}

/* ---------- иконки и мелкие помощники ---------- */
const IC_P = {
  back: '<path d="M19 12H5M11 6l-6 6 6 6"/>',
  timer: '<circle cx="12" cy="14" r="7"/><path d="M12 14v-3.5M9.5 3h5M12 3v4"/>',
  sliders: '<path d="M4 8h9M17 8h3M4 16h3M11 16h9"/><circle cx="15" cy="8" r="2"/><circle cx="9" cy="16" r="2"/>',
  play: '<path d="M7 4.5v15l13-7.5z" fill="currentColor" stroke="none"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" stroke="none"/>',
  history: '<path d="M3.5 12a8.5 8.5 0 1 0 2.6-6.1L3.5 8.5M3.5 3.5v5h5M12 7.5V12l3 2"/>',
  swap: '<path d="M4 9V6h14M15 3l3 3-3 3M20 15v3H6M9 21l-3-3 3-3"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  prev: '<path d="M12 6l-6 6 6 6M19 6l-6 6 6 6"/>',
  next: '<path d="M5 6l6 6-6 6M12 6l6 6-6 6"/>',
  kebab: '<circle cx="12" cy="5" r="1.8" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.8" fill="currentColor" stroke="none"/><circle cx="12" cy="19" r="1.8" fill="currentColor" stroke="none"/>',
  list: '<path d="M5 6h14M5 12h14M5 18h14"/>',
  chev: '<path d="M7 10l5 5 5-5"/>',
};
const ic = (n) => `<svg class="ic" viewBox="0 0 24 24" aria-hidden="true">${IC_P[n]}</svg>`;
const plural = (n, a, b, c) => { const m = n % 100, k = n % 10; return m > 10 && m < 20 ? c : k === 1 ? a : k > 1 && k < 5 ? b : c; };
const DSHORT = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];
let panel = null; // раскрытая панель: tech | hist | swap | settings
let RT = null;    // таймер внутри строки подхода (секунды)

const extraSets = (w, exId) => { const s = getSession(w.id, false); return (s && s.extra && s.extra[exId]) || 0; };
const nSets = (w, exId) => setsCount(w, exId) + extraSets(w, exId);
const phOf = (ex) => { const m = String(ex.target || '').match(/^[\d–-]+/); return m ? m[0] : String(ex.def); };
const targetText = (ex, n) => `${n} × ${ex.target}${ex.unit !== 'sec' && /^[\d–-]+$/.test(String(ex.target)) ? ' повторений' : ''}`;

function ringHTML(ex, frac, size) {
  const deg = Math.round(360 * Math.max(0, Math.min(1, frac)));
  const inner = ex.poster ? `<img src="${esc(ex.poster)}" alt="" loading="lazy">` : `<span class="ph">${esc(ex.name.slice(0, 1))}</span>`;
  return `<span class="ring" style="--p:${deg}deg;--s:${size}px">${inner}</span>`;
}
function exFrac(w, exId) {
  const n = nSets(w, exId); const s = getSession(w.id, false);
  const arr = (s && s.sets && s.sets[exId]) || [];
  return n ? arr.filter((x) => x.done).length / n : 0;
}
function defaultWorkout() {
  const wd = new Date().getDay();
  const list = (P.workouts || []);
  return list.find((x) => x.weekday === wd && x.items.length) || list.find((x) => x.items.length) || list[0];
}
function weekDays() {
  const now = new Date(); const dow = (now.getDay() + 6) % 7;
  const mon = new Date(now); mon.setDate(now.getDate() - dow);
  return [...Array(7)].map((_, i) => { const d = new Date(mon); d.setDate(mon.getDate() + i); return d; });
}
function swapsOf(w) { DB.settings.swaps = DB.settings.swaps || {}; return DB.settings.swaps[w.id] || {}; }

/* ---------- экраны ---------- */
function viewLib() {
  let h = '<h1>Упражнения</h1><div class="card list">';
  Object.entries(P.exercises).forEach(([id, ex]) => {
    h += `<a class="item" href="#/ex/${esc(id)}">${ringHTML(ex, 0, 40)}<div class="grow"><div><b>${esc(ex.name)}</b></div><div class="muted small">${esc(ex.muscles)}</div></div><span class="chev">›</span></a>`;
  });
  return h + '</div>';
}

function videoHTML(ex) {
  if (!ex.video) return '<div class="novideo">Видео для этого упражнения готовится и появится после обновления</div>';
  return `<video controls playsinline loop preload="none" src="${esc(ex.video)}"></video>`;
}
function tipsHTML(ex) {
  return `<h3>Как делать</h3><ul class="tips">${ex.tips.map((t) => `<li>${esc(t)}</li>`).join('')}</ul>
    ${ex.mistakes && ex.mistakes.length ? `<h3>Типичные ошибки</h3><ul class="tips bad">${ex.mistakes.map((t) => `<li>${esc(t)}</li>`).join('')}</ul>` : ''}`;
}

function workoutGroups(w) {
  const sw = swapsOf(w); const m = (e) => sw[e] || e;
  const split = DB.settings.split && Array.isArray(w.groups) && w.groups.length;
  return (split ? w.groups : w.items.map((e) => [e])).map((g) => g.map(m));
}

function settingsPanel(w) {
  const has = Array.isArray(w.groups) && w.groups.length;
  return `<div class="panel"><h3>Настройки тренировки</h3>
    ${has ? `<div class="row between"><div class="grow"><b>Сплит</b><div class="muted small">Пары упражнений подряд без отдыха, отдых после пары. Приложение само переключает на второе упражнение.</div></div>
      <button class="sw ${DB.settings.split ? 'on' : ''}" data-act="splitmode" aria-label="сплит"><i></i></button></div>` : '<p class="muted small">Для этой тренировки пока нет пар упражнений.</p>'}</div>`;
}

function viewWorkout(id) {
  const w = workoutById(id);
  if (!w) return '<p class="pad">Тренировка не найдена.</p>';
  const isCore = false;
  const selWd = isCore ? new Date().getDay() : w.weekday;
  const tue = workoutById('tue'), fri = workoutById('fri');
  // верхняя панель
  let h = `<div class="screen"><div class="top2"><a class="rbtn" href="#/" data-act="back" aria-label="назад">${ic('back')}</a>
    <h1 class="ttl">${esc(w.title)}</h1><button class="rbtn" data-act="panel" data-k="settings" aria-label="настройки">${ic('sliders')}</button></div>`;
  // неделя
  h += '<div class="week">' + weekDays().map((d, i) => {
    const wk = (P.workouts || []).find((x) => x.weekday === d.getDay());
    const logs = DB.logs[dateStr(d)]; let done = false;
    if (logs) Object.values(logs).forEach((s) => { if (doneCount(s) > 0) done = true; });
    const sel = d.getDay() === selWd;
    const label = sel ? `${pad(d.getDate())}.${pad(d.getMonth() + 1)}` : DSHORT[i];
    const inner = `<span class="wl">${label}</span><i class="wdot ${done ? 'done' : ''}"></i><span class="wk">${wk ? esc(wk.short || '•') : '--'}</span>`;
    return wk ? `<a class="wd ${sel ? 'sel' : ''}" href="#/w/${esc(wk.id)}">${inner}</a>` : `<span class="wd ${sel ? 'sel' : ''}">${inner}</span>`;
  }).join('') + '</div>';
  // А/Б + блок кор
  h += `<div class="seg2 one"><div class="seg"><a class="${w.id === 'tue' ? 'on' : ''}" href="#/w/tue">${esc((tue && tue.short) || 'А')}</a><a class="${w.id === 'fri' ? 'on' : ''}" href="#/w/fri">${esc((fri && fri.short) || 'Б')}</a></div>
</div>`;
  if (panel === 'settings') h += settingsPanel(w);
  if (w.status === 'pending' || !w.items.length) {
    return h + `<div class="panel"><p>${esc(w.description)}</p></div></div>`;
  }
  const sess = getSession(w.id, false);
  const started = sess && sess.startedAt, finished = sess && sess.finished;
  const groups = workoutGroups(w); const flat = groups.flat();
  const isSplit = groups.some((g) => g.length > 1);
  if (w.warmup) h += `<div class="sect">Разминка</div><div class="panel"><p class="muted">${esc(w.warmup)}</p></div>`;
  h += `<div class="sect">${flat.length} ${plural(flat.length, 'упражнение', 'упражнения', 'упражнений')}</div><div class="exlist">`;
  let idx = 0;
  groups.forEach((g, gi) => {
    if (isSplit && g.length > 1) h += `<div class="pairnote">Пара ${gi + 1} · подряд без отдыха</div>`;
    g.forEach((exId) => {
      const ex = P.exercises[exId]; if (!ex) { idx++; return; }
      h += `<div class="exrow"><a class="exmain" href="#/w/${esc(w.id)}/${idx}">${ringHTML(ex, exFrac(w, exId), 50)}
        <div class="grow"><div class="exn">${esc(ex.name)}</div><div class="exs">${esc(targetText(ex, nSets(w, exId)))}</div></div></a>
        <a class="kebab" href="#/ex/${esc(exId)}" aria-label="о упражнении">${ic('kebab')}</a></div>`;
      idx++;
    });
  });
  h += '</div></div>';
  // плавающая кнопка
  const t = started ? fmtTime(sessionSeconds(sess)) : '';
  const hasSets = doneCount(sess) > 0;
  const dur = sessionSeconds(sess);
  if (finished) h += `<div class="fabs"><button class="fab" data-act="story" data-w="${esc(w.id)}"><span>Картинка для сторис</span></button><button class="fab done" data-act="finish" data-w="${esc(w.id)}">${ic('check')}<span>${dur ? esc(fmtLong(dur)) : 'Готово'}</span></button></div>`;
  else if (started || hasSets) h += `<div class="fabs"><a class="fab ghost" href="#/w/${esc(w.id)}/0"><span>Продолжить</span></a><button class="fab" data-act="finish" data-w="${esc(w.id)}"><span>Закончить день${started ? ' · <b id="wclock" data-w="' + esc(w.id) + '">' + t + '</b>' : ''}</span></button></div>`;
  else h += `<button class="fab" data-act="wstart" data-w="${esc(w.id)}"><span>Начать ${isCore ? 'блок' : 'день ' + esc(w.short || '')}</span></button>`;
  return h;
}

function setRow(wid, exId, i, s, ex) {
  const sec = ex.unit === 'sec'; const wt = !!ex.weighted;
  const run = RT && RT.w === wid && RT.exId === exId && RT.i === i;
  return `<div class="srow ${s.done ? 'on' : ''} ${wt ? '' : 'nw'} ${run ? 'run' : ''}" data-w="${esc(wid)}" data-e="${esc(exId)}" data-i="${i}">
    <span class="num">${i + 1}</span>
    ${wt ? `<label class="pillin"><input inputmode="decimal" data-f="kg" value="${esc(s.kg)}" placeholder="${esc((() => { const R = recFor(exId); return R ? fmtKgNum(R.plates) : '0'; })())}" aria-label="вес блинов, кг"><u>${baseOf(exId) ? '+' + fmtKgNum(baseOf(exId)) : 'кг'}</u></label>` : ''}
    <label class="pillin"><input inputmode="numeric" data-f="reps" value="${esc(s.reps)}" placeholder="${esc(phOf(ex))}" aria-label="${sec ? 'секунды' : 'повторы'}">${sec ? '<u>сек</u><span class="cd">0:00</span><button type="button" class="pt" data-act="tm" aria-label="таймер">' + ic('play') + ic('stop') + '</button>' : ''}</label>
    <button class="chk" data-act="chk" aria-label="подход выполнен">${ic('check')}</button></div>`;
}

function viewStep(wid, idxRaw) {
  const w = workoutById(wid); if (!w) return '<p class="pad">Тренировка не найдена.</p>';
  const flat = workoutGroups(w).flat(); const idx = Math.max(0, Math.min(flat.length - 1, +idxRaw || 0));
  const exId = flat[idx]; const ex = P.exercises[exId];
  if (!ex) return '<p class="pad">Упражнение не найдено.</p>';
  const n = nSets(w, exId); const arr = getSets(w.id, exId, n);
  const sess = getSession(w.id, false);
  const sec = ex.unit === 'sec'; const wt = !!ex.weighted;
  let h = `<div class="screen"><div class="top3"><a class="rbtn" href="#/w/${esc(w.id)}" data-act="back" aria-label="к списку">${ic('back')}</a>
    ${ringHTML(ex, exFrac(w, exId), 84)}
    <div class="rt"><button class="rbtn" data-act="resttimer" aria-label="таймер отдыха">${ic('timer')}</button><button class="rbtn" data-act="panel" data-k="settings" aria-label="настройки">${ic('sliders')}</button></div></div>
    <h1 class="exname">${esc(ex.name)}</h1><div class="exsub">${esc(ex.muscles)}</div>
    <div class="trio"><button class="${panel === 'tech' ? 'on' : ''}" data-act="panel" data-k="tech">${ic('play')}<span>Техника</span></button>
      <button class="${panel === 'hist' ? 'on' : ''}" data-act="panel" data-k="hist">${ic('history')}<span>История</span></button>
      <button class="${panel === 'swap' ? 'on' : ''}" data-act="panel" data-k="swap">${ic('swap')}<span>Заменить</span></button></div>`;
  if (panel === 'settings') h += settingsPanel(w);
  if (panel === 'tech') h += `<div class="panel">${videoHTML(ex)}${tipsHTML(ex)}</div>`;
  if (panel === 'hist') {
    const rows = [];
    Object.keys(DB.logs).sort().reverse().forEach((d) => Object.values(DB.logs[d]).forEach((s) => {
      const a = s.sets && s.sets[exId];
      if (a && a.some((x) => x.done)) rows.push(`<tr><td>${shortDate(d)}</td><td>${a.filter((x) => x.done).map((x) => kgPre(exId, x.kg) + x.reps).join(', ')}${sec ? ' сек' : ''}</td></tr>`);
    }));
    h += `<div class="panel"><h3>История</h3>${rows.length ? `<table>${rows.slice(0, 15).join('')}</table>` : '<p class="muted">Пока записей нет. Они появятся после первых отмеченных подходов.</p>'}</div>`;
  }
  if (panel === 'swap') {
    const inW = new Set(flat);
    const opts = Object.entries(P.exercises).filter(([id]) => !inW.has(id));
    const orig = Object.keys(swapsOf(w)).find((k) => swapsOf(w)[k] === exId);
    h += `<div class="panel"><h3>Заменить упражнение</h3>${opts.map(([id, e]) => `<button class="opt" data-act="swapto" data-id="${esc(id)}" data-cur="${esc(exId)}">${ringHTML(e, 0, 34)}<span class="grow"><b>${esc(e.name)}</b><small>${esc(e.muscles)}</small></span></button>`).join('') || '<p class="muted">Других упражнений пока нет.</p>'}
      ${orig ? `<button class="opt" data-act="swapback" data-orig="${esc(orig)}"><span class="grow"><b>Вернуть «${esc((P.exercises[orig] || {}).name || orig)}»</b></span></button>` : ''}</div>`;
  }
  h += `<div class="cols">${wt ? `<span>${baseOf(exId) ? 'Блины' : 'Вес'}</span>` : ''}<span>${sec ? 'Секунды' : 'Повторения'}</span></div>`;
  if (baseOf(exId)) h += `<p class="muted small" style="margin:0 6px 8px">Вводи только вес блинов: ${esc(ex.baseNote)} прибавится сам${exId === 'rdl' || exId === 'row' ? '. Блины считай всего на грифе' : (ex.hands > 1 ? '. Блины на одной гантели, вторая такая же' : '. Вес блинов на гантели')}.</p>`;
  const R = wt ? recFor(exId) : null;
  if (R) h += `<div class="rec"><b>Рекомендация: ${fmtKgNum(R.plates)}${baseOf(exId) ? ' на блинах' : ' кг'}</b> · всего ${fmtKgNum(R.total)} кг ${R.tail}<small>${esc(R.why)}</small></div>`;
  h += '<div class="srows">' + arr.map((s, i) => setRow(w.id, exId, i, s, ex)).join('') + '</div>';
  h += `<button class="addset" data-act="addset" data-w="${esc(w.id)}" data-e="${esc(exId)}"><span class="rbtn">${ic('plus')}</span><b>Ещё подход</b></button>`;
  const note = (sess && sess.notes && sess.notes[exId]) || '';
  h += `<textarea class="note" rows="3" placeholder="Оставить заметку…" data-w="${esc(w.id)}" data-e="${esc(exId)}">${esc(note)}</textarea></div>`;
  // нижняя полоса
  const prev = idx > 0 ? `#/w/${esc(w.id)}/${idx - 1}` : `#/w/${esc(w.id)}`;
  const nx = flat[idx + 1] && P.exercises[flat[idx + 1]];
  const fin = sess && sess.finished;
  h += `<div class="botbar"><a class="rbtn" href="${prev}" aria-label="назад">${ic(idx > 0 ? 'prev' : 'list')}</a>`;
  if (nx) h += `<a class="nextp" href="#/w/${esc(w.id)}/${idx + 1}">${ringHTML(nx, 0, 34)}<span class="grow"><b>${esc(nx.name)}</b><small>Далее</small></span>${ic('next')}</a>`;
  else h += `<button class="nextp lime" data-act="finish" data-w="${esc(w.id)}"><span class="grow"><b>${fin ? 'День закончен ✓' : 'Закончить день'}</b><small>последнее упражнение</small></span>${ic('check')}</button>`;
  return h + '</div>';
}

function viewExercise(id) {
  const ex = P.exercises[id];
  if (!ex) return '<p class="pad">Упражнение не найдено.</p>';
  let h = `<a href="#/lib" data-act="back">← Назад</a><div class="center">${ringHTML(ex, 0, 84)}</div><h1 class="exname">${esc(ex.name)}</h1><div class="exsub">${esc(ex.muscles)} · ${esc(ex.target)}</div>
    ${videoHTML(ex)}<div class="card">${tipsHTML(ex)}</div>`;
  const rows = [];
  Object.keys(DB.logs).sort().reverse().forEach((d) => Object.values(DB.logs[d]).forEach((s) => {
    const arr = s.sets && s.sets[id];
    if (arr && arr.some((x) => x.done)) rows.push(`<tr><td>${shortDate(d)}</td><td>${arr.filter((x) => x.done).map((x) => kgPre(id, x.kg) + x.reps).join(', ')}</td></tr>`);
  }));
  if (rows.length) h += `<h2>История</h2><div class="card"><table>${rows.slice(0, 15).join('')}</table></div>`;
  return h;
}

function viewFood() {
  const tabs = [['menu', 'Меню'], ['protein', 'Белок'], ['recipes', 'Рецепты'], ['shop', 'Покупки'], ['rules', 'Правила']];
  let h = `<h1>Питание</h1><div class="tabs">${tabs.map(([k, t]) => `<button data-act="ftab" data-k="${k}" class="${foodTab === k ? 'on' : ''}">${t}</button>`).join('')}</div>`;
  const wd = new Date().getDay();
  if (foodTab === 'menu') {
    const t = N.targets;
    h += `<div class="card"><h3>Цели на день</h3><table><tr><th>Калории</th><td>~${esc(t.kcal)} ккал</td></tr>
      <tr><th>Белок</th><td>${esc(t.protein)}</td></tr><tr><th>Баланс</th><td>${esc(t.split)}</td></tr>
      <tr><th>Вода</th><td>${esc(t.water)}</td></tr></table><p class="muted small">${esc(t.note)}</p></div>`;
    const cw = cycleWeek(), fw = foodWeek || cw;
    h += `<div class="tabs">${[1, 2].map((k) => `<button data-act="fweek" data-k="${k}" class="${fw === k ? 'on' : ''}">Неделя ${k}${cw === k ? ' · сейчас' : ''}</button>`).join('')}</div>`;
    N.menu.filter((m) => m.week === 0 || m.week === fw).forEach((m) => {
      const today = fw === cw && [].concat(m.weekday).includes(wd);
      h += `<div class="card ${today ? 'accent' : ''}"><div class="row between"><h3>${esc(m.day)}</h3><span class="tag ${today ? 'acc' : ''}">${today ? 'сегодня · ' : ''}${esc(m.kcal)} ккал · ${esc(m.protein)}</span></div>
        <table>${m.meals.map(([a, b]) => `<tr><th>${esc(a)}</th><td>${esc(b)}</td></tr>`).join('')}</table></div>`;
    });
  } else if (foodTab === 'protein') {
    h += `<div class="card"><table><tr><th>Продукт</th><th>Белок, г</th><th>ккал</th></tr>${N.protein.map((p) =>
      `<tr><td>${esc(p.food)}<div class="muted small">${esc(p.src)}</div></td><td>${esc(p.protein)}</td><td>${esc(p.kcal)}</td></tr>`).join('')}</table></div>
      <p class="muted small">Значения с пометкой «типовое» или «оценка» приблизительные. Точные цифры смотри на этикетке.</p>`;
  } else if (foodTab === 'recipes') {
    h += `<div class="card accent"><h3>${esc(N.tasty.title)}</h3><ul class="tips">${N.tasty.items.map((i) => `<li>${esc(i)}</li>`).join('')}</ul></div>`;
    N.recipes.forEach((r) => {
      h += `<details class="card"><summary><b>${esc(r.title)}</b></summary><p class="muted small">${esc(r.note)}</p>
        ${r.ingredients.length ? `<h3>Продукты</h3><ul class="tips">${r.ingredients.map((i) => `<li>${esc(i)}</li>`).join('')}</ul>` : ''}
        <h3>Как делать</h3><ol class="tips">${r.steps.map((i) => `<li>${esc(i)}</li>`).join('')}</ol></details>`;
    });
  } else if (foodTab === 'shop') {
    const done = N.shopping.filter((s) => DB.shop[s.id]).length;
    h += `<div class="card"><div class="row between"><h3>Список покупок</h3><span class="muted">${done} / ${N.shopping.length}</span></div>
      ${N.shopping.map((s) => `<label class="check ${DB.shop[s.id] ? 'on' : ''}"><input type="checkbox" data-act="shop" data-id="${esc(s.id)}" ${DB.shop[s.id] ? 'checked' : ''}><span>${esc(s.text)}</span>${s.url ? `<a class="ext" href="${esc(s.url)}" target="_blank" rel="noopener">Devoto</a>` : ''}</label>`).join('')}
      <button class="ghost block" style="margin-top:10px" data-act="shopreset">Снять все отметки</button></div>`;
  } else {
    h += `<div class="card"><ul class="tips">${N.rules.map((r) => `<li>${esc(r)}</li>`).join('')}</ul></div>`;
  }
  return h;
}

function lineChart(points, unit) {
  if (points.length < 2) return '<p class="muted small">График появится после двух замеров.</p>';
  const W = 320, H = 150, L = 34, B = 20, R = 10, Tp = 10;
  const ys = points.map((p) => p.v); let lo = Math.min(...ys), hi = Math.max(...ys);
  if (hi - lo < 1) { hi += 0.5; lo -= 0.5; }
  const x = (i) => L + (W - L - R) * (points.length === 1 ? 0 : i / (points.length - 1));
  const y = (v) => Tp + (H - Tp - B) * (1 - (v - lo) / (hi - lo));
  const path = points.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.v).toFixed(1)}`).join(' ');
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="график">
    <line x1="${L}" y1="${Tp}" x2="${L}" y2="${H - B}" stroke="#2a2f3a"/><line x1="${L}" y1="${H - B}" x2="${W - R}" y2="${H - B}" stroke="#2a2f3a"/>
    <text x="2" y="${Tp + 8}" fill="#9aa3b2" font-size="10">${hi.toFixed(1)}</text><text x="2" y="${H - B}" fill="#9aa3b2" font-size="10">${lo.toFixed(1)}</text>
    <path d="${path}" fill="none" stroke="#ff9f43" stroke-width="2.5"/>
    ${points.map((p, i) => `<circle cx="${x(i).toFixed(1)}" cy="${y(p.v).toFixed(1)}" r="3.5" fill="#ff9f43"/>`).join('')}
    <text x="${L}" y="${H - 5}" fill="#9aa3b2" font-size="10">${shortDate(points[0].d)}</text>
    <text x="${W - R}" y="${H - 5}" fill="#9aa3b2" font-size="10" text-anchor="end">${shortDate(points[points.length - 1].d)}</text></svg><div class="muted small">${esc(unit)}</div>`;
}

const MFIELDS = [['waist', 'Талия (пупок)'], ['belly', 'Низ живота'], ['chest', 'Грудь'], ['shoulders', 'Плечи'], ['arm', 'Бицепс'], ['hips', 'Бёдра'], ['thigh', 'Бедро правое'], ['thighL', 'Бедро левое']];
const CFIELDS = [['weight', 'Вес, кг'], ['muscle', 'Мышцы, кг'], ['fat', 'Жир, %'], ['bmr', 'Обмен, ккал']];
const ALLF = MFIELDS.map(([k, t]) => [k, t, 'см']).concat(CFIELDS.map(([k, t]) => [k, t.split(',')[0], t.split(', ')[1]]));

function viewBody() {
  const ms = [...DB.measures].sort((a, b) => (a.date < b.date ? -1 : 1));
  const first = (k) => ms.find((m) => m[k] != null), last = (k) => [...ms].reverse().find((m) => m[k] != null);
  let h = `<a href="#/progress" data-act="back">← Назад</a><h1>Замеры</h1>`;
  const rows = ALLF.map(([k, t, u]) => {
    const a = first(k), b = last(k); if (!a) return '';
    const d = a === b ? null : Math.round((b[k] - a[k]) * 10) / 10;
    const dd = d == null ? '' : `<span class="${d < 0 ? 'dn' : d > 0 ? 'up' : ''}">${d > 0 ? '+' : ''}${String(d).replace('.', ',')}</span>`;
    return `<tr><td>${esc(t)}</td><td>${String(a[k]).replace('.', ',')}</td><td>${a === b ? '—' : String(b[k]).replace('.', ',')}</td><td>${dd}</td></tr>`;
  }).join('');
  h += `<div class="card"><h3>Было → стало</h3><table><tr><th></th><th>Старт</th><th>Сейчас</th><th>Разница</th></tr>${rows}</table>
    <p class="muted small">Часы дают приблизительные цифры: смотри тренд, а не один замер. Фото тела лежат на сервере (папка photos).</p></div>`;
  const wp = ms.filter((m) => m.waist != null).map((m) => ({ d: m.date, v: m.waist }));
  h += `<div class="card"><h3>Талия на уровне пупка</h3>${lineChart(wp, 'см')}</div>`;
  if (BODY && BODY.checkpoints) {
    const td = dateStr(); const nx = BODY.checkpoints.find((c) => c.date >= td);
    h += `<div class="card ${nx ? 'accent' : ''}"><h3>Контрольные точки</h3><table>${BODY.checkpoints.map((c) =>
      `<tr><td>${c.week ? 'Неделя ' + c.week : 'Старт'}</td><td>${shortDate(c.date)}</td><td>${esc(c.what)}${nx === c ? ' · ближайшая' : ''}</td></tr>`).join('')}</table>
      <p class="muted small">${esc(BODY.checkTodo || '')}</p></div>`;
  }
  h += `<div class="card"><h3>Новый замер</h3><p class="muted small">Талию мерь утром, натощак, на уровне пупка, на выдохе. Заполни только то, что измерил.</p>
    <label class="f">Дата</label><input type="date" id="m-date" value="${dateStr()}">
    <div class="grid2">${ALLF.map(([k, t, u]) => `<div><label class="f">${esc(t)}${u ? ', ' + esc(u) : ''}</label><input type="text" inputmode="decimal" id="m-${k}" placeholder="${esc(u)}"></div>`).join('')}</div>
    <button class="primary block" style="margin-top:12px" data-act="msave">Сохранить замер</button></div>`;
  const hist = [...ms].reverse();
  h += `<div class="card"><h3>История замеров</h3>${hist.map((m) => {
    const parts = ALLF.filter(([k]) => m[k] != null).map(([k, t, u]) => `${esc(t)} <b>${String(m[k]).replace('.', ',')}</b>`);
    const isBase = String(m.id).startsWith('base-');
    return `<div class="mrow"><div class="row between"><b>${shortDate(m.date)}${isBase ? ' · старт' : ''}</b>${isBase ? '' : `<button class="ghost danger" style="padding:4px 8px" data-act="mdel" data-id="${esc(m.id)}">×</button>`}</div>
      <div class="small">${parts.join(' · ')}</div>${m.src ? `<div class="muted small">${esc(m.src)}</div>` : ''}</div>`;
  }).join('')}</div>`;
  return h;
}

function viewProgress() {
  let h = `<div class="row between"><h1>Прогресс</h1><a class="btn" href="#/report">PDF</a></div>
    <div class="card"><h3>Отправить Claude</h3><p class="muted small">Одним нажатием: выбери в меню «Поделиться» приложение Claude, и журнал (подходы, время, замеры) придёт в чат.</p>
    <button class="primary block" data-act="sharetext">Отправить журнал в чат</button>
    <button class="block" style="margin-top:8px" data-act="sharefile">Поделиться файлом данных</button></div>`;
  const lw = lastMeasure('waist');
  h += `<a class="card" style="display:flex;justify-content:space-between;align-items:center;color:inherit;text-decoration:none" href="#/body"><div><b>Замеры тела</b><div class="muted small">${lw ? 'Талия ' + String(lw.v).replace('.', ',') + ' см · ' + shortDate(lw.d) : 'Талия, вес, мышцы, жир'}</div></div><span class="chev">›</span></a>`;
  // история тренировок
  const hist = [];
  Object.keys(DB.logs).sort().reverse().forEach((d) => Object.entries(DB.logs[d]).forEach(([wid, s]) => {
    const dc = doneCount(s); if (!dc) return;
    const w = workoutById(wid); let total = 0;
    if (w) w.items.forEach((e) => { total += setsCount(w, e); });
    const secs = sessionSeconds(s); hist.push(`<tr><td>${shortDate(d)}</td><td>${esc(w ? w.title : wid)}</td><td>${dc}${total ? ' / ' + total : ''}</td><td>${secs && s.finished ? fmtLong(secs) : ''}</td><td><button class="ghost" style="padding:4px 8px" data-act="story" data-w="${esc(wid)}" data-d="${esc(d)}" aria-label="картинка для сторис">▶</button></td></tr>`);
  }));
  h += `<div class="card"><h3>История тренировок</h3>${hist.length ? `<table><tr><th>Дата</th><th>Тренировка</th><th>Подходов</th><th>Время</th><th></th></tr>${hist.join('')}</table>` : '<p class="muted small">Пока пусто: сделай первую тренировку.</p>'}</div>`;
  // рекорды
  const best = {};
  Object.values(DB.logs).forEach((day) => Object.values(day).forEach((s) => Object.entries(s.sets || {}).forEach(([e, arr]) => arr.forEach((x) => {
    if (!x.done) return; const kg = num(x.kg) || 0, reps = num(x.reps) || 0; const b = best[e];
    if (!b || kg > b.kg || (kg === b.kg && reps > b.reps)) best[e] = { kg, reps };
  }))));
  const bk = Object.keys(best);
  if (bk.length) {
    h += `<div class="card"><h3>Лучшие результаты</h3><table>${bk.map((e) => {
      const ex = P.exercises[e]; const b = best[e]; if (!ex) return '';
      return `<tr><td>${esc(ex.name)}</td><td>${kgPre(e, b.kg)}${b.reps} ${ex.unit === 'sec' ? 'сек' : 'повт.'}</td></tr>`;
    }).join('')}</table></div>`;
  }
  return h;
}

function viewReport() {
  let h = `<div class="noprint"><a href="#/progress" data-act="back">← Назад</a>
    <div class="card"><p class="muted small">Это печатная версия: программа тренировок и твой журнал. Нажми кнопку и выбери «Сохранить как PDF» (на Android в окне печати вверху выбери «Сохранить как PDF»).</p>
    <button class="primary block" data-act="print">Сохранить в PDF</button></div></div>`;
  h += `<h1>Тренировки: программа и журнал</h1><p class="muted small">Создано ${shortDate(dateStr())}. Цель: рекомпозиция тела, талия и сила.</p><h2>Программа</h2>`;
  (P.workouts || []).forEach((w) => {
    h += `<div class="card"><h3>${esc(w.title)} · ${esc(w.when)}</h3><p class="small">${esc(w.description)}</p>`;
    if (w.warmup) h += `<p class="small"><b>Разминка:</b> ${esc(w.warmup)}</p>`;
    if (w.items.length) {
      h += `<table><tr><th>Упражнение</th><th>Подходы</th><th>Мышцы</th></tr>${w.items.map((id) => {
        const ex = P.exercises[id]; return ex ? `<tr><td>${esc(ex.name)}</td><td>${setsCount(w, id)} × ${esc(ex.target)}</td><td>${esc(ex.muscles)}</td></tr>` : '';
      }).join('')}</table>`;
      if (Array.isArray(w.groups) && w.groups.length) {
        h += `<p class="small"><b>Сплит (пары подряд):</b> ${w.groups.map((g) => g.map((id) => P.exercises[id] ? P.exercises[id].name : id).join(' + ')).join('; ')}.</p>`;
      }
    }
    h += '</div>';
  });
  h += '<h2>Техника выполнения</h2>';
  Object.values(P.exercises).forEach((ex) => {
    h += `<div class="card"><h3>${esc(ex.name)}</h3><ul class="tips small">${ex.tips.map((t) => `<li>${esc(t)}</li>`).join('')}</ul></div>`;
  });
  h += '<h2>Журнал</h2>';
  const days = Object.keys(DB.logs).sort().reverse(); let any = false;
  days.forEach((d) => Object.entries(DB.logs[d]).forEach(([wid, s]) => {
    if (!doneCount(s)) return; any = true;
    const w = workoutById(wid); const secs = sessionSeconds(s);
    h += `<div class="card"><h3>${shortDate(d)} · ${esc(w ? w.title : wid)}${s.finished && secs ? ' · ' + fmtLong(secs) : ''}</h3><table><tr><th>Упражнение</th><th>Подходы</th></tr>${Object.entries(s.sets).filter(([, a]) => a.some((x) => x.done)).map(([e, a]) => {
      const ex = P.exercises[e];
      return `<tr><td>${esc(ex ? ex.name : e)}</td><td>${a.filter((x) => x.done).map((x) => kgPre(e, x.kg) + x.reps).join(', ')}</td></tr>`;
    }).join('')}</table></div>`;
  }));
  if (!any) h += '<p class="muted small">Записей пока нет.</p>';
  if (DB.measures.length) {
    const rows = [...DB.measures].sort((a, b) => (a.date < b.date ? 1 : -1));
    h += `<h2>Замеры, см</h2><div class="card"><table><tr><th>Дата</th>${MFIELDS.map(([, t]) => `<th>${esc(t.split(' ')[0])}</th>`).join('')}</tr>${rows.map((m) =>
      `<tr><td>${shortDate(m.date)}</td>${MFIELDS.map(([k]) => `<td>${m[k] != null ? m[k] : ''}</td>`).join('')}</tr>`).join('')}</table></div>`;
  }
  return h;
}

function viewMore() {
  const ts = (k) => esc(localStorage.getItem(k) || '');
  return `<h1>Ещё</h1>
  <a class="card" style="display:flex;justify-content:space-between;color:inherit;text-decoration:none" href="#/lib"><b>Библиотека упражнений</b><span class="chev">›</span></a>
  <div class="card"><h3>Обновления</h3><p class="muted small">Тренировки, питание и видео подтягиваются из репозитория автоматически при открытии приложения. Пересобирать и переустанавливать ничего не нужно.</p>
    <p>Версия контента: <b>${esc(P.version)}</b> от ${esc(P.updated)}<br>Питание: <b>${esc(N.version)}</b> от ${esc(N.updated)}</p>
    <button class="block" data-act="update">Проверить обновления</button></div>
  <div class="card"><h3>Офлайн</h3><p class="muted small">Видео сохраняются на телефоне при первом просмотре. Можно скачать все сразу, пока есть Wi‑Fi.</p>
    <button class="block" data-act="offline">Скачать все видео</button><p class="muted small" id="off-status"></p></div>
  <div class="card"><h3>Установка на телефон</h3>${installEvt ? '<button class="primary block" data-act="install">Установить приложение</button>' : ''}
    <p class="muted small">Chrome на Android: меню ⋮ → «Установить приложение» (или «Добавить на главный экран»). После этого иконка «Фитнес» появится среди приложений.</p></div>
  <div class="card"><h3>Копия на сервере</h3><p class="muted small">Журнал сам сохраняется в твой закрытый репозиторий на GitHub: после тренировки и при выходе из приложения. Если приложение удалят, записи вернутся. Ничего не стирается: версии дней сливаются.</p>
    <label class="f">Репозиторий (владелец/название)</label><input id="sy-repo" value="${esc((syncCfg() || {}).repo || 'maxr180022/fitness-data')}" autocapitalize="off" autocomplete="off">
    <label class="f">Токен доступа</label><input id="sy-token" type="password" placeholder="${syncCfg() ? 'сохранён, оставь пустым' : 'github_pat_…'}" autocomplete="off">
    <button class="primary block" style="margin-top:10px" data-act="syncsave">Подключить и сохранить</button>
    <button class="block" style="margin-top:8px" data-act="syncnow">Сохранить сейчас</button>
    <p class="muted small" id="sync-status">${esc(syncStatText())}</p></div>
  <div class="card"><h3>Резервная копия</h3><p class="muted small">Подходы, замеры и отметки хранятся только на этом телефоне. Сохрани копию, чтобы не потерять данные при смене телефона или очистке браузера.</p>
    <button class="block" data-act="export">Скачать копию данных</button>
    <label class="f">Восстановить из файла</label><input type="file" id="imp" accept="application/json,.json"></div>
  <div class="card"><h3>Сброс</h3><button class="danger block" data-act="reset">Удалить все мои данные</button></div>`;
}

/* ---------- роутер ---------- */
function render(keepScroll) {
  const app = $('#app');
  const h = location.hash || '#/';
  const parts = h.replace(/^#\/?/, '').split('/');
  const r = parts[0] || '', a = parts[1];
  let html = '', tab = 'today';
  const rk = parts.slice(0, 3).join('/');
  if (rk !== lastRoute) { panel = null; lastRoute = rk; }
  document.body.dataset.r = r === 'train' ? 'w' : r;
  try {
    if (r === '') html = viewToday();
    else if (r === 'train') { const dw = defaultWorkout(); html = dw ? viewWorkout(dw.id) : viewToday(); tab = 'train'; }
    else if (r === 'w') { html = parts[2] !== undefined && parts[2] !== '' ? viewStep(a, parts[2]) : viewWorkout(a); tab = 'train'; }
    else if (r === 'lib') { html = viewLib(); tab = 'more'; }
    else if (r === 'ex') { html = viewExercise(a); tab = 'more'; }
    else if (r === 'food') { html = viewFood(); tab = 'food'; }
    else if (r === 'progress') { html = viewProgress(); tab = 'progress'; }
    else if (r === 'body') { html = viewBody(); tab = 'progress'; }
    else if (r === 'more') { html = viewMore(); tab = 'more'; }
    else if (r === 'report') { html = viewReport(); tab = 'progress'; }
    else html = viewToday();
  } catch (e) {
    html = `<p class="pad">Ошибка отображения: ${esc(e.message)}</p>`;
  }
  const y = window.scrollY;
  app.innerHTML = html;
  $$('#nav a').forEach((el) => el.classList.toggle('on', el.dataset.tab === tab));
  if (keepScroll) window.scrollTo(0, y); else window.scrollTo(0, 0);
  if (r === 'w') keepAwake(true); else keepAwake(false);
}
async function keepAwake(on) {
  try {
    if (on && 'wakeLock' in navigator && !wakeLock) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    } else if (!on && wakeLock) { await wakeLock.release(); wakeLock = null; }
  } catch (e) { /* не критично */ }
}

/* ---------- после подхода: сплит, отдых, таймер внутри строки ---------- */
function afterSet(wid, exId, i) {
  const wk = workoutById(wid), ex = P.exercises[exId]; if (!wk || !ex) return;
  const groups = workoutGroups(wk); const flat = groups.flat();
  const g = groups.find((x) => x.includes(exId)) || [exId];
  const pos = g.indexOf(exId); const split = g.length > 1;
  const hasRest = (wk.rounds || wk.restBetween) && ex.rest > 0;
  const undone = (id) => getSets(wid, id, nSets(wk, id)).findIndex((x) => !x.done);
  let go = null;
  if (split) {
    if (pos < g.length - 1) {
      const nx = g[pos + 1]; const a = getSets(wid, nx, nSets(wk, nx));
      if (a[i] && !a[i].done) { toast(`Дальше без отдыха: ${P.exercises[nx].name}`); go = flat.indexOf(nx); }
    } else {
      if (hasRest) startTimer(Math.max(...g.map((x) => P.exercises[x].rest || 0)), 'Отдых после пары');
      const first = g.find((id) => undone(id) >= 0);
      if (first) go = flat.indexOf(first);
      else { const nxt = flat.indexOf(exId) + 1; go = nxt < flat.length ? nxt : 'list'; if (go === 'list') toast('Все подходы сделаны. Можно завершать'); }
    }
  } else if (hasRest) startTimer(ex.rest, 'Отдых после: ' + ex.name);
  if (go != null && go !== -1) {
    setTimeout(() => { if (location.hash.startsWith('#/w/' + wid + '/')) location.hash = go === 'list' ? '#/w/' + wid : `#/w/${wid}/${go}`; }, 650);
  }
}
function startRowTimer(row) {
  if (RT) { stopRowTimer(true); return; }
  const { w, e: exId } = row.dataset; const i = +row.dataset.i; const ex = P.exercises[exId];
  const total = num($('input[data-f="reps"]', row).value) || ex.def;
  startSession(w);
  RT = { w, exId, i, total, end: Date.now() + total * 1000, iv: setInterval(rowTick, 250) };
  rowTick();
}
function rowTick() {
  if (!RT) return;
  const left = Math.ceil((RT.end - Date.now()) / 1000);
  const row = $(`.srow[data-w="${RT.w}"][data-e="${RT.exId}"][data-i="${RT.i}"]`);
  if (row) { row.classList.add('run'); const cd = $('.cd', row); if (cd) cd.textContent = fmtTime(Math.max(0, left)); }
  if (left <= 0) stopRowTimer(false);
}
function stopRowTimer(early) {
  const r = RT; if (!r) return; clearInterval(r.iv); RT = null;
  const secs = early ? Math.max(1, Math.round(r.total - (r.end - Date.now()) / 1000)) : r.total;
  const wk = workoutById(r.w); const arr = getSets(r.w, r.exId, nSets(wk, r.exId));
  arr[r.i].reps = String(secs); arr[r.i].done = true; startSession(r.w).lastAt = Date.now(); save(); beep(); render(true);
  afterSet(r.w, r.exId, r.i);
}

/* ---------- события ---------- */
document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-act]'); if (!el) return;
  const act = el.dataset.act;
  if (act === 'back') { e.preventDefault(); goUp(); return; }
  if (act === 'chk') {
    const row = el.closest('.srow'); const { w, e: exId } = row.dataset; const i = +row.dataset.i;
    const ex = P.exercises[exId]; const wk = workoutById(w);
    const arr = getSets(w, exId, nSets(wk, exId)); const s = arr[i];
    s.done = !s.done;
    if (s.done && !String(s.reps).trim()) s.reps = String(ex.def);
    if (s.done) { startSession(w).lastAt = Date.now(); }
    save(); render(true);
    if (s.done) afterSet(w, exId, i);
    return;
  }
  if (act === 'wstart') { startSession(el.dataset.w); location.hash = `#/w/${el.dataset.w}/0`; return; }
  if (act === 'splitmode') { DB.settings.split = !DB.settings.split; save(); render(true); return; }
  if (act === 'panel') { panel = panel === el.dataset.k ? null : el.dataset.k; render(true); return; }
  if (act === 'resttimer') {
    if (T) { stopTimer(); return; }
    const m = location.hash.match(/#\/w\/([^/]+)\/(\d+)/); const wk = m && workoutById(m[1]);
    const exId = wk ? workoutGroups(wk).flat()[+m[2]] : null;
    const ex = exId && P.exercises[exId];
    startTimer((ex && ex.rest) || 60, 'Отдых'); return;
  }
  if (act === 'addset') {
    const s = getSession(el.dataset.w, true); s.extra = s.extra || {}; s.extra[el.dataset.e] = (s.extra[el.dataset.e] || 0) + 1;
    save(); render(true); return;
  }
  if (act === 'swapto' || act === 'swapback') {
    const m = location.hash.match(/#\/w\/([^/]+)\//); const wk = m && workoutById(m[1]); if (!wk) return;
    DB.settings.swaps = DB.settings.swaps || {}; const sw = (DB.settings.swaps[wk.id] = DB.settings.swaps[wk.id] || {});
    if (act === 'swapto') { const orig = Object.keys(sw).find((k) => sw[k] === el.dataset.cur) || el.dataset.cur; sw[orig] = el.dataset.id; }
    else delete sw[el.dataset.orig];
    panel = null; save(); render(true); toast('Упражнение заменено'); return;
  }
  if (act === 'tm') { e.preventDefault(); startRowTimer(el.closest('.srow')); return; }
  if (act === 'finish') {
    const s = getSession(el.dataset.w, true);
    if (!s.finished) {
      const now = Date.now();
      // если последний подход был давно, конец тренировки = время последнего подхода, а не нажатия кнопки
      const end = s.lastAt && now - s.lastAt > 10 * 60 * 1000 ? s.lastAt : now;
      s.finished = true; s.endedAt = end;
      s.durationSec = s.startedAt ? Math.max(0, Math.round((end - s.startedAt) / 1000)) : null;
      stopTimer(); save(); scheduleSync(1500);
      toast(s.durationSec ? `День закончен: ${fmtLong(s.durationSec)}, подходов ${doneCount(s)}. Хорошая работа! Внизу кнопка для сторис` : `День закончен, подходов ${doneCount(s)}. Хорошая работа! Внизу кнопка для сторис`);
    } else { s.finished = false; s.endedAt = null; s.durationSec = null; save(); toast('Отметка снята, день снова открыт'); }
    render(true); return;
  }
  if (act === 't+') { if (T) T.end += 15000; return; }
  if (act === 'tstop') { stopTimer(); return; }
  if (act === 'water') {
    const d = dateStr(); DB.water[d] = Math.max(0, (DB.water[d] || 0) + parseInt(el.dataset.ml, 10)); save(); render(true); return;
  }
  if (act === 'fweek') { foodWeek = +el.dataset.k; render(true); return; }
  if (act === 'ftab') { foodTab = el.dataset.k; render(true); return; }
  if (act === 'shop') { DB.shop[el.dataset.id] = el.checked; save(); render(true); return; }
  if (act === 'shopreset') { DB.shop = {}; save(); render(true); return; }
  if (act === 'msave') {
    const m = { id: String(Date.now()), date: $('#m-date').value || dateStr() }; let any = false;
    ALLF.forEach(([k]) => { const v = num($('#m-' + k).value); if (v != null) { m[k] = v; any = true; } });
    if (!any) { toast('Введи хотя бы одно значение'); return; }
    DB.measures.push(m); save(); toast('Замер сохранён'); render(true); return;
  }
  if (act === 'mdel') { DB.measures = DB.measures.filter((m) => m.id !== el.dataset.id); save(); render(true); return; }
  if (act === 'update') { checkUpdates(true); return; }
  if (act === 'offline') { downloadAll(); return; }
  if (act === 'install') { if (installEvt) { installEvt.prompt(); installEvt = null; } return; }
  if (act === 'export') { exportData(); return; }
  if (act === 'print') { window.print(); return; }
  if (act === 'sharetext') { shareText(); return; }
  if (act === 'syncnow') { syncNow(true); return; }
  if (act === 'syncsave') {
    const old = syncCfg() || {}, repo = ($('#sy-repo').value || 'maxr180022/fitness-data').trim().replace(/^https?:\/\/github\.com\//, '').replace(/\.git$/, '').replace(/\/$/, ''), token = ($('#sy-token').value || '').trim() || old.token;
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) { toast('Репозиторий вида владелец/название'); return; }
    if (!token) { toast('Вставь токен'); return; }
    localStorage.setItem(SYNC_KEY, JSON.stringify({ repo, token })); $('#sy-token').value = ''; syncNow(true); return;
  }
  if (act === 'story') { openStory(el.dataset.w, el.dataset.d); return; }
  if (act === 'storyshare') { shareStory(); return; }
  if (act === 'storysave') { saveStory(); return; }
  if (act === 'storyclose') { closeStory(); return; }
  if (act === 'sharefile') { shareFile(); return; }
  if (act === 'reset') {
    if (confirm('Удалить все подходы, замеры и отметки на этом телефоне? Если подключена копия на сервере, записи оттуда вернутся.')) { DB = blank(); save(); toast('Данные удалены'); render(); }
  }
});
// чекбоксы списка покупок срабатывают как click по input
document.addEventListener('input', (e) => {
  const inp = e.target; if (!inp.matches) return;
  if (inp.matches('.srow input')) {
    const row = inp.closest('.srow'); const { w, e: exId } = row.dataset; const wk = workoutById(w);
    const arr = getSets(w, exId, nSets(wk, exId)); arr[+row.dataset.i][inp.dataset.f] = inp.value; save();
  } else if (inp.matches('textarea.note')) {
    const s = getSession(inp.dataset.w, true); s.notes = s.notes || {}; s.notes[inp.dataset.e] = inp.value; save();
  }
});
document.addEventListener('change', (e) => {
  if (e.target.id === 'imp') importData(e.target.files[0]);
});
window.addEventListener('hashchange', () => render(false));
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installEvt = e; });
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') checkUpdates(false);
});

/* ---------- обновления, офлайн, бэкап ---------- */
async function checkUpdates(manual) {
  try {
    if (swReg) swReg.update().catch(() => {});
    const changed = await loadContent();
    if (changed) {
      const busy = document.activeElement && /INPUT|TEXTAREA/.test(document.activeElement.tagName);
      if (!busy) render(true);
      toast('Контент обновлён');
    } else if (manual) toast('У тебя последняя версия');
  } catch (e) { if (manual) toast('Нет сети, обновить не удалось'); }
}
async function downloadAll() {
  const st = $('#off-status'); const vids = Object.values(P.exercises).map((x) => x.video).filter(Boolean);
  let ok = 0;
  for (const v of vids) {
    try { const r = await fetch(v); if (r.ok) { await r.arrayBuffer(); ok++; } } catch (e) { /* пропуск */ }
    if (st) st.textContent = `Скачано ${ok} из ${vids.length}`;
  }
  toast(ok === vids.length ? 'Все видео сохранены на телефоне' : 'Часть видео скачать не удалось');
}
function journalText() {
  const lines = [`Журнал тренировок (${shortDate(dateStr())})`];
  Object.keys(DB.logs).sort().reverse().slice(0, 14).forEach((d) => Object.entries(DB.logs[d]).forEach(([wid, s]) => {
    if (!doneCount(s)) return;
    const w = workoutById(wid); const secs = sessionSeconds(s);
    lines.push(`\n${shortDate(d)} · ${w ? w.title : wid}${s.finished && secs ? ' · ' + fmtLong(secs) : ''}`);
    Object.entries(s.sets).forEach(([e, a]) => {
      const done = a.filter((x) => x.done); if (!done.length) return;
      const ex = P.exercises[e];
      lines.push(`- ${ex ? ex.name : e}: ${done.map((x) => kgPre(e, x.kg) + x.reps).join(', ')}${ex && ex.unit === 'sec' ? ' сек' : ''}`);
    });
  }));
  const ms = [...DB.measures].sort((a, b) => (a.date < b.date ? 1 : -1)).slice(0, 8);
  if (ms.length) {
    lines.push('\nЗамеры:');
    ms.forEach((m) => lines.push(`${shortDate(m.date)}: ` + ALLF.filter(([k]) => m[k] != null).map(([k, t, u]) => `${t.toLowerCase()} ${m[k]}${u ? ' ' + u : ''}`).join(', ')));
  }
  return lines.join('\n');
}
/* ---------- картинка для сторис ---------- */
const STORY_BODY_KG = 60;   // примерный вес тела для оценки калорий
const STORY_MET = 4;        // силовая тренировка средней интенсивности
const MONTH_GEN = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
const MILESTONES = [1, 5, 10, 25, 50, 75, 100, 150, 200];
let storyUrl = null, storyBlob = null;

function storyData(wid, d) {
  const s = DB.logs[d] && DB.logs[d][wid]; if (!s || !doneCount(s)) return null;
  const w = workoutById(wid) || { title: wid, items: [] };
  const exIds = Object.keys(s.sets || {}).filter((e) => s.sets[e].some((x) => x.done));
  const pos = (e) => { const i = (w.items || []).indexOf(e); return i < 0 ? 99 : i; };
  exIds.sort((a, b) => pos(a) - pos(b));
  let volume = 0, sets = 0; const lifts = [];
  exIds.forEach((e) => {
    const ex = P.exercises[e]; if (!ex) return;
    const base = baseOf(e), wt = !!ex.weighted, sec = ex.unit === 'sec';
    let best = null; const allReps = [];
    s.sets[e].filter((x) => x.done).forEach((x) => {
      sets++; allReps.push(num(x.reps) || 0);
      const reps = num(x.reps) || 0, kg = (num(x.kg) || 0) + (wt ? base : 0);
      if (wt && kg > 0) volume += kg * reps * (ex.hands || 1);
      const cur = { kg: wt ? kg : 0, reps };
      if (!best || cur.kg > best.kg || (cur.kg === best.kg && cur.reps > best.reps)) best = cur;
    });
    // рекорд: лучше всего, что было в прошлые дни
    let prev = null;
    Object.keys(DB.logs).filter((dd) => dd < d).forEach((dd) => Object.values(DB.logs[dd]).forEach((ss) => {
      ((ss.sets && ss.sets[e]) || []).forEach((x) => {
        if (!x.done) return;
        const cur = { kg: wt ? (num(x.kg) || 0) + base : 0, reps: num(x.reps) || 0 };
        if (!prev || cur.kg > prev.kg || (cur.kg === prev.kg && cur.reps > prev.reps)) prev = cur;
      });
    }));
    const record = !!(prev && best && (best.kg > prev.kg || (best.kg === prev.kg && best.reps > prev.reps)));
    lifts.push({ name: ex.name, kg: best.kg, reps: best.reps, allReps, sec, wt, record, hands: ex.hands || 1, rank: ex.mobility ? 3 : wt ? 0 : (sec ? 2 : 1) });
  });
  lifts.sort((a, b) => a.rank - b.rank); // сначала с отягощением, потом свой вес, потом на время
  // номер тренировки по порядку
  const all = [];
  Object.keys(DB.logs).forEach((dd) => Object.entries(DB.logs[dd]).forEach(([k, ss]) => { if (doneCount(ss) > 0) all.push(`${dd}|${String(ss.startedAt || 0).padStart(14, '0')}|${k}`); }));
  all.sort();
  const me = all.indexOf(`${d}|${String(s.startedAt || 0).padStart(14, '0')}|${wid}`);
  const number = me >= 0 ? me + 1 : all.length;
  const secs = s.finished ? sessionSeconds(s) : 0;
  const kcal = secs ? Math.round(STORY_MET * STORY_BODY_KG * secs / 3600) : 0;
  // тренировок за неделю, заканчивая этим днём
  const dt = new Date(d + 'T12:00:00'); let week = 0;
  for (let i = 0; i < 7; i++) {
    const x = new Date(dt); x.setDate(dt.getDate() - i);
    const day = DB.logs[dateStr(x)]; if (day) Object.values(day).forEach((ss) => { if (doneCount(ss) > 0) week++; });
  }
  return { w, d, dt, secs, kcal, sets, volume: Math.round(volume), lifts, number, week, records: lifts.filter((l) => l.record).length };
}
function rr(c, x, y, w, h, r) { c.beginPath(); c.moveTo(x + r, y); c.arcTo(x + w, y, x + w, y + h, r); c.arcTo(x + w, y + h, x, y + h, r); c.arcTo(x, y + h, x, y, r); c.arcTo(x, y, x + w, y, r); c.closePath(); }
function fitText(c, text, maxW) {
  if (c.measureText(text).width <= maxW) return text;
  let t = text; while (t.length > 3 && c.measureText(t + '…').width > maxW) t = t.slice(0, -1);
  return t.trim() + '…';
}
async function drawStory(D) {
  try { await Promise.all([document.fonts.load('800 60px Unbounded', 'А1'), document.fonts.load('800 30px Manrope', 'А1'), document.fonts.load('700 30px Manrope', 'А1'), document.fonts.load('500 30px Manrope', 'А1')]); } catch (e) { /* шрифт системный */ }
  const W = 1080, H = 1920, LIME = '#c6f432', PX = 84;
  const cv = document.createElement('canvas'); cv.width = W; cv.height = H; const c = cv.getContext('2d');
  const U = (px) => `800 ${px}px Unbounded, "Segoe UI", Arial, sans-serif`;
  const M = (wt, px) => `${wt} ${px}px Manrope, "Segoe UI", Arial, sans-serif`;
  const sp = (v) => { if ('letterSpacing' in c) c.letterSpacing = v; };
  c.fillStyle = '#000'; c.fillRect(0, 0, W, H);
  let g = c.createRadialGradient(W - 120, 330, 0, W - 120, 330, 760); g.addColorStop(0, 'rgba(198,244,50,.26)'); g.addColorStop(1, 'rgba(198,244,50,0)');
  c.fillStyle = g; c.fillRect(0, 0, W, H);
  g = c.createRadialGradient(80, H - 380, 0, 80, H - 380, 620); g.addColorStop(0, 'rgba(198,244,50,.12)'); g.addColorStop(1, 'rgba(198,244,50,0)');
  c.fillStyle = g; c.fillRect(0, 0, W, H);
  c.textBaseline = 'alphabetic';

  // шапка (безопасная зона сторис: не ниже 250 и не выше 1670)
  let y = 300;
  c.fillStyle = LIME; c.font = M(800, 34); sp('7px'); c.textAlign = 'left'; c.fillText('MAX RICCO', PX, y);
  c.textAlign = 'right'; c.fillStyle = '#9a9aa2'; c.font = M(700, 34); sp('3px');
  c.fillText(`${D.dt.getDate()} ${MONTH_GEN[D.dt.getMonth()]}`.toUpperCase(), W - PX, y);
  c.textAlign = 'left'; sp('0px');

  // название
  y += 120; c.fillStyle = '#fff'; c.font = U(80);
  c.fillText(fitText(c, `ТРЕНИРОВКА ${D.w.short || ''}`.trim(), W - 2 * PX), PX, y);
  y += 54; c.fillStyle = '#9a9aa2'; c.font = M(700, 38); c.fillText(fitText(c, D.w.title || '', W - 2 * PX), PX, y);

  // значок номера тренировки
  y += 56; const ms = MILESTONES.includes(D.number);
  const label = ms ? `★ ${D.number}-Я ТРЕНИРОВКА` : `ТРЕНИРОВКА № ${D.number}`;
  c.font = U(30); sp('1px'); const lw = c.measureText(label).width + 64;
  if (ms) { c.fillStyle = LIME; rr(c, PX, y, lw, 74, 37); c.fill(); c.fillStyle = '#0a0a0a'; }
  else { c.strokeStyle = '#3a3a40'; c.lineWidth = 3; rr(c, PX + 1.5, y + 1.5, lw - 3, 71, 36); c.stroke(); c.fillStyle = '#d6d6dc'; }
  c.fillText(label, PX + 32, y + 49); sp('0px');
  if (D.records) { c.fillStyle = LIME; c.font = M(800, 32); c.fillText(`★ ${D.records} ${plural(D.records, 'рекорд', 'рекорда', 'рекордов')}`, PX + lw + 28, y + 49); }
  else if (D.week > 1) { c.fillStyle = '#9a9aa2'; c.font = M(700, 32); c.fillText(`${D.week} ${plural(D.week, 'тренировка', 'тренировки', 'тренировок')} за неделю`, PX + lw + 28, y + 48); }

  // главное число: время
  y += 272; c.fillStyle = LIME;
  if (D.secs) {
    const m = Math.round(D.secs / 60), h = Math.floor(m / 60), mm = m % 60;
    const big = h ? `${h}:${pad(mm)}` : String(m); c.font = U(h ? 200 : 225); c.fillText(big, PX - 6, y);
    const bw = c.measureText(big).width; c.fillStyle = '#fff'; c.font = U(46); c.fillText(h ? 'ЧАС' : 'МИН', PX + bw + 24, y - 4);
  } else { c.font = U(225); c.fillText(String(D.sets), PX - 6, y); const bw = c.measureText(String(D.sets)).width; c.fillStyle = '#fff'; c.font = U(46); c.fillText('ПОДХ.', PX + bw + 24, y - 4); }
  y += 50; c.fillStyle = '#9a9aa2'; c.font = M(800, 32); sp('5px'); c.fillText(D.secs ? 'ВРЕМЯ ТРЕНИРОВКИ' : 'ПОДХОДОВ', PX, y); sp('0px');

  // три плитки
  y += 46; const tiles = [];
  if (D.secs) tiles.push([String(D.sets), 'ПОДХОДОВ']);
  tiles.push([D.volume ? D.volume.toLocaleString('ru-RU').replace(/ /g, ' ') : '—', 'КГ ПОДНЯТО']);
  if (D.kcal) tiles.push(['≈' + D.kcal, 'ККАЛ']); else tiles.push([String(D.lifts.length), 'УПРАЖНЕНИЙ']);
  if (tiles.length < 3) tiles.splice(0, 0, [String(D.lifts.length), 'УПРАЖНЕНИЙ']);
  const gap = 24, tw = (W - 2 * PX - gap * 2) / 3, th = 172;
  tiles.slice(0, 3).forEach((t, i) => {
    const x = PX + i * (tw + gap);
    c.fillStyle = '#141416'; rr(c, x, y, tw, th, 32); c.fill(); c.strokeStyle = '#26262a'; c.lineWidth = 2; rr(c, x + 1, y + 1, tw - 2, th - 2, 31); c.stroke();
    c.fillStyle = '#fff'; c.font = U(t[0].length > 5 ? 44 : 54); c.textAlign = 'center'; c.fillText(t[0], x + tw / 2, y + 92);
    c.fillStyle = '#8b8b92'; c.font = M(800, 25); sp('3px'); c.fillText(t[1], x + tw / 2 + 1, y + 138); sp('0px'); c.textAlign = 'left';
  });

  // лучшие подходы
  y += th + 54; c.fillStyle = '#8b8b92'; c.font = M(800, 28); sp('5px'); c.fillText('ЛУЧШИЕ ПОДХОДЫ', PX, y); sp('0px');
  const rows = D.lifts.slice(0, 6), rh = 78; y += 20;
  const maxY = 1670; const fit = Math.max(3, Math.min(rows.length, Math.floor((maxY - y) / rh)));
  rows.slice(0, fit).forEach((l, i) => {
    const ry = y + i * rh; c.fillStyle = '#26262a'; c.fillRect(PX, ry, W - 2 * PX, 2);
    const res = !l.wt && l.allReps.length > 1 ? `${l.allReps.join(' + ')} = ${l.allReps.reduce((p, q) => p + q, 0)} ${l.sec ? 'сек' : 'повт.'}` : l.sec ? `${l.reps} сек` : (l.wt && l.kg ? `${l.hands > 1 ? '2 × ' : ''}${fmtKgNum(l.kg)} кг × ${l.reps}` : `${l.reps} повт.`);
    c.font = U(31); c.textAlign = 'right'; c.fillStyle = l.record ? LIME : '#fff'; c.fillText(res, W - PX, ry + 52);
    const resW = c.measureText(res).width, rw = resW + (l.record ? 44 : 0) + 28;
    c.textAlign = 'left'; c.font = M(700, 36); c.fillStyle = '#e8e8ee'; c.fillText(fitText(c, l.name, W - 2 * PX - rw), PX, ry + 52);
    if (l.record) { c.fillStyle = LIME; c.font = M(800, 34); c.textAlign = 'right'; c.fillText('★', W - PX - resW - 18, ry + 51); c.textAlign = 'left'; }
  });
  // подпись
  const sy = Math.min(1690, y + fit * rh + 78);
  const t1 = 'приложение ', t2 = 'RusWeo Fitness';
  c.font = M(700, 34); const w1 = c.measureText(t1).width; c.font = U(36); const w2 = c.measureText(t2).width;
  const sx = (W - w1 - w2) / 2; c.textAlign = 'left';
  c.font = M(700, 34); c.fillStyle = '#9a9aa2'; c.fillText(t1, sx, sy);
  c.font = U(36); c.fillStyle = LIME; c.fillText(t2, sx + w1, sy);
  return new Promise((res) => cv.toBlob((b) => res(b), 'image/png'));
}
async function openStory(wid, d) {
  const D = storyData(wid, d || dateStr());
  if (!D) { toast('Сначала отметь хотя бы один подход'); return; }
  toast('Рисую картинку…');
  const blob = await drawStory(D); if (!blob) { toast('Не получилось нарисовать'); return; }
  closeStory(); storyBlob = blob; storyUrl = URL.createObjectURL(blob);
  const el = document.createElement('div'); el.id = 'story'; el.className = 'story';
  el.innerHTML = `<div class="storybox"><img src="${storyUrl}" alt="Картинка для сторис"><div class="storybtns">
    <button class="primary" data-act="storyshare">Поделиться в Instagram</button>
    ${isNativeApp() ? '<p class="muted small" style="flex:1 1 100%;text-align:center;margin:0">В меню выбери Instagram → «История». Чтобы сохранить в галерею, выбери «Фото» или «Файлы».</p>' : '<button data-act="storysave">Сохранить</button>'}
    <button class="ghost" data-act="storyclose">Закрыть</button></div></div>`;
  document.body.appendChild(el);
}
function isNativeApp() { try { return !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform()); } catch (e) { return false; } }
function closeStory() {
  const el = $('#story'); if (el) el.remove();
  if (storyUrl) { URL.revokeObjectURL(storyUrl); storyUrl = null; } storyBlob = null;
}
function blobToBase64(b) {
  return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1]); r.onerror = rej; r.readAsDataURL(b); });
}
async function shareStory() {
  if (!storyBlob) return;
  const name = `fitness-story-${dateStr()}.png`;
  // 1) Android-приложение: плагины Capacitor Filesystem + Share
  try {
    const P_ = window.Capacitor && window.Capacitor.Plugins;
    if (P_ && P_.Filesystem && P_.Share) {
      const r = await P_.Filesystem.writeFile({ path: name, data: await blobToBase64(storyBlob), directory: 'CACHE' });
      await P_.Share.share({ title: 'Моя тренировка', files: [r.uri], dialogTitle: 'Поделиться картинкой' });
      return;
    }
  } catch (e) { if (e && /cancel/i.test(String(e.message || e))) return; }
  // 2) браузер / PWA
  try {
    const file = new File([storyBlob], name, { type: 'image/png' });
    if (navigator.canShare && navigator.canShare({ files: [file] })) { await navigator.share({ files: [file], title: 'Моя тренировка' }); return; }
  } catch (e) { if (e && e.name === 'AbortError') return; }
  if (isNativeApp()) { toast('Не открылось меню «Поделиться». Обнови приложение с GitHub и попробуй снова'); return; }
  saveStory();
}
function saveStory() {
  if (!storyBlob) return;
  const a = document.createElement('a'); a.href = storyUrl; a.download = `fitness-story-${dateStr()}.png`;
  document.body.appendChild(a); a.click(); a.remove(); toast('Картинка сохранена в загрузки');
}

async function shareText() {
  const text = journalText();
  try {
    if (navigator.share) { await navigator.share({ title: 'Журнал тренировок', text }); return; }
  } catch (e) { if (e && e.name === 'AbortError') return; }
  try { await navigator.clipboard.writeText(text); toast('Журнал скопирован. Вставь его в чат с Claude'); }
  catch (e) { toast('Не удалось поделиться'); }
}
async function shareFile() {
  const blob = new Blob([JSON.stringify({ app: 'fitness', exportedAt: new Date().toISOString(), data: DB }, null, 1)], { type: 'application/json' });
  const file = new File([blob], `fitness-backup-${dateStr()}.json`, { type: 'application/json' });
  try {
    if (navigator.canShare && navigator.canShare({ files: [file] })) { await navigator.share({ files: [file], title: 'Данные Фитнес' }); return; }
  } catch (e) { if (e && e.name === 'AbortError') return; }
  exportData();
}
function exportData() {
  const blob = new Blob([JSON.stringify({ app: 'fitness', exportedAt: new Date().toISOString(), data: DB }, null, 1)], { type: 'application/json' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `fitness-backup-${dateStr()}.json`;
  document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
function importData(file) {
  if (!file) return;
  const rd = new FileReader();
  rd.onload = () => {
    try {
      const j = JSON.parse(rd.result);
      if (!j || j.app !== 'fitness' || !j.data) throw new Error('формат');
      if (!confirm('Заменить текущие данные данными из файла?')) return;
      DB = Object.assign(blank(), j.data); save(); toast('Данные восстановлены'); render();
    } catch (e) { toast('Файл не подходит'); }
  };
  rd.readAsText(file);
}

/* ---------- кнопка «Назад»: идём на экран выше, а не из приложения ---------- */
function parentOf(hash) {
  const p = String(hash || '#/').replace(/^#\/?/, '').split('/'); const r = p[0] || '';
  if (r === '') return null;
  if (r === 'w' && p[2] !== undefined && p[2] !== '') return `#/w/${p[1]}`;
  if (r === 'ex') return '#/lib';
  if (r === 'lib') return '#/more';
  if (r === 'report' || r === 'body') return '#/progress';
  return '#/';
}
function goUp() {
  if (panel) { panel = null; render(true); return true; }
  const up = parentOf(location.hash);
  if (up) { location.replace(up); return true; }
  return false;
}
function setupBack() {
  // под первой страницей держим «Сегодня», чтобы «Назад» никогда не выбрасывал из приложения с глубокого экрана
  try {
    const h0 = location.hash || '#/';
    if (parentOf(h0) && history.length <= 1) {
      history.replaceState(null, '', location.pathname + location.search + '#/');
      history.pushState(null, '', location.pathname + location.search + h0);
    }
  } catch (e) { /* не критично */ }
  // системная кнопка в Android-приложении (плагин App из Capacitor)
  try {
    const A = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.App;
    if (A && A.addListener) {
      A.addListener('backButton', () => { if (!goUp() && A.exitApp) A.exitApp(); });
    }
  } catch (e) { /* не критично */ }
}

/* ---------- запуск ---------- */
async function init() {
  setupBack();
  try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist(); } catch (e) { /* ok */ }
  try { await loadContent(); await mergeHistory(); } catch (e) {
    $('#app').innerHTML = '<p class="pad">Не удалось загрузить данные. Открой приложение при подключении к интернету один раз.</p>';
    return;
  }
  render();
  scheduleSync(2500);
  if ('serviceWorker' in navigator) {
    let had = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.addEventListener('controllerchange', () => { if (had) toast('Приложение обновлено'); had = true; });
    navigator.serviceWorker.register('sw.js').then((reg) => { swReg = reg; reg.update().catch(() => {}); }).catch(() => {});
  }
}
init();
