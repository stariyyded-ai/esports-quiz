import { QUESTIONS } from "./questions.js";
import { SETTINGS } from "./config.js";
import { createStore } from "./store.js";
import { nextStats, computeAchievements } from "./achievements.js";
import { isTap, validAnswer, isCorrect, tapBoard } from "./tap.js";

const app = document.getElementById("app");
const params = new URLSearchParams(location.search);
const LETTERS = ["A", "B", "C", "D"];
const SHAPES = [
  '<svg class="shape" viewBox="0 0 20 20" aria-hidden="true"><path d="M10 2 19 18H1Z" fill="currentColor"/></svg>',
  '<svg class="shape" viewBox="0 0 20 20" aria-hidden="true"><path d="M10 1 19 10 10 19 1 10Z" fill="currentColor"/></svg>',
  '<svg class="shape" viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="9" fill="currentColor"/></svg>',
  '<svg class="shape" viewBox="0 0 20 20" aria-hidden="true"><rect x="2" y="2" width="16" height="16" fill="currentColor"/></svg>'
];
const TOTAL = QUESTIONS.length;
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmtNum = (n) => Math.round(n || 0).toLocaleString("ru-RU");
const durationOf = (i) => QUESTIONS[i]?.time || SETTINGS.questionTime;
const joinBase = () => location.origin + location.pathname;
// Служебные параметры (?local=1 — тестовый режим, ?broker=… — свой брокер) сохраняются при переходах.
const keep = ["local", "broker"].filter((k) => params.has(k)).map((k) => `${k}=${encodeURIComponent(params.get(k))}`);
const link = (q = "") => { const qs = [q, ...keep].filter(Boolean).join("&"); return joinBase() + (qs ? "?" + qs : ""); };
let store;

start();

async function start() {
  try {
    store = await createStore();
  } catch (e) {
    app.innerHTML = `<div class="center-msg"><h1>Ошибка подключения</h1><p>${esc(e.message)}</p></div>`;
    return;
  }
  if (store.mode === "local") { document.getElementById("testmode").hidden = false; document.body.classList.add("test"); }
  // Плашку «нет связи» показываем, только если связь пропала дольше чем на 4 секунды.
  let netTimer = null;
  store.onConnection((ok) => {
    clearTimeout(netTimer);
    if (ok) document.getElementById("net").hidden = true;
    else netTimer = setTimeout(() => { document.getElementById("net").hidden = false; }, 4000);
  });

  const host = params.get("host");
  const room = params.get("room");
  if (host) runHost(host.trim());
  else if (room) runPlayer(room.trim());
  else landing();
}

/* ───────────────────────── Стартовая страница ───────────────────────── */
function landing() {
  app.innerHTML = `
    <div class="landing">
      <div class="brand">
        <span class="live">LIVE</span>
        <h1>${esc(SETTINGS.title)}<span>.</span></h1>
        <p>${esc(SETTINGS.subtitle)}</p>
      </div>
      <form class="card" id="join" novalidate>
        <label for="code">Код комнаты</label>
        <input id="code" inputmode="numeric" autocomplete="off" maxlength="4" placeholder="0000" required>
        <p class="err" id="err" role="alert"></p>
        <button class="btn primary" type="submit">Войти в игру</button>
      </form>
      <button class="btn ghost" id="create" type="button">Я ведущий — создать игру</button>
      <p class="hint">Ведущий выводит свой экран на проектор или в трансляцию, игроки заходят с телефонов по коду.</p>
    </div>`;
  document.getElementById("join").addEventListener("submit", (e) => {
    e.preventDefault();
    const code = document.getElementById("code").value.replace(/\D/g, "");
    if (code.length !== 4) { document.getElementById("err").textContent = "Код — это 4 цифры"; return; }
    location.href = link(`room=${code}`);
  });
  document.getElementById("create").addEventListener("click", async (e) => {
    e.currentTarget.disabled = true;
    let code;
    for (let i = 0; i < 20; i++) {
      code = String(1000 + Math.floor(Math.random() * 9000));
      if (!(await store.get(`rooms/${code}/state`))) break;
    }
    await store.set(`rooms/${code}`, {
      meta: { createdAt: store.serverTs(), questions: TOTAL },
      state: { phase: "lobby", q: -1 }
    });
    location.href = link(`host=${code}`);
  });
}

