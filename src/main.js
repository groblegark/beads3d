import ForceGraph3D from '3d-force-graph';
import * as THREE from 'three';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { BeadsAPI } from './api.js';
import { nodeColor, nodeSize, linkColor, colorToHex } from './colors.js';
import { createFresnelMaterial, createPulseRingMaterial, createSelectionRingMaterial, createStarField, updateShaderTime } from './shaders.js';

// --- Config ---
const params = new URLSearchParams(window.location.search);
const API_BASE = params.get('api') || '/api';
const DEEP_LINK_BEAD = params.get('bead') || ''; // bd-he95o: URL deep-linking
const POLL_INTERVAL = 10000;
const MAX_NODES = 1000; // bd-04wet: raised from 500 to show more relevant beads

const api = new BeadsAPI(API_BASE);

// --- Shared geometries (reused across all nodes to reduce GC + draw overhead) ---
const GEO = {
  sphereHi:   new THREE.SphereGeometry(1, 12, 12),   // unit sphere, scaled per-node
  sphereLo:   new THREE.SphereGeometry(1, 6, 6),      // low-poly glow shell
  torus:      new THREE.TorusGeometry(1, 0.15, 6, 20), // unit torus for rings
  icosa:      new THREE.IcosahedronGeometry(1, 1),     // epic shell
  octa:       new THREE.OctahedronGeometry(1, 0),      // blocked spikes
  box:        new THREE.BoxGeometry(1, 1, 1),           // agent node (monitor/computer)
};

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

const LINK_ICON_MATERIALS = {
  'blocks':       makeLinkIconTexture(drawShield, '#d04040'),
  'waits-for':    makeLinkIconTexture(drawClock,  '#d4a017'),
  'parent-child': makeLinkIconTexture(drawChain,  '#8b45a666'),
  'relates-to':   makeLinkIconTexture(drawDot,    '#4a9eff'),
  'assigned_to':  makeLinkIconTexture(drawPerson, '#ff6b35'),
};
const LINK_ICON_DEFAULT = makeLinkIconTexture(drawDot, '#2a2a3a');

const LINK_ICON_SCALE = 8; // sprite size in world units

// --- State ---
let graphData = { nodes: [], links: [] };
let graph;
let searchFilter = '';
let statusFilter = new Set(); // empty = show all
let typeFilter = new Set();
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
let isBoxSelecting = false;
let boxSelectStart = null; // {x, y} screen coords
let cameraFrozen = false; // true when multi-select has locked orbit controls (bd-casin)
let labelsVisible = false; // true when persistent info labels are shown on all nodes (bd-1o2f7)
const openPanels = new Map(); // beadId → panel element (bd-fbmq3: tiling detail panels)
let activeAgeDays = 7; // age filter: show beads updated within N days (0 = all) (bd-uc0mw)

// Resource cleanup refs (bd-7n4g8)
let _bloomResizeHandler = null;
let _pollIntervalId = null;
let _searchDebounceTimer = null;

// Timeline scrubber state (bd-huwyz): logarithmic time-range selection
let timelineMinMs = 0;   // oldest bead timestamp (ms)
let timelineMaxMs = 0;   // newest bead timestamp (ms)
let timelineSelStart = 0; // selected range start (0..1 in log space)
let timelineSelEnd = 1;   // selected range end (0..1 in log space)
let timelineActive = false; // true when user has narrowed the range

// Live event doots — floating text particles above agent nodes (bd-c7723)
const doots = []; // { sprite, node, birth, lifetime, vx, vy, vz }

// Doot-triggered issue popups — auto-dismissing cards when doots fire (beads-edy1)
const dootPopups = new Map(); // nodeId → { el, timer, node, lastDoot }

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
  sprite.visible = labelsVisible;
  return sprite;
}

