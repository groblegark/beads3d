// Link icon glyph textures (bd-7t6nt: extracted from main.js)
// Draws simple glyphs on canvas → texture → SpriteMaterial for dependency edge midpoints.

import * as THREE from 'three';

function makeLinkIconTexture(drawFn, color) {
  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, size, size);
  drawFn(ctx, size, color);
  const tex = new THREE.CanvasTexture(canvas);
  tex.minFilter = THREE.LinearFilter;
  return new THREE.SpriteMaterial({ map: tex, transparent: true, opacity: 0.85, depthWrite: false });
}

// Shield glyph — for "blocks" deps
function drawShield(ctx, s, color) {
  const cx = s / 2,
    cy = s / 2;
  ctx.beginPath();
  ctx.moveTo(cx, cy - 22);
  ctx.bezierCurveTo(cx + 20, cy - 18, cx + 22, cy, cx + 18, cy + 14);
  ctx.lineTo(cx, cy + 24);
  ctx.lineTo(cx - 18, cy + 14);
  ctx.bezierCurveTo(cx - 22, cy, cx - 20, cy - 18, cx, cy - 22);
  ctx.closePath();
  ctx.strokeStyle = color;
  ctx.lineWidth = 3;
  ctx.stroke();
  // X inside shield
  ctx.beginPath();
  ctx.moveTo(cx - 7, cy - 5);
  ctx.lineTo(cx + 7, cy + 7);
  ctx.moveTo(cx + 7, cy - 5);
  ctx.lineTo(cx - 7, cy + 7);
  ctx.strokeStyle = color;
  ctx.lineWidth = 2.5;
  ctx.stroke();
}

// Clock glyph — for "waits-for" deps
function drawClock(ctx, s, color) {
  const cx = s / 2,
    cy = s / 2,
    r = 18;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.strokeStyle = color;
  ctx.lineWidth = 2.5;
  ctx.stroke();
  // Clock hands
  ctx.beginPath();
  ctx.moveTo(cx, cy);
  ctx.lineTo(cx, cy - 12); // 12 o'clock
  ctx.moveTo(cx, cy);
  ctx.lineTo(cx + 8, cy + 3); // ~2 o'clock
  ctx.strokeStyle = color;
  ctx.lineWidth = 2.5;
  ctx.stroke();
}

// Chain link glyph — for "parent-child" deps
function drawChain(ctx, s, color) {
  const cx = s / 2,
    cy = s / 2;
  ctx.strokeStyle = color;
  ctx.lineWidth = 2.5;
  // Top oval
  ctx.beginPath();
  ctx.ellipse(cx, cy - 8, 8, 12, 0, 0, Math.PI * 2);
  ctx.stroke();
  // Bottom oval (overlapping)
  ctx.beginPath();
  ctx.ellipse(cx, cy + 8, 8, 12, 0, 0, Math.PI * 2);
  ctx.stroke();
}

// Dot glyph — for "relates-to" or default
function drawDot(ctx, s, color) {
  const cx = s / 2,
    cy = s / 2;
  ctx.beginPath();
  ctx.arc(cx, cy, 8, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.globalAlpha = 0.6;
  ctx.fill();
  ctx.globalAlpha = 1;
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.stroke();
}

// Person glyph — for "assigned_to" deps (agent ↔ bead)
function drawPerson(ctx, s, color) {
  const cx = s / 2,
    cy = s / 2;
  ctx.strokeStyle = color;
  ctx.lineWidth = 2.5;
  // Head
  ctx.beginPath();
  ctx.arc(cx, cy - 12, 7, 0, Math.PI * 2);
  ctx.stroke();
  // Body
  ctx.beginPath();
  ctx.moveTo(cx, cy - 5);
  ctx.lineTo(cx, cy + 8);
  ctx.stroke();
  // Arms
  ctx.beginPath();
  ctx.moveTo(cx - 10, cy);
  ctx.lineTo(cx + 10, cy);
  ctx.stroke();
  // Legs
  ctx.beginPath();
  ctx.moveTo(cx, cy + 8);
  ctx.lineTo(cx - 8, cy + 20);
  ctx.moveTo(cx, cy + 8);
  ctx.lineTo(cx + 8, cy + 20);
  ctx.stroke();
}

// Warning triangle glyph — for rig conflict edges (bd-90ikf)
function drawWarning(ctx, s, color) {
  const cx = s / 2,
    cy = s / 2;
  ctx.strokeStyle = color;
  ctx.lineWidth = 2.5;
  // Triangle
  ctx.beginPath();
  ctx.moveTo(cx, cy - 16);
  ctx.lineTo(cx - 14, cy + 12);
  ctx.lineTo(cx + 14, cy + 12);
  ctx.closePath();
  ctx.stroke();
  // Exclamation
  ctx.fillStyle = color;
  ctx.fillRect(cx - 1.5, cy - 8, 3, 12);
  ctx.beginPath();
  ctx.arc(cx, cy + 8, 2, 0, Math.PI * 2);
  ctx.fill();
}

/** @type {Record<string, THREE.SpriteMaterial>} */
export const LINK_ICON_MATERIALS = {
  blocks: makeLinkIconTexture(drawShield, '#d04040'),
  'waits-for': makeLinkIconTexture(drawClock, '#d4a017'),
  'parent-child': makeLinkIconTexture(drawChain, '#8b45a6'),
  'relates-to': makeLinkIconTexture(drawDot, '#4a9eff'),
  assigned_to: makeLinkIconTexture(drawPerson, '#ff6b35'),
  rig_conflict: makeLinkIconTexture(drawWarning, '#ff3030'),
};
/** @type {THREE.SpriteMaterial} */
export const LINK_ICON_DEFAULT = makeLinkIconTexture(drawDot, '#2a2a3a');
/** @type {number} */
export const LINK_ICON_SCALE = 12; // sprite size in world units (bd-t1g9o: increased for visibility)
