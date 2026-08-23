// =============================================================
// TIDEWRECK ISLAND — ui.js
// Owns every menu, HUD element, modal and end screen. All DOM is
// built inside #ui. Styling lives entirely in public/style.css.
// Export: initUI(ctx) -> { update(dt,t), toast(text,kind), openShop(), closeAll() }
// =============================================================

import {
  MSG, MUTATIONS, FISH, ARTIFACTS, AREAS, SHOP, ECON, EVENTS,
  PLAYER_COLORS, PLAYER_MAX_HP, WEATHER, FLOPPER,
  LOOT_TYPES, FOUND_BAITS, UNIQUE_CHARMS, CAST_PERFECT, REVIVE,
  fishById, shopById, quotaTarget, wardPrice,
} from '/shared/constants.js';

// ---------------------------------------------------------------
// Optional fish icon factory from fish.js. Loaded dynamically so a
// missing/renamed export can never break the whole UI module.
// ---------------------------------------------------------------
let _iconFn = null;
let _iconStyle = 0; // 0 = untested, 1 = (fishDef,mut,size), 2 = (fishId,mut,size), -1 = unusable
const _iconCache = new Map();
import('./fish.js').then((m) => {
  if (m && typeof m.createFishIconDataURL === 'function') {
    _iconFn = m.createFishIconDataURL;
    _iconStyle = 0;
    _iconCache.clear();
    document.querySelectorAll('img.fish-icon[data-fkey]').forEach((img) => {
      img.src = fishIcon(img.dataset.fid, img.dataset.fmut || null);
    });
  }
}).catch(() => { /* fish.js not present or failed — fallback icons are used */ });

// ---------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------
const LS_NAME = 'tidewreck.name';
const LS_COLOR = 'tidewreck.color';
const LS_HAT = 'tidewreck.hat';
const LS_SKIN = 'tidewreck.skin';
const LS_DIVEHINT = 'tidewreck.divehint';
const TAU = Math.PI * 2;

function hex(c) { return '#' + ((c >>> 0) & 0xffffff).toString(16).padStart(6, '0'); }
function el(tag, cls, html) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html != null) e.innerHTML = html;
  return e;
}
function setText(node, s) { if (node && node.textContent !== s) node.textContent = s; }
function setHTML(node, s) { if (node && node._h !== s) { node._h = s; node.innerHTML = s; } }
function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }
function num(v, d) { return (typeof v === 'number' && isFinite(v)) ? v : d; }
// clamp anything (string from localStorage, stray payload field) into 0..n-1
function idx(v, n) {
  const i = Math.floor(num(typeof v === 'string' ? parseInt(v, 10) : v, 0));
  return i < 0 ? 0 : i >= n ? n - 1 : i;
}
function money(n) { return Math.round(num(n, 0)).toLocaleString('en-US'); }
function prettyKey(k) {
  return String(k).replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ')
    .replace(/^./, (c) => c.toUpperCase());
}
function titleCase(s) { return String(s || '').replace(/^./, (c) => c.toUpperCase()); }

// ---------------------------------------------------------------
// Inline SVG icon library (no external assets — everything drawn here)
// ---------------------------------------------------------------
const SVG_SUN = '<svg viewBox="0 0 24 24" class="ico"><g class="sun-rays" stroke="#ffcf5c" stroke-width="2" stroke-linecap="round"><path d="M12 1.5v3"/><path d="M12 19.5v3"/><path d="M1.5 12h3"/><path d="M19.5 12h3"/><path d="M4.6 4.6l2.1 2.1"/><path d="M17.3 17.3l2.1 2.1"/><path d="M19.4 4.6l-2.1 2.1"/><path d="M6.7 17.3l-2.1 2.1"/></g><circle cx="12" cy="12" r="5.2" fill="#ffd979"/><circle cx="12" cy="12" r="5.2" fill="none" stroke="#ffae3a" stroke-width="1.4"/></svg>';
const SVG_MOON = '<svg viewBox="0 0 24 24" class="ico"><path d="M20 14.4A8.6 8.6 0 0 1 9.6 4 9 9 0 1 0 20 14.4z" fill="#cfe2ff" stroke="#8fb4e0" stroke-width="1.2" stroke-linejoin="round"/><circle cx="10" cy="9.5" r="1.3" fill="#a9c4e6"/><circle cx="13.6" cy="14.6" r="1" fill="#a9c4e6"/></svg>';
const SVG_COIN = '<svg viewBox="0 0 24 24" class="ico coin-ico"><circle cx="12" cy="12" r="9.4" fill="#ffca4a" stroke="#c98b18" stroke-width="1.6"/><circle cx="12" cy="12" r="6.4" fill="none" stroke="#e8a92c" stroke-width="1.2"/><path d="M8.4 12.2c2-2.4 5-3.4 7.4-2.2-1.2 1-1.2 3.4 0 4.4-2.4 1.2-5.4.2-7.4-2.2z" fill="#8a5c0c"/><path d="M8.4 12.2l-2.2-1.8v3.6z" fill="#8a5c0c"/></svg>';
const SVG_HEART = '<svg viewBox="0 0 24 24" class="ico"><path d="M12 21s-8-4.9-8-10.4A4.6 4.6 0 0 1 12 7.6 4.6 4.6 0 0 1 20 10.6C20 16.1 12 21 12 21z" fill="currentColor"/></svg>';
const SVG_BAG = '<svg viewBox="0 0 24 24" class="ico"><path d="M4.5 8h15l-1.2 12.2a1.6 1.6 0 0 1-1.6 1.4H7.3a1.6 1.6 0 0 1-1.6-1.4z" fill="currentColor" opacity=".85"/><path d="M8.5 9V6.6a3.5 3.5 0 0 1 7 0V9" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
const SVG_CROWN = '<svg viewBox="0 0 24 24" class="ico"><path d="M3 18h18l-1.4-9-4.4 3.4L12 6l-3.2 6.4L4.4 9z" fill="#ffca4a" stroke="#c98b18" stroke-width="1.1" stroke-linejoin="round"/></svg>';
const SVG_CHECK = '<svg viewBox="0 0 24 24" class="ico"><path d="M5 12.6l4.6 4.6L19 7.4" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const SVG_WAVE = '<svg viewBox="0 0 120 24" class="ico wave-ico" preserveAspectRatio="none"><path d="M0 16 q15 -12 30 0 t30 0 t30 0 t30 0 V24 H0z" fill="currentColor" opacity=".55"/><path d="M0 20 q15 -10 30 0 t30 0 t30 0 t30 0 V24 H0z" fill="currentColor"/></svg>';

// ---------------------------------------------------------------
// Character customization — hat 0..4 / skin 0..3. The indices are the
// contract shared with player.js: createCharacter(color, name, {hat, skin}).
// Glyphs are drawn in currentColor so chips and lobby rows can tint them.
// ---------------------------------------------------------------
const HATS = [
  { id: 'bucket', name: 'Bucket' },
  { id: 'beanie', name: 'Beanie' },
  { id: 'captain', name: 'Captain' },
  { id: 'bandana', name: 'Bandana' },
  { id: 'none', name: 'None' },
];
const SKINS = [0xf5d0a9, 0xd9a273, 0x9c6644, 0x5c3a24];
const SKIN_NAMES = ['Light', 'Tan', 'Brown', 'Deep'];

const HAT_SVG = [
  // bucket — soft crown, wide floppy brim
  '<svg viewBox="0 0 24 24" class="ico"><path d="M6.2 14.6q0-8 5.8-8t5.8 8z" fill="currentColor"/>' +
  '<path d="M3.2 14.6h17.6q1.1 0 .7 1.7-.3 1.3-2 1.8-7.3 2-14.9 0-1.7-.5-2-1.8-.4-1.7.6-1.7z" fill="currentColor" opacity=".72"/></svg>',
  // beanie — dome, ribbed cuff, pom
  '<svg viewBox="0 0 24 24" class="ico"><circle cx="12" cy="4.6" r="1.8" fill="currentColor"/>' +
  '<path d="M5.6 15q0-8.4 6.4-8.4T18.4 15z" fill="currentColor"/>' +
  '<rect x="4.7" y="15" width="14.6" height="3.6" rx="1.8" fill="currentColor" opacity=".72"/></svg>',
  // captain — peaked cap, band, visor
  '<svg viewBox="0 0 24 24" class="ico"><path d="M6.2 12.6q0-6.4 5.8-6.4t5.8 6.4z" fill="currentColor"/>' +
  '<rect x="5.4" y="12.6" width="13.2" height="2.9" rx="1.3" fill="currentColor" opacity=".62"/>' +
  '<path d="M3.6 15.6h16.8q1.7 0 1.2 1.7-.5 1.5-2.4 1.5H4.8q-1.9 0-2.4-1.5-.5-1.7 1.2-1.7z" fill="currentColor" opacity=".9"/></svg>',
  // bandana — knotted wrap with tail
  '<svg viewBox="0 0 24 24" class="ico"><path d="M4.4 12.2q7.6-6.2 15.2 0-1.5 3.2-7.6 3.2t-7.6-3.2z" fill="currentColor"/>' +
  '<path d="M18.9 12.6l3.6 1.3-2.7 2-1-2.6z" fill="currentColor" opacity=".8"/>' +
  '<g fill="rgba(0,0,0,.34)"><circle cx="8.2" cy="11.2" r=".95"/><circle cx="12" cy="10.3" r=".95"/><circle cx="15.8" cy="11.2" r=".95"/></g></svg>',
  // none — bare head
  '<svg viewBox="0 0 24 24" class="ico"><circle cx="12" cy="9.6" r="5" fill="currentColor" opacity=".55"/>' +
  '<path d="M4.8 20.4q1.7-4.8 7.2-4.8t7.2 4.8z" fill="currentColor" opacity=".26"/></svg>',
];
function hatGlyph(i) { return HAT_SVG[i] || HAT_SVG[HAT_SVG.length - 1]; }
function hatName(i) { return (HATS[i] && HATS[i].name) || 'None'; }
function skinName(i) { return SKIN_NAMES[i] || SKIN_NAMES[0]; }
function skinHex(i) { return hex(SKINS[i] != null ? SKINS[i] : SKINS[0]); }

// ---------------------------------------------------------------
// Weather glyphs — pure inline SVG, coloured through currentColor so
// the chip's per-type palette drives them (see .weather-chip in css).
// ---------------------------------------------------------------
const WX_CLOUD = '<g fill="currentColor"><circle cx="12.5" cy="13.5" r="4.6"/><circle cx="19" cy="12.6" r="5.6"/><rect x="8" y="13.4" width="15.6" height="6.6" rx="3.3"/></g>';
const SVG_WX = {
  clear:
    '<svg viewBox="0 0 32 32" class="ico wx-svg">' +
    '<g class="wx-rays" stroke="currentColor" stroke-width="2.3" stroke-linecap="round">' +
    '<path d="M16 2.4v3.6"/><path d="M16 26v3.6"/><path d="M2.4 16H6"/><path d="M26 16h3.6"/>' +
    '<path d="M6.4 6.4l2.5 2.5"/><path d="M23.1 23.1l2.5 2.5"/><path d="M25.6 6.4l-2.5 2.5"/><path d="M8.9 23.1l-2.5 2.5"/></g>' +
    '<circle cx="16" cy="16" r="6.3" fill="currentColor"/>' +
    '<circle cx="13.6" cy="13.8" r="2.2" fill="rgba(255,255,255,.45)"/></svg>',
  overcast:
    '<svg viewBox="0 0 32 32" class="ico wx-svg">' +
    '<g opacity=".45" fill="currentColor" class="wx-drift"><circle cx="9" cy="9.6" r="3.6"/><circle cx="15" cy="8.8" r="4.4"/><rect x="5.4" y="9.4" width="12" height="5" rx="2.5"/></g>' +
    WX_CLOUD + '</svg>',
  fog:
    '<svg viewBox="0 0 32 32" class="ico wx-svg">' +
    '<g opacity=".8">' + WX_CLOUD + '</g>' +
    '<g class="wx-bars" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" opacity=".8">' +
    '<path d="M5.5 23.4h21"/><path d="M9 27.6h14"/></g></svg>',
  rain:
    '<svg viewBox="0 0 32 32" class="ico wx-svg">' + WX_CLOUD +
    '<g class="wx-drops" stroke="currentColor" stroke-width="2.2" stroke-linecap="round">' +
    '<path d="M11 22.5l-1.6 4.4"/><path d="M16.4 22.5l-1.6 4.4"/><path d="M21.8 22.5l-1.6 4.4"/></g></svg>',
  storm:
    '<svg viewBox="0 0 32 32" class="ico wx-svg">' +
    '<g opacity=".9">' + WX_CLOUD + '</g>' +
    '<g class="wx-drops" stroke="currentColor" stroke-width="2" stroke-linecap="round" opacity=".55">' +
    '<path d="M10 22.4l-1.3 3.6"/><path d="M23 22.4l-1.3 3.6"/></g>' +
    '<path class="wx-bolt" d="M17.6 20.4l-5.4 6.6h3.4l-1.2 4.6 5.6-7h-3.4z" fill="currentColor"/></svg>',
};
function wxIcon(type) { return SVG_WX[type] || SVG_WX.clear; }
// short line under the chip name — rain/storm advertise the fishing buff
function wxHint(type) {
  if (type === 'storm') return 'bites faster · rarer fish';
  if (type === 'rain') return 'bites faster · rarer fish';
  if (type === 'fog') return 'blind water · bold hunters';
  if (type === 'overcast') return 'grey · slightly luckier';
  return 'calm water';
}
function wxHazard(type) {
  const w = WEATHER[type];
  if (w && w.hazard) {
    if (type === 'rain' || type === 'storm') return w.hazard + ' The fish are stirred up.';
    return w.hazard;
  }
  if (type === 'overcast') return 'Flat grey light. The fish are a little braver.';
  return 'Flat calm and open sky. Easy water, picky fish.';
}

function rodIcon(level) {
  const cols = ['#a37b4c', '#a37b4c', '#5fb6d8', '#39424c', '#49dfb0', '#ffd979'];
  const c = cols[Math.min(5, Math.max(1, level | 0))];
  const glow = level >= 4 ? `<path d="M25 6 q6 8 1 14" stroke="${c}" stroke-width="1.4" fill="none" opacity=".7"/>` : '';
  return `<svg viewBox="0 0 32 32" class="ico"><path d="M5.5 27 L25 6" stroke="${c}" stroke-width="3.1" stroke-linecap="round" fill="none"/><circle cx="9.5" cy="23" r="3.2" fill="#f2d9a8" stroke="#a37b4c" stroke-width="1.2"/><path d="M25 6 l3.6 3.4" stroke="#eaf4fb" stroke-width="1.4" stroke-linecap="round"/><path d="M27 8.5 q2.6 7 -3 10.5" stroke="#bfe6ff" stroke-width="1" fill="none" opacity=".85"/>${glow}</svg>`;
}
function weaponIcon(id) {
  if (id === 'speargun') return '<svg viewBox="0 0 32 32" class="ico"><rect x="4" y="14.5" width="21" height="3.4" rx="1.6" fill="#5a6b78"/><path d="M25 16.2 L30 16.2" stroke="#cfe2f0" stroke-width="2.4" stroke-linecap="round"/><path d="M8 18 v5 h5" fill="none" stroke="#8a5c3a" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/><circle cx="6.5" cy="16.2" r="2.4" fill="#3fd0a0"/></svg>';
  if (id === 'trident') return '<svg viewBox="0 0 32 32" class="ico"><path d="M16 28 V10" stroke="#c8b48a" stroke-width="2.8" stroke-linecap="round"/><path d="M9 12 V4 M16 11 V2 M23 12 V4" stroke="#9fe8ff" stroke-width="2.6" stroke-linecap="round"/><path d="M9 12 h14" stroke="#9fe8ff" stroke-width="2.6" stroke-linecap="round"/><circle cx="16" cy="16" r="2" fill="#ffd979"/></svg>';
  return '<svg viewBox="0 0 32 32" class="ico"><path d="M6 26 L24 8" stroke="#8a5c3a" stroke-width="2.8" stroke-linecap="round"/><path d="M24 8 l4 -4 -1.5 6.5z" fill="#cfe2f0"/><path d="M22 10 l-4 -1 2 4z" fill="#cfe2f0"/></svg>';
}
function baitIcon(id) {
  const cols = {
    worms: '#d08a6a', shrimp: '#f2a06a', squidbait: '#c86a86', glowbait: '#6ef0d0', voidbait: '#9a5cff',
    glowgrub: '#b6f05a', abyssleech: '#ff5c9a',
  };
  const c = cols[id] || '#9fd8ff';
  const glow = (id === 'glowbait' || id === 'voidbait' || id === 'glowgrub' || id === 'abyssleech')
    ? `<circle cx="16" cy="16" r="11" fill="${c}" opacity=".18"/>` : '';
  return `<svg viewBox="0 0 32 32" class="ico">${glow}<path d="M10 20 q2 -8 7 -9 q6 -1 5 5 q-1 5 -6 6 q-5 1 -6 -2z" fill="${c}" stroke="rgba(0,0,0,.35)" stroke-width="1"/><circle cx="19" cy="14" r="1.4" fill="#101820"/></svg>`;
}
function shopKindIcon(kind, item) {
  switch (kind) {
    case 'rod': return rodIcon(item.level || 2);
    case 'boat': return '<svg viewBox="0 0 32 32" class="ico"><path d="M4 19 h24 l-4 7 H8z" fill="#a3703f" stroke="#6d4826" stroke-width="1.3" stroke-linejoin="round"/><path d="M16 18 V5 l9 11z" fill="#eef6fb" stroke="#9fbdd0" stroke-width="1.2" stroke-linejoin="round"/><path d="M2 27 q6 -3 12 0 t16 0" fill="none" stroke="#4fb3d9" stroke-width="1.8" stroke-linecap="round"/></svg>';
    case 'bait': return baitIcon(item.id);
    case 'weapon': return weaponIcon(item.id);
    case 'charm': return `<svg viewBox="0 0 32 32" class="ico"><circle cx="16" cy="18" r="8.5" fill="${item.id === 'charm3' ? '#ffca4a' : item.id === 'charm2' ? '#d8e2ea' : '#c98b4a'}" stroke="rgba(0,0,0,.35)" stroke-width="1.2"/><path d="M16 12 l2.4 4.6 5 .8 -3.6 3.5 .9 5 -4.7 -2.4 -4.7 2.4 .9 -5 -3.6 -3.5 5 -.8z" fill="rgba(255,255,255,.55)"/><path d="M13 8 h6" stroke="#8a6a44" stroke-width="2" stroke-linecap="round"/></svg>`;
    case 'revive': return reviveIcon(item.id);
    case 'diving': return '<svg viewBox="0 0 32 32" class="ico"><path d="M7 11 h18 a3 3 0 0 1 3 3 v3 a5 5 0 0 1 -5 5 h-2 l-2 3 h-4 l-2 -3 h-2 a5 5 0 0 1 -5 -5 v-3 a3 3 0 0 1 3 -3z" fill="#2c4a5e" stroke="#8fd8f0" stroke-width="1.4" stroke-linejoin="round"/><rect x="9" y="13" width="14" height="6" rx="2" fill="#9fe8ff" opacity=".75"/></svg>';
    case 'ward': return '<svg viewBox="0 0 32 32" class="ico"><path d="M16 3 l11 4 v9 c0 7 -5 11 -11 13 -6 -2 -11 -6 -11 -13 V7z" fill="#1b3d55" stroke="#7fe0ff" stroke-width="1.6" stroke-linejoin="round"/><path d="M16 9 v12 M11 14 q5 4 10 0" fill="none" stroke="#ffd979" stroke-width="1.8" stroke-linecap="round"/></svg>';
    default: return SVG_BAG;
  }
}
function artifactIcon(id) {
  if (id === 'serpentscale') return '<svg viewBox="0 0 32 32" class="ico"><path d="M16 4 q9 6 9 13 t-9 11 q-9 -4 -9 -11 t9 -13z" fill="#2ea86a" stroke="#7dffbe" stroke-width="1.5" stroke-linejoin="round"/><path d="M16 9 q5 4 5 8 t-5 7 q-5 -3 -5 -7 t5 -8z" fill="#1c6f47" opacity=".8"/></svg>';
  if (id === 'krakenbeak') return '<svg viewBox="0 0 32 32" class="ico"><path d="M8 6 q13 3 17 12 -6 10 -17 8 5 -8 4 -10 t-4 -10z" fill="#40206a" stroke="#c48bff" stroke-width="1.5" stroke-linejoin="round"/><path d="M12 12 q7 2 9 6" fill="none" stroke="#c48bff" stroke-width="1.3" opacity=".8"/></svg>';
  return '<svg viewBox="0 0 32 32" class="ico"><path d="M16 27 S4 19.5 4 12.6A5.9 5.9 0 0 1 16 9.6 5.9 5.9 0 0 1 28 12.6C28 19.5 16 27 16 27z" fill="#a8253a" stroke="#ff6a7a" stroke-width="1.5" stroke-linejoin="round"/><path d="M11 13 q5 -3 9 1" fill="none" stroke="#ffb3bd" stroke-width="1.4" stroke-linecap="round"/></svg>';
}

