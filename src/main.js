import ForceGraph3D from '3d-force-graph';
import * as THREE from 'three';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { BeadsAPI } from './api.js';
import { nodeColor, nodeSize, linkColor, colorToHex } from './colors.js';
import { createFresnelMaterial, createPulseRingMaterial, createSelectionRingMaterial, createStarField, updateShaderTime } from './shaders.js';

// --- Config ---
const params = new URLSearchParams(window.location.search);
const API_BASE = params.get('api') || '/api';
const POLL_INTERVAL = 10000;
const MAX_NODES = 500; // raised for scaling

const api = new BeadsAPI(API_BASE);

// --- Shared geometries (reused across all nodes to reduce GC + draw overhead) ---
const GEO = {
  sphereHi:   new THREE.SphereGeometry(1, 12, 12),   // unit sphere, scaled per-node
  sphereLo:   new THREE.SphereGeometry(1, 6, 6),      // low-poly glow shell
  torus:      new THREE.TorusGeometry(1, 0.15, 6, 20), // unit torus for rings
  icosa:      new THREE.IcosahedronGeometry(1, 1),     // epic shell
  octa:       new THREE.OctahedronGeometry(1, 0),      // blocked spikes
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

const LINK_ICON_MATERIALS = {
  'blocks':       makeLinkIconTexture(drawShield, '#d04040'),
  'waits-for':    makeLinkIconTexture(drawClock,  '#d4a017'),
  'parent-child': makeLinkIconTexture(drawChain,  '#8b45a666'),
  'relates-to':   makeLinkIconTexture(drawDot,    '#4a9eff'),
};
const LINK_ICON_DEFAULT = makeLinkIconTexture(drawDot, '#2a2a3a');

const LINK_ICON_SCALE = 4; // sprite size in world units

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

// --- Build graph ---
function initGraph() {
  graph = ForceGraph3D()(document.getElementById('graph'))
    .backgroundColor('#0a0a0f')
    .showNavInfo(false)

    // Custom node rendering — organic vacuole look (shared geometries for perf)
    .nodeThreeObject(n => {
      if (n._hidden) return new THREE.Group();

      const size = nodeSize(n);
      const hexColor = colorToHex(nodeColor(n));
      const group = new THREE.Group();

      // Inner sphere (solid core) — shared geometry, scaled
      const core = new THREE.Mesh(GEO.sphereHi, new THREE.MeshBasicMaterial({
        color: hexColor, transparent: true, opacity: 0.85,
      }));
      core.scale.setScalar(size);
      group.add(core);

      // Outer glow shell — Fresnel rim-lighting shader (bright at edges, clear at center)
      const glow = new THREE.Mesh(GEO.sphereLo, createFresnelMaterial(hexColor, { opacity: 0.5, power: 2.5 }));
      glow.scale.setScalar(size * 1.8);
      group.add(glow);

      // In-progress: pulsing ring — animated shader with soft edges
      if (n.status === 'in_progress') {
        const ring = new THREE.Mesh(GEO.torus, createPulseRingMaterial(0xd4a017));
        ring.scale.setScalar(size * 2.0);
        ring.rotation.x = Math.PI / 2;
        ring.userData.pulse = true;
        group.add(ring);
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

      return group;
    })
    .nodeLabel(() => '')
    .nodeVisibility(n => !n._hidden)

    // Link rendering — width responds to selection state
    .linkColor(l => linkColor(l))
    .linkOpacity(0.35)
    .linkWidth(l => {
      if (selectedNode) {
        const lk = linkKey(l);
        return highlightLinks.has(lk) ? (l.dep_type === 'blocks' ? 2.0 : 1.2) : 0.2;
      }
      return l.dep_type === 'blocks' ? 1.2 : 0.5;
    })
    .linkDirectionalArrowLength(3.5)
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
      const sprite = new THREE.Sprite(baseMat.clone()); // clone so per-link opacity works
      sprite.scale.setScalar(LINK_ICON_SCALE);
      return sprite;
    })
    .linkPositionUpdate((obj, { start, end }, l) => {
      // Position icon at midpoint of the link
      if (obj && obj.isSprite) {
        const mid = {
          x: (start.x + end.x) / 2,
          y: (start.y + end.y) / 2,
          z: (start.z + end.z) / 2,
        };
        obj.position.set(mid.x, mid.y, mid.z);

        // Dim icon when not part of selection highlight
        if (selectedNode) {
          const lk = linkKey(l);
          obj.material.opacity = highlightLinks.has(lk) ? 0.85 : 0.08;
        } else {
          obj.material.opacity = 0.85;
        }
      }
    })

    // Directional particles — only on blocking links (perf at scale)
    .linkDirectionalParticles(l => l.dep_type === 'blocks' ? 2 : 0)
    .linkDirectionalParticleWidth(1.0)
    .linkDirectionalParticleSpeed(0.003)
    .linkDirectionalParticleColor(l => linkColor(l))

    // Interaction
    .onNodeHover(handleNodeHover)
    .onNodeClick(handleNodeClick)
    .onNodeRightClick(handleNodeRightClick)
    .onBackgroundClick(() => { clearSelection(); hideTooltip(); hideDetail(); hideContextMenu(); });

  // Force tuning — applied by setLayout()
  const nodeCount = graphData.nodes.length || 100;

  // Warm up faster then cool (reduces CPU after initial layout)
  graph.cooldownTime(4000).warmupTicks(nodeCount > 200 ? 50 : 0);

  // Apply default layout forces
  setLayout('free');

  // Scene extras
  const scene = graph.scene();
  scene.fog = new THREE.FogExp2(0x0a0a0f, 0.00015);

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
    0.8,   // strength — subtle glow
    0.4,   // radius
    0.85   // threshold — only bright parts bloom
  );
  bloomPass.enabled = bloomEnabled;
  const composer = graph.postProcessingComposer();
  composer.addPass(bloomPass);

  // Handle window resize for bloom
  window.addEventListener('resize', () => {
    bloomPass.resolution.set(window.innerWidth, window.innerHeight);
  });

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
  // Force link width recalculation
  graph.linkWidth(graph.linkWidth());
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

      const isHighlighted = !hasSelection || highlightNodes.has(node.id);
      const isSelected = hasSelection && node.id === selectedNode.id;
      const dimFactor = isHighlighted ? 1.0 : 0.15;

      // Skip expensive traversal if no selection and not in_progress
      if (!hasSelection && node.status !== 'in_progress') continue;

      threeObj.traverse(child => {
        if (!child.material) return;

        if (child.userData.selectionRing) {
          // Selection ring: toggle visibility via uniform, rotate when selected
          if (child.material.uniforms && child.material.uniforms.visible) {
            child.material.uniforms.visible.value = isSelected ? 1.0 : 0.0;
          } else {
            child.material.opacity = isSelected ? 0.6 + Math.sin(t * 4) * 0.2 : 0;
          }
          if (isSelected) {
            child.rotation.x = t * 1.2;
            child.rotation.y = t * 0.8;
          }
        } else if (child.userData.pulse) {
          // Pulse ring: shader handles pulse via time uniform (set by updateShaderTime).
          // Just drive rotation here. For non-shader fallback, animate opacity directly.
          child.rotation.z = t * 0.5;
          if (!child.material.uniforms) {
            child.material.opacity = (0.3 + Math.sin(t * 3) * 0.2) * dimFactor;
          }
        } else if (hasSelection) {
          // Dim/undim non-highlighted nodes when selection is active
          if (child.material.uniforms && child.material.uniforms.opacity) {
            child.material.uniforms.opacity.value = 0.4 * dimFactor;
          } else if (!child.material.uniforms) {
            const baseOpacity = child.material.wireframe ? 0.15 : (child.material.opacity > 0.5 ? 0.85 : 0.12);
            child.material.opacity = baseOpacity * dimFactor;
          }
        }
      });
    }

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
  const result = await api.graph({
    limit: MAX_NODES,
    include_deps: true,
    include_body: true,
  });

  const nodes = (result.nodes || []).map(n => ({
    id: n.id,
    ...n,
    _blocked: !!(n.blocked_by && n.blocked_by.length > 0),
  }));

  // Graph API edges: { source, target, type } → links: { source, target, dep_type }
  const nodeIds = new Set(nodes.map(n => n.id));
  const links = (result.edges || [])
    .filter(e => nodeIds.has(e.source) && nodeIds.has(e.target))
    .map(e => ({
      source: e.source,
      target: e.target,
      dep_type: e.type || 'blocks',
    }));

  statusEl.textContent = `graph api · ${nodes.length} beads · ${links.length} links`;
  statusEl.className = 'connected';
  updateStats(result.stats, nodes);
  console.log(`[beads3d] Graph API: ${nodes.length} nodes, ${links.length} links`);
  return { nodes, links };
}