/* ───────────────────────── Экран ведущего ───────────────────────── */
function runHost(code) {
  const path = `rooms/${code}`;
  const joinUrl = link(`room=${code}`);
  let room = null;
  let loaded = false;
  let busy = false;
  let qrNode = null;

  store.on(path, (v) => { room = v; loaded = true; render(); });
  setInterval(tick, 250);

  document.addEventListener("keydown", (e) => {
    if (e.target.closest("input, textarea")) return;
    if (e.code === "Space" || e.key === "Enter") { e.preventDefault(); primary(); }
  });
  app.addEventListener("click", (e) => {
    const b = e.target.closest("[data-act]");
    if (!b) return;
    const act = b.dataset.act;
    if (act === "start") startCountdown();
    else if (act === "reveal") reveal();
    else if (act === "next") next();
    else if (act === "end") { if (confirm("Завершить игру и показать итоги?")) finish(); }
    else if (act === "kick") kick(b.dataset.id);
    else if (act === "new") location.href = link();
  });

  const players = () => Object.entries(room?.players || {}).map(([id, p]) => ({ id, ...p }));
  const ranked = () => players().sort((a, b) => (b.score || 0) - (a.score || 0) || (a.joinedAt || 0) - (b.joinedAt || 0));
  const st = () => room?.state || { phase: "lobby", q: -1 };
  const answersFor = (q) => room?.answers?.[q] || {};
  const answeredCount = () => {
    const ans = answersFor(st().q);
    return players().filter((p) => ans[p.id]).length;
  };

  function primary() {
    const s = st();
    if (s.phase === "lobby" && players().length) startCountdown();
    else if (s.phase === "question") reveal();
    else if (s.phase === "reveal") next();
  }

  // Кнопка «Старт» — 5-секундный отсчёт на экране и на всех телефонах, потом первый вопрос.
  let countdownDone = null;
  async function startCountdown() {
    if (busy || st().phase !== "lobby") return; busy = true;
    try {
      await store.update(path, { state: { phase: "countdown", q: -1, startedAt: store.serverTs(), duration: SETTINGS.countdown } });
    } finally { busy = false; }
  }

  async function goTo(i) {
    if (busy) return; busy = true;
    try {
      await store.update(path, { state: { phase: "question", q: i, startedAt: store.serverTs(), duration: durationOf(i) } });
    } finally { busy = false; }
  }

  async function reveal() {
    const s = st();
    if (busy || s.phase !== "question") return; busy = true;
    try {
      const q = QUESTIONS[s.q];
      const ans = answersFor(s.q);
      const counts = [0, 0, 0, 0];
      const upd = {};
      for (const p of players()) {
        const a = ans[p.id];
        const valid = validAnswer(q, a);
        const right = valid && isCorrect(q, a);
        if (valid) { if (isTap(q)) counts[right ? 0 : 1]++; else counts[a.c]++; }
        let gain = 0, streak = p.streak || 0, correct = false;
        const elapsedMs = valid ? Math.max(0, (a.t || 0) - (s.startedAt || 0)) : 0;
        if (right) {
          correct = true;
          const elapsed = elapsedMs / 1000;
          const frac = Math.min(1, elapsed / (s.duration || SETTINGS.questionTime));
          gain = Math.round(SETTINGS.maxPoints - (SETTINGS.maxPoints - SETTINGS.minPoints) * frac);
          streak += 1;
          gain += Math.min(SETTINGS.maxStreakBonus, SETTINGS.streakBonus * (streak - 1));
        } else {
          streak = 0;
        }
        upd[`players/${p.id}/score`] = (p.score || 0) + gain;
        upd[`players/${p.id}/streak`] = streak;
        upd[`players/${p.id}/last`] = { q: s.q, gain, correct, answered: !!valid, answer: valid && !isTap(q) ? a.c : -1 };
        upd[`players/${p.id}/stats`] = nextStats(p.stats, q, {
          answered: valid, correct, elapsedMs, durationMs: (s.duration || SETTINGS.questionTime) * 1000, streak
        });
      }
      upd["state/phase"] = "reveal";
      upd["state/counts"] = counts;
      await store.update(path, upd);
    } finally { busy = false; }
  }

  function next() {
    const s = st();
    if (s.phase !== "reveal") return;
    if (s.q + 1 >= TOTAL) finish(); else goTo(s.q + 1);
  }
  const finish = () => store.update(path, { "state/phase": "final", achievements: computeAchievements(ranked()) });
  const kick = (id) => store.update(path, { [`players/${id}`]: null, [`kicked/${id}`]: true });

  function tick() {
    const s = st();
    if (s.phase === "countdown" && typeof s.startedAt === "number") {
      const left = s.startedAt + s.duration * 1000 - store.now();
      const el = document.getElementById("cd");
      if (el) el.textContent = Math.max(1, Math.ceil(left / 1000));
      if (left <= 0 && countdownDone !== s.startedAt) { countdownDone = s.startedAt; goTo(0); }
      return;
    }
    if (s.phase !== "question" || typeof s.startedAt !== "number") return;
    const left = s.startedAt + s.duration * 1000 - store.now();
    const sec = Math.max(0, Math.ceil(left / 1000));
    const t = document.getElementById("timer");
    if (t) { t.lastChild.textContent = `0:${String(sec).padStart(2, "0")}`; t.classList.toggle("low", sec <= 5); }
    const f = document.getElementById("tfill");
    if (f) f.style.width = `${Math.max(0, Math.min(100, (left / (s.duration * 1000)) * 100))}%`;
    const n = players().length;
    if (left <= 0 || (n > 0 && answeredCount() >= n)) reveal();
  }

  function topbar(right) {
    return `<header class="topbar"><span class="live">LIVE</span><span class="tb-title">${esc(SETTINGS.title)} · ${esc(SETTINGS.subtitle)}</span><span class="tb-right">${right}</span></header>`;
  }

  function render() {
    if (!loaded) return;
    if (!room) { app.innerHTML = `<div class="center-msg"><h1>Комната ${esc(code)} не найдена</h1><p>Создайте новую игру.</p><button class="btn primary" data-act="new">На главную</button></div>`; return; }
    const s = st();
    if (s.phase === "lobby") renderLobby();
    else if (s.phase === "countdown") renderCountdown();
    else if (s.phase === "final") renderFinal();
    else renderQuestion(s);
    tick();
  }

  function renderLobby() {
    const ps = players().sort((a, b) => (a.joinedAt || 0) - (b.joinedAt || 0));
    const initials = (n) => esc(String(n).trim().slice(0, 1).toUpperCase());
    const gamepad = `<svg viewBox="0 0 64 40" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="3" stroke-linejoin="round"><path d="M14 4h36a12 12 0 0 1 12 12v6a14 14 0 0 1-25 8.7L35 28h-6l-2 2.7A14 14 0 0 1 2 22v-6A12 12 0 0 1 14 4Z"/><path d="M16 14v10M11 19h10" stroke-linecap="round"/><circle cx="44" cy="15" r="2.5" fill="currentColor"/><circle cx="50" cy="21" r="2.5" fill="currentColor"/></svg>`;
    app.innerHTML = `
      <div class="host fit">
        ${topbar(`Комната <b>${esc(code)}</b>`)}
        <section class="lobby2">
          <div class="join2">
            <h1 class="join2-title">Подключайся!</h1>
            <div class="qr-frame"><div class="qr" id="qr" role="img" aria-label="QR-код для входа в игру"></div></div>
            <div class="join2-or"><span>или введи код</span></div>
            <div class="digits" aria-label="Код комнаты ${esc(code)}">${[...String(code)].map((d) => `<span>${esc(d)}</span>`).join("")}</div>
            <ol class="steps">
              <li><b>1</b>Наведи камеру на QR-код</li>
              <li><b>2</b>Напиши своё имя</li>
              <li><b>3</b>Жди старта!</li>
            </ol>
          </div>
          <div class="roster">
            <div class="roster-head">
              <h2>Игроки в лобби</h2>
              <span class="roster-count">${ps.length}</span>
            </div>
            ${ps.length
              ? `<div class="pgrid">${ps.map((p, i) => `
                  <div class="chip pcard">
                    <span class="ava a${i % 4}" aria-hidden="true">${initials(p.name)}</span>
                    <span class="pname2">${esc(p.name)}</span>
                    <button type="button" data-act="kick" data-id="${esc(p.id)}" aria-label="Убрать игрока ${esc(p.name)}">×</button>
                  </div>`).join("")}</div>`
              : `<div class="roster-empty">
                  <div class="pad-icon">${gamepad}</div>
                  <p>Ждём первых игроков</p>
                  <div class="dots" aria-hidden="true"><i></i><i></i><i></i></div>
                </div>`}
          </div>
        </section>
        <footer class="hostbar">
          <span class="grow lobby-info"><b>${TOTAL}</b> вопросов <span class="sep">·</span> <b>${SETTINGS.questionTime}</b> сек на ответ <span class="sep">·</span> очки за скорость и серии</span>
          <button class="btn primary btn-start" data-act="start" ${ps.length ? "" : "disabled"}>
            <svg width="18" height="18" viewBox="0 0 20 20" aria-hidden="true"><path d="M5 3l12 7-12 7z" fill="currentColor"/></svg>Старт
          </button>
        </footer>
      </div>`;
    const qrBox = document.getElementById("qr");
    if (!qrNode && window.QRCode) {
      qrNode = document.createElement("div");
      new window.QRCode(qrNode, { text: joinUrl, width: 320, height: 320, colorDark: "#15122B", colorLight: "#FFFFFF" });
    }
    if (qrNode) qrBox.appendChild(qrNode);
    else if (!window.QRCode) setTimeout(() => { if (st().phase === "lobby" && window.QRCode && !qrNode) render(); }, 800);
  }

  function renderCountdown() {
    const n = players().length;
    app.innerHTML = `
      <div class="host">
        ${topbar(`Игроков: <b>${n}</b>`)}
        <section class="countdown">
          <div class="cd-label">Приготовьтесь!</div>
          <div class="cd-num" id="cd" aria-live="polite">${SETTINGS.countdown}</div>
          <div class="cd-sub">${TOTAL} вопросов · первый — «${esc(QUESTIONS[0].cat)}»</div>
        </section>
      </div>`;
  }

  function renderQuestion(s) {
    const q = QUESTIONS[s.q];
    if (!q) return;
    const isReveal = s.phase === "reveal";
    const counts = s.counts || [0, 0, 0, 0];
    const totalAns = counts.reduce((a, b) => a + b, 0);
    const n = players().length;
    const top = ranked();
    const tap = isTap(q);
    const rows = tap ? "" : q.opts.map((o, i) => {
      const pct = totalAns ? Math.round((counts[i] / totalAns) * 100) : 0;
      return `<div class="orow c${i}${isReveal && i === q.a ? " right" : ""}">
          <span class="ol">${SHAPES[i]}${LETTERS[i]}</span>
          <span class="ot">${isReveal ? `<span class="ofill" style="width:${pct}%"></span>` : ""}<span style="position:relative">${esc(o)}</span></span>
          <span class="op">${isReveal ? `${pct}%` : ""}</span>
        </div>`;
    }).join("");
    app.innerHTML = `
      <div class="host">
        ${topbar(`Игроков: <b>${n}</b>`)}
        <div class="game-grid">
          <section class="stage${isReveal ? " reveal" : ""}">
            <div class="qbar">
              <div class="qnum">ВОПРОС ${s.q + 1}<small>/${TOTAL}</small></div>
              <div class="qcat">${esc(q.cat)}</div>
              ${isReveal ? "" : `<div class="qtimer" id="timer"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="13" r="8"/><path d="M12 9v4l2 2M9 2h6"/></svg><span>0:${String(s.duration).padStart(2, "0")}</span></div>`}
            </div>
            ${isReveal ? "" : `<div class="tbar"><div id="tfill"></div></div>`}
            <div class="qslab${q.image && !tap ? " with-img" : ""}"><h1>${esc(q.q)}</h1>${q.image && !tap ? `<img src="${esc(q.image)}" alt="Иллюстрация к вопросу">` : ""}</div>
            ${tap ? hostTap(q, s, isReveal, counts, totalAns) : `<div class="opts">${rows}</div>`}
            ${isReveal && q.fact ? `<div class="fact"><b>${tap ? "Ответ" : "Факт"}</b><span>${tap ? `${esc(q.answer)}. ` : ""}${esc(q.fact)}</span></div>` : ""}
          </section>
          <aside class="board" aria-label="Таблица лидеров">
            <h2>ТАБЛИЦА ЛИДЕРОВ</h2>
            ${top.slice(0, 8).map((p, i) => `<div class="brow${i === 0 && (p.score || 0) > 0 ? " first" : ""}"><span class="bn">${i + 1}</span><span class="bname">${esc(p.name)}</span><span class="bs">${fmtNum(p.score)}${isReveal && p.last?.q === s.q && p.last.gain ? `<small>+${fmtNum(p.last.gain)}</small>` : ""}</span></div>`).join("")}
            ${top.length > 8 ? `<div class="more">и ещё ${top.length - 8}</div>` : ""}
          </aside>
        </div>
        <footer class="hostbar">
          <span class="grow">${isReveal ? `Ответили ${totalAns} из ${n}` : `Ответили <b id="answered">${answeredCount()}</b> из ${n}`} · <kbd>Пробел</kbd> — дальше</span>
          <button class="btn ghost" data-act="end">Завершить</button>
          ${isReveal
            ? `<button class="btn primary" data-act="next">${s.q + 1 >= TOTAL ? "Итоги" : "Следующий вопрос →"}</button>`
            : `<button class="btn primary" data-act="reveal">Показать ответ</button>`}
        </footer>
      </div>`;
  }

  // Вопрос с тепловой картой на большом экране: во время вопроса — только счётчик касаний,
  // на ответе — все касания пятнами и правильная зона.
  function hostTap(q, s, isReveal, counts, totalAns) {
    if (!isReveal) {
      return `<div class="tapstage">${tapBoard(q)}<div class="tapcount"><span class="tc-label">Касаний</span><b id="taps">${answeredCount()}</b><span>Тепловая карта откроется после ответа</span></div></div>`;
    }
    const taps = Object.values(answersFor(s.q)).filter((a) => validAnswer(q, a)).map((a) => ({ x: a.x, y: a.y, hit: isCorrect(q, a) }));
    const hitPct = totalAns ? Math.round((counts[0] / totalAns) * 100) : 0;
    return `<div class="tapstage">${tapBoard(q, { taps, reveal: true })}<div class="tapcount reveal"><span class="tc-label">В точку</span><b>${hitPct}%</b><span>${counts[0]} из ${totalAns} попали в зону</span></div></div>`;
  }

  function renderFinal() {
    const top = ranked();
    const ach = room.achievements || {};
    const badge = (p) => ach[p.id] ? `<span class="ach-badge"><span class="ach-e" aria-hidden="true">${esc(ach[p.id].e)}</span>${esc(ach[p.id].t)}</span>` : "";
    const pod = (p, place) => p
      ? `<div class="pod p${place}"><span class="pname">${esc(p.name)}</span>${badge(p)}<span class="pscore">${fmtNum(p.score)} очков</span><div class="block">${place}</div></div>`
      : `<div class="pod p${place}"></div>`;
    const card = (p, i) => {
      const a = ach[p.id];
      return `<div class="ach-card">
          <span class="ach-big" aria-hidden="true">${esc(a?.e || "🎮")}</span>
          <div class="ach-body">
            <div class="ach-who"><b>${i + 1}. ${esc(p.name)}</b><span>${fmtNum(p.score)}</span></div>
            <div class="ach-title">${esc(a?.t || "Участник")}</div>
            <div class="ach-desc">${esc(a?.d || "")}</div>
          </div>
        </div>`;
    };
    app.innerHTML = `
      <div class="host">
        ${topbar(`Игроков: <b>${top.length}</b>`)}
        <section class="final-main">
          <h1>Итоги квиза</h1>
          <div class="podium">${pod(top[1], 2)}${pod(top[0], 1)}${pod(top[2], 3)}</div>
          <h2 class="ach-head">Достижения</h2>
          <div class="ach-grid">${top.map(card).join("")}</div>
        </section>
        <footer class="hostbar"><span class="grow">Спасибо за игру!</span><button class="btn primary" data-act="new">Новая игра</button></footer>
      </div>`;
  }
}

