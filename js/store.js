// Связь между экраном ведущего и телефонами — как в квизе «Волшебный мир анимации»:
// публичные MQTT-брокеры по WebSocket, сразу несколько параллельно. Свой сервер и база не нужны.
//
// Ведущий хранит всё состояние игры у себя и рассылает его игрокам.
// Игроки отправляют ведущему только «вход в игру» и «мой ответ».
//
// Тестовый режим без интернета: добавьте ?local=1 к адресу — всё работает во вкладках одного браузера.

const params = new URLSearchParams(location.search);
export const IS_LOCAL = params.has("local");

const BROKERS = params.get("broker") ? [params.get("broker")] : [
  "wss://broker.emqx.io:8084/mqtt",
  "wss://broker.hivemq.com:8884/mqtt",
  "wss://broker-cn.emqx.io:8084/mqtt"
];
const TOPIC_ROOT = "cyberquiz-esq26/";
const TS = { ".sv": "timestamp" };

// ───── общие помощники для дерева данных ─────
const parts = (p) => p.split("/").filter(Boolean);
const getAt = (tree, p) => parts(p).reduce((n, k) => (n == null ? undefined : n[k]), tree);
const setAt = (tree, p, v) => {
  const ks = parts(p); let n = tree;
  for (let i = 0; i < ks.length - 1; i++) { if (typeof n[ks[i]] !== "object" || n[ks[i]] === null) n[ks[i]] = {}; n = n[ks[i]]; }
  if (v === null || v === undefined) delete n[ks[ks.length - 1]]; else n[ks[ks.length - 1]] = v;
};
const clone = (v) => (v === undefined ? null : JSON.parse(JSON.stringify(v)));
const rnd = (n = 12) => Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) => "abcdefghijklmnopqrstuvwxyz0123456789"[b % 36]).join("");

function listenerSet(readTree) {
  const listeners = new Set();
  return {
    add(path, cb) { const l = { path, cb, last: undefined }; listeners.add(l); return () => listeners.delete(l); },
    notify() {
      const tree = readTree();
      for (const l of listeners) {
        const v = clone(getAt(tree, l.path));
        const s = JSON.stringify(v);
        if (s !== l.last) { l.last = s; l.cb(v); }
      }
    }
  };
}

export async function createStore() {
  return IS_LOCAL ? localStore() : mqttStore();
}

/* ───────────────────────── Тестовый режим ───────────────────────── */
function localStore() {
  const KEY = "esports-quiz-local-db";
  const channel = "BroadcastChannel" in window ? new BroadcastChannel("esports-quiz") : null;
  const read = () => { try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch { return {}; } };
  const ls = listenerSet(read);
  const write = (tree) => { localStorage.setItem(KEY, JSON.stringify(tree)); ls.notify(); channel && channel.postMessage("changed"); };
  channel && (channel.onmessage = () => ls.notify());
  window.addEventListener("storage", (e) => { if (e.key === KEY) ls.notify(); });
  return {
    mode: "local",
    now: () => Date.now(),
    serverTs: () => Date.now(),
    get: async (p) => clone(getAt(read(), p)),
    set: async (p, v) => { const t = read(); setAt(t, p, clone(v)); write(t); },
    update: async (p, obj) => { const t = read(); for (const [k, v] of Object.entries(obj)) setAt(t, p + "/" + k, clone(v)); write(t); },
    on: (p, cb) => { const off = ls.add(p, cb); setTimeout(ls.notify, 0); return off; },
    onConnection: (cb) => cb(true)
  };
}

