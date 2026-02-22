import ForceGraph3D from '3d-force-graph';
import * as THREE from 'three';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { CSS2DRenderer, CSS2DObject } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import { BeadsAPI } from './api.js';
import { nodeColor, nodeSize, linkColor, colorToHex, rigColor } from './colors.js';
import { createFresnelMaterial, createStarField, updateShaderTime, createMateriaMaterial, createMateriaHaloTexture, createParticlePool } from './shaders.js';

// --- Config ---
const params = new URLSearchParams(window.location.search);
const API_BASE = params.get('api') || '/api';
const DEEP_LINK_BEAD = params.get('bead') || ''; // bd-he95o: URL deep-linking
const DEEP_LINK_MOLECULE = params.get('molecule') || ''; // bd-lwut6: molecule focus view
const URL_PROFILE = params.get('profile') || ''; // bd-8o2gd phase 4: load named profile from URL
const URL_ASSIGNEE = params.get('assignee') || ''; // bd-8o2gd phase 4: filter by assignee via URL
const URL_STATUS = params.get('status') || ''; // bd-8o2gd phase 4: comma-separated statuses
const URL_TYPES = params.get('types') || ''; // bd-8o2gd phase 4: comma-separated types
const POLL_INTERVAL = 30000; // bd-c1x6p: reduced from 10s to 30s — SSE handles live updates
const MAX_NODES = 1000; // bd-04wet: raised from 500 to show more relevant beads

const api = new BeadsAPI(API_BASE);

// --- Shared geometries (reused across all nodes to reduce GC + draw overhead) ---
const GEO = {
  sphereHi:   new THREE.SphereGeometry(1, 12, 12),   // unit sphere, scaled per-node
  sphereLo:   new THREE.SphereGeometry(1, 6, 6),      // low-poly glow shell
  torus:      new THREE.TorusGeometry(1, 0.15, 6, 20), // unit torus for rings
  icosa:      new THREE.IcosahedronGeometry(1, 1),     // epic shell
  octa:       new THREE.OctahedronGeometry(1, 0),      // blocked spikes
  box:        new THREE.BoxGeometry(1, 1, 1),           // descent stage, general purpose
};

// Shared materia halo texture (bd-c7d5z) — lazy-initialized on first use
let _materiaHaloTex = null;

// --- Link icon textures (shared, one per dep type) ---
// Draw simple glyphs on canvas → texture → SpriteMaterial
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
  const cx = s / 2, cy = s / 2;
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
  ctx.moveTo(cx - 7, cy - 5); ctx.lineTo(cx + 7, cy + 7);
  ctx.moveTo(cx + 7, cy - 5); ctx.lineTo(cx - 7, cy + 7);
  ctx.strokeStyle = color;
  ctx.lineWidth = 2.5;
  ctx.stroke();
}

// Clock glyph — for "waits-for" deps
function drawClock(ctx, s, color) {
  const cx = s / 2, cy = s / 2, r = 18;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.strokeStyle = color;
  ctx.lineWidth = 2.5;
  ctx.stroke();
  // Clock hands
  ctx.beginPath();
  ctx.moveTo(cx, cy); ctx.lineTo(cx, cy - 12); // 12 o'clock
  ctx.moveTo(cx, cy); ctx.lineTo(cx + 8, cy + 3); // ~2 o'clock
  ctx.strokeStyle = color;
  ctx.lineWidth = 2.5;
  ctx.stroke();
}

