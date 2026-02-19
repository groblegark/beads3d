import ForceGraph3D from '3d-force-graph';
import * as THREE from 'three';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { BeadsAPI } from './api.js';
import { nodeColor, nodeSize, linkColor } from './colors.js';

// --- Config ---
// In dev, Vite proxy handles /api → daemon with auth
// Override with ?api=http://... for direct connection
const params = new URLSearchParams(window.location.search);
const API_BASE = params.get('api') || '/api';
const POLL_INTERVAL = 5000; // ms between refreshes

const api = new BeadsAPI(API_BASE);

// --- State ---
let graphData = { nodes: [], links: [] };
let bloomEnabled = true;
let currentDagMode = 'radialout';
let graph;
let bloomPass;

// --- Build graph ---
function initGraph() {
  graph = ForceGraph3D()(document.getElementById('graph'))
    .backgroundColor('#0a0a0f')
    .showNavInfo(false)

    // Node rendering
    .nodeVal(n => nodeSize(n) ** 2)
    .nodeColor(n => nodeColor(n))
    .nodeOpacity(0.9)
    .nodeResolution(16)
    .nodeLabel(() => '') // we use custom tooltip

    // Link rendering
    .linkColor(l => linkColor(l))
    .linkOpacity(0.35)
    .linkWidth(l => l.dep_type === 'blocks' ? 1.5 : 0.5)
    .linkDirectionalArrowLength(4)
    .linkDirectionalArrowRelPos(1)
    .linkDirectionalArrowColor(l => linkColor(l))

    // Directional particles — the "ribosome processing" effect
    .linkDirectionalParticles(l => l.dep_type === 'blocks' ? 3 : 1)
    .linkDirectionalParticleWidth(1.5)
    .linkDirectionalParticleSpeed(0.005)
    .linkDirectionalParticleColor(l => linkColor(l))

    // DAG layout
    .dagMode(currentDagMode)
    .dagLevelDistance(40)

    // Interaction
    .onNodeHover(handleNodeHover)
    .onNodeClick(handleNodeClick)
    .onBackgroundClick(hideTooltip)

    // Force tuning
    .d3Force('charge').strength(-120);

  graph.d3Force('link').distance(50);

  // Bloom post-processing
  const renderer = graph.renderer();
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.2;

  bloomPass = new UnrealBloomPass(
    new THREE.Vector2(window.innerWidth, window.innerHeight),
    1.2,   // strength
    0.4,   // radius
    0.2    // threshold
  );
  graph.postProcessingComposition().addPass(bloomPass);

  // Add ambient glow to the scene
  const scene = graph.scene();
  scene.fog = new THREE.FogExp2(0x0a0a0f, 0.003);

  // Nucleus — a dim sphere at the center representing the codebase
  const nucleusGeo = new THREE.SphereGeometry(15, 32, 32);
  const nucleusMat = new THREE.MeshBasicMaterial({
    color: 0x1a1a2e,
    transparent: true,
    opacity: 0.15,
    wireframe: true,
  });
  const nucleus = new THREE.Mesh(nucleusGeo, nucleusMat);
  scene.add(nucleus);

  // Cell membrane — large wireframe sphere
  const membraneGeo = new THREE.SphereGeometry(300, 48, 48);
  const membraneMat = new THREE.MeshBasicMaterial({
    color: 0x1a2a3a,
    transparent: true,
    opacity: 0.04,
    wireframe: true,
  });
  const membrane = new THREE.Mesh(membraneGeo, membraneMat);
  scene.add(membrane);

  return graph;
}