/* ───────────────────────── Онлайн через MQTT ───────────────────────── */
function mqttNet({ subs, onMsg, onStatus }) {
  const seen = new Set(), seenQ = [];
  const clients = [];
  const status = () => onStatus && onStatus(clients.some((c) => c.connected));
  if (!window.mqtt) { setTimeout(status, 0); return { pub() {}, connected: () => false }; }
  BROKERS.forEach((url) => {
    let c;
    try {
      c = window.mqtt.connect(url, { clientId: "esq_" + rnd(12), keepalive: 20, reconnectPeriod: 3000, connectTimeout: 9000, clean: true, protocolVersion: 4 });
    } catch { return; }
    c.on("connect", () => { c.subscribe(subs, { qos: 1 }); status(); });
    c.on("close", status);
    c.on("offline", status);
    c.on("error", () => {});
    c.on("message", (topic, payload, packet) => {
      const raw = payload.toString();
      if (!raw) return;
      let obj; try { obj = JSON.parse(raw); } catch { return; }
      if (obj && obj.mid) {
        if (seen.has(obj.mid)) return;
        seen.add(obj.mid); seenQ.push(obj.mid);
        if (seenQ.length > 3000) seen.delete(seenQ.shift());
      }
      onMsg(topic, obj, !!(packet && packet.retain));
    });
    clients.push(c);
  });
  return {
    pub(topic, obj, retain = false) {
      const payload = JSON.stringify(obj);
      clients.forEach((c) => { if (c.connected) try { c.publish(topic, payload, { qos: 1, retain }); } catch {} });
    },
    connected: () => clients.some((c) => c.connected)
  };
}

function mqttStore() {
  const hostCode = params.get("host");
  const roomCode = params.get("room");

  // Стартовая страница: создание комнаты просто кладёт её в память браузера ведущего.
  if (!hostCode && !roomCode) {
    return {
      mode: "mqtt",
      now: () => Date.now(),
      serverTs: () => Date.now(),
      get: async () => null,
      set: async (p, v) => { const code = parts(p)[1]; localStorage.setItem("esq-host-" + code, JSON.stringify(v)); },
      update: async () => {},
      on: () => () => {},
      onConnection: (cb) => cb(true)
    };
  }
  return hostCode ? mqttHost(String(hostCode).trim()) : mqttPlayer(String(roomCode).trim());
}

/* Ведущий: главный экземпляр данных. */
function mqttHost(code) {
  const base = TOPIC_ROOT + code;
  const KEY = "esq-host-" + code;
  const tree = { rooms: {} };
  const ls = listenerSet(() => tree);
  let ready = false, lastV = 0, pubTimer = null, statusCb = null;

  try { const saved = JSON.parse(localStorage.getItem(KEY)); if (saved) { tree.rooms[code] = saved; ready = true; } } catch {}

  const room = () => tree.rooms[code];

  function snapshot() {
    const r = room();
    if (!r) return null;
    const q = r.state?.q;
    const wire = { ...r, answers: q >= 0 && r.answers?.[q] ? { [q]: r.answers[q] } : {} };
    lastV = Math.max(lastV + 1, Date.now());
    return { v: lastV, hostNow: Date.now(), room: wire };
  }
  function publishNow() { pubTimer = null; const s = snapshot(); if (s) net.pub(base + "/s", s, true); }
  function changed() {
    if (room()) { try { localStorage.setItem(KEY, JSON.stringify(room())); } catch {} }
    ls.notify();
    if (!pubTimer) pubTimer = setTimeout(publishNow, 120);
  }
  const fixTs = (v) => {
    if (v && typeof v === "object") {
      if (v[".sv"] === "timestamp") return Date.now();
      for (const k of Object.keys(v)) v[k] = fixTs(v[k]);
    }
    return v;
  };

  // Проверка сообщений от игроков: разрешено только войти в игру и ответить на текущий вопрос.
  function applyOp(o) {
    const r = room();
    if (!r || !o || o.op !== "set" || typeof o.path !== "string") return;
    const ps = parts(o.path);
    if (ps.length === 2 && ps[0] === "players" && /^[a-z0-9]{6,32}$/i.test(ps[1])) {
      const pid = ps[1];
      if (r.kicked?.[pid] || r.players?.[pid]) return;
      if (r.state?.phase === "final") return;
      const name = String(o.value?.name ?? "").replace(/\s+/g, " ").trim().slice(0, 16);
      if (name.length < 2) return;
      setAt(r, `players/${pid}`, { name, score: 0, streak: 0, joinedAt: Date.now() });
      changed();
    } else if (ps.length === 3 && ps[0] === "answers") {
      const q = Number(ps[1]), pid = ps[2];
      const c = o.value?.c;
      if (r.state?.phase !== "question" || r.state.q !== q) return;
      if (!r.players?.[pid] || r.answers?.[q]?.[pid]) return;
      if (!Number.isInteger(c) || c < 0 || c > 3) return;
      setAt(r, `answers/${q}/${pid}`, { c, t: Date.now() });
      changed();
    }
  }

  const net = mqttNet({
    subs: [base + "/in", base + "/s"],
    onStatus: (ok) => { statusCb && statusCb(ok); if (ok && ready) publishNow(); },
    onMsg: (topic, obj, retained) => {
      if (topic === base + "/in") applyOp(obj);
      else if (topic === base + "/s" && !ready && obj?.room) {
        // Ведущий открыл игру на другом компьютере или очистил браузер — восстанавливаемся из последнего снимка.
        tree.rooms[code] = obj.room; ready = true; lastV = obj.v || 0; changed();
      }
    }
  });
  setInterval(() => { if (ready && net.connected()) publishNow(); }, 5000);
  setTimeout(() => { if (!ready) { ready = true; ls.notify(); } }, 4000);

  return {
    mode: "mqtt",
    now: () => Date.now(),
    serverTs: () => Date.now(),
    get: async (p) => clone(getAt(tree, p)),
    set: async (p, v) => { setAt(tree, p, clone(v)); changed(); },
    update: async (p, obj) => { for (const [k, v] of Object.entries(obj)) setAt(tree, p + "/" + k, clone(v)); changed(); },
    on: (p, cb) => {
      const off = ls.add(p, cb);
      const fire = () => (ready ? ls.notify() : setTimeout(fire, 200));
      setTimeout(fire, 0);
      return off;
    },
    onConnection: (cb) => { statusCb = cb; cb(net.connected()); }
  };
}

