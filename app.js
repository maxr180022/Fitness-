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
let N = null; // питание
let foodTab = 'menu';
let installEvt = null;
let swReg = null;
let wakeLock = null;

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
}

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
async function loadContent() {
  const [p, n] = await Promise.all([getJSON('data/program.json'), getJSON('data/nutrition.json')]);
  const changed = JSON.stringify(p) !== JSON.stringify(P) || JSON.stringify(n) !== JSON.stringify(N);
  P = p; N = n;
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
        const parts = arr.filter((s) => s.done).map((s) => (s.kg ? `${s.kg} кг × ` : '') + s.reps);
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
      if (doneCount(s) > 0) { if (k !== 'core') c++; if (s.finished) sec += sessionSeconds(s); }
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
  const core = workoutById('core');
  let h = `<h1>${esc(title)}</h1>`;
  if (w) {
    const s = getSession(w.id, false); const dc = doneCount(s);
    const pending = w.status === 'pending';
    h += `<div class="card ${dc ? 'done' : 'accent'}"><div class="row between"><h3>${esc(w.when)} · ${esc(w.title)}</h3>
      ${pending ? '<span class="tag">программа скоро</span>' : dc ? `<span class="tag ok">${dc} подх.${s && s.finished ? ' · ' + fmtLong(sessionSeconds(s)) : ''}</span>` : '<span class="tag acc">сегодня</span>'}</div>
      <p class="muted">${esc(w.description)}</p>
      <a class="btn primary block" href="#/w/${esc(w.id)}">${dc ? 'Продолжить' : pending ? 'Открыть' : 'Начать тренировку'}</a></div>`;
  } else {
    h += `<div class="card"><h3>Сегодня без силовой</h3><p class="muted">День восстановления: прогулка и блок «Кор и спина» по желанию.</p></div>`;
  }
  if (core) {
    const cs = getSession('core', false);
    h += `<div class="card ${doneCount(cs) ? 'done' : ''}"><div class="row between"><h3>${esc(core.title)}</h3><span class="tag">~10 мин</span></div>
      <p class="muted small">${esc(core.when)}. ${esc(core.items.map((id) => P.exercises[id].name).join(', '))}.</p>
      <a class="btn block" href="#/w/core">Открыть блок</a></div>`;
  }
  // питание сегодня
  const m = (N.menu || []).find((x) => [].concat(x.weekday).includes(wd));
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
    <div class="card"><div class="muted small">Талия${waist ? ' · ' + shortDate(waist.d) : ''}</div><h1>${waist ? waist.v + ' см' : '—'}</h1></div></div>`;
  if (wd === 0) h += `<div class="card accent"><h3>Воскресенье: замер талии</h3><p class="muted small">Утром, натощак, на уровне пупка, на выдохе.</p><a class="btn block" href="#/progress">Записать замер</a></div>`;
  return h;
}

function viewTrain() {
  let h = '<h1>Тренировки</h1>';
  (P.workouts || []).forEach((w) => {
    const s = getSession(w.id, false); const dc = doneCount(s);
    h += `<a class="card" style="display:block;color:inherit;text-decoration:none" href="#/w/${esc(w.id)}">
      <div class="row between"><h3>${esc(w.title)}</h3>${w.status === 'pending' ? '<span class="tag">скоро</span>' : dc ? `<span class="tag ok">сегодня ${dc}</span>` : '<span class="tag"> </span>'}</div>
      <div class="muted small">${esc(w.when)}${w.items.length ? ' · ' + w.items.length + ' упражн.' : ''}</div></a>`;
  });
  h += '<h2>Все упражнения</h2><div class="card list">';
  Object.entries(P.exercises).forEach(([id, ex]) => {
    h += `<a class="item" href="#/ex/${esc(id)}"><div class="grow"><div>${esc(ex.name)}</div><div class="muted small">${esc(ex.muscles)}</div></div><span class="chev">›</span></a>`;
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
  const split = DB.settings.split && Array.isArray(w.groups) && w.groups.length;
  return split ? w.groups : w.items.map((e) => [e]);
}
function viewWorkout(id) {
  const w = workoutById(id);
  if (!w) return '<p class="pad">Тренировка не найдена.</p>';
  let h = `<a href="#/train" data-act="back">← Назад</a><h1>${esc(w.title)}</h1><div class="muted">${esc(w.when)}</div>
    <div class="card"><p>${esc(w.description)}</p></div>`;
  if (w.status === 'pending' || !w.items.length) return h;
  const sess = getSession(w.id, false);
  const started = sess && sess.startedAt, finished = sess && sess.finished;
  h += `<div class="card ${finished ? 'done' : started ? 'accent' : ''}"><div class="row between">
    <div><div class="muted small">Время тренировки</div><div class="t" style="font-size:30px;font-weight:700" id="wclock" data-w="${esc(w.id)}">${started ? fmtTime(sessionSeconds(sess)) : '0:00'}</div></div>
    ${started ? (finished ? '<span class="tag ok">завершена</span>' : '<span class="tag acc">идёт</span>') : `<button class="primary" data-act="wstart" data-w="${esc(w.id)}">▶ Начать</button>`}</div></div>`;
  if (Array.isArray(w.groups) && w.groups.length) {
    h += `<div class="row between" style="margin:6px 0"><div class="muted small">Режим: <b>${DB.settings.split ? 'сплит (пары упражнений подряд)' : 'по порядку'}</b></div>
      <button class="ghost" style="padding:6px 10px" data-act="splitmode">${DB.settings.split ? 'По порядку' : 'Сплит'}</button></div>`;
  }
  if (w.warmup) h += `<div class="card"><h3>Разминка</h3><p class="muted">${esc(w.warmup)}</p></div>`;
  const groups = workoutGroups(w);
  const isSplit = groups.some((g) => g.length > 1);
  h += `<p class="muted small">${w.rounds ? w.rounds + ' круга. ' : ''}${isSplit ? 'В паре делай упражнения подряд без отдыха, таймер отдыха запустится после второго.' : 'Отметь подход галочкой, запустится таймер отдыха.'}</p>`;
  groups.forEach((g, gi) => {
    const exs = g.map((e) => P.exercises[e]).filter(Boolean); if (!exs.length) return;
    const n = Math.max(...g.map((e) => setsCount(w, e)));
    h += `<div class="card" data-g="${gi}">`;
    if (g.length > 1) h += `<div class="row between"><h3>Пара ${gi + 1}</h3><span class="tag acc">${n} круга</span></div>`;
    g.forEach((exId, k) => {
      const ex = P.exercises[exId]; if (!ex) return;
      const last = lastTime(exId, w.id);
      h += `<div style="margin-top:${k ? 10 : 0}px"><div class="row between"><h3>${g.length > 1 ? String.fromCharCode(65 + k) + '. ' : ''}${esc(ex.name)}</h3><span class="tag">${setsCount(w, exId)} × ${esc(ex.target)}</span></div>
        <div class="muted small">${esc(ex.muscles)}${last ? ' · раньше ' + esc(last) : ''}</div>
        <details><summary class="small" style="margin:6px 0;color:var(--accent)">Видео и техника</summary>${videoHTML(ex)}${tipsHTML(ex)}</details></div>`;
    });
    // подходы: в сплите чередуем A1, B1, A2, B2
    for (let i = 0; i < n; i++) {
      if (g.length > 1) h += `<div class="small" style="color:var(--accent);margin-top:10px">Круг ${i + 1}</div>`;
      g.forEach((exId, k) => {
        const ex = P.exercises[exId]; if (!ex || i >= setsCount(w, exId)) return;
        const arr = getSets(w.id, exId, setsCount(w, exId));
        h += setRow(w.id, exId, i, arr[i], ex, g.length > 1 ? String.fromCharCode(65 + k) : '');
      });
    }
    h += '</div>';
  });
  h += `<button class="primary block" data-act="finish" data-w="${esc(w.id)}">${finished ? '✓ Тренировка завершена' : 'Завершить тренировку'}</button>`;
  return h;
}
function setRow(wid, exId, i, s, ex, letter) {
  const sec = ex.unit === 'sec';
  return `<div class="set ${s.done ? 'on' : ''}" data-w="${esc(wid)}" data-e="${esc(exId)}" data-i="${i}">
    <span class="n" title="${esc(ex.name)}">${letter ? esc(letter) : i + 1}</span>
    ${ex.weighted ? `<input inputmode="decimal" data-f="kg" value="${esc(s.kg)}" placeholder="кг" aria-label="вес, кг"><span class="u">кг</span>` : ''}
    <input inputmode="numeric" data-f="reps" value="${esc(s.reps)}" placeholder="${esc(ex.def)}" aria-label="${sec ? 'секунды' : 'повторы'}"><span class="u">${sec ? 'сек' : 'повт.'}</span>
    ${sec ? '<button class="tm" data-act="tm">▶ таймер</button>' : ''}
    <button class="chk" data-act="chk" aria-label="подход выполнен">✓</button></div>`;
}

function viewExercise(id) {
  const ex = P.exercises[id];
  if (!ex) return '<p class="pad">Упражнение не найдено.</p>';
  let h = `<a href="#/train" data-act="back">← Назад</a><h1>${esc(ex.name)}</h1><div class="muted">${esc(ex.muscles)} · ${esc(ex.target)}</div>
    ${videoHTML(ex)}<div class="card">${tipsHTML(ex)}</div>`;
  const rows = [];
  Object.keys(DB.logs).sort().reverse().forEach((d) => Object.values(DB.logs[d]).forEach((s) => {
    const arr = s.sets && s.sets[id];
    if (arr && arr.some((x) => x.done)) rows.push(`<tr><td>${shortDate(d)}</td><td>${arr.filter((x) => x.done).map((x) => (x.kg ? x.kg + ' кг × ' : '') + x.reps).join(', ')}</td></tr>`);
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
    N.menu.forEach((m) => {
      const today = [].concat(m.weekday).includes(wd);
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
      ${N.shopping.map((s) => `<label class="check ${DB.shop[s.id] ? 'on' : ''}"><input type="checkbox" data-act="shop" data-id="${esc(s.id)}" ${DB.shop[s.id] ? 'checked' : ''}><span>${esc(s.text)}</span></label>`).join('')}
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

const MFIELDS = [['waist', 'Талия'], ['navel', 'Живот на уровне пупка'], ['chest', 'Грудь'], ['shoulders', 'Плечи'], ['arm', 'Рука'], ['hips', 'Бёдра'], ['thigh', 'Нога (бедро)']];

function viewProgress() {
  let h = '<h1>Прогресс</h1>';
  h += `<div class="card"><h3>Новый замер, см</h3><p class="muted small">Талию мерь утром, натощак, на уровне пупка, на выдохе. Достаточно раз в неделю, лучше в воскресенье.</p>
    <label class="f">Дата</label><input type="date" id="m-date" value="${dateStr()}">
    <div class="grid2">${MFIELDS.map(([k, t]) => `<div><label class="f">${t}</label><input type="text" inputmode="decimal" id="m-${k}" placeholder="см"></div>`).join('')}</div>
    <button class="primary block" style="margin-top:12px" data-act="msave">Сохранить замер</button></div>`;
  const wp = DB.measures.filter((m) => m.waist != null).sort((a, b) => (a.date < b.date ? -1 : 1)).map((m) => ({ d: m.date, v: m.waist }));
  h += `<div class="card"><h3>Талия</h3>${lineChart(wp, 'см')}</div>`;
  if (DB.measures.length) {
    const rows = [...DB.measures].sort((a, b) => (a.date < b.date ? 1 : -1));
    h += `<div class="card"><h3>Замеры</h3><table><tr><th>Дата</th>${MFIELDS.map(([, t]) => `<th>${esc(t.split(' ')[0])}</th>`).join('')}<th></th></tr>${rows.map((m) =>
      `<tr><td>${shortDate(m.date)}</td>${MFIELDS.map(([k]) => `<td>${m[k] != null ? m[k] : ''}</td>`).join('')}<td><button class="ghost danger" style="padding:4px 8px" data-act="mdel" data-id="${esc(m.id)}">×</button></td></tr>`).join('')}</table></div>`;
  }
  // история тренировок
  const hist = [];
  Object.keys(DB.logs).sort().reverse().forEach((d) => Object.entries(DB.logs[d]).forEach(([wid, s]) => {
    const dc = doneCount(s); if (!dc) return;
    const w = workoutById(wid); let total = 0;
    if (w) w.items.forEach((e) => { total += setsCount(w, e); });
    const secs = sessionSeconds(s); hist.push(`<tr><td>${shortDate(d)}</td><td>${esc(w ? w.title : wid)}</td><td>${dc}${total ? ' / ' + total : ''}</td><td>${secs && s.finished ? fmtLong(secs) : ''}</td></tr>`);
  }));
  h += `<div class="card"><h3>История тренировок</h3>${hist.length ? `<table><tr><th>Дата</th><th>Тренировка</th><th>Подходов</th><th>Время</th></tr>${hist.slice(0, 30).join('')}</table>` : '<p class="muted small">Пока пусто: сделай первую тренировку.</p>'}</div>`;
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
      return `<tr><td>${esc(ex.name)}</td><td>${b.kg ? b.kg + ' кг × ' : ''}${b.reps} ${ex.unit === 'sec' ? 'сек' : 'повт.'}</td></tr>`;
    }).join('')}</table></div>`;
  }
  return h;
}