async function fetchViaList(statusEl) {
  const SKIP_TYPES = new Set(['message', 'config', 'gate', 'wisp', 'convoy']);

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

    // Parent-child
    if (issue.parent && issueMap.has(issue.parent)) {
      const key = `${issue.id}->parent:${issue.parent}`;
      if (!seenLinks.has(key)) {
        seenLinks.add(key);
        links.push({ source: issue.id, target: issue.parent, dep_type: 'parent-child' });
      }
    }
  });

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
  if (!node || node._hidden) return;

  selectNode(node);

  // Fly camera to node
  const distance = 80;
  const distRatio = 1 + distance / Math.hypot(node.x, node.y, node.z);
  graph.cameraPosition(
    { x: node.x * distRatio, y: node.y * distRatio, z: node.z * distRatio },
    node, 1000
  );

  showDetail(node);
}

async function showDetail(node) {
  const panel = document.getElementById('detail');
  panel.style.display = 'block';
  panel.classList.add('open');

  const pLabel = ['P0 CRIT', 'P1 HIGH', 'P2 MED', 'P3 LOW', 'P4 BACKLOG'][node.priority] || '';

  // Show basic info immediately
  panel.innerHTML = `
    <div class="detail-header">
      <span class="detail-id">${escapeHtml(node.id)}</span>
      <button class="detail-close" onclick="document.getElementById('detail').classList.remove('open'); document.getElementById('detail').style.display='none';">&times;</button>
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

  // Lazy-load full details via Show
  try {
    const full = await api.show(node.id);
    const body = panel.querySelector('.detail-body');
    body.classList.remove('loading');
    body.innerHTML = renderFullDetail(full);
  } catch (err) {
    const body = panel.querySelector('.detail-body');
    body.classList.remove('loading');
    body.textContent = `Could not load: ${err.message}`;
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
  const panel = document.getElementById('detail');
  panel.classList.remove('open');
  setTimeout(() => { panel.style.display = 'none'; }, 200);
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

function handleNodeRightClick(node, event) {
  event.preventDefault();
  if (!node || node._hidden) return;
  ctxNode = node;
  hideTooltip();

  ctxMenu.innerHTML = `
    <div class="ctx-header">${escapeHtml(node.id)}</div>
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

  // Handle clicks on menu items
  ctxMenu.onclick = (e) => {
    const item = e.target.closest('.ctx-item');
    if (!item) return;
    const action = item.dataset.action;
    handleContextAction(action, node);
  };
}