/* ───────────────────────── Телефон игрока ───────────────────────── */
function runPlayer(code) {
  const path = `rooms/${code}`;
  const pidKey = `quiz-pid-${code}`;
  // В тестовом режиме каждая вкладка — отдельный игрок, в боевом — игрок сохраняется при перезагрузке.
  const idStore = store.mode === "local" ? sessionStorage : localStorage;
  let pid = idStore.getItem(pidKey);
  if (!pid) {
    pid = "p" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
    idStore.setItem(pidKey, pid);
  }
  let room = null, loaded = false, lastKey = "";
  const localPick = {};
  let tapPin = null;

  // Касание картинки ставит метку; ответ отправляется кнопкой «Ответить».
  app.addEventListener("pointerdown", (e) => {
    const box = e.target.closest("#tapzone");
    if (!box) return;
    e.preventDefault();
    const r = box.getBoundingClientRect();
    const x = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    const y = Math.min(1, Math.max(0, (e.clientY - r.top) / r.height));
    tapPin = { x: Math.round(x * 10000) / 10000, y: Math.round(y * 10000) / 10000 };
    const pinEl = document.getElementById("tapzone-pin");
    if (pinEl) { pinEl.style.display = ""; pinEl.style.left = `${x * 100}%`; pinEl.style.top = `${y * 100}%`; }
    const ok = document.getElementById("tapok");
    if (ok) { ok.disabled = false; ok.textContent = "Ответить"; }
  });

  store.on(path, (v) => { room = v; loaded = true; render(); });
  setInterval(tick, 250);

  app.addEventListener("click", (e) => {
    const b = e.target.closest("[data-pick]");
    if (b) pick({ c: Number(b.dataset.pick) });
    if (e.target.closest("#tapok") && tapPin) pick({ x: tapPin.x, y: tapPin.y });
    if (e.target.closest("[data-home]")) location.href = link();
  });

  const me = () => room?.players?.[pid];
  const st = () => room?.state || { phase: "lobby", q: -1 };
  const myAnswer = (q) => room?.answers?.[q]?.[pid] ?? localPick[q];
  const ranked = () => Object.entries(room?.players || {}).map(([id, p]) => ({ id, ...p }))
    .sort((a, b) => (b.score || 0) - (a.score || 0) || (a.joinedAt || 0) - (b.joinedAt || 0));
  const place = () => ranked().findIndex((p) => p.id === pid) + 1;

  function viewKey() {
    if (!loaded) return "loading";
    if (!room) return "none";
    if (room.kicked?.[pid]) return "kicked";
    if (!me()) return "join";
    const s = st();
    if (s.phase === "lobby") return `lobby:${Object.keys(room.players || {}).length}`;
    if (s.phase === "countdown") return `countdown:${s.startedAt}`;
    if (s.phase === "question") return myAnswer(s.q) !== undefined ? `answered:${s.q}` : `q:${s.q}`;
    if (s.phase === "reveal") return `reveal:${s.q}:${me().score}:${place()}`;
    return `final:${me().score}:${place()}:${room.achievements?.[pid]?.t || ""}`;
  }

  function render() {
    const key = viewKey();
    if (key === lastKey) return;
    lastKey = key;
    const kind = key.split(":")[0];
    if (kind === "loading") return;
    if (kind === "none") return msg("Комната не найдена", `Проверь код <b>${esc(code)}</b> и попробуй ещё раз.`, true);
    if (kind === "kicked") return msg("Ты вне игры", "Ведущий убрал тебя из этой комнаты.", true);
    if (kind === "join") return renderJoin();
    if (kind === "lobby") return renderLobby();
    if (kind === "countdown") return renderCountdown();
    if (kind === "q") return renderQuestion();
    if (kind === "answered") return renderAnswered();
    if (kind === "reveal") return renderReveal();
    return renderFinal();
  }

  function msg(title, text, home) {
    app.innerHTML = `<div class="center-msg"><h1>${title}</h1><p>${text}</p>${home ? `<button class="btn primary" data-home>На главную</button>` : ""}</div>`;
  }

  function header(extra = "") {
    const s = st();
    return `<header class="ptop"><span>${s.q >= 0 ? `Вопрос ${s.q + 1}/${TOTAL}` : esc(SETTINGS.title)}</span>${extra}<span>${fmtNum(me()?.score)} очк.</span></header>`;
  }

  function renderJoin() {
    if (st().phase === "final") return msg("Игра уже закончилась", "Попроси ведущего начать новую.", true);
    app.innerHTML = `
      <div class="landing">
        <div class="brand"><span class="live">LIVE</span><h1>${esc(SETTINGS.title)}<span>.</span></h1><p>Комната ${esc(code)}</p></div>
        <form class="card" id="jf" novalidate>
          <label for="nm">Как тебя зовут?</label>
          <input id="nm" class="name" maxlength="16" autocomplete="nickname" placeholder="Имя или ник" value="${esc(localStorage.getItem("quiz-name") || "")}">
          <p class="err" id="err" role="alert"></p>
          <button class="btn primary" type="submit">Играть!</button>
        </form>
        <p class="hint">Пиши настоящее имя или добрый ник — его увидят все на экране.</p>
      </div>`;
    document.getElementById("jf").addEventListener("submit", async (e) => {
      e.preventDefault();
      const name = document.getElementById("nm").value.replace(/\s+/g, " ").trim().slice(0, 16);
      if (name.length < 2) { document.getElementById("err").textContent = "Нужно хотя бы 2 символа"; return; }
      e.submitter && (e.submitter.disabled = true);
      localStorage.setItem("quiz-name", name);
      await store.set(`${path}/players/${pid}`, { name, score: 0, streak: 0, joinedAt: store.serverTs() });
    });
  }

  function renderLobby() {
    const n = Object.keys(room.players || {}).length;
    app.innerHTML = `<div class="player">${header()}
      <div class="pwait"><div class="spinner" aria-hidden="true"></div>
        <h1>Ты в игре, ${esc(me().name)}!</h1>
        <p>Смотри на экран ведущего — скоро начнём.<br>Уже в комнате: <b>${n}</b></p></div></div>`;
  }

  function renderCountdown() {
    app.innerHTML = `<div class="player">${header()}
      <div class="pwait countdown">
        <div class="cd-label">Приготовься, ${esc(me().name)}!</div>
        <div class="cd-num" id="cd" aria-live="polite">${SETTINGS.countdown}</div>
        <p>Сейчас будет первый вопрос</p>
      </div></div>`;
    tick();
  }

  function qImage(q) { return q.image ? `<img src="${esc(q.image)}" alt="Иллюстрация к вопросу">` : ""; }

  function renderQuestion() {
    const s = st(); const q = QUESTIONS[s.q];
    if (!q) return;
    if (isTap(q)) {
      tapPin = null;
      app.innerHTML = `<div class="player">${header(`<span class="pt" id="pt">${s.duration}</span>`)}
        <div class="pq"><span class="pcat">${esc(q.cat)}</span><h2>${esc(q.q)}</h2></div>
        <div class="ptap">
          ${tapBoard(q, { id: "tapzone", interactive: true })}
          <p class="taphint">Коснись картинки, чтобы поставить метку. Можно передвинуть.</p>
          <button type="button" class="btn primary tapok" id="tapok" disabled>Поставь метку</button>
        </div>
      </div>`;
      tick();
      return;
    }
    app.innerHTML = `<div class="player">${header(`<span class="pt" id="pt">${s.duration}</span>`)}
      <div class="pq"><span class="pcat">${esc(q.cat)}</span><h2>${esc(q.q)}</h2>${qImage(q)}</div>
      <div class="popts">${q.opts.map((o, i) => `<button type="button" class="opt c${i}" data-pick="${i}"><span class="ol">${SHAPES[i]}${LETTERS[i]}</span><span>${esc(o)}</span></button>`).join("")}</div>
    </div>`;
    tick();
  }

  async function pick(ans) {
    const s = st();
    if (s.phase !== "question" || myAnswer(s.q) !== undefined) return;
    localPick[s.q] = ans;
    render();
    await store.set(`${path}/answers/${s.q}/${pid}`, { ...ans, t: store.serverTs() });
  }

  function renderAnswered() {
    const s = st(); const q = QUESTIONS[s.q]; const my = myAnswer(s.q); const c = my?.c;
    app.innerHTML = `<div class="player">${header(`<span class="pt" id="pt"></span>`)}
      <div class="pwait">
        <h1>Ответ принят!</h1>
        ${isTap(q)
          ? `<div class="ptap small">${tapBoard(q, { pin: my })}</div>`
          : `<span class="chosen opt c${c}">${SHAPES[c]}${LETTERS[c]} · ${esc(q.opts[c])}</span>`}
        <p>Ждём остальных и смотрим на экран.</p>
      </div></div>`;
    tick();
  }

  function renderReveal() {
    const s = st(); const q = QUESTIONS[s.q]; const m = me();
    const last = m.last && m.last.q === s.q ? m.last : null;
    const answered = last ? !!last.answered : myAnswer(s.q) !== undefined;
    const my = myAnswer(s.q);
    const ok = last?.correct;
    const cls = ok ? "ok" : answered ? "bad" : "none";
    const title = ok ? "Верно!" : answered ? "Мимо!" : "Время вышло";
    app.innerHTML = `<div class="player">${header()}
      <div class="result ${cls}"><h1>${title}</h1>${ok ? `<span class="gain">+${fmtNum(last.gain)}</span>` : ""}${ok && m.streak > 1 ? `<span>Серия: ${m.streak} подряд</span>` : ""}</div>
      <div class="pinfo">
        ${isTap(q)
          ? `<div class="ptap small">${tapBoard(q, { reveal: true, pin: my ? { ...my, cls: ok ? "hit" : "miss" } : null })}</div><div class="row"><b>Правильный ответ</b>${esc(q.answer)}</div>`
          : `<div class="row"><b>Правильный ответ</b>${LETTERS[q.a]} · ${esc(q.opts[q.a])}</div>`}
        ${q.fact ? `<div class="row"><b>Факт</b>${esc(q.fact)}</div>` : ""}
        <div class="row"><b>Твоё место</b>${place()} из ${ranked().length} · ${fmtNum(m.score)} очков</div>
      </div></div>`;
  }

  function renderFinal() {
    const p = place(); const n = ranked().length; const a = room.achievements?.[pid];
    app.innerHTML = `<div class="player">${header()}
      <div class="pwait">
        <h1>Игра окончена!</h1>
        <div class="big">${p} место</div>
        <p>из ${n} игроков · ${fmtNum(me().score)} очков</p>
        ${a ? `<div class="my-ach"><span class="ach-big" aria-hidden="true">${esc(a.e)}</span><span class="my-ach-label">Твоё достижение</span><span class="ach-title">${esc(a.t)}</span><span class="ach-desc">${esc(a.d)}</span></div>` : ""}
        <p>${p === 1 ? "Ты чемпион квиза!" : p <= 3 ? "Ты на пьедестале — отличный результат!" : "Классная игра! Приходи на следующий квиз."}</p>
      </div></div>`;
  }

  function tick() {
    const s = st();
    const cd = document.getElementById("cd");
    if (cd && s.phase === "countdown" && typeof s.startedAt === "number") {
      cd.textContent = Math.max(1, Math.ceil((s.startedAt + s.duration * 1000 - store.now()) / 1000));
      return;
    }
    const el = document.getElementById("pt");
    if (!el || s.phase !== "question" || typeof s.startedAt !== "number") return;
    const sec = Math.max(0, Math.ceil((s.startedAt + s.duration * 1000 - store.now()) / 1000));
    el.textContent = sec;
    el.classList.toggle("low", sec <= 5);
  }
}