function viewMore() {
  const ts = (k) => esc(localStorage.getItem(k) || '');
  return `<h1>Ещё</h1>
  <div class="card"><h3>Обновления</h3><p class="muted small">Тренировки, питание и видео подтягиваются из репозитория автоматически при открытии приложения. Пересобирать и переустанавливать ничего не нужно.</p>
    <p>Версия контента: <b>${esc(P.version)}</b> от ${esc(P.updated)}<br>Питание: <b>${esc(N.version)}</b> от ${esc(N.updated)}</p>
    <button class="block" data-act="update">Проверить обновления</button></div>
  <div class="card"><h3>Офлайн</h3><p class="muted small">Видео сохраняются на телефоне при первом просмотре. Можно скачать все сразу, пока есть Wi‑Fi.</p>
    <button class="block" data-act="offline">Скачать все видео</button><p class="muted small" id="off-status"></p></div>
  <div class="card"><h3>Установка на телефон</h3>${installEvt ? '<button class="primary block" data-act="install">Установить приложение</button>' : ''}
    <p class="muted small">Chrome на Android: меню ⋮ → «Установить приложение» (или «Добавить на главный экран»). После этого иконка «Фитнес» появится среди приложений.</p></div>
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
  try {
    if (r === '') html = viewToday();
    else if (r === 'train') { html = viewTrain(); tab = 'train'; }
    else if (r === 'w') { html = viewWorkout(a); tab = 'train'; }
    else if (r === 'ex') { html = viewExercise(a); tab = 'train'; }
    else if (r === 'food') { html = viewFood(); tab = 'food'; }
    else if (r === 'progress') { html = viewProgress(); tab = 'progress'; }
    else if (r === 'more') { html = viewMore(); tab = 'more'; }
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

/* ---------- события ---------- */
document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-act]'); if (!el) return;
  const act = el.dataset.act;
  if (act === 'back') { e.preventDefault(); if (history.length > 1) history.back(); else location.hash = '#/train'; return; }
  if (act === 'chk') {
    const row = el.closest('.set'); const { w, e: exId } = row.dataset; const i = +row.dataset.i;
    const ex = P.exercises[exId]; const wk = workoutById(w);
    const arr = getSets(w, exId, setsCount(wk, exId)); const s = arr[i];
    const inp = $('input[data-f="reps"]', row);
    s.done = !s.done;
    if (s.done && !String(s.reps).trim()) { s.reps = String(ex.def); inp.value = s.reps; }
    row.classList.toggle('on', s.done);
    if (s.done) startSession(w);
    save();
    if (s.done) {
      const g = workoutGroups(wk).find((x) => x.includes(exId)) || [exId];
      const idx = g.indexOf(exId);
      if (idx < g.length - 1) {
        const nx = P.exercises[g[idx + 1]];
        toast(`Дальше без отдыха: ${nx ? nx.name : ''}`);
      } else if (wk.rounds && ex.rest > 0) {
        const rest = Math.max(...g.map((x) => (P.exercises[x] ? P.exercises[x].rest : 0)));
        startTimer(rest, g.length > 1 ? 'Отдых после пары' : 'Отдых после: ' + ex.name);
      }
    }
    return;
  }
  if (act === 'wstart') { startSession(el.dataset.w); render(true); return; }
  if (act === 'splitmode') { DB.settings.split = !DB.settings.split; save(); render(true); return; }
  if (act === 'tm') {
    const row = el.closest('.set'); const ex = P.exercises[row.dataset.e];
    const v = num($('input[data-f="reps"]', row).value) || ex.def;
    startTimer(v, ex.name); return;
  }
  if (act === 'finish') {
    const s = getSession(el.dataset.w, true);
    if (!s.finished) {
      if (!s.startedAt) s.startedAt = Date.now();
      s.finished = true; s.endedAt = Date.now(); s.durationSec = Math.round((s.endedAt - s.startedAt) / 1000);
      stopTimer(); save();
      toast(`Тренировка завершена: ${fmtLong(s.durationSec)}, подходов ${doneCount(s)}. Хорошая работа!`);
    } else { s.finished = false; s.endedAt = null; s.durationSec = null; save(); toast('Отметка снята, время идёт дальше'); }
    render(true); return;
  }
  if (act === 't+') { if (T) T.end += 15000; return; }
  if (act === 'tstop') { stopTimer(); return; }
  if (act === 'water') {
    const d = dateStr(); DB.water[d] = Math.max(0, (DB.water[d] || 0) + parseInt(el.dataset.ml, 10)); save(); render(true); return;
  }
  if (act === 'ftab') { foodTab = el.dataset.k; render(true); return; }
  if (act === 'shop') { DB.shop[el.dataset.id] = el.checked; save(); render(true); return; }
  if (act === 'shopreset') { DB.shop = {}; save(); render(true); return; }
  if (act === 'msave') {
    const m = { id: String(Date.now()), date: $('#m-date').value || dateStr() }; let any = false;
    MFIELDS.forEach(([k]) => { const v = num($('#m-' + k).value); if (v != null) { m[k] = v; any = true; } });
    if (!any) { toast('Введи хотя бы одно значение'); return; }
    DB.measures.push(m); save(); toast('Замер сохранён'); render(true); return;
  }
  if (act === 'mdel') { DB.measures = DB.measures.filter((m) => m.id !== el.dataset.id); save(); render(true); return; }
  if (act === 'update') { checkUpdates(true); return; }
  if (act === 'offline') { downloadAll(); return; }
  if (act === 'install') { if (installEvt) { installEvt.prompt(); installEvt = null; } return; }
  if (act === 'export') { exportData(); return; }
  if (act === 'reset') {
    if (confirm('Удалить все подходы, замеры и отметки на этом телефоне? Это нельзя отменить.')) { DB = blank(); save(); toast('Данные удалены'); render(); }
  }
});
// чекбоксы списка покупок срабатывают как click по input
document.addEventListener('input', (e) => {
  const inp = e.target; if (!inp.matches || !inp.matches('.set input')) return;
  const row = inp.closest('.set'); const { w, e: exId } = row.dataset; const wk = workoutById(w);
  const arr = getSets(w, exId, setsCount(wk, exId)); arr[+row.dataset.i][inp.dataset.f] = inp.value; save();
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

/* ---------- запуск ---------- */
async function init() {
  try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist(); } catch (e) { /* ok */ }
  try { await loadContent(); } catch (e) {
    $('#app').innerHTML = '<p class="pad">Не удалось загрузить данные. Открой приложение при подключении к интернету один раз.</p>';
    return;
  }
  render();
  if ('serviceWorker' in navigator) {
    let had = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.addEventListener('controllerchange', () => { if (had) toast('Приложение обновлено'); had = true; });
    navigator.serviceWorker.register('sw.js').then((reg) => { swReg = reg; reg.update().catch(() => {}); }).catch(() => {});
  }
}
init();
