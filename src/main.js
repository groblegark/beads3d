import ForceGraph3D from '3d-force-graph';
import * as THREE from 'three';
import { BeadsAPI } from './api.js';
import { nodeColor, nodeSize, linkColor, colorToHex } from './colors.js';

// --- Config ---
const params = new URLSearchParams(window.location.search);
const API_BASE = params.get('api') || '/api';
const POLL_INTERVAL = 10000;
const MAX_NODES = 300; // safety cap for performance

const api = new BeadsAPI(API_BASE);

// --- State ---
let graphData = { nodes: [], links: [] };
let graph;
let searchFilter = '';
let statusFilter = new Set(); // empty = show all
let typeFilter = new Set();
let startTime = performance.now();

// --- Build graph ---
function initGraph() {
  graph = ForceGraph3D()(document.getElementById('graph'))
    .backgroundColor('#0a0a0f')
    .showNavInfo(false)

    // Custom node rendering — organic vacuole look
    .nodeThreeObject(n => {
      if (n._hidden) return new THREE.Group(); // filtered out

      const size = nodeSize(n);
      const color = nodeColor(n);
      const hexColor = colorToHex(color);
      const group = new THREE.Group();

      // Inner sphere (solid core)
      const geo = new THREE.SphereGeometry(size, 16, 16);
      const mat = new THREE.MeshBasicMaterial({
        color: hexColor,
        transparent: true,
        opacity: 0.85,
      });
      group.add(new THREE.Mesh(geo, mat));

      // Outer glow shell
      const glowGeo = new THREE.SphereGeometry(size * 1.6, 10, 10);
      const glowMat = new THREE.MeshBasicMaterial({
        color: hexColor,
        transparent: true,
        opacity: 0.12,
      });
      group.add(new THREE.Mesh(glowGeo, glowMat));

      // In-progress nodes get a pulsing ring
      if (n.status === 'in_progress') {
        const ringGeo = new THREE.TorusGeometry(size * 2.0, 0.3, 8, 32);
        const ringMat = new THREE.MeshBasicMaterial({
          color: 0xd4a017,
          transparent: true,
          opacity: 0.5,
        });
        const ring = new THREE.Mesh(ringGeo, ringMat);
        ring.rotation.x = Math.PI / 2;
        ring.userData.pulse = true;
        group.add(ring);
      }

      // Epics get a wireframe shell (organelle membrane)
      if (n.issue_type === 'epic') {
        const shellGeo = new THREE.IcosahedronGeometry(size * 2, 1);
        const shellMat = new THREE.MeshBasicMaterial({
          color: 0x8b45a6,
          transparent: true,
          opacity: 0.15,
          wireframe: true,
        });
        group.add(new THREE.Mesh(shellGeo, shellMat));
      }

      // Blocked nodes get spiky outer shell
      if (n._blocked) {
        const spikeGeo = new THREE.OctahedronGeometry(size * 2.4, 0);
        const spikeMat = new THREE.MeshBasicMaterial({
          color: 0xd04040,
          transparent: true,
          opacity: 0.2,
          wireframe: true,
        });
        group.add(new THREE.Mesh(spikeGeo, spikeMat));
      }

      return group;
    })
    .nodeLabel(() => '')
    .nodeVisibility(n => !n._hidden)

    // Link rendering
    .linkColor(l => linkColor(l))
    .linkOpacity(0.35)
    .linkWidth(l => l.dep_type === 'blocks' ? 1.2 : 0.5)
    .linkDirectionalArrowLength(3.5)
    .linkDirectionalArrowRelPos(1)
    .linkDirectionalArrowColor(l => linkColor(l))
    .linkVisibility(l => {
      const src = typeof l.source === 'object' ? l.source : graphData.nodes.find(n => n.id === l.source);
      const tgt = typeof l.target === 'object' ? l.target : graphData.nodes.find(n => n.id === l.target);
      return src && tgt && !src._hidden && !tgt._hidden;
    })

    // Directional particles — chromatin flow effect
    .linkDirectionalParticles(l => l.dep_type === 'blocks' ? 3 : 1)
    .linkDirectionalParticleWidth(1.2)
    .linkDirectionalParticleSpeed(0.003)
    .linkDirectionalParticleColor(l => linkColor(l))

    // Interaction
    .onNodeHover(handleNodeHover)
    .onNodeClick(handleNodeClick)
    .onBackgroundClick(() => { hideTooltip(); hideDetail(); });

  // Force tuning — spread nodes more
  graph.d3Force('charge').strength(-120);
  graph.d3Force('link').distance(60);

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

  // Start animation loop for pulsing effects
  startAnimation();

  return graph;
}

// --- Animation for pulsing in-progress rings ---
function startAnimation() {
  function animate() {
    requestAnimationFrame(animate);
    const t = (performance.now() - startTime) / 1000;

    // Rotate nucleus slowly
    const scene = graph.scene();
    scene.traverse(obj => {
      if (obj.userData.isNucleus) {
        obj.rotation.y = t * 0.1;
        obj.rotation.x = Math.sin(t * 0.05) * 0.3;
      }
      if (obj.userData.pulse) {
        obj.material.opacity = 0.3 + Math.sin(t * 3) * 0.2;
        obj.rotation.z = t * 0.5;
      }
    });
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

  dagTd.onclick = () => setDagMode('td', dagTd);
  dagNone.onclick = () => setDagMode(null, dagNone);
  btnRefresh.onclick = () => refresh();

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
    // Escape to clear search and close detail
    if (e.key === 'Escape') {
      if (document.activeElement === searchInput) {
        searchInput.value = '';
        searchFilter = '';
        searchInput.blur();
        applyFilters();
      }
      hideDetail();
      hideTooltip();
    }
    // 'r' to refresh
    if (e.key === 'r' && document.activeElement !== searchInput) {
      refresh();
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
