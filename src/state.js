// Shared mutable state for beads3d (bd-7t6nt: extracted from main.js monolith)
// All modules import from here to avoid circular dependencies.

import * as THREE from 'three';
import { BeadsAPI } from './api.js';

// --- Config ---
const params = new URLSearchParams(window.location.search);
export const API_BASE = params.get('api') || '/api';
export const DEEP_LINK_BEAD = params.get('bead') || ''; // bd-he95o: URL deep-linking
export const DEEP_LINK_MOLECULE = params.get('molecule') || ''; // bd-lwut6: molecule focus view
export const URL_PROFILE = params.get('profile') || ''; // bd-8o2gd phase 4: load named profile from URL
export const URL_ASSIGNEE = params.get('assignee') || ''; // bd-8o2gd phase 4: filter by assignee via URL
export const URL_STATUS = params.get('status') || ''; // bd-8o2gd phase 4: comma-separated statuses
export const URL_TYPES = params.get('types') || ''; // bd-8o2gd phase 4: comma-separated types
export const POLL_INTERVAL = 30000; // bd-c1x6p: reduced from 10s to 30s — SSE handles live updates
export const MAX_NODES = 1000; // bd-04wet: raised from 500 to show more relevant beads

export const api = new BeadsAPI(API_BASE);

// --- Shared geometries (reused across all nodes to reduce GC + draw overhead) ---
export const GEO = {
  sphereHi:   new THREE.SphereGeometry(1, 12, 12),   // unit sphere, scaled per-node
  sphereLo:   new THREE.SphereGeometry(1, 6, 6),      // low-poly glow shell
  torus:      new THREE.TorusGeometry(1, 0.15, 6, 20), // unit torus for rings
  octa:       new THREE.OctahedronGeometry(1, 0),      // blocked spikes
  box:        new THREE.BoxGeometry(1, 1, 1),           // descent stage, general purpose
};

// Shared materia halo texture (bd-c7d5z) — lazy-initialized on first use
export let _materiaHaloTex = null;
export function setMateriaHaloTex(tex) { _materiaHaloTex = tex; }

// --- Graph State ---
export let graphData = { nodes: [], links: [] };
export function setGraphData(data) { graphData = data; }
export let graph = null;
export function setGraph(g) { graph = g; }

export let searchFilter = '';
export function setSearchFilter(v) { searchFilter = v; }
export let statusFilter = new Set(); // empty = show all
export let typeFilter = new Set();
export let priorityFilter = new Set(); // empty = show all priorities (bd-8o2gd phase 2)
export let assigneeFilter = ''; // empty = show all assignees (bd-8o2gd phase 2)
export function setAssigneeFilter(v) { assigneeFilter = v; }
export let filterDashboardOpen = false; // slide-out filter panel state (bd-8o2gd phase 2)
export function setFilterDashboardOpen(v) { filterDashboardOpen = v; }
export const startTime = performance.now();
export let selectedNode = null;
export function setSelectedNode(n) { selectedNode = n; }
export const highlightNodes = new Set();
export const highlightLinks = new Set();
export let bloomPass = null;
export function setBloomPass(bp) { bloomPass = bp; }
export let bloomEnabled = false;
export function setBloomEnabled(v) { bloomEnabled = v; }
export let layoutGuides = []; // THREE objects added as layout visual aids (cleaned up on layout switch)
export function setLayoutGuides(arr) { layoutGuides = arr; }

// Search navigation state
export let searchResults = []; // ordered list of matching node ids
export function setSearchResults(arr) { searchResults = arr; }
export let searchResultIdx = -1; // current position in results (-1 = none)
export function setSearchResultIdx(v) { searchResultIdx = v; }
export let minimapVisible = true;
export function setMinimapVisible(v) { minimapVisible = v; }

// Multi-selection state (rubber-band / shift+drag)
export const multiSelected = new Set(); // set of node IDs currently multi-selected
export const revealedNodes = new Set(); // node IDs force-shown by click-to-reveal (hq-vorf47)
export const focusedMoleculeNodes = new Set(); // node IDs in the focused molecule (bd-lwut6)
export let isBoxSelecting = false;
export function setIsBoxSelecting(v) { isBoxSelecting = v; }
export let boxSelectStart = null; // {x, y} screen coords
export function setBoxSelectStart(v) { boxSelectStart = v; }
export let cameraFrozen = false; // true when multi-select has locked orbit controls (bd-casin)
export function setCameraFrozen(v) { cameraFrozen = v; }
export let labelsVisible = true; // true when persistent info labels are shown on all nodes (bd-1o2f7, bd-oypa2: default on)
export function setLabelsVisible(v) { labelsVisible = v; }

// Quake-style smooth camera movement (bd-zab4q)
export const _keysDown = new Set(); // currently held arrow keys
export const _camVelocity = { x: 0, y: 0, z: 0 }; // world-space camera velocity
export const CAM_ACCEL = 1.2;      // acceleration per frame while key held
export const CAM_MAX_SPEED = 16;   // max strafe speed (units/frame)
export const CAM_FRICTION = 0.88;  // velocity multiplier per frame when no key held (lower = more friction)
export const openPanels = new Map(); // beadId → panel element (bd-fbmq3: tiling detail panels)
export let activeAgeDays = 7; // age filter: show beads updated within N days (0 = all) (bd-uc0mw)
export function setActiveAgeDays(v) { activeAgeDays = v; }

