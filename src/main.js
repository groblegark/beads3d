import ForceGraph3D from '3d-force-graph';
import * as THREE from 'three';
import { BeadsAPI } from './api.js';
import { nodeColor, nodeSize, linkColor } from './colors.js';

// --- Config ---
const params = new URLSearchParams(window.location.search);
const API_BASE = params.get('api') || '/api';
const POLL_INTERVAL = 8000;

const api = new BeadsAPI(API_BASE);

// --- State ---
let graphData = { nodes: [], links: [] };
let graph;

// --- Build graph ---
function initGraph() {
  graph = ForceGraph3D()(document.getElementById('graph'))
    .backgroundColor('#0a0a0f')
    .showNavInfo(false)

    // Custom node rendering — organic vacuole look
    .nodeThreeObject(n => {
      const size = nodeSize(n);
      const color = nodeColor(n);
      const group = new THREE.Group();

      // Inner sphere (solid core)
      const geo = new THREE.SphereGeometry(size, 12, 12);
      const mat = new THREE.MeshBasicMaterial({
        color,
        transparent: true,
        opacity: 0.85,
      });
      group.add(new THREE.Mesh(geo, mat));

      // Outer glow shell
      const glowGeo = new THREE.SphereGeometry(size * 1.6, 10, 10);
      const glowMat = new THREE.MeshBasicMaterial({
        color,
        transparent: true,
        opacity: 0.12,
      });
      group.add(new THREE.Mesh(glowGeo, glowMat));

      // Agents get a spinning ring (ribosome marker)
      if (n.issue_type === 'agent' && n.status === 'in_progress') {
        const ringGeo = new THREE.TorusGeometry(size * 2.2, 0.3, 8, 24);
        const ringMat = new THREE.MeshBasicMaterial({
          color: 0xff6b35,
          transparent: true,
          opacity: 0.5,
        });
        const ring = new THREE.Mesh(ringGeo, ringMat);
        ring.rotation.x = Math.PI / 2;
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

      return group;
    })
    .nodeLabel(() => '')

    // Link rendering
    .linkColor(l => linkColor(l))
    .linkOpacity(0.35)
    .linkWidth(l => l.dep_type === 'blocks' ? 1.2 : 0.5)
    .linkDirectionalArrowLength(3.5)
    .linkDirectionalArrowRelPos(1)
    .linkDirectionalArrowColor(l => linkColor(l))

    // Directional particles — ribosome processing effect
    .linkDirectionalParticles(2)
    .linkDirectionalParticleWidth(1.2)
    .linkDirectionalParticleSpeed(0.004)
    .linkDirectionalParticleColor(l => linkColor(l))

    // Interaction
    .onNodeHover(handleNodeHover)
    .onNodeClick(handleNodeClick)
    .onBackgroundClick(hideTooltip);

  // Force tuning
  graph.d3Force('charge').strength(-100);
  graph.d3Force('link').distance(50);

  // Scene extras
  const scene = graph.scene();
  scene.fog = new THREE.FogExp2(0x0a0a0f, 0.0003); // very subtle fog, won't clip at distance

  // Nucleus — wireframe icosahedron at center (codebase)
  const nucleusGeo = new THREE.IcosahedronGeometry(10, 2);
  const nucleusMat = new THREE.MeshBasicMaterial({
    color: 0x1a1a3e,
    transparent: true,
    opacity: 0.12,
    wireframe: true,
  });
  scene.add(new THREE.Mesh(nucleusGeo, nucleusMat));

  // Cell membrane — faint outer boundary
  const membraneGeo = new THREE.IcosahedronGeometry(250, 3);
  const membraneMat = new THREE.MeshBasicMaterial({
    color: 0x1a2a3a,
    transparent: true,
    opacity: 0.03,
    wireframe: true,
  });
  scene.add(new THREE.Mesh(membraneGeo, membraneMat));

  scene.add(new THREE.AmbientLight(0x404060, 0.5));

  // Extend camera draw distance
  const camera = graph.camera();
  camera.far = 50000;
  camera.updateProjectionMatrix();

  return graph;
}

// --- Data fetching ---
// Combine Ready + Blocked + InProgress to get all active work with dep links
async function fetchGraphData() {
  const statusEl = document.getElementById('status');
  try {
    // Fetch multiple views in parallel to build a complete active-work graph
    const [ready, blocked, inProgress, stats] = await Promise.all([
      api.ready(),
      api.blocked(),
      api.list({ limit: 100, status: 'in_progress' }),
      api.stats().catch(() => null),
    ]);

    // Merge all issues, dedup by id
    const issueMap = new Map();
    const addIssues = (arr) => {
      if (!Array.isArray(arr)) return;
      for (const i of arr) {
        if (!i.ephemeral && i.issue_type !== 'message' && i.issue_type !== 'config') {
          issueMap.set(i.id, i);
        }
      }
    };

    addIssues(ready);
    addIssues(blocked);
    addIssues(inProgress);

    const issues = [...issueMap.values()];

    statusEl.textContent = `connected · ${issues.length} beads`;
    statusEl.className = 'connected';

    updateStats(stats, issues);
    return buildGraphData(issues);
  } catch (err) {
    statusEl.textContent = `error: ${err.message}`;
    statusEl.className = 'error';
    console.error('Fetch failed:', err);
    return null;
  }
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
    // blocked_by array from Blocked endpoint → create links
    if (issue.blocked_by && Array.isArray(issue.blocked_by)) {
      for (const blockerId of issue.blocked_by) {
        // Link: blocker → blocked (blocker must finish first)
        const key = `${issue.id}<-${blockerId}`;
        if (seenLinks.has(key)) continue;
        seenLinks.add(key);

        // Add the blocker as a node if not already present
        if (!issueMap.has(blockerId)) {
          // Create a placeholder node for the blocker
          const placeholder = {
            id: blockerId,
            title: blockerId,
            status: 'open',
            priority: 3,
            issue_type: 'task',
            _placeholder: true,
          };
          issueMap.set(blockerId, placeholder);
          nodes.push({ ...placeholder, _blocked: false });
        }

        links.push({
          source: blockerId,
          target: issue.id,
          dep_type: 'blocks',
        });
      }
    }

    // Dependencies from Show-style responses (if present)
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
            id: toId,
            title: dep.title || toId,
            status: dep.status || 'open',
            priority: dep.priority ?? 3,
            issue_type: dep.issue_type || 'task',
            _placeholder: true,
          };
          issueMap.set(toId, placeholder);
          nodes.push({ ...placeholder, _blocked: false });
        }

        links.push({
          source: fromId,
          target: toId,
          dep_type: dep.type || dep.dependency_type || 'blocks',
        });
      }
    }

    // Parent-child links
    if (issue.parent && issueMap.has(issue.parent)) {
      const key = `${issue.id}->parent:${issue.parent}`;
      if (!seenLinks.has(key)) {
        seenLinks.add(key);
        links.push({
          source: issue.id,
          target: issue.parent,
          dep_type: 'parent-child',
        });
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
    parts.push(`<span>${stats.open_issues}</span> open`);
    parts.push(`<span>${stats.in_progress_issues}</span> active`);
    if (stats.blocked_issues) parts.push(`<span>${stats.blocked_issues}</span> blocked`);
  }
  parts.push(`<span>${issues.length}</span> shown`);
  el.innerHTML = parts.join(' · ');
}