function toggleLabels() {
  labelsVisible = !labelsVisible;
  // Toggle visibility on all existing label sprites by traversing the scene
  if (graph) {
    graph.scene().traverse(child => {
      if (child.userData && child.userData.nodeLabel) {
        child.visible = labelsVisible;
      }
    });
  }
  const btn = document.getElementById('btn-labels');
  if (btn) btn.classList.toggle('active', labelsVisible);
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

      // Inner sphere (solid core) — shared geometry, scaled
      const core = new THREE.Mesh(GEO.sphereHi, new THREE.MeshBasicMaterial({
        color: hexColor, transparent: true, opacity: 0.85 * ghostFade,
      }));
      core.scale.setScalar(size);
      group.add(core);

      // Outer glow shell — Fresnel rim-lighting shader (bright at edges, clear at center)
      const glow = new THREE.Mesh(GEO.sphereLo, createFresnelMaterial(hexColor, { opacity: 0.4 * ghostFade, power: 3.0 }));
      glow.scale.setScalar(size * 1.5);
      group.add(glow);

      // In-progress: pulsing ring — animated shader with soft edges
      if (n.status === 'in_progress') {
        const ring = new THREE.Mesh(GEO.torus, createPulseRingMaterial(0xd4a017));
        ring.scale.setScalar(size * 2.0);
        ring.rotation.x = Math.PI / 2;
        ring.userData.pulse = true;
        group.add(ring);
      }

      // Agent: monitor/computer-dude — box core with glowing screen face
      if (n.issue_type === 'agent') {
        // Replace sphere core with box
        group.remove(core);
        group.remove(glow);

        // Monitor body — solid dark box
        const body = new THREE.Mesh(GEO.box, new THREE.MeshBasicMaterial({
          color: 0x2a2a3a, transparent: true, opacity: 0.9,
        }));
        body.scale.set(size * 1.6, size * 1.2, size * 0.6);
        group.add(body);

        // Screen face — bright orange glow on front
        const screen = new THREE.Mesh(
          new THREE.PlaneGeometry(1, 1),
          new THREE.MeshBasicMaterial({
            color: 0xff6b35, transparent: true, opacity: 0.7, side: THREE.DoubleSide,
          }),
        );
        screen.scale.set(size * 1.3, size * 0.9, 1);
        screen.position.z = size * 0.31;
        group.add(screen);

        // Scan lines overlay — horizontal stripes for retro-tech look
        const scanCanvas = document.createElement('canvas');
        scanCanvas.width = 64;
        scanCanvas.height = 64;
        const sCtx = scanCanvas.getContext('2d');
        for (let y = 0; y < 64; y += 4) {
          sCtx.fillStyle = 'rgba(0,0,0,0.3)';
          sCtx.fillRect(0, y, 64, 2);
        }
        const scanTex = new THREE.CanvasTexture(scanCanvas);
        scanTex.minFilter = THREE.LinearFilter;
        const scanLines = new THREE.Mesh(
          new THREE.PlaneGeometry(1, 1),
          new THREE.MeshBasicMaterial({ map: scanTex, transparent: true, opacity: 0.5, side: THREE.DoubleSide }),
        );
        scanLines.scale.set(size * 1.3, size * 0.9, 1);
        scanLines.position.z = size * 0.32;
        group.add(scanLines);

        // Outer glow — orange fresnel shell, pulses with activity (beads-v0wa)
        const agentGlow = new THREE.Mesh(GEO.sphereLo, createFresnelMaterial(0xff6b35, { opacity: 0.25, power: 2.5 }));
        agentGlow.scale.setScalar(size * 1.8);
        agentGlow.userData.agentGlow = true;
        agentGlow.userData.baseScale = size * 1.8;
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
      }

      // Epic: wireframe organelle membrane
      if (n.issue_type === 'epic') {
        const shell = new THREE.Mesh(GEO.icosa, new THREE.MeshBasicMaterial({
          color: 0x8b45a6, transparent: true, opacity: 0.15, wireframe: true,
        }));
        shell.scale.setScalar(size * 2);
        group.add(shell);
      }

      // Blocked: spiky octahedron
      if (n._blocked) {
        const spike = new THREE.Mesh(GEO.octa, new THREE.MeshBasicMaterial({
          color: 0xd04040, transparent: true, opacity: 0.2, wireframe: true,
        }));
        spike.scale.setScalar(size * 2.4);
        group.add(spike);
      }

      // Selection ring (invisible until selected)
      // Selection ring — animated shader with sweep effect (invisible until selected)
      const selRingMat = createSelectionRingMaterial();
      const selRing = new THREE.Mesh(GEO.torus, selRingMat);
      selRing.scale.setScalar(size * 2.5);
      selRing.userData.selectionRing = true;
      group.add(selRing);

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
        return highlightLinks.has(lk) ? (l.dep_type === 'blocks' ? 2.0 : 1.2) : 0.2;
      }
      return l.dep_type === 'blocks' ? 1.2 : l.dep_type === 'assigned_to' ? 1.5 : 0.5;
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
      const subtree = node._dragSubtree;
      for (const { node: child, depth } of subtree) {
        if (child === node || child.fx !== undefined) continue;
        const strength = 0.3 * Math.pow(0.5, depth - 1);
        const dx = node.x - child.x;
        const dy = node.y - child.y;
        const dz = (node.z || 0) - (child.z || 0);
        const dist = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
        const restDist = 30 * depth;
        if (dist > restDist) {
          child.vx = (child.vx || 0) + dx * strength * 0.05;
          child.vy = (child.vy || 0) + dy * strength * 0.05;
          child.vz = (child.vz || 0) + dz * strength * 0.05;
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

  // Extend camera draw distance
  const camera = graph.camera();
  camera.far = 50000;
  camera.updateProjectionMatrix();

  // Bloom post-processing
  bloomPass = new UnrealBloomPass(
    new THREE.Vector2(window.innerWidth, window.innerHeight),
    1.2,   // strength — visible glow
    0.6,   // radius — wider spread
    0.2    // threshold — lower so node colors bloom
  );
  bloomPass.enabled = bloomEnabled;
  const composer = graph.postProcessingComposer();
  composer.addPass(bloomPass);

  // Handle window resize for bloom (bd-7n4g8: store ref for cleanup)
  if (_bloomResizeHandler) window.removeEventListener('resize', _bloomResizeHandler);
  _bloomResizeHandler = () => bloomPass.resolution.set(window.innerWidth, window.innerHeight);
  window.addEventListener('resize', _bloomResizeHandler);

  // Start animation loop for pulsing effects
  startAnimation();

  return graph;
}

// --- Selection logic ---

// Unique key for a link (handles both object and string source/target)
function linkKey(l) {
  const s = typeof l.source === 'object' ? l.source.id : l.source;
  const t = typeof l.target === 'object' ? l.target.id : l.target;
  return `${s}->${t}`;
}

// Select a node: highlight it and all directly connected nodes/links
function selectNode(node) {
  selectedNode = node;
  highlightNodes.clear();
  highlightLinks.clear();

  if (!node) return;

  highlightNodes.add(node.id);

  // Walk all links to find connected nodes
  for (const l of graphData.links) {
    const srcId = typeof l.source === 'object' ? l.source.id : l.source;
    const tgtId = typeof l.target === 'object' ? l.target.id : l.target;
    if (srcId === node.id || tgtId === node.id) {
      highlightNodes.add(srcId);
      highlightNodes.add(tgtId);
      highlightLinks.add(linkKey(l));
    }
  }

  // Force link width recalculation
  graph.linkWidth(graph.linkWidth());
}

function clearSelection() {
  selectedNode = null;
  highlightNodes.clear();
  highlightLinks.clear();
  multiSelected.clear();
  // Clear revealed subgraph and re-apply filters (hq-vorf47)
  if (revealedNodes.size > 0) {
    revealedNodes.clear();
    graphData.nodes.forEach(n => { n._revealed = false; });
    applyFilters();
  }
  hideBulkMenu();
  unfreezeCamera(); // bd-casin: restore orbit controls
  restoreAllNodeOpacity();
  updateBeadURL(null); // bd-he95o: clear URL deep-link on deselect
  // Force link width recalculation
  graph.linkWidth(graph.linkWidth());
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

  // Select and highlight the node + its neighbors
  selectNode(node);

  // Fly camera to the node
  const x = node.x || 0, y = node.y || 0, z = node.z || 0;
  const distance = 120; // close-up view
  graph.cameraPosition(
    { x: x, y: y, z: z + distance },
    { x, y, z },
    1500, // 1.5s fly animation
  );

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
  const distance = Math.max(maxDist * 2.5, 60);
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

    // Hide selection-shown labels (bd-xk0tx): revert to global toggle state
    threeObj.traverse(child => {
      if (child.userData.nodeLabel) {
        child.visible = labelsVisible;
      }
    });

    if (!node._wasDimmed) continue;
    threeObj.traverse(child => {
      if (!child.material || child.userData.selectionRing || child.userData.pulse || child.userData.nodeLabel) return;
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

      // Show labels on highlighted beads when there's an active selection (bd-xk0tx)
      const showLabel = hasSelection ? isHighlighted : labelsVisible;

      // Skip traversal when nothing to update (agents always animate — beads-v0wa)
      if (!hasSelection && !isMultiSelected && node.status !== 'in_progress' && node.issue_type !== 'agent' && !labelsVisible) continue;

      // Track dimmed nodes for restoration in clearSelection()
      if (hasSelection && !isHighlighted) node._wasDimmed = true;

      threeObj.traverse(child => {
        if (!child.material) return;

        // Label sprites: show on highlighted nodes or when global toggle is on (bd-xk0tx)
        if (child.userData.nodeLabel) {
          child.visible = showLabel;
          return;
        }

        if (child.userData.selectionRing) {
          if (child.material.uniforms && child.material.uniforms.visible) {
            child.material.uniforms.visible.value = isSelected ? 1.0 : 0.0;
          } else {
            child.material.opacity = isSelected ? 0.6 + Math.sin(t * 4) * 0.2 : 0;
          }
          if (isSelected) {
            child.rotation.x = t * 1.2;
            child.rotation.y = t * 0.8;
          }
        } else if (child.userData.agentGlow) {
          // Agent glow: breathing pulse (beads-v0wa)
          const base = child.userData.baseScale || 1;
          const pulse = 1.0 + Math.sin(t * 2) * 0.15;
          child.scale.setScalar(base * pulse);
          if (child.material.uniforms && child.material.uniforms.opacity) {
            child.material.uniforms.opacity.value = (0.2 + Math.sin(t * 2.5) * 0.1) * dimFactor;
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
            child.material.opacity = (0.3 + Math.sin(t * 3) * 0.2) * dimFactor;
          }
        } else if (hasSelection) {
          saveBaseOpacity(child.material);
          setMaterialDim(child.material, dimFactor);
        }
      });
    }

    // Update live event doots (bd-c7723)
    updateDoots(t);

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
    status: ['open', 'in_progress', 'closed'],
    max_age_days: activeAgeDays || 0,
    include_deps: true,
    include_body: true,
    include_agents: true,
    exclude_types: ['message', 'config', 'gate', 'wisp', 'convoy', 'molecule', 'formula', 'advice', 'role'], // bd-04wet, bd-t25i1, bd-uqkpq: filter noise types
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
  const SKIP_TYPES = new Set(['message', 'config', 'gate', 'wisp', 'convoy', 'decision', 'molecule', 'formula', 'advice', 'role']);

  // Parallel fetch: open/in_progress beads + blocked + stats
  const [openIssues, inProgress, blocked, stats] = await Promise.all([
    api.list({
      limit: MAX_NODES * 2, // over-fetch to compensate for client-side filtering
      status: 'open',
      exclude_status: ['tombstone', 'closed'],
    }),
    api.list({
      limit: 100,
      status: 'in_progress',
    }),
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
  }
  parts.push(`<span>${issues.length}</span> shown`);
  el.innerHTML = parts.join(' &middot; ');
}

// --- Tooltip ---
const tooltip = document.getElementById('tooltip');

function handleNodeHover(node) {
  document.body.style.cursor = node ? 'pointer' : 'default';
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

  selectNode(node);

  // Reveal entire connected subgraph regardless of filters (hq-vorf47).
  // BFS across ALL links (including hidden nodes) to find the full component,
  // then force those nodes visible via applyFilters override.
  revealedNodes.clear();
  const component = getConnectedComponent(node.id);
  for (const id of component) {
    revealedNodes.add(id);
  }
  applyFilters(); // re-run filters to un-hide revealed nodes

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
    const distance = 80;
    const distRatio = 1 + distance / Math.hypot(cx, cy, cz);
    graph.cameraPosition(
      { x: cx * distRatio, y: cy * distRatio, z: cz * distRatio },
      { x: cx, y: cy, z: cz }, 1000
    );
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

  const distance = Math.max(maxDist * 2.5, 80);
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
      ${node._blocked ? '<span class="tag tag-blocked">BLOCKED</span>' : ''}
    </div>
    <div class="detail-body loading">loading full details...</div>
  `;

  // Close button handler
  panel.querySelector('.detail-close').onclick = () => closeDetailPanel(node.id);

  // Animate open
  requestAnimationFrame(() => panel.classList.add('open'));

  // Lazy-load full details via Show (skip for synthetic agent nodes — beads-zq8a)
  if (node.issue_type === 'agent' && node.id.startsWith('agent:')) {
    const body = panel.querySelector('.detail-body');
    if (body) {
      body.classList.remove('loading');
      const assigned = graphData.links
        .filter(l => l.dep_type === 'assigned_to' &&
          (typeof l.source === 'object' ? l.source.id : l.source) === node.id)
        .map(l => {
          const tgtId = typeof l.target === 'object' ? l.target.id : l.target;
          const tgtNode = graphData.nodes.find(n => n.id === tgtId);
          return tgtNode ? `<div class="dep-link">${escapeHtml(tgtId)}: ${escapeHtml(tgtNode.title || tgtId)}</div>` : '';
        })
        .filter(Boolean)
        .join('');
      body.innerHTML = assigned ? `<div class="section-label">Working on:</div>${assigned}` : '<em>No active assignments</em>';
    }
  } else {
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

    // Update the graph with new data
    graph.graphData(graphData);

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

    // Status filter — agent nodes are exempt (bd-keeha)
    if (statusFilter.size > 0 && n.issue_type !== 'agent' && !statusFilter.has(n.status)) {
      hidden = true;
    }

    // Type filter — agent nodes are always visible (bd-keeha)
    if (typeFilter.size > 0 && n.issue_type !== 'agent' && !typeFilter.has(n.issue_type)) {
      hidden = true;
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

    // Timeline scrubber filter (bd-huwyz): hide nodes outside the selected time range.
    // Uses created_at mapped through the logarithmic scale. Agent nodes are exempt.
    if (!hidden && timelineActive && n.issue_type !== 'agent') {
      const t = new Date(n.created_at || n.updated_at || 0).getTime();
      if (t > 0 && timelineMinMs > 0) {
        const pos = timeToLogPos(t, timelineMinMs, timelineMaxMs);
        if (pos < timelineSelStart || pos > timelineSelEnd) {
          hidden = true;
          n._ageFiltered = true;
        }
      }
    }

    n._hidden = hidden;
    n._searchMatch = !hidden && !!q;
  });

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
  updateTimeline();
}

// --- Timeline Scrubber (bd-huwyz) ---
// Logarithmic time-range selector. Recent time is expanded (easy to distinguish
// today vs yesterday), while older time is compressed (months ago squish together).
// Log transform: pos = log(1 + t/scale) / log(1 + range/scale)

const TIMELINE_LOG_SCALE = 3600000; // 1 hour in ms — aggressive log curvature for fine-grained recent time

function timeToLogPos(timeMs, minMs, maxMs) {
  const range = maxMs - minMs || 1;
  const t = timeMs - minMs;
  return Math.log1p(t / TIMELINE_LOG_SCALE) / Math.log1p(range / TIMELINE_LOG_SCALE);
}

function logPosToTime(pos, minMs, maxMs) {
  const range = maxMs - minMs || 1;
  const logMax = Math.log1p(range / TIMELINE_LOG_SCALE);
  return minMs + (Math.expm1(pos * logMax) * TIMELINE_LOG_SCALE);
}

function formatTimelineDate(ms) {
  const d = new Date(ms);
  const now = new Date();
  const diffMs = now - d;
  const diffHours = diffMs / 3600000;
  const diffDays = diffMs / 86400000;
  if (diffHours < 1) return `${Math.floor(diffMs / 60000)}m ago`;
  if (diffHours < 24) return `${Math.floor(diffHours)}h ago`;
  if (diffDays < 2) return 'yesterday';
  if (diffDays < 7) return `${Math.floor(diffDays)}d ago`;
  if (diffDays < 30) return `${Math.floor(diffDays / 7)}w ago`;
  if (diffDays < 365) {
    const months = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];
    return `${months[d.getMonth()]} ${d.getDate()}`;
  }
  return `${d.getFullYear()}`;
}

function updateTimeline() {
  const canvas = document.getElementById('timeline-canvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const rangeEl = document.getElementById('timeline-range');
  const handleL = document.getElementById('handle-left');
  const handleR = document.getElementById('handle-right');
  const lblOldest = document.getElementById('tl-oldest');
  const lblNewest = document.getElementById('tl-newest');
  const lblRange = document.getElementById('tl-range');

  const times = graphData.nodes
    .filter(n => n.issue_type !== 'agent')
    .map(n => new Date(n.created_at || n.updated_at || 0).getTime())
    .filter(t => t > 0);

  if (times.length === 0) {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    lblOldest.textContent = '';
    lblNewest.textContent = '';
    lblRange.textContent = 'no data';
    rangeEl.style.display = 'none';
    handleL.style.display = 'none';
    handleR.style.display = 'none';
    return;
  }

  timelineMinMs = Math.min(...times);
  timelineMaxMs = Math.max(...times);

  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  canvas.width = rect.width * dpr;
  canvas.height = rect.height * dpr;
  ctx.scale(dpr, dpr);
  const W = rect.width;
  const H = rect.height;

  // Build histogram in log space
  const BUCKETS = 40;
  const buckets = new Array(BUCKETS).fill(0);
  const statusBuckets = new Array(BUCKETS).fill(null).map(() => ({ open: 0, active: 0, closed: 0 }));
  for (const node of graphData.nodes) {
    if (node.issue_type === 'agent') continue;
    const t = new Date(node.created_at || node.updated_at || 0).getTime();
    if (t <= 0) continue;
    const pos = timeToLogPos(t, timelineMinMs, timelineMaxMs);
    const idx = Math.min(Math.floor(pos * BUCKETS), BUCKETS - 1);
    buckets[idx]++;
    if (node.status === 'in_progress') statusBuckets[idx].active++;
    else if (node.status === 'closed') statusBuckets[idx].closed++;
    else statusBuckets[idx].open++;
  }
  const maxBucket = Math.max(...buckets, 1);

  ctx.clearRect(0, 0, W, H);
  const barW = W / BUCKETS;
  for (let i = 0; i < BUCKETS; i++) {
    if (buckets[i] === 0) continue;
    const barH = (buckets[i] / maxBucket) * (H - 4);
    const x = i * barW;
    const y = H - 2 - barH;
    const inRange = (i / BUCKETS) >= timelineSelStart && ((i + 1) / BUCKETS) <= timelineSelEnd;
    const total = statusBuckets[i].open + statusBuckets[i].active + statusBuckets[i].closed;
    if (total > 0) {
      let cy = y;
      if (statusBuckets[i].active > 0) {
        const h = (statusBuckets[i].active / total) * barH;
        ctx.fillStyle = inRange ? 'rgba(212, 160, 23, 0.8)' : 'rgba(212, 160, 23, 0.3)';
        ctx.fillRect(x + 1, cy, barW - 2, h);
        cy += h;
      }
      if (statusBuckets[i].open > 0) {
        const h = (statusBuckets[i].open / total) * barH;
        ctx.fillStyle = inRange ? 'rgba(45, 138, 78, 0.8)' : 'rgba(45, 138, 78, 0.3)';
        ctx.fillRect(x + 1, cy, barW - 2, h);
        cy += h;
      }
      if (statusBuckets[i].closed > 0) {
        const h = (statusBuckets[i].closed / total) * barH;
        ctx.fillStyle = inRange ? 'rgba(100, 100, 120, 0.6)' : 'rgba(100, 100, 120, 0.2)';
        ctx.fillRect(x + 1, cy, barW - 2, h);
      }
    }
  }

  // Position range highlight and handles
  const selLeftPx = timelineSelStart * W;
  const selRightPx = timelineSelEnd * W;
  rangeEl.style.display = 'block';
  rangeEl.style.left = selLeftPx + 'px';
  rangeEl.style.width = (selRightPx - selLeftPx) + 'px';
  handleL.style.display = 'block';
  handleL.style.left = (selLeftPx - 4) + 'px';
  handleR.style.display = 'block';
  handleR.style.left = (selRightPx - 4) + 'px';

  lblOldest.textContent = formatTimelineDate(timelineMinMs);
  lblNewest.textContent = formatTimelineDate(timelineMaxMs);
  if (timelineSelStart > 0.001 || timelineSelEnd < 0.999) {
    const startDate = logPosToTime(timelineSelStart, timelineMinMs, timelineMaxMs);
    const endDate = logPosToTime(timelineSelEnd, timelineMinMs, timelineMaxMs);
    lblRange.textContent = `${formatTimelineDate(startDate)} \u2013 ${formatTimelineDate(endDate)}`;
    timelineActive = true;
  } else {
    lblRange.textContent = 'all time';
    timelineActive = false;
  }
}

function initTimelineScrubber() {
  const canvas = document.getElementById('timeline-canvas');
  if (!canvas) return;
  let dragging = null; // 'left', 'right', or 'range'
  let dragStartX = 0;
  let dragStartSelStart = 0;
  let dragStartSelEnd = 0;

  function posFromEvent(e) {
    const rect = canvas.getBoundingClientRect();
    return Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
  }

  document.getElementById('handle-left').addEventListener('mousedown', (e) => {
    e.preventDefault();
    e.stopPropagation();
    dragging = 'left';
    dragStartX = posFromEvent(e);
  });

  document.getElementById('handle-right').addEventListener('mousedown', (e) => {
    e.preventDefault();
    e.stopPropagation();
    dragging = 'right';
    dragStartX = posFromEvent(e);
  });

  canvas.addEventListener('mousedown', (e) => {
    const pos = posFromEvent(e);
    if (pos >= timelineSelStart + 0.005 && pos <= timelineSelEnd - 0.005) {
      dragging = 'range';
      dragStartX = pos;
      dragStartSelStart = timelineSelStart;
      dragStartSelEnd = timelineSelEnd;
    } else {
      const distToLeft = Math.abs(pos - timelineSelStart);
      const distToRight = Math.abs(pos - timelineSelEnd);
      if (distToLeft < distToRight) {
        timelineSelStart = pos;
        dragging = 'left';
      } else {
        timelineSelEnd = pos;
        dragging = 'right';
      }
      updateTimeline();
      applyFilters();
    }
  });

  document.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const pos = posFromEvent(e);
    if (dragging === 'left') {
      timelineSelStart = Math.min(pos, timelineSelEnd - 0.005);
    } else if (dragging === 'right') {
      timelineSelEnd = Math.max(pos, timelineSelStart + 0.005);
    } else if (dragging === 'range') {
      const delta = pos - dragStartX;
      const width = dragStartSelEnd - dragStartSelStart;
      let newStart = dragStartSelStart + delta;
      let newEnd = dragStartSelEnd + delta;
      if (newStart < 0) { newStart = 0; newEnd = width; }
      if (newEnd > 1) { newEnd = 1; newStart = 1 - width; }
      timelineSelStart = newStart;
      timelineSelEnd = newEnd;
    }
    updateTimeline();
  });

  document.addEventListener('mouseup', () => {
    if (dragging) {
      dragging = null;
      applyFilters();
    }
  });

  canvas.addEventListener('dblclick', () => {
    timelineSelStart = 0;
    timelineSelEnd = 1;
    updateTimeline();
    applyFilters();
  });

  // Scroll wheel zoom: zoom in/out around cursor position (bd-or8t1)
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const pos = posFromEvent(e);
    const width = timelineSelEnd - timelineSelStart;
    const zoomFactor = e.deltaY > 0 ? 1.15 : 0.85; // scroll down = zoom out
    const newWidth = Math.max(0.005, Math.min(1, width * zoomFactor));

    // Anchor zoom around cursor position within selection
    const anchor = (pos - timelineSelStart) / (width || 1);
    let newStart = pos - anchor * newWidth;
    let newEnd = newStart + newWidth;

    // Clamp to [0, 1]
    if (newStart < 0) { newEnd -= newStart; newStart = 0; }
    if (newEnd > 1) { newStart -= (newEnd - 1); newEnd = 1; }
    newStart = Math.max(0, newStart);
    newEnd = Math.min(1, newEnd);

    timelineSelStart = newStart;
    timelineSelEnd = newEnd;
    updateTimeline();
    applyFilters();
  }, { passive: false });
}

// Navigate search results: fly camera to the current match
function flyToSearchResult() {
  if (searchResults.length === 0 || searchResultIdx < 0) return;
  const node = searchResults[searchResultIdx];
  if (!node) return;

  selectNode(node);

  const distance = 80;
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
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  ctx.font = `${fontSize}px SF Mono, Fira Code, monospace`;
  const metrics = ctx.measureText(text);
  canvas.width = Math.ceil(metrics.width) + 16;
  canvas.height = fontSize + 12;
  ctx.font = `${fontSize}px SF Mono, Fira Code, monospace`;
  ctx.fillStyle = color;
  ctx.textBaseline = 'top';
  ctx.fillText(text, 8, 6);
  const tex = new THREE.CanvasTexture(canvas);
  tex.minFilter = THREE.LinearFilter;
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, opacity: opts.opacity || 0.6 });
  const sprite = new THREE.Sprite(mat);
  sprite.scale.set(canvas.width / 4, canvas.height / 4, 1);
  return sprite;
}

function addRadialGuides() {
  const scene = graph.scene();
  const radiusScale = 60;
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

    case 'dag':
      graph.dagMode('td');
      graph.d3Force('charge').strength(-40).distanceMax(300);
      graph.d3Force('link').distance(30);
      break;

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
      // Radial: distance from center = priority (P0 center, P4 outer)
      graph.d3Force('charge').strength(-20).distanceMax(200);
      graph.d3Force('link').distance(15);

      const radiusScale = 60; // pixels per priority level
      graph.d3Force('radialPriority', (alpha) => {
        for (const node of graphData.nodes) {
          if (node._hidden) continue;
          const targetR = (node.priority + 0.5) * radiusScale;
          const x = node.x || 0;
          const z = node.z || 0;
          const currentR = Math.sqrt(x * x + z * z) || 1;
          const factor = (targetR / currentR - 1) * alpha * 0.08;
          node.vx += x * factor;
          node.vz += z * factor;
        }
      });
      // Flatten Y for a disc layout
      graph.d3Force('flattenY', (alpha) => {
        for (const node of graphData.nodes) {
          if (node._hidden) continue;
          node.vy += (0 - (node.y || 0)) * alpha * 0.2;
        }
      });
      addRadialGuides();
      // Top-down camera for disc view
      graph.cameraPosition({ x: 0, y: 500, z: 50 }, { x: 0, y: 0, z: 0 }, 1200);
      break;
    }

    case 'cluster': {
      // Cluster by assignee: each assignee gets an anchor point
      graph.d3Force('charge').strength(-25).distanceMax(200);
      graph.d3Force('link').distance(20);

      // Build assignee → anchor position map
      const assignees = [...new Set(graphData.nodes.map(n => n.assignee || '(unassigned)'))];
      const anchorMap = {};
      const clusterRadius = Math.max(assignees.length * 40, 150);
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
          node.vx += (anchor.x - (node.x || 0)) * alpha * 0.06;
          node.vz += (anchor.z - (node.z || 0)) * alpha * 0.06;
        }
      });
      // Flatten Y for a disc layout
      graph.d3Force('flattenY', (alpha) => {
        for (const node of graphData.nodes) {
          if (node._hidden) continue;
          node.vy += (0 - (node.y || 0)) * alpha * 0.15;
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
  document.querySelectorAll('.filter-status').forEach(btn => {
    btn.addEventListener('click', () => {
      const status = btn.dataset.status;
      btn.classList.toggle('active');
      if (statusFilter.has(status)) {
        statusFilter.delete(status);
      } else {
        statusFilter.add(status);
      }
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
      applyFilters();
    });
  });

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
      // Reset timeline scrubber to full range when age filter changes (bd-huwyz)
      timelineSelStart = 0;
      timelineSelEnd = 1;
      refresh(); // re-fetch with new age cutoff (bd-uc0mw)
    });
  });

  // Timeline scrubber (bd-huwyz)
  initTimelineScrubber();

  // Keyboard shortcuts
  document.addEventListener('keydown', (e) => {
    // '/' to focus search
    if (e.key === '/' && document.activeElement !== searchInput) {
      e.preventDefault();
      searchInput.focus();
    }
    // Escape to clear search, close detail, close context/bulk menu, and deselect
    if (e.key === 'Escape') {
      // Always unfreeze camera on Escape (bd-casin)
      unfreezeCamera();

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
      hideDetail();
      hideTooltip();
    }
    // 'r' to refresh
    if (e.key === 'r' && document.activeElement !== searchInput) {
      refresh();
    }
    // 'b' to toggle bloom
    if (e.key === 'b' && document.activeElement !== searchInput) {
      btnBloom.click();
    }
    // 'm' to toggle minimap
    if (e.key === 'm' && document.activeElement !== searchInput) {
      toggleMinimap();
    }
    // 'l' for labels toggle (bd-1o2f7)
    if (e.key === 'l' && document.activeElement !== searchInput) {
      toggleLabels();
    }
    // 'p' for screenshot
    if (e.key === 'p' && document.activeElement !== searchInput) {
      captureScreenshot();
    }
    // 'x' for export
    if (e.key === 'x' && document.activeElement !== searchInput) {
      exportGraphJSON();
    }
    // 1-5 for layout modes
    const layoutKeys = { '1': 'free', '2': 'dag', '3': 'timeline', '4': 'radial', '5': 'cluster' };
    if (layoutKeys[e.key] && document.activeElement !== searchInput) {
      setLayout(layoutKeys[e.key]);
    }
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
  const refreshLinkKey = l => `${typeof l.source === 'object' ? l.source.id : l.source}→${typeof l.target === 'object' ? l.target.id : l.target}:${l.dep_type}`;
  const existingLinkKeys = new Set(currentLinks.map(refreshLinkKey));
  const newLinkKeys = new Set(data.links.map(refreshLinkKey));

  let linksChanged = false;
  if (data.links.length !== currentLinks.length ||
      data.links.some(l => !existingLinkKeys.has(refreshLinkKey(l))) ||
      currentLinks.some(l => !newLinkKeys.has(refreshLinkKey(l)))) {
    linksChanged = true;
  }

  const structureChanged = nodesAdded > 0 || nodesRemoved > 0 || linksChanged;

  graphData = { nodes: mergedNodes, links: data.links };
  applyFilters();

  if (structureChanged) {
    // graph.graphData() reheats d3-force to alpha=1, scattering all positioned nodes.
    // Fix (bd-vacsl): temporarily crank d3VelocityDecay so existing nodes barely move
    // during the initial high-alpha ticks, then restore for gentle settling.
    const prevVelocityDecay = graph.d3VelocityDecay();
    graph.d3VelocityDecay(0.9); // heavy friction: velocity *= 0.1 each tick

    graph.graphData(graphData);

    // After 200ms (~12 frames at 60fps), alpha decays from 1→~0.76.
    // Restore normal friction so new nodes can drift to their equilibrium.
    setTimeout(() => graph.d3VelocityDecay(prevVelocityDecay), 200);
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
      // delay if we already applied the change visually.
      clearTimeout(_refreshTimer);
      _refreshTimer = setTimeout(refresh, applied ? 5000 : 1500);
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

// --- Live event doots (bd-c7723) ---

const DOOT_LIFETIME = 4.0; // seconds before fully faded
const DOOT_RISE_SPEED = 8; // units per second upward
const DOOT_MAX = 30; // max active doots (oldest get pruned)

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

  // Hook events (tool use, session, etc.)
  if (type === 'PreToolUse' || type === 'PostToolUse') {
    const tool = p.tool_name || p.toolName || '';
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

  // Mutations (bd-5knqx: filter noisy heartbeat-style updates)
  if (type === 'MutationCreate') return 'created bead';
  if (type === 'MutationUpdate') {
    if (p.type === 'rpc_audit') return null; // daemon-token bookkeeping noise
    if (p.agent_state && !p.new_status) return null; // periodic agent heartbeat
    return 'updated';
  }
  if (type === 'MutationStatus') return p.new_status || 'status';
  if (type === 'MutationClose') return 'closed';

  // Decisions — filtered out of doots (bd-t25i1: too noisy, not tied to visible beads)
  if (type === 'DecisionCreated') return null;
  if (type === 'DecisionResponded') return null;
  if (type === 'DecisionEscalated') return null;
  if (type === 'DecisionExpired') return null;

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
  const candidates = [
    p.issue_id,   // mutation events: the bead being mutated
    p.agent_id,   // agent lifecycle events
    p.agentID,    // alternate casing
    p.assignee,   // mutation events: the agent assigned to the bead
    p.actor,      // hook events (short agent name) or mutations ("daemon")
  ].filter(c => c && c !== 'daemon');

  if (candidates.length === 0) return null;

  // Pass 1: Prefer dedicated agent nodes
  const agents = graphData.nodes.filter(n => n.issue_type === 'agent');
  for (const candidate of candidates) {
    for (const node of agents) {
      if (node.id === candidate || node.title === candidate || node.assignee === candidate) return node;
    }
    for (const node of agents) {
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

function spawnDoot(node, text, color) {
  if (!node || !text || !graph) return;

  // Trigger doot popup for non-agent nodes (beads-edy1)
  showDootPopup(node);

  const sprite = makeTextSprite(text, { fontSize: 16, color, opacity: 0.9 });
  // Random horizontal jitter so overlapping doots spread out
  const jx = (Math.random() - 0.5) * 6;
  const jz = (Math.random() - 0.5) * 6;
  sprite.position.set(
    (node.x || 0) + jx,
    (node.y || 0) + 10, // start just above node
    (node.z || 0) + jz,
  );
  sprite.renderOrder = 999;
  graph.scene().add(sprite);

  doots.push({
    sprite,
    node,
    birth: performance.now() / 1000,
    lifetime: DOOT_LIFETIME,
    jx, jz,
  });

  // Prune oldest if over limit
  while (doots.length > DOOT_MAX) {
    const old = doots.shift();
    graph.scene().remove(old.sprite);
    old.sprite.material.map?.dispose();
    old.sprite.material.dispose();
  }
}

// Update doot positions and opacity in animate loop
function updateDoots(t) {
  for (let i = doots.length - 1; i >= 0; i--) {
    const d = doots[i];
    const age = t - d.birth;

    if (age > d.lifetime) {
      // Remove expired doot
      graph.scene().remove(d.sprite);
      d.sprite.material.map?.dispose();
      d.sprite.material.dispose();
      doots.splice(i, 1);
      continue;
    }

    // Rise upward, follow node position (nodes can move during force layout)
    const rise = age * DOOT_RISE_SPEED;
    d.sprite.position.set(
      (d.node.x || 0) + d.jx,
      (d.node.y || 0) + 10 + rise,
      (d.node.z || 0) + d.jz,
    );

    // Fade out over last 40% of lifetime
    const fadeStart = d.lifetime * 0.6;
    const opacity = age < fadeStart ? 0.9 : 0.9 * (1 - (age - fadeStart) / (d.lifetime - fadeStart));
    d.sprite.material.opacity = Math.max(0, opacity);
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

function connectBusStream() {
  try {
    let _dootDrops = 0;
    api.connectBusEvents('agents,hooks,oj,mutations', (evt) => {
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
    if (_pollIntervalId) clearInterval(_pollIntervalId);
    _pollIntervalId = setInterval(refresh, POLL_INTERVAL);
    graph.cameraPosition({ x: 0, y: 0, z: 400 });

    // URL deep-linking (bd-he95o): ?bead=<id> highlights and focuses a specific bead.
    // Delay to let force layout settle so camera can fly to stable positions.
    if (DEEP_LINK_BEAD) {
      setTimeout(() => focusDeepLinkBead(DEEP_LINK_BEAD), 2000);
    }
    // Expose for Playwright tests
    window.__beads3d = { graph, graphData: () => graphData, multiSelected: () => multiSelected, showBulkMenu, showDetail, hideDetail, selectNode, highlightSubgraph, clearSelection };
    // Expose doot internals for testing (bd-pg7vy)
    window.__beads3d_spawnDoot = spawnDoot;
    window.__beads3d_doots = () => doots;
    window.__beads3d_dootLabel = dootLabel;
    window.__beads3d_dootColor = dootColor;
    window.__beads3d_findAgentNode = findAgentNode;
    // Expose mutation handler for testing (bd-03b5v)
    window.__beads3d_applyMutation = applyMutationOptimistic;

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
