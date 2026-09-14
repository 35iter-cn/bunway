// 自适应:≥1M 用 M 档压缩,1k~1M 千分位,<1k 原样
export const fmtTok = (v) => {
  const n = v ?? 0;
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + "M";
  if (n >= 1000) return n.toLocaleString("en-US");
  return String(n);
};

export const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const pad2 = (n) => String(n).padStart(2, "0");

export const localHM = (ts) => {
  const d = new Date(ts);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
};

export const hm = (min) => `${pad2(Math.floor(min / 60))}:${pad2(min % 60)}`;

export const offsetLabel = () => {
  const off = -new Date().getTimezoneOffset();
  const abs = Math.abs(off);
  return `UTC${off < 0 ? "-" : "+"}${pad2(Math.floor(abs / 60))}:${pad2(abs % 60)}`;
};

export const dayMark = (ts, ref = Date.now()) => {
  const d = new Date(ts);
  const n = new Date(ref);
  const days = Math.round(
    (new Date(d.getFullYear(), d.getMonth(), d.getDate()) - new Date(n.getFullYear(), n.getMonth(), n.getDate())) / 86_400_000
  );
  if (days === 0) return "Today";
  if (days === 1) return "Tomorrow";
  return DAY_NAMES[d.getDay()];
};

const toMins = (t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));

export const localWindow = (w) => {
  const offset = -new Date().getTimezoneOffset();
  const start = toMins(w.slice(0, 5));
  const end = w.slice(6) === "24:00" ? 1440 : toMins(w.slice(6));
  return {
    from: (start + offset + 1440) % 1440,
    to: (end + offset) % 1440,
    dayShift: Math.floor((start + offset) / 1440),
    crosses: end + offset >= 1440,
  };
};

export const windowLabel = (w) => {
  const l = localWindow(w);
  return `${hm(l.from)}–${hm(l.to)}${l.crosses ? " (next day)" : ""}`;
};

export const dayList = (days, shift = 0) => {
  if (!days || days.length === 7) return "";
  const ds = [...new Set(days.map((d) => (d + shift + 7) % 7))].sort((a, b) => a - b);
  const run = ds.length >= 3 && ds.every((d, i) => i === 0 || d === ds[i - 1] + 1);
  return run ? `${DAY_NAMES[ds[0]]}–${DAY_NAMES[ds[ds.length - 1]]} ` : `${ds.map((d) => DAY_NAMES[d]).join("/")} `;
};