function hideContextMenu() {
  ctxMenu.style.display = 'none';
  ctxMenu.onclick = null;
  ctxNode = null;
}

function handleContextAction(action, node) {
  switch (action) {
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
    let hidden = false;

    // Text search
    if (q && !(n.id || '').toLowerCase().includes(q) &&
        !(n.title || '').toLowerCase().includes(q) &&
        !(n.assignee || '').toLowerCase().includes(q)) {
      hidden = true;
    }

    // Status filter
    if (statusFilter.size > 0 && !statusFilter.has(n.status)) {
      hidden = true;
    }

    // Type filter
    if (typeFilter.size > 0 && !typeFilter.has(n.issue_type)) {
      hidden = true;
    }

    n._hidden = hidden;
    n._searchMatch = !hidden && !!q;
  });

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

  updateFilterCount();
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

  // Bloom toggle
  btnBloom.onclick = () => {
    bloomEnabled = !bloomEnabled;
    if (bloomPass) bloomPass.enabled = bloomEnabled;
    btnBloom.classList.toggle('active', bloomEnabled);
  };

  // Search — input updates filter, Enter/arrows navigate results
  searchInput.addEventListener('input', (e) => {
    searchFilter = e.target.value;
    searchResultIdx = 0; // reset to first result on new input
    applyFilters();
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

  // Keyboard shortcuts
  document.addEventListener('keydown', (e) => {
    // '/' to focus search
    if (e.key === '/' && document.activeElement !== searchInput) {
      e.preventDefault();
      searchInput.focus();
    }
    // Escape to clear search, close detail, close context menu, and deselect
    if (e.key === 'Escape') {
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
    // 1-5 for layout modes
    const layoutKeys = { '1': 'free', '2': 'dag', '3': 'timeline', '4': 'radial', '5': 'cluster' };
    if (layoutKeys[e.key] && document.activeElement !== searchInput) {
      setLayout(layoutKeys[e.key]);
    }
  });
}

// --- Refresh ---
async function refresh() {
  const data = await fetchGraphData();
  if (data) {
    graphData = data;
    applyFilters();
    graph.graphData(graphData);
  }
}

// --- SSE live updates ---
function connectLiveUpdates() {
  try {
    let timer;
    api.connectEvents(() => {
      clearTimeout(timer);
      timer = setTimeout(refresh, 2000);
    });
  } catch { /* polling fallback */ }
}

// --- Init ---
async function main() {
  try {
    initGraph();
    setupControls();
    await refresh();
    connectLiveUpdates();
    setInterval(refresh, POLL_INTERVAL);
    graph.cameraPosition({ x: 0, y: 0, z: 400 });
  } catch (err) {
    console.error('Init failed:', err);
    document.getElementById('status').textContent = `init error: ${err.message}`;
    document.getElementById('status').className = 'error';
  }
}

main();
