// Статистика игроков и достижения в конце игры.
// Каждый игрок получает своё достижение: сначала раздаются особые награды
// (каждая — одному лучшему игроку), остальным — личные звания по их результатам.

import { QUESTIONS } from "./questions.js";

const bucket = (q) => (q.cat.startsWith("Dota") ? "dota" : q.cat.startsWith("CS") ? "cs" : "misc");
const TOTALS = QUESTIONS.reduce((t, q) => { t[bucket(q)]++; if (q.hard) t.hard++; return t; }, { dota: 0, cs: 0, misc: 0, hard: 0 });

const sec = (ms) => (ms / 1000).toLocaleString("ru-RU", { maximumFractionDigits: 1 });
const plural = (n, one, few, many) => {
  const m10 = n % 10, m100 = n % 100;
  return m10 === 1 && m100 !== 11 ? one : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? few : many;
};
const answersWord = (n) => `${n} ${plural(n, "верный ответ", "верных ответа", "верных ответов")}`;

// Обновляет статистику игрока после вопроса.
const EMPTY = { ok: 0, ans: 0, best: 0, fast: null, dota: 0, cs: 0, misc: 0, hard: 0, clutch: 0 };
const withDefaults = (s) => ({ ...EMPTY, ...(s || {}) });

export function nextStats(prev, q, { answered, correct, elapsedMs, durationMs, streak }) {
  const s = withDefaults(prev);
  if (answered) s.ans++;
  if (correct) {
    s.ok++;
    s[bucket(q)]++;
    if (q.hard) s.hard++;
    if (s.fast == null || elapsedMs < s.fast) s.fast = Math.round(elapsedMs);
    if (durationMs - elapsedMs <= 5000) s.clutch++;
  }
  s.best = Math.max(s.best, streak);
  return s;
}

// Особые награды — по одной на игру. power(p) — насколько игрок силён в этом (0…1),
// ok(p) — минимальный порог, чтобы награда была заслуженной.
const third = (n) => Math.max(1, Math.ceil(n / 3));
const SPECIAL = [
  { e: "⚡", t: "Молния", ok: (p) => p.s.fast != null && p.s.fast <= 6000, power: (p) => 1 - p.s.fast / 10000,
    d: (p) => `Самый быстрый верный ответ — за ${sec(p.s.fast)} с` },
  { e: "🔥", t: "Неудержимый", ok: (p) => p.s.best >= 3, power: (p) => Math.min(1, p.s.best / 8),
    d: (p) => `${p.s.best} ${plural(p.s.best, "верный ответ", "верных ответа", "верных ответов")} подряд` },
  { e: "🧠", t: "Мозг хардкора", ok: (p) => p.s.hard >= 2, power: (p) => p.s.hard / TOTALS.hard,
    d: (p) => `${p.s.hard} из ${TOTALS.hard} трудных вопросов по CS 2` },
  { e: "🧙", t: "Знаток Доты", ok: (p) => p.s.dota >= third(TOTALS.dota), power: (p) => p.s.dota / TOTALS.dota,
    d: (p) => `${p.s.dota} из ${TOTALS.dota} вопросов по Dota 2` },
  { e: "🎯", t: "Мастер CS 2", ok: (p) => p.s.cs >= third(TOTALS.cs), power: (p) => p.s.cs / TOTALS.cs,
    d: (p) => `${p.s.cs} из ${TOTALS.cs} вопросов по CS 2` },
  { e: "📚", t: "Эрудит", ok: (p) => p.s.misc >= third(TOTALS.misc), power: (p) => p.s.misc / TOTALS.misc,
    d: (p) => `${p.s.misc} из ${TOTALS.misc} вопросов «Разминки» и «Разного»` },
  { e: "❄️", t: "Хладнокровие", ok: (p) => p.s.clutch >= 2, power: (p) => Math.min(1, p.s.clutch / 5),
    d: (p) => `${p.s.clutch} ${plural(p.s.clutch, "верный ответ", "верных ответа", "верных ответов")} в последние 5 секунд` },
  { e: "🏹", t: "Снайпер", ok: (p) => p.s.ans >= 5 && p.s.ok / p.s.ans >= 0.6, power: (p) => p.s.ok / p.s.ans,
    d: (p) => `Точность ${Math.round((p.s.ok / p.s.ans) * 100)}% — почти без промахов` },
  { e: "🏃", t: "Марафонец", ok: (p) => p.s.ans >= Math.ceil(QUESTIONS.length * 0.9), power: (p) => p.s.ans / QUESTIONS.length,
    d: (p) => `Ответил(а) на ${p.s.ans} из ${QUESTIONS.length} вопросов` }
];
const CHAMPION = { e: "🏆", t: "Чемпион квиза" };

// Личные звания для всех остальных — у соседей по таблице они разные.
const PERSONAL = [
  { e: "💪", t: "Боец" },
  { e: "⭐", t: "Восходящая звезда" },
  { e: "🧩", t: "Стратег" },
  { e: "🤝", t: "Командный дух" },
  { e: "🛡️", t: "Надёжный тыл" },
  { e: "🎮", t: "Настоящий геймер" },
  { e: "🚀", t: "На взлёте" },
  { e: "🦾", t: "Киберспортсмен" }
];
const NEWBIE = { e: "🌱", t: "Смелый новичок", d: "Главное — участие! В следующий раз верных ответов будет больше" };

// players: [{ id, name, score, stats }], уже отсортированные по месту.
export function computeAchievements(players) {
  const list = players.map((p, i) => ({ id: p.id, score: p.score || 0, place: i + 1, s: withDefaults(p.stats) }));
  const result = {};

  // 1. Победитель — всегда «Чемпион квиза».
  const top = list[0];
  if (top && top.score > 0) result[top.id] = { ...CHAMPION, d: `Больше всех очков: ${top.score.toLocaleString("ru-RU")}` };

  // 2. Особые награды: каждому игроку — та, в которой он сильнее всего,
  //    каждая награда — лучшему в ней. Раздаём от самых ярких сочетаний к слабым.
  const pairs = [];
  for (const a of SPECIAL) for (const p of list) if (!result[p.id] && a.ok(p)) pairs.push({ a, p, power: a.power(p) });
  pairs.sort((x, y) => y.power - x.power || y.p.score - x.p.score);
  const used = new Set();
  for (const { a, p } of pairs) {
    if (used.has(a.t) || result[p.id]) continue;
    used.add(a.t);
    result[p.id] = { e: a.e, t: a.t, d: a.d(p) };
  }

  // 3. Остальным — личные звания.
  let k = 0;
  for (const p of list) {
    if (result[p.id]) continue;
    if (!p.s.ok) { result[p.id] = { ...NEWBIE }; continue; }
    const a = PERSONAL[k++ % PERSONAL.length];
    result[p.id] = { e: a.e, t: a.t, d: `${answersWord(p.s.ok)} · ${p.score.toLocaleString("ru-RU")} очков` };
  }
  return result;
}