/* Игрок: получает снимки от ведущего, отправляет вход и ответы. */
function mqttPlayer(code) {
  const base = TOPIC_ROOT + code;
  const tree = { rooms: {} };
  const ls = listenerSet(() => tree);
  let lastV = 0, offset = 0, got = false, statusCb = null;
  const pending = new Map();

  const net = mqttNet({
    subs: [base + "/s"],
    onStatus: (ok) => statusCb && statusCb(ok),
    onMsg: (topic, obj, retained) => {
      if (!obj?.room || !(obj.v > lastV)) return;
      lastV = obj.v;
      if (!retained && obj.hostNow) offset = obj.hostNow - Date.now();
      tree.rooms[code] = obj.room;
      got = true;
      ls.notify();
      for (const [p] of pending) if (getAt(tree, p) != null) pending.delete(p);
    }
  });

  // Повторяем вход/ответ, пока ведущий не подтвердит (сообщения могут теряться).
  setInterval(() => {
    for (const [p, item] of pending) {
      if (getAt(tree, p) != null || item.tries >= 6) { pending.delete(p); continue; }
      item.tries++; net.pub(base + "/in", { mid: rnd(12), op: "set", path: item.rel, value: item.value });
    }
  }, 2500);

  const rel = (p) => parts(p).slice(2).join("/");

  return {
    mode: "mqtt",
    now: () => Date.now() + offset,
    serverTs: () => TS,
    get: async (p) => clone(getAt(tree, p)),
    set: async (p, v) => {
      const r = rel(p);
      pending.set(p, { rel: r, value: v, tries: 0 });
      net.pub(base + "/in", { mid: rnd(12), op: "set", path: r, value: v });
    },
    update: async () => {},
    on: (p, cb) => {
      const off = ls.add(p, cb);
      // Если ведущий не отвечает 10 секунд — сообщаем, что комната не найдена (появится сама, когда он подключится).
      setTimeout(() => { if (!got) cb(null); }, 10000);
      if (got) setTimeout(ls.notify, 0);
      return off;
    },
    onConnection: (cb) => { statusCb = cb; cb(net.connected()); }
  };
}