// Agent filter state (bd-8o2gd: configurable filter dashboard, phase 1)
export let agentFilterShow = true;        // master toggle — show/hide all agent nodes
export function setAgentFilterShow(v) { agentFilterShow = v; }
export let agentFilterOrphaned = false;   // show agents with no visible connected beads
export function setAgentFilterOrphaned(v) { agentFilterOrphaned = v; }
export const agentFilterRigExclude = new Set(); // hide agents on these rigs (exact match)
export let agentFilterNameExclude = []; // glob patterns to hide agents by name (bd-8o2gd phase 4)
export function setAgentFilterNameExclude(v) { agentFilterNameExclude = v; }

// Edge type filter (bd-a0vbd): hide specific edge types to reduce graph density
export const depTypeHidden = new Set(['rig_conflict']); // default: hide rig conflict edges
export let maxEdgesPerNode = 0; // 0 = unlimited; cap edges per node to reduce hub hairballs (bd-ke2xc)
export function setMaxEdgesPerNode(v) { maxEdgesPerNode = v; }

// Simple glob matcher: supports * (any chars) and ? (single char) (bd-8o2gd phase 4)
export function globMatch(pattern, str) {
  const re = new RegExp('^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'i');
  return re.test(str);
}

// Check if a text input element is focused — suppress keyboard shortcuts (beads-lznc)
export function isTextInputFocused() {
  const el = document.activeElement;
  if (!el) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || el.contentEditable === 'true';
}

// Resource cleanup refs (bd-7n4g8)
export let _bloomResizeHandler = null;
export function setBloomResizeHandler(v) { _bloomResizeHandler = v; }
export let _pollIntervalId = null;
export function setPollIntervalId(v) { _pollIntervalId = v; }
export let _searchDebounceTimer = null;
export function setSearchDebounceTimer(v) { _searchDebounceTimer = v; }

// Live event doots — HTML overlay elements via CSS2DRenderer (bd-bwkdk)
export const doots = []; // { css2d, el, node, birth, lifetime, jx, jz }
export let css2dRenderer = null; // CSS2DRenderer instance
export function setCss2dRenderer(v) { css2dRenderer = v; }

// Doot-triggered issue popups — auto-dismissing cards when doots fire (beads-edy1)
export const dootPopups = new Map(); // nodeId → { el, timer, node, lastDoot }

// Agent activity feed windows — rich session transcript popups (bd-kau4k)
// bd-5ok9s: enhanced status: lastStatus, lastTool, idleSince, crashError
export const agentWindows = new Map();

// Agents View overlay state (bd-jgvas)
export let agentsViewOpen = false;
export function setAgentsViewOpen(v) { agentsViewOpen = v; }

// Left Sidebar state (bd-nnr22)
export let leftSidebarOpen = false;
export function setLeftSidebarOpen(v) { leftSidebarOpen = v; }
export const _agentRoster = new Map(); // agent name → { status, task, tool, idleSince, crashError, nodeId }

// Epic cycling state — Shift+S/D navigation (bd-pnngb)
export let _epicNodes = [];       // sorted array of epic nodes, rebuilt on refresh
export function setEpicNodes(arr) { _epicNodes = arr; }
export let _epicCycleIndex = -1;  // current position in _epicNodes (-1 = none)
export function setEpicCycleIndex(v) { _epicCycleIndex = v; }

// --- GPU Particle Pool + Selection VFX (bd-m9525) ---
export let _particlePool = null;  // GPU particle pool instance
export function setParticlePool(p) { _particlePool = p; }
export let _hoveredNode = null;   // currently hovered node for glow warmup
export function setHoveredNode(n) { _hoveredNode = n; }
export let _hoverGlowTimer = 0;   // accumulator for hover glow particle emission
export function setHoverGlowTimer(v) { _hoverGlowTimer = v; }
export let _selectionOrbitTimer = 0; // accumulator for orbit ring particle emission
export function setSelectionOrbitTimer(v) { _selectionOrbitTimer = v; }
export let _energyStreamTimer = 0;  // accumulator for dependency energy stream particles
export function setEnergyStreamTimer(v) { _energyStreamTimer = v; }
export let _flyToTrailActive = false; // true during camera fly-to for particle trail
export function setFlyToTrailActive(v) { _flyToTrailActive = v; }

// --- VFX Control Panel settings (bd-hr5om) ---
export const _vfxConfig = {
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

// Agent tether strength — 0 = off, 1 = max pull (bd-uzj5j)
export let _agentTetherStrength = 0.5;
export function setAgentTetherStrength(v) { _agentTetherStrength = v; }

// --- Event sprites: pop-up animations for status changes + new associations (bd-9qeto) ---
export const eventSprites = []; // { mesh, birth, lifetime, type, ... }
export const EVENT_SPRITE_MAX = 40;

// Status pulse colors by transition
export const STATUS_PULSE_COLORS = {
  in_progress: 0xd4a017, // amber — just started
  closed:      0x2d8a4e, // green — completed
  open:        0x4a9eff, // blue — reopened
  review:      0x4a9eff, // blue
  on_ice:      0x3a5a7a, // muted blue
};

// --- SSE connection state tracking (bd-ki6im) ---
export const _sseState = { mutation: 'connecting', bus: 'connecting' };
export let _refreshTimer = null;
export function setRefreshTimer(v) { _refreshTimer = v; }

// --- Expanded nodes ---
export const expandedNodes = new Set();

// Escape HTML for safe rendering
export function escapeHtml(str) {
  return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