// Chain link glyph — for "parent-child" deps
function drawChain(ctx, s, color) {
  const cx = s / 2, cy = s / 2;
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
  const cx = s / 2, cy = s / 2;
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
  const cx = s / 2, cy = s / 2;
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
  const cx = s / 2, cy = s / 2;
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

const LINK_ICON_MATERIALS = {
  'blocks':       makeLinkIconTexture(drawShield, '#d04040'),
  'waits-for':    makeLinkIconTexture(drawClock,  '#d4a017'),
  'parent-child': makeLinkIconTexture(drawChain,  '#8b45a6'),
  'relates-to':   makeLinkIconTexture(drawDot,    '#4a9eff'),
  'assigned_to':  makeLinkIconTexture(drawPerson, '#ff6b35'),
  'rig_conflict': makeLinkIconTexture(drawWarning,'#ff3030'),
};
const LINK_ICON_DEFAULT = makeLinkIconTexture(drawDot, '#2a2a3a');

const LINK_ICON_SCALE = 12; // sprite size in world units (bd-t1g9o: increased for visibility)

// --- State ---
let graphData = { nodes: [], links: [] };
let graph;
let searchFilter = '';
let statusFilter = new Set(); // empty = show all
let typeFilter = new Set();
let priorityFilter = new Set(); // empty = show all priorities (bd-8o2gd phase 2)
let assigneeFilter = ''; // empty = show all assignees (bd-8o2gd phase 2)
let filterDashboardOpen = false; // slide-out filter panel state (bd-8o2gd phase 2)
let startTime = performance.now();
let selectedNode = null;
let highlightNodes = new Set();
let highlightLinks = new Set();
let bloomPass = null;
let bloomEnabled = false;
let layoutGuides = []; // THREE objects added as layout visual aids (cleaned up on layout switch)

// Search navigation state
let searchResults = []; // ordered list of matching node ids
let searchResultIdx = -1; // current position in results (-1 = none)
let minimapVisible = true;

// Multi-selection state (rubber-band / shift+drag)
let multiSelected = new Set(); // set of node IDs currently multi-selected
let revealedNodes = new Set(); // node IDs force-shown by click-to-reveal (hq-vorf47)
let focusedMoleculeNodes = new Set(); // node IDs in the focused molecule (bd-lwut6)
let isBoxSelecting = false;
let boxSelectStart = null; // {x, y} screen coords
let cameraFrozen = false; // true when multi-select has locked orbit controls (bd-casin)
let labelsVisible = false; // true when persistent info labels are shown on all nodes (bd-1o2f7)

// Quake-style smooth camera movement (bd-zab4q)
const _keysDown = new Set(); // currently held arrow keys
const _camVelocity = { x: 0, y: 0, z: 0 }; // world-space camera velocity
const CAM_ACCEL = 1.2;      // acceleration per frame while key held
const CAM_MAX_SPEED = 16;   // max strafe speed (units/frame)
const CAM_FRICTION = 0.88;  // velocity multiplier per frame when no key held (lower = more friction)
const openPanels = new Map(); // beadId → panel element (bd-fbmq3: tiling detail panels)
let activeAgeDays = 7; // age filter: show beads updated within N days (0 = all) (bd-uc0mw)

// Agent filter state (bd-8o2gd: configurable filter dashboard, phase 1)
let agentFilterShow = true;        // master toggle — show/hide all agent nodes
let agentFilterOrphaned = false;   // show agents with no visible connected beads
let agentFilterRigExclude = new Set(); // hide agents on these rigs (exact match)
let agentFilterNameExclude = []; // glob patterns to hide agents by name (bd-8o2gd phase 4)

// Simple glob matcher: supports * (any chars) and ? (single char) (bd-8o2gd phase 4)
function globMatch(pattern, str) {
  const re = new RegExp('^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'i');
  return re.test(str);
}

// Check if a text input element is focused — suppress keyboard shortcuts (beads-lznc)
function isTextInputFocused() {
  const el = document.activeElement;
  if (!el) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || el.contentEditable === 'true';
}

// Resource cleanup refs (bd-7n4g8)
let _bloomResizeHandler = null;
let _pollIntervalId = null;
let _searchDebounceTimer = null;

// Live event doots — HTML overlay elements via CSS2DRenderer (bd-bwkdk)
const doots = []; // { css2d, el, node, birth, lifetime, jx, jz }
let css2dRenderer = null; // CSS2DRenderer instance

// Doot-triggered issue popups — auto-dismissing cards when doots fire (beads-edy1)
const dootPopups = new Map(); // nodeId → { el, timer, node, lastDoot }

// Agent activity feed windows — rich session transcript popups (bd-kau4k)
// bd-5ok9s: enhanced status: lastStatus, lastTool, idleSince, crashError
const agentWindows = new Map();

// Agents View overlay state (bd-jgvas)
let agentsViewOpen = false;

// Left Sidebar state (bd-nnr22)
let leftSidebarOpen = false;
const _agentRoster = new Map(); // agent name → { status, task, tool, idleSince, crashError, nodeId }

// Epic cycling state — Shift+S/D navigation (bd-pnngb)
let _epicNodes = [];       // sorted array of epic nodes, rebuilt on refresh
let _epicCycleIndex = -1;  // current position in _epicNodes (-1 = none)

// --- GPU Particle Pool + Selection VFX (bd-m9525) ---
let _particlePool = null;  // GPU particle pool instance
let _hoveredNode = null;   // currently hovered node for glow warmup
let _hoverGlowTimer = 0;   // accumulator for hover glow particle emission
let _selectionOrbitTimer = 0; // accumulator for orbit ring particle emission
let _energyStreamTimer = 0;  // accumulator for dependency energy stream particles
let _flyToTrailActive = false; // true during camera fly-to for particle trail

// --- VFX Control Panel settings (bd-hr5om) ---
const _vfxConfig = {
  orbitSpeed: 2.5,          // orbit ring angular speed
  orbitRate: 0.08,          // orbit ring emission interval (seconds)
  orbitSize: 1.5,           // orbit ring particle size
  hoverRate: 0.15,          // hover glow emission interval (seconds)
  hoverSize: 1.2,           // hover glow particle size
  streamRate: 0.12,         // dependency energy stream emission interval (seconds)
  streamSpeed: 3.0,         // energy stream particle velocity
  particleLifetime: 0.8,    // base particle lifetime (seconds)
  selectionGlow: 1.0,       // selection glow intensity multiplier
};

// --- Event sprites: pop-up animations for status changes + new associations (bd-9qeto) ---
const eventSprites = []; // { mesh, birth, lifetime, type, ... }
const EVENT_SPRITE_MAX = 40;

// Status pulse colors by transition
const STATUS_PULSE_COLORS = {
  in_progress: 0xd4a017, // amber — just started
  closed:      0x2d8a4e, // green — completed
  open:        0x4a9eff, // blue — reopened
  review:      0x4a9eff, // blue
  on_ice:      0x3a5a7a, // muted blue
};

// Spawn an expanding ring burst when a bead changes status (bd-9qeto)
function spawnStatusPulse(node, oldStatus, newStatus) {
  if (!node || !graph) return;
  const color = STATUS_PULSE_COLORS[newStatus] || 0x4a9eff;
  const size = nodeSize({ priority: node.priority, issue_type: node.issue_type });

  // Ring 1: fast expanding ring
  const ringGeo = new THREE.RingGeometry(size * 0.8, size * 1.0, 24);
  const ringMat = new THREE.MeshBasicMaterial({
    color, transparent: true, opacity: 0.7, side: THREE.DoubleSide, depthWrite: false,
  });
  const ring = new THREE.Mesh(ringGeo, ringMat);
  ring.position.set(node.x || 0, node.y || 0, node.z || 0);
  ring.lookAt(graph.camera().position);
  graph.scene().add(ring);

  eventSprites.push({
    mesh: ring, node, birth: performance.now() / 1000, lifetime: 1.5,
    type: 'status-pulse', startScale: 1.0, endScale: 4.0,
  });

  // Ring 2: slower, wider, dimmer secondary pulse
  const ring2Geo = new THREE.RingGeometry(size * 0.6, size * 0.75, 24);
  const ring2Mat = new THREE.MeshBasicMaterial({
    color, transparent: true, opacity: 0.4, side: THREE.DoubleSide, depthWrite: false,
  });
  const ring2 = new THREE.Mesh(ring2Geo, ring2Mat);
  ring2.position.set(node.x || 0, node.y || 0, node.z || 0);
  ring2.lookAt(graph.camera().position);
  graph.scene().add(ring2);

  eventSprites.push({
    mesh: ring2, node, birth: performance.now() / 1000 + 0.15, lifetime: 2.0,
    type: 'status-pulse', startScale: 1.0, endScale: 5.0,
  });

  // Prune oldest
  while (eventSprites.length > EVENT_SPRITE_MAX) {
    const old = eventSprites.shift();
    graph.scene().remove(old.mesh);
    old.mesh.geometry.dispose();
    old.mesh.material.dispose();
  }
}

// Spawn sparks that travel along a new edge between two nodes (bd-9qeto)
function spawnEdgeSpark(sourceNode, targetNode, color) {
  if (!sourceNode || !targetNode || !graph) return;
  const sparkColor = color || 0x4a9eff;

  // Create 3 small sphere sparks that travel from source to target
  for (let i = 0; i < 3; i++) {
    const sparkGeo = new THREE.SphereGeometry(0.8, 6, 6);
    const sparkMat = new THREE.MeshBasicMaterial({
      color: sparkColor, transparent: true, opacity: 0.9, depthWrite: false,
    });
    const spark = new THREE.Mesh(sparkGeo, sparkMat);
    spark.position.set(sourceNode.x || 0, sourceNode.y || 0, sourceNode.z || 0);
    graph.scene().add(spark);

    eventSprites.push({
      mesh: spark, birth: performance.now() / 1000 + i * 0.2, lifetime: 1.2,
      type: 'edge-spark',
      sourceNode, targetNode,
      jitter: { x: (Math.random() - 0.5) * 2, y: (Math.random() - 0.5) * 2, z: (Math.random() - 0.5) * 2 },
    });
  }

  // Burst particles at connection point (midpoint)
  const mx = ((sourceNode.x || 0) + (targetNode.x || 0)) / 2;
  const my = ((sourceNode.y || 0) + (targetNode.y || 0)) / 2;
  const mz = ((sourceNode.z || 0) + (targetNode.z || 0)) / 2;

  for (let i = 0; i < 5; i++) {
    const pGeo = new THREE.SphereGeometry(0.4, 4, 4);
    const pMat = new THREE.MeshBasicMaterial({
      color: sparkColor, transparent: true, opacity: 0.8, depthWrite: false,
    });
    const p = new THREE.Mesh(pGeo, pMat);
    p.position.set(mx, my, mz);
    graph.scene().add(p);

    eventSprites.push({
      mesh: p, birth: performance.now() / 1000 + 0.3, lifetime: 1.0,
      type: 'burst',
      velocity: {
        x: (Math.random() - 0.5) * 15,
        y: (Math.random() - 0.5) * 15,
        z: (Math.random() - 0.5) * 15,
      },
    });
  }

  // Prune oldest
  while (eventSprites.length > EVENT_SPRITE_MAX) {
    const old = eventSprites.shift();
    graph.scene().remove(old.mesh);
    old.mesh.geometry.dispose();
    old.mesh.material.dispose();
  }
}

// Update event sprites each frame (bd-9qeto)
function updateEventSprites(t) {
  for (let i = eventSprites.length - 1; i >= 0; i--) {
    const s = eventSprites[i];
    const age = t - s.birth;

    // Not born yet (staggered spawns)
    if (age < 0) continue;

    if (age > s.lifetime) {
      graph.scene().remove(s.mesh);
      s.mesh.geometry.dispose();
      s.mesh.material.dispose();
      eventSprites.splice(i, 1);
      continue;
    }

    const progress = age / s.lifetime; // 0→1

    if (s.type === 'status-pulse') {
      // Expanding ring that fades out
      const scale = s.startScale + (s.endScale - s.startScale) * progress;
      s.mesh.scale.setScalar(scale);
      s.mesh.material.opacity = (1 - progress) * 0.7;
      // Follow node position
      if (s.node) {
        s.mesh.position.set(s.node.x || 0, s.node.y || 0, s.node.z || 0);
        s.mesh.lookAt(graph.camera().position);
      }
    } else if (s.type === 'edge-spark') {
      // Interpolate from source to target with slight jitter
      const sx = s.sourceNode.x || 0, sy = s.sourceNode.y || 0, sz = s.sourceNode.z || 0;
      const tx = s.targetNode.x || 0, ty = s.targetNode.y || 0, tz = s.targetNode.z || 0;
      const wobble = Math.sin(progress * Math.PI * 3) * (1 - progress);
      s.mesh.position.set(
        sx + (tx - sx) * progress + s.jitter.x * wobble,
        sy + (ty - sy) * progress + s.jitter.y * wobble,
        sz + (tz - sz) * progress + s.jitter.z * wobble,
      );
      // Shrink and fade near the end
      const sparkScale = 1 - progress * 0.7;
      s.mesh.scale.setScalar(sparkScale);
      s.mesh.material.opacity = (1 - progress * progress) * 0.9;
    } else if (s.type === 'burst') {
      // Outward burst particles with gravity-like deceleration
      const decel = 1 - progress * 0.8; // slow down over time
      s.mesh.position.x += s.velocity.x * 0.016 * decel;
      s.mesh.position.y += s.velocity.y * 0.016 * decel;
      s.mesh.position.z += s.velocity.z * 0.016 * decel;
      s.mesh.material.opacity = (1 - progress) * 0.8;
      s.mesh.scale.setScalar(1 - progress * 0.5);
    }
  }
}

// --- Minimap ---
const minimapCanvas = document.getElementById('minimap');
const minimapCtx = minimapCanvas.getContext('2d');
const minimapLabel = document.getElementById('minimap-label');

function renderMinimap() {
  if (!minimapVisible || !graph || graphData.nodes.length === 0) return;

  const w = minimapCanvas.width;
  const h = minimapCanvas.height;
  const ctx = minimapCtx;

  ctx.clearRect(0, 0, w, h);

  // Background
  ctx.fillStyle = 'rgba(10, 10, 20, 0.6)';
  ctx.fillRect(0, 0, w, h);

  // Compute bounding box of all visible nodes (top-down: X, Z)
  let minX = Infinity, maxX = -Infinity;
  let minZ = Infinity, maxZ = -Infinity;
  const visibleNodes = graphData.nodes.filter(n => !n._hidden && n.x !== undefined);

  for (const n of visibleNodes) {
    if (n.x < minX) minX = n.x;
    if (n.x > maxX) maxX = n.x;
    if ((n.z || 0) < minZ) minZ = n.z || 0;
    if ((n.z || 0) > maxZ) maxZ = n.z || 0;
  }

  if (!isFinite(minX)) return; // no positioned nodes

  // Add padding
  const pad = 40;
  const rangeX = (maxX - minX) || 1;
  const rangeZ = (maxZ - minZ) || 1;
  const scale = Math.min((w - pad * 2) / rangeX, (h - pad * 2) / rangeZ);

  // Map world coords to minimap coords
  const toMiniX = (wx) => pad + (wx - minX) * scale;
  const toMiniY = (wz) => pad + (wz - minZ) * scale;

  // Store mapping for click-to-teleport
  minimapCanvas._mapState = { minX, minZ, scale, pad };

  // Draw links (thin lines)
  ctx.globalAlpha = 0.15;
  ctx.lineWidth = 0.5;
  for (const l of graphData.links) {
    const src = typeof l.source === 'object' ? l.source : null;
    const tgt = typeof l.target === 'object' ? l.target : null;
    if (!src || !tgt || src._hidden || tgt._hidden) continue;
    if (src.x === undefined || tgt.x === undefined) continue;

    ctx.strokeStyle = l.dep_type === 'blocks' ? '#d04040' : '#2a2a3a';
    ctx.beginPath();
    ctx.moveTo(toMiniX(src.x), toMiniY(src.z || 0));
    ctx.lineTo(toMiniX(tgt.x), toMiniY(tgt.z || 0));
    ctx.stroke();
  }
  ctx.globalAlpha = 1;

  // Draw nodes (dots)
  for (const n of visibleNodes) {
    const mx = toMiniX(n.x);
    const my = toMiniY(n.z || 0);
    const r = n.issue_type === 'epic' ? 3 : (n._blocked ? 2.5 : 1.5);
    const color = nodeColor(n);

    ctx.fillStyle = color;
    ctx.globalAlpha = highlightNodes.size > 0 ? (highlightNodes.has(n.id) ? 1 : 0.2) : 0.8;
    ctx.beginPath();
    ctx.arc(mx, my, r, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;

  // Draw selected node marker
  if (selectedNode && selectedNode.x !== undefined) {
    const sx = toMiniX(selectedNode.x);
    const sy = toMiniY(selectedNode.z || 0);
    ctx.strokeStyle = '#4a9eff';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(sx, sy, 6, 0, Math.PI * 2);
    ctx.stroke();
  }

  // Draw camera viewport indicator (frustum projected to XZ plane)
  const camera = graph.camera();
  const camPos = camera.position;
  // Camera footprint: show camera position as a small diamond
  const cx = toMiniX(camPos.x);
  const cy = toMiniY(camPos.z);
  ctx.strokeStyle = '#4a9eff';
  ctx.lineWidth = 1;
  ctx.globalAlpha = 0.6;

  // Viewport rectangle (approximate based on camera height and FOV)
  const fovRad = (camera.fov / 2) * Math.PI / 180;
  const camHeight = Math.abs(camPos.y) || 200;
  const halfW = Math.tan(fovRad) * camHeight * camera.aspect;
  const halfH = Math.tan(fovRad) * camHeight;
  const vw = halfW * scale;
  const vh = halfH * scale;

  ctx.strokeRect(cx - vw, cy - vh, vw * 2, vh * 2);

  // Camera dot
  ctx.fillStyle = '#4a9eff';
  ctx.globalAlpha = 0.8;
  ctx.beginPath();
  ctx.arc(cx, cy, 2, 0, Math.PI * 2);
  ctx.fill();

  ctx.globalAlpha = 1;
}

// Click on minimap → teleport camera
minimapCanvas.addEventListener('click', (e) => {
  const rect = minimapCanvas.getBoundingClientRect();
  const scaleX = minimapCanvas.width / rect.width;
  const scaleY = minimapCanvas.height / rect.height;
  const mx = (e.clientX - rect.left) * scaleX;
  const my = (e.clientY - rect.top) * scaleY;

  const state = minimapCanvas._mapState;
  if (!state) return;

  // Convert minimap coords back to world XZ
  const wx = (mx - state.pad) / state.scale + state.minX;
  const wz = (my - state.pad) / state.scale + state.minZ;

  // Keep current camera height (Y), move to clicked world position
  const camY = graph.camera().position.y || 200;
  graph.cameraPosition(
    { x: wx, y: camY, z: wz + camY * 0.3 }, // offset Z slightly to look down
    { x: wx, y: 0, z: wz },
    600
  );
});

function toggleMinimap() {
  minimapVisible = !minimapVisible;
  minimapCanvas.style.display = minimapVisible ? 'block' : 'none';
  minimapLabel.style.display = minimapVisible ? 'block' : 'none';
}

// --- Persistent node labels (bd-1o2f7) ---
// Creates a THREE.Sprite with canvas-rendered text showing bead info.
// Positioned above the node, billboard-aligned to camera.
function createNodeLabelSprite(node) {
  const pLabel = ['P0', 'P1', 'P2', 'P3', 'P4'][node.priority] || '';
  const title = (node.title || node.id).slice(0, 40) + ((node.title || node.id).length > 40 ? '...' : '');
  const line1 = node.id;
  const line2 = title;
  const line3 = `${node.status || ''}${node.assignee ? ' · ' + node.assignee : ''} · ${pLabel}`;

  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  const fontSize = 28;
  const lineHeight = fontSize * 1.3;
  const padding = 14;

  ctx.font = `bold ${fontSize}px "SF Mono", "Fira Code", monospace`;
  const w1 = ctx.measureText(line1).width;
  ctx.font = `${fontSize}px "SF Mono", "Fira Code", monospace`;
  const w2 = ctx.measureText(line2).width;
  const w3 = ctx.measureText(line3).width;
  const textW = Math.max(w1, w2, w3);

  canvas.width = Math.ceil(textW + padding * 2);
  canvas.height = Math.ceil(lineHeight * 3 + padding * 2);

  // Background with rounded corners
  ctx.fillStyle = 'rgba(10, 10, 18, 0.85)';
  const r = 6, cw = canvas.width, ch = canvas.height;
  ctx.beginPath();
  ctx.moveTo(r, 0);
  ctx.lineTo(cw - r, 0); ctx.arcTo(cw, 0, cw, r, r);
  ctx.lineTo(cw, ch - r); ctx.arcTo(cw, ch, cw - r, ch, r);
  ctx.lineTo(r, ch); ctx.arcTo(0, ch, 0, ch - r, r);
  ctx.lineTo(0, r); ctx.arcTo(0, 0, r, 0, r);
  ctx.closePath();
  ctx.fill();

  // Border
  ctx.strokeStyle = 'rgba(74, 158, 255, 0.3)';
  ctx.lineWidth = 1;
  ctx.stroke();

  // Line 1: ID (bold, blue)
  ctx.font = `bold ${fontSize}px "SF Mono", "Fira Code", monospace`;
  ctx.fillStyle = '#4a9eff';
  ctx.fillText(line1, padding, padding + fontSize);

  // Line 2: title (white)
  ctx.font = `${fontSize}px "SF Mono", "Fira Code", monospace`;
  ctx.fillStyle = '#e0e0e0';
  ctx.fillText(line2, padding, padding + fontSize + lineHeight);

  // Line 3: status · assignee · priority (dim)
  ctx.fillStyle = '#888';
  ctx.fillText(line3, padding, padding + fontSize + lineHeight * 2);

  const texture = new THREE.CanvasTexture(canvas);
  texture.minFilter = THREE.LinearFilter;
  const material = new THREE.SpriteMaterial({
    map: texture,
    transparent: true,
    depthWrite: false,
    depthTest: false,
    sizeAttenuation: false,  // flat screen-space labels — no perspective zoom
  });
  const sprite = new THREE.Sprite(material);

  // Scale in screen pixels (sizeAttenuation=false) — constant size regardless of zoom
  const aspect = canvas.width / canvas.height;
  const spriteH = 0.06;  // fraction of viewport height (~60px on 1000px screen)
  sprite.scale.set(spriteH * aspect, spriteH, 1);

  // Position above the node
  const size = nodeSize(node);
  sprite.position.y = size * 2.5 + spriteH / 2 + 2;

  sprite.userData.nodeLabel = true;
  sprite.userData.baseLabelY = sprite.position.y; // base Y for anti-overlap reset (beads-rgmh)
  sprite.visible = labelsVisible;
  return sprite;
}

function toggleLabels() {
  labelsVisible = !labelsVisible;
  // Immediately run LOD pass to show/hide correct labels (beads-bu3r)
  resolveOverlappingLabels();
  const btn = document.getElementById('btn-labels');
  if (btn) btn.classList.toggle('active', labelsVisible);
}

// --- Label anti-overlap with LOD (beads-rgmh, beads-bu3r) ---
// Priority-based level-of-detail: only the top N labels are visible, where N
// scales with zoom level.  Visible labels get multi-pass screen-space repulsion
// to resolve overlaps.  Lower-priority visible labels fade to reduced opacity.
function resolveOverlappingLabels() {
  if (!graph) return;
  const camera = graph.camera();
  const renderer = graph.renderer();
  if (!camera || !renderer) return;

  const width = renderer.domElement.clientWidth;
  const height = renderer.domElement.clientHeight;
  if (width === 0 || height === 0) return;

  // --- Phase 1: Collect all label sprites and compute priority scores ---
  const allLabels = [];
  for (const node of graphData.nodes) {
    const threeObj = node.__threeObj;
    if (!threeObj) continue;
    threeObj.traverse(child => {
      if (!child.userData.nodeLabel) return;
      // Reset to base position before computing new offsets
      if (child.userData.baseLabelY !== undefined) {
        child.position.y = child.userData.baseLabelY;
      }
      allLabels.push({ sprite: child, node });
    });
  }

  if (allLabels.length === 0) return;

  // Compute priority for each label
  for (const l of allLabels) {
    l.pri = _labelPriority(l);
  }

  // --- Phase 2: LOD — determine how many labels to show (beads-bu3r) ---
  // Camera distance to scene center drives the label budget.
  // Close zoom: show many; far zoom: show fewer.
  const camPos = camera.position;
  const camDist = camPos.length(); // distance from origin
  // Budget: at distance 100 show ~40 labels, at 500 show ~12, at 1000 show ~6
  // Selected/multi-selected always shown (budget doesn't apply).
  // bd-lwut6: when a molecule is focused, increase budget to show all its labels.
  const BASE_BUDGET = 40;
  const moleculeBudgetBoost = focusedMoleculeNodes.size > 0 ? focusedMoleculeNodes.size : 0;
  const labelBudget = Math.max(6, Math.round(BASE_BUDGET * (100 / Math.max(camDist, 50)))) + moleculeBudgetBoost;

  // Sort by priority descending — highest priority labels shown first
  allLabels.sort((a, b) => b.pri - a.pri);

  // Always-show: selected, multi-selected, and agents with in_progress tasks
  let budgetUsed = 0;
  for (const l of allLabels) {
    const isForced = l.pri >= 500; // selected or multi-selected
    if (isForced) {
      l.show = true;
    } else if (budgetUsed < labelBudget) {
      l.show = true;
      budgetUsed++;
    } else {
      l.show = false;
    }
  }

  // Apply visibility — hide labels that didn't make the budget
  for (const l of allLabels) {
    if (!labelsVisible) {
      l.sprite.visible = false;
      continue;
    }
    l.sprite.visible = l.show;
    // Opacity fade: top labels get full opacity, lower ones fade (beads-bu3r)
    if (l.show && l.sprite.material) {
      const rank = allLabels.indexOf(l);
      const fadeStart = Math.max(6, labelBudget * 0.6);
      if (rank < fadeStart || l.pri >= 500) {
        l.sprite.material.opacity = 1.0;
      } else {
        // Fade from 1.0 down to 0.35 for the lowest-ranked visible labels
        const fadeRange = Math.max(1, labelBudget - fadeStart);
        const t = Math.min(1, (rank - fadeStart) / fadeRange);
        l.sprite.material.opacity = 1.0 - t * 0.65;
      }
    }
  }

  // --- Phase 3: Project visible labels to screen space ---
  const visibleLabels = [];
  for (const l of allLabels) {
    if (!l.show || !labelsVisible) continue;
    const worldPos = new THREE.Vector3();
    l.sprite.getWorldPosition(worldPos);
    const ndc = worldPos.clone().project(camera);
    if (ndc.z > 1) continue; // behind camera
    const sx = (ndc.x * 0.5 + 0.5) * width;
    const sy = (-ndc.y * 0.5 + 0.5) * height;
    const lw = l.sprite.scale.x * height;
    const lh = l.sprite.scale.y * height;
    visibleLabels.push({ ...l, sx, sy, lw, lh, offsetY: 0 });
  }

  if (visibleLabels.length < 2) return;

  // --- Phase 4: Multi-pass overlap resolution (beads-bu3r, bd-5rwn3) ---
  // Run up to 8 passes of pairwise repulsion. Higher-priority labels hold
  // position; lower-priority labels are pushed away from the overlap.
  // Direction is determined by relative screen-Y: if the lower-priority
  // label's center is below (or equal), push it down; otherwise push up.
  // This prevents labels from piling in one direction.
  const PADDING = 10;
  const MAX_OFFSET = height * 0.15; // don't push labels off-screen
  for (let pass = 0; pass < 8; pass++) {
    // Sort by screen X for sweep-and-prune
    visibleLabels.sort((a, b) => a.sx - b.sx);
    let anyMoved = false;

    for (let i = 0; i < visibleLabels.length; i++) {
      const a = visibleLabels[i];
      const aRight = a.sx + a.lw / 2;

      for (let j = i + 1; j < visibleLabels.length; j++) {
        const b = visibleLabels[j];
        const bLeft = b.sx - b.lw / 2;
        if (bLeft > aRight + PADDING) break;

        const aCy = a.sy + a.offsetY;
        const bCy = b.sy + b.offsetY;
        const aTop = aCy - a.lh / 2;
        const aBot = aCy + a.lh / 2;
        const bTop = bCy - b.lh / 2;
        const bBot = bCy + b.lh / 2;

        if (aTop > bBot + PADDING || bTop > aBot + PADDING) continue;

        // Full separation needed to clear the overlap + padding
        const overlapY = Math.min(aBot, bBot) - Math.max(aTop, bTop) + PADDING;
        // Push the lower-priority label away from the higher-priority one
        if (a.pri >= b.pri) {
          // Push b away from a: if b is below or same, push down; else up
          const dir = bCy >= aCy ? 1 : -1;
          b.offsetY += overlapY * dir;
          if (Math.abs(b.offsetY) > MAX_OFFSET) b.offsetY = MAX_OFFSET * Math.sign(b.offsetY);
        } else {
          const dir = aCy >= bCy ? 1 : -1;
          a.offsetY += overlapY * dir;
          if (Math.abs(a.offsetY) > MAX_OFFSET) a.offsetY = MAX_OFFSET * Math.sign(a.offsetY);
        }
        anyMoved = true;
      }
    }
    // Early exit if no overlaps remain
    if (!anyMoved) break;
  }

  // Apply offsets back to sprite world positions (bd-5rwn3).
  // Since sizeAttenuation=false, sprite.scale is in viewport fractions but
  // sprite.position is in the parent group's world space. We must convert
  // screen-pixel offsets to world-space Y offsets using the camera projection.
  for (const l of visibleLabels) {
    if (l.offsetY === 0) continue;
    // Compute world-to-screen Y scale at this sprite's depth
    const worldPos = new THREE.Vector3();
    l.sprite.getWorldPosition(worldPos);
    const camDist = camera.position.distanceTo(worldPos);
    // For perspective camera: world units per pixel = 2 * dist * tan(fov/2) / height
    const fovRad = camera.fov * Math.PI / 180;
    const worldPerPx = 2 * camDist * Math.tan(fovRad / 2) / height;
    l.sprite.position.y -= l.offsetY * worldPerPx; // screen Y is inverted vs world Y
  }
}

function _labelPriority(label) {
  const n = label.node;
  // Higher = wins position contest (stays in place) and survives LOD culling
  let pri = 0;
  if (selectedNode && n.id === selectedNode.id) pri += 1000;
  if (multiSelected.has(n.id)) pri += 500;
  // bd-lwut6: boost labels in focused molecule — always show at full opacity
  if (focusedMoleculeNodes.has(n.id)) pri += 500;
  if (n.issue_type === 'agent') pri += 100;
  // In-progress beads are more important than open/closed
  if (n.status === 'in_progress') pri += 50;
  // Lower priority number = more important
  pri += (4 - (n.priority || 2)) * 10;
  return pri;
}

// --- Build graph ---
function initGraph() {
  graph = ForceGraph3D({ rendererConfig: { preserveDrawingBuffer: true } })(document.getElementById('graph'))
    .backgroundColor('#0a0a0f')
    .showNavInfo(false)

    // Custom node rendering — organic vacuole look (shared geometries for perf)
    .nodeThreeObject(n => {
      if (n._hidden) return new THREE.Group();

      // Revealed-but-filtered nodes render as ghosts — reduced opacity (hq-vorf47)
      const isGhost = !!n._revealed;
      const ghostFade = isGhost ? 0.4 : 1.0;

      const size = nodeSize(n);
      const hexColor = colorToHex(nodeColor(n));
      const group = new THREE.Group();

      // Materia orb core — FFVII-style inner glow (bd-c7d5z, replaces MeshBasicMaterial)
      const breathSpeed = n.status === 'in_progress' ? 2.0 : (n.status === 'blocked' ? 0.5 : 0.0);
      const coreIntensity = n.status === 'closed' ? 0.5 : (n.status === 'in_progress' ? 1.8 : 1.4);
      const coreOpacity = n.status === 'closed' ? 0.4 : 0.85;
      const core = new THREE.Mesh(GEO.sphereHi, createMateriaMaterial(hexColor, {
        opacity: coreOpacity * ghostFade,
        coreIntensity,
        breathSpeed,
      }));
      core.scale.setScalar(size);
      group.add(core);

      // Materia halo sprite — soft radial gradient billboard (bd-c7d5z, replaces Fresnel shell)
      if (!_materiaHaloTex) _materiaHaloTex = createMateriaHaloTexture(64);
      const halo = new THREE.Sprite(new THREE.SpriteMaterial({
        map: _materiaHaloTex,
        color: hexColor,
        transparent: true,
        opacity: 0.2 * ghostFade,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }));
      halo.scale.setScalar(size * 3.0);
      group.add(halo);

      // Agent: retro lunar lander — cute spaceship with landing legs (beads-yp2y)
      if (n.issue_type === 'agent') {
        group.remove(core);
        group.remove(halo);
        const s = size;
        const matOrange = new THREE.MeshBasicMaterial({ color: 0xff6b35, transparent: true, opacity: 0.85 });
        const matDark = new THREE.MeshBasicMaterial({ color: 0x2a2a3a, transparent: true, opacity: 0.9 });
        const matGold = new THREE.MeshBasicMaterial({ color: 0xd4a017, transparent: true, opacity: 0.7 });

        // Cabin — squat octahedron (angular Apollo LM shape)
        const cabin = new THREE.Mesh(GEO.octa, matOrange.clone());
        cabin.scale.set(s * 1.0, s * 0.7, s * 1.0);
        group.add(cabin);

        // Viewport window — small sphere on front face
        const window = new THREE.Mesh(GEO.sphereHi, new THREE.MeshBasicMaterial({
          color: 0x88ccff, transparent: true, opacity: 0.8,
        }));
        window.scale.setScalar(s * 0.25);
        window.position.set(0, s * 0.15, s * 0.55);
        group.add(window);

        // Descent stage — wider box below cabin
        const descent = new THREE.Mesh(GEO.box, matGold.clone());
        descent.scale.set(s * 1.4, s * 0.35, s * 1.4);
        descent.position.y = -s * 0.55;
        group.add(descent);

        // Thruster nozzle — cone below descent stage
        const nozzleGeo = new THREE.ConeGeometry(0.3, 0.5, 6);
        const nozzle = new THREE.Mesh(nozzleGeo, matDark.clone());
        nozzle.scale.setScalar(s);
        nozzle.position.y = -s * 1.0;
        nozzle.rotation.x = Math.PI; // point down
        group.add(nozzle);

        // Landing legs — 4 angled cylinders
        const legGeo = new THREE.CylinderGeometry(0.04, 0.04, 1, 4);
        const padGeo = new THREE.SphereGeometry(0.12, 4, 4);
        for (let i = 0; i < 4; i++) {
          const angle = (i / 4) * Math.PI * 2 + Math.PI / 4;
          const leg = new THREE.Mesh(legGeo, matOrange.clone());
          leg.scale.setScalar(s);
          leg.scale.y = s * 1.2;
          leg.position.set(Math.cos(angle) * s * 0.7, -s * 0.9, Math.sin(angle) * s * 0.7);
          leg.rotation.z = Math.cos(angle) * 0.4;
          leg.rotation.x = -Math.sin(angle) * 0.4;
          group.add(leg);
          // Landing pad at foot
          const pad = new THREE.Mesh(padGeo, matGold.clone());
          pad.scale.setScalar(s);
          pad.position.set(Math.cos(angle) * s * 1.1, -s * 1.5, Math.sin(angle) * s * 1.1);
          group.add(pad);
        }

        // Antenna — thin cylinder on top
        const antennaGeo = new THREE.CylinderGeometry(0.02, 0.02, 1, 3);
        const antenna = new THREE.Mesh(antennaGeo, matOrange.clone());
        antenna.scale.setScalar(s);
        antenna.scale.y = s * 0.8;
        antenna.position.y = s * 0.8;
        group.add(antenna);
        // Antenna tip
        const tip = new THREE.Mesh(GEO.sphereHi, matOrange.clone());
        tip.scale.setScalar(s * 0.1);
        tip.position.y = s * 1.3;
        group.add(tip);

        // Outer glow — orange fresnel shell (bd-s9b4v: subtler, tighter)
        const agentGlow = new THREE.Mesh(GEO.sphereLo, createFresnelMaterial(0xff6b35, { opacity: 0.12, power: 3.5 }));
        agentGlow.scale.setScalar(size * 1.3);
        agentGlow.userData.agentGlow = true;
        agentGlow.userData.baseScale = size * 1.5;
        group.add(agentGlow);

        // Wake trail — elongated sprite behind agent's direction of travel (beads-v0wa)
        const trailMat = new THREE.SpriteMaterial({
          color: 0xff6b35, transparent: true, opacity: 0.0, // starts invisible
        });
        const trail = new THREE.Sprite(trailMat);
        trail.scale.set(size * 0.4, size * 3, 1);
        trail.userData.agentTrail = true;
        trail.userData.prevPos = { x: 0, y: 0, z: 0 };
        group.add(trail);

        // Rig badge — colored label below landing pads (bd-90ikf)
        if (n.rig) {
          const rc = rigColor(n.rig);
          const rigSprite = makeTextSprite(n.rig, {
            fontSize: 18, color: rc,
            background: 'rgba(8, 8, 16, 0.85)',
            sizeAttenuation: false, screenHeight: 0.025,
          });
          rigSprite.position.y = -size * 2.2;
          rigSprite.renderOrder = 999;
          rigSprite.userData.rigBadge = true;
          group.add(rigSprite);
        }
      }

      // Epic: wireframe organelle membrane
      if (n.issue_type === 'epic') {
        const shell = new THREE.Mesh(GEO.icosa, new THREE.MeshBasicMaterial({
          color: 0x8b45a6, transparent: true, opacity: 0.15, wireframe: true,
        }));
        shell.scale.setScalar(size * 2);
        group.add(shell);
      }

      // Decision/gate: diamond shape with "?" marker, only pending visible (bd-zr374)
      if (n.issue_type === 'gate' || n.issue_type === 'decision') {
        // Replace sphere core with elongated octahedron (diamond)
        group.remove(core);
        const diamond = new THREE.Mesh(GEO.octa, new THREE.MeshBasicMaterial({
          color: hexColor, transparent: true, opacity: 0.9 * ghostFade,
        }));
        diamond.scale.set(size * 0.8, size * 1.4, size * 0.8); // tall diamond
        group.add(diamond);

        // "?" question mark above node — screen-space for readability
        const qSprite = makeTextSprite('?', {
          fontSize: 32, color: '#d4a017', opacity: 0.95 * ghostFade,
          background: 'rgba(10, 10, 18, 0.85)',
          sizeAttenuation: false, screenHeight: 0.04,
        });
        qSprite.position.y = size * 2.5;
        qSprite.renderOrder = 998;
        group.add(qSprite);

        // Pulsing glow wireframe for pending decisions
        const pulseGlow = new THREE.Mesh(GEO.octa, new THREE.MeshBasicMaterial({
          color: 0xd4a017, transparent: true, opacity: 0.25 * ghostFade, wireframe: true,
        }));
        pulseGlow.scale.set(size * 1.2, size * 2.0, size * 1.2);
        pulseGlow.userData.decisionPulse = true;
        group.add(pulseGlow);
      }

      // Blocked: spiky octahedron
      if (n._blocked) {
        const spike = new THREE.Mesh(GEO.octa, new THREE.MeshBasicMaterial({
          color: 0xd04040, transparent: true, opacity: 0.2, wireframe: true,
        }));
        spike.scale.setScalar(size * 2.4);
        group.add(spike);
      }

      // Pending decision badge — small amber dot with count (bd-o6tgy)
      if (n._pendingDecisions > 0 && n.issue_type !== 'gate' && n.issue_type !== 'decision') {
        const badge = new THREE.Mesh(GEO.sphereHi, new THREE.MeshBasicMaterial({
          color: 0xd4a017, transparent: true, opacity: 0.9,
        }));
        badge.scale.setScalar(Math.min(3 + n._pendingDecisions, 6));
        badge.position.set(size * 1.2, size * 1.2, 0); // top-right offset
        badge.userData.decisionBadge = true;
        group.add(badge);
      }

      // Commit count badge — small number below-left of node (bd-90ikf)
      // Lights up when backend adds commit_count field to GraphNode
      if (n.commit_count > 0 && n.issue_type !== 'agent') {
        const ccSprite = makeTextSprite(`${n.commit_count}`, {
          fontSize: 16, color: '#a0d050',
          background: 'rgba(8, 8, 16, 0.85)',
          sizeAttenuation: false, screenHeight: 0.02,
        });
        ccSprite.position.set(-size * 1.2, -size * 1.2, 0); // bottom-left
        ccSprite.renderOrder = 998;
        ccSprite.userData.commitBadge = true;
        group.add(ccSprite);
      }

      // Selection glow — materia intensification instead of orbiting ring (bd-c7d5z)
      // The core materia material has a `selected` uniform (0=off, 1=on)
      // Updated in animation loop to boost glow when selected
      core.userData.materiaCore = true;

      // Persistent info label sprite (bd-1o2f7) — hidden until 'l' toggles labels on
      const labelSprite = createNodeLabelSprite(n);
      group.add(labelSprite);

      return group;
    })
    .nodeLabel(() => '')
    .nodeVisibility(n => !n._hidden)

    // Link rendering — width responds to selection state
    .linkColor(l => linkColor(l))
    .linkOpacity(0.55)
    .linkWidth(l => {
      if (selectedNode) {
        const lk = linkKey(l);
        return highlightLinks.has(lk) ? (l.dep_type === 'blocks' ? 2.0 : 1.2) : 0.15;
      }
      if (l.dep_type === 'rig_conflict') return 2.5; // thick red conflict edge (bd-90ikf)
      // Thinner assignment edges to reduce visual clutter in dense graphs (bd-ld2fa)
      return l.dep_type === 'blocks' ? 1.2 : l.dep_type === 'assigned_to' ? 0.6 : 0.5;
    })
    .linkDirectionalArrowLength(5)
    .linkDirectionalArrowRelPos(1)
    .linkDirectionalArrowColor(l => linkColor(l))
    .linkVisibility(l => {
      const src = typeof l.source === 'object' ? l.source : graphData.nodes.find(n => n.id === l.source);
      const tgt = typeof l.target === 'object' ? l.target : graphData.nodes.find(n => n.id === l.target);
      return src && tgt && !src._hidden && !tgt._hidden;
    })

    // Link icons — sprite at midpoint showing dep type (shield=blocks, clock=waits, chain=parent)
    .linkThreeObjectExtend(true)
    .linkThreeObject(l => {
      const baseMat = LINK_ICON_MATERIALS[l.dep_type] || LINK_ICON_DEFAULT;
      const sprite = new THREE.Sprite(baseMat.clone());
      sprite.scale.setScalar(LINK_ICON_SCALE);

      if (l.dep_type === 'assigned_to') {
        // Agent link: icon sprite + pulsing glow tube (beads-v0wa)
        const group = new THREE.Group();
        group.userData.isAgentLink = true;
        group.add(sprite);
        const tubeMat = new THREE.MeshBasicMaterial({
          color: 0xff6b35, transparent: true, opacity: 0.12,
        });
        const tube = new THREE.Mesh(new THREE.CylinderGeometry(0.6, 0.6, 1, 6, 1, true), tubeMat);
        tube.userData.isGlowTube = true;
        group.add(tube);
        return group;
      }
      return sprite;
    })
    .linkPositionUpdate((obj, { start, end }, l) => {
      const mid = {
        x: (start.x + end.x) / 2,
        y: (start.y + end.y) / 2,
        z: (start.z + end.z) / 2,
      };
      if (obj && obj.userData.isAgentLink) {
        // Agent link group: icon at midpoint, glow tube stretched between endpoints
        const t = (performance.now() - startTime) / 1000;
        const dimTarget = selectedNode ? (highlightLinks.has(linkKey(l)) ? 1.0 : 0.08) : 1.0;
        for (const child of obj.children) {
          if (child.isSprite) {
            child.position.set(mid.x, mid.y, mid.z);
            child.material.opacity = 0.85 * dimTarget;
          } else if (child.userData.isGlowTube) {
            child.position.set(mid.x, mid.y, mid.z);
            const dx = end.x - start.x, dy = end.y - start.y, dz = end.z - start.z;
            const dist = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
            child.scale.set(1, dist, 1);
            child.lookAt(end.x, end.y, end.z);
            child.rotateX(Math.PI / 2);
            child.material.opacity = (0.08 + Math.sin(t * 3) * 0.06) * dimTarget;
          }
        }
      } else if (obj && obj.isSprite) {
        obj.position.set(mid.x, mid.y, mid.z);
        if (selectedNode) {
          obj.material.opacity = highlightLinks.has(linkKey(l)) ? 0.85 : 0.08;
        } else {
          obj.material.opacity = 0.85;
        }
      }
    })

    // Directional particles — blocking links + agent tethers (beads-1gx1)
    .linkDirectionalParticles(l => l.dep_type === 'blocks' ? 2 : l.dep_type === 'assigned_to' ? 3 : 0)
    .linkDirectionalParticleWidth(l => l.dep_type === 'assigned_to' ? 1.8 : 1.0)
    .linkDirectionalParticleSpeed(l => l.dep_type === 'assigned_to' ? 0.008 : 0.003)
    .linkDirectionalParticleColor(l => linkColor(l))

    // Interaction
    .onNodeHover(handleNodeHover)
    .onNodeClick(handleNodeClick)
    .onNodeRightClick(handleNodeRightClick)
    .onBackgroundClick(() => { clearSelection(); hideTooltip(); hideDetail(); hideContextMenu(); })
    // DAG dragging: dragged node pulls its subtree with spring physics (beads-6253)
    .onNodeDrag((node) => {
      if (!node || node._hidden) return;
      if (!node._dragSubtree) {
        node._dragSubtree = getDragSubtree(node.id);
      }
      // Apply velocity impulses to subtree proportional to drag delta
      // Agents get stronger, snappier coupling to their assigned beads (beads-mxhq)
      const isAgent = node.issue_type === 'agent';
      const subtree = node._dragSubtree;
      for (const { node: child, depth } of subtree) {
        if (child === node || child.fx !== undefined) continue;
        // Agents: stronger base pull (0.6 vs 0.3), slower decay (0.65 vs 0.5)
        const baseStrength = isAgent ? 0.6 : 0.3;
        const decay = isAgent ? 0.65 : 0.5;
        const strength = baseStrength * Math.pow(decay, depth - 1);
        const dx = node.x - child.x;
        const dy = node.y - child.y;
        const dz = (node.z || 0) - (child.z || 0);
        const dist = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
        const restDist = (isAgent ? 20 : 30) * depth;
        if (dist > restDist) {
          // Agents: higher impulse multiplier for snappy response
          const impulse = isAgent ? 0.12 : 0.05;
          child.vx = (child.vx || 0) + dx * strength * impulse;
          child.vy = (child.vy || 0) + dy * strength * impulse;
          child.vz = (child.vz || 0) + dz * strength * impulse;
        }
      }
    })
    .onNodeDragEnd((node) => {
      if (node) delete node._dragSubtree;
    });

  // Force tuning — applied by setLayout()
  const nodeCount = graphData.nodes.length || 100;

  // Warm up faster then cool (reduces CPU after initial layout)
  graph.cooldownTime(4000).warmupTicks(nodeCount > 200 ? 50 : 0);

  // Apply default layout forces
  setLayout('free');

  // Scene extras
  const scene = graph.scene();
  scene.fog = new THREE.FogExp2(0x0a0a0f, 0.0001);

  // Nucleus — wireframe icosahedron at center (codebase)
  const nucleusGeo = new THREE.IcosahedronGeometry(12, 2);
  const nucleusMat = new THREE.MeshBasicMaterial({
    color: 0x1a1a3e,
    transparent: true,
    opacity: 0.15,
    wireframe: true,
  });
  const nucleus = new THREE.Mesh(nucleusGeo, nucleusMat);
  nucleus.userData.isNucleus = true;
  scene.add(nucleus);

  // Cell membrane — faint outer boundary
  const membraneGeo = new THREE.IcosahedronGeometry(350, 3);
  const membraneMat = new THREE.MeshBasicMaterial({
    color: 0x1a2a3a,
    transparent: true,
    opacity: 0.02,
    wireframe: true,
  });
  scene.add(new THREE.Mesh(membraneGeo, membraneMat));

  scene.add(new THREE.AmbientLight(0x404060, 0.5));

  // Star field — subtle background particles for depth
  const stars = createStarField(1500, 500);
  scene.add(stars);

  // GPU particle pool for all VFX (bd-m9525)
  _particlePool = createParticlePool(2000);
  _particlePool.mesh.userData.isParticlePool = true;
  scene.add(_particlePool.mesh);

  // Extend camera draw distance
  const camera = graph.camera();
  camera.far = 50000;
  camera.updateProjectionMatrix();

  // Bloom post-processing
  bloomPass = new UnrealBloomPass(
    new THREE.Vector2(window.innerWidth, window.innerHeight),
    0.7,   // strength — subtle glow (bd-s9b4v: reduced from 1.2)
    0.4,   // radius — tighter spread (bd-s9b4v: reduced from 0.6)
    0.35   // threshold — higher so only bright nodes bloom (bd-s9b4v: raised from 0.2)
  );
  bloomPass.enabled = bloomEnabled;
  const composer = graph.postProcessingComposer();
  composer.addPass(bloomPass);

  // Handle window resize for bloom (bd-7n4g8: store ref for cleanup)
  if (_bloomResizeHandler) window.removeEventListener('resize', _bloomResizeHandler);
  _bloomResizeHandler = () => bloomPass.resolution.set(window.innerWidth, window.innerHeight);
  window.addEventListener('resize', _bloomResizeHandler);

  // CSS2D overlay renderer for HTML doots (bd-bwkdk)
  initCSS2DRenderer();

  // Start animation loop for pulsing effects
  startAnimation();

  return graph;
}

// --- Selection VFX (bd-m9525) ---
// Continuous particle effects for selected/hovered nodes.

// Update all selection-related VFX each frame.
function updateSelectionVFX(t) {
  const dt = 0.016; // ~60fps

  // 1. Hover glow warmup — gentle particle emission on hovered node
  if (_hoveredNode && _hoveredNode !== selectedNode) {
    _hoverGlowTimer += dt;
    if (_hoverGlowTimer > _vfxConfig.hoverRate) {
      _hoverGlowTimer = 0;
      const pos = { x: _hoveredNode.x || 0, y: _hoveredNode.y || 0, z: _hoveredNode.z || 0 };
      const size = nodeSize({ priority: _hoveredNode.priority, issue_type: _hoveredNode.issue_type });
      _particlePool.emit(pos, 0x4a9eff, 2, {
        velocity: [0, 0.5, 0],
        spread: size * 0.6,
        lifetime: _vfxConfig.particleLifetime * 0.75,
        size: _vfxConfig.hoverSize,
      });
    }
  }

  // 2. Selection orbit ring — particles orbiting the selected node
  if (selectedNode) {
    _selectionOrbitTimer += dt;
    if (_selectionOrbitTimer > _vfxConfig.orbitRate) {
      _selectionOrbitTimer = 0;
      const pos = { x: selectedNode.x || 0, y: selectedNode.y || 0, z: selectedNode.z || 0 };
      const size = nodeSize({ priority: selectedNode.priority, issue_type: selectedNode.issue_type });
      const radius = size * 1.8;
      const angle = t * _vfxConfig.orbitSpeed;
      // Emit at orbit position with tangential velocity
      const orbitPos = {
        x: pos.x + Math.cos(angle) * radius,
        y: pos.y + (Math.random() - 0.5) * size * 0.5,
        z: pos.z + Math.sin(angle) * radius,
      };
      _particlePool.emit(orbitPos, 0x4a9eff, 1, {
        velocity: [-Math.sin(angle) * 1.5, 0.3, Math.cos(angle) * 1.5],
        spread: 0.3,
        lifetime: _vfxConfig.particleLifetime,
        size: _vfxConfig.orbitSize,
      });
      // Second particle at opposite side
      const orbitPos2 = {
        x: pos.x + Math.cos(angle + Math.PI) * radius,
        y: pos.y + (Math.random() - 0.5) * size * 0.5,
        z: pos.z + Math.sin(angle + Math.PI) * radius,
      };
      _particlePool.emit(orbitPos2, 0x4a9eff, 1, {
        velocity: [-Math.sin(angle + Math.PI) * 1.5, 0.3, Math.cos(angle + Math.PI) * 1.5],
        spread: 0.3,
        lifetime: _vfxConfig.particleLifetime,
        size: _vfxConfig.orbitSize,
      });
    }
  }

  // 3. Dependency energy streams — particle flow along highlighted links
  if (selectedNode && highlightLinks.size > 0) {
    _energyStreamTimer += dt;
    if (_energyStreamTimer > _vfxConfig.streamRate) {
      _energyStreamTimer = 0;
      for (const l of graphData.links) {
        if (!highlightLinks.has(linkKey(l))) continue;
        const src = typeof l.source === 'object' ? l.source : graphData.nodes.find(n => n.id === l.source);
        const tgt = typeof l.target === 'object' ? l.target : graphData.nodes.find(n => n.id === l.target);
        if (!src || !tgt) continue;
        // Spawn particle at random point along the link
        const progress = Math.random();
        const pos = {
          x: (src.x || 0) + ((tgt.x || 0) - (src.x || 0)) * progress,
          y: (src.y || 0) + ((tgt.y || 0) - (src.y || 0)) * progress,
          z: (src.z || 0) + ((tgt.z || 0) - (src.z || 0)) * progress,
        };
        // Velocity towards target
        const dx = (tgt.x || 0) - (src.x || 0);
        const dy = (tgt.y || 0) - (src.y || 0);
        const dz = (tgt.z || 0) - (src.z || 0);
        const len = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
        const speed = _vfxConfig.streamSpeed;
        const linkColorHex = l.dep_type === 'blocks' ? 0xd04040 :
                             l.dep_type === 'assigned_to' ? 0xff6b35 : 0x4a9eff;
        _particlePool.emit(pos, linkColorHex, 1, {
          velocity: [dx / len * speed, dy / len * speed, dz / len * speed],
          spread: 0.5,
          lifetime: Math.min(len / (speed * 60), _vfxConfig.particleLifetime * 1.9),
          size: 1.0,
        });
      }
    }
  }

  // 4. Connected materia pulse — highlighted nodes pulse particles in unison
  if (selectedNode && highlightNodes.size > 1) {
    const pulseBeat = Math.sin(t * 3) > 0.95; // brief pulse every ~2 seconds
    if (pulseBeat && !updateSelectionVFX._lastPulse) {
      for (const nodeId of highlightNodes) {
        if (nodeId === selectedNode.id) continue;
        const node = graphData.nodes.find(n => n.id === nodeId);
        if (!node) continue;
        const pos = { x: node.x || 0, y: node.y || 0, z: node.z || 0 };
        const color = nodeColor(node);
        _particlePool.emit(pos, color, 4, {
          velocity: [0, 1.5, 0],
          spread: 2,
          lifetime: _vfxConfig.particleLifetime,
          size: _vfxConfig.orbitSize,
        });
      }
    }
    updateSelectionVFX._lastPulse = pulseBeat;
  }
}
updateSelectionVFX._lastPulse = false;

// Spawn selection burst — enhanced materia intensification on click (bd-m9525)
function spawnSelectionBurst(node) {
  if (!_particlePool || !node) return;
  const pos = { x: node.x || 0, y: node.y || 0, z: node.z || 0 };
  const size = nodeSize({ priority: node.priority, issue_type: node.issue_type });
  const color = nodeColor(node);

  // Inner materia burst — bright core particles
  _particlePool.emit(pos, 0xffffff, Math.round(6 * _vfxConfig.selectionGlow), {
    velocity: [0, 2, 0],
    spread: size * 0.3,
    lifetime: 0.5 * _vfxConfig.selectionGlow,
    size: 2.0 * _vfxConfig.selectionGlow,
  });

  // Outer colored burst — expanding ring of node-colored particles
  for (let i = 0; i < 12; i++) {
    const angle = (i / 12) * Math.PI * 2;
    const ringPos = {
      x: pos.x + Math.cos(angle) * size * 0.5,
      y: pos.y,
      z: pos.z + Math.sin(angle) * size * 0.5,
    };
    _particlePool.emit(ringPos, color, 1, {
      velocity: [Math.cos(angle) * 3, 0.5 + Math.random(), Math.sin(angle) * 3],
      spread: 0.2,
      lifetime: 1.0,
      size: 1.8,
    });
  }
}

// Camera fly-to particle trail (bd-m9525)
function spawnFlyToTrail(fromPos, toPos) {
  if (!_particlePool) return;
  // Spawn particles along the path between camera start and target
  const steps = 8;
  for (let i = 0; i < steps; i++) {
    const progress = i / steps;
    const pos = {
      x: fromPos.x + (toPos.x - fromPos.x) * progress,
      y: fromPos.y + (toPos.y - fromPos.y) * progress,
      z: fromPos.z + (toPos.z - fromPos.z) * progress,
    };
    // Delayed emission for trail effect
    setTimeout(() => {
      if (!_particlePool) return;
      _particlePool.emit(pos, 0x4a9eff, 3, {
        velocity: [0, 0.5, 0],
        spread: 2,
        lifetime: 1.2,
        size: 1.0,
      });
    }, progress * 400);
  }
}

// --- Selection logic ---

// Unique key for a link (handles both object and string source/target)
function linkKey(l) {
  const s = typeof l.source === 'object' ? l.source.id : l.source;
  const t = typeof l.target === 'object' ? l.target.id : l.target;
  return `${s}->${t}`;
}

// Select a node: highlight it and its entire connected component (beads-1sqr)
function selectNode(node, componentIds) {
  selectedNode = node;
  highlightNodes.clear();
  highlightLinks.clear();

  if (!node) return;

  // If a pre-computed connected component is provided, highlight the full subgraph.
  // Otherwise fall back to direct neighbors only (e.g. for keyboard navigation).
  const targetIds = componentIds || new Set([node.id]);
  if (!componentIds) {
    // Legacy: direct neighbors only
    for (const l of graphData.links) {
      const srcId = typeof l.source === 'object' ? l.source.id : l.source;
      const tgtId = typeof l.target === 'object' ? l.target.id : l.target;
      if (srcId === node.id || tgtId === node.id) {
        targetIds.add(srcId);
        targetIds.add(tgtId);
      }
    }
  }

  for (const id of targetIds) highlightNodes.add(id);

  // Highlight all links between nodes in the component
  for (const l of graphData.links) {
    const srcId = typeof l.source === 'object' ? l.source.id : l.source;
    const tgtId = typeof l.target === 'object' ? l.target.id : l.target;
    if (highlightNodes.has(srcId) && highlightNodes.has(tgtId)) {
      highlightLinks.add(linkKey(l));
    }
  }

  // Force link width recalculation
  graph.linkWidth(graph.linkWidth());

  // Materia selection burst VFX (bd-m9525)
  spawnSelectionBurst(node);

  // bd-nnr22: update left sidebar focused issue
  if (typeof updateLeftSidebarFocus === 'function') updateLeftSidebarFocus(node);
}

// Temporarily spread out highlighted subgraph nodes for readability (beads-k38a).
// Uses pairwise repulsion between component nodes (not just radial from centroid)
// so nearby nodes push apart in all directions.  Also applies a gentle centroid
// expansion to prevent the subgraph from collapsing inward.
let _spreadTimeout = null;
function spreadSubgraph(componentIds) {
  // Remove any previous spread force
  if (graph.d3Force('subgraphSpread')) {
    graph.d3Force('subgraphSpread', null);
  }
  if (_spreadTimeout) {
    clearTimeout(_spreadTimeout);
    _spreadTimeout = null;
  }

  if (!componentIds || componentIds.size < 2) return;

  // Collect component nodes for O(n²) pairwise check (n is small — typically < 20)
  const componentNodeList = graphData.nodes.filter(n => componentIds.has(n.id));
  const count = componentNodeList.length;
  if (count < 2) return;

  // Minimum pairwise distance — labels are ~80-120px wide at typical zoom.
  // At camera distance ~200 (zoomToNodes default for small clusters), 1 world unit ≈ 3-4px.
  // So 40 world units ≈ 120-160px — enough clearance for side-by-side labels.
  const MIN_PAIR_DIST = Math.max(40, count * 5);
  // Radial expansion: push nodes to at least this distance from centroid
  const MIN_RADIAL_DIST = Math.max(30, count * 6);

  graph.d3Force('subgraphSpread', (alpha) => {
    // Phase 1: Pairwise repulsion — push overlapping node pairs apart
    const strength = alpha * 0.15;
    for (let i = 0; i < componentNodeList.length; i++) {
      const a = componentNodeList[i];
      for (let j = i + 1; j < componentNodeList.length; j++) {
        const b = componentNodeList[j];
        let dx = (a.x || 0) - (b.x || 0);
        let dy = (a.y || 0) - (b.y || 0);
        let dz = (a.z || 0) - (b.z || 0);
        const dist = Math.sqrt(dx * dx + dy * dy + dz * dz) || 0.1;
        if (dist < MIN_PAIR_DIST) {
          // Inverse-distance force: stronger when closer
          const push = strength * (MIN_PAIR_DIST - dist) / dist;
          // Add small random jitter to break symmetry for overlapping nodes
          const jx = (Math.random() - 0.5) * 0.1;
          const jy = (Math.random() - 0.5) * 0.1;
          a.vx += (dx + jx) * push;
          a.vy += (dy + jy) * push;
          a.vz += dz * push;
          b.vx -= (dx + jx) * push;
          b.vy -= (dy + jy) * push;
          b.vz -= dz * push;
        }
      }
    }

    // Phase 2: Radial expansion from live centroid — prevents collapse
    let cx = 0, cy = 0, cz = 0;
    for (const n of componentNodeList) {
      cx += (n.x || 0); cy += (n.y || 0); cz += (n.z || 0);
    }
    cx /= count; cy /= count; cz /= count;

    const radialStrength = alpha * 0.08;
    for (const n of componentNodeList) {
      const dx = (n.x || 0) - cx;
      const dy = (n.y || 0) - cy;
      const dz = (n.z || 0) - cz;
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz) || 0.1;
      if (dist < MIN_RADIAL_DIST) {
        const push = radialStrength * (MIN_RADIAL_DIST - dist) / dist;
        n.vx += dx * push;
        n.vy += dy * push;
        n.vz += dz * push;
      }
    }
  });

  // Reheat simulation to apply the force
  graph.d3ReheatSimulation();

  // Remove the spread force after layout settles (3s — slightly longer for pairwise)
  _spreadTimeout = setTimeout(() => {
    graph.d3Force('subgraphSpread', null);
    _spreadTimeout = null;
  }, 3000);
}

function clearSelection() {
  selectedNode = null;
  highlightNodes.clear();
  highlightLinks.clear();
  multiSelected.clear();
  // Remove subgraph spread force (beads-k38a)
  if (graph.d3Force('subgraphSpread')) {
    graph.d3Force('subgraphSpread', null);
  }
  // Clear revealed subgraph and re-apply filters (hq-vorf47)
  if (revealedNodes.size > 0) {
    revealedNodes.clear();
    graphData.nodes.forEach(n => { n._revealed = false; });
    applyFilters();
  }
  // Clear molecule focus state (bd-lwut6)
  focusedMoleculeNodes.clear();
  hideBulkMenu();
  unfreezeCamera(); // bd-casin: restore orbit controls
  restoreAllNodeOpacity();
  updateBeadURL(null); // bd-he95o: clear URL deep-link on deselect
  // Force link width recalculation
  graph.linkWidth(graph.linkWidth());
  // bd-nnr22: clear left sidebar focused issue
  if (typeof updateLeftSidebarFocus === 'function') updateLeftSidebarFocus(null);
}

// --- URL deep-linking (bd-he95o) ---
// Focus on a bead specified via ?bead=<id> URL parameter.
// Selects the node, highlights its connected subgraph, flies camera to it,
// and opens the detail panel.
function focusDeepLinkBead(beadId) {
  const node = graphData.nodes.find(n => n.id === beadId);
  if (!node) {
    console.warn(`[beads3d] Deep-link bead "${beadId}" not found in graph`);
    return;
  }

  // Select and highlight the full connected component (beads-1sqr)
  const component = getConnectedComponent(node.id);
  selectNode(node, component);

  // Reveal the subgraph, spread for readability, and zoom to it
  revealedNodes.clear();
  for (const id of component) revealedNodes.add(id);
  applyFilters();

  spreadSubgraph(component); // beads-k38a: push nodes apart for readability
  zoomToNodes(component);

  // Show detail panel after camera starts moving
  setTimeout(() => showDetail(node), 500);

  // Update URL hash for shareability without triggering reload
  if (window.history.replaceState) {
    const url = new URL(window.location.href);
    url.searchParams.set('bead', beadId);
    window.history.replaceState(null, '', url.toString());
  }

  console.log(`[beads3d] Deep-linked to bead: ${beadId}`);
}

// --- Molecule focus view (bd-lwut6) ---
// Brings a molecule's connected subgraph into view with all labels readable.
// Triggered via ?molecule=<id> URL parameter or programmatically.
function focusMolecule(moleculeId) {
  const node = graphData.nodes.find(n => n.id === moleculeId);
  if (!node) {
    console.warn(`[beads3d] Molecule "${moleculeId}" not found in graph`);
    return;
  }

  // Find the full connected component
  const component = getConnectedComponent(node.id);

  // Store focused molecule nodes for label LOD override
  focusedMoleculeNodes = new Set(component);

  // Select and highlight the subgraph
  selectNode(node, component);

  // Reveal all nodes in the component (override filters)
  revealedNodes.clear();
  for (const id of component) revealedNodes.add(id);
  applyFilters();

  // Enable labels if not already visible
  if (!labelsVisible) {
    labelsVisible = true;
    const btn = document.getElementById('btn-labels');
    if (btn) btn.classList.toggle('active', true);
  }

  // Spread nodes apart for readability, then zoom to fit
  spreadSubgraph(component);
  zoomToNodes(component);

  // Show detail panel for the molecule node
  setTimeout(() => showDetail(node), 500);

  // Update URL for shareability
  if (window.history.replaceState) {
    const url = new URL(window.location.href);
    url.searchParams.set('molecule', moleculeId);
    url.searchParams.delete('bead');
    window.history.replaceState(null, '', url.toString());
  }

  console.log(`[beads3d] Molecule focus: ${moleculeId} (${component.size} nodes)`);
}

// --- Camera freeze / center on multi-select (bd-casin) ---

// Fly camera to center on the selected nodes + their immediate connections,
// then freeze orbit controls. Call unfreezeCamera() (Escape) to restore.
function centerCameraOnSelection() {
  if (multiSelected.size === 0) return;

  // Collect selected node IDs + their direct neighbors
  const relevantIds = new Set(multiSelected);
  for (const l of graphData.links) {
    const srcId = typeof l.source === 'object' ? l.source.id : l.source;
    const tgtId = typeof l.target === 'object' ? l.target.id : l.target;
    if (multiSelected.has(srcId) || multiSelected.has(tgtId)) {
      relevantIds.add(srcId);
      relevantIds.add(tgtId);
    }
  }

  // Calculate bounding-box center of relevant nodes
  let cx = 0, cy = 0, cz = 0, count = 0;
  for (const node of graphData.nodes) {
    if (!relevantIds.has(node.id)) continue;
    cx += (node.x || 0);
    cy += (node.y || 0);
    cz += (node.z || 0);
    count++;
  }
  if (count === 0) return;
  cx /= count; cy /= count; cz /= count;

  // Calculate radius (max distance from center) to set camera distance
  let maxDist = 0;
  for (const node of graphData.nodes) {
    if (!relevantIds.has(node.id)) continue;
    const dx = (node.x || 0) - cx;
    const dy = (node.y || 0) - cy;
    const dz = (node.z || 0) - cz;
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (d > maxDist) maxDist = d;
  }

  // Camera distance: enough to see the whole cluster with some padding
  const distance = Math.max(maxDist * 2.5, 120);
  const lookAt = { x: cx, y: cy, z: cz };
  // Position camera along the current camera direction, but at the right distance
  const cam = graph.camera();
  const dir = new THREE.Vector3(
    cam.position.x - cx, cam.position.y - cy, cam.position.z - cz
  ).normalize();
  const camPos = {
    x: cx + dir.x * distance,
    y: cy + dir.y * distance,
    z: cz + dir.z * distance,
  };

  graph.cameraPosition(camPos, lookAt, 1000);

  // Freeze orbit controls + pin all node positions after the fly animation
  cameraFrozen = true;
  setTimeout(() => {
    const controls = graph.controls();
    if (controls) controls.enabled = false;
    // Pin every node so forces don't drift them (bd-casin)
    for (const node of graphData.nodes) {
      node.fx = node.x;
      node.fy = node.y;
      node.fz = node.z;
    }
  }, 1050);
}

function unfreezeCamera() {
  if (!cameraFrozen) return;
  cameraFrozen = false;
  const controls = graph.controls();
  if (controls) controls.enabled = true;
  // Unpin all nodes so forces resume (bd-casin)
  for (const node of graphData.nodes) {
    node.fx = undefined;
    node.fy = undefined;
    node.fz = undefined;
  }
}

// --- Node opacity helpers ---

// Save the original opacity on a material (first time only)
function saveBaseOpacity(mat) {
  if (mat.uniforms && mat.uniforms.opacity) {
    if (mat._baseUniformOpacity === undefined) mat._baseUniformOpacity = mat.uniforms.opacity.value;
  } else if (!mat.uniforms) {
    if (mat._baseOpacity === undefined) mat._baseOpacity = mat.opacity;
  }
}

// Set material opacity to base * factor
function setMaterialDim(mat, factor) {
  if (mat.uniforms && mat.uniforms.opacity) {
    mat.uniforms.opacity.value = (mat._baseUniformOpacity ?? 0.4) * factor;
  } else if (!mat.uniforms) {
    mat.opacity = (mat._baseOpacity ?? mat.opacity) * factor;
  }
}

// Restore material to saved base opacity
function restoreMaterialOpacity(mat) {
  if (mat.uniforms && mat.uniforms.opacity && mat._baseUniformOpacity !== undefined) {
    mat.uniforms.opacity.value = mat._baseUniformOpacity;
  } else if (!mat.uniforms && mat._baseOpacity !== undefined) {
    mat.opacity = mat._baseOpacity;
  }
}

// Restore all nodes that were dimmed during selection
function restoreAllNodeOpacity() {
  for (const node of graphData.nodes) {
    const threeObj = node.__threeObj;
    if (!threeObj) continue;

    // Revert selection-shown labels (bd-xk0tx): LOD pass will re-apply budget (beads-bu3r)
    threeObj.traverse(child => {
      if (child.userData.nodeLabel) {
        child.visible = false; // LOD pass (resolveOverlappingLabels) re-shows the right ones
      }
    });

    if (!node._wasDimmed) continue;
    threeObj.traverse(child => {
      if (!child.material || child.userData.selectionRing || child.userData.materiaCore || child.userData.pulse || child.userData.decisionPulse || child.userData.nodeLabel) return;
      restoreMaterialOpacity(child.material);
    });
    node._wasDimmed = false;
  }
}

// --- Animation loop: pulsing effects + selection dimming ---
let nucleusMesh = null; // cached reference

function startAnimation() {
  function animate() {
    requestAnimationFrame(animate);
    const t = (performance.now() - startTime) / 1000;
    const hasSelection = selectedNode !== null;

    // Rotate nucleus (cached, no scene.traverse)
    if (!nucleusMesh) {
      graph.scene().traverse(obj => {
        if (obj.userData.isNucleus) nucleusMesh = obj;
      });
    }
    if (nucleusMesh) {
      nucleusMesh.rotation.y = t * 0.1;
      nucleusMesh.rotation.x = Math.sin(t * 0.05) * 0.3;
    }

    // Update all shader uniforms (star field twinkle, Fresnel, selection ring sweep)
    updateShaderTime(graph.scene(), t);

    // Per-node visual feedback — only iterate when needed
    for (const node of graphData.nodes) {
      const threeObj = node.__threeObj;
      if (!threeObj) continue;

      const isMultiSelected = multiSelected.has(node.id);
      const isHighlighted = !hasSelection || highlightNodes.has(node.id) || isMultiSelected;
      const isSelected = (hasSelection && node.id === selectedNode.id) || isMultiSelected;
      const dimFactor = isHighlighted ? 1.0 : 0.35;

      // Skip traversal when nothing to update (agents always animate — beads-v0wa)
      if (!hasSelection && !isMultiSelected && node.status !== 'in_progress' && node.issue_type !== 'agent' && !labelsVisible) continue;

      // Track dimmed nodes for restoration in clearSelection()
      if (hasSelection && !isHighlighted) node._wasDimmed = true;

      threeObj.traverse(child => {
        if (!child.material) return;

        // Label sprites: show on highlighted nodes when selected (bd-xk0tx)
        // When no selection, LOD pass (resolveOverlappingLabels) manages visibility (beads-bu3r)
        if (child.userData.nodeLabel) {
          if (hasSelection) {
            child.visible = isHighlighted;
          }
          // else: LOD pass handles visibility via label budget
          return;
        }

        if (child.userData.materiaCore) {
          // Materia selection boost — glow intensification (bd-c7d5z)
          if (child.material.uniforms && child.material.uniforms.selected) {
            child.material.uniforms.selected.value = isSelected ? 1.0 : 0.0;
          }
        } else if (child.userData.selectionRing) {
          // Legacy selection ring (kept for backward compat)
          if (child.material.uniforms && child.material.uniforms.visible) {
            child.material.uniforms.visible.value = isSelected ? 1.0 : 0.0;
          }
        } else if (child.userData.agentGlow) {
          // Agent glow: breathing pulse (beads-v0wa)
          const base = child.userData.baseScale || 1;
          const pulse = 1.0 + Math.sin(t * 2) * 0.08;
          child.scale.setScalar(base * pulse);
          if (child.material.uniforms && child.material.uniforms.opacity) {
            child.material.uniforms.opacity.value = (0.1 + Math.sin(t * 2.5) * 0.05) * dimFactor;
          }
        } else if (child.userData.agentTrail) {
          // Wake trail: orient behind movement direction, fade based on speed (beads-v0wa)
          const prev = child.userData.prevPos;
          const dx = (node.x || 0) - prev.x;
          const dy = (node.y || 0) - prev.y;
          const dz = (node.z || 0) - prev.z;
          const speed = Math.sqrt(dx * dx + dy * dy + dz * dz);
          // Smoothly update previous position
          prev.x += dx * 0.1; prev.y += dy * 0.1; prev.z += dz * 0.1;
          // Trail visible only when moving (speed > threshold)
          const trailOpacity = Math.min(speed * 0.15, 0.35) * dimFactor;
          child.material.opacity = trailOpacity;
          // Position trail behind the agent (opposite of travel direction)
          if (speed > 0.5) {
            const nx = -dx / speed, ny = -dy / speed, nz = -dz / speed;
            child.position.set(nx * 6, ny * 6, nz * 6);
          }
        } else if (child.userData.pulse) {
          child.rotation.z = t * 0.5;
          if (!child.material.uniforms) {
            child.material.opacity = (0.15 + Math.sin(t * 3) * 0.1) * dimFactor;
          }
        } else if (child.userData.decisionPulse) {
          // Decision pending pulse: breathe scale + rotate (bd-zr374)
          const pulse = 1.0 + Math.sin(t * 2.5) * 0.15;
          child.scale.set(child.scale.x, child.scale.y, child.scale.z);
          child.scale.multiplyScalar(pulse);
          child.rotation.y = t * 0.3;
          child.material.opacity = (0.2 + Math.sin(t * 2.5) * 0.1) * dimFactor;
        } else if (hasSelection) {
          saveBaseOpacity(child.material);
          setMaterialDim(child.material, dimFactor);
        }
      });
    }

    // Quake-style smooth camera movement (bd-zab4q)
    if (_keysDown.size > 0 || Math.abs(_camVelocity.x) > 0.01 || Math.abs(_camVelocity.y) > 0.01 || Math.abs(_camVelocity.z) > 0.01) {
      const camera = graph.camera();
      const controls = graph.controls();
      // Build desired direction from held keys
      const right = new THREE.Vector3();
      camera.getWorldDirection(new THREE.Vector3());
      right.setFromMatrixColumn(camera.matrixWorld, 0).normalize();

      // Forward vector for W/S: camera look direction projected onto XZ plane (bd-pwaen)
      const forward = new THREE.Vector3();
      camera.getWorldDirection(forward);
      forward.y = 0; // project to XZ plane — no diving into ground
      forward.normalize();

      // Accelerate in held directions
      // Strafe: ArrowLeft/A = left, ArrowRight/D = right
      if (_keysDown.has('ArrowLeft') || _keysDown.has('a'))  { _camVelocity.x -= right.x * CAM_ACCEL; _camVelocity.y -= right.y * CAM_ACCEL; _camVelocity.z -= right.z * CAM_ACCEL; }
      if (_keysDown.has('ArrowRight') || _keysDown.has('d')) { _camVelocity.x += right.x * CAM_ACCEL; _camVelocity.y += right.y * CAM_ACCEL; _camVelocity.z += right.z * CAM_ACCEL; }
      // Vertical: ArrowUp/Down (unchanged — moves camera up/down in Y)
      if (_keysDown.has('ArrowUp'))    { _camVelocity.y += CAM_ACCEL; }
      if (_keysDown.has('ArrowDown'))  { _camVelocity.y -= CAM_ACCEL; }
      // Forward/back: W/S move along camera look direction in XZ plane (bd-pwaen)
      if (_keysDown.has('w')) { _camVelocity.x += forward.x * CAM_ACCEL; _camVelocity.z += forward.z * CAM_ACCEL; }
      if (_keysDown.has('s')) { _camVelocity.x -= forward.x * CAM_ACCEL; _camVelocity.z -= forward.z * CAM_ACCEL; }

      // Clamp speed
      const speed = Math.sqrt(_camVelocity.x ** 2 + _camVelocity.y ** 2 + _camVelocity.z ** 2);
      if (speed > CAM_MAX_SPEED) {
        const s = CAM_MAX_SPEED / speed;
        _camVelocity.x *= s; _camVelocity.y *= s; _camVelocity.z *= s;
      }

      // Apply velocity to camera + orbit target
      const delta = new THREE.Vector3(_camVelocity.x, _camVelocity.y, _camVelocity.z);
      camera.position.add(delta);
      if (controls && controls.target) controls.target.add(delta);

      // Friction: decelerate when no keys held (or gentle drag when keys held)
      const friction = _keysDown.size > 0 ? 0.95 : CAM_FRICTION;
      _camVelocity.x *= friction;
      _camVelocity.y *= friction;
      _camVelocity.z *= friction;

      // Full stop below threshold
      if (speed < 0.01) { _camVelocity.x = 0; _camVelocity.y = 0; _camVelocity.z = 0; }
    }

    // Update live event doots — HTML overlay via CSS2DRenderer (bd-bwkdk)
    updateDoots(t);
    if (css2dRenderer) css2dRenderer.render(graph.scene(), graph.camera());

    // Update event sprites — status pulses + edge sparks (bd-9qeto)
    updateEventSprites(t);

    // GPU particle pool update + selection VFX (bd-m9525)
    if (_particlePool) {
      _particlePool.update(t);
      updateSelectionVFX(t);
    }

    // Label anti-overlap: run every 4th frame for perf (beads-rgmh)
    if (!animate._labelFrame) animate._labelFrame = 0;
    if (++animate._labelFrame % 4 === 0) resolveOverlappingLabels();

    // Minimap: render every 3rd frame for perf
    if (!animate._frame) animate._frame = 0;
    if (++animate._frame % 3 === 0) renderMinimap();
  }
  animate();
}

// --- Data fetching ---
async function fetchGraphData() {
  const statusEl = document.getElementById('status');
  try {
    // Try Graph API first (single optimized endpoint)
    const hasGraph = await api.hasGraph();
    if (hasGraph) {
      return await fetchViaGraph(statusEl);
    }
    // Fallback: combine List endpoints
    return await fetchViaList(statusEl);
  } catch (err) {
    statusEl.textContent = `error: ${err.message}`;
    statusEl.className = 'error';
    console.error('Fetch failed:', err);
    return null;
  }
}

async function fetchViaGraph(statusEl) {
  // Include closed issues so age filter can work; server-side max_age_days
  // limits the query to recently-updated closed beads only (bd-uc0mw).
  const graphArgs = {
    limit: MAX_NODES,
    status: ['open', 'in_progress', 'blocked', 'hooked', 'deferred', 'closed'], // bd-7haep: include all active statuses
    max_age_days: activeAgeDays || 0,
    include_deps: true,
    include_body: true,
    include_agents: true,
    exclude_types: DEEP_LINK_MOLECULE
      ? ['message', 'config', 'gate', 'wisp', 'convoy', 'formula', 'advice', 'role'] // bd-lwut6: include molecules when focusing one
      : ['message', 'config', 'gate', 'wisp', 'convoy', 'molecule', 'formula', 'advice', 'role'], // bd-04wet, bd-t25i1, bd-uqkpq: filter noise types
  };
  const result = await api.graph(graphArgs);

  let nodes = (result.nodes || []).map(n => ({
    id: n.id,
    ...n,
    _blocked: !!(n.blocked_by && n.blocked_by.length > 0),
  }));

  // Graph API edges: { source, target, type } → links: { source, target, dep_type }
  // Promote "blocks" edges where target is an epic to "parent-child" so they render
  // with the chain glyph instead of the shield. Most epics use "blocks" deps rather
  // than explicit "parent-child" deps. (bd-uqkpq)
  const nodeIds = new Set(nodes.map(n => n.id));
  const nodeMap = Object.fromEntries(nodes.map(n => [n.id, n]));
  const links = [];
  for (const e of (result.edges || [])) {
    const hasSrc = nodeIds.has(e.source);
    const hasTgt = nodeIds.has(e.target);
    let depType = e.type || 'blocks';

    // Promote blocks edges to parent-child when target is an epic (bd-uqkpq)
    if (depType === 'blocks' && hasTgt && nodeMap[e.target]?.issue_type === 'epic') {
      depType = 'parent-child';
    }

    if (hasSrc && hasTgt) {
      links.push({ source: e.source, target: e.target, dep_type: depType });
    } else if (depType === 'parent-child' && (hasSrc || hasTgt)) {
      // Create ghost node for the missing endpoint so DAG links remain visible
      const missingId = hasSrc ? e.target : e.source;
      if (!nodeIds.has(missingId)) {
        nodes.push({
          id: missingId, title: missingId, status: 'open', priority: 3,
          issue_type: 'epic', _placeholder: true, _blocked: false,
        });
        nodeIds.add(missingId);
        nodeMap[missingId] = nodes[nodes.length - 1];
      }
      links.push({ source: e.source, target: e.target, dep_type: 'parent-child' });
    }
  }

  // Client-side agent→bead linkage (beads-zq8a): synthesize agent nodes and
  // assigned_to links from node assignee fields. The server Graph API should
  // return these, but currently doesn't — so we build them client-side.
  const agentNodes = new Map(); // assignee name → agent node
  for (const n of nodes) {
    if (n.assignee && n.status === 'in_progress') {
      const agentId = `agent:${n.assignee}`;
      if (!agentNodes.has(n.assignee)) {
        agentNodes.set(n.assignee, {
          id: agentId,
          title: n.assignee,
          status: 'active',
          priority: 3,
          issue_type: 'agent',
          _blocked: false,
        });
      }
      // Only add edge if not already present from server
      const edgeExists = links.some(l =>
        (l.source === agentId || l.source?.id === agentId) &&
        (l.target === n.id || l.target?.id === n.id) &&
        l.dep_type === 'assigned_to',
      );
      if (!edgeExists) {
        links.push({ source: agentId, target: n.id, dep_type: 'assigned_to' });
      }
    }
  }
  for (const [, agentNode] of agentNodes) {
    if (!nodeIds.has(agentNode.id)) {
      nodes.push(agentNode);
      nodeIds.add(agentNode.id);
      nodeMap[agentNode.id] = agentNode;
    }
  }

  // Filter disconnected decisions and molecules: only show if they have at least
  // one edge connecting them to a visible bead (bd-t25i1)
  const LINKED_ONLY = new Set(['decision', 'molecule']);
  const connectedIds = new Set();
  for (const l of links) { connectedIds.add(l.source); connectedIds.add(l.target); }
  nodes = nodes.filter(n => !LINKED_ONLY.has(n.issue_type) || connectedIds.has(n.id));

  statusEl.textContent = `graph api · ${nodes.length} beads · ${links.length} links`;
  statusEl.className = 'connected';
  updateStats(result.stats, nodes);
  console.log(`[beads3d] Graph API: ${nodes.length} nodes, ${links.length} links`);
  return { nodes, links };
}

async function fetchViaList(statusEl) {
  const SKIP_TYPES = new Set(DEEP_LINK_MOLECULE
    ? ['message', 'config', 'gate', 'wisp', 'convoy', 'decision', 'formula', 'advice', 'role'] // bd-lwut6: include molecules
    : ['message', 'config', 'gate', 'wisp', 'convoy', 'decision', 'molecule', 'formula', 'advice', 'role']);

  // Parallel fetch: open/active beads + blocked + stats (bd-7haep: include all active statuses)
  const [openIssues, inProgress, hookedIssues, deferredIssues, blocked, stats] = await Promise.all([
    api.list({
      limit: MAX_NODES * 2, // over-fetch to compensate for client-side filtering
      status: 'open',
      exclude_status: ['tombstone', 'closed'],
    }),
    api.list({
      limit: 100,
      status: 'in_progress',
    }),
    api.list({ limit: 100, status: 'hooked' }).catch(() => []),
    api.list({ limit: 100, status: 'deferred' }).catch(() => []),
    api.blocked().catch(() => []),
    api.stats().catch(() => null),
  ]);

  // Merge all issues, dedup by id, filter out noise
  const issueMap = new Map();
  const addIssues = (arr) => {
    if (!Array.isArray(arr)) return;
    for (const i of arr) {
      if (i.ephemeral) continue;
      if (SKIP_TYPES.has(i.issue_type)) continue;
      if (i.id.includes('-wisp-')) continue;
      issueMap.set(i.id, i);
    }
  };

  addIssues(openIssues);
  addIssues(inProgress);
  addIssues(hookedIssues);
  addIssues(deferredIssues);
  addIssues(blocked);

  const issues = [...issueMap.values()].slice(0, MAX_NODES);

  statusEl.textContent = `list api · ${issues.length} beads`;
  statusEl.className = 'connected';
  updateStats(stats, issues);
  return buildGraphData(issues);
}

function buildGraphData(issues) {
  const issueMap = new Map();
  issues.forEach(i => issueMap.set(i.id, i));

  const nodes = issues.map(issue => ({
    id: issue.id,
    ...issue,
    _blocked: !!(issue.blocked_by && issue.blocked_by.length > 0),
  }));

  const links = [];
  const seenLinks = new Set();

  issues.forEach(issue => {
    // blocked_by → create links
    if (issue.blocked_by && Array.isArray(issue.blocked_by)) {
      for (const blockerId of issue.blocked_by) {
        const key = `${issue.id}<-${blockerId}`;
        if (seenLinks.has(key)) continue;
        seenLinks.add(key);

        if (!issueMap.has(blockerId)) {
          const placeholder = {
            id: blockerId, title: blockerId, status: 'open',
            priority: 3, issue_type: 'task', _placeholder: true,
          };
          issueMap.set(blockerId, placeholder);
          nodes.push({ ...placeholder, _blocked: false });
        }

        links.push({ source: blockerId, target: issue.id, dep_type: 'blocks' });
      }
    }

    // Dependencies
    if (issue.dependencies && Array.isArray(issue.dependencies)) {
      for (const dep of issue.dependencies) {
        const fromId = dep.issue_id || issue.id;
        const toId = dep.depends_on_id || dep.id;
        if (!toId) continue;
        const key = `${fromId}->${toId}`;
        if (seenLinks.has(key)) continue;
        seenLinks.add(key);

        if (!issueMap.has(toId)) {
          const placeholder = {
            id: toId, title: dep.title || toId, status: dep.status || 'open',
            priority: dep.priority ?? 3, issue_type: dep.issue_type || 'task',
            _placeholder: true,
          };
          issueMap.set(toId, placeholder);
          nodes.push({ ...placeholder, _blocked: false });
        }

        links.push({
          source: fromId, target: toId,
          dep_type: dep.type || dep.dependency_type || 'blocks',
        });
      }
    }

    // Parent-child — create placeholder if parent not loaded (bd-uqkpq)
    if (issue.parent) {
      const key = `${issue.id}->parent:${issue.parent}`;
      if (!seenLinks.has(key)) {
        seenLinks.add(key);
        if (!issueMap.has(issue.parent)) {
          const placeholder = {
            id: issue.parent, title: issue.parent, status: 'open',
            priority: 3, issue_type: 'epic', _placeholder: true,
          };
          issueMap.set(issue.parent, placeholder);
          nodes.push({ ...placeholder, _blocked: false });
        }
        links.push({ source: issue.id, target: issue.parent, dep_type: 'parent-child' });
      }
    }
  });

  // Client-side agent→bead linkage (beads-zq8a): same as fetchViaGraph path
  const agentMap = new Map();
  for (const n of nodes) {
    const assignee = n.assigned_to || n.assignee;
    if (assignee && n.status === 'in_progress') {
      const agentId = `agent:${assignee}`;
      if (!agentMap.has(assignee)) {
        agentMap.set(assignee, {
          id: agentId, title: assignee, status: 'active',
          priority: 3, issue_type: 'agent', _blocked: false,
        });
      }
      links.push({ source: agentId, target: n.id, dep_type: 'assigned_to' });
    }
  }
  for (const [, agentNode] of agentMap) {
    if (!issueMap.has(agentNode.id)) {
      nodes.push(agentNode);
      issueMap.set(agentNode.id, agentNode);
    }
  }

  console.log(`[beads3d] ${nodes.length} nodes, ${links.length} links`);
  return { nodes, links };
}

// bd-9cpbc.1: live-update project pulse from bus mutation events
function _liveUpdateProjectPulse() {
  if (!graphData) return;
  const pulseEl = document.getElementById('hud-project-pulse');
  if (!pulseEl) return;
  const nodes = graphData.nodes.filter(n => !n._hidden);
  let open = 0, active = 0, blocked = 0, agentCount = 0, pendingDecisions = 0;
  for (const n of nodes) {
    if (n.issue_type === 'agent') { agentCount++; continue; }
    if ((n.issue_type === 'gate' || n.issue_type === 'decision') && n.status !== 'closed') pendingDecisions++;
    if (n._blocked) blocked++;
    else if (n.status === 'in_progress') active++;
    else if (n.status === 'open' || n.status === 'hooked' || n.status === 'deferred') open++;
  }
  pulseEl.innerHTML = `
    <div class="pulse-stat"><span class="pulse-stat-label">open</span><span class="pulse-stat-value">${open}</span></div>
    <div class="pulse-stat"><span class="pulse-stat-label">active</span><span class="pulse-stat-value good">${active}</span></div>
    <div class="pulse-stat"><span class="pulse-stat-label">blocked</span><span class="pulse-stat-value${blocked ? ' bad' : ''}">${blocked}</span></div>
    <div class="pulse-stat"><span class="pulse-stat-label">agents</span><span class="pulse-stat-value${agentCount ? ' warn' : ''}">${agentCount}</span></div>
    <div class="pulse-stat"><span class="pulse-stat-label">decisions</span><span class="pulse-stat-value${pendingDecisions ? ' warn' : ''}">${pendingDecisions}</span></div>
    <div class="pulse-stat"><span class="pulse-stat-label">shown</span><span class="pulse-stat-value">${nodes.length}</span></div>
  `;
}

function updateStats(stats, issues) {
  const el = document.getElementById('stats');
  const parts = [];
  if (stats) {
    // Handle both Graph API (total_open) and Stats API (open_issues) formats
    const open = stats.total_open ?? stats.open_issues ?? 0;
    const active = stats.total_in_progress ?? stats.in_progress_issues ?? 0;
    const blocked = stats.total_blocked ?? stats.blocked_issues ?? 0;
    parts.push(`<span>${open}</span> open`);
    parts.push(`<span>${active}</span> active`);
    if (blocked) parts.push(`<span>${blocked}</span> blocked`);

    // Update Bottom HUD project pulse (bd-ddj44, bd-9ndk0.1)
    const pulseEl = document.getElementById('hud-project-pulse');
    if (pulseEl) {
      const agentCount = issues.filter(n => n.issue_type === 'agent').length;
      const pendingDecisions = issues.filter(n =>
        (n.issue_type === 'gate' || n.issue_type === 'decision') && n.status !== 'closed'
      ).length;
      pulseEl.innerHTML = `
        <div class="pulse-stat"><span class="pulse-stat-label">open</span><span class="pulse-stat-value">${open}</span></div>
        <div class="pulse-stat"><span class="pulse-stat-label">active</span><span class="pulse-stat-value good">${active}</span></div>
        <div class="pulse-stat"><span class="pulse-stat-label">blocked</span><span class="pulse-stat-value${blocked ? ' bad' : ''}">${blocked}</span></div>
        <div class="pulse-stat"><span class="pulse-stat-label">agents</span><span class="pulse-stat-value${agentCount ? ' warn' : ''}">${agentCount}</span></div>
        <div class="pulse-stat"><span class="pulse-stat-label">decisions</span><span class="pulse-stat-value${pendingDecisions ? ' warn' : ''}">${pendingDecisions}</span></div>
        <div class="pulse-stat"><span class="pulse-stat-label">shown</span><span class="pulse-stat-value">${issues.length}</span></div>
      `;
    }
  }
  parts.push(`<span>${issues.length}</span> shown`);
  el.innerHTML = parts.join(' &middot; ');
}

// --- Tooltip ---
const tooltip = document.getElementById('tooltip');

function handleNodeHover(node) {
  document.body.style.cursor = node ? 'pointer' : 'default';
  // Track hovered node for VFX glow warmup (bd-m9525)
  _hoveredNode = (node && !node._hidden) ? node : null;
  _hoverGlowTimer = 0;
  if (!node || node._hidden) { hideTooltip(); return; }

  const pLabel = ['P0 CRIT', 'P1', 'P2', 'P3', 'P4'][node.priority] || '';
  const assignee = node.assignee ? `<br>assignee: ${escapeHtml(node.assignee)}` : '';

  tooltip.innerHTML = `
    <div class="id">${escapeHtml(node.id)} &middot; ${node.issue_type || 'task'} &middot; ${pLabel}</div>
    <div class="title">${escapeHtml(node.title || node.id)}</div>
    <div class="meta">
      ${node.status}${node._blocked ? ' &middot; BLOCKED' : ''}${node._placeholder ? ' &middot; (ref)' : ''}
      ${assignee}
      ${node.blocked_by ? '<br>blocked by: ' + node.blocked_by.map(escapeHtml).join(', ') : ''}
    </div>
    <div class="hint">click for details</div>
  `;
  // Respect HUD visibility toggle (bd-4hggh)
  if (window.__beads3d_hudHidden && window.__beads3d_hudHidden['tooltip']) return;
  tooltip.style.display = 'block';
  document.addEventListener('mousemove', positionTooltip);
}

function positionTooltip(e) {
  const pad = 15;
  let x = e.clientX + pad;
  let y = e.clientY + pad;
  // Keep tooltip on screen
  const rect = tooltip.getBoundingClientRect();
  if (x + rect.width > window.innerWidth) x = e.clientX - rect.width - pad;
  if (y + rect.height > window.innerHeight) y = e.clientY - rect.height - pad;
  tooltip.style.left = x + 'px';
  tooltip.style.top = y + 'px';
}

function hideTooltip() {
  tooltip.style.display = 'none';
  document.removeEventListener('mousemove', positionTooltip);
}

// --- Detail panel (click to open) ---
function handleNodeClick(node) {
  if (!node) return;
  // Allow clicking revealed nodes even when they'd normally be hidden (hq-vorf47)
  if (node._hidden && !revealedNodes.has(node.id)) return;

  // Compute full connected component first, then highlight it all (beads-1sqr)
  const component = getConnectedComponent(node.id);
  selectNode(node, component);

  // Reveal entire connected subgraph regardless of filters (hq-vorf47).
  revealedNodes.clear();
  for (const id of component) {
    revealedNodes.add(id);
  }
  applyFilters(); // re-run filters to un-hide revealed nodes

  spreadSubgraph(component); // beads-k38a: push nodes apart for readability
  zoomToNodes(component);
  showDetail(node);

  // Update URL for deep-linking (bd-he95o) — enables copy/paste sharing
  updateBeadURL(node.id);
}

// Update URL ?bead= parameter without page reload (bd-he95o)
function updateBeadURL(beadId) {
  if (!window.history.replaceState) return;
  const url = new URL(window.location.href);
  if (beadId) {
    url.searchParams.set('bead', beadId);
  } else {
    url.searchParams.delete('bead');
    url.searchParams.delete('molecule'); // bd-lwut6: clear molecule param on deselect
  }
  window.history.replaceState(null, '', url.toString());
}

// BFS to find the full connected component (both directions) for a node (bd-tr0en)
function getConnectedComponent(startId) {
  const visited = new Set();
  const queue = [startId];
  while (queue.length > 0) {
    const current = queue.shift();
    if (visited.has(current)) continue;
    visited.add(current);
    for (const l of graphData.links) {
      const srcId = typeof l.source === 'object' ? l.source.id : l.source;
      const tgtId = typeof l.target === 'object' ? l.target.id : l.target;
      if (srcId === current && !visited.has(tgtId)) queue.push(tgtId);
      if (tgtId === current && !visited.has(srcId)) queue.push(srcId);
    }
  }
  return visited;
}

// Fly camera to fit a set of node IDs with padding (bd-tr0en)
function zoomToNodes(nodeIds) {
  let cx = 0, cy = 0, cz = 0, count = 0;
  for (const node of graphData.nodes) {
    if (!nodeIds.has(node.id)) continue;
    cx += (node.x || 0);
    cy += (node.y || 0);
    cz += (node.z || 0);
    count++;
  }
  if (count === 0) return;
  cx /= count; cy /= count; cz /= count;

  // For single-node components, use the original close-up zoom
  if (count === 1) {
    const distance = 150;
    const distRatio = 1 + distance / Math.hypot(cx, cy, cz);
    const camFrom = graph.camera().position.clone();
    const camTo = { x: cx * distRatio, y: cy * distRatio, z: cz * distRatio };
    spawnFlyToTrail(camFrom, { x: cx, y: cy, z: cz }); // bd-m9525: particle trail
    graph.cameraPosition(camTo, { x: cx, y: cy, z: cz }, 1000);
    return;
  }

  // Calculate radius (max distance from center)
  let maxDist = 0;
  for (const node of graphData.nodes) {
    if (!nodeIds.has(node.id)) continue;
    const dx = (node.x || 0) - cx;
    const dy = (node.y || 0) - cy;
    const dz = (node.z || 0) - cz;
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (d > maxDist) maxDist = d;
  }

  const distance = Math.max(maxDist * 2.5, 150);
  const lookAt = { x: cx, y: cy, z: cz };
  const cam = graph.camera();
  const dir = new THREE.Vector3(
    cam.position.x - cx, cam.position.y - cy, cam.position.z - cz
  ).normalize();
  const camPos = {
    x: cx + dir.x * distance,
    y: cy + dir.y * distance,
    z: cz + dir.z * distance,
  };
  spawnFlyToTrail(graph.camera().position.clone(), lookAt); // bd-m9525: particle trail
  graph.cameraPosition(camPos, lookAt, 1000);
}

async function showDetail(node) {
  const container = document.getElementById('detail');

  // Toggle: if this bead's panel is already open, close it (bd-fbmq3)
  if (openPanels.has(node.id)) {
    closeDetailPanel(node.id);
    return;
  }

  container.style.display = 'block';

  // Create a new panel element
  const panel = document.createElement('div');
  panel.className = 'detail-panel';
  panel.dataset.beadId = node.id;
  container.appendChild(panel);

  // Track it
  openPanels.set(node.id, panel);
  repositionPanels();

  const pLabel = ['P0 CRIT', 'P1 HIGH', 'P2 MED', 'P3 LOW', 'P4 BACKLOG'][node.priority] || '';

  // Show basic info immediately
  panel.innerHTML = `
    <div class="detail-header">
      <span class="detail-id">${escapeHtml(node.id)}</span>
      <button class="detail-close">&times;</button>
    </div>
    <div class="detail-title">${escapeHtml(node.title || node.id)}</div>
    <div class="detail-meta">
      <span class="tag tag-${node.status}">${node.status}</span>
      <span class="tag">${node.issue_type || 'task'}</span>
      <span class="tag">${pLabel}</span>
      ${node.assignee ? `<span class="tag tag-assignee">${escapeHtml(node.assignee)}</span>` : ''}
      ${node.rig ? `<span class="tag" style="color:${rigColor(node.rig)};border-color:${rigColor(node.rig)}33">${escapeHtml(node.rig)}</span>` : ''}
      ${node._blocked ? '<span class="tag tag-blocked">BLOCKED</span>' : ''}
    </div>
    <div class="detail-body loading">loading full details...</div>
  `;

  // Close button handler
  panel.querySelector('.detail-close').onclick = () => closeDetailPanel(node.id);

  // Animate open
  requestAnimationFrame(() => panel.classList.add('open'));

  // Agent nodes: open activity feed window instead of detail panel (bd-kau4k)
  if (node.issue_type === 'agent' && node.id.startsWith('agent:')) {
    // Remove the detail panel we just created — agent windows live in the bottom tray
    closeDetailPanel(node.id);
    showAgentWindow(node);
    return;
  }

  // Decision/gate nodes: show decision panel with options and resolve UI (bd-1xskh, bd-9gxt1)
  if (node.issue_type === 'gate' || node.issue_type === 'decision') {
    try {
      const resp = await api.decisionGet(node.id);
      const body = panel.querySelector('.detail-body');
      if (body) {
        body.classList.remove('loading');
        body.innerHTML = renderDecisionDetail(node, resp);
        bindDecisionHandlers(panel, node, resp);
      }
    } catch (err) {
      // Fall back to regular detail
      try {
        const full = await api.show(node.id);
        const body = panel.querySelector('.detail-body');
        if (body) {
          body.classList.remove('loading');
          body.innerHTML = renderFullDetail(full);
        }
      } catch (err2) {
        const body = panel.querySelector('.detail-body');
        if (body) {
          body.classList.remove('loading');
          body.textContent = `Could not load: ${err2.message}`;
        }
      }
    }
    return;
  }

  // Regular nodes
  try {
    const full = await api.show(node.id);
    const body = panel.querySelector('.detail-body');
    if (body) {
      body.classList.remove('loading');
      body.innerHTML = renderFullDetail(full);
    }
  } catch (err) {
    const body = panel.querySelector('.detail-body');
    if (body) {
      body.classList.remove('loading');
      body.textContent = `Could not load: ${err.message}`;
    }
  }
}

// Close a single detail panel by bead ID (bd-fbmq3)
function closeDetailPanel(beadId) {
  const panel = openPanels.get(beadId);
  if (!panel) return;
  panel.classList.remove('open');
  openPanels.delete(beadId);
  setTimeout(() => {
    panel.remove();
    repositionPanels();
    if (openPanels.size === 0) {
      document.getElementById('detail').style.display = 'none';
    }
  }, 200); // wait for slide-out animation
}

// Position panels side-by-side from right edge (bd-fbmq3)
function repositionPanels() {
  let offset = 0;
  // Iterate in insertion order (Map preserves order) — newest on right
  const entries = [...openPanels.entries()].reverse();
  for (const [, panel] of entries) {
    panel.style.right = `${offset}px`;
    offset += 384; // 380px width + 4px gap
  }
}

function renderFullDetail(issue) {
  const sections = [];

  if (issue.description) {
    sections.push(`<div class="detail-section"><h4>Description</h4><pre>${escapeHtml(issue.description)}</pre></div>`);
  }
  if (issue.design) {
    sections.push(`<div class="detail-section"><h4>Design</h4><pre>${escapeHtml(issue.design)}</pre></div>`);
  }
  if (issue.notes) {
    sections.push(`<div class="detail-section"><h4>Notes</h4><pre>${escapeHtml(issue.notes)}</pre></div>`);
  }
  if (issue.acceptance_criteria) {
    sections.push(`<div class="detail-section"><h4>Acceptance Criteria</h4><pre>${escapeHtml(issue.acceptance_criteria)}</pre></div>`);
  }

  // Dependencies
  if (issue.dependencies && issue.dependencies.length > 0) {
    const deps = issue.dependencies.map(d =>
      `<div class="dep-item">${escapeHtml(d.type || 'dep')} &rarr; ${escapeHtml(d.title || d.depends_on_id || d.id)}</div>`
    ).join('');
    sections.push(`<div class="detail-section"><h4>Dependencies</h4>${deps}</div>`);
  }

  // Blocked by
  if (issue.blocked_by && issue.blocked_by.length > 0) {
    sections.push(`<div class="detail-section"><h4>Blocked By</h4>${issue.blocked_by.map(b => `<div class="dep-item">${escapeHtml(b)}</div>`).join('')}</div>`);
  }

  // Labels
  if (issue.labels && issue.labels.length > 0) {
    const labels = issue.labels.map(l => `<span class="tag">${escapeHtml(l)}</span>`).join(' ');
    sections.push(`<div class="detail-section"><h4>Labels</h4>${labels}</div>`);
  }

  // Metadata
  const meta = [];
  if (issue.created_at) meta.push(`created: ${new Date(issue.created_at).toLocaleDateString()}`);
  if (issue.updated_at) meta.push(`updated: ${new Date(issue.updated_at).toLocaleDateString()}`);
  if (issue.owner) meta.push(`owner: ${issue.owner}`);
  if (issue.created_by) meta.push(`by: ${issue.created_by}`);
  if (meta.length) {
    sections.push(`<div class="detail-section detail-timestamps">${meta.join(' &middot; ')}</div>`);
  }

  return sections.join('') || '<em>No additional details</em>';
}

// Render decision detail panel content (bd-1xskh)
function renderDecisionDetail(node, resp) {
  const dec = resp.decision || {};
  const issue = resp.issue || {};
  const sections = [];

  // State badge
  const state = dec.selected_option ? 'resolved' : (node.status === 'closed' ? 'resolved' : 'pending');
  const stateColor = state === 'resolved' ? '#2d8a4e' : state === 'expired' ? '#d04040' : '#d4a017';
  sections.push(`<div class="decision-state" style="color:${stateColor};font-weight:bold;margin-bottom:8px">${state.toUpperCase()}</div>`);

  // Prompt
  if (dec.prompt) {
    sections.push(`<div class="detail-section"><h4>Question</h4><pre class="decision-prompt">${escapeHtml(dec.prompt)}</pre></div>`);
  }

  // Context
  if (dec.context) {
    sections.push(`<div class="detail-section"><h4>Context</h4><pre>${escapeHtml(dec.context)}</pre></div>`);
  }

  // Options (DecisionPoint.Options is a JSON string in Go, must parse)
  const opts = typeof dec.options === 'string' ? (() => { try { return JSON.parse(dec.options); } catch { return []; } })() : (dec.options || []);
  if (opts.length > 0) {
    const optHtml = opts.map((opt, i) => {
      const selected = dec.selected_option === opt.id;
      const cls = selected ? 'decision-opt selected' : 'decision-opt';
      const label = opt.label || opt.short || opt.id;
      const beadRef = opt.bead_id ? ` <span class="decision-opt-bead">(${escapeHtml(opt.bead_id)})</span>` : '';
      return `<button class="${cls}" data-opt-id="${escapeHtml(opt.id)}" data-opt-idx="${i}">${escapeHtml(label)}${beadRef}</button>`;
    }).join('');
    sections.push(`<div class="detail-section"><h4>Options</h4><div class="decision-options">${optHtml}</div></div>`);
  }

  // Resolution result
  if (dec.selected_option) {
    const selectedOpt = opts.find(o => o.id === dec.selected_option);
    const selectedLabel = selectedOpt ? (selectedOpt.label || selectedOpt.short || selectedOpt.id) : dec.selected_option;
    let resolvedInfo = `<div class="decision-selected">${escapeHtml(selectedLabel)}</div>`;
    if (dec.responded_by) resolvedInfo += `<div style="color:#888;font-size:11px">by ${escapeHtml(dec.responded_by)}`;
    if (dec.responded_at) resolvedInfo += ` at ${new Date(dec.responded_at).toLocaleString()}`;
    if (dec.responded_by) resolvedInfo += `</div>`;
    sections.push(`<div class="detail-section"><h4>Selected</h4>${resolvedInfo}</div>`);
    if (dec.response_text) {
      sections.push(`<div class="detail-section"><h4>Response</h4><pre>${escapeHtml(dec.response_text)}</pre></div>`);
    }
  }

  // Custom response input (only for pending decisions)
  if (state === 'pending') {
    sections.push(`<div class="detail-section decision-respond-section">
      <h4>Respond</h4>
      <input type="text" class="decision-response-input" placeholder="Custom response text..." />
      <button class="decision-send-btn">Send</button>
    </div>`);
  }

  // Iteration info
  if (dec.iteration > 0 || dec.max_iterations > 0) {
    sections.push(`<div class="detail-section detail-timestamps">iteration ${dec.iteration || 0}/${dec.max_iterations || 3}</div>`);
  }

  // Metadata
  const meta = [];
  if (dec.requested_by) meta.push(`by: ${dec.requested_by}`);
  if (dec.urgency) meta.push(`urgency: ${dec.urgency}`);
  if (issue.created_at) meta.push(`created: ${new Date(issue.created_at).toLocaleDateString()}`);
  if (meta.length) {
    sections.push(`<div class="detail-section detail-timestamps">${meta.join(' &middot; ')}</div>`);
  }

  return sections.join('');
}

// Bind click handlers for decision option buttons and custom response (bd-9gxt1)
function bindDecisionHandlers(panel, node, resp) {
  const dec = resp.decision || {};
  const state = dec.selected_option ? 'resolved' : 'pending';
  if (state !== 'pending') return; // Already resolved — no interaction

  // Option buttons
  panel.querySelectorAll('.decision-opt').forEach(btn => {
    btn.addEventListener('click', async () => {
      const optId = btn.dataset.optId;
      btn.classList.add('selected');
      btn.disabled = true;
      try {
        await api.decisionResolve(node.id, optId, '');
        // Optimistic state update
        node._decisionState = 'resolved';
        const stateEl = panel.querySelector('.decision-state');
        if (stateEl) { stateEl.textContent = 'RESOLVED'; stateEl.style.color = '#2d8a4e'; }
        // Disable all buttons
        panel.querySelectorAll('.decision-opt').forEach(b => { b.disabled = true; });
        const respondSection = panel.querySelector('.decision-respond-section');
        if (respondSection) respondSection.remove();
        showStatusToast(`resolved ${node.id}: ${optId}`);
        // Rebuild graph node
        graph.nodeThreeObject(graph.nodeThreeObject());
      } catch (err) {
        btn.classList.remove('selected');
        btn.disabled = false;
        showStatusToast(`resolve failed: ${err.message}`, true);
        console.error('[beads3d] decision resolve failed:', err);
      }
    });
  });

  // Custom response send button
  const sendBtn = panel.querySelector('.decision-send-btn');
  const input = panel.querySelector('.decision-response-input');
  if (sendBtn && input) {
    const doSend = async () => {
      const text = input.value.trim();
      if (!text) return;
      sendBtn.disabled = true;
      try {
        await api.decisionResolve(node.id, '', text);
        node._decisionState = 'resolved';
        const stateEl = panel.querySelector('.decision-state');
        if (stateEl) { stateEl.textContent = 'RESOLVED'; stateEl.style.color = '#2d8a4e'; }
        panel.querySelectorAll('.decision-opt').forEach(b => { b.disabled = true; });
        input.value = 'Sent!';
        input.disabled = true;
        showStatusToast(`resolved ${node.id}`);
        graph.nodeThreeObject(graph.nodeThreeObject());
      } catch (err) {
        sendBtn.disabled = false;
        showStatusToast(`response failed: ${err.message}`, true);
        console.error('[beads3d] decision response failed:', err);
      }
    };
    sendBtn.addEventListener('click', doSend);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') doSend(); });
  }
}

function hideDetail() {
  // Close all open panels (bd-fbmq3)
  for (const [beadId] of openPanels) {
    closeDetailPanel(beadId);
  }
}

function escapeHtml(str) {
  if (!str) return '';
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// --- Context menu (right-click) ---
const ctxMenu = document.getElementById('context-menu');
let ctxNode = null;

function buildStatusSubmenu(currentStatus) {
  const statuses = [
    { value: 'open', label: 'open', color: '#2d8a4e' },
    { value: 'in_progress', label: 'in progress', color: '#d4a017' },
    { value: 'closed', label: 'closed', color: '#333340' },
  ];
  return statuses.map(s =>
    `<div class="ctx-sub-item${s.value === currentStatus ? ' active' : ''}" data-action="set-status" data-value="${s.value}">` +
    `<span class="ctx-dot" style="background:${s.color}"></span>${s.label}</div>`
  ).join('');
}

function buildPrioritySubmenu(currentPriority) {
  const priorities = [
    { value: 0, label: 'P0 critical', color: '#ff3333' },
    { value: 1, label: 'P1 high', color: '#ff8833' },
    { value: 2, label: 'P2 medium', color: '#d4a017' },
    { value: 3, label: 'P3 low', color: '#4a9eff' },
    { value: 4, label: 'P4 backlog', color: '#666' },
  ];
  return priorities.map(p =>
    `<div class="ctx-sub-item${p.value === currentPriority ? ' active' : ''}" data-action="set-priority" data-value="${p.value}">` +
    `<span class="ctx-dot" style="background:${p.color}"></span>${p.label}</div>`
  ).join('');
}

function handleNodeRightClick(node, event) {
  event.preventDefault();
  if (!node || node._hidden) return;
  // Skip agent pseudo-nodes — they're not real beads
  if (node.issue_type === 'agent') return;
  ctxNode = node;
  hideTooltip();

  ctxMenu.innerHTML = `
    <div class="ctx-header">${escapeHtml(node.id)}</div>
    <div class="ctx-item ctx-submenu">status
      <div class="ctx-submenu-panel">${buildStatusSubmenu(node.status)}</div>
    </div>
    <div class="ctx-item ctx-submenu">priority
      <div class="ctx-submenu-panel">${buildPrioritySubmenu(node.priority)}</div>
    </div>
    <div class="ctx-item" data-action="claim">claim (assign to me)</div>
    <div class="ctx-item" data-action="close-bead">close</div>
    <div class="ctx-sep"></div>
    <div class="ctx-item" data-action="expand-deps">expand dep tree<span class="ctx-key">e</span></div>
    <div class="ctx-item" data-action="show-deps">show dependencies<span class="ctx-key">d</span></div>
    <div class="ctx-item" data-action="show-blockers">show blockers<span class="ctx-key">b</span></div>
    <div class="ctx-sep"></div>
    <div class="ctx-item" data-action="copy-id">copy ID<span class="ctx-key">c</span></div>
    <div class="ctx-item" data-action="copy-show">copy bd show ${escapeHtml(node.id)}</div>
  `;

  // Position menu, keeping it on screen
  ctxMenu.style.display = 'block';
  const rect = ctxMenu.getBoundingClientRect();
  let x = event.clientX;
  let y = event.clientY;
  if (x + rect.width > window.innerWidth) x = window.innerWidth - rect.width - 8;
  if (y + rect.height > window.innerHeight) y = window.innerHeight - rect.height - 8;
  ctxMenu.style.left = x + 'px';
  ctxMenu.style.top = y + 'px';

  // Handle clicks on menu items (including submenu items, bd-9g7f0)
  ctxMenu.onclick = (e) => {
    // Check submenu items first (they're nested inside .ctx-item)
    const subItem = e.target.closest('.ctx-sub-item');
    if (subItem) {
      handleContextAction(subItem.dataset.action, node, subItem);
      return;
    }
    const item = e.target.closest('.ctx-item');
    if (!item || item.classList.contains('ctx-submenu')) return; // skip submenu parents
    handleContextAction(item.dataset.action, node, item);
  };
}

function hideContextMenu() {
  ctxMenu.style.display = 'none';
  ctxMenu.onclick = null;
  ctxNode = null;
}

// Apply an optimistic update to a node: immediately update local data + visuals,
// fire the API call, and revert on failure.
async function optimisticUpdate(node, changes, apiCall) {
  // Snapshot current values for rollback
  const snapshot = {};
  for (const key of Object.keys(changes)) {
    snapshot[key] = node[key];
  }

  // Apply changes immediately
  Object.assign(node, changes);

  // Force Three.js object rebuild for this node (picks up new color, size, status effects)
  graph.nodeThreeObject(graph.nodeThreeObject());

  try {
    await apiCall();
  } catch (err) {
    // Revert on failure
    Object.assign(node, snapshot);
    graph.nodeThreeObject(graph.nodeThreeObject());
    showStatusToast(`error: ${err.message}`, true);
  }
}

async function handleContextAction(action, node, el) {
  switch (action) {
    case 'set-status': {
      const value = el?.dataset.value;
      if (!value || value === node.status) break;
      hideContextMenu();
      showStatusToast(`${node.id} → ${value}`);
      await optimisticUpdate(node, { status: value }, () => api.update(node.id, { status: value }));
      break;
    }
    case 'set-priority': {
      const value = parseInt(el?.dataset.value, 10);
      if (isNaN(value) || value === node.priority) break;
      hideContextMenu();
      showStatusToast(`${node.id} → P${value}`);
      await optimisticUpdate(node, { priority: value }, () => api.update(node.id, { priority: value }));
      break;
    }
    case 'claim':
      hideContextMenu();
      showStatusToast(`claimed ${node.id}`);
      await optimisticUpdate(node, { status: 'in_progress' }, () => api.update(node.id, { status: 'in_progress' }));
      break;
    case 'close-bead':
      hideContextMenu();
      showStatusToast(`closed ${node.id}`);
      await optimisticUpdate(node, { status: 'closed' }, () => api.close(node.id));
      break;
    case 'expand-deps':
      expandDepTree(node);
      hideContextMenu();
      break;
    case 'show-deps':
      highlightSubgraph(node, 'downstream');
      hideContextMenu();
      break;
    case 'show-blockers':
      highlightSubgraph(node, 'upstream');
      hideContextMenu();
      break;
    case 'copy-id':
      copyToClipboard(node.id);
      showCtxToast('copied!');
      break;
    case 'copy-show':
      copyToClipboard(`bd show ${node.id}`);
      showCtxToast('copied!');
      break;
  }
}

// Brief toast message overlaid on the status bar (bd-9g7f0)
let _toastTimer = null;
let _toastOrigText = null;
let _toastOrigClass = null;
function showStatusToast(msg, isError = false) {
  const el = document.getElementById('status');
  // Save the base state only on first (non-nested) toast
  if (_toastTimer === null) {
    _toastOrigText = el.textContent;
    _toastOrigClass = el.className;
  } else {
    clearTimeout(_toastTimer);
  }
  el.textContent = msg;
  el.className = isError ? 'error' : '';
  _toastTimer = setTimeout(() => {
    el.textContent = _toastOrigText;
    el.className = _toastOrigClass;
    _toastTimer = null;
  }, 2000);
}

// Floating toast notification for decision events (bd-tausm)
function showDecisionToast(evt) {
  const p = evt.payload || {};
  const type = evt.type;
  let text, cls;
  if (type === 'DecisionCreated') {
    const agent = p.requested_by || 'agent';
    const q = (p.question || 'decision').slice(0, 60);
    text = `? ${agent}: ${q}`;
    cls = p.urgency === 'high' ? 'decision-toast urgent' : 'decision-toast';
  } else if (type === 'DecisionResponded') {
    text = `✓ Decided: ${(p.chosen_label || 'resolved').slice(0, 40)}`;
    cls = 'decision-toast resolved';
  } else {
    return; // Only toast for created and responded
  }

  const toast = document.createElement('div');
  toast.className = cls;
  toast.textContent = text;
  // Click to focus the decision node
  if (p.decision_id) {
    toast.style.cursor = 'pointer';
    toast.addEventListener('click', () => {
      toast.remove();
      if (graphData) {
        const decNode = graphData.nodes.find(n => n.id === p.decision_id);
        if (decNode) handleNodeClick(decNode);
      }
    });
  }
  document.body.appendChild(toast);
  requestAnimationFrame(() => toast.classList.add('show'));
  setTimeout(() => {
    toast.classList.remove('show');
    setTimeout(() => toast.remove(), 300);
  }, 8000);
}

// Walk the dependency graph in one direction to build a subgraph highlight
function highlightSubgraph(node, direction) {
  selectedNode = node;
  highlightNodes.clear();
  highlightLinks.clear();

  const visited = new Set();
  const queue = [node.id];

  while (queue.length > 0) {
    const current = queue.shift();
    if (visited.has(current)) continue;
    visited.add(current);
    highlightNodes.add(current);

    for (const l of graphData.links) {
      const srcId = typeof l.source === 'object' ? l.source.id : l.source;
      const tgtId = typeof l.target === 'object' ? l.target.id : l.target;

      if (direction === 'downstream') {
        // Dependencies: this node depends on (source=node → target=dep)
        if (srcId === current) {
          highlightLinks.add(linkKey(l));
          if (!visited.has(tgtId)) queue.push(tgtId);
        }
      } else {
        // Blockers: what blocks this node (target=node ← source=blocker)
        if (tgtId === current) {
          highlightLinks.add(linkKey(l));
          if (!visited.has(srcId)) queue.push(srcId);
        }
      }
    }
  }

  graph.linkWidth(graph.linkWidth());
}

// --- Dep tree expansion: load full deps for a node via Show API ---
const expandedNodes = new Set(); // track which nodes have been expanded

async function expandDepTree(node) {
  if (expandedNodes.has(node.id)) {
    console.log(`[beads3d] ${node.id} already expanded`);
    return;
  }
  expandedNodes.add(node.id);

  const statusEl = document.getElementById('status');
  statusEl.textContent = `expanding ${node.id}...`;

  try {
    const full = await api.show(node.id);
    const existingIds = new Set(graphData.nodes.map(n => n.id));
    const existingLinks = new Set(graphData.links.map(l => linkKey(l)));
    let addedNodes = 0;
    let addedLinks = 0;

    // Process dependencies from Show response
    const deps = full.dependencies || [];
    for (const dep of deps) {
      const depId = dep.depends_on_id || dep.id;
      if (!depId) continue;

      const depType = dep.type || dep.dependency_type || 'blocks';

      // Add node if not already in graph
      if (!existingIds.has(depId)) {
        graphData.nodes.push({
          id: depId,
          title: dep.title || depId,
          status: dep.status || 'open',
          priority: dep.priority ?? 3,
          issue_type: dep.issue_type || 'task',
          assignee: dep.assignee || '',
          _blocked: false,
          _expanded: true,
        });
        existingIds.add(depId);
        addedNodes++;
      }

      // Add link if not already present
      const lk = `${node.id}->${depId}`;
      if (!existingLinks.has(lk)) {
        graphData.links.push({ source: node.id, target: depId, dep_type: depType });
        existingLinks.add(lk);
        addedLinks++;
      }
    }

    // Process blocked_by
    const blockedBy = full.blocked_by || [];
    for (const blockerId of blockedBy) {
      if (!blockerId) continue;

      if (!existingIds.has(blockerId)) {
        graphData.nodes.push({
          id: blockerId,
          title: blockerId,
          status: 'open',
          priority: 3,
          issue_type: 'task',
          _blocked: false,
          _expanded: true,
        });
        existingIds.add(blockerId);
        addedNodes++;
      }

      const lk = `${blockerId}->${node.id}`;
      if (!existingLinks.has(lk)) {
        graphData.links.push({ source: blockerId, target: node.id, dep_type: 'blocks' });
        existingLinks.add(lk);
        addedLinks++;
      }
    }

    // Fetch titles for newly added placeholder nodes (max 10, parallel)
    const untitledNodes = graphData.nodes.filter(n => n._expanded && n.title === n.id);
    await Promise.all(untitledNodes.slice(0, 10).map(async (n) => {
      try {
        const detail = await api.show(n.id);
        n.title = detail.title || n.id;
        n.status = detail.status || n.status;
        n.issue_type = detail.issue_type || n.issue_type;
        n.priority = detail.priority ?? n.priority;
        n.assignee = detail.assignee || n.assignee;
        n._blocked = !!(detail.blocked_by && detail.blocked_by.length > 0);
      } catch { /* placeholder stays as-is */ }
    }));

    // Update the graph — save/restore camera to prevent library auto-reposition (bd-7ccyd)
    const cam = graph.camera();
    const savedPos = cam.position.clone();
    const ctl = graph.controls();
    const savedTgt = ctl?.target?.clone();
    graph.graphData(graphData);
    cam.position.copy(savedPos);
    if (ctl && savedTgt) { ctl.target.copy(savedTgt); ctl.update(); }

    // Highlight the expanded subtree
    selectNode(node);

    statusEl.textContent = `expanded ${node.id}: +${addedNodes} nodes, +${addedLinks} links`;
    statusEl.className = 'connected';
    console.log(`[beads3d] Expanded ${node.id}: +${addedNodes} nodes, +${addedLinks} links`);
  } catch (err) {
    statusEl.textContent = `expand failed: ${err.message}`;
    statusEl.className = 'error';
    console.error(`[beads3d] Expand failed for ${node.id}:`, err);
  }
}

function copyToClipboard(text) {
  navigator.clipboard.writeText(text).catch(() => {
    // Fallback for non-HTTPS contexts
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
  });
}

function showCtxToast(msg) {
  const items = ctxMenu.querySelectorAll('.ctx-item');
  // Brief flash on the clicked item, then close
  setTimeout(() => hideContextMenu(), 400);
}

// Close context menu on any click elsewhere or Escape
document.addEventListener('click', (e) => {
  if (ctxMenu.style.display === 'block' && !ctxMenu.contains(e.target)) {
    hideContextMenu();
  }
});

// Suppress browser context menu on the graph canvas
document.getElementById('graph').addEventListener('contextmenu', (e) => e.preventDefault());

// --- Filtering ---
function applyFilters() {
  const q = searchFilter.toLowerCase();
  graphData.nodes.forEach(n => {
    n._revealed = false; // reset before re-evaluating (hq-vorf47)
    let hidden = false;

    // Text search
    if (q && !(n.id || '').toLowerCase().includes(q) &&
        !(n.title || '').toLowerCase().includes(q) &&
        !(n.assignee || '').toLowerCase().includes(q)) {
      hidden = true;
    }

    // Agent visibility controls (bd-n0971, bd-8o2gd)
    if (n.issue_type === 'agent') {
      const agentStatus = (n.status || '').toLowerCase();
      // Always hide closed/tombstone agents
      if (agentStatus === 'closed' || agentStatus === 'tombstone') {
        hidden = true;
      }
      // Master toggle: hide all agents (bd-8o2gd)
      if (!agentFilterShow) {
        hidden = true;
      }
      // Rig exclusion: hide agents on excluded rigs (bd-8o2gd)
      if (agentFilterRigExclude.size > 0 && n.rig && agentFilterRigExclude.has(n.rig)) {
        hidden = true;
      }
      // Name exclusion: hide agents matching glob patterns (bd-8o2gd phase 4)
      if (agentFilterNameExclude.length > 0) {
        const name = (n.id || '').toLowerCase();
        if (agentFilterNameExclude.some(p => globMatch(p, name))) hidden = true;
      }
    }

    // Status filter — agent nodes are exempt from user status filters (bd-keeha)
    if (statusFilter.size > 0 && n.issue_type !== 'agent' && !statusFilter.has(n.status)) {
      hidden = true;
    }

    // Type filter — agent nodes are always visible (bd-keeha)
    if (typeFilter.size > 0 && n.issue_type !== 'agent' && !typeFilter.has(n.issue_type)) {
      hidden = true;
    }

    // Priority filter (bd-8o2gd phase 2) — agents exempt
    if (priorityFilter.size > 0 && n.issue_type !== 'agent') {
      const p = n.priority != null ? String(n.priority) : null;
      if (p === null || !priorityFilter.has(p)) hidden = true;
    }

    // Assignee filter (bd-8o2gd phase 2) — agents exempt
    if (assigneeFilter && n.issue_type !== 'agent') {
      if ((n.assignee || '').toLowerCase() !== assigneeFilter.toLowerCase()) hidden = true;
    }

    // Age filter (bd-uc0mw): hide old closed beads, always show active/open/blocked/agent
    if (!hidden && activeAgeDays > 0 && n.status === 'closed') {
      const updatedAt = n.updated_at ? new Date(n.updated_at) : null;
      if (updatedAt) {
        const cutoff = Date.now() - activeAgeDays * 86400000;
        if (updatedAt.getTime() < cutoff) {
          hidden = true;
          n._ageFiltered = true;  // mark so we can rescue connected nodes below
        }
      }
    }

    // Hide resolved/expired/closed decisions — only show pending (bd-zr374)
    if (!hidden && (n.issue_type === 'gate' || n.issue_type === 'decision')) {
      const ds = n._decisionState || (n.status === 'closed' ? 'resolved' : 'pending');
      if (ds !== 'pending') hidden = true;
    }

    n._hidden = hidden;
    n._searchMatch = !hidden && !!q;
  });

  // Hide orphaned agents (bd-n0971, bd-8o2gd): if all of an agent's connected
  // beads are hidden, hide the agent too — unless agentFilterOrphaned is true.
  // Exception (bd-ixx3d): never hide agents with active/idle status — these are
  // live agents from the roster and must always be visible even without edges.
  for (const n of graphData.nodes) {
    if (n.issue_type !== 'agent' || n._hidden) continue;
    if (agentFilterOrphaned) continue; // bd-8o2gd: user wants to see orphaned agents
    const agentStatus = (n.status || '').toLowerCase();
    if (agentStatus === 'active' || agentStatus === 'idle') continue;
    const hasVisibleBead = graphData.links.some(l => {
      const srcId = typeof l.source === 'object' ? l.source.id : l.source;
      const tgtId = typeof l.target === 'object' ? l.target.id : l.target;
      if (srcId !== n.id) return false;
      const bead = graphData.nodes.find(nd => nd.id === tgtId);
      return bead && !bead._hidden;
    });
    if (!hasVisibleBead) n._hidden = true;
  }

  // Rescue age-filtered nodes that are directly connected to visible nodes (bd-uc0mw).
  // This ensures dependency chains remain visible even when old closed beads are culled.
  if (activeAgeDays > 0) {
    const visibleIds = new Set(graphData.nodes.filter(n => !n._hidden).map(n => n.id));
    for (const n of graphData.nodes) {
      if (!n._ageFiltered) continue;
      // Check if this age-filtered node has an edge to/from any visible node
      const connected = graphData.links.some(l => {
        const srcId = typeof l.source === 'object' ? l.source.id : l.source;
        const tgtId = typeof l.target === 'object' ? l.target.id : l.target;
        return (srcId === n.id && visibleIds.has(tgtId)) ||
               (tgtId === n.id && visibleIds.has(srcId));
      });
      if (connected) {
        n._hidden = false;
        n._ageFiltered = false;
      }
    }
  }

  // Click-to-reveal: force-show nodes in the revealed subgraph (hq-vorf47).
  // This overrides all filters for the connected component of the clicked node.
  if (revealedNodes.size > 0) {
    for (const nodeId of revealedNodes) {
      const rn = graphData.nodes.find(nd => nd.id === nodeId);
      if (rn) {
        rn._hidden = false;
        rn._revealed = true;
      }
    }
  }

  // Build ordered search results for navigation
  if (q) {
    searchResults = graphData.nodes
      .filter(n => n._searchMatch)
      .sort((a, b) => {
        const aId = (a.id || '').toLowerCase().includes(q) ? 0 : 1;
        const bId = (b.id || '').toLowerCase().includes(q) ? 0 : 1;
        if (aId !== bId) return aId - bId;
        const aTitle = (a.title || '').toLowerCase().includes(q) ? 0 : 1;
        const bTitle = (b.title || '').toLowerCase().includes(q) ? 0 : 1;
        if (aTitle !== bTitle) return aTitle - bTitle;
        return (a.priority ?? 9) - (b.priority ?? 9);
      });
    if (searchResults.length > 0) {
      searchResultIdx = Math.min(Math.max(searchResultIdx, 0), searchResults.length - 1);
    } else {
      searchResultIdx = -1;
    }
  } else {
    searchResults = [];
    searchResultIdx = -1;
  }

  // Trigger re-render
  graph.nodeVisibility(n => !n._hidden);
  graph.linkVisibility(l => {
    const src = typeof l.source === 'object' ? l.source : graphData.nodes.find(n => n.id === l.source);
    const tgt = typeof l.target === 'object' ? l.target : graphData.nodes.find(n => n.id === l.target);
    return src && tgt && !src._hidden && !tgt._hidden;
  });

  // Rebuild node objects when reveal state changes (ghost opacity) (hq-vorf47)
  if (revealedNodes.size > 0 || graphData.nodes.some(n => n._revealed)) {
    graph.nodeThreeObject(graph.nodeThreeObject());
  }

  updateFilterCount();
}

// Navigate search results: fly camera to the current match
function flyToSearchResult() {
  if (searchResults.length === 0 || searchResultIdx < 0) return;
  const node = searchResults[searchResultIdx];
  if (!node) return;

  selectNode(node);

  const distance = 150;
  const dx = node.x || 0, dy = node.y || 0, dz = node.z || 0;
  const distRatio = 1 + distance / (Math.hypot(dx, dy, dz) || 1);
  graph.cameraPosition(
    { x: dx * distRatio, y: dy * distRatio, z: dz * distRatio },
    node, 800
  );

  showDetail(node);
}

function nextSearchResult() {
  if (searchResults.length === 0) return;
  searchResultIdx = (searchResultIdx + 1) % searchResults.length;
  updateFilterCount();
  flyToSearchResult();
}

function prevSearchResult() {
  if (searchResults.length === 0) return;
  searchResultIdx = (searchResultIdx - 1 + searchResults.length) % searchResults.length;
  updateFilterCount();
  flyToSearchResult();
}

// --- Epic cycling: Shift+S/D navigation (bd-pnngb) ---

function rebuildEpicIndex() {
  const prev = _epicNodes.map(n => n.id).join(',');
  _epicNodes = graphData.nodes
    .filter(n => n.issue_type === 'epic' && !n._hidden)
    .sort((a, b) => (a.title || a.id).localeCompare(b.title || b.id));
  const curr = _epicNodes.map(n => n.id).join(',');
  // Reset index if the set of epics changed
  if (prev !== curr) _epicCycleIndex = -1;
}

function cycleEpic(delta) {
  if (_epicNodes.length === 0) return;
  if (_epicCycleIndex < 0) {
    _epicCycleIndex = delta > 0 ? 0 : _epicNodes.length - 1;
  } else {
    _epicCycleIndex = (_epicCycleIndex + delta + _epicNodes.length) % _epicNodes.length;
  }
  highlightEpic(_epicNodes[_epicCycleIndex]);
}

function highlightEpic(epicNode) {
  if (!epicNode) return;

  // Select the epic and fly camera to it
  selectNode(epicNode);
  const distance = 160;
  const dx = epicNode.x || 0, dy = epicNode.y || 0, dz = epicNode.z || 0;
  const distRatio = 1 + distance / (Math.hypot(dx, dy, dz) || 1);
  graph.cameraPosition(
    { x: dx * distRatio, y: dy * distRatio, z: dz * distRatio },
    epicNode, 800
  );

  // Find all child/descendant node IDs via parent-child edges.
  // Direction is inconsistent: raw edges have source=parent, target=child;
  // promoted blocks edges have source=child, target=parent (epic).
  // So we check both directions.
  const childIds = new Set();
  const queue = [epicNode.id];
  while (queue.length > 0) {
    const parentId = queue.shift();
    for (const l of graphData.links) {
      if (l.dep_type !== 'parent-child') continue;
      const srcId = typeof l.source === 'object' ? l.source.id : l.source;
      const tgtId = typeof l.target === 'object' ? l.target.id : l.target;
      let childId = null;
      if (srcId === parentId && !childIds.has(tgtId)) childId = tgtId;
      else if (tgtId === parentId && !childIds.has(srcId)) childId = srcId;
      if (childId) {
        childIds.add(childId);
        queue.push(childId);
      }
    }
  }

  // Dim non-descendant nodes, emphasize descendants
  for (const n of graphData.nodes) {
    const obj = n.__threeObj;
    if (!obj) continue;
    if (n.id === epicNode.id || childIds.has(n.id)) {
      obj.traverse(c => { if (c.material) c.material.opacity = 1.0; });
    } else {
      obj.traverse(c => { if (c.material) c.material.opacity = 0.15; });
    }
  }

  // Show detail panel
  showDetail(epicNode);

  // Show HUD indicator
  showEpicHUD(_epicCycleIndex, _epicNodes.length, epicNode.title || epicNode.id);
}

function clearEpicHighlight() {
  _epicCycleIndex = -1;
  restoreAllNodeOpacity();
  hideEpicHUD();
}

let _epicHUDEl = null;
let _epicHUDTimer = null;

function showEpicHUD(index, total, title) {
  if (!_epicHUDEl) {
    _epicHUDEl = document.createElement('div');
    _epicHUDEl.id = 'epic-hud';
    document.body.appendChild(_epicHUDEl);
  }
  _epicHUDEl.textContent = `Epic ${index + 1}/${total}: ${title}`;
  _epicHUDEl.style.display = 'block';
  _epicHUDEl.style.opacity = '1';

  // Auto-fade after 3 seconds of no cycling
  clearTimeout(_epicHUDTimer);
  _epicHUDTimer = setTimeout(() => {
    _epicHUDEl.style.opacity = '0';
    setTimeout(() => { if (_epicHUDEl) _epicHUDEl.style.display = 'none'; }, 400);
  }, 3000);
}

function hideEpicHUD() {
  clearTimeout(_epicHUDTimer);
  if (_epicHUDEl) {
    _epicHUDEl.style.display = 'none';
  }
}

// Populate rig filter pills in a container — clickable pills for each discovered rig (bd-8o2gd)
function _buildRigPillsIn(container, nodes) {
  if (!container) return;

  const rigs = new Set();
  for (const n of nodes) {
    if (n.issue_type === 'agent' && n.rig) rigs.add(n.rig);
  }
  const sortedRigs = [...rigs].sort();

  // Only rebuild if rig set changed
  const currentRigs = [...container.querySelectorAll('.rig-pill')].map(p => p.dataset.rig);
  if (currentRigs.length === sortedRigs.length && currentRigs.every((r, i) => r === sortedRigs[i])) {
    for (const pill of container.querySelectorAll('.rig-pill')) {
      pill.classList.toggle('excluded', agentFilterRigExclude.has(pill.dataset.rig));
    }
    return;
  }

  container.innerHTML = '';
  for (const rig of sortedRigs) {
    const pill = document.createElement('span');
    pill.className = 'rig-pill';
    pill.dataset.rig = rig;
    pill.textContent = rig;
    pill.style.color = rigColor(rig);
    pill.style.borderColor = rigColor(rig) + '66';
    pill.style.background = rigColor(rig) + '18';
    if (agentFilterRigExclude.has(rig)) pill.classList.add('excluded');
    pill.title = `Click to ${agentFilterRigExclude.has(rig) ? 'show' : 'hide'} agents on ${rig}`;
    pill.addEventListener('click', () => {
      if (agentFilterRigExclude.has(rig)) {
        agentFilterRigExclude.delete(rig);
      } else {
        agentFilterRigExclude.add(rig);
      }
      // Sync all rig pill containers
      _syncAllRigPills();
      applyFilters();
    });
    container.appendChild(pill);
  }
}

function _syncAllRigPills() {
  document.querySelectorAll('.rig-pill').forEach(pill => {
    const rig = pill.dataset.rig;
    pill.classList.toggle('excluded', agentFilterRigExclude.has(rig));
    pill.title = `Click to ${agentFilterRigExclude.has(rig) ? 'show' : 'hide'} agents on ${rig}`;
  });
}

function updateRigPills(nodes) {
  _buildRigPillsIn(document.getElementById('agent-rig-pills'), nodes);
  _buildRigPillsIn(document.getElementById('fd-rig-pills'), nodes);
}

// ── Filter Dashboard (bd-8o2gd phase 2) ─────────────────────────────────────

function toggleFilterDashboard() {
  const panel = document.getElementById('filter-dashboard');
  if (!panel) return;
  filterDashboardOpen = !filterDashboardOpen;
  panel.classList.toggle('open', filterDashboardOpen);
  if (filterDashboardOpen) syncFilterDashboard();
}

// Sync dashboard button states to match current filter state
function syncFilterDashboard() {
  // Status buttons
  document.querySelectorAll('.fd-status').forEach(btn => {
    const status = btn.dataset.status;
    const STATUS_GROUPS = { in_progress: ['in_progress', 'blocked', 'hooked', 'deferred'] };
    const group = STATUS_GROUPS[status] || [status];
    btn.classList.toggle('active', group.some(s => statusFilter.has(s)));
  });

  // Type buttons
  document.querySelectorAll('.fd-type').forEach(btn => {
    btn.classList.toggle('active', typeFilter.has(btn.dataset.type));
  });

  // Priority buttons
  document.querySelectorAll('.fd-priority').forEach(btn => {
    btn.classList.toggle('active', priorityFilter.has(btn.dataset.priority));
  });

  // Age buttons
  document.querySelectorAll('.fd-age').forEach(btn => {
    const days = parseInt(btn.dataset.days, 10);
    btn.classList.toggle('active', days === activeAgeDays);
  });

  // Agent toggles
  const fdShow = document.getElementById('fd-agent-show');
  const fdOrph = document.getElementById('fd-agent-orphaned');
  if (fdShow) fdShow.classList.toggle('active', agentFilterShow);
  if (fdOrph) fdOrph.classList.toggle('active', agentFilterOrphaned);

  // Assignee buttons
  updateAssigneeButtons();
}

// Sync toolbar controls to match dashboard changes
function syncToolbarControls() {
  // Status
  const STATUS_GROUPS = { in_progress: ['in_progress', 'blocked', 'hooked', 'deferred'] };
  document.querySelectorAll('.filter-status').forEach(btn => {
    const status = btn.dataset.status;
    const group = STATUS_GROUPS[status] || [status];
    btn.classList.toggle('active', group.some(s => statusFilter.has(s)));
  });
  // Type
  document.querySelectorAll('.filter-type').forEach(btn => {
    btn.classList.toggle('active', typeFilter.has(btn.dataset.type));
  });
  // Age
  document.querySelectorAll('.filter-age').forEach(btn => {
    const days = parseInt(btn.dataset.days, 10);
    btn.classList.toggle('active', days === activeAgeDays);
  });
  // Agent toggles
  const btnShow = document.getElementById('btn-agent-show');
  const btnOrph = document.getElementById('btn-agent-orphaned');
  if (btnShow) btnShow.classList.toggle('active', agentFilterShow);
  if (btnOrph) btnOrph.classList.toggle('active', agentFilterOrphaned);
}

function updateAssigneeButtons() {
  const body = document.getElementById('fd-assignee-body');
  if (!body) return;

  // Collect unique assignees from visible graph data
  const assignees = new Set();
  for (const n of graphData.nodes) {
    if (n.assignee && n.issue_type !== 'agent') assignees.add(n.assignee);
  }
  const sorted = [...assignees].sort();

  // Only rebuild if set changed
  const current = [...body.querySelectorAll('.fd-btn')].map(b => b.dataset.assignee);
  if (current.length === sorted.length && current.every((a, i) => a === sorted[i])) {
    body.querySelectorAll('.fd-btn').forEach(btn => {
      btn.classList.toggle('active', assigneeFilter === btn.dataset.assignee);
    });
    return;
  }

  body.innerHTML = '';
  for (const name of sorted) {
    const btn = document.createElement('button');
    btn.className = 'fd-btn';
    btn.dataset.assignee = name;
    btn.textContent = name;
    if (assigneeFilter === name) btn.classList.add('active');
    btn.addEventListener('click', () => {
      if (assigneeFilter === name) {
        assigneeFilter = '';
      } else {
        assigneeFilter = name;
      }
      body.querySelectorAll('.fd-btn').forEach(b => {
        b.classList.toggle('active', assigneeFilter === b.dataset.assignee);
      });
      applyFilters();
    });
    body.appendChild(btn);
  }
}

// ── Filter profile persistence (bd-8o2gd phase 3) ───────────────────────────

const PROFILE_KEY_PREFIX = 'beads3d.view.';
let _profilesLoaded = false;

function _currentFilterState() {
  return {
    status: [...statusFilter],
    types: [...typeFilter],
    priority: [...priorityFilter],
    age_days: activeAgeDays,
    assignee: assigneeFilter,
    agents: {
      show: agentFilterShow,
      orphaned: agentFilterOrphaned,
      rig_exclude: [...agentFilterRigExclude],
      name_exclude: agentFilterNameExclude.length > 0 ? [...agentFilterNameExclude] : [],
    },
  };
}

function _applyFilterState(state) {
  statusFilter.clear();
  (state.status || []).forEach(s => statusFilter.add(s));
  typeFilter.clear();
  (state.types || []).forEach(t => typeFilter.add(t));
  priorityFilter.clear();
  (state.priority || []).forEach(p => priorityFilter.add(String(p)));
  activeAgeDays = state.age_days ?? 7;
  assigneeFilter = state.assignee || '';
  if (state.agents) {
    agentFilterShow = state.agents.show !== false;
    agentFilterOrphaned = !!state.agents.orphaned;
    agentFilterRigExclude.clear();
    (state.agents.rig_exclude || []).forEach(r => agentFilterRigExclude.add(r));
    agentFilterNameExclude = state.agents.name_exclude || [];
    // Update the exclude input field
    const excludeInput = document.getElementById('fd-agent-exclude');
    if (excludeInput) excludeInput.value = agentFilterNameExclude.join(', ');
  }
  syncFilterDashboard();
  syncToolbarControls();
  _syncAllRigPills();
  // Age changes need re-fetch; for simplicity always refresh
  refresh();
}

async function loadFilterProfiles() {
  const select = document.getElementById('fd-profile-select');
  if (!select) return;

  try {
    const resp = await api.configList();
    const config = resp.config || {};
    // Clear existing options except default
    select.innerHTML = '<option value="">— default —</option>';
    const profiles = Object.keys(config)
      .filter(k => k.startsWith(PROFILE_KEY_PREFIX))
      .map(k => k.slice(PROFILE_KEY_PREFIX.length))
      .sort();
    for (const name of profiles) {
      const opt = document.createElement('option');
      opt.value = name;
      opt.textContent = name;
      select.appendChild(opt);
    }
    // Restore last selected profile from localStorage
    const lastProfile = localStorage.getItem('beads3d-filter-profile');
    if (lastProfile && profiles.includes(lastProfile)) {
      select.value = lastProfile;
    }
    _profilesLoaded = true;
  } catch (e) {
    console.warn('[beads3d] failed to load filter profiles:', e);
  }
}

async function saveFilterProfile(name) {
  if (!name) return;
  const state = _currentFilterState();
  try {
    await api.configSet(PROFILE_KEY_PREFIX + name, JSON.stringify(state));
    localStorage.setItem('beads3d-filter-profile', name);
    await loadFilterProfiles();
    const select = document.getElementById('fd-profile-select');
    if (select) select.value = name;
    console.log(`[beads3d] saved filter profile: ${name}`);
  } catch (e) {
    console.warn('[beads3d] failed to save filter profile:', e);
  }
}

async function loadFilterProfile(name) {
  if (!name) {
    // Default profile — clear all filters
    statusFilter.clear();
    typeFilter.clear();
    priorityFilter.clear();
    assigneeFilter = '';
    agentFilterShow = true;
    agentFilterOrphaned = false;
    agentFilterRigExclude.clear();
    activeAgeDays = 7;
    syncFilterDashboard();
    syncToolbarControls();
    _syncAllRigPills();
    localStorage.removeItem('beads3d-filter-profile');
    refresh();
    return;
  }

  try {
    const resp = await api.configGet(PROFILE_KEY_PREFIX + name);
    const state = JSON.parse(resp.value);
    _applyFilterState(state);
    localStorage.setItem('beads3d-filter-profile', name);
    console.log(`[beads3d] loaded filter profile: ${name}`);
  } catch (e) {
    console.warn(`[beads3d] failed to load profile ${name}:`, e);
  }
}

async function deleteFilterProfile(name) {
  if (!name) return;
  try {
    await api.configUnset(PROFILE_KEY_PREFIX + name);
    localStorage.removeItem('beads3d-filter-profile');
    await loadFilterProfiles();
    const select = document.getElementById('fd-profile-select');
    if (select) select.value = '';
    console.log(`[beads3d] deleted filter profile: ${name}`);
  } catch (e) {
    console.warn(`[beads3d] failed to delete profile ${name}:`, e);
  }
}

// Apply URL query params to filter state (bd-8o2gd phase 4)
async function applyUrlFilterParams() {
  let needRefresh = false;

  // ?profile=<name> — load a named profile
  if (URL_PROFILE) {
    await loadFilterProfile(URL_PROFILE);
    const select = document.getElementById('fd-profile-select');
    if (select) select.value = URL_PROFILE;
    return; // profile applies all settings; skip individual params
  }

  // ?status=open,in_progress — comma-separated status filter
  if (URL_STATUS) {
    statusFilter.clear();
    URL_STATUS.split(',').forEach(s => statusFilter.add(s.trim()));
    needRefresh = true;
  }

  // ?types=epic,bug — comma-separated type filter
  if (URL_TYPES) {
    typeFilter.clear();
    URL_TYPES.split(',').forEach(t => typeFilter.add(t.trim()));
    needRefresh = true;
  }

  // ?assignee=cool-trout — filter by assignee
  if (URL_ASSIGNEE) {
    assigneeFilter = URL_ASSIGNEE;
    needRefresh = true;
  }

  if (needRefresh) {
    syncFilterDashboard();
    syncToolbarControls();
    applyFilters();
  }
}

// Generate a shareable URL with current filter state (bd-8o2gd phase 4)
function getShareableUrl() {
  const url = new URL(window.location.href);
  // Clear old filter params
  url.searchParams.delete('profile');
  url.searchParams.delete('status');
  url.searchParams.delete('types');
  url.searchParams.delete('assignee');

  // Check if current state matches a saved profile
  const select = document.getElementById('fd-profile-select');
  if (select?.value) {
    url.searchParams.set('profile', select.value);
  } else {
    // Encode individual filter params
    if (statusFilter.size > 0) url.searchParams.set('status', [...statusFilter].join(','));
    if (typeFilter.size > 0) url.searchParams.set('types', [...typeFilter].join(','));
    if (assigneeFilter) url.searchParams.set('assignee', assigneeFilter);
  }

  return url.toString();
}

function initFilterDashboard() {
  const panel = document.getElementById('filter-dashboard');
  if (!panel) return;

  // Close button
  document.getElementById('fd-close')?.addEventListener('click', toggleFilterDashboard);

  // Collapsible sections
  panel.querySelectorAll('.fd-section-header').forEach(header => {
    header.addEventListener('click', () => {
      header.parentElement.classList.toggle('collapsed');
    });
  });

  const STATUS_GROUPS = {
    in_progress: ['in_progress', 'blocked', 'hooked', 'deferred'],
  };

  // Status buttons — sync with toolbar
  panel.querySelectorAll('.fd-status').forEach(btn => {
    btn.addEventListener('click', () => {
      const status = btn.dataset.status;
      const group = STATUS_GROUPS[status] || [status];
      btn.classList.toggle('active');
      if (statusFilter.has(status)) {
        group.forEach(s => statusFilter.delete(s));
      } else {
        group.forEach(s => statusFilter.add(s));
      }
      syncToolbarControls();
      applyFilters();
    });
  });

  // Type buttons — sync with toolbar
  panel.querySelectorAll('.fd-type').forEach(btn => {
    btn.addEventListener('click', () => {
      const type = btn.dataset.type;
      btn.classList.toggle('active');
      if (typeFilter.has(type)) {
        typeFilter.delete(type);
      } else {
        typeFilter.add(type);
      }
      syncToolbarControls();
      applyFilters();
    });
  });

  // Priority buttons (bd-8o2gd phase 2)
  panel.querySelectorAll('.fd-priority').forEach(btn => {
    btn.addEventListener('click', () => {
      const p = btn.dataset.priority;
      btn.classList.toggle('active');
      if (priorityFilter.has(p)) {
        priorityFilter.delete(p);
      } else {
        priorityFilter.add(p);
      }
      applyFilters();
    });
  });

  // Age buttons — sync with toolbar (triggers re-fetch)
  panel.querySelectorAll('.fd-age').forEach(btn => {
    btn.addEventListener('click', () => {
      const newDays = parseInt(btn.dataset.days, 10);
      if (newDays === activeAgeDays) return;
      panel.querySelectorAll('.fd-age').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      activeAgeDays = newDays;
      syncToolbarControls();
      refresh();
    });
  });

  // Agent show/orphaned toggles — sync with toolbar
  document.getElementById('fd-agent-show')?.addEventListener('click', () => {
    agentFilterShow = !agentFilterShow;
    document.getElementById('fd-agent-show')?.classList.toggle('active', agentFilterShow);
    syncToolbarControls();
    applyFilters();
  });

  document.getElementById('fd-agent-orphaned')?.addEventListener('click', () => {
    agentFilterOrphaned = !agentFilterOrphaned;
    document.getElementById('fd-agent-orphaned')?.classList.toggle('active', agentFilterOrphaned);
    syncToolbarControls();
    applyFilters();
  });

  // Agent name exclusion input — glob patterns, comma-separated (bd-8o2gd phase 4)
  const agentExcludeInput = document.getElementById('fd-agent-exclude');
  if (agentExcludeInput) {
    agentExcludeInput.addEventListener('input', () => {
      const val = agentExcludeInput.value.trim();
      agentFilterNameExclude = val ? val.split(',').map(p => p.trim().toLowerCase()).filter(Boolean) : [];
      applyFilters();
    });
  }

  // Share button — copy shareable URL to clipboard (bd-8o2gd phase 4)
  document.getElementById('fd-share')?.addEventListener('click', () => {
    const url = getShareableUrl();
    navigator.clipboard.writeText(url).then(() => {
      const btn = document.getElementById('fd-share');
      if (btn) { btn.textContent = 'copied!'; setTimeout(() => { btn.textContent = 'share'; }, 1500); }
    }).catch(() => {
      prompt('Copy this URL:', url);
    });
  });

  // Reset button
  document.getElementById('fd-reset')?.addEventListener('click', () => {
    statusFilter.clear();
    typeFilter.clear();
    priorityFilter.clear();
    assigneeFilter = '';
    agentFilterShow = true;
    agentFilterOrphaned = false;
    agentFilterRigExclude.clear();
    agentFilterNameExclude = [];
    const excludeInput = document.getElementById('fd-agent-exclude');
    if (excludeInput) excludeInput.value = '';
    activeAgeDays = 7;
    syncFilterDashboard();
    syncToolbarControls();
    _syncAllRigPills();
    refresh();
  });

  // ── Profile persistence (bd-8o2gd phase 3) ──────────────────────────────

  const profileSelect = document.getElementById('fd-profile-select');
  const btnSave = document.getElementById('fd-profile-save');
  const btnSaveAs = document.getElementById('fd-profile-save-as');
  const btnDelete = document.getElementById('fd-profile-delete');

  // Load profile list, then apply URL params (bd-8o2gd phase 4)
  loadFilterProfiles().then(() => {
    applyUrlFilterParams();
  });

  // Profile dropdown change — load selected profile
  profileSelect?.addEventListener('change', () => {
    loadFilterProfile(profileSelect.value);
  });

  // Save — overwrite currently selected profile
  btnSave?.addEventListener('click', () => {
    const name = profileSelect?.value;
    if (!name) {
      // No profile selected — prompt for name
      const newName = prompt('Profile name:');
      if (newName) saveFilterProfile(newName.trim());
    } else {
      saveFilterProfile(name);
    }
  });

  // Save As — always prompt for new name
  btnSaveAs?.addEventListener('click', () => {
    const newName = prompt('New profile name:');
    if (newName) saveFilterProfile(newName.trim());
  });

  // Delete — remove currently selected profile
  btnDelete?.addEventListener('click', () => {
    const name = profileSelect?.value;
    if (!name) return;
    if (confirm(`Delete profile "${name}"?`)) {
      deleteFilterProfile(name);
    }
  });
}

function updateFilterCount() {
  const visible = graphData.nodes.filter(n => !n._hidden).length;
  const total = graphData.nodes.length;
  const el = document.getElementById('filter-count');
  if (el) {
    if (searchResults.length > 0) {
      el.textContent = `${searchResultIdx + 1}/${searchResults.length} matches · ${visible}/${total}`;
    } else if (visible < total) {
      el.textContent = `${visible}/${total}`;
    } else {
      el.textContent = `${total}`;
    }
  }
  // Update filter dashboard node count (bd-8o2gd phase 2)
  const fdCount = document.getElementById('fd-node-count');
  if (fdCount) fdCount.textContent = `${visible}/${total} nodes`;
}

// --- Layout modes ---
let currentLayout = 'free';

function clearLayoutGuides() {
  const scene = graph.scene();
  for (const obj of layoutGuides) {
    scene.remove(obj);
    if (obj.geometry) obj.geometry.dispose();
    if (obj.material) obj.material.dispose();
    // Sprite sheets
    if (obj.material && obj.material.map) obj.material.map.dispose();
  }
  layoutGuides = [];
}

function makeTextSprite(text, opts = {}) {
  const fontSize = opts.fontSize || 24;
  const color = opts.color || '#4a9eff';
  const bg = opts.background || null; // e.g. 'rgba(10, 10, 18, 0.85)'
  const padding = bg ? 10 : 8;
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  ctx.font = `${fontSize}px SF Mono, Fira Code, monospace`;
  const metrics = ctx.measureText(text);
  canvas.width = Math.ceil(metrics.width) + padding * 2;
  canvas.height = fontSize + padding * 2;
  // Background (bd-jy0yt)
  if (bg) {
    ctx.fillStyle = bg;
    const r = 4, cw = canvas.width, ch = canvas.height;
    ctx.beginPath();
    ctx.moveTo(r, 0);
    ctx.lineTo(cw - r, 0); ctx.arcTo(cw, 0, cw, r, r);
    ctx.lineTo(cw, ch - r); ctx.arcTo(cw, ch, cw - r, ch, r);
    ctx.lineTo(r, ch); ctx.arcTo(0, ch, 0, ch - r, r);
    ctx.lineTo(0, r); ctx.arcTo(0, 0, r, 0, r);
    ctx.closePath();
    ctx.fill();
  }
  ctx.font = `${fontSize}px SF Mono, Fira Code, monospace`;
  ctx.fillStyle = color;
  ctx.textBaseline = 'top';
  ctx.fillText(text, padding, padding);
  const tex = new THREE.CanvasTexture(canvas);
  tex.minFilter = THREE.LinearFilter;
  const screenSpace = opts.sizeAttenuation === false;
  const mat = new THREE.SpriteMaterial({
    map: tex, transparent: true, opacity: opts.opacity || 0.6,
    depthWrite: false, depthTest: false,
    sizeAttenuation: !screenSpace,
  });
  const sprite = new THREE.Sprite(mat);
  if (screenSpace) {
    const aspect = canvas.width / canvas.height;
    const spriteH = opts.screenHeight || 0.03; // fraction of viewport height
    sprite.scale.set(spriteH * aspect, spriteH, 1);
  } else {
    sprite.scale.set(canvas.width / 4, canvas.height / 4, 1);
  }
  return sprite;
}

function addRadialGuides() {
  const scene = graph.scene();
  const radiusScale = 80; // match radial layout force (bd-22dga)
  const labels = ['P0', 'P1', 'P2', 'P3', 'P4'];
  for (let p = 0; p <= 4; p++) {
    const r = (p + 0.5) * radiusScale;
    // Ring in XZ plane
    const ringGeo = new THREE.RingGeometry(r - 0.3, r + 0.3, 64);
    const ringMat = new THREE.MeshBasicMaterial({ color: 0x1a2a3a, transparent: true, opacity: 0.15, side: THREE.DoubleSide });
    const ring = new THREE.Mesh(ringGeo, ringMat);
    ring.rotation.x = -Math.PI / 2; // lay flat in XZ
    scene.add(ring);
    layoutGuides.push(ring);

    // Priority label
    const label = makeTextSprite(labels[p], { fontSize: 20, color: '#2a3a4a', opacity: 0.4 });
    label.position.set(r + 8, 2, 0);
    scene.add(label);
    layoutGuides.push(label);
  }
}

function addTimelineGuides(nodes) {
  const scene = graph.scene();
  const times = nodes.map(n => new Date(n.created_at || 0).getTime()).filter(t => t > 0);
  if (times.length === 0) return;
  const minTime = Math.min(...times);
  const maxTime = Math.max(...times);
  const timeSpan = maxTime - minTime || 1;
  const nodeCount = nodes.length || 100;
  const spread = Math.max(nodeCount * 2, 400);

  // Time axis line (X axis)
  const axisGeo = new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(-spread / 2 - 20, 0, 0),
    new THREE.Vector3(spread / 2 + 20, 0, 0),
  ]);
  const axisMat = new THREE.LineBasicMaterial({ color: 0x1a2a3a, transparent: true, opacity: 0.3 });
  const axis = new THREE.Line(axisGeo, axisMat);
  scene.add(axis);
  layoutGuides.push(axis);

  // Date tick marks — one per month (approximate)
  const msPerMonth = 30 * 24 * 3600 * 1000;
  const startMonth = new Date(minTime);
  startMonth.setDate(1);
  startMonth.setHours(0, 0, 0, 0);
  let tickTime = startMonth.getTime();
  while (tickTime <= maxTime + msPerMonth) {
    const x = ((tickTime - minTime) / timeSpan - 0.5) * spread;
    const d = new Date(tickTime);
    const label = makeTextSprite(
      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`,
      { fontSize: 16, color: '#2a3a4a', opacity: 0.35 }
    );
    label.position.set(x, -8, 0);
    scene.add(label);
    layoutGuides.push(label);

    // Vertical tick
    const tickGeo = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(x, -3, 0),
      new THREE.Vector3(x, 3, 0),
    ]);
    const tick = new THREE.Line(tickGeo, new THREE.LineBasicMaterial({ color: 0x1a2a3a, transparent: true, opacity: 0.2 }));
    scene.add(tick);
    layoutGuides.push(tick);

    tickTime += msPerMonth;
  }

  // Priority zone labels on Z axis
  const pLabels = ['P0', 'P1', 'P2', 'P3', 'P4'];
  for (let p = 0; p <= 4; p++) {
    const z = (p - 2) * 30;
    const label = makeTextSprite(pLabels[p], { fontSize: 16, color: '#2a3a4a', opacity: 0.3 });
    label.position.set(-spread / 2 - 30, 0, z);
    scene.add(label);
    layoutGuides.push(label);
  }
}

function addClusterGuides(nodes) {
  const scene = graph.scene();
  const assignees = [...new Set(nodes.map(n => n.assignee || '(unassigned)'))];
  const clusterRadius = Math.max(assignees.length * 40, 150);

  assignees.forEach((a, i) => {
    const angle = (i / assignees.length) * Math.PI * 2;
    const x = Math.cos(angle) * clusterRadius;
    const z = Math.sin(angle) * clusterRadius;

    // Assignee label
    const label = makeTextSprite(a, { fontSize: 22, color: '#ff6b35', opacity: 0.5 });
    label.position.set(x, 15, z);
    scene.add(label);
    layoutGuides.push(label);

    // Small anchor ring at cluster center
    const ringGeo = new THREE.RingGeometry(8, 10, 24);
    const ringMat = new THREE.MeshBasicMaterial({ color: 0xff6b35, transparent: true, opacity: 0.08, side: THREE.DoubleSide });
    const ring = new THREE.Mesh(ringGeo, ringMat);
    ring.position.set(x, 0, z);
    ring.rotation.x = -Math.PI / 2;
    scene.add(ring);
    layoutGuides.push(ring);
  });
}

function setLayout(mode) {
  currentLayout = mode;

  // Highlight active button
  document.querySelectorAll('#layout-controls button').forEach(b => b.classList.remove('active'));
  const btn = document.getElementById(`btn-layout-${mode}`);
  if (btn) btn.classList.add('active');
  const layoutSel = document.getElementById('cp-layout-mode');
  if (layoutSel && layoutSel.value !== mode) layoutSel.value = mode;

  // Clear all custom forces and visual guides
  clearLayoutGuides();
  graph.dagMode(null);
  graph.d3Force('timeline', null);
  graph.d3Force('radialPriority', null);
  graph.d3Force('clusterAssignee', null);
  graph.d3Force('flattenY', null);
  graph.d3Force('flattenZ', null);

  // Restore default forces
  const nodeCount = graphData.nodes.length || 100;

  switch (mode) {
    case 'free':
      graph.d3Force('charge').strength(nodeCount > 200 ? -60 : -120).distanceMax(400);
      graph.d3Force('link').distance(nodeCount > 200 ? 40 : 60);
      break;

    case 'dag': {
      // Hierarchical top-down: dagMode positions Y by depth.
      // Add stronger charge repulsion in X/Z to spread nodes within layers. (bd-22dga)
      graph.dagMode('td');
      graph.d3Force('charge').strength(-80).distanceMax(500);
      graph.d3Force('link').distance(50);
      graph.dagLevelDistance(60);
      // Flatten Z so layers are clearly visible in the X-Y plane.
      graph.d3Force('flattenZ', (alpha) => {
        for (const node of graphData.nodes) {
          if (node._hidden) continue;
          node.vz += (0 - (node.z || 0)) * alpha * 0.3;
        }
      });
      graph.cameraPosition({ x: 0, y: 0, z: 500 }, { x: 0, y: 0, z: 0 }, 1200);
      break;
    }

    case 'timeline': {
      // Flat plane: X = creation date, Y = 0 (flattened), Z = priority spread
      graph.d3Force('charge').strength(-30).distanceMax(200);
      graph.d3Force('link').distance(20);

      // Compute time range for normalization
      const times = graphData.nodes.map(n => new Date(n.created_at || 0).getTime()).filter(t => t > 0);
      const minTime = Math.min(...times) || 0;
      const maxTime = Math.max(...times) || 1;
      const timeSpan = maxTime - minTime || 1;
      const spread = Math.max(nodeCount * 2, 400);

      graph.d3Force('timeline', (alpha) => {
        for (const node of graphData.nodes) {
          if (node._hidden) continue;
          const t = new Date(node.created_at || 0).getTime();
          const xTarget = ((t - minTime) / timeSpan - 0.5) * spread;
          const zTarget = (node.priority - 2) * 30; // spread by priority on Z
          node.vx += (xTarget - node.x) * alpha * 0.1;
          node.vz += (zTarget - (node.z || 0)) * alpha * 0.05;
        }
      });
      // Flatten Y axis
      graph.d3Force('flattenY', (alpha) => {
        for (const node of graphData.nodes) {
          if (node._hidden) continue;
          node.vy += (0 - (node.y || 0)) * alpha * 0.3;
        }
      });
      addTimelineGuides(graphData.nodes);
      // Side camera to see the timeline plane
      graph.cameraPosition({ x: 0, y: 300, z: 200 }, { x: 0, y: 0, z: 0 }, 1200);
      break;
    }

    case 'radial': {
      // Radial: distance from center = priority (P0 center, P4 outer). (bd-22dga)
      // Weaker charge so radial force dominates; stronger damping for distinct rings.
      graph.d3Force('charge').strength(-8).distanceMax(120);
      graph.d3Force('link').distance(15);

      const radiusScale = 80; // pixels per priority level (wider rings)
      graph.d3Force('radialPriority', (alpha) => {
        for (const node of graphData.nodes) {
          if (node._hidden) continue;
          const targetR = (node.priority + 0.5) * radiusScale;
          const x = node.x || 0;
          const z = node.z || 0;
          const currentR = Math.sqrt(x * x + z * z) || 1;
          const factor = (targetR / currentR - 1) * alpha * 0.5;
          node.vx += x * factor;
          node.vz += z * factor;
        }
      });
      // Flatten Y for a disc layout
      graph.d3Force('flattenY', (alpha) => {
        for (const node of graphData.nodes) {
          if (node._hidden) continue;
          node.vy += (0 - (node.y || 0)) * alpha * 0.5;
        }
      });
      addRadialGuides();
      // Top-down camera for disc view
      graph.cameraPosition({ x: 0, y: 500, z: 50 }, { x: 0, y: 0, z: 0 }, 1200);
      break;
    }

    case 'cluster': {
      // Cluster by assignee: each assignee gets an anchor point on a circle. (bd-22dga)
      // Weaker charge within clusters; stronger anchor damping for distinct grouping.
      graph.d3Force('charge').strength(-10).distanceMax(100);
      graph.d3Force('link').distance(15);

      // Build assignee → anchor position map (wider circle for clear separation)
      const assignees = [...new Set(graphData.nodes.map(n => n.assignee || '(unassigned)'))];
      const anchorMap = {};
      const clusterRadius = Math.max(assignees.length * 60, 200);
      assignees.forEach((a, i) => {
        const angle = (i / assignees.length) * Math.PI * 2;
        anchorMap[a] = {
          x: Math.cos(angle) * clusterRadius,
          z: Math.sin(angle) * clusterRadius,
        };
      });

      graph.d3Force('clusterAssignee', (alpha) => {
        for (const node of graphData.nodes) {
          if (node._hidden) continue;
          const anchor = anchorMap[node.assignee || '(unassigned)'];
          if (!anchor) continue;
          node.vx += (anchor.x - (node.x || 0)) * alpha * 0.4;
          node.vz += (anchor.z - (node.z || 0)) * alpha * 0.4;
        }
      });
      // Flatten Y for a disc layout
      graph.d3Force('flattenY', (alpha) => {
        for (const node of graphData.nodes) {
          if (node._hidden) continue;
          node.vy += (0 - (node.y || 0)) * alpha * 0.5;
        }
      });
      addClusterGuides(graphData.nodes);
      // Top-down camera for cluster disc view
      graph.cameraPosition({ x: 0, y: 500, z: 50 }, { x: 0, y: 0, z: 0 }, 1200);
      break;
    }
  }

  // Reheat simulation to animate the transition
  graph.d3ReheatSimulation();

  // Re-apply agent tether force (survives layout changes)
  setupAgentTether();
}

// --- DAG Dragging Subtree (beads-6253) ---
// Returns array of {node, depth} for all nodes reachable from startId.
// Agents: follow assigned_to edges downstream only.
// Beads: follow all edge types bidirectionally (full connected component).
function getDragSubtree(startId) {
  const nodeById = new Map();
  for (const n of graphData.nodes) {
    if (!n._hidden) nodeById.set(n.id, n);
  }

  const result = [];
  const visited = new Set();
  const queue = [{ id: startId, depth: 0 }];
  const startNode = nodeById.get(startId);
  const isAgent = startNode && startNode.issue_type === 'agent';

  while (queue.length > 0) {
    const { id, depth } = queue.shift();
    if (visited.has(id)) continue;
    visited.add(id);
    const node = nodeById.get(id);
    if (!node) continue;
    result.push({ node, depth });

    // Max 4 hops to limit subtree size
    if (depth >= 4) continue;

    for (const l of graphData.links) {
      const srcId = typeof l.source === 'object' ? l.source.id : l.source;
      const tgtId = typeof l.target === 'object' ? l.target.id : l.target;

      if (isAgent) {
        // Agents: only follow outgoing assigned_to edges, then deps downstream
        if (srcId === id && !visited.has(tgtId)) {
          queue.push({ id: tgtId, depth: depth + 1 });
        }
      } else {
        // Beads: follow edges bidirectionally
        if (srcId === id && !visited.has(tgtId)) {
          queue.push({ id: tgtId, depth: depth + 1 });
        }
        if (tgtId === id && !visited.has(srcId)) {
          queue.push({ id: srcId, depth: depth + 1 });
        }
      }
    }
  }
  return result;
}

// --- Agent DAG Tether (beads-1gx1) ---
// Strong elastic coupling between agent nodes and their claimed bead subtrees.
// When an agent moves (drag or force), its beads follow like a kite tail.
// Force propagates: agent → assigned bead → bead's dependencies (with decay).
function setupAgentTether() {
  graph.d3Force('agentTether', (alpha) => {
    // Build agent → bead adjacency from current links
    const nodeById = new Map();
    for (const n of graphData.nodes) {
      if (!n._hidden) nodeById.set(n.id, n);
    }

    // Collect agent→bead assignments
    const agentBeads = new Map(); // agentId → [beadNode, ...]
    for (const l of graphData.links) {
      if (l.dep_type !== 'assigned_to') continue;
      const srcId = typeof l.source === 'object' ? l.source.id : l.source;
      const tgtId = typeof l.target === 'object' ? l.target.id : l.target;
      const agent = nodeById.get(srcId);
      const bead = nodeById.get(tgtId);
      if (!agent || !bead || agent.issue_type !== 'agent') continue;
      if (!agentBeads.has(srcId)) agentBeads.set(srcId, []);
      agentBeads.get(srcId).push(bead);
    }

    // Build dep adjacency for subtree traversal (bead → its deps)
    const deps = new Map(); // nodeId → [depNode, ...]
    for (const l of graphData.links) {
      if (l.dep_type === 'assigned_to') continue;
      const srcId = typeof l.source === 'object' ? l.source.id : l.source;
      const tgtId = typeof l.target === 'object' ? l.target.id : l.target;
      // parent→child and blocks edges: target is the dependent
      const parent = nodeById.get(srcId);
      const child = nodeById.get(tgtId);
      if (!parent || !child) continue;
      if (!deps.has(srcId)) deps.set(srcId, []);
      deps.get(srcId).push(child);
    }

    // Apply spring force: agent pulls beads, beads pull deps (with decay)
    const TETHER_STRENGTH = 0.08;  // direct agent→bead coupling
    const DECAY = 0.5;             // force halves per hop
    const REST_DIST = 25;          // desired agent→bead distance

    for (const [agentId, beads] of agentBeads) {
      const agent = nodeById.get(agentId);
      if (!agent || agent.x === undefined) continue;

      // BFS from agent through beads and their deps
      const queue = beads.map(b => ({ node: b, depth: 1 }));
      const visited = new Set([agentId]);

      while (queue.length > 0) {
        const { node, depth } = queue.shift();
        if (visited.has(node.id)) continue;
        visited.add(node.id);
        if (node.x === undefined) continue;

        const strength = TETHER_STRENGTH * Math.pow(DECAY, depth - 1);
        const dx = agent.x - node.x;
        const dy = agent.y - node.y;
        const dz = (agent.z || 0) - (node.z || 0);
        const dist = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;

        // Only apply pull when beyond rest distance
        if (dist > REST_DIST * depth) {
          const pull = strength * alpha;
          node.vx += dx * pull;
          node.vy += dy * pull;
          node.vz += dz * pull;
          // Slight counter-force on agent (Newton's 3rd, dampened)
          const counterPull = pull * 0.1;
          agent.vx -= dx * counterPull;
          agent.vy -= dy * counterPull;
          agent.vz -= dz * counterPull;
        }

        // Enqueue this node's deps (up to 3 hops)
        if (depth < 3) {
          const children = deps.get(node.id) || [];
          for (const child of children) {
            if (!visited.has(child.id)) {
              queue.push({ node: child, depth: depth + 1 });
            }
          }
        }
      }
    }
  });
}

// --- Screenshot & Export ---
function captureScreenshot() {
  const renderer = graph.renderer();
  const canvas = renderer.domElement;

  // Force a render to ensure the buffer is fresh
  renderer.render(graph.scene(), graph.camera());

  const dataUrl = canvas.toDataURL('image/png');
  const link = document.createElement('a');
  link.download = `beads3d-${new Date().toISOString().slice(0, 19).replace(/:/g, '')}.png`;
  link.href = dataUrl;
  link.click();

  const statusEl = document.getElementById('status');
  statusEl.textContent = 'screenshot saved';
  statusEl.className = 'connected';
}

function exportGraphJSON() {
  const visibleNodes = graphData.nodes.filter(n => !n._hidden);
  const visibleIds = new Set(visibleNodes.map(n => n.id));
  const visibleLinks = graphData.links.filter(l => {
    const srcId = typeof l.source === 'object' ? l.source.id : l.source;
    const tgtId = typeof l.target === 'object' ? l.target.id : l.target;
    return visibleIds.has(srcId) && visibleIds.has(tgtId);
  });

  const exportData = {
    exported_at: new Date().toISOString(),
    filters: {
      search: searchFilter || null,
      status: statusFilter.size > 0 ? [...statusFilter] : null,
      type: typeFilter.size > 0 ? [...typeFilter] : null,
      agents: {
        show: agentFilterShow,
        orphaned: agentFilterOrphaned,
        rig_exclude: agentFilterRigExclude.size > 0 ? [...agentFilterRigExclude] : null,
      },
    },
    stats: {
      total_nodes: graphData.nodes.length,
      visible_nodes: visibleNodes.length,
      visible_links: visibleLinks.length,
    },
    nodes: visibleNodes.map(n => ({
      id: n.id,
      title: n.title,
      status: n.status,
      priority: n.priority,
      issue_type: n.issue_type,
      assignee: n.assignee || null,
      blocked: !!n._blocked,
      x: n.x ? Math.round(n.x * 10) / 10 : null,
      y: n.y ? Math.round(n.y * 10) / 10 : null,
      z: n.z ? Math.round(n.z * 10) / 10 : null,
    })),
    links: visibleLinks.map(l => ({
      source: typeof l.source === 'object' ? l.source.id : l.source,
      target: typeof l.target === 'object' ? l.target.id : l.target,
      dep_type: l.dep_type,
    })),
  };

  const json = JSON.stringify(exportData, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.download = `beads3d-${new Date().toISOString().slice(0, 19).replace(/:/g, '')}.json`;
  link.href = url;
  link.click();
  URL.revokeObjectURL(url);

  const statusEl = document.getElementById('status');
  statusEl.textContent = `exported ${visibleNodes.length} nodes, ${visibleLinks.length} links`;
  statusEl.className = 'connected';
}

// --- Rubber-band selection (shift+drag) ---
const selectOverlay = document.getElementById('select-overlay');
const selectCtx = selectOverlay.getContext('2d');
const bulkMenu = document.getElementById('bulk-menu');

function resizeSelectOverlay() {
  selectOverlay.width = window.innerWidth;
  selectOverlay.height = window.innerHeight;
}
window.addEventListener('resize', resizeSelectOverlay);
resizeSelectOverlay();

// Project a 3D node position to 2D screen coordinates
function nodeToScreen(node) {
  const camera = graph.camera();
  const renderer = graph.renderer();
  const { width, height } = renderer.domElement.getBoundingClientRect();
  const vec = new THREE.Vector3(node.x || 0, node.y || 0, node.z || 0);
  vec.project(camera);
  return {
    x: (vec.x * 0.5 + 0.5) * width,
    y: (-vec.y * 0.5 + 0.5) * height,
  };
}

function setupBoxSelect() {
  const graphEl = document.getElementById('graph');

  graphEl.addEventListener('mousedown', (e) => {
    if (!e.shiftKey || e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();

    isBoxSelecting = true;
    boxSelectStart = { x: e.clientX, y: e.clientY };
    selectOverlay.style.display = 'block';
    selectOverlay.style.pointerEvents = 'auto';

    // Disable orbit controls during box select
    const controls = graph.controls();
    if (controls) controls.enabled = false;
  });

  // Use document-level listeners so drag works even if mouse leaves graph
  document.addEventListener('mousemove', (e) => {
    if (!isBoxSelecting) return;
    e.preventDefault();

    const x0 = Math.min(boxSelectStart.x, e.clientX);
    const y0 = Math.min(boxSelectStart.y, e.clientY);
    const w = Math.abs(e.clientX - boxSelectStart.x);
    const h = Math.abs(e.clientY - boxSelectStart.y);

    selectCtx.clearRect(0, 0, selectOverlay.width, selectOverlay.height);

    // Draw selection rectangle
    selectCtx.fillStyle = 'rgba(74, 158, 255, 0.08)';
    selectCtx.fillRect(x0, y0, w, h);
    selectCtx.strokeStyle = 'rgba(74, 158, 255, 0.6)';
    selectCtx.lineWidth = 1;
    selectCtx.setLineDash([4, 4]);
    selectCtx.strokeRect(x0, y0, w, h);
    selectCtx.setLineDash([]);

    // Live preview: highlight nodes inside the rectangle
    const previewSet = new Set();
    for (const node of graphData.nodes) {
      if (node._hidden || node.issue_type === 'agent') continue;
      const screen = nodeToScreen(node);
      if (screen.x >= x0 && screen.x <= x0 + w && screen.y >= y0 && screen.y <= y0 + h) {
        previewSet.add(node.id);
        // Draw a small indicator dot on the overlay
        selectCtx.beginPath();
        selectCtx.arc(screen.x, screen.y, 4, 0, Math.PI * 2);
        selectCtx.fillStyle = 'rgba(74, 158, 255, 0.5)';
        selectCtx.fill();
      }
    }
    multiSelected = previewSet;
  });

  document.addEventListener('mouseup', (e) => {
    if (!isBoxSelecting) return;
    isBoxSelecting = false;
    selectOverlay.style.display = 'none';
    selectOverlay.style.pointerEvents = 'none';
    selectCtx.clearRect(0, 0, selectOverlay.width, selectOverlay.height);

    // Re-enable orbit controls (will be re-frozen by centerCameraOnSelection if multi-select)
    const controls = graph.controls();
    if (controls) controls.enabled = true;

    // Finalize selection
    if (multiSelected.size > 0) {
      // Highlight connected nodes/links for the selection
      highlightNodes.clear();
      highlightLinks.clear();
      for (const id of multiSelected) highlightNodes.add(id);
      for (const l of graphData.links) {
        const srcId = typeof l.source === 'object' ? l.source.id : l.source;
        const tgtId = typeof l.target === 'object' ? l.target.id : l.target;
        if (multiSelected.has(srcId) || multiSelected.has(tgtId)) {
          highlightNodes.add(srcId);
          highlightNodes.add(tgtId);
          highlightLinks.add(linkKey(l));
        }
      }
      graph.linkWidth(graph.linkWidth());

      // Center camera on selection and freeze controls (bd-casin)
      centerCameraOnSelection();

      showBulkMenu(e.clientX, e.clientY);
    }
  });
}

function buildBulkStatusSubmenu() {
  const statuses = [
    { value: 'open', label: 'open', color: '#2d8a4e' },
    { value: 'in_progress', label: 'in progress', color: '#d4a017' },
    { value: 'closed', label: 'closed', color: '#333340' },
  ];
  return statuses.map(s =>
    `<div class="bulk-item" data-action="bulk-status" data-value="${s.value}">` +
    `<span class="ctx-dot" style="background:${s.color}"></span>${s.label}</div>`
  ).join('');
}

function buildBulkPrioritySubmenu() {
  const priorities = [
    { value: 0, label: 'P0 critical', color: '#ff3333' },
    { value: 1, label: 'P1 high', color: '#ff8833' },
    { value: 2, label: 'P2 medium', color: '#d4a017' },
    { value: 3, label: 'P3 low', color: '#4a9eff' },
    { value: 4, label: 'P4 backlog', color: '#666' },
  ];
  return priorities.map(p =>
    `<div class="bulk-item" data-action="bulk-priority" data-value="${p.value}">` +
    `<span class="ctx-dot" style="background:${p.color}"></span>${p.label}</div>`
  ).join('');
}

function showBulkMenu(x, y) {
  const count = multiSelected.size;
  bulkMenu.innerHTML = `
    <div class="bulk-header">${count} bead${count !== 1 ? 's' : ''} selected</div>
    <div class="bulk-item bulk-submenu">set status
      <div class="bulk-submenu-panel">${buildBulkStatusSubmenu()}</div>
    </div>
    <div class="bulk-item bulk-submenu">set priority
      <div class="bulk-submenu-panel">${buildBulkPrioritySubmenu()}</div>
    </div>
    <div class="bulk-sep"></div>
    <div class="bulk-item" data-action="bulk-close">close all</div>
    <div class="bulk-sep"></div>
    <div class="bulk-item" data-action="bulk-clear">clear selection</div>
  `;

  bulkMenu.style.display = 'block';
  const rect = bulkMenu.getBoundingClientRect();
  if (x + rect.width > window.innerWidth) x = window.innerWidth - rect.width - 8;
  if (y + rect.height > window.innerHeight) y = window.innerHeight - rect.height - 8;
  bulkMenu.style.left = x + 'px';
  bulkMenu.style.top = y + 'px';

  bulkMenu.onclick = (e) => {
    const item = e.target.closest('.bulk-item');
    if (!item) return;
    const action = item.dataset.action;
    const value = item.dataset.value;
    handleBulkAction(action, value);
  };
}

function hideBulkMenu() {
  bulkMenu.style.display = 'none';
  bulkMenu.onclick = null;
}

async function handleBulkAction(action, value) {
  const ids = [...multiSelected];
  hideBulkMenu();

  // Build snapshot for rollback and apply optimistic changes
  const nodeMap = new Map(graphData.nodes.map(n => [n.id, n]));
  const snapshots = new Map();

  switch (action) {
    case 'bulk-status': {
      for (const id of ids) {
        const n = nodeMap.get(id);
        if (n) { snapshots.set(id, { status: n.status }); n.status = value; }
      }
      graph.nodeThreeObject(graph.nodeThreeObject());
      showStatusToast(`${ids.length} → ${value}`);
      const results = await Promise.allSettled(ids.map(id => api.update(id, { status: value })));
      const failed = results.filter(r => r.status === 'rejected').length;
      if (failed > 0) {
        showStatusToast(`${failed}/${ids.length} failed`, true);
        for (const [id, snap] of snapshots) { const n = nodeMap.get(id); if (n) Object.assign(n, snap); }
        graph.nodeThreeObject(graph.nodeThreeObject());
      }
      break;
    }
    case 'bulk-priority': {
      const p = parseInt(value, 10);
      for (const id of ids) {
        const n = nodeMap.get(id);
        if (n) { snapshots.set(id, { priority: n.priority }); n.priority = p; }
      }
      graph.nodeThreeObject(graph.nodeThreeObject());
      showStatusToast(`${ids.length} → P${p}`);
      const results = await Promise.allSettled(ids.map(id => api.update(id, { priority: p })));
      const failed = results.filter(r => r.status === 'rejected').length;
      if (failed > 0) {
        showStatusToast(`${failed}/${ids.length} failed`, true);
        for (const [id, snap] of snapshots) { const n = nodeMap.get(id); if (n) Object.assign(n, snap); }
        graph.nodeThreeObject(graph.nodeThreeObject());
      }
      break;
    }
    case 'bulk-close': {
      for (const id of ids) {
        const n = nodeMap.get(id);
        if (n) { snapshots.set(id, { status: n.status }); n.status = 'closed'; }
      }
      graph.nodeThreeObject(graph.nodeThreeObject());
      showStatusToast(`closed ${ids.length}`);
      const results = await Promise.allSettled(ids.map(id => api.close(id)));
      const failed = results.filter(r => r.status === 'rejected').length;
      if (failed > 0) {
        showStatusToast(`${failed}/${ids.length} failed`, true);
        for (const [id, snap] of snapshots) { const n = nodeMap.get(id); if (n) Object.assign(n, snap); }
        graph.nodeThreeObject(graph.nodeThreeObject());
      }
      break;
    }
    case 'bulk-clear':
      break;
  }

  multiSelected.clear();
  unfreezeCamera(); // bd-casin: restore orbit controls after bulk action
}

// --- Controls ---
function setupControls() {
  const btnRefresh = document.getElementById('btn-refresh');
  const searchInput = document.getElementById('search-input');

  const btnBloom = document.getElementById('btn-bloom');

  // Layout buttons
  document.getElementById('btn-layout-free').onclick = () => setLayout('free');
  document.getElementById('btn-layout-dag').onclick = () => setLayout('dag');
  document.getElementById('btn-layout-timeline').onclick = () => setLayout('timeline');
  document.getElementById('btn-layout-radial').onclick = () => setLayout('radial');
  document.getElementById('btn-layout-cluster').onclick = () => setLayout('cluster');

  btnRefresh.onclick = () => refresh();

  // Screenshot & export buttons
  document.getElementById('btn-screenshot').onclick = () => captureScreenshot();
  document.getElementById('btn-export').onclick = () => exportGraphJSON();

  // Bloom toggle
  btnBloom.onclick = () => {
    bloomEnabled = !bloomEnabled;
    if (bloomPass) bloomPass.enabled = bloomEnabled;
    btnBloom.classList.toggle('active', bloomEnabled);
  };

  // Labels toggle (bd-1o2f7)
  document.getElementById('btn-labels').onclick = () => toggleLabels();

  // Bottom HUD bar quick-action buttons (bd-ddj44, bd-9ndk0.1)
  const hudBtnRefresh = document.getElementById('hud-btn-refresh');
  const hudBtnLabels = document.getElementById('hud-btn-labels');
  const hudBtnAgents = document.getElementById('hud-btn-agents');
  const hudBtnBloom = document.getElementById('hud-btn-bloom');
  const hudBtnSearch = document.getElementById('hud-btn-search');
  const hudBtnMinimap = document.getElementById('hud-btn-minimap');
  const hudBtnSidebar = document.getElementById('hud-btn-sidebar');
  const hudBtnControls = document.getElementById('hud-btn-controls');
  if (hudBtnRefresh) hudBtnRefresh.onclick = () => refresh();
  if (hudBtnLabels) hudBtnLabels.onclick = () => toggleLabels();
  if (hudBtnAgents) hudBtnAgents.onclick = () => toggleAgentsView();
  if (hudBtnBloom) hudBtnBloom.onclick = () => {
    bloomEnabled = !bloomEnabled;
    if (bloomPass) bloomPass.enabled = bloomEnabled;
    hudBtnBloom.classList.toggle('active', bloomEnabled);
  };
  if (hudBtnSearch) hudBtnSearch.onclick = () => searchInput.focus();
  if (hudBtnMinimap) hudBtnMinimap.onclick = () => toggleMinimap();
  if (hudBtnSidebar) hudBtnSidebar.onclick = () => toggleLeftSidebar();
  if (hudBtnControls) hudBtnControls.onclick = () => toggleControlPanel();

  // bd-69y6v: Control panel toggle & wiring
  initControlPanel();

  // bd-inqge: Right sidebar
  initRightSidebar();

  // bd-9ndk0.3: Unified activity stream
  initUnifiedFeed();

  // Search — debounced input updates filter, Enter/arrows navigate results (bd-7n4g8)
  searchInput.addEventListener('input', (e) => {
    searchFilter = e.target.value;
    searchResultIdx = 0; // reset to first result on new input
    clearTimeout(_searchDebounceTimer);
    _searchDebounceTimer = setTimeout(() => applyFilters(), 150);
  });
  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (searchResults.length > 0) {
        flyToSearchResult();
      }
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      nextSearchResult();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      prevSearchResult();
    }
  });

  // Status filter toggles
  // "active" button covers in_progress + blocked + hooked + deferred (bd-7haep)
  const STATUS_GROUPS = {
    in_progress: ['in_progress', 'blocked', 'hooked', 'deferred'],
  };
  document.querySelectorAll('.filter-status').forEach(btn => {
    btn.addEventListener('click', () => {
      const status = btn.dataset.status;
      const group = STATUS_GROUPS[status] || [status];
      btn.classList.toggle('active');
      if (statusFilter.has(status)) {
        group.forEach(s => statusFilter.delete(s));
      } else {
        group.forEach(s => statusFilter.add(s));
      }
      syncFilterDashboard();
      applyFilters();
    });
  });

  // Type filter toggles
  document.querySelectorAll('.filter-type').forEach(btn => {
    btn.addEventListener('click', () => {
      const type = btn.dataset.type;
      btn.classList.toggle('active');
      if (typeFilter.has(type)) {
        typeFilter.delete(type);
      } else {
        typeFilter.add(type);
      }
      syncFilterDashboard();
      applyFilters();
    });
  });

  // Agent filter controls (bd-8o2gd)
  const btnAgentShow = document.getElementById('btn-agent-show');
  const btnAgentOrphaned = document.getElementById('btn-agent-orphaned');

  if (btnAgentShow) {
    btnAgentShow.addEventListener('click', () => {
      agentFilterShow = !agentFilterShow;
      btnAgentShow.classList.toggle('active', agentFilterShow);
      syncFilterDashboard();
      applyFilters();
    });
  }

  if (btnAgentOrphaned) {
    btnAgentOrphaned.addEventListener('click', () => {
      agentFilterOrphaned = !agentFilterOrphaned;
      btnAgentOrphaned.classList.toggle('active', agentFilterOrphaned);
      syncFilterDashboard();
      applyFilters();
    });
  }

  // Age filter (bd-uc0mw): radio-style — only one active at a time.
  // Triggers a full re-fetch because the server uses max_age_days to limit
  // which closed issues are returned (avoids pulling thousands of stale beads).
  document.querySelectorAll('.filter-age').forEach(btn => {
    btn.addEventListener('click', () => {
      const newDays = parseInt(btn.dataset.days, 10);
      if (newDays === activeAgeDays) return; // no change
      document.querySelectorAll('.filter-age').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      activeAgeDays = newDays;
      syncFilterDashboard();
      refresh(); // re-fetch with new age cutoff (bd-uc0mw)
    });
  });

  // Filter dashboard panel (bd-8o2gd phase 2)
  initFilterDashboard();

  // Keyboard shortcuts
  document.addEventListener('keydown', (e) => {
    // '/' to focus search
    if (e.key === '/' && !isTextInputFocused()) {
      e.preventDefault();
      searchInput.focus();
    }
    // Escape to clear search, close detail, close context/bulk menu, and deselect
    if (e.key === 'Escape') {
      // Always unfreeze camera on Escape (bd-casin)
      unfreezeCamera();

      // Close control panel if open (bd-69y6v)
      if (controlPanelOpen) {
        toggleControlPanel();
        return;
      }

      // Close left sidebar if open (bd-nnr22)
      if (leftSidebarOpen) {
        toggleLeftSidebar();
        return;
      }

      // Close filter dashboard if open (bd-8o2gd phase 2)
      if (filterDashboardOpen) {
        toggleFilterDashboard();
        return;
      }

      // Close Agents View if open (bd-jgvas)
      if (agentsViewOpen) {
        // If search is focused and has text, clear it first
        const avSearch = document.querySelector('.agents-view-search');
        if (avSearch && document.activeElement === avSearch && avSearch.value) {
          avSearch.value = '';
          avSearch.dispatchEvent(new Event('input'));
          return;
        }
        closeAgentsView();
        return;
      }

      if (bulkMenu.style.display === 'block') {
        hideBulkMenu();
        multiSelected.clear();
        return;
      }
      if (ctxMenu.style.display === 'block') {
        hideContextMenu();
        return;
      }
      if (document.activeElement === searchInput) {
        searchInput.value = '';
        searchFilter = '';
        searchInput.blur();
        applyFilters();
      }
      clearSelection();
      clearEpicHighlight();
      hideDetail();
      hideTooltip();
      // Dismiss all doot popups (beads-799l)
      for (const [id] of dootPopups) dismissDootPopup(id);
      // Close all agent windows (bd-kau4k)
      for (const [id] of agentWindows) closeAgentWindow(id);
    }
    // 'r' to refresh
    if (e.key === 'r' && !isTextInputFocused()) {
      refresh();
    }
    // 'b' to toggle bloom (ignore key repeat to prevent rapid on/off — beads-p97b)
    if (e.key === 'b' && !e.repeat && !isTextInputFocused()) {
      btnBloom.click();
    }
    // 'm' to toggle minimap
    if (e.key === 'm' && !e.repeat && !isTextInputFocused()) {
      toggleMinimap();
    }
    // 'l' for labels toggle (bd-1o2f7, beads-p97b: ignore key repeat)
    if (e.key === 'l' && !e.repeat && !isTextInputFocused()) {
      toggleLabels();
    }
    // 'f' for left sidebar (bd-nnr22, was filter dashboard bd-8o2gd)
    if (e.key === 'f' && !e.repeat && !isTextInputFocused()) {
      toggleLeftSidebar();
    }
    // 'g' for control panel (bd-69y6v)
    if (e.key === 'g' && !e.repeat && !isTextInputFocused()) {
      toggleControlPanel();
    }
    // 'p' for screenshot
    if (e.key === 'p' && !isTextInputFocused()) {
      captureScreenshot();
    }
    // 'x' for export
    if (e.key === 'x' && !isTextInputFocused()) {
      exportGraphJSON();
    }
    // Shift+D / Shift+S for epic cycling (bd-pnngb)
    if (e.shiftKey && e.key === 'D' && !isTextInputFocused()) {
      e.preventDefault();
      cycleEpic(1);
      return;
    }
    if (e.shiftKey && e.key === 'S' && !isTextInputFocused()) {
      e.preventDefault();
      cycleEpic(-1);
      return;
    }
    // Shift+A for Agents View overlay (bd-jgvas)
    if (e.shiftKey && e.key === 'A' && !isTextInputFocused()) {
      e.preventDefault();
      toggleAgentsView();
      return;
    }
    // 1-5 for layout modes
    const layoutKeys = { '1': 'free', '2': 'dag', '3': 'timeline', '4': 'radial', '5': 'cluster' };
    if (layoutKeys[e.key] && !isTextInputFocused()) {
      setLayout(layoutKeys[e.key]);
    }

    // Arrow + WASD keys: track held keys for Quake-style smooth camera (bd-zab4q, bd-pwaen)
    if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'w', 'a', 's', 'd'].includes(e.key) &&
        !e.shiftKey && !isTextInputFocused()) {
      e.preventDefault();
      _keysDown.add(e.key);
    }
  });

  // Release arrow keys — velocity decays via friction in animation loop (bd-zab4q)
  document.addEventListener('keyup', (e) => {
    _keysDown.delete(e.key);
  });
}

// --- Refresh ---
// Merge new data into the existing graph, preserving node positions to avoid layout jumps.
// Only triggers a full graph.graphData() call when nodes are added or removed.
// Uses a low alpha reheat to gently integrate new nodes without scattering the layout.
async function refresh() {
  const data = await fetchGraphData();
  if (!data) return;

  const currentNodes = graphData.nodes;
  const currentLinks = graphData.links;
  const existingById = new Map(currentNodes.map(n => [n.id, n]));
  const newIds = new Set(data.nodes.map(n => n.id));

  // Position-related keys to preserve across refreshes
  const POSITION_KEYS = ['x', 'y', 'z', 'vx', 'vy', 'vz', 'fx', 'fy', 'fz', '__threeObj', '_wasDimmed'];

  let nodesAdded = 0;
  let nodesRemoved = 0;

  // Update existing nodes in-place, detect additions
  const mergedNodes = data.nodes.map(incoming => {
    const existing = existingById.get(incoming.id);
    if (existing) {
      // Update properties in-place (preserving position/velocity/three.js object)
      for (const key of Object.keys(incoming)) {
        if (!POSITION_KEYS.includes(key)) {
          existing[key] = incoming[key];
        }
      }
      existing._blocked = !!(incoming.blocked_by && incoming.blocked_by.length > 0);
      return existing;
    }
    // New node — place near a connected neighbor if possible, else near origin
    nodesAdded++;
    const newNode = { ...incoming, _blocked: !!(incoming.blocked_by && incoming.blocked_by.length > 0) };
    // Seed new nodes near a connected existing node to reduce layout shock
    const neighborId = (incoming.blocked_by || [])[0] || (incoming.assignee_id);
    const neighbor = neighborId && existingById.get(neighborId);
    if (neighbor && neighbor.x !== undefined) {
      newNode.x = neighbor.x + (Math.random() - 0.5) * 30;
      newNode.y = neighbor.y + (Math.random() - 0.5) * 30;
      newNode.z = neighbor.z + (Math.random() - 0.5) * 30;
    }
    return newNode;
  });

  // Detect removed nodes
  for (const n of currentNodes) {
    if (!newIds.has(n.id)) nodesRemoved++;
  }

  // Build link key for comparison (includes dep_type)
  // Exclude rig_conflict edges — they're re-synthesized every refresh and would
  // always trigger structureChanged even when nothing meaningful changed (bd-c1x6p).
  const refreshLinkKey = l => `${typeof l.source === 'object' ? l.source.id : l.source}→${typeof l.target === 'object' ? l.target.id : l.target}:${l.dep_type}`;
  const existingLinkKeys = new Set(currentLinks.filter(l => l.dep_type !== 'rig_conflict').map(refreshLinkKey));
  const newLinkKeys = new Set(data.links.filter(l => l.dep_type !== 'rig_conflict').map(refreshLinkKey));

  let linksChanged = false;
  // Detect genuinely new links for edge spark animations (bd-9qeto)
  const brandNewLinks = data.links.filter(l => !existingLinkKeys.has(refreshLinkKey(l)));
  if (data.links.length !== currentLinks.length ||
      brandNewLinks.length > 0 ||
      currentLinks.some(l => !newLinkKeys.has(refreshLinkKey(l)))) {
    linksChanged = true;
  }

  // Spawn edge sparks for new associations (bd-9qeto)
  // Only fire for non-assigned_to links (assigned_to already has glow tubes)
  for (const nl of brandNewLinks) {
    if (nl.dep_type === 'assigned_to') continue;
    const srcId = typeof nl.source === 'object' ? nl.source.id : nl.source;
    const tgtId = typeof nl.target === 'object' ? nl.target.id : nl.target;
    const srcNode = mergedNodes.find(n => n.id === srcId);
    const tgtNode = mergedNodes.find(n => n.id === tgtId);
    if (srcNode && tgtNode && srcNode.x !== undefined && tgtNode.x !== undefined) {
      const sparkColor = nl.dep_type === 'blocks' ? 0xd04040
        : nl.dep_type === 'parent-child' ? 0x8b45a6
        : 0x4a9eff;
      spawnEdgeSpark(srcNode, tgtNode, sparkColor);
    }
  }

  const structureChanged = nodesAdded > 0 || nodesRemoved > 0 || linksChanged;

  graphData = { nodes: mergedNodes, links: data.links };

  // Populate rig filter pills from agent nodes (bd-8o2gd)
  updateRigPills(mergedNodes);
  // Update assignee buttons in filter dashboard (bd-8o2gd phase 2)
  updateAssigneeButtons();

  applyFilters();
  rebuildEpicIndex();
  updateRightSidebar(); // bd-inqge

  // Compute pending decision badge counts per parent node (bd-o6tgy)
  const nodeById = new Map(mergedNodes.map(n => [n.id, n]));
  for (const n of mergedNodes) n._pendingDecisions = 0;
  for (const link of data.links) {
    if (link.dep_type !== 'parent-child') continue;
    const childId = typeof link.target === 'object' ? link.target.id : link.target;
    const parentId = typeof link.source === 'object' ? link.source.id : link.source;
    const child = nodeById.get(childId);
    const parent = nodeById.get(parentId);
    if (child && parent && (child.issue_type === 'gate' || child.issue_type === 'decision')) {
      const ds = child._decisionState || (child.status === 'closed' ? 'resolved' : 'pending');
      if (ds === 'pending') parent._pendingDecisions++;
    }
  }

  // Rig conflict edges — red links between agents sharing the same rig (bd-90ikf)
  // Synthesized client-side: group agents by rig, create conflict edges between pairs.
  const rigGroups = new Map(); // rig -> [agentId, ...]
  for (const n of mergedNodes) {
    if (n.issue_type === 'agent' && n.rig) {
      if (!rigGroups.has(n.rig)) rigGroups.set(n.rig, []);
      rigGroups.get(n.rig).push(n.id);
    }
  }
  // Remove stale conflict edges from previous update
  graphData.links = graphData.links.filter(l => l.dep_type !== 'rig_conflict');
  for (const [, agents] of rigGroups) {
    if (agents.length < 2) continue;
    for (let i = 0; i < agents.length; i++) {
      for (let j = i + 1; j < agents.length; j++) {
        graphData.links.push({
          source: agents[i], target: agents[j],
          dep_type: 'rig_conflict',
        });
      }
    }
  }

  if (structureChanged) {
    // graph.graphData() reheats d3-force to alpha=1, which scatters positioned nodes.
    // Fix (bd-7ccyd): pin ALL existing nodes at their current positions during the
    // graphData() call. Only new nodes (without positions) float freely. After a brief
    // settling period, unpin so the layout can gently adjust.
    const pinnedNodes = [];
    for (const n of mergedNodes) {
      if (n.x !== undefined && n.fx === undefined) {
        n.fx = n.x;
        n.fy = n.y;
        n.fz = n.z || 0;
        pinnedNodes.push(n);
      }
    }

    // Save camera state — graphData() triggers the library's onUpdate which
    // auto-repositions the camera when it detects a (0,0,Z) default position.
    // We restore immediately after to prevent any camera jump (bd-7ccyd).
    const cam = graph.camera();
    const savedCamPos = cam.position.clone();
    const controls = graph.controls();
    const savedTarget = controls?.target?.clone();

    graph.graphData(graphData);

    // Counter the force reheat: graphData() sets alpha=1 which causes violent
    // node scattering. Temporarily set high alphaDecay so the simulation cools
    // down much faster (settles in ~50 ticks instead of ~300). Restore normal
    // decay after settling period (bd-c1x6p).
    const normalDecay = 0.0228; // d3 default
    graph.d3AlphaDecay(0.1); // 4x faster cooldown
    setTimeout(() => graph.d3AlphaDecay(normalDecay), 2000);

    // Restore camera position immediately (prevents library auto-reposition)
    cam.position.copy(savedCamPos);
    if (controls && savedTarget) {
      controls.target.copy(savedTarget);
      controls.update();
    }

    // Release pins after simulation has mostly cooled down. With the faster
    // alphaDecay, alpha drops below 0.1 within ~1s. Unpin after 2s to be
    // safe — remaining alpha is negligible so nodes barely drift (bd-c1x6p).
    setTimeout(() => {
      for (const n of pinnedNodes) {
        delete n.fx;
        delete n.fy;
        delete n.fz;
      }
    }, 2000);
  }
  // If only properties changed (status, title, etc.), the existing three.js
  // objects pick up the changes via the animation tick — no layout reset needed.
}

// --- SSE live updates (bd-03b5v) ---
// Handle incoming mutation events: optimistic property updates for instant feedback,
// debounced full refresh for structural changes (new/deleted beads).
let _refreshTimer;
function connectLiveUpdates() {
  try {
    api.connectEvents((evt) => {
      const applied = applyMutationOptimistic(evt);
      // Always schedule a background refresh for consistency, but with longer
      // delay if we already applied the change visually (bd-c1x6p: increased
      // debounce from 5s/1.5s to 10s/3s to reduce layout disruption frequency).
      clearTimeout(_refreshTimer);
      _refreshTimer = setTimeout(refresh, applied ? 10000 : 3000);
    });
  } catch { /* polling fallback */ }
}

// Apply a mutation event optimistically to the in-memory graph data.
// Returns true if a visual update was applied (no urgent refresh needed).
function applyMutationOptimistic(evt) {
  if (!graphData || !graphData.nodes) return false;

  const id = evt.issue_id;
  if (!id) return false;

  // Find the node in the current graph
  const node = graphData.nodes.find(n => n.id === id);

  switch (evt.type) {
    case 'status': {
      if (!node) return false;
      const oldStatus = node.status;
      node.status = evt.new_status || node.status;
      // Rebuild THREE.js object if status changed (affects color, pulse ring, etc.)
      if (oldStatus !== node.status && graph) {
        graph.nodeThreeObject(graph.nodeThreeObject());
        // Event sprite: status change pulse (bd-9qeto)
        spawnStatusPulse(node, oldStatus, node.status);
      }
      return true;
    }

    case 'update': {
      if (!node) return false;
      // Update assignee if present in the event
      if (evt.assignee !== undefined) {
        node.assignee = evt.assignee;
      }
      if (evt.title) {
        node.title = evt.title;
      }
      return true;
    }

    case 'create':
      // New bead — can't render without full data, need refresh
      return false;

    case 'delete':
      // Deleted bead — could remove from graph, but safer to let refresh handle it
      return false;

    default:
      return false;
  }
}

// --- Live event doots — HTML overlay via CSS2DRenderer (bd-c7723, bd-bwkdk) ---

const DOOT_LIFETIME = 4.0; // seconds before fully faded
const DOOT_RISE_SPEED = 8; // units per second upward
const DOOT_MAX = 30; // max active doots (oldest get pruned)

// Initialize CSS2D overlay renderer for HTML doots (bd-bwkdk)
function initCSS2DRenderer() {
  css2dRenderer = new CSS2DRenderer();
  css2dRenderer.setSize(window.innerWidth, window.innerHeight);
  css2dRenderer.domElement.id = 'css2d-overlay';
  css2dRenderer.domElement.style.position = 'absolute';
  css2dRenderer.domElement.style.top = '0';
  css2dRenderer.domElement.style.left = '0';
  css2dRenderer.domElement.style.pointerEvents = 'none';
  css2dRenderer.domElement.style.zIndex = '1';
  document.getElementById('graph').appendChild(css2dRenderer.domElement);
  window.addEventListener('resize', () => {
    css2dRenderer.setSize(window.innerWidth, window.innerHeight);
  });
}

// Short human-readable label for a bus event
function dootLabel(evt) {
  const type = evt.type || '';
  const p = evt.payload || {};

  // Agent lifecycle
  if (type === 'AgentStarted') return 'started';
  if (type === 'AgentStopped') return 'stopped';
  if (type === 'AgentCrashed') return 'crashed!';
  if (type === 'AgentIdle') return 'idle';
  if (type === 'AgentHeartbeat') return null; // too noisy

  // Hook events (tool use, session, etc.) — show full command context (bd-wn5he)
  if (type === 'PreToolUse' || type === 'PostToolUse') {
    const tool = p.tool_name || p.toolName || '';
    const input = p.tool_input || {};
    if (tool === 'Bash' || tool === 'bash') {
      const cmd = input.command || input.cmd || '';
      const short = cmd.replace(/^cd [^ ]+ && /, '').split('\n')[0].slice(0, 60);
      return short || 'bash';
    }
    if (tool === 'Read' || tool === 'read') {
      const fp = input.file_path || input.path || '';
      return fp ? `read ${fp.split('/').pop()}` : 'read';
    }
    if (tool === 'Edit' || tool === 'edit') {
      const fp = input.file_path || input.path || '';
      return fp ? `edit ${fp.split('/').pop()}` : 'edit';
    }
    if (tool === 'Write' || tool === 'write') {
      const fp = input.file_path || input.path || '';
      return fp ? `write ${fp.split('/').pop()}` : 'write';
    }
    if (tool === 'Grep' || tool === 'grep') {
      const pat = input.pattern || '';
      return pat ? `grep ${pat.slice(0, 30)}` : 'grep';
    }
    if (tool === 'Glob' || tool === 'glob') {
      const pat = input.pattern || '';
      return pat ? `glob ${pat.slice(0, 30)}` : 'glob';
    }
    if (tool === 'Task' || tool === 'task') {
      const desc = input.description || '';
      return desc ? `task: ${desc.slice(0, 40)}` : 'task';
    }
    return tool ? tool.toLowerCase() : 'tool';
  }
  if (type === 'SessionStart') return 'session start';
  if (type === 'SessionEnd') return 'session end';
  if (type === 'Stop') return 'stop';
  if (type === 'UserPromptSubmit') return 'prompt';
  if (type === 'PreCompact') return 'compacting...';

  // OddJobs
  if (type === 'OjJobCreated') return 'job created';
  if (type === 'OjStepAdvanced') return 'step';
  if (type === 'OjAgentSpawned') return 'spawned';
  if (type === 'OjAgentIdle') return 'idle';
  if (type === 'OjJobCompleted') return 'job done';
  if (type === 'OjJobFailed') return 'job failed!';

  // Mail events (bd-t76aw)
  if (type === 'MailSent') return `✉ ${(p.subject || 'mail').slice(0, 40)}`;
  if (type === 'MailRead') return '✉ read';

  // Mutations (bd-wn5he: rate-limit noisy heartbeat updates, show meaningful ones)
  if (type === 'MutationCreate') return `new: ${(p.title || p.issue_id || 'bead').slice(0, 40)}`;
  if (type === 'MutationUpdate') {
    if (p.type === 'rpc_audit') return null; // daemon-token bookkeeping noise
    // Rate-limit agent heartbeats: one doot per agent per 10s
    if (p.agent_state && !p.new_status) {
      const key = p.issue_id || p.actor || '';
      const now = Date.now();
      if (!dootLabel._lastHeartbeat) dootLabel._lastHeartbeat = {};
      if (now - (dootLabel._lastHeartbeat[key] || 0) < 10000) return null;
      dootLabel._lastHeartbeat[key] = now;
      return p.agent_state; // "working", "idle", etc.
    }
    // Show assignee claims
    if (p.assignee && p.type === 'update') return `claimed by ${p.assignee}`;
    return p.title ? p.title.slice(0, 50) : 'updated';
  }
  if (type === 'MutationStatus') return p.new_status || 'status';
  if (type === 'MutationClose') return 'closed';

  // Decisions (bd-0j7hr: show decision events as doots + graph updates)
  if (type === 'DecisionCreated') return `? ${(p.question || 'decision').slice(0, 35)}`;
  if (type === 'DecisionResponded') return `✓ ${(p.chosen_label || 'resolved').slice(0, 35)}`;
  if (type === 'DecisionEscalated') return 'escalated';
  if (type === 'DecisionExpired') return 'expired';

  return type.replace(/([A-Z])/g, ' $1').trim().toLowerCase().slice(0, 20);
}

// Color based on event type
function dootColor(evt) {
  const type = evt.type || '';
  if (type.includes('Crash') || type.includes('Failed')) return '#ff3333';
  if (type.includes('Decision')) return '#d4a017'; // before Created check — DecisionCreated is yellow
  if (type.includes('Stop') || type.includes('End')) return '#888888';
  if (type.includes('Started') || type.includes('Spawned') || type.includes('Created')) return '#2d8a4e';
  if (type.includes('Tool')) return '#4a9eff';
  if (type.includes('Idle')) return '#666666';
  return '#ff6b35'; // agent orange default
}

// Find a graph node to attach a doot to for a bus event (bd-5knqx).
// Pass 1: Prefer dedicated agent nodes (issue_type=agent) — works with mock data.
// Pass 2: Fall back to any visible node by issue_id or assignee — works in live
// deployments where agents are transient sessions, not agent beads.
function findAgentNode(evt) {
  const p = evt.payload || {};

  // Mail events: find recipient agent node (bd-t76aw, bd-gal6f: prefer visible)
  if (evt.type === 'MailSent' || evt.type === 'MailRead') {
    const to = (p.to || '').replace(/^@/, '');
    if (to && graphData) {
      const visible = graphData.nodes.filter(n => n.issue_type === 'agent' && !n._hidden);
      for (const node of visible) {
        if (node.title === to || node.id === `agent:${to}`) return node;
      }
      // Fall back to hidden agents
      const hidden = graphData.nodes.filter(n => n.issue_type === 'agent' && n._hidden);
      for (const node of hidden) {
        if (node.title === to || node.id === `agent:${to}`) return node;
      }
    }
    return null;
  }

  const candidates = [
    p.issue_id,      // mutation events: the bead being mutated
    p.agent_id,      // agent lifecycle events
    p.agentID,       // alternate casing
    p.assignee,      // mutation events: the agent assigned to the bead
    p.requested_by,  // decision events: requesting agent (bd-0j7hr)
    p.actor,         // hook events (short agent name) or mutations ("daemon")
  ].filter(c => c && c !== 'daemon');

  if (candidates.length === 0) return null;

  // Pass 1a: Prefer VISIBLE agent nodes (bd-gal6f: avoid doots on hidden agents)
  const visibleAgents = graphData.nodes.filter(n => n.issue_type === 'agent' && !n._hidden);
  for (const candidate of candidates) {
    for (const node of visibleAgents) {
      if (node.id === candidate || node.title === candidate || node.assignee === candidate) return node;
    }
    for (const node of visibleAgents) {
      if (node.id === `agent:${candidate}`) return node;
    }
  }
  // Pass 1b: Fall back to hidden agent nodes (still better than random bead)
  const allAgents = graphData.nodes.filter(n => n.issue_type === 'agent' && n._hidden);
  for (const candidate of candidates) {
    for (const node of allAgents) {
      if (node.id === candidate || node.title === candidate || node.assignee === candidate) return node;
    }
    for (const node of allAgents) {
      if (node.id === `agent:${candidate}`) return node;
    }
  }

  // Pass 2: Fall back to any visible node (bd-5knqx live doot fix)
  const allVisible = graphData.nodes.filter(n => !n._hidden);
  if (p.issue_id) {
    const byId = allVisible.find(n => n.id === p.issue_id);
    if (byId) return byId;
  }
  const actor = p.actor;
  if (actor && actor !== 'daemon') {
    const byAssignee = allVisible.find(n => n.assignee === actor && n.status === 'in_progress');
    if (byAssignee) return byAssignee;
  }
  return null;
}

// Spawn an HTML doot via CSS2DObject — crisp text at any zoom (bd-bwkdk)
function spawnDoot(node, text, color) {
  if (!node || !text || !graph) return;

  // Trigger doot popup for non-agent nodes (beads-edy1)
  showDootPopup(node);

  // Create HTML element for the doot
  const el = document.createElement('div');
  el.className = 'doot-text';
  el.textContent = text;
  el.style.color = color || '#ff6b35';
  el.style.setProperty('--doot-color', color || '#ff6b35');

  // Wrap in CSS2DObject for 3D positioning
  const css2d = new CSS2DObject(el);
  css2d.userData.isDoot = true;

  // Random horizontal jitter so overlapping doots spread out
  const jx = (Math.random() - 0.5) * 6;
  const jz = (Math.random() - 0.5) * 6;
  css2d.position.set(
    (node.x || 0) + jx,
    (node.y || 0) + 10, // start just above node
    (node.z || 0) + jz,
  );
  graph.scene().add(css2d);

  doots.push({
    css2d,
    el,
    node,
    birth: performance.now() / 1000,
    lifetime: DOOT_LIFETIME,
    jx, jz,
  });

  // Prune oldest if over limit
  while (doots.length > DOOT_MAX) {
    const old = doots.shift();
    graph.scene().remove(old.css2d);
  }
}

// Update doot positions and opacity in animate loop (bd-bwkdk)
// CSS2DRenderer handles screen projection — we just update world Y for rising
function updateDoots(t) {
  for (let i = doots.length - 1; i >= 0; i--) {
    const d = doots[i];
    const age = t - d.birth;

    if (age > d.lifetime) {
      // Remove expired doot
      graph.scene().remove(d.css2d);
      doots.splice(i, 1);
      continue;
    }

    // Rise upward, follow node position (nodes can move during force layout)
    const rise = age * DOOT_RISE_SPEED;
    d.css2d.position.set(
      (d.node.x || 0) + d.jx,
      (d.node.y || 0) + 10 + rise,
      (d.node.z || 0) + d.jz,
    );

    // Fade out over last 40% of lifetime
    const fadeStart = d.lifetime * 0.6;
    const opacity = age < fadeStart ? 0.9 : 0.9 * (1 - (age - fadeStart) / (d.lifetime - fadeStart));
    d.el.style.opacity = Math.max(0, opacity).toFixed(2);
  }
}

// --- Doot-triggered issue popup (beads-edy1) ---
const DOOT_POPUP_DURATION = 30000; // 30s auto-dismiss
const DOOT_POPUP_MAX = 3; // max simultaneous popups

function showDootPopup(node) {
  if (!node || !node.id || node.issue_type === 'agent') return;

  const existing = dootPopups.get(node.id);
  if (existing) {
    // Reset timer — activity keeps it alive
    clearTimeout(existing.timer);
    existing.timer = setTimeout(() => dismissDootPopup(node.id), DOOT_POPUP_DURATION);
    existing.lastDoot = Date.now();
    // Pulse animation
    existing.el.classList.remove('doot-pulse');
    void existing.el.offsetWidth; // force reflow
    existing.el.classList.add('doot-pulse');
    return;
  }

  // Prune oldest if at max
  if (dootPopups.size >= DOOT_POPUP_MAX) {
    const oldest = [...dootPopups.entries()].sort((a, b) => a[1].lastDoot - b[1].lastDoot)[0];
    if (oldest) dismissDootPopup(oldest[0]);
  }

  // Create popup element
  const container = document.getElementById('doot-popups') || createDootPopupContainer();
  const el = document.createElement('div');
  el.className = 'doot-popup';
  el.dataset.beadId = node.id;

  const pLabel = ['P0', 'P1', 'P2', 'P3', 'P4'][node.priority] || '';
  el.innerHTML = `
    <div class="doot-popup-header">
      <span class="doot-popup-id">${escapeHtml(node.id)}</span>
      <span class="tag tag-${node.status}">${node.status}</span>
      <span class="tag">${pLabel}</span>
      <button class="doot-popup-close">&times;</button>
    </div>
    <div class="doot-popup-title">${escapeHtml(node.title || node.id)}</div>
    ${node.assignee ? `<div class="doot-popup-assignee">@ ${escapeHtml(node.assignee)}</div>` : ''}
    <div class="doot-popup-bar"></div>
  `;

  el.querySelector('.doot-popup-close').onclick = () => dismissDootPopup(node.id);
  el.onclick = (e) => {
    if (e.target.classList.contains('doot-popup-close')) return;
    handleNodeClick(node);
  };

  container.appendChild(el);
  requestAnimationFrame(() => el.classList.add('open'));

  const timer = setTimeout(() => dismissDootPopup(node.id), DOOT_POPUP_DURATION);
  dootPopups.set(node.id, { el, timer, node, lastDoot: Date.now() });

  // Start countdown bar animation
  const bar = el.querySelector('.doot-popup-bar');
  if (bar) bar.style.animationDuration = `${DOOT_POPUP_DURATION}ms`;
}

function dismissDootPopup(nodeId) {
  const popup = dootPopups.get(nodeId);
  if (!popup) return;
  clearTimeout(popup.timer);
  popup.el.classList.remove('open');
  dootPopups.delete(nodeId);
  setTimeout(() => popup.el.remove(), 300);
}

function createDootPopupContainer() {
  const c = document.createElement('div');
  c.id = 'doot-popups';
  document.body.appendChild(c);
  return c;
}

// --- Agent activity feed windows (bd-kau4k) ---

const TOOL_ICONS = {
  Read: 'R', Edit: 'E', Bash: '$', Grep: '?', Write: 'W', Task: 'T',
  Glob: 'G', WebFetch: 'F', WebSearch: 'S', NotebookEdit: 'N',
};

function showAgentWindow(node) {
  if (!node || !node.id) return;

  // Toggle: if already open, collapse/expand
  const existing = agentWindows.get(node.id);
  if (existing) {
    existing.collapsed = !existing.collapsed;
    existing.el.classList.toggle('collapsed', existing.collapsed);
    return;
  }

  const container = document.getElementById('agent-windows');
  if (!container) return;

  const el = document.createElement('div');
  el.className = 'agent-window';
  el.dataset.agentId = node.id;

  const agentName = node.title || node.id.replace('agent:', '');

  // Find assigned beads
  const assigned = graphData.links
    .filter(l => l.dep_type === 'assigned_to' &&
      (typeof l.source === 'object' ? l.source.id : l.source) === node.id)
    .map(l => {
      const tgtId = typeof l.target === 'object' ? l.target.id : l.target;
      const tgtNode = graphData.nodes.find(n => n.id === tgtId);
      return tgtNode ? { id: tgtId, title: tgtNode.title || tgtId } : null;
    })
    .filter(Boolean);

  const beadsList = assigned
    .map(b => `<div class="agent-window-bead" data-bead-id="${escapeHtml(b.id)}" title="${escapeHtml(b.id)}: ${escapeHtml(b.title)}" style="cursor:pointer">${escapeHtml(b.id.replace(/^[a-z]+-/, ''))}: ${escapeHtml(b.title)}</div>`)
    .join('');

  const rigBadge = node.rig
    ? `<span class="agent-window-rig" style="color:${rigColor(node.rig)};border-color:${rigColor(node.rig)}33">${escapeHtml(node.rig)}</span>`
    : '';

  // bd-5ok9s: derive initial status from node data
  const initStatus = (node.status || '').toLowerCase();
  const initStatusClass = initStatus === 'active' ? 'status-active' : initStatus === 'idle' ? 'status-idle' : initStatus === 'crashed' ? 'status-crashed' : '';

  el.innerHTML = `
    <div class="agent-window-resize-handle"></div>
    <div class="agent-window-header">
      <span class="agent-window-name" style="cursor:pointer" title="Click to zoom to agent">${escapeHtml(agentName)}</span>
      ${rigBadge}
      <span class="agent-window-badge">${assigned.length}</span>
      <button class="agent-window-popout" title="Pop out to floating window">&#x2197;</button>
      <button class="agent-window-close">&times;</button>
    </div>
    <div class="agent-status-bar">
      <span><span class="status-label">Status:</span> <span class="agent-status-state ${initStatusClass}">${initStatus || '?'}</span></span>
      <span class="agent-status-idle-dur"></span>
      <span class="agent-status-tool"></span>
    </div>
    ${beadsList ? `<div class="agent-window-beads">${beadsList}</div>` : ''}
    <div class="agent-feed"><div class="agent-window-empty">waiting for events...</div></div>
    <div class="agent-mail-compose">
      <input class="agent-mail-input" type="text" placeholder="Send message to ${escapeHtml(agentName)}..." />
      <button class="agent-mail-send">&#x2709;</button>
    </div>
  `;

  // bd-2ysfj: Click agent name to highlight + zoom to agent node in 3D scene
  el.querySelector('.agent-window-name').onclick = (e) => {
    e.stopPropagation(); // Don't trigger header collapse
    const agentNode = graphData.nodes.find(n => n.id === node.id);
    if (agentNode) handleNodeClick(agentNode);
  };

  // bd-xm78e: Click assigned bead to highlight + zoom to bead node in 3D scene
  const beadsContainer = el.querySelector('.agent-window-beads');
  if (beadsContainer) {
    beadsContainer.onclick = (e) => {
      const beadEl = e.target.closest('.agent-window-bead');
      if (!beadEl) return;
      const beadId = beadEl.dataset.beadId;
      if (!beadId) return;
      e.stopPropagation();
      const beadNode = graphData.nodes.find(n => n.id === beadId);
      if (beadNode) handleNodeClick(beadNode);
    };
  }

  const header = el.querySelector('.agent-window-header');
  header.onclick = (e) => {
    if (e.target.classList.contains('agent-window-close')) return;
    if (e.target.classList.contains('agent-window-name')) return; // bd-2ysfj: name has its own handler
    const win = agentWindows.get(node.id);
    if (win) {
      win.collapsed = !win.collapsed;
      el.classList.toggle('collapsed', win.collapsed);
    }
  };

  el.querySelector('.agent-window-close').onclick = () => closeAgentWindow(node.id);

  // bd-dqe6k: Pop-out / dock-back
  el.querySelector('.agent-window-popout').onclick = (e) => {
    e.stopPropagation();
    togglePopout(node.id);
  };

  // Mail compose (bd-t76aw): send message on Enter or click
  const mailInput = el.querySelector('.agent-mail-input');
  const mailSend = el.querySelector('.agent-mail-send');
  const doSend = async () => {
    const text = mailInput.value.trim();
    if (!text) return;
    mailInput.value = '';
    mailInput.disabled = true;
    mailSend.disabled = true;
    try {
      await api.sendMail(agentName, text);
      // Optimistic: show sent confirmation in feed immediately
      const win = agentWindows.get(node.id);
      if (win) {
        const empty = win.feedEl.querySelector('.agent-window-empty');
        if (empty) empty.remove();
        const ts = new Date().toTimeString().slice(0, 8);
        win.feedEl.appendChild(createEntry(ts, '▶', `sent: ${text}`, 'mail mail-sent'));
        autoScroll(win);
      }
    } catch (err) {
      console.error('[beads3d] mail send failed:', err);
      mailInput.value = text; // restore the message so user can retry
      const compose = el.querySelector('.agent-mail-compose');
      compose.classList.add('send-error');
      setTimeout(() => compose.classList.remove('send-error'), 2000);
    }
    mailInput.disabled = false;
    mailSend.disabled = false;
    mailInput.focus();
  };
  mailSend.onclick = doSend;
  mailInput.onkeydown = (e) => { if (e.key === 'Enter') doSend(); };

  container.appendChild(el);

  const feedEl = el.querySelector('.agent-feed');
  const statusEl = el.querySelector('.agent-status-bar');
  agentWindows.set(node.id, {
    el, feedEl, statusEl, node,
    entries: [],
    pendingTool: null,
    collapsed: false,
    lastStatus: initStatus || null,
    lastTool: null,
    idleSince: initStatus === 'idle' ? Date.now() : null,
    crashError: null,
  });
  enableTopResize(el); // bd-9wxm9
}

function closeAgentWindow(agentId) {
  const win = agentWindows.get(agentId);
  if (!win) return;
  if (win._dragCleanup) { win._dragCleanup(); win._dragCleanup = null; }
  win.el.remove();
  agentWindows.delete(agentId);
}

// bd-dqe6k: Pop-out / dock-back agent windows
function togglePopout(agentId) {
  const win = agentWindows.get(agentId);
  if (!win) return;
  const el = win.el;
  const btn = el.querySelector('.agent-window-popout');

  if (el.classList.contains('popped-out')) {
    // Dock back: return to tray or grid
    el.classList.remove('popped-out');
    el.style.left = '';
    el.style.top = '';
    el.style.width = '';
    el.style.height = '';
    btn.innerHTML = '&#x2197;';
    btn.title = 'Pop out to floating window';
    // Move back to original container
    const tray = document.getElementById('agent-windows');
    const grid = document.querySelector('.agents-view-grid');
    if (grid && document.getElementById('agents-view')?.style.display !== 'none') {
      grid.appendChild(el);
    } else if (tray) {
      tray.appendChild(el);
    }
    // Remove drag listeners
    if (win._dragCleanup) { win._dragCleanup(); win._dragCleanup = null; }
  } else {
    // Pop out: detach to fixed floating window
    const rect = el.getBoundingClientRect();
    el.classList.add('popped-out');
    // Position where it was, clamped to viewport
    el.style.left = Math.min(rect.left, window.innerWidth - 440) + 'px';
    el.style.top = Math.max(20, rect.top - 60) + 'px';
    btn.innerHTML = '&#x2199;';
    btn.title = 'Dock back to tray';
    // Move to body so it floats above everything
    document.body.appendChild(el);
    // Enable drag on header
    win._dragCleanup = enableHeaderDrag(el);
  }
}

function enableHeaderDrag(el) {
  const header = el.querySelector('.agent-window-header');
  let dragging = false, startX = 0, startY = 0, origLeft = 0, origTop = 0;

  function onMouseDown(e) {
    // Don't drag if clicking buttons or name
    if (e.target.closest('button') || e.target.closest('.agent-window-name')) return;
    dragging = true;
    startX = e.clientX;
    startY = e.clientY;
    origLeft = parseInt(el.style.left) || 0;
    origTop = parseInt(el.style.top) || 0;
    e.preventDefault();
  }
  function onMouseMove(e) {
    if (!dragging) return;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    el.style.left = (origLeft + dx) + 'px';
    el.style.top = (origTop + dy) + 'px';
  }
  function onMouseUp() {
    dragging = false;
  }

  header.addEventListener('mousedown', onMouseDown);
  document.addEventListener('mousemove', onMouseMove);
  document.addEventListener('mouseup', onMouseUp);

  // Return cleanup function
  return () => {
    header.removeEventListener('mousedown', onMouseDown);
    document.removeEventListener('mousemove', onMouseMove);
    document.removeEventListener('mouseup', onMouseUp);
  };
}

// bd-9wxm9: Enable top-edge resize on agent windows (drag upward to expand)
function enableTopResize(el) {
  const handle = el.querySelector('.agent-window-resize-handle');
  if (!handle) return;
  let resizing = false, startY = 0, origHeight = 0;

  handle.addEventListener('mousedown', (e) => {
    resizing = true;
    startY = e.clientY;
    origHeight = el.offsetHeight;
    handle.classList.add('active');
    el.style.transition = 'none'; // disable height transition while dragging
    e.preventDefault();
  });
  document.addEventListener('mousemove', (e) => {
    if (!resizing) return;
    const dy = startY - e.clientY; // drag up = positive
    const newH = Math.max(100, Math.min(window.innerHeight - 40, origHeight + dy));
    el.style.height = newH + 'px';
  });
  document.addEventListener('mouseup', () => {
    if (!resizing) return;
    resizing = false;
    handle.classList.remove('active');
    el.style.transition = '';
  });
}

// --- bd-inqge: Right Sidebar ---

let rightSidebarCollapsed = false;

function toggleRightSidebar() {
  const sidebar = document.getElementById('right-sidebar');
  if (!sidebar) return;
  rightSidebarCollapsed = !rightSidebarCollapsed;
  sidebar.classList.toggle('collapsed', rightSidebarCollapsed);
  const btn = document.getElementById('rs-collapse');
  if (btn) btn.innerHTML = rightSidebarCollapsed ? '&#x25C0;' : '&#x25B6;';
  // Shift controls bar when sidebar collapses/expands (bd-kj8e5)
  const controls = document.getElementById('controls');
  if (controls) controls.classList.toggle('sidebar-collapsed', rightSidebarCollapsed);
}

function initRightSidebar() {
  const sidebar = document.getElementById('right-sidebar');
  if (!sidebar) return;

  // Collapse button
  const collapseBtn = document.getElementById('rs-collapse');
  if (collapseBtn) collapseBtn.onclick = () => toggleRightSidebar();

  // Collapsible sections
  sidebar.querySelectorAll('.rs-section-header').forEach(header => {
    header.onclick = () => header.parentElement.classList.toggle('collapsed');
  });
}

function updateRightSidebar() {
  if (!graphData || rightSidebarCollapsed) return;
  updateEpicProgress();
  updateDepHealth();
  updateDecisionQueue();
}

function updateEpicProgress() {
  const body = document.getElementById('rs-epics-body');
  if (!body || !graphData) return;

  // Find all epic nodes
  const epics = graphData.nodes.filter(n => n.issue_type === 'epic' && !n._hidden);
  if (epics.length === 0) { body.innerHTML = '<div class="rs-empty">no epics</div>'; return; }

  // For each epic, find children via parent-child links
  const html = epics.map(epic => {
    const children = graphData.links
      .filter(l => l.dep_type === 'parent-child' &&
        (typeof l.source === 'object' ? l.source.id : l.source) === epic.id)
      .map(l => {
        const tgtId = typeof l.target === 'object' ? l.target.id : l.target;
        return graphData.nodes.find(n => n.id === tgtId);
      })
      .filter(Boolean);

    const total = children.length;
    if (total === 0) return '';

    const closed = children.filter(c => c.status === 'closed').length;
    const active = children.filter(c => c.status === 'in_progress').length;
    const blocked = children.filter(c => c._blocked).length;
    const pct = Math.round((closed / total) * 100);

    const closedW = (closed / total) * 100;
    const activeW = (active / total) * 100;
    const blockedW = (blocked / total) * 100;

    const name = epic.title || epic.id.replace(/^[a-z]+-/, '');
    return `<div class="rs-epic-item" data-node-id="${escapeHtml(epic.id)}" title="${escapeHtml(epic.id)}: ${escapeHtml(epic.title || '')}">
      <div class="rs-epic-name">${escapeHtml(name)} <span class="rs-epic-pct">${pct}%</span></div>
      <div class="rs-epic-bar">
        <span style="width:${closedW}%;background:#2d8a4e"></span>
        <span style="width:${activeW}%;background:#d4a017"></span>
        <span style="width:${blockedW}%;background:#d04040"></span>
      </div>
    </div>`;
  }).filter(Boolean).join('');

  body.innerHTML = html || '<div class="rs-empty">no epics with children</div>';

  // Click to fly to epic
  body.querySelectorAll('.rs-epic-item').forEach(el => {
    el.onclick = () => {
      const nodeId = el.dataset.nodeId;
      const node = graphData.nodes.find(n => n.id === nodeId);
      if (node) handleNodeClick(node);
    };
  });
}

function updateDepHealth() {
  const body = document.getElementById('rs-health-body');
  if (!body || !graphData) return;

  const blocked = graphData.nodes.filter(n => n._blocked && !n._hidden && n.status !== 'closed');
  if (blocked.length === 0) {
    body.innerHTML = '<div class="rs-empty">no blocked items</div>';
    return;
  }

  const html = blocked.slice(0, 15).map(n => {
    const name = n.title || n.id.replace(/^[a-z]+-/, '');
    return `<div class="rs-blocked-item" data-node-id="${escapeHtml(n.id)}" title="${escapeHtml(n.id)}">${escapeHtml(name)}</div>`;
  }).join('');

  body.innerHTML = `<div style="font-size:9px;color:#d04040;margin-bottom:4px">${blocked.length} blocked</div>${html}`;

  body.querySelectorAll('.rs-blocked-item').forEach(el => {
    el.onclick = () => {
      const node = graphData.nodes.find(n => n.id === el.dataset.nodeId);
      if (node) handleNodeClick(node);
    };
  });
}

function updateDecisionQueue() {
  const body = document.getElementById('rs-decisions-body');
  if (!body || !graphData) return;

  // Find decision/gate nodes that are pending
  const decisions = graphData.nodes.filter(n =>
    (n.issue_type === 'decision' || n.issue_type === 'gate') &&
    n.status !== 'closed' && !n._hidden
  );

  if (decisions.length === 0) {
    body.innerHTML = '<div class="rs-empty">no pending decisions</div>';
    return;
  }

  const html = decisions.slice(0, 8).map(d => {
    const prompt = d.title || d.id;
    return `<div class="rs-decision-item" data-node-id="${escapeHtml(d.id)}">
      <div class="rs-decision-prompt">${escapeHtml(prompt)}</div>
    </div>`;
  }).join('');

  body.innerHTML = html;

  body.querySelectorAll('.rs-decision-item').forEach(el => {
    el.onclick = () => {
      const node = graphData.nodes.find(n => n.id === el.dataset.nodeId);
      if (node) handleNodeClick(node);
    };
  });
}

// --- bd-69y6v: Control Panel ---

let controlPanelOpen = false;

function toggleControlPanel() {
  const panel = document.getElementById('control-panel');
  if (!panel) return;
  controlPanelOpen = !controlPanelOpen;
  panel.classList.toggle('open', controlPanelOpen);
}

function initControlPanel() {
  const panel = document.getElementById('control-panel');
  if (!panel) return;

  // Toggle button
  const btn = document.getElementById('btn-control-panel');
  if (btn) btn.onclick = () => toggleControlPanel();

  // Close button
  const closeBtn = document.getElementById('cp-close');
  if (closeBtn) closeBtn.onclick = () => { controlPanelOpen = false; panel.classList.remove('open'); };

  // Collapsible sections
  panel.querySelectorAll('.cp-section-header').forEach(header => {
    header.onclick = () => header.parentElement.classList.toggle('collapsed');
  });

  // Helper: wire a slider to its value display and a callback
  function wireSlider(id, cb) {
    const slider = document.getElementById(id);
    const valEl = document.getElementById(id + '-val');
    if (!slider) return;
    slider.addEventListener('input', () => {
      const v = parseFloat(slider.value);
      if (valEl) valEl.textContent = Number.isInteger(v) ? v : v.toFixed(2);
      cb(v);
    });
  }

  // Bloom controls
  wireSlider('cp-bloom-threshold', v => { if (bloomPass) bloomPass.threshold = v; });
  wireSlider('cp-bloom-strength', v => { if (bloomPass) bloomPass.strength = v; });
  wireSlider('cp-bloom-radius', v => { if (bloomPass) bloomPass.radius = v; });

  // Shader controls — update fresnel materials on all glow shells
  wireSlider('cp-fresnel-opacity', v => {
    if (!graph) return;
    graph.scene().traverse(obj => {
      if (obj.material?.uniforms?.opacity && obj.material?.uniforms?.power) {
        obj.material.uniforms.opacity.value = v;
      }
    });
  });
  wireSlider('cp-fresnel-power', v => {
    if (!graph) return;
    graph.scene().traverse(obj => {
      if (obj.material?.uniforms?.opacity && obj.material?.uniforms?.power) {
        obj.material.uniforms.power.value = v;
      }
    });
  });
  wireSlider('cp-pulse-speed', v => {
    // Update pulseCycle uniform on all pulse ring materials (bd-b3ujw)
    if (!graph) return;
    graph.scene().traverse(obj => {
      if (obj.material?.uniforms?.pulseCycle) {
        obj.material.uniforms.pulseCycle.value = v;
      }
    });
  });

  // Star field controls
  wireSlider('cp-star-count', v => {
    if (!graph) return;
    const scene = graph.scene();
    // Remove existing star field
    scene.traverse(obj => { if (obj.userData?.isStarField) scene.remove(obj); });
    // Add new one with updated count
    if (v > 0) {
      const stars = createStarField(v, 500);
      scene.add(stars);
    }
  });
  wireSlider('cp-twinkle-speed', v => {
    // Update twinkleSpeed uniform on star field (bd-b3ujw)
    if (!graph) return;
    graph.scene().traverse(obj => {
      if (obj.userData?.isStarField && obj.material?.uniforms?.twinkleSpeed) {
        obj.material.uniforms.twinkleSpeed.value = v;
      }
    });
  });

  // Background color
  const bgColor = document.getElementById('cp-bg-color');
  if (bgColor) {
    bgColor.addEventListener('input', () => {
      if (!graph) return;
      graph.scene().background = new THREE.Color(bgColor.value);
    });
  }

  // Node color overrides — stored in a config object
  window.__beads3d_colorOverrides = {};
  let _colorDebounce = null;
  const colorMap = {
    'cp-color-open': 'open',
    'cp-color-active': 'in_progress',
    'cp-color-blocked': 'blocked',
    'cp-color-agent': 'agent',
    'cp-color-epic': 'epic',
  };
  for (const [elId, key] of Object.entries(colorMap)) {
    const el = document.getElementById(elId);
    if (!el) continue;
    el.addEventListener('input', () => {
      window.__beads3d_colorOverrides[key] = el.value;
      // Debounced re-render — color pickers fire rapidly
      clearTimeout(_colorDebounce);
      _colorDebounce = setTimeout(() => {
        if (graph) graph.nodeThreeObject(graph.nodeThreeObject());
      }, 150);
    });
  }

  // Label controls
  wireSlider('cp-label-size', v => { window.__beads3d_labelSize = v; });
  wireSlider('cp-label-opacity', v => { window.__beads3d_labelOpacity = v; });

  // Layout controls (bd-a1odd)
  wireSlider('cp-force-strength', v => { if (graph) { graph.d3Force('charge')?.strength(-v); graph.d3ReheatSimulation(); } });
  wireSlider('cp-link-distance', v => { if (graph) { graph.d3Force('link')?.distance(v); graph.d3ReheatSimulation(); } });
  wireSlider('cp-center-force', v => { if (graph) { graph.d3Force('center')?.strength(v); graph.d3ReheatSimulation(); } });
  wireSlider('cp-collision-radius', v => {
    if (graph) {
      if (v > 0) {
        graph.d3Force('collision', (alpha) => {
          const nodes = graphData.nodes;
          for (let i = 0; i < nodes.length; i++) { for (let j = i + 1; j < nodes.length; j++) {
            const a = nodes[i], b = nodes[j]; if (a._hidden || b._hidden) continue;
            const dx = (b.x||0)-(a.x||0), dy = (b.y||0)-(a.y||0), dz = (b.z||0)-(a.z||0);
            const dist = Math.sqrt(dx*dx+dy*dy+dz*dz) || 1;
            if (dist < v*2) { const f = ((v*2-dist)/dist)*alpha*0.5;
              a.vx-=dx*f; a.vy-=dy*f; a.vz-=dz*f; b.vx+=dx*f; b.vy+=dy*f; b.vz+=dz*f; }
          }}
        });
      } else { graph.d3Force('collision', null); }
      graph.d3ReheatSimulation();
    }
  });
  wireSlider('cp-alpha-decay', v => { if (graph) graph.d3AlphaDecay(v); });
  // Layout mode dropdown (bd-a1odd)
  { const sel = document.getElementById('cp-layout-mode');
    if (sel) sel.addEventListener('change', () => setLayout(sel.value)); }

  // Animation controls
  wireSlider('cp-fly-speed', v => { window.__beads3d_flySpeed = v; });

  // Particles / VFX controls (bd-hr5om)
  wireSlider('cp-orbit-speed', v => { _vfxConfig.orbitSpeed = v; });
  wireSlider('cp-orbit-rate', v => { _vfxConfig.orbitRate = v; });
  wireSlider('cp-orbit-size', v => { _vfxConfig.orbitSize = v; });
  wireSlider('cp-hover-rate', v => { _vfxConfig.hoverRate = v; });
  wireSlider('cp-stream-rate', v => { _vfxConfig.streamRate = v; });
  wireSlider('cp-stream-speed', v => { _vfxConfig.streamSpeed = v; });
  wireSlider('cp-particle-lifetime', v => { _vfxConfig.particleLifetime = v; });
  wireSlider('cp-selection-glow', v => { _vfxConfig.selectionGlow = v; });

  // Camera controls (bd-bz1ba)
  wireSlider('cp-camera-fov', v => {
    if (!graph) return;
    const camera = graph.camera();
    camera.fov = v;
    camera.updateProjectionMatrix();
  });
  wireSlider('cp-camera-rotate-speed', v => {
    if (!graph) return;
    const controls = graph.controls();
    if (controls) controls.autoRotateSpeed = v;
  });
  wireSlider('cp-camera-zoom-speed', v => {
    if (!graph) return;
    const controls = graph.controls();
    if (controls) controls.zoomSpeed = v;
  });
  wireSlider('cp-camera-near', v => {
    if (!graph) return;
    const camera = graph.camera();
    camera.near = v;
    camera.updateProjectionMatrix();
  });
  wireSlider('cp-camera-far', v => {
    if (!graph) return;
    const camera = graph.camera();
    camera.far = v;
    camera.updateProjectionMatrix();
  });
  // Auto-rotate toggle
  const autoRotateToggle = document.getElementById('cp-camera-autorotate');
  if (autoRotateToggle) {
    autoRotateToggle.onclick = () => {
      autoRotateToggle.classList.toggle('on');
      if (!graph) return;
      const controls = graph.controls();
      if (controls) controls.autoRotate = autoRotateToggle.classList.contains('on');
    };
  }

  // bd-4hggh: HUD Visibility toggles
  // Track which HUD elements the user has hidden via toggles (prevents
  // other code from re-showing them, e.g. tooltip on hover).
  const _hudHidden = {};

  panel.querySelectorAll('.cp-toggle[data-target]').forEach(toggle => {
    const targetId = toggle.dataset.target;
    toggle.addEventListener('click', () => {
      const isOn = toggle.classList.toggle('on');
      _hudHidden[targetId] = !isOn;
      const el = document.getElementById(targetId);
      if (!el) return;

      if (targetId === 'minimap') {
        // Minimap has both canvas and label
        el.style.display = isOn ? 'block' : 'none';
        const label = document.getElementById('minimap-label');
        if (label) label.style.display = isOn ? 'block' : 'none';
        minimapVisible = isOn;
      } else if (targetId === 'left-sidebar') {
        if (isOn) { el.classList.add('open'); leftSidebarOpen = true; }
        else { el.classList.remove('open'); leftSidebarOpen = false; }
      } else if (targetId === 'right-sidebar') {
        if (isOn) { el.classList.remove('collapsed'); rightSidebarCollapsed = false; }
        else { el.classList.add('collapsed'); rightSidebarCollapsed = true; }
        // Shift controls bar
        const controls = document.getElementById('controls');
        if (controls) controls.classList.toggle('sidebar-collapsed', !isOn);
      } else {
        el.style.display = isOn ? '' : 'none';
      }
    });
  });

  // Expose _hudHidden so tooltip code can check it
  window.__beads3d_hudHidden = _hudHidden;

  // bd-krh7y: Theme presets
  const BUILT_IN_PRESETS = {
    'Default Dark': {
      'cp-bloom-threshold': 0.35, 'cp-bloom-strength': 0.7, 'cp-bloom-radius': 0.4,
      'cp-fresnel-opacity': 0.4, 'cp-fresnel-power': 2.0, 'cp-pulse-speed': 4.0,
      'cp-star-count': 2000, 'cp-twinkle-speed': 1.0,
      'cp-bg-color': '#000005',
      'cp-color-open': '#2d8a4e', 'cp-color-active': '#d4a017',
      'cp-color-blocked': '#d04040', 'cp-color-agent': '#ff6b35', 'cp-color-epic': '#8b45a6',
      'cp-label-size': 11, 'cp-label-opacity': 0.8,
      'cp-force-strength': 60, 'cp-link-distance': 60, 'cp-center-force': 1, 'cp-collision-radius': 0, 'cp-alpha-decay': 0.023,
      'cp-fly-speed': 1000,
      'cp-orbit-speed': 2.5, 'cp-orbit-rate': 0.08, 'cp-orbit-size': 1.5,
      'cp-hover-rate': 0.15, 'cp-stream-rate': 0.12, 'cp-stream-speed': 3.0,
      'cp-particle-lifetime': 0.8, 'cp-selection-glow': 1.0,
      'cp-camera-fov': 75, 'cp-camera-rotate-speed': 2.0, 'cp-camera-zoom-speed': 1.0,
      'cp-camera-near': 0.1, 'cp-camera-far': 50000,
      'cp-hud-stats': 1, 'cp-hud-bottom': 1, 'cp-hud-controls': 1,
      'cp-hud-left-sidebar': 1, 'cp-hud-right-sidebar': 1, 'cp-hud-minimap': 1, 'cp-hud-tooltip': 1,
    },
    'Neon': {
      'cp-bloom-threshold': 0.15, 'cp-bloom-strength': 1.8, 'cp-bloom-radius': 0.6,
      'cp-fresnel-opacity': 0.7, 'cp-fresnel-power': 1.5, 'cp-pulse-speed': 2.0,
      'cp-star-count': 3000, 'cp-twinkle-speed': 2.0,
      'cp-bg-color': '#050510',
      'cp-color-open': '#00ff88', 'cp-color-active': '#ffee00',
      'cp-color-blocked': '#ff2050', 'cp-color-agent': '#ff8800', 'cp-color-epic': '#cc44ff',
      'cp-label-size': 12, 'cp-label-opacity': 0.9,
      'cp-force-strength': 80, 'cp-link-distance': 50, 'cp-center-force': 1, 'cp-collision-radius': 0, 'cp-alpha-decay': 0.023,
      'cp-fly-speed': 800,
      'cp-orbit-speed': 4.0, 'cp-orbit-rate': 0.05, 'cp-orbit-size': 2.0,
      'cp-hover-rate': 0.08, 'cp-stream-rate': 0.06, 'cp-stream-speed': 5.0,
      'cp-particle-lifetime': 1.2, 'cp-selection-glow': 1.5,
      'cp-camera-fov': 60, 'cp-camera-rotate-speed': 3.0, 'cp-camera-zoom-speed': 1.5,
      'cp-camera-near': 0.1, 'cp-camera-far': 50000,
      'cp-hud-stats': 1, 'cp-hud-bottom': 1, 'cp-hud-controls': 1,
      'cp-hud-left-sidebar': 1, 'cp-hud-right-sidebar': 1, 'cp-hud-minimap': 1, 'cp-hud-tooltip': 1,
    },
    'High Contrast': {
      'cp-bloom-threshold': 0.8, 'cp-bloom-strength': 0.3, 'cp-bloom-radius': 0.2,
      'cp-fresnel-opacity': 0.2, 'cp-fresnel-power': 3.0, 'cp-pulse-speed': 4.0,
      'cp-star-count': 500, 'cp-twinkle-speed': 0.5,
      'cp-bg-color': '#000000',
      'cp-color-open': '#00cc44', 'cp-color-active': '#ffcc00',
      'cp-color-blocked': '#ff0000', 'cp-color-agent': '#ff8844', 'cp-color-epic': '#aa44cc',
      'cp-label-size': 13, 'cp-label-opacity': 1.0,
      'cp-force-strength': 60, 'cp-link-distance': 60, 'cp-center-force': 1, 'cp-collision-radius': 0, 'cp-alpha-decay': 0.023,
      'cp-fly-speed': 1000,
      'cp-orbit-speed': 1.5, 'cp-orbit-rate': 0.15, 'cp-orbit-size': 1.0,
      'cp-hover-rate': 0.25, 'cp-stream-rate': 0.2, 'cp-stream-speed': 2.0,
      'cp-particle-lifetime': 0.5, 'cp-selection-glow': 0.6,
      'cp-camera-fov': 75, 'cp-camera-rotate-speed': 2.0, 'cp-camera-zoom-speed': 1.0,
      'cp-camera-near': 0.1, 'cp-camera-far': 50000,
      'cp-hud-stats': 1, 'cp-hud-bottom': 1, 'cp-hud-controls': 1,
      'cp-hud-left-sidebar': 1, 'cp-hud-right-sidebar': 1, 'cp-hud-minimap': 1, 'cp-hud-tooltip': 1,
    },
  };

  function applyPreset(settings) {
    for (const [id, val] of Object.entries(settings)) {
      const el = document.getElementById(id);
      if (!el) continue;
      if (el.classList.contains('cp-toggle')) {
        // HUD visibility toggle: val=1 means on, val=0 means off
        const shouldBeOn = val === 1 || val === true;
        if (el.classList.contains('on') !== shouldBeOn) {
          el.click(); // triggers the toggle handler
        }
      } else {
        el.value = val;
        el.dispatchEvent(new Event('input')); // triggers all wired handlers
      }
    }
  }

  function getCurrentSettings() {
    const settings = {};
    const ids = Object.keys(BUILT_IN_PRESETS['Default Dark']);
    for (const id of ids) {
      const el = document.getElementById(id);
      if (!el) continue;
      if (el.classList.contains('cp-toggle')) {
        settings[id] = el.classList.contains('on') ? 1 : 0;
      } else {
        settings[id] = el.type === 'color' ? el.value : parseFloat(el.value);
      }
    }
    return settings;
  }

  // Render preset buttons
  const presetContainer = document.getElementById('cp-preset-buttons');
  if (presetContainer) {
    function renderPresetButtons() {
      presetContainer.innerHTML = '';
      // Built-in presets
      for (const name of Object.keys(BUILT_IN_PRESETS)) {
        const btn = document.createElement('button');
        btn.className = 'cp-preset-btn';
        btn.textContent = name;
        btn.onclick = () => applyPreset(BUILT_IN_PRESETS[name]);
        presetContainer.appendChild(btn);
      }
      // Custom presets from localStorage
      const custom = JSON.parse(localStorage.getItem('beads3d-custom-presets') || '{}');
      for (const name of Object.keys(custom)) {
        const btn = document.createElement('button');
        btn.className = 'cp-preset-btn';
        btn.textContent = name;
        btn.onclick = () => applyPreset(custom[name]);
        btn.oncontextmenu = (e) => {
          e.preventDefault();
          delete custom[name];
          localStorage.setItem('beads3d-custom-presets', JSON.stringify(custom));
          renderPresetButtons();
        };
        btn.title = 'Click to load, right-click to delete';
        presetContainer.appendChild(btn);
      }
      // Save button
      const saveBtn = document.createElement('button');
      saveBtn.className = 'cp-preset-btn';
      saveBtn.textContent = '+ save';
      saveBtn.style.color = '#39c5cf';
      saveBtn.onclick = () => {
        const name = prompt('Preset name:');
        if (!name) return;
        custom[name] = getCurrentSettings();
        localStorage.setItem('beads3d-custom-presets', JSON.stringify(custom));
        renderPresetButtons();
      };
      presetContainer.appendChild(saveBtn);
    }
    renderPresetButtons();
  }


  // --- Preset import/export (bd-n0g9q) ---
  const exportBtn = document.getElementById('cp-preset-export');
  if (exportBtn) {
    exportBtn.onclick = () => {
      const settings = getCurrentSettings();
      const blob = new Blob([JSON.stringify(settings, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'beads3d-theme.json';
      a.click();
      URL.revokeObjectURL(a.href);
    };
  }
  const importBtn = document.getElementById('cp-preset-import');
  const fileInput = document.getElementById('cp-preset-file-input');
  if (importBtn && fileInput) {
    importBtn.onclick = () => fileInput.click();
    fileInput.onchange = () => {
      const file = fileInput.files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        try {
          const settings = JSON.parse(reader.result);
          if (settings && typeof settings === 'object') applyPreset(settings);
        } catch { console.warn('[beads3d] failed to import preset'); }
      };
      reader.readAsText(file);
      fileInput.value = '';
    };
  }
  const copyUrlBtn = document.getElementById('cp-preset-copy-url');
  if (copyUrlBtn) {
    copyUrlBtn.onclick = () => {
      const settings = getCurrentSettings();
      const encoded = btoa(JSON.stringify(settings));
      const url = `${location.origin}${location.pathname}#preset=${encoded}`;
      navigator.clipboard.writeText(url).then(() => {
        copyUrlBtn.textContent = 'copied!';
        setTimeout(() => { copyUrlBtn.textContent = 'copy URL'; }, 1500);
      }).catch(() => { prompt('Copy this URL:', url); });
    };
  }
  // Apply preset from URL fragment on load
  if (location.hash.startsWith('#preset=')) {
    try {
      const settings = JSON.parse(atob(location.hash.slice('#preset='.length)));
      if (settings && typeof settings === 'object') applyPreset(settings);
    } catch { /* ignore invalid fragment */ }
  }
  // --- Config bead persistence (bd-ljy5v) ---
  // Load saved settings from daemon on startup, save changes back with debounce.
  const CONFIG_KEY = 'beads3d-control-panel-settings';
  let _persistDebounce = null;

  function persistSettings() {
    clearTimeout(_persistDebounce);
    _persistDebounce = setTimeout(() => {
      const settings = getCurrentSettings();
      api.configSet(CONFIG_KEY, JSON.stringify(settings)).catch(err => {
        console.warn('[beads3d] failed to persist settings:', err.message);
      });
    }, 1000);
  }

  // Wire persistence to all control panel inputs
  panel.querySelectorAll('.cp-slider, input[type="color"]').forEach(input => {
    input.addEventListener('input', persistSettings);
  });

  // Load saved settings from config bead
  api.configGet(CONFIG_KEY).then(resp => {
    const val = resp?.value;
    if (!val) return;
    try {
      const settings = JSON.parse(val);
      if (settings && typeof settings === 'object') {
        applyPreset(settings);
        console.log('[beads3d] loaded control panel settings from config bead');
      }
    } catch {
      console.warn('[beads3d] failed to parse saved settings');
    }
  }).catch(() => {
    // Config bead not available — silently fall back to defaults
  });
}

// --- Agents View overlay — Shift+A (bd-jgvas) ---

function toggleAgentsView() {
  if (agentsViewOpen) {
    closeAgentsView();
  } else {
    openAgentsView();
  }
}

function openAgentsView() {
  const overlay = document.getElementById('agents-view');
  if (!overlay || !graphData) return;

  // Collect all agent nodes from graph
  const agentNodes = graphData.nodes.filter(n => n.issue_type === 'agent' && !n._hidden);
  if (agentNodes.length === 0) return;

  // Sort: active first, idle second, rest last; alphabetical within group
  const statusOrder = { active: 0, idle: 1 };
  agentNodes.sort((a, b) => {
    const sa = statusOrder[a.status] ?? 2;
    const sb = statusOrder[b.status] ?? 2;
    if (sa !== sb) return sa - sb;
    return (a.title || a.id).localeCompare(b.title || b.id);
  });

  // Count by status
  const counts = { active: 0, idle: 0, crashed: 0 };
  for (const n of agentNodes) {
    if (n.status === 'active') counts.active++;
    else if (n.status === 'idle') counts.idle++;
    else if (n.status === 'crashed') counts.crashed++;
  }

  overlay.innerHTML = `
    <div class="agents-view-header">
      <span class="agents-view-title">AGENTS</span>
      <input class="agents-view-search" type="text" placeholder="filter agents..." />
      <div class="agents-view-stats">
        <span class="active">${counts.active} active</span>
        <span class="idle">${counts.idle} idle</span>
        ${counts.crashed ? `<span class="crashed">${counts.crashed} crashed</span>` : ''}
        <span>${agentNodes.length} total</span>
      </div>
      <button class="agents-view-close">ESC close</button>
    </div>
    <div class="agents-view-grid"></div>
  `;

  overlay.querySelector('.agents-view-close').onclick = () => closeAgentsView();

  // Filter/search agent windows by name (bd-jgvas Phase 2)
  const searchEl = overlay.querySelector('.agents-view-search');
  searchEl.addEventListener('input', () => {
    const q = searchEl.value.toLowerCase().trim();
    for (const [, win] of agentWindows) {
      const name = (win.node.title || win.node.id).toLowerCase();
      win.el.style.display = (!q || name.includes(q)) ? '' : 'none';
    }
  });
  // Focus search on open, but don't steal from Escape handler
  setTimeout(() => searchEl.focus(), 100);

  const grid = overlay.querySelector('.agents-view-grid');

  // Open agent windows inside the overlay grid
  for (const node of agentNodes) {
    // If window already exists (from bottom tray), move it into the grid
    const existing = agentWindows.get(node.id);
    if (existing) {
      existing.collapsed = false;
      existing.el.classList.remove('collapsed');
      grid.appendChild(existing.el);
      continue;
    }

    // Create new window in the grid (reuse showAgentWindow logic inline)
    const el = document.createElement('div');
    el.className = 'agent-window';
    el.dataset.agentId = node.id;

    const agentName = node.title || node.id.replace('agent:', '');
    const agentStatus = (node.status || '').toLowerCase();
    const statusColor = agentStatus === 'active' ? '#2d8a4e' :
                         agentStatus === 'idle' ? '#d4a017' :
                         agentStatus === 'crashed' ? '#d04040' : '#666';

    // Find assigned beads
    const assigned = graphData.links
      .filter(l => l.dep_type === 'assigned_to' &&
        (typeof l.source === 'object' ? l.source.id : l.source) === node.id)
      .map(l => {
        const tgtId = typeof l.target === 'object' ? l.target.id : l.target;
        const tgtNode = graphData.nodes.find(n => n.id === tgtId);
        return tgtNode ? { id: tgtId, title: tgtNode.title || tgtId } : null;
      })
      .filter(Boolean);

    const beadsList = assigned
      .map(b => `<div class="agent-window-bead" data-bead-id="${escapeHtml(b.id)}" title="${escapeHtml(b.id)}: ${escapeHtml(b.title)}" style="cursor:pointer">${escapeHtml(b.id.replace(/^[a-z]+-/, ''))}: ${escapeHtml(b.title)}</div>`)
      .join('');

    const avRigBadge = node.rig
      ? `<span class="agent-window-rig" style="color:${rigColor(node.rig)};border-color:${rigColor(node.rig)}33">${escapeHtml(node.rig)}</span>`
      : '';

    const avStatusClass = agentStatus === 'active' ? 'status-active' : agentStatus === 'idle' ? 'status-idle' : agentStatus === 'crashed' ? 'status-crashed' : '';

    el.innerHTML = `
      <div class="agent-window-resize-handle"></div>
      <div class="agent-window-header">
        <span class="agent-window-name" style="cursor:pointer" title="Click to zoom to agent">${escapeHtml(agentName)}</span>
        ${avRigBadge}
        <span class="agent-window-badge" style="color:${statusColor}">${agentStatus || '?'}</span>
        <span class="agent-window-badge">${assigned.length}</span>
        <button class="agent-window-popout" title="Pop out to floating window">&#x2197;</button>
        <button class="agent-window-close">&times;</button>
      </div>
      <div class="agent-status-bar">
        <span><span class="status-label">Status:</span> <span class="agent-status-state ${avStatusClass}">${agentStatus || '?'}</span></span>
        <span class="agent-status-idle-dur"></span>
        <span class="agent-status-tool"></span>
      </div>
      ${beadsList ? `<div class="agent-window-beads">${beadsList}</div>` : ''}
      <div class="agent-feed"><div class="agent-window-empty">waiting for events...</div></div>
      <div class="agent-mail-compose">
        <input class="agent-mail-input" type="text" placeholder="Send message to ${escapeHtml(agentName)}..." />
        <button class="agent-mail-send">&#x2709;</button>
      </div>
    `;

    // bd-2ysfj: Click agent name to highlight + zoom to agent node in 3D scene
    el.querySelector('.agent-window-name').onclick = (e) => {
      e.stopPropagation();
      const agentNode = graphData.nodes.find(n => n.id === node.id);
      if (agentNode) handleNodeClick(agentNode);
    };

    // bd-xm78e: Click assigned bead to highlight + zoom to bead node in 3D scene
    const beadsContainer = el.querySelector('.agent-window-beads');
    if (beadsContainer) {
      beadsContainer.onclick = (e) => {
        const beadEl = e.target.closest('.agent-window-bead');
        if (!beadEl) return;
        const beadId = beadEl.dataset.beadId;
        if (!beadId) return;
        e.stopPropagation();
        const beadNode = graphData.nodes.find(n => n.id === beadId);
        if (beadNode) handleNodeClick(beadNode);
      };
    }

    const header = el.querySelector('.agent-window-header');
    header.onclick = (e) => {
      if (e.target.classList.contains('agent-window-close')) return;
      if (e.target.classList.contains('agent-window-name')) return; // bd-2ysfj: name has its own handler
      const win = agentWindows.get(node.id);
      if (win) {
        win.collapsed = !win.collapsed;
        el.classList.toggle('collapsed', win.collapsed);
      }
    };

    el.querySelector('.agent-window-close').onclick = () => closeAgentWindow(node.id);

    // bd-dqe6k: Pop-out / dock-back
    el.querySelector('.agent-window-popout').onclick = (e) => {
      e.stopPropagation();
      togglePopout(node.id);
    };

    // Mail compose
    const mailInput = el.querySelector('.agent-mail-input');
    const mailSend = el.querySelector('.agent-mail-send');
    const doSend = async () => {
      const text = mailInput.value.trim();
      if (!text) return;
      mailInput.value = '';
      mailInput.disabled = true;
      mailSend.disabled = true;
      try {
        await api.sendMail(agentName, text);
        const win = agentWindows.get(node.id);
        if (win) {
          const empty = win.feedEl.querySelector('.agent-window-empty');
          if (empty) empty.remove();
          const ts = new Date().toTimeString().slice(0, 8);
          win.feedEl.appendChild(createEntry(ts, '\u25b6', `sent: ${text}`, 'mail mail-sent'));
          autoScroll(win);
        }
      } catch (err) {
        console.error('[beads3d] mail send failed:', err);
        mailInput.value = text;
        const compose = el.querySelector('.agent-mail-compose');
        compose.classList.add('send-error');
        setTimeout(() => compose.classList.remove('send-error'), 2000);
      }
      mailInput.disabled = false;
      mailSend.disabled = false;
      mailInput.focus();
    };
    mailSend.onclick = doSend;
    mailInput.onkeydown = (e) => { if (e.key === 'Enter') doSend(); };

    grid.appendChild(el);

    const feedEl = el.querySelector('.agent-feed');
    const statusEl = el.querySelector('.agent-status-bar');
    agentWindows.set(node.id, {
      el, feedEl, statusEl, node,
      entries: [],
      pendingTool: null,
      collapsed: false,
      lastStatus: agentStatus || null,
      lastTool: null,
      idleSince: agentStatus === 'idle' ? Date.now() : null,
      crashError: null,
    });
    enableTopResize(el); // bd-9wxm9
  }

  overlay.classList.add('open');
  agentsViewOpen = true;
}

function closeAgentsView() {
  const overlay = document.getElementById('agents-view');
  if (!overlay) return;

  // Move windows back to bottom tray (don't destroy — preserves event history)
  const tray = document.getElementById('agent-windows');
  if (tray) {
    for (const [, win] of agentWindows) {
      if (win.el.parentElement !== tray) {
        win.collapsed = true;
        win.el.classList.add('collapsed');
        tray.appendChild(win.el);
      }
    }
  }

  overlay.classList.remove('open');
  overlay.innerHTML = '';
  agentsViewOpen = false;
}

// Create an agent window inside the agents-view grid (bd-jgvas Phase 2: auto-open)
function createAgentWindowInGrid(node) {
  if (!node || agentWindows.has(node.id)) return;
  const overlay = document.getElementById('agents-view');
  if (!overlay) return;
  const grid = overlay.querySelector('.agents-view-grid');
  if (!grid) return;

  const el = document.createElement('div');
  el.className = 'agent-window';
  el.dataset.agentId = node.id;

  const agentName = node.title || node.id.replace('agent:', '');
  const agentStatus = (node.status || '').toLowerCase();
  const statusColor = agentStatus === 'active' ? '#2d8a4e' :
                       agentStatus === 'idle' ? '#d4a017' :
                       agentStatus === 'crashed' ? '#d04040' : '#666';

  const assigned = graphData ? graphData.links
    .filter(l => l.dep_type === 'assigned_to' &&
      (typeof l.source === 'object' ? l.source.id : l.source) === node.id)
    .map(l => {
      const tgtId = typeof l.target === 'object' ? l.target.id : l.target;
      const tgtNode = graphData.nodes.find(n => n.id === tgtId);
      return tgtNode ? { id: tgtId, title: tgtNode.title || tgtId } : null;
    })
    .filter(Boolean) : [];

  const beadsList = assigned
    .map(b => `<div class="agent-window-bead" data-bead-id="${escapeHtml(b.id)}" title="${escapeHtml(b.id)}: ${escapeHtml(b.title)}" style="cursor:pointer">${escapeHtml(b.id.replace(/^[a-z]+-/, ''))}: ${escapeHtml(b.title)}</div>`)
    .join('');

  const ciwStatusClass = agentStatus === 'active' ? 'status-active' : agentStatus === 'idle' ? 'status-idle' : agentStatus === 'crashed' ? 'status-crashed' : '';

  el.innerHTML = `
    <div class="agent-window-resize-handle"></div>
    <div class="agent-window-header">
      <span class="agent-window-name" style="cursor:pointer" title="Click to zoom to agent">${escapeHtml(agentName)}</span>
      <span class="agent-window-badge" style="color:${statusColor}">${agentStatus || '?'}</span>
      <span class="agent-window-badge">${assigned.length}</span>
      <button class="agent-window-popout" title="Pop out to floating window">&#x2197;</button>
      <button class="agent-window-close">&times;</button>
    </div>
    <div class="agent-status-bar">
      <span><span class="status-label">Status:</span> <span class="agent-status-state ${ciwStatusClass}">${agentStatus || '?'}</span></span>
      <span class="agent-status-idle-dur"></span>
      <span class="agent-status-tool"></span>
    </div>
    ${beadsList ? `<div class="agent-window-beads">${beadsList}</div>` : ''}
    <div class="agent-feed"><div class="agent-window-empty">waiting for events...</div></div>
    <div class="agent-mail-compose">
      <input class="agent-mail-input" type="text" placeholder="Send message to ${escapeHtml(agentName)}..." />
      <button class="agent-mail-send">&#x2709;</button>
    </div>
  `;

  // bd-2ysfj: Click agent name to highlight + zoom to agent node in 3D scene
  el.querySelector('.agent-window-name').onclick = (e) => {
    e.stopPropagation();
    const agentNode = graphData.nodes.find(n => n.id === node.id);
    if (agentNode) handleNodeClick(agentNode);
  };

  // bd-xm78e: Click assigned bead to highlight + zoom to bead node in 3D scene
  const beadsContainer = el.querySelector('.agent-window-beads');
  if (beadsContainer) {
    beadsContainer.onclick = (e) => {
      const beadEl = e.target.closest('.agent-window-bead');
      if (!beadEl) return;
      const beadId = beadEl.dataset.beadId;
      if (!beadId) return;
      e.stopPropagation();
      const beadNode = graphData.nodes.find(n => n.id === beadId);
      if (beadNode) handleNodeClick(beadNode);
    };
  }

  const header = el.querySelector('.agent-window-header');
  header.onclick = (e) => {
    if (e.target.classList.contains('agent-window-close')) return;
    if (e.target.classList.contains('agent-window-name')) return; // bd-2ysfj: name has its own handler
    const win = agentWindows.get(node.id);
    if (win) {
      win.collapsed = !win.collapsed;
      el.classList.toggle('collapsed', win.collapsed);
    }
  };

  el.querySelector('.agent-window-close').onclick = () => closeAgentWindow(node.id);

  // bd-dqe6k: Pop-out / dock-back
  el.querySelector('.agent-window-popout').onclick = (e) => {
    e.stopPropagation();
    togglePopout(node.id);
  };

  // Mail compose
  const mailInput = el.querySelector('.agent-mail-input');
  const mailSend = el.querySelector('.agent-mail-send');
  const doSend = async () => {
    const text = mailInput.value.trim();
    if (!text) return;
    mailInput.value = '';
    mailInput.disabled = true;
    mailSend.disabled = true;
    try {
      await api.sendMail(agentName, text);
      const win = agentWindows.get(node.id);
      if (win) {
        const empty = win.feedEl.querySelector('.agent-window-empty');
        if (empty) empty.remove();
        const ts = new Date().toTimeString().slice(0, 8);
        win.feedEl.appendChild(createEntry(ts, '\u25b6', `sent: ${text}`, 'mail mail-sent'));
        autoScroll(win);
      }
    } catch (err) {
      console.error('[beads3d] mail send failed:', err);
      mailInput.value = text;
      const compose = el.querySelector('.agent-mail-compose');
      compose.classList.add('send-error');
      setTimeout(() => compose.classList.remove('send-error'), 2000);
    }
    mailInput.disabled = false;
    mailSend.disabled = false;
    mailInput.focus();
  };
  mailSend.onclick = doSend;
  mailInput.onkeydown = (e) => { if (e.key === 'Enter') doSend(); };

  grid.appendChild(el);

  const feedEl = el.querySelector('.agent-feed');
  const statusEl = el.querySelector('.agent-status-bar');
  agentWindows.set(node.id, {
    el, feedEl, statusEl, node,
    entries: [],
    pendingTool: null,
    collapsed: false,
    lastStatus: agentStatus || null,
    lastTool: null,
    idleSince: agentStatus === 'idle' ? Date.now() : null,
    crashError: null,
  });
  enableTopResize(el); // bd-9wxm9

  // Update the header stats count
  updateAgentsViewStats();
}

// Update the stats line in the overlay header (bd-jgvas Phase 2)
function updateAgentsViewStats() {
  const overlay = document.getElementById('agents-view');
  if (!overlay) return;
  const statsEl = overlay.querySelector('.agents-view-stats');
  if (!statsEl || !graphData) return;
  const agentNodes = graphData.nodes.filter(n => n.issue_type === 'agent' && !n._hidden);
  const counts = { active: 0, idle: 0, crashed: 0 };
  for (const n of agentNodes) {
    if (n.status === 'active') counts.active++;
    else if (n.status === 'idle') counts.idle++;
    else if (n.status === 'crashed') counts.crashed++;
  }
  statsEl.innerHTML = `
    <span class="active">${counts.active} active</span>
    <span class="idle">${counts.idle} idle</span>
    ${counts.crashed ? `<span class="crashed">${counts.crashed} crashed</span>` : ''}
    <span>${agentNodes.length} total</span>
  `;
}

// --- Unified Activity Stream (bd-9ndk0.3) ---
const _unifiedFeed = { el: null, entries: [], maxEntries: 500, pendingTools: new Map() };
function initUnifiedFeed() {
  _unifiedFeed.el = document.getElementById('unified-feed');
  if (!_unifiedFeed.el) return;
  _unifiedFeed.el.innerHTML = '<div class="uf-empty">waiting for agent events...</div>';
  // Toggle button
  const toggleBtn = document.getElementById('unified-feed-toggle');
  if (toggleBtn) {
    toggleBtn.onclick = () => {
      const active = _unifiedFeed.el.classList.toggle('active');
      toggleBtn.textContent = active ? 'split' : 'unified';
    };
  }
}
function appendUnifiedEntry(agentId, evt) {
  if (!_unifiedFeed.el) return;
  const type = evt.type;
  const p = evt.payload || {};
  const ts = evt.ts ? new Date(evt.ts) : new Date();
  const timeStr = ts.toTimeString().slice(0, 8);
  // Extract short agent name from ID (e.g. "agent:cool-trout" → "cool-trout")
  const agentName = agentId.replace(/^agent:/, '');

  // Handle PreToolUse / PostToolUse pairing
  if (type === 'PreToolUse') {
    const label = formatToolLabel(p);
    const toolClass = `tool-${(p.tool_name || 'tool').toLowerCase()}`;
    const entry = createUnifiedEntry(timeStr, agentName, TOOL_ICONS[p.tool_name] || '·', label, toolClass + ' running');
    _unifiedFeed.el.appendChild(entry);
    _unifiedFeed.entries.push(entry);
    _unifiedFeed.pendingTools.set(agentId, { entry, startTs: ts.getTime() });
    trimUnifiedFeed();
    autoScrollUnified();
    return;
  }
  if (type === 'PostToolUse') {
    const pending = _unifiedFeed.pendingTools.get(agentId);
    if (pending) {
      const dur = (ts.getTime() - pending.startTs) / 1000;
      pending.entry.classList.remove('running');
      const durEl = pending.entry.querySelector('.uf-entry-dur');
      if (durEl && dur > 0.1) durEl.textContent = `${dur.toFixed(1)}s`;
      const iconEl = pending.entry.querySelector('.uf-entry-icon');
      if (iconEl) iconEl.textContent = '✓';
      _unifiedFeed.pendingTools.delete(agentId);
    }
    return;
  }
  // Map event types to display
  let icon, text, classes;
  if (type === 'AgentStarted') { icon = '●'; text = 'started'; classes = 'lifecycle lifecycle-started'; }
  else if (type === 'AgentIdle') { icon = '◌'; text = 'idle'; classes = 'lifecycle lifecycle-idle'; }
  else if (type === 'AgentCrashed') { icon = '✕'; text = 'crashed!'; classes = 'lifecycle lifecycle-crashed'; }
  else if (type === 'AgentStopped') { icon = '○'; text = 'stopped'; classes = 'lifecycle lifecycle-stopped'; }
  else if (type === 'SessionStart') { icon = '▸'; text = 'session start'; classes = 'lifecycle'; }
  else if (type === 'MutationCreate') { icon = '+'; text = `new: ${p.title || 'bead'}`; classes = 'mutation'; }
  else if (type === 'MutationClose') { icon = '✓'; text = `closed ${p.issue_id || ''}`; classes = 'mutation mutation-close'; }
  else if (type === 'MutationStatus') { icon = '~'; text = p.new_status || 'updated'; classes = 'mutation'; }
  else if (type === 'MutationUpdate') {
    if (p.assignee) { icon = '→'; text = `claimed by ${p.assignee}`; classes = 'mutation'; }
    else return;
  }
  else if (type === 'DecisionCreated') { icon = '?'; text = (p.question || 'decision').slice(0, 50); classes = 'decision decision-pending'; }
  else if (type === 'DecisionResponded') { icon = '✓'; text = `decided: ${p.chosen_label || 'resolved'}`; classes = 'decision decision-resolved'; }
  else if (type === 'DecisionExpired') { icon = '⏰'; text = 'decision expired'; classes = 'decision decision-expired'; }
  else if (type === 'MailSent') { icon = '✉'; text = `from ${p.from || '?'}: ${p.subject || ''}`; classes = 'mail mail-received'; }
  else if (type === 'MailRead') { icon = '✉'; text = 'mail read'; classes = 'mail'; }
  else return;

  const entry = createUnifiedEntry(timeStr, agentName, icon, text, classes);
  _unifiedFeed.el.appendChild(entry);
  _unifiedFeed.entries.push(entry);
  trimUnifiedFeed();
  autoScrollUnified();
}
function createUnifiedEntry(time, agent, icon, text, classes) {
  // Remove empty placeholder
  if (_unifiedFeed.el) {
    const empty = _unifiedFeed.el.querySelector('.uf-empty');
    if (empty) empty.remove();
  }
  const el = document.createElement('div');
  el.className = `uf-entry ${classes}`;
  el.innerHTML = `
    <span class="uf-entry-time">${escapeHtml(time)}</span>
    <span class="uf-entry-agent">${escapeHtml(agent)}</span>
    <span class="uf-entry-icon">${escapeHtml(icon)}</span>
    <span class="uf-entry-text">${escapeHtml(text)}</span>
    <span class="uf-entry-dur"></span>
  `;
  return el;
}
function trimUnifiedFeed() {
  while (_unifiedFeed.entries.length > _unifiedFeed.maxEntries) {
    const old = _unifiedFeed.entries.shift();
    if (old && old.parentNode) old.parentNode.removeChild(old);
  }
}
function autoScrollUnified() {
  if (!_unifiedFeed.el) return;
  const isNear = _unifiedFeed.el.scrollTop + _unifiedFeed.el.clientHeight >= _unifiedFeed.el.scrollHeight - 30;
  if (isNear || _unifiedFeed.entries.length <= 1) {
    requestAnimationFrame(() => { _unifiedFeed.el.scrollTop = _unifiedFeed.el.scrollHeight; });
  }
}

function appendAgentEvent(agentId, evt) {
  // Also append to unified feed (bd-9ndk0.3)
  appendUnifiedEntry(agentId, evt);

  const win = agentWindows.get(agentId);
  if (!win) return;

  // Clear the empty placeholder
  const empty = win.feedEl.querySelector('.agent-window-empty');
  if (empty) empty.remove();

  const type = evt.type;
  const p = evt.payload || {};
  const ts = evt.ts ? new Date(evt.ts) : new Date();
  const timeStr = ts.toTimeString().slice(0, 8); // HH:MM:SS

  // Handle PreToolUse / PostToolUse pairing
  if (type === 'PreToolUse') {
    const toolName = p.tool_name || 'tool';
    const icon = TOOL_ICONS[toolName] || '·';
    const toolClass = `tool-${toolName.toLowerCase()}`;
    const label = formatToolLabel(p);

    const entry = createEntry(timeStr, icon, label, toolClass + ' running');
    win.feedEl.appendChild(entry);
    win.entries.push(entry);
    win.pendingTool = { toolName, startTs: ts.getTime(), entry };
    // bd-5ok9s: track last tool used
    win.lastTool = toolName;
    win.lastStatus = 'active';
    win.idleSince = null;
    win.crashError = null;
    _updateAgentStatusBar(win);
    autoScroll(win);
    return;
  }

  if (type === 'PostToolUse') {
    if (win.pendingTool) {
      const dur = (ts.getTime() - win.pendingTool.startTs) / 1000;
      win.pendingTool.entry.classList.remove('running');
      const durEl = win.pendingTool.entry.querySelector('.agent-entry-dur');
      if (durEl && dur > 0.1) durEl.textContent = `${dur.toFixed(1)}s`;
      const iconEl = win.pendingTool.entry.querySelector('.agent-entry-icon');
      if (iconEl) iconEl.textContent = '✓';
      win.pendingTool = null;
    }
    return; // Don't add a separate row
  }

  // Lifecycle events — bd-5ok9s: update status tracking
  if (type === 'AgentStarted') {
    win.feedEl.appendChild(createEntry(timeStr, '●', 'started', 'lifecycle lifecycle-started'));
    win.lastStatus = 'active';
    win.idleSince = null;
    win.crashError = null;
    win.lastTool = null;
  } else if (type === 'AgentIdle') {
    win.feedEl.appendChild(createEntry(timeStr, '◌', 'idle', 'lifecycle lifecycle-idle'));
    win.lastStatus = 'idle';
    win.idleSince = ts.getTime();
    win.crashError = null;
  } else if (type === 'AgentCrashed') {
    win.feedEl.appendChild(createEntry(timeStr, '✕', 'crashed!', 'lifecycle lifecycle-crashed'));
    win.lastStatus = 'crashed';
    win.idleSince = null;
    win.crashError = p.error || 'unknown error';
  } else if (type === 'AgentStopped') {
    win.feedEl.appendChild(createEntry(timeStr, '○', 'stopped', 'lifecycle lifecycle-stopped'));
    win.lastStatus = 'stopped';
    win.idleSince = null;
  } else if (type === 'SessionStart') {
    win.feedEl.appendChild(createEntry(timeStr, '▸', 'session start', 'lifecycle'));
    win.lastStatus = 'active';
    win.idleSince = null;
    win.crashError = null;
  }
  // Mutation events
  else if (type === 'MutationCreate') {
    const title = p.title || 'new bead';
    win.feedEl.appendChild(createEntry(timeStr, '+', `new: ${title}`, 'mutation'));
  } else if (type === 'MutationClose') {
    const issueId = p.issue_id || '';
    win.feedEl.appendChild(createEntry(timeStr, '✓', `closed ${issueId}`, 'mutation mutation-close'));
  } else if (type === 'MutationStatus') {
    const status = p.new_status || 'updated';
    win.feedEl.appendChild(createEntry(timeStr, '~', status, 'mutation'));
  } else if (type === 'MutationUpdate') {
    // Skip most updates (too noisy), but show assignee claims
    if (p.assignee) {
      win.feedEl.appendChild(createEntry(timeStr, '→', `claimed by ${p.assignee}`, 'mutation'));
    }
    return;
  }
  // OJ events
  else if (type === 'OjJobCreated') {
    win.feedEl.appendChild(createEntry(timeStr, '⚙', 'job created', 'lifecycle'));
  } else if (type === 'OjJobCompleted') {
    win.feedEl.appendChild(createEntry(timeStr, '✓', 'job done', 'lifecycle lifecycle-started'));
  } else if (type === 'OjJobFailed') {
    win.feedEl.appendChild(createEntry(timeStr, '✕', 'job failed!', 'lifecycle lifecycle-crashed'));
  }
  // Mail events (bd-t76aw)
  else if (type === 'MailSent') {
    const from = p.from || 'unknown';
    const subject = p.subject || 'no subject';
    win.feedEl.appendChild(createEntry(timeStr, '✉', `from ${from}: ${subject}`, 'mail mail-received'));
  } else if (type === 'MailRead') {
    win.feedEl.appendChild(createEntry(timeStr, '✉', 'mail read', 'mail'));
  }
  // Decision events (bd-0j7hr)
  else if (type === 'DecisionCreated') {
    const q = (p.question || 'decision').slice(0, 50);
    win.feedEl.appendChild(createEntry(timeStr, '?', q, 'decision decision-pending'));
  } else if (type === 'DecisionResponded') {
    const choice = p.chosen_label || 'resolved';
    win.feedEl.appendChild(createEntry(timeStr, '✓', `decided: ${choice}`, 'decision decision-resolved'));
  } else if (type === 'DecisionExpired') {
    win.feedEl.appendChild(createEntry(timeStr, '⏰', 'decision expired', 'decision decision-expired'));
  } else if (type === 'DecisionEscalated') {
    win.feedEl.appendChild(createEntry(timeStr, '!', 'decision escalated', 'decision decision-escalated'));
  }
  // Skip other event types silently
  else {
    return;
  }

  // bd-5ok9s: update status bar after any lifecycle event
  _updateAgentStatusBar(win);
  autoScroll(win);
}

function formatToolLabel(payload) {
  const toolName = payload.tool_name || 'tool';
  const input = payload.tool_input || {};
  if (toolName === 'Bash' && input.command) {
    const cmd = input.command.length > 40 ? input.command.slice(0, 40) + '…' : input.command;
    return cmd;
  }
  if (toolName === 'Read' && input.file_path) {
    return `read ${input.file_path.split('/').pop()}`;
  }
  if (toolName === 'Edit' && input.file_path) {
    return `edit ${input.file_path.split('/').pop()}`;
  }
  if (toolName === 'Write' && input.file_path) {
    return `write ${input.file_path.split('/').pop()}`;
  }
  if (toolName === 'Grep' && input.pattern) {
    return `grep ${input.pattern.length > 30 ? input.pattern.slice(0, 30) + '…' : input.pattern}`;
  }
  if (toolName === 'Task' && input.description) {
    return `task: ${input.description.length > 30 ? input.description.slice(0, 30) + '…' : input.description}`;
  }
  return toolName.toLowerCase();
}

function createEntry(time, icon, text, classes) {
  const el = document.createElement('div');
  el.className = `agent-entry ${classes}`;
  el.innerHTML = `
    <span class="agent-entry-time">${escapeHtml(time)}</span>
    <span class="agent-entry-icon">${escapeHtml(icon)}</span>
    <span class="agent-entry-text">${escapeHtml(text)}</span>
    <span class="agent-entry-dur"></span>
  `;
  return el;
}

function autoScroll(win) {
  const feed = win.feedEl;
  // Only auto-scroll if user hasn't scrolled up
  const isNearBottom = feed.scrollTop + feed.clientHeight >= feed.scrollHeight - 30;
  if (isNearBottom || win.entries.length <= 1) {
    requestAnimationFrame(() => { feed.scrollTop = feed.scrollHeight; });
  }
}

// Map a bus event to the agent node ID it belongs to (bd-kau4k, bd-t76aw, bd-jgvas).
// Returns the agent node ID (e.g. "agent:cool-trout") or null.
// Does NOT require a window to already exist — used for auto-open (bd-jgvas Phase 2).
function resolveAgentIdLoose(evt) {
  const p = evt.payload || {};

  if (evt.type === 'MailSent' || evt.type === 'MailRead') {
    const to = (p.to || '').replace(/^@/, '');
    return to ? `agent:${to}` : null;
  }

  if (evt.type && evt.type.startsWith('Decision') && p.requested_by) {
    return `agent:${p.requested_by}`;
  }

  const actor = p.actor;
  return actor && actor !== 'daemon' ? `agent:${actor}` : null;
}

function connectBusStream() {
  try {
    let _dootDrops = 0;
    api.connectBusEvents('agents,hooks,oj,mutations,mail,decisions', (evt) => {
      const label = dootLabel(evt);
      if (!label) return;

      const node = findAgentNode(evt);
      if (!node) {
        if (++_dootDrops <= 5) {
          const p = evt.payload || {};
          console.debug('[beads3d] doot drop %d: type=%s actor=%s issue=%s', _dootDrops, evt.type, p.actor, p.issue_id);
        }
        return;
      }

      spawnDoot(node, label, dootColor(evt));

      // Event sprites: status change pulse + close burst (bd-9qeto)
      const p = evt.payload || {};
      if ((evt.type === 'MutationStatus' || evt.type === 'MutationClose') && p.issue_id && graphData) {
        const issueNode = graphData.nodes.find(n => n.id === p.issue_id);
        if (issueNode) {
          const newStatus = p.new_status || (evt.type === 'MutationClose' ? 'closed' : '');
          spawnStatusPulse(issueNode, p.old_status || '', newStatus);
        }
      }

      // Edge pulse: spark along assigned_to edge from agent to task (bd-kc7r1)
      // Rate-limited to 1 spark per agent per 500ms to avoid overwhelming the scene.
      if (node && node.issue_type === 'agent' && graphData) {
        if (!connectBusStream._lastSpark) connectBusStream._lastSpark = {};
        const now = Date.now();
        const lastSpark = connectBusStream._lastSpark[node.id] || 0;
        if (now - lastSpark > 500) {
          connectBusStream._lastSpark[node.id] = now;
          const agentNodeId = node.id;
          const assignedLinks = graphData.links.filter(l =>
            l.dep_type === 'assigned_to' &&
            (typeof l.source === 'object' ? l.source.id : l.source) === agentNodeId
          );
          for (const link of assignedLinks) {
            const tgtId = typeof link.target === 'object' ? link.target.id : link.target;
            const taskNode = graphData.nodes.find(n => n.id === tgtId);
            if (taskNode && !taskNode._hidden) {
              const sparkHex = parseInt((dootColor(evt) || '#ff6b35').replace('#', ''), 16);
              spawnEdgeSpark(node, taskNode, sparkHex);
              break; // one pulse per event
            }
          }
        }
      }

      // Decision event: update graph node state, rebuild Three.js, spark edges (bd-0j7hr, bd-fbcbd)
      if (evt.type && evt.type.startsWith('Decision') && p.decision_id && graphData) {
        const decNode = graphData.nodes.find(n => n.id === p.decision_id);
        if (decNode) {
          if (evt.type === 'DecisionCreated') decNode._decisionState = 'pending';
          else if (evt.type === 'DecisionResponded') decNode._decisionState = 'resolved';
          else if (evt.type === 'DecisionExpired') decNode._decisionState = 'expired';
          // Re-apply filters: resolved/expired decisions disappear from graph (bd-zr374)
          applyFilters();
          // Rebuild node Three.js object to reflect new color/shape
          graph.nodeThreeObject(graph.nodeThreeObject());

          // Edge spark: agent ↔ decision node (bd-fbcbd)
          if (p.requested_by && !decNode._hidden) {
            const agentNode = graphData.nodes.find(n =>
              n.issue_type === 'agent' && (n.title === p.requested_by || n.id === `agent:${p.requested_by}`)
            );
            if (agentNode && !agentNode._hidden) {
              const sparkColor = evt.type === 'DecisionResponded' ? 0x2d8a4e : 0xd4a017;
              spawnEdgeSpark(agentNode, decNode, sparkColor);
            }
          }
        }
        // Toast notification for new/resolved decisions (bd-tausm)
        showDecisionToast(evt);
      }

      // Feed agent activity windows (bd-kau4k, bd-jgvas Phase 2: auto-open)
      const agentId = resolveAgentIdLoose(evt);
      if (agentId) {
        // Auto-create window if it doesn't exist yet (bd-jgvas)
        if (!agentWindows.has(agentId) && graphData) {
          const agentNode = graphData.nodes.find(n => n.id === agentId);
          if (agentNode) {
            if (agentsViewOpen) {
              // Create window inside the overlay grid
              createAgentWindowInGrid(agentNode);
            } else {
              showAgentWindow(agentNode);
            }
          }
        }
        if (agentWindows.has(agentId)) {
          appendAgentEvent(agentId, evt);
          // Scroll-to-agent and flash highlight in overlay (bd-jgvas Phase 2)
          if (agentsViewOpen) {
            const win = agentWindows.get(agentId);
            if (win && win.el) {
              win.el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
              win.el.classList.add('agent-window-flash');
              setTimeout(() => win.el.classList.remove('agent-window-flash'), 600);
            }
          }
        }
      }

      // bd-9cpbc.1: live-update right sidebar from bus events
      if (evt.type && evt.type.startsWith('Decision')) {
        updateDecisionQueue();
      }
      if (evt.type === 'MutationStatus' || evt.type === 'MutationClose' || evt.type === 'MutationUpdate') {
        updateEpicProgress();
        updateDepHealth();
        // Live-update project pulse stats
        _liveUpdateProjectPulse(evt);
      }

      // bd-nnr22: update left sidebar agent roster from all SSE events
      updateAgentRosterFromEvent(evt);
    });
  } catch { /* SSE not available — degrade gracefully */ }
}

// --- Init ---
async function main() {
  try {
    initGraph();
    // Seed with empty data so the force layout initializes before first tick
    graph.graphData({ nodes: [], links: [] });
    setupControls();
    setupBoxSelect();
    await refresh();
    connectLiveUpdates();
    connectBusStream(); // bd-c7723: live NATS event doots on agent nodes
    initLeftSidebar(); // bd-nnr22: left sidebar close button handler
    if (_pollIntervalId) clearInterval(_pollIntervalId);
    _pollIntervalId = setInterval(refresh, POLL_INTERVAL);
    graph.cameraPosition({ x: 0, y: 0, z: 400 });

    // URL deep-linking (bd-he95o): ?bead=<id> highlights and focuses a specific bead.
    // Delay to let force layout settle so camera can fly to stable positions.
    if (DEEP_LINK_BEAD) {
      setTimeout(() => focusDeepLinkBead(DEEP_LINK_BEAD), 2000);
    }
    // Molecule focus view (bd-lwut6): ?molecule=<id> focuses on a molecule's subgraph.
    if (DEEP_LINK_MOLECULE) {
      setTimeout(() => focusMolecule(DEEP_LINK_MOLECULE), 2000);
    }

// Expose for Playwright tests
    window.__THREE = THREE;
    window.__beads3d = { graph, graphData: () => graphData, multiSelected: () => multiSelected, highlightNodes: () => highlightNodes, showBulkMenu, showDetail, hideDetail, selectNode, highlightSubgraph, clearSelection, focusMolecule, focusedMoleculeNodes: () => focusedMoleculeNodes, get selectedNode() { return selectedNode; }, get cameraFrozen() { return cameraFrozen; } };
    // Expose doot internals for testing (bd-pg7vy)
    window.__beads3d_spawnDoot = spawnDoot;
    window.__beads3d_doots = () => doots;
    window.__beads3d_dootLabel = dootLabel;
    window.__beads3d_dootColor = dootColor;
    window.__beads3d_findAgentNode = findAgentNode;
    // Expose mutation handler for testing (bd-03b5v)
    window.__beads3d_applyMutation = applyMutationOptimistic;
    // Expose popup internals for testing (beads-xmix)
    window.__beads3d_showDootPopup = showDootPopup;
    window.__beads3d_dismissDootPopup = dismissDootPopup;
    window.__beads3d_dootPopups = () => dootPopups;
    // Expose agent window internals for testing (bd-kau4k)
    window.__beads3d_showAgentWindow = showAgentWindow;
    window.__beads3d_closeAgentWindow = closeAgentWindow;
    window.__beads3d_appendAgentEvent = appendAgentEvent;
    window.__beads3d_agentWindows = () => agentWindows;
    // Expose agents view overlay for testing (bd-jgvas)
    window.__beads3d_toggleAgentsView = toggleAgentsView;
    window.__beads3d_openAgentsView = openAgentsView;
    window.__beads3d_closeAgentsView = closeAgentsView;
    window.__beads3d_agentsViewOpen = () => agentsViewOpen;
    window.__beads3d_resolveAgentIdLoose = resolveAgentIdLoose;
    // Expose event sprite internals for testing (bd-9qeto)
    window.__beads3d_spawnStatusPulse = spawnStatusPulse;
    window.__beads3d_spawnEdgeSpark = spawnEdgeSpark;
    window.__beads3d_eventSprites = () => eventSprites;
    // Expose camera velocity system for testing (bd-zab4q)
    window.__beads3d_keysDown = _keysDown;
    window.__beads3d_camVelocity = _camVelocity;

    // Cleanup on page unload (bd-7n4g8): close SSE, clear intervals
    window.addEventListener('beforeunload', () => {
      api.destroy();
      if (_pollIntervalId) clearInterval(_pollIntervalId);
      if (_bloomResizeHandler) window.removeEventListener('resize', _bloomResizeHandler);
    });
  } catch (err) {
    console.error('Init failed:', err);
    document.getElementById('status').textContent = `init error: ${err.message}`;
    document.getElementById('status').className = 'error';
  }
}

main();

// bd-5ok9s: update the agent status bar with current state
function _updateAgentStatusBar(win) {
  if (!win.statusEl) return;
  const stateEl = win.statusEl.querySelector('.agent-status-state');
  const idleDurEl = win.statusEl.querySelector('.agent-status-idle-dur');
  const toolEl = win.statusEl.querySelector('.agent-status-tool');

  if (stateEl) {
    const s = win.lastStatus || '?';
    stateEl.textContent = s;
    stateEl.className = 'agent-status-state ' + (
      s === 'active' ? 'status-active' :
      s === 'idle' ? 'status-idle' :
      s === 'crashed' ? 'status-crashed' : ''
    );
  }

  if (idleDurEl) {
    if (win.lastStatus === 'idle' && win.idleSince) {
      const dur = Math.floor((Date.now() - win.idleSince) / 1000);
      idleDurEl.innerHTML = '<span class="status-label">Idle:</span> <span class="status-idle-dur">' + _formatDuration(dur) + '</span>';
    } else if (win.lastStatus === 'crashed' && win.crashError) {
      idleDurEl.innerHTML = '<span class="status-crashed">' + _escapeStatusText(win.crashError) + '</span>';
    } else {
      idleDurEl.textContent = '';
    }
  }

  if (toolEl) {
    if (win.lastTool) {
      toolEl.innerHTML = '<span class="status-label">Last:</span> <span class="status-tool">' + _escapeStatusText(win.lastTool) + '</span>';
    } else {
      toolEl.textContent = '';
    }
  }
}

function _formatDuration(seconds) {
  if (seconds < 60) return seconds + 's';
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  if (m < 60) return m + 'm' + (s > 0 ? s + 's' : '');
  const h = Math.floor(m / 60);
  return h + 'h' + (m % 60) + 'm';
}

function _escapeStatusText(str) {
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}

// bd-5ok9s: live-update idle durations every second
setInterval(() => {
  for (const [, win] of agentWindows) {
    if (win.lastStatus === 'idle' && win.idleSince) {
      _updateAgentStatusBar(win);
    }
  }
}, 1000);

// ===== Left Sidebar (bd-nnr22) =====

function toggleLeftSidebar() {
  const panel = document.getElementById('left-sidebar');
  if (!panel) return;
  leftSidebarOpen = !leftSidebarOpen;
  panel.classList.toggle('open', leftSidebarOpen);
  if (leftSidebarOpen) {
    renderAgentRoster();
    if (selectedNode) updateLeftSidebarFocus(selectedNode);
  }
}

function initLeftSidebar() {
  const closeBtn = document.getElementById('ls-close');
  if (closeBtn) closeBtn.onclick = () => { leftSidebarOpen = false; document.getElementById('left-sidebar')?.classList.remove('open'); };
}

// Update agent roster from SSE events
function updateAgentRosterFromEvent(evt) {
  const agentId = resolveAgentIdLoose(evt);
  if (!agentId) return;

  const type = evt.type || '';
  const p = evt.payload || {};
  const agentName = agentId.replace('agent:', '');

  let entry = _agentRoster.get(agentName);
  if (!entry) {
    entry = { status: 'active', task: '', tool: '', idleSince: null, crashError: null, nodeId: agentId };
    _agentRoster.set(agentName, entry);
  }

  if (type === 'AgentStarted' || type === 'SessionStart') {
    entry.status = 'active';
    entry.idleSince = null;
    entry.crashError = null;
  } else if (type === 'AgentIdle' || type === 'OjAgentIdle') {
    entry.status = 'idle';
    entry.idleSince = evt.ts ? new Date(evt.ts).getTime() : Date.now();
  } else if (type === 'AgentCrashed') {
    entry.status = 'crashed';
    entry.crashError = p.error || 'unknown';
    entry.idleSince = null;
  } else if (type === 'AgentStopped') {
    entry.status = 'stopped';
    entry.idleSince = null;
  } else if (type === 'PreToolUse') {
    entry.status = 'active';
    entry.tool = p.tool_name || p.toolName || '';
    entry.idleSince = null;
    entry.crashError = null;
  }

  // Update task from MutationUpdate with assignee claim
  if (type === 'MutationUpdate' && p.new_status === 'in_progress' && p.assignee) {
    const assigneeName = p.assignee;
    // Find roster entry matching this assignee
    for (const [name, e] of _agentRoster) {
      if (name === assigneeName || assigneeName.includes(name)) {
        e.task = p.title || p.issue_id || '';
      }
    }
  }

  if (leftSidebarOpen) renderAgentRoster();
}

function renderAgentRoster() {
  const list = document.getElementById('ls-agent-list');
  const count = document.getElementById('ls-agent-count');
  if (!list) return;

  // Also seed roster from graph data (agent nodes have task info)
  if (graphData && graphData.nodes) {
    for (const n of graphData.nodes) {
      if (n.issue_type === 'agent' && !n._hidden) {
        const name = n.title || n.id.replace('agent:', '');
        if (!_agentRoster.has(name)) {
          _agentRoster.set(name, {
            status: n._agentState || 'active',
            task: n._currentTask || '',
            tool: '',
            idleSince: null,
            crashError: null,
            nodeId: n.id,
          });
        } else {
          const e = _agentRoster.get(name);
          e.nodeId = n.id;
          if (n._currentTask) e.task = n._currentTask;
        }
      }
    }
  }

  if (_agentRoster.size === 0) {
    list.innerHTML = '<div class="ls-agent-empty">No agents connected</div>';
    if (count) count.textContent = '0';
    return;
  }

  // Sort: active first, then idle, then crashed, then stopped
  const order = { active: 0, idle: 1, crashed: 2, stopped: 3 };
  const sorted = [..._agentRoster.entries()].sort((a, b) => (order[a[1].status] || 9) - (order[b[1].status] || 9));

  if (count) count.textContent = String(sorted.length);

  list.innerHTML = sorted.map(([name, e]) => {
    const dotClass = e.status === 'active' ? 'active' : e.status === 'idle' ? 'idle' : e.status === 'crashed' ? 'crashed' : 'idle';
    const idle = e.status === 'idle' && e.idleSince ? _formatDuration(Math.floor((Date.now() - e.idleSince) / 1000)) : '';
    const toolText = e.tool ? _escapeStatusText(e.tool) : '';
    return `<div class="ls-agent-row" data-agent-id="${_escapeStatusText(e.nodeId)}" title="${_escapeStatusText(name)}${e.task ? ': ' + _escapeStatusText(e.task) : ''}">
      <span class="ls-agent-dot ${dotClass}"></span>
      <span class="ls-agent-name">${_escapeStatusText(name)}</span>
      <span class="ls-agent-task">${e.task ? _escapeStatusText(e.task.slice(0, 30)) : ''}</span>
      <span class="ls-agent-meta">${idle || toolText}</span>
    </div>`;
  }).join('');

  // Click handler: fly to agent node
  list.querySelectorAll('.ls-agent-row').forEach(row => {
    row.onclick = () => {
      const nodeId = row.dataset.agentId;
      if (!nodeId || !graphData) return;
      const node = graphData.nodes.find(n => n.id === nodeId);
      if (node && node.x !== undefined) {
        const dist = 150;
        graph.cameraPosition(
          { x: node.x + dist, y: node.y + dist * 0.3, z: node.z + dist },
          { x: node.x, y: node.y, z: node.z },
          1000
        );
      }
    };
  });
}

async function updateLeftSidebarFocus(node) {
  const content = document.getElementById('ls-focused-content');
  if (!content) return;

  if (!node) {
    content.innerHTML = '<div class="ls-placeholder">Click a node to inspect</div>';
    return;
  }

  // Show basic info immediately
  const pLabel = ['P0', 'P1', 'P2', 'P3', 'P4'][node.priority] || '';
  const statusClass = node._blocked ? 'blocked' : (node.status || 'open');
  content.innerHTML = `
    <div class="ls-issue-header">
      <span class="ls-issue-id">${escapeHtml(node.id)}</span>
      <span class="ls-issue-status ${statusClass}">${node._blocked ? 'blocked' : (node.status || 'open')}</span>
      ${pLabel ? `<span class="ls-issue-priority">${pLabel}</span>` : ''}
    </div>
    <div class="ls-issue-title">${escapeHtml(node.title || node.id)}</div>
    <div style="color:#555;font-size:9px;font-style:italic">loading...</div>
  `;

  // Agent nodes: show agent info instead
  if (node.issue_type === 'agent') {
    const name = node.title || node.id.replace('agent:', '');
    const e = _agentRoster.get(name);
    content.innerHTML = `
      <div class="ls-issue-header">
        <span class="ls-issue-id">${escapeHtml(node.id)}</span>
        <span class="ls-issue-status in_progress">agent</span>
      </div>
      <div class="ls-issue-title">${escapeHtml(name)}</div>
      <div class="ls-issue-field">
        <div class="ls-issue-field-label">Status</div>
        <div class="ls-issue-field-value">${e ? e.status : 'unknown'}</div>
      </div>
      ${e && e.task ? `<div class="ls-issue-field"><div class="ls-issue-field-label">Current Task</div><div class="ls-issue-field-value">${escapeHtml(e.task)}</div></div>` : ''}
      ${e && e.tool ? `<div class="ls-issue-field"><div class="ls-issue-field-label">Last Tool</div><div class="ls-issue-field-value">${escapeHtml(e.tool)}</div></div>` : ''}
    `;
    return;
  }

  // Fetch full details
  try {
    const full = await api.show(node.id);
    // Re-check that this node is still selected
    if (selectedNode !== node) return;

    let html = `
      <div class="ls-issue-header">
        <span class="ls-issue-id">${escapeHtml(node.id)}</span>
        <span class="ls-issue-status ${statusClass}">${node._blocked ? 'blocked' : (node.status || 'open')}</span>
        ${pLabel ? `<span class="ls-issue-priority">${pLabel}</span>` : ''}
      </div>
      <div class="ls-issue-title">${escapeHtml(full.title || node.title || node.id)}</div>
    `;

    // Type + assignee
    const metaParts = [];
    if (full.issue_type || node.issue_type) metaParts.push(full.issue_type || node.issue_type);
    if (full.assignee) metaParts.push('@ ' + full.assignee);
    if (metaParts.length) {
      html += `<div class="ls-issue-field"><div class="ls-issue-field-label">Info</div><div class="ls-issue-field-value">${escapeHtml(metaParts.join(' · '))}</div></div>`;
    }

    // Description
    if (full.description) {
      const desc = full.description.length > 300 ? full.description.slice(0, 300) + '...' : full.description;
      html += `<div class="ls-issue-field"><div class="ls-issue-field-label">Description</div><div class="ls-issue-field-value">${escapeHtml(desc)}</div></div>`;
    }

    // Dependencies (blocks / blocked_by)
    if (full.dependencies && full.dependencies.length > 0) {
      const deps = full.dependencies.map(d => {
        const depId = d.depends_on_id || d.id || '';
        return `<span class="ls-dep-link" data-dep-id="${escapeHtml(depId)}">${escapeHtml(d.title || depId)}</span>`;
      }).join('<br>');
      html += `<div class="ls-issue-field"><div class="ls-issue-field-label">Depends On</div><div class="ls-issue-field-value">${deps}</div></div>`;
    }
    if (full.blocked_by && full.blocked_by.length > 0) {
      const blockers = full.blocked_by.map(b => `<span class="ls-dep-link" data-dep-id="${escapeHtml(b)}">${escapeHtml(b)}</span>`).join('<br>');
      html += `<div class="ls-issue-field"><div class="ls-issue-field-label">Blocked By</div><div class="ls-issue-field-value">${blockers}</div></div>`;
    }

    // Labels
    if (full.labels && full.labels.length > 0) {
      html += `<div class="ls-issue-field"><div class="ls-issue-field-label">Labels</div><div class="ls-issue-field-value">${full.labels.map(l => escapeHtml(l)).join(', ')}</div></div>`;
    }

    content.innerHTML = html;

    // Bind dep link click handlers
    content.querySelectorAll('.ls-dep-link').forEach(link => {
      link.onclick = () => {
        const depId = link.dataset.depId;
        if (!depId || !graphData) return;
        const depNode = graphData.nodes.find(n => n.id === depId);
        if (depNode) {
          selectNode(depNode);
          showDetail(depNode);
          if (depNode.x !== undefined) {
            graph.cameraPosition(
              { x: depNode.x + 100, y: depNode.y + 30, z: depNode.z + 100 },
              { x: depNode.x, y: depNode.y, z: depNode.z },
              800
            );
          }
        }
      };
    });
  } catch (err) {
    content.innerHTML = `
      <div class="ls-issue-header">
        <span class="ls-issue-id">${escapeHtml(node.id)}</span>
      </div>
      <div class="ls-issue-title">${escapeHtml(node.title || node.id)}</div>
      <div class="ls-issue-field-value">Could not load details</div>
    `;
  }
}

// Update agent roster idle durations (runs alongside bd-5ok9s status bar updates)
setInterval(() => {
  if (leftSidebarOpen) {
    // Update idle durations in-place
    const list = document.getElementById('ls-agent-list');
    if (!list) return;
    list.querySelectorAll('.ls-agent-row').forEach(row => {
      const agentId = row.dataset.agentId;
      if (!agentId) return;
      const name = agentId.replace('agent:', '');
      const e = _agentRoster.get(name);
      if (e && e.status === 'idle' && e.idleSince) {
        const meta = row.querySelector('.ls-agent-meta');
        if (meta) meta.textContent = _formatDuration(Math.floor((Date.now() - e.idleSince) / 1000));
      }
    });
  }
}, 1000);