// ---------------------------------------------------------------
// Procedural fallback fish icon (canvas). Used until/unless
// fish.js provides createFishIconDataURL.
// ---------------------------------------------------------------
function drawFallbackIcon(fish, mutation, size) {
  const cv = document.createElement('canvas');
  cv.width = cv.height = size;
  const g = cv.getContext('2d');
  const m = fish && fish.model ? fish.model : {};
  const cols = m.colors || [0x8fb4c9, 0x4f7489];
  const top = hex(cols[0]), bot = hex(cols[1] != null ? cols[1] : cols[0]);
  const belly = hex(m.belly != null ? m.belly : 0xe6f2f8);
  const shape = m.shape || 'slim';
  const S = size;
  g.clearRect(0, 0, S, S);
  g.save();
  g.translate(S * 0.5, S * 0.5);
  const grad = g.createLinearGradient(0, -S * 0.22, 0, S * 0.22);
  grad.addColorStop(0, top);
  grad.addColorStop(0.62, bot);
  grad.addColorStop(1, belly);

  const stroke = 'rgba(4,14,22,0.55)';
  g.lineJoin = 'round';
  g.lineWidth = Math.max(1.5, S * 0.022);

  const body = (rx, ry) => {
    g.beginPath();
    g.ellipse(0, 0, rx, ry, 0, 0, TAU);
    g.fillStyle = grad; g.fill();
    g.strokeStyle = stroke; g.stroke();
  };
  const tail = (x, w, h) => {
    g.beginPath();
    g.moveTo(x, 0);
    g.lineTo(x + w, -h);
    g.quadraticCurveTo(x + w * 0.55, 0, x + w, h);
    g.closePath();
    g.fillStyle = bot; g.fill(); g.strokeStyle = stroke; g.stroke();
  };
  const eye = (x, y, r) => {
    g.beginPath(); g.arc(x, y, r, 0, TAU); g.fillStyle = '#f6fbff'; g.fill();
    g.beginPath(); g.arc(x + r * 0.18, y, r * 0.55, 0, TAU); g.fillStyle = '#0a1620'; g.fill();
  };

  if (shape === 'eel' || shape === 'serpent') {
    g.beginPath();
    g.moveTo(-S * 0.40, S * 0.02);
    g.quadraticCurveTo(-S * 0.14, -S * 0.19, S * 0.06, S * 0.0);
    g.quadraticCurveTo(S * 0.24, S * 0.16, S * 0.38, S * 0.02);
    g.lineTo(S * 0.38, S * 0.10);
    g.quadraticCurveTo(S * 0.22, S * 0.26, S * 0.04, S * 0.11);
    g.quadraticCurveTo(-S * 0.14, -S * 0.05, -S * 0.40, S * 0.13);
    g.closePath();
    g.fillStyle = grad; g.fill(); g.strokeStyle = stroke; g.stroke();
    eye(-S * 0.33, S * 0.055, S * 0.032);
  } else if (shape === 'squid') {
    g.beginPath();
    g.ellipse(0, -S * 0.10, S * 0.15, S * 0.24, 0, 0, TAU);
    g.fillStyle = grad; g.fill(); g.strokeStyle = stroke; g.stroke();
    g.strokeStyle = bot; g.lineWidth = Math.max(2, S * 0.028); g.lineCap = 'round';
    for (let i = -3; i <= 3; i++) {
      g.beginPath();
      g.moveTo(i * S * 0.032, S * 0.12);
      g.quadraticCurveTo(i * S * 0.07, S * 0.28, i * S * 0.11, S * 0.40);
      g.stroke();
    }
    eye(-S * 0.06, -S * 0.14, S * 0.036);
  } else if (shape === 'octopus') {
    g.beginPath(); g.arc(0, -S * 0.10, S * 0.20, Math.PI, 0); g.closePath();
    g.fillStyle = grad; g.fill(); g.strokeStyle = stroke; g.stroke();
    g.strokeStyle = bot; g.lineWidth = Math.max(2, S * 0.032); g.lineCap = 'round';
    for (let i = -3; i <= 3; i++) {
      g.beginPath();
      g.moveTo(i * S * 0.05, -S * 0.08);
      g.quadraticCurveTo(i * S * 0.10, S * 0.16, i * S * 0.055, S * 0.36);
      g.stroke();
    }
    eye(-S * 0.075, -S * 0.14, S * 0.036); eye(S * 0.075, -S * 0.14, S * 0.036);
  } else if (shape === 'ray') {
    g.beginPath();
    g.moveTo(0, -S * 0.24);
    g.quadraticCurveTo(S * 0.42, -S * 0.02, 0, S * 0.20);
    g.quadraticCurveTo(-S * 0.42, -S * 0.02, 0, -S * 0.24);
    g.closePath();
    g.fillStyle = grad; g.fill(); g.strokeStyle = stroke; g.stroke();
    g.beginPath(); g.moveTo(0, S * 0.18); g.lineTo(0, S * 0.42);
    g.strokeStyle = bot; g.lineWidth = Math.max(2, S * 0.026); g.stroke();
    eye(-S * 0.07, -S * 0.10, S * 0.03); eye(S * 0.07, -S * 0.10, S * 0.03);
  } else if (shape === 'flat') {
    body(S * 0.30, S * 0.20);
    tail(S * 0.28, S * 0.13, S * 0.11);
    eye(-S * 0.16, -S * 0.05, S * 0.034);
  } else if (shape === 'blob') {
    body(S * 0.27, S * 0.25);
    tail(S * 0.24, S * 0.14, S * 0.13);
    eye(-S * 0.12, -S * 0.06, S * 0.045);
    if (m.spikes) {
      g.strokeStyle = bot; g.lineWidth = Math.max(1.5, S * 0.018);
      for (let i = 0; i < 10; i++) {
        const a = (i / 10) * TAU;
        g.beginPath();
        g.moveTo(Math.cos(a) * S * 0.25, Math.sin(a) * S * 0.235);
        g.lineTo(Math.cos(a) * S * 0.32, Math.sin(a) * S * 0.30);
        g.stroke();
      }
    }
  } else if (shape === 'shark') {
    g.beginPath();
    g.moveTo(-S * 0.36, S * 0.02);
    g.quadraticCurveTo(-S * 0.10, -S * 0.20, S * 0.22, -S * 0.05);
    g.quadraticCurveTo(-S * 0.06, S * 0.19, -S * 0.36, S * 0.02);
    g.closePath();
    g.fillStyle = grad; g.fill(); g.strokeStyle = stroke; g.stroke();
    g.beginPath();
    g.moveTo(-S * 0.05, -S * 0.13); g.lineTo(S * 0.02, -S * 0.33); g.lineTo(S * 0.10, -S * 0.10);
    g.closePath(); g.fillStyle = bot; g.fill(); g.strokeStyle = stroke; g.stroke();
    tail(S * 0.20, S * 0.16, S * 0.15);
    eye(-S * 0.25, -S * 0.02, S * 0.030);
  } else if (shape === 'angler') {
    body(S * 0.24, S * 0.21);
    tail(S * 0.22, S * 0.13, S * 0.12);
    eye(-S * 0.11, -S * 0.07, S * 0.042);
    g.beginPath();
    g.moveTo(-S * 0.06, -S * 0.19);
    g.quadraticCurveTo(-S * 0.26, -S * 0.34, -S * 0.28, -S * 0.20);
    g.strokeStyle = bot; g.lineWidth = Math.max(1.6, S * 0.02); g.stroke();
    g.beginPath(); g.arc(-S * 0.28, -S * 0.20, S * 0.045, 0, TAU);
    g.fillStyle = hex(m.emissive != null ? m.emissive : 0x88ddff); g.fill();
  } else if (shape === 'round') {
    body(S * 0.26, S * 0.20);
    tail(S * 0.24, S * 0.14, S * 0.13);
    eye(-S * 0.14, -S * 0.05, S * 0.036);
    g.beginPath();
    g.moveTo(-S * 0.06, -S * 0.19); g.lineTo(S * 0.06, -S * 0.30); g.lineTo(S * 0.13, -S * 0.14);
    g.closePath(); g.fillStyle = bot; g.fill(); g.strokeStyle = stroke; g.stroke();
  } else {
    body(S * 0.29, S * 0.155);
    tail(S * 0.27, S * 0.14, S * 0.13);
    eye(-S * 0.18, -S * 0.03, S * 0.032);
    g.beginPath();
    g.moveTo(-S * 0.04, -S * 0.145); g.lineTo(S * 0.05, -S * 0.26); g.lineTo(S * 0.12, -S * 0.10);
    g.closePath(); g.fillStyle = bot; g.fill(); g.strokeStyle = stroke; g.stroke();
  }

  if (m.stripes != null && (shape === 'slim' || shape === 'round')) {
    g.save();
    g.globalAlpha = 0.55; g.strokeStyle = hex(m.stripes); g.lineWidth = Math.max(1.5, S * 0.02);
    for (let i = -2; i <= 2; i++) {
      g.beginPath();
      g.moveTo(i * S * 0.075, -S * 0.13);
      g.quadraticCurveTo(i * S * 0.075 + S * 0.02, 0, i * S * 0.075, S * 0.10);
      g.stroke();
    }
    g.restore();
  }
  g.restore();

  if (mutation && MUTATIONS[mutation]) {
    const mu = MUTATIONS[mutation];
    g.save();
    g.globalCompositeOperation = 'source-atop';
    if (mutation === 'rainbow') {
      const rg = g.createLinearGradient(0, 0, S, S);
      const stops = ['#ff5a5a', '#ffc84a', '#5aff8a', '#5ad0ff', '#a55aff', '#ff5ad0'];
      stops.forEach((c, i) => rg.addColorStop(i / (stops.length - 1), c));
      g.globalAlpha = 0.55; g.fillStyle = rg;
    } else {
      g.globalAlpha = mutation === 'void' ? 0.78 : 0.5;
      g.fillStyle = hex(mu.tint);
    }
    g.fillRect(0, 0, S, S);
    if (mu.emissive) {
      g.globalCompositeOperation = 'lighter';
      g.globalAlpha = 0.32;
      const rr = g.createRadialGradient(S * 0.5, S * 0.5, 0, S * 0.5, S * 0.5, S * 0.5);
      rr.addColorStop(0, hex(mu.emissive)); rr.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = rr; g.fillRect(0, 0, S, S);
    }
    g.restore();
  }
  return cv.toDataURL('image/png');
}

function fishIcon(fishId, mutation, size = 128) {
  const key = fishId + '|' + (mutation || '') + '|' + size;
  const cached = _iconCache.get(key);
  if (cached) return cached;
  const fish = fishById(fishId) || FISH[0];
  let url = null;
  if (_iconFn && _iconStyle >= 0) {
    const attempts = _iconStyle === 2 ? [2] : _iconStyle === 1 ? [1] : [1, 2];
    for (const a of attempts) {
      try {
        const r = _iconFn(a === 1 ? fish : fishId, mutation || null, size);
        if (typeof r === 'string' && r.slice(0, 5) === 'data:') { url = r; _iconStyle = a; break; }
      } catch (e) { /* try next calling convention */ }
    }
    if (!url) _iconStyle = -1;
  }
  if (!url) {
    try { url = drawFallbackIcon(fish, mutation, size); } catch (e) { url = ''; }
  }
  _iconCache.set(key, url);
  return url;
}

// ---------------------------------------------------------------
// Wave 4 — diving loot, found baits, unique charms
// ---------------------------------------------------------------
// The E prompt reads as a verb: "E — Pry open the Pearl Clam".
const LOOT_VERB = {
  clam: 'Pry open the', coins: 'Scoop up the', bottle: 'Uncork the',
  chest: 'Crack open the', relic: 'Lift the', geode: 'Chip out the',
};
// payloads may name the type as `type` or `kind`; some only carry the name
function lootTypeOf(d) {
  if (!d) return '';
  const k = d.type || d.kind || d.lootType;
  if (typeof k === 'string' && LOOT_TYPES[k]) return k;
  const n = d.name;
  if (typeof n === 'string') {
    for (const id in LOOT_TYPES) { if (LOOT_TYPES[id].name === n) return id; }
  }
  return '';
}
function lootName(d) {
  const k = lootTypeOf(d);
  const n = d && typeof d.name === 'string' ? d.name : '';
  return n || (k ? LOOT_TYPES[k].name : 'Something down there');
}
function lootPromptLabel(d) {
  const k = lootTypeOf(d);
  return (LOOT_VERB[k] || 'Take the') + ' ' + lootName(d);
}
// cut gem, gold crown into a violet pavilion — no gradient defs, because this
// glyph is rendered in several places at once and duplicate ids are a trap
const SVG_LOOT_GEM =
  '<svg viewBox="0 0 32 32" class="ico">' +
  '<path d="M11 4h10l6 8-11 16L5 12z" fill="#ffca4a" stroke="#fff3cf" stroke-width="1.2" stroke-linejoin="round"/>' +
  '<path d="M11 4l5 8 5-8z" fill="#ffe9a8" opacity=".9"/>' +
  '<path d="M16 12L5 12l11 16z" fill="#e0a52c" opacity=".8"/>' +
  '<path d="M16 12h11l-11 16z" fill="#a97bff" opacity=".55"/>' +
  '<path d="M5 12h22" fill="none" stroke="rgba(255,255,255,.6)" stroke-width="1"/></svg>';

// one readable line per unique effect (the server applies the real maths)
function uniqueEffect(def) {
  if (!def) return '';
  const pct = (m) => Math.round((num(m, 1) - 1) * 100);
  switch (def.effect) {
    case 'airMult': return '+' + pct(def.mult) + '% air underwater';
    case 'biteSpeed': return 'bites ' + pct(def.mult) + '% faster';
    case 'meleeMult': return '+' + pct(def.mult) + '% melee damage';
    case 'luckAdd': return '+' + Math.round(num(def.add, 0) * 100) + '% luck';
    case 'sellMult': return 'fish sell for +' + pct(def.mult) + '%';
    default: return def.desc || '';
  }
}

// Baits you can hold = the shop's list PLUS the found-only ones out of chests.
// Found baits are never purchasable, so they only ever show up once you own some.
const BAIT_DEFS = SHOP.filter((s) => s.kind === 'bait').concat(
  FOUND_BAITS.map((b) => ({
    kind: 'bait', found: true, id: b.id, name: b.name, pack: b.pack,
    tierBias: b.tierBias, luck: b.luck, desc: b.desc, price: 0,
  })));
function baitById(id) {
  for (let i = 0; i < BAIT_DEFS.length; i++) if (BAIT_DEFS[i].id === id) return BAIT_DEFS[i];
  return null;
}
function foundBaitById(id) {
  for (let i = 0; i < FOUND_BAITS.length; i++) if (FOUND_BAITS[i].id === id) return FOUND_BAITS[i];
  return null;
}

function mutName(fishName, mutation) {
  if (mutation && MUTATIONS[mutation]) return MUTATIONS[mutation].name.toUpperCase() + ' ' + fishName;
  return fishName;
}
function tierLabel(t) { return (t >= 11) ? 'TX' : 'T' + t; }

// ---------------------------------------------------------------
// Wave 5 — perfect cast, reviving, doomsday
// ---------------------------------------------------------------
// The sweet band on the cast meter. fishing.js ships it on every
// 'castPower' payload; this is the fallback so the lines are never wrong.
const PERFECT_BAND = (() => {
  const raw = (CAST_PERFECT && Array.isArray(CAST_PERFECT.BAND)) ? CAST_PERFECT.BAND : [0.78, 0.92];
  const a = clamp01(num(raw[0], 0.78));
  const b = clamp01(num(raw[1], 0.92));
  return a <= b ? [a, b] : [b, a];
})();
function bandOf(d) {
  const raw = d && (Array.isArray(d.band) ? d.band : (Array.isArray(d.perfect) ? d.perfect : null));
  if (!raw || raw.length < 2) return PERFECT_BAND;
  const a = clamp01(num(raw[0], PERFECT_BAND[0]));
  const b = clamp01(num(raw[1], PERFECT_BAND[1]));
  return a <= b ? [a, b] : [b, a];
}

// Revive numbers, read defensively — a missing constant must not break the HUD.
const RV = {
  hold: Math.max(0.2, num(REVIVE && REVIVE.SALTS_HOLD_SECONDS, 3)),
  saltsRange: Math.max(0.5, num(REVIVE && REVIVE.SALTS_RANGE, 3)),
  clawRange: Math.max(0.5, num(REVIVE && REVIVE.CLAW_RANGE, 3.5)),
  kitHp: clamp01(num(REVIVE && REVIVE.KIT_HP, 0.4)),
  saltsHp: clamp01(num(REVIVE && REVIVE.SALTS_HP, 0.5)),
  noSaltsUnder: REVIVE ? REVIVE.NO_SALTS_UNDERWATER !== false : true,
};

// a downed crewmate, drawn as a marker you can find from anywhere
const SVG_SKULL =
  '<svg viewBox="0 0 24 24" class="ico"><path d="M12 2.3c-4.7 0-7.8 3.1-7.8 7.3 0 2.4 1 4 2.2 5 .6.5.9 1 .9 1.8v1.1c0 .9.8 1.7 1.7 1.7h6c.9 0 1.7-.8 1.7-1.7v-1.1c0-.8.3-1.3.9-1.8 1.2-1 2.2-2.6 2.2-5 0-4.2-3.1-7.3-7.8-7.3z" fill="currentColor"/>' +
  '<circle cx="8.9" cy="10.3" r="2.2" fill="rgba(4,14,22,.85)"/><circle cx="15.1" cy="10.3" r="2.2" fill="rgba(4,14,22,.85)"/>' +
  '<path d="M12 13.1l-1.2 2.3h2.4z" fill="rgba(4,14,22,.85)"/>' +
  '<g fill="currentColor"><rect x="8.2" y="19" width="1.7" height="3.1" rx=".7"/><rect x="11.15" y="19" width="1.7" height="3.1" rx=".7"/><rect x="14.1" y="19" width="1.7" height="3.1" rx=".7"/></g></svg>';

const REVIVE_SVG = {
  // a jar of salts — cork, glass, bright grains
  salts:
    '<svg viewBox="0 0 32 32" class="ico"><path d="M12.5 3.5h7v3.2l-1 2.3h-5l-1-2.3z" fill="#c8a06a" stroke="#8a6a44" stroke-width="1.1" stroke-linejoin="round"/>' +
    '<path d="M9 9h14a2.4 2.4 0 0 1 2.4 2.4v14.2A2.4 2.4 0 0 1 23 28H9a2.4 2.4 0 0 1-2.4-2.4V11.4A2.4 2.4 0 0 1 9 9z" fill="#123a52" stroke="#8fd8f0" stroke-width="1.4" stroke-linejoin="round"/>' +
    '<g fill="#eafaff"><circle cx="12" cy="17" r="1.6"/><circle cx="17.4" cy="20.4" r="1.9"/><circle cx="21" cy="16.2" r="1.3"/><circle cx="13.6" cy="23" r="1.3"/><circle cx="19.6" cy="24" r="1"/></g></svg>',
  // the rescue claw — chain, hoop, two hooked jaws
  rescueclaw:
    '<svg viewBox="0 0 32 32" class="ico"><circle cx="16" cy="4.4" r="2.4" fill="none" stroke="#9fbdd0" stroke-width="1.7"/>' +
    '<path d="M16 6.8v5.4" stroke="#9fbdd0" stroke-width="2.2" stroke-linecap="round"/>' +
    '<path d="M9.4 12.2h13.2l-2 4.2H11.4z" fill="#5a6b78" stroke="#cfe2f0" stroke-width="1.2" stroke-linejoin="round"/>' +
    '<path d="M11.6 16.4q-4.4 4.6-4.2 10.4 3.6.6 5-3.4" fill="none" stroke="#cfe2f0" stroke-width="2.4" stroke-linecap="round"/>' +
    '<path d="M20.4 16.4q4.4 4.6 4.2 10.4-3.6.6-5-3.4" fill="none" stroke="#cfe2f0" stroke-width="2.4" stroke-linecap="round"/></svg>',
  // the kit — a white case with a red cross
  revivalkit:
    '<svg viewBox="0 0 32 32" class="ico"><path d="M11 7h10v3.2h4a2.4 2.4 0 0 1 2.4 2.4v12.6A2.4 2.4 0 0 1 25 27.6H7a2.4 2.4 0 0 1-2.4-2.4V12.6A2.4 2.4 0 0 1 7 10.2h4z" fill="#e6ecf0" stroke="#9fb4c0" stroke-width="1.3" stroke-linejoin="round"/>' +
    '<path d="M12.6 7h6.8v3.2h-6.8z" fill="#9fb4c0"/>' +
    '<path d="M14.1 13.6h3.8v3.4h3.4v3.8h-3.4v3.4h-3.8v-3.4h-3.4v-3.8h3.4z" fill="#e0554a"/></svg>',
};
function reviveIcon(id) { return REVIVE_SVG[id] || REVIVE_SVG.salts; }
function reviveShortName(id) {
  const it = shopById(id);
  return it ? it.name : prettyKey(id);
}

