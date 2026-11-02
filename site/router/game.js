// Farming economy from deadlock.wiki (Crate, Buff_Container, Souls, Denizens, Sinner's_Sacrifice
// pages; checked 2026-10-29). Update these when a patch changes them.

// The wiki's soul icon and its color (sampled from the icon: rgb 176, 255, 224). The wiki CDN
// refuses hotlinked requests that carry a referrer, so the <img> is sent without one.
export const SOUL_ICON = "https://cdn.deadlock.wiki/thumb/Souls.png/28px-Souls.png";
export const SOUL_COLOR = "#b0ffe0";

// category: which farming toggle a target belongs to
export const BOX_TYPES = {
  crate: { label: "Crate", color: "#c58b4c", category: "box", souls: 23, perMin: 2, chance: 0.6, buffChance: 0 },
  tough: { label: "Tough crate", color: "#46c2c9", category: "box", souls: 46, perMin: 4, chance: 1, buffChance: 0 },
  buff: { label: "Golden statue", color: "#ffd54a", category: "box", souls: 0, perMin: 0, chance: 0, buffChance: 0.5 },
  camp: { label: "Jungle camp", color: "#ef7b6c", category: "camp" },
  sinner: { label: "Sinner's Sacrifice", color: "#b98cf0", category: "sinner" },
};
export const CATEGORIES = {
  box: "Boxes",
  camp: "Jungle camps",
  sinner: "Sinner's Sacrifices",
};
export const isBox = (b) => BOX_TYPES[b.type].category === "box";

// Haunts grow by 1.08% of their base value per minute; health grows 2.1% per minute.
export const HAUNTS = {
  small: { souls: 41, perMin: 0.44, hp: 129 },
  medium: { souls: 68, perMin: 0.73, hp: 322 },
  large: { souls: 181, perMin: 1.95, hp: 1133 },
};
export const SINNER = { souls: 310, perMin: 3.35 }; // breaks in 4 heavy melees; jackpot gives buffs

// Expected souls from breaking/clearing target b at game time t (seconds). Soul scaling starts at
// 0:00 even though boxes first spawn at 3:00.
export function targetSouls(b, t) {
  const m = t / 60, bt = BOX_TYPES[b.type];
  if (bt.category === "box") return bt.chance * (bt.souls + bt.perMin * m);
  let s = 0;
  for (const [k, n] of Object.entries(b.haunts ?? {})) s += n * (HAUNTS[k].souls + HAUNTS[k].perMin * m);
  return s + (b.sinners ?? 0) * (SINNER.souls + SINNER.perMin * m);
}

// Seconds spent at target b at game time t: breaking a box, or killing a camp's haunts at your
// damage per second and hitting its Sinner's Sacrifices.
export function serviceTime(b, t, p) {
  if (BOX_TYPES[b.type].category === "box") return p.breakTime;
  let hp = 0;
  for (const [k, n] of Object.entries(b.haunts ?? {})) hp += n * HAUNTS[k].hp;
  // TODO(human): this treats a camp as one pool of health melted at a flat DPS. Adjust it if
  // clearing works differently in game (e.g. AoE hitting several haunts at once, or a minimum time).
  const dps = p.campDps + (p.campDpsPerMin ?? 0) * (t / 60);
  return hp * (1 + 0.021 * (t / 60)) / dps + (b.sinners ?? 0) * p.sinnerTime + p.breakTime;
}

// Expected permanent buffs from a target.
export const targetBuffs = (b, p) => (b.type === "buff" ? BOX_TYPES.buff.buffChance : (b.sinners ?? 0) * p.sinnerBuffs);

// Booklet potency: level 1 from 0:00, level 2 from 10:00, level 3 from 30:00.
export const buffLevel = (gameSeconds) => (gameSeconds >= 1800 ? 3 : gameSeconds >= 600 ? 2 : 1);

export const fmtClock = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
export function parseClock(text) {
  const m = String(text).trim().match(/^(\d+)(?::(\d{1,2}))?$/);
  if (!m) return null;
  return m[2] === undefined ? Number(m[1]) * 60 : Number(m[1]) * 60 + Number(m[2]);
}