// --- Data fetching ---
async function fetchGraphData() {
  const statusEl = document.getElementById('status');
  try {
    // Fetch issues and stats in parallel
    // Filter to active work — exclude closed/tombstone/ephemeral to keep graph manageable
    const [issues, stats] = await Promise.all([
      api.list({
        limit: 300,
        exclude_status: ['closed', 'tombstone'],
      }),
      api.stats(),
    ]);

    statusEl.textContent = `connected · ${API_BASE}`;
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
  if (!Array.isArray(issues)) {
    issues = issues?.issues || [];
  }

  const issueMap = new Map();
  issues.forEach(issue => issueMap.set(issue.id, issue));

  // Mark blocked issues
  const blockedIds = new Set();

  const nodes = issues.map(issue => ({
    id: issue.id,
    ...issue,
    _blocked: false,
  }));

  const links = [];
  const seenLinks = new Set();

  issues.forEach(issue => {
    // Dependencies from the issue itself
    if (issue.dependencies) {
      issue.dependencies.forEach(dep => {
        const key = `${dep.issue_id}->${dep.depends_on_id}:${dep.type || dep.dependency_type}`;
        if (seenLinks.has(key)) return;
        seenLinks.add(key);

        // Only add link if both nodes exist
        if (issueMap.has(dep.issue_id) && issueMap.has(dep.depends_on_id)) {
          links.push({
            source: dep.issue_id,
            target: dep.depends_on_id,
            dep_type: dep.type || dep.dependency_type || 'blocks',
          });

          // If the dependency is open/in_progress, the issue is blocked
          const blocker = issueMap.get(dep.depends_on_id);
          if (blocker && blocker.status !== 'closed') {
            blockedIds.add(dep.issue_id);
          }
        }
      });
    }

    // Parent-child links
    if (issue.parent && issueMap.has(issue.parent)) {
      const key = `${issue.id}->${issue.parent}:parent-child`;
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

  // Mark blocked
  nodes.forEach(n => {
    if (blockedIds.has(n.id)) n._blocked = true;
  });

  return { nodes, links };
}

function updateStats(stats, issues) {
  const el = document.getElementById('stats');
  if (!stats) return;

  const arr = Array.isArray(issues) ? issues : (issues?.issues || []);
  const agents = arr.filter(i => i.issue_type === 'agent' && i.status === 'in_progress').length;
  const epics = arr.filter(i => i.issue_type === 'epic' && i.status !== 'closed').length;

  el.innerHTML = [
    `<span>${stats.total_issues || arr.length}</span> total`,
    `<span>${stats.open_issues || '?'}</span> open`,
    `<span>${stats.in_progress_issues || '?'}</span> active`,
    `<span>${stats.blocked_issues || '?'}</span> blocked`,
    agents > 0 ? `<span>${agents}</span> agents` : '',
    epics > 0 ? `<span>${epics}</span> epics` : '',
  ].filter(Boolean).join(' · ');
}

// --- Tooltip ---
const tooltip = document.getElementById('tooltip');

function handleNodeHover(node, prevNode) {
  document.body.style.cursor = node ? 'pointer' : 'default';

  if (!node) {
    hideTooltip();
    return;
  }

  const priorityLabel = ['P0 CRITICAL', 'P1 HIGH', 'P2', 'P3', 'P4'][node.priority] || '';
  const assignee = node.assignee ? `assignee: ${node.assignee}` : '';
  const agentState = node.agent_state ? `agent: ${node.agent_state}` : '';
  const labels = node.labels?.length ? `labels: ${node.labels.join(', ')}` : '';

  tooltip.innerHTML = `
    <div class="id">${node.id} · ${node.issue_type || 'task'} · ${priorityLabel}</div>
    <div class="title">${escapeHtml(node.title || node.id)}</div>
    <div class="meta">
      ${node.status}${node._blocked ? ' · BLOCKED' : ''}
      ${assignee ? '<br>' + assignee : ''}
      ${agentState ? '<br>' + agentState : ''}
      ${labels ? '<br>' + labels : ''}
    </div>
  `;
  tooltip.style.display = 'block';

  // Position near cursor
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

  // Zoom camera to node
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
    currentDagMode = mode;
    graph.dagMode(mode);
    [dagRadial, dagTd, dagNone].forEach(b => b.classList.remove('active'));
    activeBtn.classList.add('active');
  }

  dagRadial.onclick = () => setDagMode('radialout', dagRadial);
  dagTd.onclick = () => setDagMode('td', dagTd);
  dagNone.onclick = () => setDagMode(null, dagNone);

  btnBloom.classList.add('active');
  btnBloom.onclick = () => {
    bloomEnabled = !bloomEnabled;
    bloomPass.strength = bloomEnabled ? 1.2 : 0;
    btnBloom.classList.toggle('active', bloomEnabled);
  };

  btnRefresh.onclick = () => refresh();
}

// --- Refresh loop ---
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
    api.connectEvents((event) => {
      // On any event, schedule a refresh (debounced)
      clearTimeout(connectLiveUpdates._timer);
      connectLiveUpdates._timer = setTimeout(refresh, 1000);
    });
  } catch {
    // SSE not available — fall back to polling
  }
}

// --- Init ---
async function main() {
  initGraph();
  setupControls();

  // Initial load
  await refresh();

  // Try SSE, fall back to polling
  connectLiveUpdates();
  setInterval(refresh, POLL_INTERVAL);

  // Camera starting position
  graph.cameraPosition({ x: 0, y: 0, z: 400 });
}

main();