// ===============================================================
// initUI
// ===============================================================
export function initUI(ctx) {
  const state = ctx.state;
  const bus = ctx.bus;
  const net = ctx.net;

  // ---- root ---------------------------------------------------
  let root = document.getElementById('ui');
  if (!root) { root = el('div'); root.id = 'ui'; document.body.appendChild(root); }
  root.innerHTML = '';
  root.dataset.phase = state.phase || 'menu';

  // ---- local ui state ----------------------------------------
  const ui = {
    phase: null,
    menuPanel: 'none',          // 'none' | 'create' | 'join'
    name: (localStorage.getItem(LS_NAME) || '').slice(0, 16),
    color: Math.max(0, Math.min(PLAYER_COLORS.length - 1, parseInt(localStorage.getItem(LS_COLOR) || '0', 10) || 0)),
    hat: idx(localStorage.getItem(LS_HAT), HATS.length),
    skin: idx(localStorage.getItem(LS_SKIN), SKINS.length),
    ready: false,
    shopOpen: false,
    shopTab: 'rod',
    sellSel: new Set(),
    invOpen: false,
    chatOpen: false,
    chatLog: [],
    endData: null,
    lastArtifacts: 0,
    sawWorld: false,
    lastWallet: null,
    lastCatchKey: '',
    catchTimer: 0,
    dedupe: new Map(),
    interact: null,
    lootNear: null,        // {lootId, name, type} from bus 'lootNear'
    lootKnown: false,      // any LOOT_STATE seen -> the seabed hint is worth showing
    diveHinted: false,
    uniques: [],           // unique charm ids claimed by ME this run
    uqTimer: 0,
    castPowerT: -99,
    reelT: -99,
    reelOn: false,
    // wave 5
    doom: false,           // doomsday tsunami: the whole hud is hidden
    perfectT: -99,
    reviveOn: false,
    reviveChT: -99,
    reviveTarget: null,    // id we are channelling a revive on
    towing: null,          // {id, name} while the Rescue Claw is hauling a body
    downSeen: new Set(),   // ids we have already announced as down
    downInit: false,
    tsunamiPulse: 0,
    damageFlash: 0,
    koShown: false,
    roomRev: -1,
    invRev: 0,
    lastInvRender: -1,
    acc: 0,
    now: 0,
    sellPreview: 0,
  };

  // Reusable position holder. A real THREE.Vector3 when available so other
  // modules (boat.nearBoat) can call Vector3 methods on it.
  const TMP = (ctx.THREE && ctx.THREE.Vector3) ? new ctx.THREE.Vector3() : { x: 0, y: 0, z: 0 };

  function myId() {
    if (state.myId) return state.myId;
    try { if (net && typeof net.id === 'function') return net.id(); } catch (e) { /* not connected */ }
    return null;
  }
  function send(type, data) {
    try { if (net && typeof net.send === 'function') net.send(type, data || {}); } catch (e) { /* offline */ }
  }
  function onNet(type, cb) {
    try { if (net && typeof net.on === 'function') net.on(type, cb); } catch (e) { /* offline */ }
  }
  function onBus(evt, cb) {
    try { if (bus && typeof bus.on === 'function') bus.on(evt, cb); } catch (e) { /* no bus */ }
  }
  // Guards against a payload being delivered twice (net + bus relay).
  function fresh(key, ms) {
    const t = performance.now();
    const prev = ui.dedupe.get(key);
    if (prev != null && t - prev < (ms || 300)) return false;
    ui.dedupe.set(key, t);
    if (ui.dedupe.size > 64) {
      for (const [k, v] of ui.dedupe) { if (t - v > 5000) ui.dedupe.delete(k); }
    }
    return true;
  }

  // =============================================================
  // TOASTS
  // =============================================================
  const toastLayer = el('div', 'toast-layer');
  root.appendChild(toastLayer);

  function toast(text, kind) {
    if (!text) return;
    if (ui.doom) return;   // doomsday owns the screen — nothing pops over the wave
    const t = el('div', 'toast toast-' + (kind || 'info'));
    t.appendChild(el('span', 'toast-dot'));
    const body = el('span', 'toast-text');
    body.textContent = String(text);
    t.appendChild(body);
    toastLayer.appendChild(t);
    while (toastLayer.children.length > 5) toastLayer.removeChild(toastLayer.firstChild);
    setTimeout(() => { t.classList.add('out'); }, 2600);
    setTimeout(() => { if (t.parentNode) t.parentNode.removeChild(t); }, 3200);
  }

  // =============================================================
  // MAIN MENU
  // =============================================================
  const menu = el('div', 'screen screen-menu');
  menu.innerHTML = `
    <div class="menu-scrim"></div>
    <div class="menu-inner">
      <div class="title-block">
        <h1 class="game-title" id="gameTitle"></h1>
        <div class="title-underwave">${SVG_WAVE}</div>
        <p class="title-sub">a co-op fishing panic</p>
      </div>

      <div class="menu-stack">
        <div class="card menu-card identity-card">
          <div class="field">
            <label class="field-label" for="nameInput">Your name</label>
            <input id="nameInput" class="txt" type="text" maxlength="16" spellcheck="false" placeholder="Deckhand" autocomplete="off">
          </div>
          <div class="field">
            <label class="field-label">Crew colour</label>
            <div class="swatches" id="swatches"></div>
          </div>
          <div class="field field-pick">
            <label class="field-label">Hat <span class="field-val" id="hatVal">Bucket</span></label>
            <div class="pick-row row-hat" id="hatRow"></div>
          </div>
          <div class="field field-pick">
            <label class="field-label">Skin <span class="field-val" id="skinVal">Light</span></label>
            <div class="pick-row row-skin" id="skinRow"></div>
          </div>
        </div>

        <div class="menu-actions" id="menuActions">
          <button class="btn btn-big btn-primary" id="btnCreateOpen"><span>CREATE ISLAND</span></button>
          <button class="btn btn-big btn-secondary" id="btnJoinOpen"><span>JOIN ISLAND</span></button>
        </div>

        <div class="card menu-card panel-create" id="panelCreate">
          <div class="panel-head"><span class="panel-title">New island</span><button class="btn btn-ghost btn-x" id="createBack">✕</button></div>
          <div class="field">
            <label class="field-label" for="roomNameInput">Island name</label>
            <input id="roomNameInput" class="txt" type="text" maxlength="18" spellcheck="false" placeholder="Tidewreck" autocomplete="off">
          </div>
          <div class="field">
            <label class="field-label">Crew size <span class="field-val" id="maxPlayersVal">4</span></label>
            <input id="maxPlayersInput" class="slider" type="range" min="2" max="8" step="1" value="4">
            <div class="slider-ticks"><span>2</span><span>3</span><span>4</span><span>5</span><span>6</span><span>7</span><span>8</span></div>
          </div>
          <div class="field">
            <label class="field-label">Difficulty</label>
            <div class="seg" id="difficultySeg">
              <button class="seg-btn" data-diff="chill"><b>Chill</b><i>quota ×0.7</i></button>
              <button class="seg-btn is-on" data-diff="normal"><b>Normal</b><i>quota ×1.0</i></button>
              <button class="seg-btn" data-diff="hard"><b>Hard</b><i>quota ×1.4</i></button>
            </div>
          </div>
          <button class="btn btn-big btn-primary" id="btnCreate"><span>SET SAIL</span></button>
        </div>

        <div class="card menu-card panel-join" id="panelJoin">
          <div class="panel-head"><span class="panel-title">Join a crew</span><button class="btn btn-ghost btn-x" id="joinBack">✕</button></div>
          <div class="field">
            <label class="field-label" for="codeInput">Island code</label>
            <input id="codeInput" class="txt code-input" type="text" maxlength="4" spellcheck="false" placeholder="ABCD" autocomplete="off">
          </div>
          <button class="btn btn-big btn-secondary" id="btnJoin"><span>JOIN ISLAND</span></button>
        </div>
      </div>

      <div class="controls-footer">
        <div class="ctl"><kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd><span>move</span></div>
        <div class="ctl"><kbd class="wide">Mouse</kbd><span>look</span></div>
        <div class="ctl"><kbd class="wide">LMB</kbd><span>cast / attack</span></div>
        <div class="ctl"><kbd>E</kbd><span>interact</span></div>
        <div class="ctl"><kbd>C</kbd><span>dive</span></div>
        <div class="ctl"><kbd>1</kbd><kbd>2</kbd><span>rod / weapon</span></div>
        <div class="ctl"><kbd>B</kbd><span>bait</span></div>
        <div class="ctl"><kbd>I</kbd><span>inventory</span></div>
        <div class="ctl"><kbd class="wide">Enter</kbd><span>chat</span></div>
      </div>
    </div>`;
  root.appendChild(menu);

  // wave-animated title letters
  (function buildTitle() {
    const h = menu.querySelector('#gameTitle');
    const words = ['TIDEWRECK', 'ISLAND'];
    let i = 0;
    words.forEach((w, wi) => {
      const ws = el('span', 'tw');
      for (const ch of w) {
        const s = el('span', 'tl', ch);
        s.style.setProperty('--i', String(i++));
        ws.appendChild(s);
      }
      h.appendChild(ws);
      if (wi === 0) h.appendChild(el('span', 'tgap', '&nbsp;'));
    });
  })();

  const nameInput = menu.querySelector('#nameInput');
  const swatches = menu.querySelector('#swatches');
  const panelCreate = menu.querySelector('#panelCreate');
  const panelJoin = menu.querySelector('#panelJoin');
  const menuActions = menu.querySelector('#menuActions');
  const roomNameInput = menu.querySelector('#roomNameInput');
  const maxPlayersInput = menu.querySelector('#maxPlayersInput');
  const maxPlayersVal = menu.querySelector('#maxPlayersVal');
  const codeInput = menu.querySelector('#codeInput');
  let difficulty = 'normal';

  nameInput.value = ui.name;
  PLAYER_COLORS.forEach((c, i) => {
    const s = el('button', 'swatch');
    s.style.setProperty('--c', hex(c));
    s.dataset.i = String(i);
    s.innerHTML = '<span class="swatch-in"></span>';
    s.addEventListener('click', () => {
      ui.color = i;
      state.myColor = i;
      localStorage.setItem(LS_COLOR, String(i));
      refreshSwatches();
    });
    swatches.appendChild(s);
  });
  function refreshSwatches() {
    for (const s of swatches.children) s.classList.toggle('is-on', +s.dataset.i === ui.color);
  }
  refreshSwatches();

  // ---- hat + skin pickers (character customization) ----
  const hatRow = menu.querySelector('#hatRow');
  const skinRow = menu.querySelector('#skinRow');
  const hatVal = menu.querySelector('#hatVal');
  const skinVal = menu.querySelector('#skinVal');

  HATS.forEach((h, i) => {
    const b = el('button', 'pick-chip');
    b.dataset.i = String(i);
    b.title = h.name === 'None' ? 'No hat' : (h.name + ' hat');
    b.innerHTML = `<span class="pick-ico hat-ico">${hatGlyph(i)}</span><i>${escapeHTML(h.name)}</i>`;
    b.addEventListener('click', () => setHat(i));
    hatRow.appendChild(b);
  });
  SKINS.forEach((c, i) => {
    const b = el('button', 'pick-chip');
    b.dataset.i = String(i);
    b.title = skinName(i) + ' skin';
    b.innerHTML = `<span class="pick-ico skin-disc" style="--c:${hex(c)}"></span><i>${escapeHTML(skinName(i))}</i>`;
    b.addEventListener('click', () => setSkin(i));
    skinRow.appendChild(b);
  });
  function refreshLook() {
    for (const b of hatRow.children) b.classList.toggle('is-on', +b.dataset.i === ui.hat);
    for (const b of skinRow.children) b.classList.toggle('is-on', +b.dataset.i === ui.skin);
    setText(hatVal, hatName(ui.hat));
    setText(skinVal, skinName(ui.skin));
  }
  function setHat(i) {
    ui.hat = idx(i, HATS.length);
    state.myHat = ui.hat;
    localStorage.setItem(LS_HAT, String(ui.hat));
    refreshLook();
  }
  function setSkin(i) {
    ui.skin = idx(i, SKINS.length);
    state.mySkin = ui.skin;
    localStorage.setItem(LS_SKIN, String(ui.skin));
    refreshLook();
  }
  refreshLook();

  state.myColor = ui.color;
  state.myName = ui.name;
  state.myHat = ui.hat;
  state.mySkin = ui.skin;

  nameInput.addEventListener('input', () => {
    ui.name = nameInput.value.slice(0, 16);
    state.myName = ui.name;
    localStorage.setItem(LS_NAME, ui.name);
  });

  function setMenuPanel(p) {
    ui.menuPanel = p;
    panelCreate.classList.toggle('is-open', p === 'create');
    panelJoin.classList.toggle('is-open', p === 'join');
    menuActions.classList.toggle('is-dim', p !== 'none');
    if (p === 'create') setTimeout(() => roomNameInput.focus(), 60);
    if (p === 'join') setTimeout(() => codeInput.focus(), 60);
  }
  menu.querySelector('#btnCreateOpen').addEventListener('click', () => setMenuPanel(ui.menuPanel === 'create' ? 'none' : 'create'));
  menu.querySelector('#btnJoinOpen').addEventListener('click', () => setMenuPanel(ui.menuPanel === 'join' ? 'none' : 'join'));
  menu.querySelector('#createBack').addEventListener('click', () => setMenuPanel('none'));
  menu.querySelector('#joinBack').addEventListener('click', () => setMenuPanel('none'));

  maxPlayersInput.addEventListener('input', () => { setText(maxPlayersVal, maxPlayersInput.value); });
  menu.querySelectorAll('#difficultySeg .seg-btn').forEach((b) => {
    b.addEventListener('click', () => {
      difficulty = b.dataset.diff;
      menu.querySelectorAll('#difficultySeg .seg-btn').forEach((o) => o.classList.toggle('is-on', o === b));
    });
  });
  codeInput.addEventListener('input', () => {
    codeInput.value = codeInput.value.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4);
  });
  codeInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); doJoin(); } });
  roomNameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); doCreate(); } });

  function playerName() {
    const n = (nameInput.value || '').trim();
    return n || 'Deckhand';
  }
  // name + colour + look are all committed the moment we hand them to the server
  function commitIdentity(nm) {
    state.myName = nm;
    state.myColor = ui.color;
    state.myHat = ui.hat;
    state.mySkin = ui.skin;
    localStorage.setItem(LS_NAME, nm);
    localStorage.setItem(LS_HAT, String(ui.hat));
    localStorage.setItem(LS_SKIN, String(ui.skin));
  }
  function doCreate() {
    const nm = playerName();
    commitIdentity(nm);
    send(MSG.CREATE_ROOM, {
      playerName: nm,
      color: ui.color,
      hat: ui.hat,
      skin: ui.skin,
      roomName: (roomNameInput.value || '').trim() || 'Tidewreck',
      maxPlayers: parseInt(maxPlayersInput.value, 10) || 4,
      difficulty,
    });
  }
  function doJoin() {
    const code = (codeInput.value || '').toUpperCase().replace(/[^A-Z]/g, '');
    if (code.length !== 4) { toast('Island codes are 4 letters', 'bad'); codeInput.focus(); return; }
    const nm = playerName();
    commitIdentity(nm);
    send(MSG.JOIN_ROOM, { playerName: nm, color: ui.color, hat: ui.hat, skin: ui.skin, code });
  }
  menu.querySelector('#btnCreate').addEventListener('click', doCreate);
  menu.querySelector('#btnJoin').addEventListener('click', doJoin);

  // =============================================================
  // LOBBY
  // =============================================================
  const lobby = el('div', 'screen screen-lobby');
  lobby.innerHTML = `
    <div class="menu-scrim"></div>
    <div class="lobby-inner">
      <div class="card lobby-code-card">
        <div class="code-label">island code</div>
        <div class="code-big" id="lobbyCode">----</div>
        <div class="code-hint">share this with friends <span class="copy-hint" id="copyHint">click to copy</span></div>
      </div>
      <div class="card lobby-main">
        <div class="lobby-head">
          <div class="lobby-title" id="lobbyRoomName">Tidewreck</div>
          <div class="lobby-settings" id="lobbySettings"></div>
        </div>
        <div class="players-list" id="playersList"></div>
        <div class="lobby-actions">
          <button class="btn btn-secondary" id="btnLeave"><span>LEAVE</span></button>
          <button class="btn btn-ready" id="btnReady"><span>READY UP</span></button>
          <button class="btn btn-primary" id="btnStart"><span>START RUN</span></button>
        </div>
        <div class="lobby-note" id="lobbyNote"></div>
      </div>
    </div>`;
  root.appendChild(lobby);

  const lobbyCode = lobby.querySelector('#lobbyCode');
  const lobbyRoomName = lobby.querySelector('#lobbyRoomName');
  const lobbySettings = lobby.querySelector('#lobbySettings');
  const playersList = lobby.querySelector('#playersList');
  const btnReady = lobby.querySelector('#btnReady');
  const btnStart = lobby.querySelector('#btnStart');
  const lobbyNote = lobby.querySelector('#lobbyNote');

  lobby.querySelector('.lobby-code-card').addEventListener('click', () => {
    const code = state.room && state.room.code;
    if (!code) return;
    try {
      navigator.clipboard.writeText(code);
      toast('Code ' + code + ' copied', 'good');
    } catch (e) { toast('Code: ' + code, 'info'); }
  });
  btnReady.addEventListener('click', () => { ui.ready = !ui.ready; send(MSG.SET_READY, { ready: ui.ready }); renderLobby(); });
  btnStart.addEventListener('click', () => { send(MSG.START_GAME, {}); });
  lobby.querySelector('#btnLeave').addEventListener('click', () => {
    send(MSG.LEAVE_ROOM, {});
    setTimeout(() => { try { location.reload(); } catch (e) { /* ignore */ } }, 140);
  });

  function diffMult(d) { return d === 'chill' ? '×0.7' : d === 'hard' ? '×1.4' : '×1.0'; }

  function renderLobby() {
    const r = state.room;
    if (!r) return;
    setText(lobbyCode, (r.code || '----').toUpperCase());
    setText(lobbyRoomName, r.name || 'Tidewreck');
    const st = r.settings || r;
    const maxP = num(st.maxPlayers, 8);
    const dif = st.difficulty || 'normal';
    const list = Array.isArray(r.players) ? r.players : [];
    setHTML(lobbySettings,
      `<span class="chip">${list.length}/${maxP} crew</span>` +
      `<span class="chip">${titleCase(dif)} <i>quota ${diffMult(dif)}</i></span>` +
      `<span class="chip">${ECON.QUOTAS_TO_WIN} quotas to escape</span>`);

    const me = myId();
    const hostId = r.hostId;
    playersList.innerHTML = '';
    let allReady = list.length > 0;
    list.forEach((p) => {
      const isMe = p.id === me;
      if (!p.ready) allReady = false;
      if (isMe && typeof p.ready === 'boolean') ui.ready = p.ready;
      const row = el('div', 'player-row' + (isMe ? ' is-me' : '') + (p.ready ? ' is-ready' : ''));
      const ci = Math.max(0, Math.min(PLAYER_COLORS.length - 1, num(p.color, 0)));
      // hat/skin ride along on ROOM_STATE now — absent on older payloads, so default to 0
      const hi = idx(p.hat, HATS.length);
      const si = idx(p.skin, SKINS.length);
      row.innerHTML =
        `<span class="pdot" style="--c:${hex(PLAYER_COLORS[ci])}"></span>` +
        `<span class="plook" title="${escapeHTML(hatName(hi) + ' · ' + skinName(si) + ' skin')}">` +
        `<span class="pskin" style="--c:${skinHex(si)}"></span>` +
        `<span class="phat">${hatGlyph(hi)}</span>` +
        `</span>` +
        `<span class="pname">${escapeHTML(p.name || 'Deckhand')}${isMe ? '<i class="you">you</i>' : ''}</span>` +
        (p.id === hostId ? `<span class="pcrown" title="host">${SVG_CROWN}</span>` : '') +
        `<span class="pready">${p.ready ? SVG_CHECK + '<b>ready</b>' : '<b class="dim">waiting…</b>'}</span>`;
      playersList.appendChild(row);
    });
    for (let i = list.length; i < maxP; i++) {
      playersList.appendChild(el('div', 'player-row is-empty', '<span class="pdot empty"></span><span class="pname dim">open berth</span>'));
    }

    btnReady.classList.toggle('is-on', ui.ready);
    setText(btnReady.querySelector('span'), ui.ready ? 'READY!' : 'READY UP');
    const isHost = me && hostId && me === hostId;
    btnStart.style.display = isHost ? '' : 'none';
    btnStart.disabled = !allReady;
    setText(lobbyNote, isHost
      ? (allReady ? 'Everyone is ready. Cast off.' : 'Waiting for the crew to ready up…')
      : 'The host starts the run.');
  }

  function escapeHTML(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // =============================================================
  // HUD
  // =============================================================
  const hud = el('div', 'screen screen-hud');
  hud.innerHTML = `
    <div class="hud-vignette"></div>
    <div class="event-vignette" id="eventVignette"></div>
    <div class="damage-vignette" id="damageVignette"></div>

    <div class="hud-topleft">
      <div class="artifact-tracker" id="artifactTracker"></div>
      <div class="area-chip" id="areaChip"></div>
    </div>

    <div class="hud-topbar" id="hudTopbar">
      <div class="day-chip">
        <div class="sky-icon" id="skyIcon">${SVG_SUN}</div>
        <div class="day-txt"><b id="dayNum">DAY 1</b><i id="dayPhase">morning</i></div>
      </div>
      <div class="weather-chip" id="weatherChip" data-w="clear">
        <span class="wx-ico" id="wxIco">${SVG_WX.clear}</span>
        <span class="wx-txt"><b id="wxName">Clear Skies</b><i id="wxHint">calm water</i></span>
      </div>
      <div class="quota-block">
        <div class="quota-head"><span id="quotaN">QUOTA 0/10</span><span class="quota-nums" id="quotaNums">0 / 400</span></div>
        <div class="quota-bar">
          <div class="quota-preview" id="quotaPreview"></div>
          <div class="quota-fill" id="quotaFill"></div>
          <div class="quota-sheen"></div>
        </div>
      </div>
      <div class="deadline-chip" id="deadlineChip"><b id="deadlineTxt">Tsunami in 3 days</b></div>
    </div>

    <div class="hud-wallet" id="hudWallet">
      <span class="wallet-coin">${SVG_COIN}</span>
      <span class="wallet-num" id="walletNum">0</span>
      <span class="wallet-delta" id="walletDelta"></span>
      <span class="wallet-label">team purse</span>
    </div>

    <div class="hud-bottomleft">
      <div class="chat-log" id="chatLog"></div>
      <div class="chat-input-wrap" id="chatWrap">
        <span class="chat-caret">say</span>
        <input id="chatInput" class="chat-input" type="text" maxlength="140" spellcheck="false" autocomplete="off" placeholder="press enter to send…">
      </div>
      <div class="vitals">
        <div class="bar-row hp-row">
          <span class="bar-ico">${SVG_HEART}</span>
          <div class="bar hp-bar"><div class="bar-fill" id="hpFill"></div><span class="bar-txt" id="hpTxt">100</span></div>
        </div>
        <div class="bar-row air-row" id="airRow">
          <span class="bar-ico air-ico">◌</span>
          <div class="bar air-bar"><div class="bar-fill" id="airFill"></div><span class="bar-txt" id="airTxt">AIR</span></div>
        </div>
      </div>
    </div>

    <div class="hud-hotbar" id="hotbar">
      <button class="slot" id="slotRod" data-key="1">
        <span class="slot-key">1</span>
        <span class="slot-ico" id="rodIco">${rodIcon(1)}</span>
        <span class="slot-name" id="rodName">Driftwood Rod</span>
        <span class="slot-sub" id="rodSub">Lv 1</span>
      </button>
      <button class="slot" id="slotWeapon" data-key="2">
        <span class="slot-key">2</span>
        <span class="slot-ico" id="weaponIco">${weaponIcon('harpoon')}</span>
        <span class="slot-name" id="weaponName">—</span>
        <span class="slot-sub" id="weaponSub">no weapon</span>
      </button>
      <button class="slot slot-bait" id="slotBait" data-key="B">
        <span class="slot-key">B</span>
        <span class="slot-ico" id="baitIco">${baitIcon('worms')}</span>
        <span class="slot-name" id="baitName">No bait</span>
        <span class="slot-sub" id="baitSub">—</span>
      </button>
      <button class="slot slot-inv" id="slotInv" data-key="I">
        <span class="slot-key">I</span>
        <span class="slot-ico">${SVG_BAG}</span>
        <span class="slot-name">Catch bag</span>
        <span class="slot-sub" id="invSub">0 fish</span>
      </button>
    </div>

    <div class="hud-prompt" id="hudPrompt"><kbd>E</kbd><span id="promptTxt"></span></div>

    <div class="cast-power" id="castPower">
      <div class="cast-label">CAST POWER</div>
      <div class="cast-track">
        <div class="cast-fill" id="castFill"></div>
        <div class="cast-band" id="castBand"></div>
      </div>
      <div class="cast-band-hint">perfect throw</div>
    </div>

    <div class="perfect-burst" id="perfectBurst">
      <span class="pb-rays"></span>
      <b class="pb-txt" data-text="PERFECT!">PERFECT!</b>
    </div>

    <div class="downed-layer" id="downedLayer"></div>

    <div class="revive-ring" id="reviveRing">
      <div class="rr-ring">
        <svg viewBox="0 0 72 72">
          <circle class="rr-bg" cx="36" cy="36" r="30"></circle>
          <circle class="rr-fg" id="rrFg" cx="36" cy="36" r="30"></circle>
        </svg>
        <span class="rr-ico">${SVG_HEART}</span>
      </div>
      <div class="rr-txt" id="rrTxt">Reviving…</div>
      <div class="rr-hint">hold <kbd>E</kbd></div>
    </div>

    <div class="tow-hint" id="towHint">
      <span class="th-ico">${REVIVE_SVG.rescueclaw}</span>
      <span class="th-txt"><b id="towName">Crewmate</b><i>bring them to air</i></span>
    </div>

    <div class="reel-widget" id="reelWidget">
      <div class="reel-title">REEL!</div>
      <div class="reel-body">
        <div class="reel-track">
          <div class="reel-zone" id="reelZone"></div>
          <div class="reel-marker" id="reelMarker"></div>
        </div>
        <div class="reel-ring">
          <svg viewBox="0 0 64 64">
            <circle class="ring-bg" cx="32" cy="32" r="26"></circle>
            <circle class="ring-fg" id="reelRing" cx="32" cy="32" r="26"></circle>
          </svg>
          <span class="ring-pct" id="reelPct">0%</span>
        </div>
      </div>
      <div class="reel-hint">hold in the band</div>
    </div>

    <div class="ko-overlay" id="koOverlay">
      <div class="ko-inner">
        <div class="ko-title">OUT COLD</div>
        <div class="ko-sub">You're out cold — sunrise revives you</div>
        <div class="ko-kit" id="koKit"><kbd>R</kbd><span id="koKitTxt">Revival Kit</span></div>
        <div class="ko-hint" id="koHint">A crewmate can revive you with Sea Salts</div>
      </div>
    </div>

    <div class="event-banner" id="eventBanner">
      <div class="eb-title" id="ebTitle" data-text="">THE SERPENT</div>
      <div class="eb-desc" id="ebDesc"></div>
    </div>

    <div class="quota-banner" id="quotaBanner">
      <div class="qb-sweep"></div>
      <div class="qb-title" id="qbTitle">QUOTA MET</div>
      <div class="qb-sub" id="qbSub"></div>
    </div>

    <div class="artifact-banner" id="artifactBanner">
      <div class="ab-ico" id="abIco"></div>
      <div class="ab-txt"><b>NEW ARTIFACT</b><i id="abName"></i></div>
    </div>

    <div class="catch-card" id="catchCard">
      <div class="cc-glow"></div>
      <div class="cc-tier" id="ccTier">T1</div>
      <img class="cc-icon fish-icon" id="ccIcon" alt="">
      <div class="cc-name" id="ccName">Sardine</div>
      <div class="cc-stats"><span id="ccWeight">0.0 kg</span><span class="cc-dot">•</span><span class="cc-value">${SVG_COIN}<b id="ccValue">0</b></span></div>
      <div class="cc-record" id="ccRecord">PERSONAL BEST</div>
    </div>

    <div class="unique-card" id="uniqueCard">
      <div class="uq-rays"></div>
      <div class="uq-badge">ONE OF A KIND</div>
      <div class="uq-gem" id="uqGem">${SVG_LOOT_GEM}</div>
      <div class="uq-name" id="uqName">Charm</div>
      <div class="uq-eff" id="uqEff"></div>
      <div class="uq-desc" id="uqDesc"></div>
    </div>

    <div class="flopper-strip" id="flopperStrip">
      <div class="flopper-rows" id="flopperRows"></div>
      <div class="fl-prompt fl-prompt-bonk"><b>BONK IT</b><span>before it escapes!</span><kbd>LMB</kbd><i>up close</i></div>
      <div class="fl-prompt fl-prompt-grab"><b>GRAB IT</b><span>it stopped moving — pick it up</span><kbd>E</kbd><i>or walk over it</i></div>
    </div>

    <div class="lightning-flash" id="lightningFlash"></div>

    <div class="tsunami-flash" id="tsunamiFlash"><div class="tf-txt">TSUNAMI</div><div class="tf-wave"></div></div>`;
  root.appendChild(hud);

  const $ = (id) => hud.querySelector('#' + id);
  const elSkyIcon = $('skyIcon'), elDayNum = $('dayNum'), elDayPhase = $('dayPhase');
  const elQuotaN = $('quotaN'), elQuotaNums = $('quotaNums'), elQuotaFill = $('quotaFill'), elQuotaPreview = $('quotaPreview');
  const elDeadlineChip = $('deadlineChip'), elDeadlineTxt = $('deadlineTxt');
  const elWallet = $('hudWallet'), elWalletNum = $('walletNum'), elWalletDelta = $('walletDelta');
  const elHpFill = $('hpFill'), elHpTxt = $('hpTxt'), elAirRow = $('airRow'), elAirFill = $('airFill'), elAirTxt = $('airTxt');
  const elPrompt = $('hudPrompt'), elPromptTxt = $('promptTxt');
  const elCastPower = $('castPower'), elCastFill = $('castFill'), elCastBand = $('castBand');
  const elPerfect = $('perfectBurst');
  const elDownedLayer = $('downedLayer');
  const elReviveRing = $('reviveRing'), elRrFg = $('rrFg'), elRrTxt = $('rrTxt');
  const elTowHint = $('towHint'), elTowName = $('towName');
  const elReel = $('reelWidget'), elReelZone = $('reelZone'), elReelMarker = $('reelMarker'), elReelRing = $('reelRing'), elReelPct = $('reelPct');
  const elKO = $('koOverlay'), elKoKit = $('koKit'), elKoKitTxt = $('koKitTxt'), elKoHint = $('koHint');
  const elEventBanner = $('eventBanner'), elEbTitle = $('ebTitle'), elEbDesc = $('ebDesc');
  const elEventVig = $('eventVignette'), elDamageVig = $('damageVignette');
  const elQuotaBanner = $('quotaBanner'), elQbTitle = $('qbTitle'), elQbSub = $('qbSub');
  const elArtifactBanner = $('artifactBanner'), elAbIco = $('abIco'), elAbName = $('abName');
  const elCatch = $('catchCard'), elCcTier = $('ccTier'), elCcIcon = $('ccIcon'), elCcName = $('ccName'),
    elCcWeight = $('ccWeight'), elCcValue = $('ccValue'), elCcRecord = $('ccRecord');
  const elArtiTracker = $('artifactTracker'), elAreaChip = $('areaChip');
  const elChatLog = $('chatLog'), elChatWrap = $('chatWrap'), elChatInput = $('chatInput');
  const elTsunamiFlash = $('tsunamiFlash');
  const elRodIco = $('rodIco'), elRodName = $('rodName'), elRodSub = $('rodSub');
  const elWeaponIco = $('weaponIco'), elWeaponName = $('weaponName'), elWeaponSub = $('weaponSub');
  const elBaitIco = $('baitIco'), elBaitName = $('baitName'), elBaitSub = $('baitSub');
  const elSlotRod = $('slotRod'), elSlotWeapon = $('slotWeapon'), elInvSub = $('invSub');
  const elWeatherChip = $('weatherChip'), elWxIco = $('wxIco'), elWxName = $('wxName'), elWxHint = $('wxHint');
  const elFlopStrip = $('flopperStrip'), elFlopRows = $('flopperRows'), elLightning = $('lightningFlash');
  const elUnique = $('uniqueCard'), elUqName = $('uqName'), elUqEff = $('uqEff'), elUqDesc = $('uqDesc');

  const RING_LEN = TAU * 26;
  elReelRing.style.strokeDasharray = RING_LEN.toFixed(2);
  elReelRing.style.strokeDashoffset = RING_LEN.toFixed(2);
  const RR_LEN = TAU * 30;
  elRrFg.style.strokeDasharray = RR_LEN.toFixed(2);
  elRrFg.style.strokeDashoffset = RR_LEN.toFixed(2);

  // artifact tracker slots
  const artiKeys = Object.keys(ARTIFACTS);
  artiKeys.forEach((k) => {
    const s = el('div', 'arti-slot');
    s.dataset.a = k;
    s.innerHTML = `<span class="arti-ico">${artifactIcon(k)}</span><span class="arti-tip">${escapeHTML(ARTIFACTS[k].name)}</span>`;
    elArtiTracker.appendChild(s);
  });

  elSlotRod.addEventListener('click', () => setTool('rod'));
  elSlotWeapon.addEventListener('click', () => setTool('weapon', true));
  $('slotBait').addEventListener('click', () => cycleBait());
  $('slotInv').addEventListener('click', () => toggleInventory());

  // =============================================================
  // MODALS (shop + inventory)
  // =============================================================
  const modalLayer = el('div', 'modal-layer');
  modalLayer.innerHTML = `
    <div class="modal-scrim" id="modalScrim"></div>

    <div class="modal shop-modal" id="shopModal">
      <div class="modal-head">
        <div class="modal-title"><span class="mt-main">THE SALT &amp; SCALE</span><span class="mt-sub">tidewreck trading post</span></div>
        <div class="modal-wallet"><span>${SVG_COIN}</span><b id="shopWallet">0</b><i>team purse</i></div>
        <button class="btn btn-ghost btn-x" id="shopClose">✕</button>
      </div>
      <div class="shop-tabs" id="shopTabs"></div>
      <div class="shop-body" id="shopBody"></div>
      <div class="sell-bar" id="sellBar">
        <div class="sell-info"><b id="sellCount">0 selected</b><span id="sellValue">0</span></div>
        <div class="sell-quota"><div class="sq-bar"><div class="sq-fill" id="sqFill"></div><div class="sq-add" id="sqAdd"></div></div><i id="sqTxt"></i></div>
        <div class="sell-btns">
          <button class="btn btn-secondary" id="btnSellAll"><span>SELL ALL</span></button>
          <button class="btn btn-primary" id="btnSellSel"><span>SELL SELECTED</span></button>
        </div>
      </div>
    </div>

    <div class="modal inv-modal" id="invModal">
      <div class="modal-head">
        <div class="modal-title"><span class="mt-main">CATCH BAG</span><span class="mt-sub" id="invSummary">nothing yet</span></div>
        <button class="btn btn-ghost btn-x" id="invClose">✕</button>
      </div>
      <div class="bait-strip" id="baitStrip"></div>
      <div class="charm-strip" id="charmStrip"></div>
      <div class="inv-body" id="invBody"></div>
    </div>`;
  root.appendChild(modalLayer);

  const elShopModal = modalLayer.querySelector('#shopModal');
  const elInvModal = modalLayer.querySelector('#invModal');
  const elShopTabs = modalLayer.querySelector('#shopTabs');
  const elShopBody = modalLayer.querySelector('#shopBody');
  const elShopWallet = modalLayer.querySelector('#shopWallet');
  const elSellBar = modalLayer.querySelector('#sellBar');
  const elSellCount = modalLayer.querySelector('#sellCount');
  const elSellValue = modalLayer.querySelector('#sellValue');
  const elSqFill = modalLayer.querySelector('#sqFill');
  const elSqAdd = modalLayer.querySelector('#sqAdd');
  const elSqTxt = modalLayer.querySelector('#sqTxt');
  const elInvBody = modalLayer.querySelector('#invBody');
  const elBaitStrip = modalLayer.querySelector('#baitStrip');
  const elCharmStrip = modalLayer.querySelector('#charmStrip');
  const elInvSummary = modalLayer.querySelector('#invSummary');

  modalLayer.querySelector('#modalScrim').addEventListener('click', () => closeAll());
  modalLayer.querySelector('#shopClose').addEventListener('click', () => closeShop());
  modalLayer.querySelector('#invClose').addEventListener('click', () => closeInventory());
  modalLayer.querySelector('#btnSellAll').addEventListener('click', () => sellFish(true));
  modalLayer.querySelector('#btnSellSel').addEventListener('click', () => sellFish(false));

  const SHOP_TABS = [
    { k: 'rod', label: 'Rods' },
    { k: 'boat', label: 'Boat' },
    { k: 'bait', label: 'Baits' },
    { k: 'weapon', label: 'Weapons' },
    { k: 'charm', label: 'Charms' },
    { k: 'revive', label: 'Rescue' },
    { k: 'diving', label: 'Diving' },
    { k: 'ward', label: 'Ward' },
    { k: 'sell', label: 'Sell' },
  ];
  SHOP_TABS.forEach((t) => {
    const b = el('button', 'shop-tab', `<b>${t.label}</b>`);
    b.dataset.k = t.k;
    b.addEventListener('click', () => { ui.shopTab = t.k; renderShop(); });
    elShopTabs.appendChild(b);
  });

  // =============================================================
  // END SCREENS
  // =============================================================
  const endScreen = el('div', 'screen screen-end');
  endScreen.innerHTML = `
    <div class="end-bg" id="endBg"></div>
    <div class="end-inner">
      <div class="end-kicker" id="endKicker"></div>
      <h2 class="end-title" id="endTitle"></h2>
      <p class="end-reason" id="endReason"></p>
      <p class="end-note" id="endNote"></p>
      <div class="card end-stats" id="endStats"></div>
      <div class="end-credit" id="endCredit"></div>
      <button class="btn btn-big btn-primary" id="btnBackMenu"><span>BACK TO THE DOCK</span></button>
    </div>`;
  root.appendChild(endScreen);
  endScreen.querySelector('#btnBackMenu').addEventListener('click', () => { try { location.reload(); } catch (e) { /* ignore */ } });
  const elEndBg = endScreen.querySelector('#endBg');
  const elEndKicker = endScreen.querySelector('#endKicker');
  const elEndTitle = endScreen.querySelector('#endTitle');
  const elEndReason = endScreen.querySelector('#endReason');
  const elEndNote = endScreen.querySelector('#endNote');
  const elEndStats = endScreen.querySelector('#endStats');
  const elEndCredit = endScreen.querySelector('#endCredit');

  function renderStats(stats) {
    elEndStats.innerHTML = '';
    const head = el('div', 'stats-head', 'RUN LOG');
    elEndStats.appendChild(head);
    const entries = (stats && typeof stats === 'object') ? Object.entries(stats) : [];
    if (!entries.length) {
      elEndStats.appendChild(el('div', 'stat-row', '<span>Story</span><b>Not recorded</b>'));
      return;
    }
    for (const [k, v] of entries) {
      let val;
      if (Array.isArray(v)) {
        val = v.length ? v.map((x) => {
          const f = typeof x === 'string' ? fishById(x) : null;
          if (f) return f.name;
          if (typeof x === 'string' && ARTIFACTS[x]) return ARTIFACTS[x].name;
          if (typeof x === 'string' && EVENTS[x]) return EVENTS[x].name;
          if (x && typeof x === 'object') return x.name || x.id || '?';
          return String(x);
        }).join(' · ') : '—';
      } else if (v && typeof v === 'object') {
        val = Object.entries(v).map(([kk, vv]) => `${prettyKey(kk)} ${typeof vv === 'number' ? money(vv) : vv}`).join(' · ');
      } else if (typeof v === 'number') {
        val = Number.isInteger(v) ? v.toLocaleString('en-US') : v.toFixed(1);
      } else if (typeof v === 'boolean') {
        val = v ? 'yes' : 'no';
      } else {
        val = String(v);
      }
      const row = el('div', 'stat-row');
      const kEl = el('span'); kEl.textContent = prettyKey(k);
      const vEl = el('b'); vEl.textContent = val;
      row.appendChild(kEl);
      row.appendChild(vEl);
      elEndStats.appendChild(row);
    }
  }

  function showEnd(kind, data) {
    ui.endData = { kind, data };
    const won = kind === 'won';
    endScreen.classList.toggle('is-won', won);
    endScreen.classList.toggle('is-lost', !won);
    elEndBg.className = 'end-bg ' + (won ? 'bg-sunrise' : 'bg-tsunami');
    endScreen.classList.remove('is-wipe');
    let note = '';
    if (won) {
      setText(elEndKicker, 'the ring opened at dawn');
      setText(elEndTitle, 'YOU ESCAPED TIDEWRECK ISLAND');
      setText(elEndReason, 'Ten quotas paid, three artifacts carried, one crew intact. The water let you go.');
      setText(elEndCredit, 'made with your crew');
    } else {
      const reason = (data && data.reason) || 'tsunami';
      setText(elEndKicker, 'the run ends');
      if (reason === 'wipe') {
        // a team wipe is its own ending: no quota failed, the island simply took its due
        endScreen.classList.add('is-wipe');
        setText(elEndKicker, 'nobody was left standing');
        setText(elEndTitle, 'THE CREW IS GONE');
        setText(elEndReason, 'The sea took the whole crew.');
        note = 'Every last one of you went under at once — so the water came up to collect the rest.';
      } else {
        setText(elEndTitle, 'THE TIDE CAME TO COLLECT');
        setText(elEndReason, 'The quota went unpaid. A black wall of water folded the island flat.');
      }
      setText(elEndCredit, 'the sea remembers. try again.');
    }
    setText(elEndNote, note);
    elEndNote.style.display = note ? '' : 'none';
    renderStats(data && data.stats);
    state.phase = 'over';
    applyPhase(true);
  }

  // =============================================================
  // PHASE HANDLING
  // =============================================================
  function effectivePhase() {
    const p = state.phase || 'menu';
    if (p === 'menu' && state.room && !state.room.started) return 'lobby';
    return p;
  }
  function applyPhase(force) {
    const p = effectivePhase();
    if (!force && p === ui.phase) return;
    ui.phase = p;
    root.dataset.phase = p;
    if (p !== 'playing') {
      closeShop(); closeInventory(); closeChat(false); clearFloppers(); ui.lootNear = null;
      hideReviveRing(); setTowing(null); clearDownedMarkers();
    }
    // the doomsday blackout only ever lifts on the way back to the dock
    if (p === 'menu' || p === 'lobby') endDoomsday();
    if (p === 'lobby') renderLobby();
    if (p === 'playing') { refreshHUDFromState(); refreshHotbar(); }
  }

  // =============================================================
  // DOOMSDAY — the tsunami cinematic owns the whole screen
  // =============================================================
  // One class on the hud root hides EVERY hud element (chips, quota, wallet,
  // hotbar, vitals, prompts, chat, banners, cards, the flopper strip). Nothing
  // may re-show itself while it is on: toasts bail out early, the prompt and
  // the transient widgets are force-hidden here and refuse to come back.
  function startDoomsday() {
    if (ui.doom) return;
    ui.doom = true;
    root.classList.add('doomsday');
    hud.classList.add('is-doom');
    closeShop();
    closeInventory();
    closeChat(false);
    clearFloppers();
    clearDownedMarkers();
    hideReviveRing();
    setTowing(null);
    hideCastPower();
    hidePerfect();
    hideReel();
    ui.lootNear = null;
    ui.interact = null;
    elPrompt.classList.remove('show');
    elCatch.classList.remove('show');
    elUnique.classList.remove('show');
    elArtifactBanner.classList.remove('show');
    elQuotaBanner.classList.remove('show');
    elEventBanner.classList.remove('show');
    elKO.classList.remove('show');
    ui.koShown = false;
    toastLayer.innerHTML = '';
  }
  function endDoomsday() {
    if (!ui.doom && !root.classList.contains('doomsday')) return;
    ui.doom = false;
    root.classList.remove('doomsday');
    hud.classList.remove('is-doom');
    elTsunamiFlash.classList.remove('show');
    root.classList.remove('shake-long');
  }

  // =============================================================
  // WORLD STATE / HUD REFRESH
  // =============================================================
  function onWorldState(w) {
    if (!w || typeof w !== 'object') return;
    state.world = w;
    if (typeof w.timeOfDay === 'number') { /* main interpolates state.timeOfDay */ }
    // artifacts growth -> NEW ARTIFACT banner
    const arts = Array.isArray(w.artifacts) ? w.artifacts : [];
    if (!ui.sawWorld) {
      ui.sawWorld = true;
      ui.lastArtifacts = arts.length;
    } else if (arts.length > ui.lastArtifacts) {
      const gained = arts[arts.length - 1];
      ui.lastArtifacts = arts.length;
      if (ui.phase === 'playing' && fresh('artb:' + gained, 3000)) showArtifactBanner(gained);
    } else if (arts.length < ui.lastArtifacts) {
      ui.lastArtifacts = arts.length;
    }
    refreshHUDFromState();
    if (ui.shopOpen) renderShop();
  }

  function refreshHUDFromState() {
    const w = state.world;
    if (!w) return;
    const day = Math.max(1, Math.floor(num(w.day, 1)));
    setText(elDayNum, 'DAY ' + day);

    const q = w.quota || {};
    const n = Math.max(0, Math.floor(num(q.n, 0)));
    const target = Math.max(1, num(q.target, quotaTarget(n)));
    const progress = Math.max(0, num(q.progress, 0));
    setText(elQuotaN, 'QUOTA ' + n + '/' + ECON.QUOTAS_TO_WIN);
    setText(elQuotaNums, money(progress) + ' / ' + money(target));
    const frac = clamp01(progress / target);
    elQuotaFill.style.width = (frac * 100).toFixed(2) + '%';
    elQuotaFill.classList.toggle('is-full', frac >= 0.999);

    const dl = Math.floor(num(q.deadlineDay, day + ECON.QUOTA_CYCLE_DAYS));
    const left = dl - day;
    setText(elDeadlineTxt, left <= 0 ? 'Tsunami TODAY' : ('Tsunami in ' + left + (left === 1 ? ' day' : ' days')));
    elDeadlineChip.classList.toggle('is-urgent', left <= 1);

    const wallet = num(w.wallet, 0);
    if (ui.lastWallet == null) {
      ui.lastWallet = wallet;
      setText(elWalletNum, money(wallet));
    } else if (wallet !== ui.lastWallet) {
      const d = wallet - ui.lastWallet;
      ui.lastWallet = wallet;
      setText(elWalletNum, money(wallet));
      elWallet.classList.remove('pop'); void elWallet.offsetWidth; elWallet.classList.add('pop');
      elWalletDelta.textContent = (d > 0 ? '+' : '') + money(d);
      elWalletDelta.className = 'wallet-delta ' + (d > 0 ? 'up' : 'down');
      void elWalletDelta.offsetWidth;
      elWalletDelta.classList.add('go');
    }
    setText(elShopWallet, money(wallet));

    const arts = Array.isArray(w.artifacts) ? w.artifacts : [];
    for (const s of elArtiTracker.children) s.classList.toggle('is-on', arts.indexOf(s.dataset.a) >= 0);

    // weather rides along on WORLD_STATE (may be absent on older payloads)
    if (w.weather && typeof w.weather.type === 'string') setWeather(w.weather.type);

    // gear (and now unique charms) may ride along on world.players
    if (Array.isArray(w.players)) {
      const me = myId();
      const mine = w.players.find((p) => p && p.id === me);
      if (mine && mine.gear && typeof mine.gear === 'object') {
        state.gear = Object.assign({}, state.gear, mine.gear);
        refreshHotbar();
      }
    }
    if (ui.invOpen) renderCharmStrip();
  }

  function showArtifactBanner(id) {
    if (ui.doom) return;
    const a = ARTIFACTS[id];
    elAbIco.innerHTML = artifactIcon(id);
    setText(elAbName, a ? a.name : 'Unknown relic');
    elArtifactBanner.classList.remove('show'); void elArtifactBanner.offsetWidth;
    elArtifactBanner.classList.add('show');
    setTimeout(() => elArtifactBanner.classList.remove('show'), 4200);
    toast('New artifact: ' + (a ? a.name : id), 'good');
  }

  // =============================================================
  // WEATHER CHIP
  // =============================================================
  let curWeather = null;
  let wxPopTimer = 0;
  function setWeather(type) {
    const t = WEATHER[type] ? type : 'clear';
    if (t === curWeather) return;
    const first = curWeather === null;
    curWeather = t;
    const def = WEATHER[t];
    setHTML(elWxIco, wxIcon(t));
    setText(elWxName, def.name);
    setText(elWxHint, wxHint(t));
    elWeatherChip.dataset.w = t;
    root.dataset.weather = t;
    elWeatherChip.classList.remove('wx-pop'); void elWeatherChip.offsetWidth;
    elWeatherChip.classList.add('wx-pop');
    // the class has to come back off or it would shadow the storm's pulse
    clearTimeout(wxPopTimer);
    wxPopTimer = setTimeout(() => elWeatherChip.classList.remove('wx-pop'), 700);
    if (first) return;                              // the opening weather is not "news"
    if (effectivePhase() !== 'playing') return;
    if (!fresh('wx:' + t, 1200)) return;
    toast(def.name + ' — ' + wxHazard(t), 'weather');
  }

  // =============================================================
  // FLOPPERS — your landed catch is alive and heading for the rail
  // =============================================================
  const floppers = new Map();   // flopperId -> row record

  function flopperName(fish) {
    if (!fish) return 'Your catch';
    const def = fishById(fish.fishId || fish.id) || null;
    const base = fish.name || (def ? def.name : 'Your catch');
    return mutName(base, fish.mutation);
  }
  function pipCount(maxHp) {
    return Math.max(2, Math.min(14, Math.round(num(maxHp, FLOPPER.BASE_HP) / 5)));
  }

  function addFlopper(id, d) {
    if (floppers.has(id)) return floppers.get(id);
    const fish = d && d.fish ? d.fish : null;
    const maxHp = Math.max(1, num(d && d.maxHp, num(fish && fish.tier, 1) * FLOPPER.HP_PER_TIER + FLOPPER.BASE_HP));
    const hp = Math.max(0, num(d && d.hp, maxHp));
    const n = pipCount(maxHp);
    const name = flopperName(fish);
    const fid = fish ? (fish.fishId || fish.id || '') : '';

    const row = el('div', 'flopper');
    row.dataset.id = id;
    row.innerHTML =
      (fid
        ? `<img class="fl-icon fish-icon" data-fkey="1" data-fid="${escapeHTML(fid)}" data-fmut="${escapeHTML((fish && fish.mutation) || '')}" src="${fishIcon(fid, fish && fish.mutation, 96)}" alt="">`
        : '<span class="fl-icon fl-icon-blank"></span>') +
      `<div class="fl-main">` +
      `<div class="fl-top"><b class="fl-name${fish && fish.mutation ? ' mut-' + fish.mutation : ''}">${escapeHTML(name)}</b>` +
      `<span class="fl-pips"></span><b class="fl-grab">GRAB IT!</b></div>` +
      `<div class="fl-timer"><div class="fl-timer-fill"></div><span class="fl-timer-txt"></span></div>` +
      `</div>` +
      `<div class="fl-verdict"></div>`;
    const pips = row.querySelector('.fl-pips');
    for (let i = 0; i < n; i++) pips.appendChild(el('span', 'fl-pip'));
    elFlopRows.appendChild(row);

    const rec = {
      el: row, pips, n, hp, maxHp,
      fill: row.querySelector('.fl-timer-fill'),
      timeTxt: row.querySelector('.fl-timer-txt'),
      verdict: row.querySelector('.fl-verdict'),
      // the server may state its own window; fall back to the shared constant
      escapeS: Math.max(3, num(d && d.escapeSeconds, ESCAPE_S)),
      spawn: performance.now(), done: false, removeAt: 0,
      // 'alive' = bonk it · 'dead' = it is a pickup now · done = stowed/lost
      state: 'alive', deadAt: 0,
    };
    floppers.set(id, rec);
    paintPips(rec);
    refreshFlopperStrip();
    return rec;
  }

  function paintPips(rec) {
    const frac = clamp01(rec.hp / Math.max(1, rec.maxHp));
    const lit = rec.hp <= 0 ? 0 : Math.max(1, Math.ceil(frac * rec.n));
    for (let i = 0; i < rec.pips.children.length; i++) {
      rec.pips.children[i].classList.toggle('is-out', i >= lit);
    }
    rec.el.classList.toggle('is-hurt', frac <= 0.34);
  }

  // wave 4: the killing bonk does NOT bank the fish any more. It stops
  // flopping and becomes a glowing pickup — the row switches from hp pips to
  // "grab it" and only leaves on 'stowed' (or the server's auto-bank).
  function pickupFlopper(id, d) {
    const rec = floppers.get(id) || addFlopper(id, d);
    if (!rec || rec.done || rec.state === 'dead') return;
    rec.state = 'dead';
    rec.hp = 0;
    rec.deadAt = performance.now();
    paintPips(rec);
    rec.el.classList.remove('is-warn', 'is-crit', 'is-hurt');
    rec.el.classList.add('is-dead');
    rec.fill.style.width = '100%';
    setText(rec.timeTxt, 'yours');
    refreshFlopperStrip();
  }

  function hitFlopper(id, d) {
    const rec = floppers.get(id) || addFlopper(id, d);
    if (!rec || rec.done || rec.state === 'dead') return;
    if (typeof (d && d.maxHp) === 'number' && d.maxHp > 0) rec.maxHp = d.maxHp;
    if (typeof (d && d.hp) === 'number') rec.hp = Math.max(0, d.hp);
    paintPips(rec);
    rec.el.classList.remove('is-hit'); void rec.el.offsetWidth;
    rec.el.classList.add('is-hit');
  }

  function endFlopper(id, kept) {
    const rec = floppers.get(id);
    if (!rec || rec.done) return;
    rec.done = true;
    rec.state = 'done';
    rec.hp = kept ? 0 : rec.hp;
    if (kept) paintPips(rec);
    rec.el.classList.remove('is-dead');
    rec.el.classList.add(kept ? 'is-stowed' : 'is-lost');
    setText(rec.verdict, kept ? 'STOWED!' : 'IT GOT AWAY!');
    rec.removeAt = performance.now() + (kept ? 950 : 1250);
  }

  function dropFlopper(id) {
    const rec = floppers.get(id);
    if (!rec) return;
    if (rec.el.parentNode) rec.el.parentNode.removeChild(rec.el);
    floppers.delete(id);
    refreshFlopperStrip();
  }

  function refreshFlopperStrip() {
    let live = 0, grab = 0;
    for (const rec of floppers.values()) {
      if (rec.done) continue;
      if (rec.state === 'dead') grab++; else live++;
    }
    elFlopStrip.classList.toggle('show', floppers.size > 0);
    elFlopStrip.classList.toggle('has-live', live > 0);
    elFlopStrip.classList.toggle('has-pickup', grab > 0);
    elFlopStrip.classList.toggle('is-crowd', floppers.size > 2);
  }

  function onFlopper(d) {
    if (!d || typeof d !== 'object' || ui.doom) return;
    const id = (d.flopperId != null) ? String(d.flopperId) : '';
    if (!id) return;
    const st = String(d.state || 'spawn');
    if (!fresh('flp:' + id + ':' + st + ':' + (d.hp != null ? d.hp : ''), 250)) return;
    if (st === 'spawn') addFlopper(id, d);
    else if (st === 'hit') hitFlopper(id, d);
    else if (st === 'dead') pickupFlopper(id, d);
    else if (st === 'stowed') endFlopper(id, true);
    else if (st === 'escaped') endFlopper(id, false);
  }

  const ESCAPE_S = Math.max(3, num(FLOPPER.ESCAPE_SECONDS, 25));
  // the server banks an unclaimed kill after ~20 s, so a catch is never lost
  const BANK_S = 20;
  function tickFloppers() {
    if (!floppers.size) return;
    const now = performance.now();
    let dirty = false;
    for (const [id, rec] of floppers) {
      if (rec.done) {
        if (now >= rec.removeAt) { dropFlopper(id); dirty = true; }
        continue;
      }
      if (rec.state === 'dead') {
        const left = BANK_S - (now - rec.deadAt) / 1000;
        const f = clamp01(left / BANK_S);
        rec.fill.style.width = (f * 100).toFixed(1) + '%';
        setText(rec.timeTxt, left > 9 ? 'yours' : (Math.max(0, left).toFixed(1) + 's'));
        // the server hands it over on its own; never leave a ghost row up
        if (left < -6) { dropFlopper(id); dirty = true; }
        continue;
      }
      const span = rec.escapeS || ESCAPE_S;
      const left = span - (now - rec.spawn) / 1000;
      const f = clamp01(left / span);
      rec.fill.style.width = (f * 100).toFixed(1) + '%';
      setText(rec.timeTxt, Math.max(0, left).toFixed(1) + 's');
      rec.el.classList.toggle('is-warn', f < 0.42 && f >= 0.18);
      rec.el.classList.toggle('is-crit', f < 0.18);
      // safety net: the server owns the escape, but never leave a ghost row up
      if (left < -2.5) { endFlopper(id, false); dirty = true; }
    }
    if (dirty) refreshFlopperStrip();
  }

  function clearFloppers() {
    for (const id of Array.from(floppers.keys())) dropFlopper(id);
  }

  // =============================================================
  // DIVING LOOT — prompts, toasts, the one-of-a-kind card
  // =============================================================
  function onLootNear(d) {
    const near = (d && d.lootId != null) ? d : null;
    const prev = ui.lootNear;
    ui.lootNear = near;
    if (near) ui.lootKnown = true;
    const a = prev ? String(prev.lootId) : '';
    const b = near ? String(near.lootId) : '';
    if (a !== b) refreshPrompt();
  }

  function noteLootState(d) {
    const n = (d && Array.isArray(d.list)) ? d.list.length : 0;
    if (n <= 0) return;
    ui.lootKnown = true;
    if (state.underwater) maybeDiveHint();
  }

  // First dive over a seabed that actually has something on it: say so, once
  // ever (per browser) — after that the glow speaks for itself.
  function maybeDiveHint() {
    if (ui.diveHinted || !ui.lootKnown) return;
    if (effectivePhase() !== 'playing') return;
    ui.diveHinted = true;
    try { if (localStorage.getItem(LS_DIVEHINT)) return; } catch (e) { /* private mode */ }
    try { localStorage.setItem(LS_DIVEHINT, '1'); } catch (e) { /* private mode */ }
    toast('Something glints on the seabed…', 'loot');
  }

  // uniques[] rides along on WORLD_STATE players; keep a local copy too so the
  // card and the charm strip are right the instant the chest opens.
  function myUniques() {
    const out = [];
    const w = state.world;
    const me = myId();
    if (w && Array.isArray(w.players) && me) {
      const mine = w.players.find((p) => p && p.id === me);
      const list = mine && Array.isArray(mine.uniques) ? mine.uniques : [];
      for (const id of list) if (UNIQUE_CHARMS[id] && out.indexOf(id) < 0) out.push(id);
    }
    for (const id of ui.uniques) if (UNIQUE_CHARMS[id] && out.indexOf(id) < 0) out.push(id);
    return out;
  }

  function showUniqueCard(id) {
    if (ui.doom) return;
    const def = UNIQUE_CHARMS[id];
    if (ui.uniques.indexOf(id) < 0) ui.uniques.push(id);
    if (ui.invOpen) renderCharmStrip();
    if (!fresh('uq:' + id, 4000)) return;
    setText(elUqName, def ? def.name : 'Unclaimed Charm');
    setText(elUqEff, uniqueEffect(def));
    setText(elUqDesc, def ? (def.desc || '') : 'Nobody else will ever hold this one.');
    elUnique.classList.remove('show'); void elUnique.offsetWidth;
    elUnique.classList.add('show');
    clearTimeout(ui.uqTimer);
    ui.uqTimer = setTimeout(() => elUnique.classList.remove('show'), 3200);
  }

  function onLootResult(d) {
    if (!d || typeof d !== 'object') return;
    const key = 'loot:' + (d.lootId != null ? d.lootId : '?') + '|' + (d.ok ? 1 : 0)
      + '|' + (d.itemId || '') + '|' + (d.uniqueId || '');
    if (!fresh(key, 600)) return;
    ui.lootKnown = true;
    if (d.ok === false) {
      toast(d.message || 'You cannot reach that', 'bad');
      return;
    }
    if (ui.lootNear && d.lootId != null && String(ui.lootNear.lootId) === String(d.lootId)) {
      ui.lootNear = null;
      refreshPrompt();
    }
    const name = lootName(d);
    const val = Math.max(0, Math.round(num(d.value, 0)));
    toast(val > 0 ? (name + ' — +' + money(val) + ' to the purse') : (name + ' recovered'), 'loot');

    if (d.itemId) {
      const bait = foundBaitById(d.itemId);
      if (bait) {
        toast(bait.name + ' ×' + Math.max(1, Math.floor(num(bait.pack, 1))) + ' — found-only bait', 'loot');
      } else {
        const shopItem = shopById(d.itemId);
        toast('Also inside: ' + (shopItem ? shopItem.name : prettyKey(d.itemId)), 'loot');
      }
    }
    if (d.uniqueId) showUniqueCard(d.uniqueId);
    if (ui.invOpen) renderInventory();
  }

  // =============================================================
  // LIGHTNING
  // =============================================================
  function lightningFlinch() {
    if (ui.doom) return;
    elLightning.classList.remove('strike'); void elLightning.offsetWidth;
    elLightning.classList.add('strike');
    flashDamage();
  }

  // =============================================================
  // HOTBAR / GEAR
  // =============================================================
  const ROD_NAMES = { 1: 'Driftwood Rod' };
  SHOP.forEach((s) => { if (s.kind === 'rod' && s.level) ROD_NAMES[s.level] = s.name; });
  const BOAT_NAMES = { 1: 'Dinghy' };
  SHOP.forEach((s) => { if (s.kind === 'boat' && s.level) BOAT_NAMES[s.level] = s.name; });
  const DIVE_NAMES = { 1: 'Lungs' };
  SHOP.forEach((s) => { if (s.kind === 'diving' && s.level) DIVE_NAMES[s.level] = s.name; });

  function ownedWeapons() {
    const g = state.gear || {};
    const owned = Array.isArray(g.weapons) ? g.weapons : [];
    return SHOP.filter((s) => s.kind === 'weapon' && owned.indexOf(s.id) >= 0);
  }
  // found-only baits live in the same baits map as the shop ones, so they have
  // to be cycleable too — you cannot buy another Abyss Leech
  function ownedBaits() {
    const b = state.baits || {};
    return BAIT_DEFS.filter((s) => num(b[s.id], 0) > 0);
  }

  function refreshHotbar() {
    const g = state.gear || {};
    const rl = Math.max(1, Math.floor(num(g.rod, 1)));
    setHTML(elRodIco, rodIcon(rl));
    setText(elRodName, ROD_NAMES[rl] || ('Rod Lv ' + rl));
    setText(elRodSub, 'Lv ' + rl);

    const ws = ownedWeapons();
    const aw = g.activeWeapon && ws.find((w) => w.id === g.activeWeapon);
    if (aw) {
      setHTML(elWeaponIco, weaponIcon(aw.id));
      setText(elWeaponName, aw.name);
      setText(elWeaponSub, aw.dmg + ' dmg · ' + attackShort(aw));
      elSlotWeapon.classList.remove('is-empty');
    } else if (ws.length) {
      setHTML(elWeaponIco, weaponIcon(ws[0].id));
      setText(elWeaponName, ws[0].name);
      setText(elWeaponSub, 'press 2 to equip');
      elSlotWeapon.classList.remove('is-empty');
    } else {
      setHTML(elWeaponIco, weaponIcon('harpoon'));
      setText(elWeaponName, '—');
      setText(elWeaponSub, 'no weapon');
      elSlotWeapon.classList.add('is-empty');
    }

    const bId = g.activeBait;
    const bDef = bId ? baitById(bId) : null;
    const count = bId ? num((state.baits || {})[bId], 0) : 0;
    setHTML(elBaitIco, baitIcon(bId || 'worms'));
    setText(elBaitName, bDef ? bDef.name : 'No bait');
    setText(elBaitSub, bDef ? ('×' + count + (bDef.found ? ' · found' : '')) : 'press B');
    $('slotBait').classList.toggle('is-empty', !bDef || count <= 0);

    const tool = state.activeTool || 'rod';
    elSlotRod.classList.toggle('is-active', tool === 'rod');
    elSlotWeapon.classList.toggle('is-active', tool === 'weapon');

    const inv = Array.isArray(state.inventory) ? state.inventory : [];
    setText(elInvSub, inv.length === 1 ? '1 fish' : inv.length + ' fish');
  }

  function setTool(tool, cycle) {
    if (tool === 'weapon') {
      const ws = ownedWeapons();
      if (!ws.length) { toast('No weapon yet — buy one at the shop', 'bad'); return; }
      const g = state.gear || (state.gear = {});
      if (state.activeTool === 'weapon' && cycle) {
        const i = ws.findIndex((w) => w.id === g.activeWeapon);
        g.activeWeapon = ws[(i + 1 + ws.length) % ws.length].id;
        const def = shopById(g.activeWeapon);
        if (def) toast(def.name + ' equipped', 'info');
      } else if (!g.activeWeapon || !ws.find((w) => w.id === g.activeWeapon)) {
        g.activeWeapon = ws[0].id;
      }
      state.activeTool = 'weapon';
    } else {
      state.activeTool = 'rod';
    }
    refreshHotbar();
  }

  function cycleBait() {
    const list = ownedBaits();
    const g = state.gear || (state.gear = {});
    if (!list.length) { g.activeBait = null; refreshHotbar(); toast('No bait — buy some at the shop', 'bad'); return; }
    const order = list.map((b) => b.id).concat([null]);
    const i = order.indexOf(g.activeBait != null ? g.activeBait : null);
    g.activeBait = order[(i + 1 + order.length) % order.length];
    refreshHotbar();
    const def = g.activeBait ? baitById(g.activeBait) : null;
    toast(def ? (def.name + ' · ×' + num((state.baits || {})[def.id], 0)) : 'Bait removed', 'info');
  }

  // =============================================================
  // FISH CARDS
  // =============================================================
  function fishCard(item, selectable) {
    const f = fishById(item.fishId) || { name: item.fishId || 'Fish', tier: 1, model: {} };
    const card = el('div', 'fish-card' + (item.mutation ? ' has-mut' : ''));
    card.dataset.inv = item.invId;
    const mutCls = item.mutation ? ' mut-' + item.mutation : '';
    const name = mutName(f.name, item.mutation);
    const tier = num(f.tier, 1);
    card.innerHTML =
      `<span class="fc-tier${tier >= 11 ? ' tx' : ''}">${tierLabel(tier)}</span>` +
      `<img class="fish-icon" data-fkey="1" data-fid="${escapeHTML(item.fishId)}" data-fmut="${escapeHTML(item.mutation || '')}" src="${fishIcon(item.fishId, item.mutation, 96)}" alt="">` +
      `<span class="fc-name${mutCls}" data-text="${escapeHTML(name)}">${escapeHTML(name)}</span>` +
      `<span class="fc-meta">${num(item.weightKg, 0).toFixed(item.weightKg >= 100 ? 0 : 1)} kg</span>` +
      `<span class="fc-value">${SVG_COIN}<b>${money(item.value)}</b></span>`;
    if (selectable) {
      card.classList.add('is-sel-able');
      if (ui.sellSel.has(item.invId)) card.classList.add('is-sel');
      card.addEventListener('click', () => {
        if (ui.sellSel.has(item.invId)) { ui.sellSel.delete(item.invId); card.classList.remove('is-sel'); }
        else { ui.sellSel.add(item.invId); card.classList.add('is-sel'); }
        refreshSellBar();
      });
    }
    return card;
  }

  function inventoryList() { return Array.isArray(state.inventory) ? state.inventory : []; }

  function refreshSellBar() {
    const inv = inventoryList();
    let total = 0, n = 0;
    for (const it of inv) if (ui.sellSel.has(it.invId)) { total += num(it.value, 0); n++; }
    setText(elSellCount, n === 1 ? '1 fish selected' : n + ' fish selected');
    setText(elSellValue, money(total));
    ui.sellPreview = total;

    const w = state.world;
    const q = (w && w.quota) || {};
    const target = Math.max(1, num(q.target, ECON.QUOTA_BASE));
    const prog = Math.max(0, num(q.progress, 0));
    const base = clamp01(prog / target);
    const add = clamp01((prog + total) / target) - base;
    elSqFill.style.width = (base * 100).toFixed(2) + '%';
    elSqAdd.style.left = (base * 100).toFixed(2) + '%';
    elSqAdd.style.width = (add * 100).toFixed(2) + '%';
    setText(elSqTxt, total > 0
      ? (money(prog) + ' → ' + money(prog + total) + ' of ' + money(target) + ' quota')
      : (money(prog) + ' / ' + money(target) + ' quota'));
    // live ghost on the HUD quota bar
    elQuotaPreview.style.left = (base * 100).toFixed(2) + '%';
    elQuotaPreview.style.width = ((ui.shopOpen && ui.shopTab === 'sell') ? (add * 100).toFixed(2) : '0') + '%';
    modalLayer.querySelector('#btnSellSel').disabled = n === 0;
  }

  function sellFish(all) {
    const inv = inventoryList();
    if (!inv.length) { toast('Catch bag is empty', 'bad'); return; }
    const ids = all ? inv.map((i) => i.invId) : inv.filter((i) => ui.sellSel.has(i.invId)).map((i) => i.invId);
    if (!ids.length) { toast('Select some fish first', 'bad'); return; }
    send(MSG.SELL_FISH, { invIds: ids });
    ui.sellSel.clear();
    refreshSellBar();
  }

  // =============================================================
  // SHOP
  // =============================================================
  function gearLevel(kind) {
    const g = state.gear || {};
    if (kind === 'rod') return Math.max(1, Math.floor(num(g.rod, 1)));
    if (kind === 'boat') return Math.max(1, Math.floor(num(g.boat, 1)));
    if (kind === 'diving') return Math.max(1, Math.floor(num(g.diving, 1)));
    return 1;
  }

  function itemState(item) {
    const g = state.gear || {};
    const w = state.world || {};
    const wallet = num(w.wallet, 0);
    if (item.kind === 'rod' || item.kind === 'boat' || item.kind === 'diving') {
      const cur = gearLevel(item.kind);
      if (item.level <= cur) return { s: 'owned', label: 'OWNED' };
      if (item.level > cur + 1) {
        const prereq = SHOP.find((x) => x.kind === item.kind && x.level === item.level - 1);
        return { s: 'locked', label: 'LOCKED', note: 'needs ' + (prereq ? prereq.name : 'the previous tier') };
      }
    } else if (item.kind === 'weapon') {
      const owned = Array.isArray(g.weapons) ? g.weapons : [];
      if (owned.indexOf(item.id) >= 0) {
        return { s: 'owned', label: g.activeWeapon === item.id ? 'EQUIPPED' : 'OWNED' };
      }
    } else if (item.kind === 'charm') {
      const owned = Array.isArray(g.charms) ? g.charms : [];
      if (owned.indexOf(item.id) >= 0) return { s: 'owned', label: 'OWNED' };
    } else if (item.kind === 'revive') {
      // the claw is a one-time tool; salts and kits stack, so they never lock
      if (item.id === 'rescueclaw' && revivesMap().rescueclaw > 0) return { s: 'owned', label: 'OWNED' };
    }
    const price = itemPrice(item);
    if (price > wallet) return { s: 'poor', label: 'BUY', note: 'purse too light' };
    return { s: 'buy', label: 'BUY' };
  }

  function itemPrice(item) {
    if (item.kind === 'ward') {
      const w = state.world || {};
      return wardPrice(Math.max(0, Math.floor(num(w.wards, 0))));
    }
    return item.price;
  }

  function itemMeta(item) {
    const bits = [];
    if (item.kind === 'rod') {
      bits.push('Level ' + item.level);
      const areas = AREAS.filter((a) => a.unlock && a.unlock.rod === item.level).map((a) => a.name);
      if (areas.length) bits.push('unlocks ' + areas.join(', '));
    } else if (item.kind === 'boat') {
      bits.push('Level ' + item.level);
      const areas = AREAS.filter((a) => a.unlock && a.unlock.boat === item.level).map((a) => a.name);
      if (areas.length) bits.push('unlocks ' + areas.join(', '));
    } else if (item.kind === 'bait') {
      bits.push('pack of ' + item.pack);
      if (item.tierBias) bits.push('+' + item.tierBias + ' tier bias');
      if (item.luck) bits.push('+' + Math.round(item.luck * 100) + '% luck');
      const have = num((state.baits || {})[item.id], 0);
      bits.push(have > 0 ? ('you hold ×' + have) : 'none held');
    } else if (item.kind === 'weapon') {
      bits.push(item.dmg + ' dmg');
      if (item.attack === 'both' && item.meleeDmg) bits.push(item.meleeDmg + ' on the jab');
      bits.push(item.rate + '/s');
      bits.push(item.range + ' m');
      if (canBonk(item)) bits.push('bonks your catch');
    } else if (item.kind === 'charm') {
      bits.push('+' + Math.round(item.luck * 100) + '% luck');
    } else if (item.kind === 'revive') {
      const rv = revivesMap();
      if (item.id === 'rescueclaw') {
        bits.push('permanent tool');
        bits.push('reaches ' + RV.clawRange + ' m underwater');
        bits.push(rv.rescueclaw > 0 ? 'on your belt' : 'not owned');
      } else if (item.id === 'salts') {
        bits.push('hold E for ' + RV.hold + 's within ' + RV.saltsRange + ' m');
        bits.push('revives at ' + Math.round(RV.saltsHp * 100) + '% hp');
        bits.push('you hold ×' + rv.salts);
      } else {
        bits.push('self-revive at ' + Math.round(RV.kitHp * 100) + '% hp');
        bits.push('you hold ×' + rv.revivalkit);
      }
    } else if (item.kind === 'diving') {
      bits.push(item.air + 's of air');
      bits.push('Level ' + item.level);
    } else if (item.kind === 'ward') {
      const w = state.world || {};
      const q = w.quota || {};
      const dl = Math.floor(num(q.deadlineDay, 0));
      const wards = Math.max(0, Math.floor(num(w.wards, 0)));
      bits.push('bought ×' + wards);
      if (dl) bits.push('deadline day ' + dl + ' → ' + (dl + 3));
    }
    return bits.join(' · ');
  }

  // weapons carry attack: 'melee' | 'ranged' | 'both' — melee reach also
  // finishes landed catches (see FLOPPER), ranged-only weapons cannot.
  function attackKind(item) {
    if (!item || item.kind !== 'weapon') return '';
    const a = item.attack;
    return (a === 'melee' || a === 'ranged' || a === 'both') ? a : '';
  }
  function canBonk(item) { const a = attackKind(item); return a === 'melee' || a === 'both'; }
  function attackShort(item) {
    const a = attackKind(item);
    return a === 'both' ? 'melee+ranged' : (a || 'melee');
  }
  function attackBadge(item) {
    const a = attackKind(item);
    if (!a) return '';
    const label = a === 'both' ? 'MELEE+RANGED' : a.toUpperCase();
    const tip = canBonk(item) ? 'Can bonk your landed catch' : 'Cannot bonk a landed catch';
    return `<span class="si-att att-${a}" title="${tip}">${label}</span>`;
  }

  function shopItemCard(item) {
    const st = itemState(item);
    const price = itemPrice(item);
    const card = el('div', 'shop-item state-' + st.s);
    card.innerHTML =
      `<div class="si-ico">${shopKindIcon(item.kind, item)}</div>` +
      `<div class="si-main">` +
      `<div class="si-top"><span class="si-name">${escapeHTML(item.name)}</span>${attackBadge(item)}` +
      `<span class="si-price">${SVG_COIN}<b>${money(price)}</b></span></div>` +
      `<div class="si-desc">${escapeHTML(item.desc || '')}</div>` +
      `<div class="si-meta">${escapeHTML(itemMeta(item))}${st.note ? ' · <i>' + escapeHTML(st.note) + '</i>' : ''}</div>` +
      `</div>` +
      `<button class="btn si-buy ${st.s === 'buy' ? 'btn-primary' : 'btn-secondary'}">${st.label}</button>`;
    const btn = card.querySelector('.si-buy');
    if (st.s === 'owned' || st.s === 'locked') btn.disabled = true;
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (st.s === 'owned') {
        if (item.kind === 'weapon') {
          const g = state.gear || (state.gear = {});
          g.activeWeapon = item.id; state.activeTool = 'weapon';
          refreshHotbar(); renderShop(); toast(item.name + ' equipped', 'info');
        }
        return;
      }
      if (st.s === 'locked') { toast(st.note || 'Locked', 'bad'); return; }
      if (st.s === 'poor') { toast('Not enough in the team purse', 'bad'); return; }
      send(MSG.BUY_ITEM, { itemId: item.id });
      btn.disabled = true;
      setTimeout(() => { if (btn.isConnected) btn.disabled = false; }, 700);
    });
    return card;
  }

  function renderShop() {
    for (const b of elShopTabs.children) b.classList.toggle('is-on', b.dataset.k === ui.shopTab);
    const w = state.world || {};
    setText(elShopWallet, money(w.wallet));
    elShopBody.innerHTML = '';
    const isSell = ui.shopTab === 'sell';
    elShopModal.classList.toggle('is-sell', isSell);
    elSellBar.style.display = isSell ? '' : 'none';

    if (isSell) {
      const inv = inventoryList();
      // drop stale selections
      const ids = new Set(inv.map((i) => i.invId));
      for (const s of Array.from(ui.sellSel)) if (!ids.has(s)) ui.sellSel.delete(s);
      if (!inv.length) {
        elShopBody.appendChild(el('div', 'empty-note', 'Your catch bag is empty. Go bother some fish.'));
      } else {
        const grid = el('div', 'fish-grid');
        const sorted = inv.slice().sort((a, b) => num(b.value, 0) - num(a.value, 0));
        sorted.forEach((it) => grid.appendChild(fishCard(it, true)));
        elShopBody.appendChild(grid);
      }
      refreshSellBar();
      return;
    }

    elQuotaPreview.style.width = '0%';
    const items = SHOP.filter((s) => s.kind === ui.shopTab);
    const list = el('div', 'shop-list');
    items.forEach((it) => list.appendChild(shopItemCard(it)));
    elShopBody.appendChild(list);

    if (ui.shopTab === 'rod' || ui.shopTab === 'boat' || ui.shopTab === 'diving') {
      const cur = gearLevel(ui.shopTab);
      const names = ui.shopTab === 'rod' ? ROD_NAMES : ui.shopTab === 'boat' ? BOAT_NAMES : DIVE_NAMES;
      elShopBody.insertBefore(el('div', 'shop-note', 'Currently equipped: <b>' + escapeHTML(names[cur] || ('Level ' + cur)) + '</b>'), list);
    }
    if (ui.shopTab === 'ward') {
      elShopBody.insertBefore(el('div', 'shop-note',
        'The ward is a <b>team purchase</b>. Each one buys three more days — and costs 50% more than the last.'), list);
    }
    if (ui.shopTab === 'revive') {
      const rv = revivesMap();
      elShopBody.insertBefore(el('div', 'shop-note revive-note',
        'Nobody stays down if the crew can reach them. In your pack: '
        + '<b>Sea Salts ×' + rv.salts + '</b> · <b>Revival Kits ×' + rv.revivalkit + '</b> · '
        + 'Rescue Claw <b>' + (rv.rescueclaw > 0 ? 'owned' : 'not owned') + '</b>. '
        + 'If the WHOLE crew goes down at once, the island stops waiting.'), list);
    }
  }

  function openShop() {
    if (ui.invOpen) closeInventory();
    ui.shopOpen = true;
    ui.shopTab = ui.shopTab === 'sell' ? 'sell' : ui.shopTab;
    elShopModal.classList.add('is-open');
    modalLayer.classList.add('is-open');
    renderShop();
    onModalOpen();
  }
  function closeShop() {
    if (!ui.shopOpen) return;
    ui.shopOpen = false;
    ui.sellSel.clear();
    elQuotaPreview.style.width = '0%';
    elShopModal.classList.remove('is-open');
    if (!ui.invOpen) modalLayer.classList.remove('is-open');
    onModalClose();
  }

  // =============================================================
  // INVENTORY MODAL
  // =============================================================
  function renderInventory() {
    const inv = inventoryList();
    elInvBody.innerHTML = '';
    let total = 0;
    inv.forEach((i) => { total += num(i.value, 0); });
    setText(elInvSummary, inv.length ? (inv.length + ' fish · ' + money(total) + ' on the hook') : 'nothing yet');
    if (!inv.length) {
      elInvBody.appendChild(el('div', 'empty-note', 'Nothing in the bag. The sea is right there.'));
    } else {
      const grid = el('div', 'fish-grid');
      inv.slice().sort((a, b) => num(b.value, 0) - num(a.value, 0)).forEach((it) => grid.appendChild(fishCard(it, false)));
      elInvBody.appendChild(grid);
    }
    elBaitStrip.innerHTML = '';
    const g = state.gear || {};
    BAIT_DEFS.forEach((b) => {
      const c = num((state.baits || {})[b.id], 0);
      // found-only baits are not on any shelf — only show them once you have some
      if (b.found && c <= 0) return;
      const chip = el('div', 'bait-chip' + (c > 0 ? '' : ' is-zero')
        + (g.activeBait === b.id ? ' is-on' : '') + (b.found ? ' is-found' : ''));
      chip.title = b.desc || '';
      chip.innerHTML = `<span class="bc-ico">${baitIcon(b.id)}</span><span class="bc-name">${escapeHTML(b.name)}</span><b>×${c}</b>`;
      elBaitStrip.appendChild(chip);
    });
    renderCharmStrip();
  }

  // ---- charms: shop talismans + the one-of-a-kind ones you dived up ----
  function charmChip(cls, iconHTML, name, effect, tag, tip) {
    const chip = el('button', 'charm-chip' + (cls ? ' ' + cls : ''));
    chip.type = 'button';
    chip.title = name + ' — ' + (tip || effect);
    chip.innerHTML =
      `<span class="ch-ico">${iconHTML}</span>` +
      `<span class="ch-body"><b>${escapeHTML(name)}</b><i>${escapeHTML(effect)}</i></span>` +
      (tag ? `<span class="ch-tag">${escapeHTML(tag)}</span>` : '');
    // hover shows the effect line on desktop; a tap pins it open on touch
    chip.addEventListener('click', () => chip.classList.toggle('is-open'));
    return chip;
  }

  function renderCharmStrip() {
    if (!elCharmStrip) return;
    elCharmStrip.innerHTML = '';
    elCharmStrip.appendChild(el('div', 'cs-head', 'Charms'));
    const list = el('div', 'cs-list');
    let n = 0;
    const g = state.gear || {};
    const owned = Array.isArray(g.charms) ? g.charms : [];
    owned.forEach((id) => {
      const it = shopById(id);
      if (!it || it.kind !== 'charm') return;
      n++;
      list.appendChild(charmChip('', shopKindIcon('charm', it),
        it.name, '+' + Math.round(num(it.luck, 0) * 100) + '% luck', '', it.desc));
    });
    myUniques().forEach((id) => {
      const def = UNIQUE_CHARMS[id];
      if (!def) return;
      n++;
      list.appendChild(charmChip('is-unique', SVG_LOOT_GEM, def.name, uniqueEffect(def), '1 of 1', def.desc));
    });
    if (!n) {
      list.appendChild(el('div', 'cs-none', 'No charms yet — the shop sells talismans, the seabed hides the unique ones.'));
    }
    elCharmStrip.appendChild(list);
  }
  function openInventory() {
    if (ui.shopOpen) closeShop();
    ui.invOpen = true;
    elInvModal.classList.add('is-open');
    modalLayer.classList.add('is-open');
    renderInventory();
    onModalOpen();
  }
  function closeInventory() {
    if (!ui.invOpen) return;
    ui.invOpen = false;
    elInvModal.classList.remove('is-open');
    if (!ui.shopOpen) modalLayer.classList.remove('is-open');
    onModalClose();
  }
  function toggleInventory() { if (ui.invOpen) closeInventory(); else openInventory(); }

  function onModalOpen() {
    state.uiModalOpen = true;
    root.classList.add('modal-open');
    try { if (ctx.input && ctx.input.keys) ctx.input.keys.clear(); } catch (e) { /* ignore */ }
    if (ctx.input) ctx.input.mouseDown = false;
    try { if (document.pointerLockElement) document.exitPointerLock(); } catch (e) { /* ignore */ }
    try { bus && bus.emit && bus.emit('uiModal', { open: true }); } catch (e) { /* ignore */ }
  }
  function onModalClose() {
    if (ui.shopOpen || ui.invOpen) return;
    state.uiModalOpen = false;
    root.classList.remove('modal-open');
    try { bus && bus.emit && bus.emit('uiModal', { open: false }); } catch (e) { /* ignore */ }
    relock();
  }
  function relock() {
    if (ui.chatOpen || ui.shopOpen || ui.invOpen) return;
    if (effectivePhase() !== 'playing') return;
    try {
      const c = ctx.renderer && ctx.renderer.domElement;
      if (c && !document.pointerLockElement && c.requestPointerLock) c.requestPointerLock();
    } catch (e) { /* browsers may refuse; user can click to relock */ }
  }

  // =============================================================
  // CHAT
  // =============================================================
  function pushChat(fromName, text, system) {
    ui.chatLog.push({ from: fromName || '', text: String(text || ''), t: performance.now(), system: !!system });
    while (ui.chatLog.length > 30) ui.chatLog.shift();
    renderChat();
  }
  function chatColor(name) {
    const w = state.world;
    const list = (w && Array.isArray(w.players)) ? w.players : (state.room && Array.isArray(state.room.players) ? state.room.players : []);
    const p = list.find((x) => x && x.name === name);
    if (p) {
      const ci = Math.max(0, Math.min(PLAYER_COLORS.length - 1, num(p.color, 0)));
      return hex(PLAYER_COLORS[ci]);
    }
    return '#9fd8ff';
  }
  function renderChat() {
    const show = ui.chatLog.slice(-6);
    elChatLog.innerHTML = '';
    show.forEach((m, i) => {
      const line = el('div', 'chat-line' + (m.system ? ' is-sys' : ''));
      line._t = m.t;
      line.innerHTML = m.system
        ? `<span class="chat-text">${escapeHTML(m.text)}</span>`
        : `<span class="chat-from" style="color:${chatColor(m.from)}">${escapeHTML(m.from || '???')}</span><span class="chat-text">${escapeHTML(m.text)}</span>`;
      line.style.opacity = String(0.45 + 0.55 * ((i + 1) / show.length));
      elChatLog.appendChild(line);
    });
    fadeChat();
  }
  function fadeChat() {
    const now = performance.now();
    const kids = elChatLog.children;
    for (let i = 0; i < kids.length; i++) {
      const k = kids[i];
      const age = (now - (k._t || now)) / 1000;
      let a = 0.5 + 0.5 * ((i + 1) / kids.length);
      if (!ui.chatOpen && age > 14) a *= Math.max(0, 1 - (age - 14) / 5);
      k.style.opacity = a.toFixed(2);
    }
  }
  function openChat() {
    if (effectivePhase() !== 'playing') return;
    ui.chatOpen = true;
    root.classList.add('chat-open');
    try { if (ctx.input && ctx.input.keys) ctx.input.keys.clear(); } catch (e) { /* ignore */ }
    try { if (document.pointerLockElement) document.exitPointerLock(); } catch (e) { /* ignore */ }
    elChatInput.value = '';
    setTimeout(() => elChatInput.focus(), 10);
    renderChat();
  }
  function closeChat(sendIt) {
    if (!ui.chatOpen) { if (document.activeElement === elChatInput) elChatInput.blur(); return; }
    const text = elChatInput.value.trim();
    ui.chatOpen = false;
    root.classList.remove('chat-open');
    elChatInput.value = '';
    elChatInput.blur();
    if (sendIt && text) send(MSG.CHAT, { text: text.slice(0, 140) });
    relock();
  }
  elChatInput.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') { e.preventDefault(); closeChat(true); }
    else if (e.key === 'Escape') { e.preventDefault(); closeChat(false); }
  });
  elChatWrap.addEventListener('click', (e) => e.stopPropagation());

  // =============================================================
  // CATCH CARD / EVENT BANNERS / VIGNETTES
  // =============================================================
  function showCatch(payload) {
    if (!payload || ui.doom) return;
    const caught = payload.caught != null ? payload.caught : true;
    const fish = payload.fish || (payload.fishId ? payload : null);
    if (!caught || !fish) {
      if (!caught) toast('It got away…', 'bad');
      return;
    }
    const key = String(fish.invId || (fish.fishId + '|' + fish.weightKg));
    if (!fresh('catch:' + key, 500)) return;
    const def = fishById(fish.fishId) || { name: fish.name || 'Fish', tier: num(fish.tier, 1) };
    const tier = num(fish.tier, num(def.tier, 1));
    const name = mutName(fish.name || def.name, fish.mutation);

    elCcTier.className = 'cc-tier' + (tier >= 11 ? ' tx' : ' t' + Math.min(10, tier));
    setText(elCcTier, tierLabel(tier));
    elCcIcon.src = fishIcon(fish.fishId, fish.mutation, 192);
    elCcIcon.dataset.fid = fish.fishId || '';
    elCcIcon.dataset.fmut = fish.mutation || '';
    elCcName.className = 'cc-name' + (fish.mutation ? ' mut-' + fish.mutation : '');
    elCcName.setAttribute('data-text', name);
    setText(elCcName, name);
    setText(elCcWeight, num(fish.weightKg, 0).toFixed(fish.weightKg >= 100 ? 0 : 1) + ' kg');
    setText(elCcValue, money(fish.value));
    elCcRecord.style.display = payload.newRecord ? '' : 'none';
    elCatch.className = 'catch-card show' + (fish.mutation ? ' has-mut mut-bg-' + fish.mutation : '') + (tier >= 11 ? ' is-tx' : '');
    clearTimeout(ui.catchTimer);
    ui.catchTimer = setTimeout(() => { elCatch.classList.remove('show'); }, 2100);
    hideReel();
  }

  function showEventBanner(type) {
    if (ui.doom) return;
    const def = EVENTS[type];
    const title = (def ? def.name : String(type || 'IT')).toUpperCase();
    elEbTitle.setAttribute('data-text', title);
    setText(elEbTitle, title);
    setText(elEbDesc, def ? def.desc : 'Something is out there.');
    root.dataset.event = type || '';
    elEventBanner.classList.remove('show'); void elEventBanner.offsetWidth;
    elEventBanner.classList.add('show');
    elEventVig.classList.add('on');
    setTimeout(() => elEventBanner.classList.remove('show'), 4600);
  }
  function endEventBanner(info) {
    root.dataset.event = '';
    elEventVig.classList.remove('on');
    elEventBanner.classList.remove('show');
    if (info && info.survived) {
      const un = info.unlocked ? fishById(info.unlocked) : null;
      toast(un ? ('Survived. ' + un.name + ' now swims the Abyss.') : 'You survived the night.', 'good');
    } else if (info) {
      toast('It took the night. It will come back.', 'bad');
    }
  }

  function flashDamage(amount) {
    if (ui.doom) return;   // the doomsday shake owns the screen
    ui.damageFlash = 1;
    elDamageVig.classList.remove('hit'); void elDamageVig.offsetWidth;
    elDamageVig.classList.add('hit');
    root.classList.remove('shake'); void root.offsetWidth;
    root.classList.add('shake');
    setTimeout(() => root.classList.remove('shake'), 380);
  }

  function showQuotaBanner(d) {
    if (ui.doom) return;
    const n = num(d && d.n, 0);
    setText(elQbTitle, 'QUOTA ' + n + ' MET');
    const bits = [];
    if (d && d.nextTarget) bits.push('next target ' + money(d.nextTarget));
    if (d && d.deadlineDay) bits.push('deadline day ' + Math.floor(d.deadlineDay));
    if (d && d.bonus) bits.push('+' + money(d.bonus) + ' bonus');
    bits.push((ECON.QUOTAS_TO_WIN - n) + ' to go');
    setText(elQbSub, bits.join(' · '));
    elQuotaBanner.classList.remove('show'); void elQuotaBanner.offsetWidth;
    elQuotaBanner.classList.add('show');
    setTimeout(() => elQuotaBanner.classList.remove('show'), 3600);
  }

  // =============================================================
  // CAST POWER + REEL WIDGET
  // =============================================================
  function normFrac(v, d) {
    let x = num(v, d);
    if (x > 1.5) x = x / 100;
    return clamp01(x);
  }
  // The sweet band: two bright lines with a soft glow between them. The
  // payload owns the numbers (fishing.js ships band:[a,b]); this only paints.
  let bandLo = -1, bandHi = -1;
  function setCastBand(band) {
    const a = clamp01(num(band && band[0], PERFECT_BAND[0]));
    const b = clamp01(num(band && band[1], PERFECT_BAND[1]));
    const lo = Math.min(a, b), hi = Math.max(a, b);
    if (lo === bandLo && hi === bandHi) return;
    bandLo = lo; bandHi = hi;
    elCastBand.style.left = (lo * 100).toFixed(2) + '%';
    elCastBand.style.width = Math.max(0.4, (hi - lo) * 100).toFixed(2) + '%';
  }
  function inBand(p) { return p >= bandLo && p <= bandHi; }

  function onCastPower(d) {
    let p;
    if (typeof d === 'number') p = d;
    else if (d && typeof d === 'object') p = num(d.power, num(d.value, num(d.p, num(d.charge, 0))));
    else p = 0;
    if (d === null || d === false || (d && d.active === false)) { elCastPower.classList.remove('show'); ui.castPowerT = -99; return; }
    setCastBand(bandOf(d));
    p = normFrac(p, 0);
    ui.castPowerT = ui.now;
    if (ui.doom) return;
    elCastPower.classList.add('show');
    elCastFill.style.width = (p * 100).toFixed(1) + '%';
    elCastFill.classList.toggle('is-max', p > 0.92);
    elCastPower.classList.toggle('in-band', p > 0.001 && inBand(p));
  }
  function hideCastPower() {
    elCastPower.classList.remove('show', 'in-band');
    ui.castPowerT = -99;
  }

  // PERFECT! — a short golden burst right where the bar was
  function showPerfect() {
    if (ui.doom) return;
    if (!fresh('perfect', 250)) return;
    ui.perfectT = ui.now;
    elPerfect.classList.remove('show'); void elPerfect.offsetWidth;
    elPerfect.classList.add('show');
    elCastPower.classList.add('in-band');
  }
  function hidePerfect() { elPerfect.classList.remove('show'); ui.perfectT = -99; }

  function onReelState(d) {
    if (!d || d === false || d.active === false || d.done === true || d.state === 'done' || d.state === 'end') { hideReel(); return; }
    ui.reelOn = true;
    ui.reelT = ui.now;
    elReel.classList.add('show');

    const pos = normFrac(
      d.pos !== undefined ? d.pos
        : d.position !== undefined ? d.position
          : d.marker !== undefined ? d.marker
            : d.fish !== undefined ? d.fish
              : d.value !== undefined ? d.value : 0.5, 0.5);

    let zs, ze;
    if (d.zoneStart !== undefined && d.zoneEnd !== undefined) {
      zs = normFrac(d.zoneStart, 0.4); ze = normFrac(d.zoneEnd, 0.6);
    } else if (d.sweetStart !== undefined && d.sweetEnd !== undefined) {
      zs = normFrac(d.sweetStart, 0.4); ze = normFrac(d.sweetEnd, 0.6);
    } else {
      const c = normFrac(
        d.zoneCenter !== undefined ? d.zoneCenter
          : d.zone !== undefined ? d.zone
            : d.sweet !== undefined ? d.sweet
              : d.bar !== undefined ? d.bar : 0.5, 0.5);
      const half = normFrac(
        d.zoneHalf !== undefined ? d.zoneHalf
          : d.zoneSize !== undefined ? d.zoneSize / 2
            : d.sweetSize !== undefined ? d.sweetSize / 2 : 0.09, 0.09);
      zs = c - half; ze = c + half;
    }
    if (ze < zs) { const t = zs; zs = ze; ze = t; }
    zs = clamp01(zs); ze = clamp01(ze);

    const prog = normFrac(d.progress !== undefined ? d.progress : (d.pct !== undefined ? d.pct : 0), 0);
    const inZone = (d.inZone !== undefined) ? !!d.inZone : (pos >= zs && pos <= ze);

    elReelZone.style.bottom = (zs * 100).toFixed(2) + '%';
    elReelZone.style.height = Math.max(2, (ze - zs) * 100).toFixed(2) + '%';
    elReelMarker.style.bottom = (pos * 100).toFixed(2) + '%';
    elReel.classList.toggle('in-zone', inZone);
    elReelRing.style.strokeDashoffset = (RING_LEN * (1 - prog)).toFixed(2);
    setText(elReelPct, Math.round(prog * 100) + '%');
    const tension = d.tension !== undefined ? normFrac(d.tension, 0) : -1;
    elReel.classList.toggle('is-strain', tension > 0.8);
  }
  function hideReel() {
    if (!ui.reelOn) { elReel.classList.remove('show'); return; }
    ui.reelOn = false;
    ui.reelT = -99;
    elReel.classList.remove('show', 'in-zone', 'is-strain');
  }

  // =============================================================
  // REVIVING — downed markers, channel ring, tow hint, KO overlay
  // =============================================================
  // player.js owns the hold-E channel and every send (REVIVE_TEAMMATE /
  // TOW_BODY); everything here reads its published state and paints it.
  const PROJ = (ctx.THREE && ctx.THREE.Vector3) ? new ctx.THREE.Vector3() : null;
  const dmRows = new Map();          // playerId -> marker record

  function dist3(a, b) {
    const dx = num(a.x, 0) - num(b.x, 0);
    const dy = num(a.y, 0) - num(b.y, 0);
    const dz = num(a.z, 0) - num(b.z, 0);
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  }

  // gear.revives is the wave-5 payload {salts, rescueclaw, revivalkit}.
  // An array of ids or flat gear fields are honoured too — never trust a shape.
  function revivesMap() {
    const g = state.gear || {};
    const out = { salts: 0, rescueclaw: 0, revivalkit: 0 };
    const r = g.revives;
    if (Array.isArray(r)) {
      for (const id of r) if (out[id] !== undefined) out[id]++;
    } else if (r && typeof r === 'object') {
      for (const k in out) {
        const v = r[k];
        out[k] = (v === true) ? 1 : Math.max(0, Math.floor(num(v, 0)));
      }
    }
    if (!out.rescueclaw) {
      const lists = [g.tools, g.items, g.revivals];
      for (const l of lists) if (Array.isArray(l) && l.indexOf('rescueclaw') >= 0) out.rescueclaw = 1;
      if (g.rescueclaw === true || num(g.rescueclaw, 0) > 0) out.rescueclaw = 1;
    }
    if (!out.salts) out.salts = Math.max(0, Math.floor(num(g.salts, 0)));
    if (!out.revivalkit) out.revivalkit = Math.max(0, Math.floor(num(g.revivalkit, 0)));
    return out;
  }

  function playerNameById(id) {
    if (id == null || id === '') return 'Crewmate';
    const key = String(id);
    const w = state.world;
    const lists = [
      (w && Array.isArray(w.players)) ? w.players : null,
      (state.room && Array.isArray(state.room.players)) ? state.room.players : null,
    ];
    for (const l of lists) {
      if (!l) continue;
      for (const p of l) if (p && String(p.id) === key && p.name) return String(p.name);
    }
    try {
      const rem = ctx.playerMod && ctx.playerMod.remotes;
      const r = (rem && typeof rem.get === 'function') ? rem.get(key) : null;
      if (r && r.name) return String(r.name);
    } catch (e) { /* remotes not ready */ }
    return 'Crewmate';
  }

  function readDownEntry(key, v, out) {
    if (!v) return;
    if (typeof v === 'string' || typeof v === 'number') v = { id: String(v) };
    if (typeof v !== 'object') return;
    const id = (v.id != null) ? String(v.id) : String(key);
    if (!id || id === 'undefined' || id === 'null') return;
    const src = v.pos || v.p || v.position
      || (v.char && v.char.group && v.char.group.position)
      || (v.group && v.group.position) || null;
    out.push({
      id,
      name: (typeof v.name === 'string' && v.name) ? v.name : playerNameById(id),
      pos: vecOf(src, { x: 0, y: 0, z: 0 }),
      under: (v.underwater != null) ? !!v.underwater : ((v.under != null) ? !!v.under : null),
      towedBy: (v.towedBy != null) ? String(v.towedBy) : ((v.towed != null && v.towed !== false) ? String(v.towed) : null),
    });
  }
  // ctx.playerMod.downed may be a Map, an array, a Set of ids or a plain object
  function downedList() {
    const out = [];
    const src = ctx.playerMod && ctx.playerMod.downed;
    if (!src) return out;
    try {
      if (typeof Map !== 'undefined' && src instanceof Map) src.forEach((v, k) => readDownEntry(k, v, out));
      else if (Array.isArray(src)) src.forEach((v, i) => readDownEntry((v && v.id != null) ? v.id : i, v, out));
      else if (typeof Set !== 'undefined' && src instanceof Set) src.forEach((v) => readDownEntry(v, v, out));
      else if (typeof src === 'object') { for (const k in src) readDownEntry(k, src[k], out); }
    } catch (e) { /* whatever shape that was, it is not ours */ }
    return out;
  }

  // a body is "under" if the module said so, else ask the water
  function bodyUnder(d) {
    if (d.under != null) return d.under;
    if (!d.pos) return false;
    let sea = 0;
    try {
      if (typeof ctx.getWaterHeight === 'function') sea = num(ctx.getWaterHeight(d.pos.x, d.pos.z, ui.now), 0);
    } catch (e) { sea = 0; }
    return d.pos.y < sea - 0.35;
  }

  // ---- world-anchored markers (edge-clamped so a body is always findable) ----
  function markerFor(id) {
    let rec = dmRows.get(id);
    if (rec) return rec;
    const node = el('div', 'downed-marker');
    node.innerHTML =
      `<span class="dm-glyph">${SVG_SKULL}</span>` +
      '<span class="dm-body"><b class="dm-name"></b><i class="dm-dist"></i></span>';
    elDownedLayer.appendChild(node);
    rec = { el: node, name: node.querySelector('.dm-name'), dist: node.querySelector('.dm-dist') };
    dmRows.set(id, rec);
    return rec;
  }
  function dropMarker(id) {
    const rec = dmRows.get(String(id));
    if (!rec) return;
    if (rec.el.parentNode) rec.el.parentNode.removeChild(rec.el);
    dmRows.delete(String(id));
  }
  function clearDownedMarkers() {
    for (const id of Array.from(dmRows.keys())) dropMarker(id);
    ui.downSeen.clear();
    ui.downInit = false;
    elDownedLayer.classList.remove('show');
  }

  function updateDownedMarkers() {
    if (ui.doom || effectivePhase() !== 'playing') {
      if (dmRows.size || ui.downSeen.size) clearDownedMarkers();
      return;
    }
    const list = downedList();
    if (!list.length && !dmRows.size && !ui.downSeen.size) { ui.downInit = true; return; }
    const me = myId() ? String(myId()) : null;
    const cam = ctx.camera;
    const p = playerPos(TMP);
    const W = window.innerWidth || 1280;
    const H = window.innerHeight || 720;
    const seen = new Set();
    for (let i = 0; i < list.length; i++) {
      const d = list[i];
      if (me && d.id === me) continue;
      seen.add(d.id);
      if (!ui.downSeen.has(d.id)) {
        ui.downSeen.add(d.id);
        if (ui.downInit) toast(d.name + ' is down — get to them', 'bad');
      }
      if (!d.pos || !cam || !PROJ) continue;
      const rec = markerFor(d.id);
      PROJ.set(num(d.pos.x, 0), num(d.pos.y, 0) + 1.35, num(d.pos.z, 0));
      try { PROJ.project(cam); } catch (e) { continue; }
      let x = num(PROJ.x, 0), y = num(PROJ.y, 0);
      const behind = num(PROJ.z, 0) > 1;
      if (behind) { x = -x; y = -1; }
      const off = behind || x < -1 || x > 1 || y < -1 || y > 1;
      x = x < -0.93 ? -0.93 : (x > 0.93 ? 0.93 : x);
      y = y < -0.86 ? -0.86 : (y > 0.9 ? 0.9 : y);
      rec.el.style.transform = 'translate(' + ((x * 0.5 + 0.5) * W).toFixed(1) + 'px,'
        + ((0.5 - y * 0.5) * H).toFixed(1) + 'px) translate(-50%,-50%)';
      rec.el.classList.toggle('is-edge', off);
      rec.el.classList.toggle('is-towed', !!d.towedBy);
      rec.el.classList.add('show');
      setText(rec.name, d.name);
      const dist = dist3(p, d.pos);
      setText(rec.dist, dist >= 999 ? '999+ m' : (Math.max(0, Math.round(dist)) + ' m'));
    }
    for (const id of Array.from(dmRows.keys())) if (!seen.has(id)) dropMarker(id);
    for (const id of Array.from(ui.downSeen)) if (!seen.has(id)) ui.downSeen.delete(id);
    ui.downInit = true;
    elDownedLayer.classList.toggle('show', dmRows.size > 0);
  }

  // ---- the hold-E channel ring ----
  function onReviveChannel(d) {
    if (!d || d === false || d.active === false || d.cancel === true) { hideReviveRing(); return; }
    const t01 = clamp01(num(d.t01, num(d.t, num(d.progress, num(d.p, 0)))));
    if (t01 <= 0.0001) { hideReviveRing(); return; }
    ui.reviveOn = true;
    ui.reviveChT = ui.now;
    ui.reviveTarget = (d.targetId != null) ? String(d.targetId) : null;
    if (ui.doom) return;
    const name = (typeof d.name === 'string' && d.name) ? d.name : playerNameById(ui.reviveTarget);
    setText(elRrTxt, 'Reviving ' + name + '…');
    elRrFg.style.strokeDashoffset = (RR_LEN * (1 - t01)).toFixed(2);
    elReviveRing.classList.add('show');
    elReviveRing.classList.toggle('is-full', t01 > 0.985);
  }
  function hideReviveRing() {
    ui.reviveOn = false;
    ui.reviveChT = -99;
    ui.reviveTarget = null;
    elReviveRing.classList.remove('show', 'is-full');
  }

  // ---- towing a body up with the Rescue Claw ----
  function setTowing(rec) {
    ui.towing = rec || null;
    if (!rec || ui.doom) { elTowHint.classList.remove('show'); return; }
    setText(elTowName, rec.name || 'Crewmate');
    elTowHint.classList.add('show');
  }
  function onBodyTowed(d) {
    if (!d) return;
    const id = (d.id != null) ? String(d.id) : '';
    if (!id) return;
    const by = (d.by != null && d.by !== false) ? String(d.by) : null;
    const me = myId() ? String(myId()) : null;
    if (by && me && by === me) {
      if (!ui.towing || ui.towing.id !== id) setTowing({ id, name: playerNameById(id) });
      refreshPrompt();
      return;
    }
    if (ui.towing && ui.towing.id === id) { setTowing(null); refreshPrompt(); }
  }

  // ---- prompts ----
  // Mirrors player.js's updateRevive() exactly, so the prompt never promises
  // something E will not do: the claw wins while you are in the water, salts
  // only work on a body that is out of it, and the helm owns E while driving.
  function inWater() {
    if (state.underwater) return true;
    const l = ctx.playerMod && ctx.playerMod.local;
    return !!(l && (l.swimming || l.underwater));
  }
  function nearestBody(p, range, needAir) {
    const list = downedList();
    if (!list.length) return null;
    const me = myId() ? String(myId()) : null;
    let best = null;
    for (let i = 0; i < list.length; i++) {
      const d = list[i];
      if (!d.pos || (me && d.id === me)) continue;
      if (d.towedBy && (!me || d.towedBy !== me)) continue;   // someone else has them
      if (needAir && bodyUnder(d)) continue;
      const dist = dist3(p, d.pos);
      if (dist > range) continue;
      if (!best || dist < best.dist) best = { d, dist };
    }
    return best;
  }
  function revivePrompt(p) {
    if (isDrivingBoat()) return null;                          // the wheel owns E
    const rv = revivesMap();
    const wet = inWater();

    // 1. Rescue Claw — grab anything you can reach while you are in the water
    if (rv.rescueclaw > 0 && wet) {
      const grab = nearestBody(p, RV.clawRange, false);
      if (grab) {
        return { kind: 'revive', d: grab.dist, hot: true, act: null, label: 'E — Grab ' + grab.d.name + ' (Rescue Claw)' };
      }
    }
    // 2. Sea Salts — only ever on a body that is out of the water
    const dry = nearestBody(p, RV.saltsRange, RV.noSaltsUnder);
    if (dry && rv.salts > 0) {
      return { kind: 'revive', d: dry.dist, hot: true, act: null, label: 'Hold E — Revive ' + dry.d.name + ' (Sea Salts)' };
    }
    // 3. nothing you can do yet — say why
    const any = nearestBody(p, Math.max(RV.clawRange, RV.saltsRange) + 1.5, false);
    if (!any) return null;
    const name = any.d.name;
    if (bodyUnder(any.d)) {
      return {
        kind: 'revive', d: any.dist, locked: true, act: null,
        label: rv.rescueclaw > 0
          ? (name + ' is under — swim down and grab them')
          : (name + ' is under — a Rescue Claw could reach them'),
      };
    }
    if (!dry) return { kind: 'revive', d: any.dist, locked: true, act: null, label: name + ' is down — get closer' };
    return { kind: 'revive', d: any.dist, locked: true, act: null, label: name + ' is down — Sea Salts would bring them back' };
  }

  // ---- the KO overlay you see from the floor ----
  function refreshKO(ko) {
    if (!ko) { elKO.classList.remove('has-kit'); return; }
    const kits = revivesMap().revivalkit;
    elKoKit.style.display = kits > 0 ? '' : 'none';
    // player.js owns the R key and the USE_REVIVAL_KIT send — this is the prompt
    setText(elKoKitTxt, 'Press R — ' + reviveShortName('revivalkit') + ' (' + kits + ' left)');
    elKoHint.style.display = kits > 0 ? 'none' : '';
    elKO.classList.toggle('has-kit', kits > 0);
  }

  function onRevived(d) {
    if (!d) return;
    const id = (d.id != null) ? String(d.id) : '';
    if (!id) return;
    if (!fresh('rev:' + id, 400)) return;
    const me = myId() ? String(myId()) : null;
    hideReviveRing();
    if (ui.towing && ui.towing.id === id) setTowing(null);
    dropMarker(id);
    ui.downSeen.delete(id);
    if (me && id === me) {
      const raw = num(d.hp, RV.saltsHp);
      state.hp = raw <= 1 ? Math.max(1, Math.round(raw * PLAYER_MAX_HP)) : Math.max(1, Math.round(raw));
      ui.koShown = false;
      elKO.classList.remove('show', 'has-kit');
      root.dataset.ko = '';
      refreshVitals();
      const by = (d.by != null && d.by !== false) ? playerNameById(d.by) : null;
      toast(by ? (by + ' hauled you back up') : 'You are back on your feet', 'good');
    } else {
      toast(playerNameById(id) + ' is back up', 'good');
    }
    refreshPrompt();
  }

  // =============================================================
  // PROXIMITY + INTERACT PROMPT
  // =============================================================
  function vecOf(p, out) {
    if (!p) return null;
    if (typeof p.x === 'number' && typeof p.z === 'number') { out.x = p.x; out.y = num(p.y, 0); out.z = p.z; return out; }
    if (Array.isArray(p) && p.length >= 3) { out.x = p[0]; out.y = p[1]; out.z = p[2]; return out; }
    return null;
  }
  const TMP2 = { x: 0, y: 0, z: 0 };
  // scratch for the boat helm lookup — a real Vector3 where possible, since
  // boat.helmPos(out) writes into whatever it is handed.
  const TMP3 = (ctx.THREE && ctx.THREE.Vector3) ? new ctx.THREE.Vector3() : { x: 0, y: 0, z: 0 };
  const TMP4 = { x: 0, y: 0, z: 0 };
  function playerPos(out) {
    const pm = ctx.playerMod;
    const l = pm && pm.local;
    if (l) {
      const cands = [l.pos, l.position, l.group && l.group.position, l.char && l.char.group && l.char.group.position, l.mesh && l.mesh.position];
      for (const c of cands) {
        if (c && typeof c.x === 'number' && typeof c.z === 'number') { out.x = c.x; out.y = c.y; out.z = c.z; return out; }
      }
    }
    const cam = ctx.camera;
    if (cam && cam.position) { out.x = cam.position.x; out.y = cam.position.y; out.z = cam.position.z; return out; }
    out.x = 0; out.y = 0; out.z = 0;
    return out;
  }
  function distXZ(a, b) { const dx = a.x - b.x, dz = a.z - b.z; return Math.sqrt(dx * dx + dz * dz); }

  function portalInfo() {
    const w = state.world || {};
    const q = w.quota || {};
    const n = Math.max(0, Math.floor(num(q.n, 0)));
    const arts = Array.isArray(w.artifacts) ? w.artifacts.length : 0;
    const built = !!w.portalBuilt;
    const ready = n >= ECON.QUOTAS_TO_WIN && arts >= 3;
    return { n, arts, built, ready };
  }

  // ---- boat prompts -------------------------------------------
  // The boat is a walkable platform: you can be driving (seat 0), standing on
  // the deck by the wheel, or standing on the deck anywhere else. Older boat
  // handles expose none of that — those fall back to the plain leave prompt.
  function isDrivingBoat() {
    if (Math.floor(num(state.seat, -1)) === 0) return true;
    const b = ctx.boat;
    if (b && typeof b.isDriver === 'function') {
      try { return !!b.isDriver(); } catch (e) { /* boat not ready */ }
    }
    return false;
  }
  function helmDist(p) {
    const b = ctx.boat;
    if (!b || typeof b.helmPos !== 'function') return null;
    let hp = null;
    try { hp = b.helmPos(TMP3); } catch (e) { return null; }
    const v = vecOf(hp, TMP4);
    if (!v) return null;
    return distXZ(p, v);
  }
  function onDeckNow(p) {
    if (state.onDeck === true) return true;
    if (state.onDeck === false) return false;
    const b = ctx.boat;
    if (b && typeof b.deckInfo === 'function') {
      try { return !!b.deckInfo(p.x, p.z); } catch (e) { /* older boat handle */ }
    }
    return false;
  }
  function boatPrompt(p) {
    if (isDrivingBoat()) return { kind: 'boat', d: 0, label: 'Release the wheel', act: null };
    const hd = helmDist(p);
    if (hd != null && hd <= 2) return { kind: 'boat', d: hd, label: 'Take the wheel', act: null };
    if (onDeckNow(p)) return { kind: 'boat', d: 0, label: 'Hop off', act: null };
    return { kind: 'boat', d: 0, label: 'Leave boat', act: null };
  }

  function computeInteract() {
    if (effectivePhase() !== 'playing') return null;
    if (ui.shopOpen || ui.invOpen || ui.chatOpen) return null;
    if (num(state.hp, 100) <= 0) return null;

    // Treasure wins every other prompt: you are only ever "near loot" while
    // hanging over the seabed, where nothing else is competing for E.
    const ln = ui.lootNear;
    if (ln) {
      return {
        kind: 'loot', d: 0, label: lootPromptLabel(ln), lootId: ln.lootId,
        act: () => { try { bus && bus.emit && bus.emit('lootInteract', { lootId: ln.lootId }); } catch (e) { /* no bus */ } },
      };
    }

    const p = playerPos(TMP);

    // A crewmate on the floor outranks the shop, the wheel and the ring.
    if (ui.towing) {
      return { kind: 'revive', d: 0, hot: true, act: null, label: 'E — Release ' + (ui.towing.name || 'them') };
    }
    const rev = revivePrompt(p);
    if (rev) return rev;

    if (state.onBoat) return boatPrompt(p);

    const world = ctx.world;
    const cands = [];

    if (world) {
      const sp = vecOf(world.shopPos, TMP2);
      if (sp) { const d = distXZ(p, sp); if (d < 8) cands.push({ kind: 'shop', d, label: 'Shop — buy & sell', act: openShop }); }
    }
    if (world) {
      const rp = vecOf(world.ringPos || world.portalPos, TMP2);
      if (rp) {
        const d = distXZ(p, rp);
        if (d < 8) {
          const pi = portalInfo();
          if (pi.built) {
            cands.push({ kind: 'portal', d, label: 'ENTER PORTAL', act: () => send(MSG.ENTER_PORTAL, {}), hot: true });
          } else if (pi.ready) {
            cands.push({ kind: 'portal', d, label: 'BUILD PORTAL', act: () => send(MSG.BUILD_PORTAL, {}), hot: true });
          } else {
            cands.push({
              kind: 'portal', d, locked: true,
              label: pi.n + '/' + ECON.QUOTAS_TO_WIN + ' quotas · artifacts ' + pi.arts + '/3',
              act: null,
            });
          }
        }
      }
    }
    const boat = ctx.boat;
    if (boat && typeof boat.nearBoat === 'function') {
      let near = false;
      try { near = !!boat.nearBoat(p); } catch (e) { near = false; }
      if (near) {
        let d = 4;
        if (boat.group && boat.group.position) d = distXZ(p, boat.group.position);
        cands.push({ kind: 'boat', d, label: 'Board boat', act: null });
      }
    }
    if (!cands.length) return null;
    cands.sort((a, b) => a.d - b.d);
    return cands[0];
  }

  const elPromptKey = elPrompt.querySelector('kbd');
  function refreshPrompt() {
    if (ui.doom) { ui.interact = null; elPrompt.classList.remove('show'); return; }
    const it = computeInteract();
    ui.interact = it;
    if (!it) { elPrompt.classList.remove('show'); return; }
    elPrompt.classList.add('show');
    elPrompt.classList.toggle('is-locked', !!it.locked);
    elPrompt.classList.toggle('is-hot', !!it.hot);
    elPrompt.classList.toggle('is-loot', it.kind === 'loot');
    elPrompt.classList.toggle('is-revive', it.kind === 'revive');
    setText(elPromptTxt, it.label);
    elPromptKey.style.display = it.locked ? 'none' : '';
  }

  function doInteract() {
    if (ui.doom) return;
    const it = ui.interact || computeInteract();
    if (!it) return;
    if (it.locked) {
      toast(it.kind === 'portal' ? ('The ring is not ready: ' + it.label) : it.label, 'warn');
      return;
    }
    if (typeof it.act === 'function') it.act();
    // boat boarding/leaving is owned by player.js — the prompt is informational
  }

  // =============================================================
  // AREA CHIP + SKY ICON
  // =============================================================
  function refreshArea() {
    const id = state.currentArea;
    if (!id) { elAreaChip.classList.remove('show'); return; }
    const a = AREAS.find((x) => x.id === id);
    if (!a) { elAreaChip.classList.remove('show'); return; }
    elAreaChip.classList.add('show');
    setHTML(elAreaChip, `<b>${escapeHTML(a.name)}</b><i>tiers ${a.tiers[0]}–${a.tiers[1]} · ${a.depth} m</i>`);
  }

  let lastNight = null;
  function refreshSky() {
    const t = num(state.timeOfDay, 0.3);
    const night = (t >= ECON.NIGHT_START || t < 0.22);
    if (night !== lastNight) {
      lastNight = night;
      setHTML(elSkyIcon, night ? SVG_MOON : SVG_SUN);
      elSkyIcon.classList.toggle('is-night', night);
    }
    let phase;
    if (t < 0.22) phase = 'small hours';
    else if (t < 0.32) phase = 'sunrise';
    else if (t < 0.5) phase = 'morning';
    else if (t < 0.66) phase = 'afternoon';
    else if (t < ECON.NIGHT_START) phase = 'dusk';
    else phase = 'night';
    setText(elDayPhase, phase);
    root.classList.toggle('is-night', night);
  }

  // =============================================================
  // VITALS
  // =============================================================
  function refreshVitals() {
    const hp = Math.max(0, num(state.hp, PLAYER_MAX_HP));
    const f = clamp01(hp / PLAYER_MAX_HP);
    elHpFill.style.width = (f * 100).toFixed(1) + '%';
    setText(elHpTxt, String(Math.round(hp)));
    elHpFill.classList.toggle('is-low', f < 0.3);

    const air = clamp01(num(state.air, 1));
    const showAir = !!state.underwater || air < 0.999;
    elAirRow.classList.toggle('show', showAir);
    if (showAir) {
      elAirFill.style.width = (air * 100).toFixed(1) + '%';
      setText(elAirTxt, air > 0.005 ? (Math.round(air * 100) + '%') : 'OUT');
      elAirFill.classList.toggle('is-low', air < 0.3);
    }

    const ko = hp <= 0 && effectivePhase() === 'playing' && !ui.doom;
    if (ko !== ui.koShown) {
      ui.koShown = ko;
      elKO.classList.toggle('show', ko);
      root.dataset.ko = ko ? '1' : '';
      if (ko) { closeShop(); closeInventory(); hideReviveRing(); }
    }
    refreshKO(ko);
  }

  // =============================================================
  // NET + BUS WIRING
  // =============================================================
  onBus('phase', () => applyPhase());
  onBus('worldState', (w) => onWorldState(w));
  onBus('error', (d) => {
    const msg = (d && (d.message || d.msg)) || (typeof d === 'string' ? d : 'Something went wrong');
    if (fresh('err:' + msg, 400)) toast(msg, 'bad');
  });
  onBus('catch', (d) => showCatch(d));
  onBus('castPower', (d) => onCastPower(d));
  onBus('reelState', (d) => onReelState(d));
  onBus('castStart', () => { hideCastPower(); });
  onBus('bite', () => { hideCastPower(); toast('Something bit!', 'good'); });
  onBus('chat', (d) => {
    if (!d) return;
    const from = d.fromName || d.from || '';
    const text = d.text || '';
    if (!text) return;
    if (!fresh('chat:' + from + '|' + text, 350)) return;
    handleChatMsg(from, text);
  });
  onBus('eventStart', (d) => {
    const type = (d && d.type) || d;
    if (!fresh('evs:' + type, 800)) return;
    state.eventActive = type;
    showEventBanner(type);
  });
  onBus('eventEnd', (d) => {
    const type = (d && d.type) || d;
    if (!fresh('eve:' + type, 800)) return;
    state.eventActive = null;
    endEventBanner(d && typeof d === 'object' ? d : null);
  });
  onBus('localDamaged', (d) => { flashDamage(d && d.dmg); });
  onBus('underwater', (on) => {
    refreshVitals();
    const under = (on && typeof on === 'object') ? !!on.on : !!on;
    if (under) maybeDiveHint();
  });
  onBus('boardBoat', () => { refreshPrompt(); });
  onBus('leaveBoat', () => { refreshPrompt(); });
  onBus('shopResult', (d) => handleShopResult(d));
  onBus('quotaDone', (d) => { if (fresh('qd:' + (d && d.n), 500)) showQuotaBanner(d); });
  onBus('tsunamiWarning', (d) => handleTsunamiWarning(d));
  // fishing.js re-emits the server's flopper beats for us
  onBus('flopper', (d) => onFlopper(d));
  onBus('weather', (d) => { const t = (d && d.type) || d; if (typeof t === 'string') setWeather(t); });
  // loot.js owns the nodes and the PICKUP_LOOT send; we own the prompt + the noise
  onBus('lootNear', (d) => onLootNear(d));
  onBus('lootResult', (d) => onLootResult(d));
  onBus('lootState', (d) => noteLootState(d));
  // wave 5: fishing.js says the release landed in the band; player.js channels revives
  onBus('perfectCast', () => showPerfect());
  onBus('reviveChannel', (d) => onReviveChannel(d));
  onBus('bodyTowed', (d) => onBodyTowed(d));
  onBus('revived', (d) => onRevived(d));
  onBus('tsunami', () => startDoomsday());

  function handleChatMsg(from, text) {
    const sys = !from || from === 'ISLAND' || from === 'system' || from === 'System';
    pushChat(from, text, sys);
    // The server announces artifacts through chat; mirror it as a banner.
    if (sys || /artifact/i.test(text)) {
      for (const k of artiKeys) {
        if (text.indexOf(ARTIFACTS[k].name) >= 0) {
          if (fresh('artb:' + k, 3000)) showArtifactBanner(k);
          break;
        }
      }
    }
  }

  function handleShopResult(d) {
    if (!d) return;
    const key = 'shop:' + (d.itemId || '') + '|' + (d.message || '') + '|' + (d.ok ? 1 : 0);
    if (!fresh(key, 400)) return;
    if (d.gear && typeof d.gear === 'object') state.gear = Object.assign({}, state.gear, d.gear);
    const item = d.itemId ? shopById(d.itemId) : null;
    const msg = d.message || (d.ok ? ((item ? item.name : 'Item') + ' purchased') : 'Purchase failed');
    toast(msg, d.ok ? 'good' : 'bad');
    if (d.ok && item) {
      if (item.kind === 'weapon') {
        const g = state.gear || (state.gear = {});
        if (!Array.isArray(g.weapons)) g.weapons = [];
        if (g.weapons.indexOf(item.id) < 0) g.weapons.push(item.id);
        if (!g.activeWeapon) g.activeWeapon = item.id;
      }
      if (item.kind === 'bait') {
        const g = state.gear || (state.gear = {});
        if (!g.activeBait) g.activeBait = item.id;
      }
    }
    refreshHotbar();
    refreshHUDFromState();
    if (ui.shopOpen) renderShop();
    if (ui.invOpen) renderInventory();
  }

  function handleTsunamiWarning(d) {
    const days = Math.max(0, Math.floor(num(d && d.daysLeft, 1)));
    if (!fresh('tw:' + days, 1500)) return;
    elDeadlineChip.classList.add('is-urgent', 'is-pulse');
    ui.tsunamiPulse = 8;
    toast(days <= 0
      ? 'THE TSUNAMI COMES TODAY — sell everything'
      : ('Tsunami in ' + days + (days === 1 ? ' day' : ' days') + ' — sell everything'), 'warn');
  }

  // Direct net subscriptions (authoritative; deduped against bus relays)
  onNet(MSG.ROOM_STATE, (d) => {
    if (!d) return;
    state.room = d;
    if (!d.started && (state.phase === 'menu' || !state.phase)) state.phase = 'lobby';
    const me = myId();
    if (Array.isArray(d.players)) {
      const mine = d.players.find((p) => p && p.id === me);
      if (mine && typeof mine.ready === 'boolean') ui.ready = mine.ready;
    }
    applyPhase(true);
    renderLobby();
  });
  onNet(MSG.ERROR_MSG, (d) => {
    const msg = (d && (d.message || d.msg)) || 'Something went wrong';
    if (fresh('err:' + msg, 400)) toast(msg, 'bad');
  });
  onNet(MSG.GAME_START, (d) => {
    if (d && d.you && d.you.id) state.myId = d.you.id;
    if (d && d.state) onWorldState(d.state);
    if (state.phase !== 'playing') state.phase = 'playing';
    ui.sawWorld = true;
    ui.lastArtifacts = (d && d.state && Array.isArray(d.state.artifacts)) ? d.state.artifacts.length : 0;
    applyPhase(true);
    toast('The island is yours. Don\'t miss the quota.', 'good');
  });
  onNet(MSG.WORLD_STATE, (d) => onWorldState(d));
  onNet(MSG.INVENTORY, (d) => {
    if (!d) return;
    if (Array.isArray(d.items)) state.inventory = d.items;
    if (d.baits && typeof d.baits === 'object') state.baits = d.baits;
    const g = state.gear || (state.gear = {});
    if (g.activeBait && num(state.baits[g.activeBait], 0) <= 0) {
      const ob = ownedBaits();
      g.activeBait = ob.length ? ob[0].id : null;
    }
    refreshHotbar();
    if (ui.invOpen) renderInventory();
    if (ui.shopOpen && ui.shopTab === 'sell') renderShop();
  });
  onNet(MSG.WALLET, (d) => {
    if (!d) return;
    if (state.world) {
      if (typeof d.wallet === 'number') state.world.wallet = d.wallet;
      if (typeof d.quotaProgress === 'number') {
        state.world.quota = state.world.quota || {};
        state.world.quota.progress = d.quotaProgress;
      }
      refreshHUDFromState();
      if (ui.shopOpen) renderShop();
    }
  });
  onNet(MSG.SHOP_RESULT, (d) => handleShopResult(d));
  onNet(MSG.CAST_RESULT, (d) => showCatch(d));
  onNet(MSG.CHAT_MSG, (d) => {
    if (!d) return;
    const from = d.fromName || d.from || '';
    const text = d.text || '';
    if (!text) return;
    if (!fresh('chat:' + from + '|' + text, 350)) return;
    handleChatMsg(from, text);
  });
  onNet(MSG.QUOTA_DONE, (d) => { if (fresh('qd:' + (d && d.n), 500)) showQuotaBanner(d); });
  onNet(MSG.TSUNAMI_WARNING, (d) => handleTsunamiWarning(d));
  // DOOMSDAY. The hud goes away entirely — events.js owns the screen from here.
  onNet(MSG.TSUNAMI, () => {
    startDoomsday();
    elTsunamiFlash.classList.remove('show'); void elTsunamiFlash.offsetWidth;
    elTsunamiFlash.classList.add('show');
    root.classList.add('shake-long');
  });
  onNet(MSG.GAME_OVER, (d) => {
    elTsunamiFlash.classList.remove('show');
    root.classList.remove('shake-long');
    showEnd('over', d || {});
  });
  onNet(MSG.GAME_WON, (d) => { showEnd('won', d || {}); });
  onNet(MSG.PORTAL_STATE, (d) => {
    if (!d) return;
    if (state.world) state.world.portalBuilt = !!d.built;
    if (d.built && fresh('portalbuilt', 4000)) toast('The portal is open. Everyone in.', 'good');
    else if (!d.built && Array.isArray(d.missing) && d.missing.length && fresh('portalmiss', 2000)) {
      toast('Still missing: ' + d.missing.map((m) => (ARTIFACTS[m] ? ARTIFACTS[m].name : m)).join(', '), 'warn');
    }
    refreshPrompt();
  });
  onNet(MSG.PLAYER_DAMAGED, (d) => {
    if (!d) return;
    const me = myId();
    if (d.id && me && d.id !== me) return;
    if (typeof d.hp === 'number') state.hp = d.hp;
    if (fresh('dmg:' + (d.hp != null ? d.hp : Math.random()), 120)) flashDamage();
    refreshVitals();
  });
  onNet(MSG.EVENT_START, (d) => {
    const type = (d && d.type) || d;
    if (!fresh('evs:' + type, 800)) return;
    state.eventActive = type;
    showEventBanner(type);
  });
  onNet(MSG.EVENT_END, (d) => {
    const type = (d && d.type) || d;
    if (!fresh('eve:' + type, 800)) return;
    state.eventActive = null;
    endEventBanner(d && typeof d === 'object' ? d : null);
  });
  onNet(MSG.BITE, () => { hideCastPower(); });

  // ---- wave 2: weather, landed-catch bonking, lightning ----
  onNet(MSG.WEATHER, (d) => {
    const t = (d && d.type) || d;
    if (typeof t === 'string') setWeather(t);
  });
  onNet(MSG.FLOPPER, (d) => onFlopper(d));

  // ---- wave 4: underwater loot ----
  onNet(MSG.LOOT_STATE, (d) => noteLootState(d));
  onNet(MSG.LOOT_RESULT, (d) => onLootResult(d));

  // ---- wave 5: reviving ----
  onNet(MSG.REVIVED, (d) => onRevived(d));
  onNet(MSG.BODY_TOWED, (d) => onBodyTowed(d));
  onNet(MSG.LIGHTNING, (d) => {
    if (!d) return;
    const me = myId();
    if (!d.targetId || !me || d.targetId !== me) return;
    if (!fresh('zap:' + me, 250)) return;
    lightningFlinch();
    toast('LIGHTNING — get off the open water', 'bad');
  });

  // =============================================================
  // KEYBOARD
  // =============================================================
  function isTyping() {
    const a = document.activeElement;
    if (!a) return false;
    const tn = a.tagName;
    return tn === 'INPUT' || tn === 'TEXTAREA' || tn === 'SELECT' || a.isContentEditable === true;
  }

  function onKeyDown(e) {
    const phase = effectivePhase();
    if (isTyping()) {
      if (e.code === 'Escape' && !ui.chatOpen) { document.activeElement.blur(); }
      return; // inputs own their keys
    }
    if (e.code === 'Escape') {
      if (ui.shopOpen || ui.invOpen) { e.preventDefault(); closeAll(); }
      else if (ui.menuPanel !== 'none' && phase === 'menu') { setMenuPanel('none'); }
      return;
    }
    if (phase !== 'playing') return;
    if (e.repeat) return;

    switch (e.code) {
      case 'Enter':
      case 'NumpadEnter':
        e.preventDefault();
        if (!ui.shopOpen && !ui.invOpen) openChat();
        break;
      case 'KeyE':
        if (ui.shopOpen || ui.invOpen) break;
        doInteract();
        break;
      case 'KeyI':
        if (ui.shopOpen) { closeShop(); break; }
        toggleInventory();
        break;
      case 'KeyB':
        if (ui.shopOpen || ui.invOpen) break;
        cycleBait();
        break;
      case 'Digit1':
      case 'Numpad1':
        if (ui.shopOpen || ui.invOpen) break;
        setTool('rod');
        break;
      case 'Digit2':
      case 'Numpad2':
        if (ui.shopOpen || ui.invOpen) break;
        setTool('weapon', true);
        break;
      default:
        break;
    }
  }
  window.addEventListener('keydown', onKeyDown);

  // =============================================================
  // UPDATE LOOP
  // =============================================================
  function tick10() {
    applyPhase();

    // Doomsday: the hud is gone and stays gone. Nothing below may repaint it.
    if (ui.doom) {
      if (ui.phase === 'playing') { refreshSky(); }
      return;
    }

    if (ui.shopOpen || ui.invOpen || ui.chatOpen || isTyping()) {
      try { if (ctx.input && ctx.input.keys && ctx.input.keys.size) ctx.input.keys.clear(); } catch (e) { /* ignore */ }
      if (ctx.input && (ui.shopOpen || ui.invOpen)) ctx.input.mouseDown = false;
    }

    if (ui.phase === 'lobby') {
      const r = state.room;
      const rev = r ? (String(r.code) + '|' + (Array.isArray(r.players)
        ? r.players.map((p) => p.id + ':' + (p.ready ? 1 : 0) + ':' + p.name + ':' + p.hat + ':' + p.skin).join(',')
        : '') + '|' + r.hostId) : '';
      if (rev !== ui.roomRev) { ui.roomRev = rev; renderLobby(); }
      return;
    }
    if (ui.phase !== 'playing') return;

    refreshSky();
    refreshVitals();
    refreshArea();
    refreshPrompt();
    fadeChat();

    // hotbar reacts to gear/inventory changes coming from anywhere
    const g = state.gear || {};
    const inv = inventoryList();
    const sig = [g.rod, g.boat, g.diving, g.activeBait, g.activeWeapon, state.activeTool,
      (Array.isArray(g.weapons) ? g.weapons.length : 0), inv.length].join('|');
    if (sig !== ui._gearSig) { ui._gearSig = sig; refreshHotbar(); }

    // event vignette follows authoritative state
    const ev = state.eventActive;
    if (!!ev !== elEventVig.classList.contains('on')) {
      elEventVig.classList.toggle('on', !!ev);
      root.dataset.event = ev || '';
    }

    if (ui.tsunamiPulse > 0) {
      ui.tsunamiPulse -= 0.1;
      if (ui.tsunamiPulse <= 0) elDeadlineChip.classList.remove('is-pulse');
    }
  }

  function update(dt, t) {
    ui.now = num(t, ui.now + num(dt, 0.016));
    ui.acc += num(dt, 0.016);
    if (ui.acc >= 0.1) { ui.acc = 0; tick10(); }
    if (ui.doom) return;
    if (floppers.size) tickFloppers();
    // world-anchored downed markers follow the camera, so they run every frame
    updateDownedMarkers();
    // stale-timeout for the transient widgets
    if (elCastPower.classList.contains('show') && ui.now - ui.castPowerT > 0.35) hideCastPower();
    if (ui.reelOn && ui.now - ui.reelT > 45) hideReel();
    if (ui.reviveOn && ui.now - ui.reviveChT > 0.35) hideReviveRing();
    if (ui.perfectT > -90 && ui.now - ui.perfectT > 0.85) hidePerfect();
  }

  // =============================================================
  // PUBLIC HANDLE
  // =============================================================
  function closeAll() {
    closeShop();
    closeInventory();
    closeChat(false);
    setMenuPanel('none');
    elCatch.classList.remove('show');
    elUnique.classList.remove('show');
    hideReel();
    hideCastPower();
    hidePerfect();
    hideReviveRing();
  }

  setCastBand(PERFECT_BAND);
  applyPhase(true);
  refreshHotbar();
  refreshVitals();
  refreshSky();
  setText(maxPlayersVal, maxPlayersInput.value);

  const handle = { update, toast, openShop, closeAll };
  return handle;
}
