// Вопросы с тепловой картой: игрок касается картинки, в ответе — координаты касания.

export const W = 640, H = 360; // размер картинок (viewBox)
export const isTap = (q) => q?.type === "tap";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const pct = (v) => `${(v * 100).toFixed(2)}%`;

export function validAnswer(q, a) {
  if (!a) return false;
  if (isTap(q)) return Number.isFinite(a.x) && Number.isFinite(a.y) && a.x >= 0 && a.x <= 1 && a.y >= 0 && a.y <= 1;
  return Number.isInteger(a.c) && a.c >= 0 && a.c < 4;
}

export function isCorrect(q, a) {
  if (!validAnswer(q, a)) return false;
  if (!isTap(q)) return a.c === q.a;
  const x = a.x * W, y = a.y * H, z = q.zone;
  return x >= z.x1 && x <= z.x2 && y >= z.y1 && y <= z.y2;
}

// Картинка с тепловой картой.
// taps: [{x, y, hit}] — все касания (показываются только при reveal)
// pin: {x, y, cls} — своя метка игрока
export function tapBoard(q, { taps = [], reveal = false, pin = null, id = "", interactive = false } = {}) {
  const z = q.zone;
  const zone = `left:${pct(z.x1 / W)};top:${pct(z.y1 / H)};width:${pct((z.x2 - z.x1) / W)};height:${pct((z.y2 - z.y1) / H)}`;
  const dots = reveal
    ? taps.map((t, i) => {
        const pos = `left:${pct(t.x)};top:${pct(t.y)};animation-delay:${Math.min(i * 60, 2000)}ms`;
        return `<i class="heat" style="${pos}"></i><i class="dot ${t.hit ? "hit" : "miss"}" style="${pos}"></i>`;
      }).join("")
    : "";
  return `<div class="tapbox${interactive ? " interactive" : ""}"${id ? ` id="${id}"` : ""}>
      <img src="${esc(q.image)}" alt="Картинка для ответа касанием" draggable="false">
      ${reveal ? `<div class="tz" style="${zone}"></div>` : ""}
      <div class="heatlayer">${dots}</div>
      <i class="pin ${pin?.cls || ""}" id="${id ? id + "-pin" : ""}" style="${pin ? `left:${pct(pin.x)};top:${pct(pin.y)}` : "display:none"}"></i>
    </div>`;
}
