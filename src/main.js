import ForceGraph3D from '3d-force-graph';
import * as THREE from 'three';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { BeadsAPI } from './api.js';
import { nodeColor, nodeSize, linkColor, colorToHex } from './colors.js';

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

      // Outer glow shell — low-poly shared geometry
      const glow = new THREE.Mesh(GEO.sphereLo, new THREE.MeshBasicMaterial({
        color: hexColor, transparent: true, opacity: 0.12,
      }));
      glow.scale.setScalar(size * 1.6);
      group.add(glow);

      // In-progress: pulsing ring
      if (n.status === 'in_progress') {
        const ring = new THREE.Mesh(GEO.torus, new THREE.MeshBasicMaterial({
          color: 0xd4a017, transparent: true, opacity: 0.5,
        }));
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
      const selRing = new THREE.Mesh(GEO.torus, new THREE.MeshBasicMaterial({
        color: 0x4a9eff, transparent: true, opacity: 0,
      }));
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

  // Force tuning — scale-aware
  const nodeCount = graphData.nodes.length || 100;
  const chargeStrength = nodeCount > 200 ? -60 : -120;
  graph.d3Force('charge').strength(chargeStrength).distanceMax(400);
  graph.d3Force('link').distance(nodeCount > 200 ? 40 : 60);

  // Warm up faster then cool (reduces CPU after initial layout)
  graph.cooldownTime(4000).warmupTicks(nodeCount > 200 ? 50 : 0);

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
          if (isSelected) {
            child.material.opacity = 0.6 + Math.sin(t * 4) * 0.2;
            child.rotation.x = t * 1.2;
            child.rotation.y = t * 0.8;
          } else {
            child.material.opacity = 0;
          }
        } else if (child.userData.pulse) {
          child.material.opacity = (0.3 + Math.sin(t * 3) * 0.2) * dimFactor;
          child.rotation.z = t * 0.5;
        } else if (hasSelection) {
          // Only dim/undim when selection is active
          const baseOpacity = child.material.wireframe ? 0.15 : (child.material.opacity > 0.5 ? 0.85 : 0.12);
          child.material.opacity = baseOpacity * dimFactor;
        }
      });
    }
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
  });

  // Trigger re-render
  graph.nodeVisibility(n => !n._hidden);
  graph.linkVisibility(l => {
    const src = typeof l.source === 'object' ? l.source : graphData.nodes.find(n => n.id === l.source);
    const tgt = typeof l.target === 'object' ? l.target : graphData.nodes.find(n => n.id === l.target);
    return src && tgt && !src._hidden && !tgt._hidden;
  });

  updateFilterCount();
}

function updateFilterCount() {
  const visible = graphData.nodes.filter(n => !n._hidden).length;
  const total = graphData.nodes.length;
  const el = document.getElementById('filter-count');
  if (el) {
    el.textContent = visible < total ? `${visible}/${total}` : `${total}`;
  }
}

// --- Controls ---
function setupControls() {
  const dagTd = document.getElementById('btn-dag-td');
  const dagNone = document.getElementById('btn-dag-none');
  const btnRefresh = document.getElementById('btn-refresh');
  const searchInput = document.getElementById('search-input');

  function setDagMode(mode, activeBtn) {
    graph.dagMode(mode);
    document.querySelectorAll('#layout-controls button').forEach(b => b.classList.remove('active'));
    activeBtn.classList.add('active');
  }

  const btnBloom = document.getElementById('btn-bloom');

  dagTd.onclick = () => setDagMode('td', dagTd);
  dagNone.onclick = () => setDagMode(null, dagNone);
  btnRefresh.onclick = () => refresh();

  // Bloom toggle
  btnBloom.onclick = () => {
    bloomEnabled = !bloomEnabled;
    if (bloomPass) bloomPass.enabled = bloomEnabled;
    btnBloom.classList.toggle('active', bloomEnabled);
  };

  // Free layout default
  dagNone.classList.add('active');

  // Search
  searchInput.addEventListener('input', (e) => {
    searchFilter = e.target.value;
    applyFilters();
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