// --- Tooltip ---
const tooltip = document.getElementById('tooltip');

function handleNodeHover(node) {
  document.body.style.cursor = node ? 'pointer' : 'default';
  if (!node) { hideTooltip(); return; }

  const pLabel = ['P0 CRIT', 'P1', 'P2', 'P3', 'P4'][node.priority] || '';
  const assignee = node.assignee ? `assignee: ${node.assignee}` : '';

  tooltip.innerHTML = `
    <div class="id">${node.id} · ${node.issue_type || 'task'} · ${pLabel}</div>
    <div class="title">${escapeHtml(node.title || node.id)}</div>
    <div class="meta">
      ${node.status}${node._blocked ? ' · BLOCKED' : ''}${node._placeholder ? ' · (dep reference)' : ''}
      ${assignee ? '<br>' + assignee : ''}
      ${node.blocked_by ? '<br>blocked by: ' + node.blocked_by.join(', ') : ''}
    </div>
  `;
  tooltip.style.display = 'block';
  document.addEventListener('mousemove', positionTooltip);
}

function positionTooltip(e) {
  tooltip.style.left = (e.clientX + 15) + 'px';
  tooltip.style.top = (e.clientY + 15) + 'px';
}

function hideTooltip() {
  tooltip.style.display = 'none';
  document.removeEventListener('mousemove', positionTooltip);
}

function handleNodeClick(node) {
  if (!node) return;
  const distance = 80;
  const distRatio = 1 + distance / Math.hypot(node.x, node.y, node.z);
  graph.cameraPosition(
    { x: node.x * distRatio, y: node.y * distRatio, z: node.z * distRatio },
    node,
    1000
  );
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// --- Controls ---
function setupControls() {
  const dagRadial = document.getElementById('btn-dag-radial');
  const dagTd = document.getElementById('btn-dag-td');
  const dagNone = document.getElementById('btn-dag-none');
  const btnBloom = document.getElementById('btn-bloom');
  const btnRefresh = document.getElementById('btn-refresh');

  function setDagMode(mode, activeBtn) {
    graph.dagMode(mode);
    [dagRadial, dagTd, dagNone].forEach(b => b.classList.remove('active'));
    activeBtn.classList.add('active');
  }

  dagRadial.onclick = () => setDagMode('radialout', dagRadial);
  dagTd.onclick = () => setDagMode('td', dagTd);
  dagNone.onclick = () => setDagMode(null, dagNone);
  btnBloom.onclick = () => btnBloom.classList.toggle('active');
  btnRefresh.onclick = () => refresh();

  // Free layout default
  [dagRadial, dagTd, dagNone].forEach(b => b.classList.remove('active'));
  dagNone.classList.add('active');
}

// --- Refresh ---
async function refresh() {
  const data = await fetchGraphData();
  if (data) {
    graphData = data;
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
    graph.cameraPosition({ x: 0, y: 0, z: 300 });
  } catch (err) {
    console.error('Init failed:', err);
    document.getElementById('status').textContent = `init error: ${err.message}`;
    document.getElementById('status').className = 'error';
  }
}

main();
