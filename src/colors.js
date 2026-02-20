// Color scheme — biological cell aesthetic
// Dark background, bioluminescent nodes, organic feel

export const STATUS_COLORS = {
  open:        '#2d8a4e',  // green — alive, ready
  in_progress: '#d4a017',  // amber — active metabolism
  blocked:     '#d04040',  // red — blocked by dependency (bd-7haep)
  hooked:      '#c06020',  // burnt orange — waiting on hook (bd-7haep)
  deferred:    '#3a5a7a',  // muted blue — deferred/dormant (bd-7haep)
  review:      '#4a9eff',  // blue — signaling
  on_ice:      '#3a5a7a',  // muted blue — dormant
  closed:      '#333340',  // dark — inert
  tombstone:   '#1a1a22',  // near-black — dead
};

export const TYPE_COLORS = {
  epic:     '#8b45a6',  // purple — organelle
  feature:  '#2d8a4e',  // green
  bug:      '#d04040',  // red — pathogen
  task:     '#4a9eff',  // blue
  agent:    '#ff6b35',  // orange — ribosome
  decision: '#d4a017',  // amber — signal molecule
  gate:     '#d4a017',
  chore:    '#666',
  doc:      '#5a8a5a',
  test:     '#4a7a9e',
};

export const PRIORITY_SIZES = {
  0: 16,  // P0 critical — largest (bd-d8dfd: increased)
  1: 11,  // P1 high
  2: 8,   // P2 medium
  3: 6,   // P3 low
  4: 5,   // P4 backlog — smallest
};

export const DEP_TYPE_COLORS = {
  blocks:       '#d04040',
  'waits-for':  '#d4a017',
  'relates-to': '#4a9eff88',
  'parent-child':'#8b45a688',
  'assigned_to': '#ff6b35',
  'rig_conflict':'#ff3030',    // bright red — agents on same rig+branch (bd-90ikf)
  default:      '#3a3a5a',
};

// Decision state → color (bd-zr374)
export const DECISION_COLORS = {
  pending:  '#d4a017',  // amber — awaiting response
  resolved: '#2d8a4e',  // green — answered
  expired:  '#d04040',  // red — timed out
  canceled: '#666',     // gray — canceled
};

export function nodeColor(issue) {
  // Blocked nodes glow red
  if (issue._blocked) return '#d04040';
  // Agents get special orange
  if (issue.issue_type === 'agent') return '#ff6b35';
  // Epics always purple
  if (issue.issue_type === 'epic') return '#8b45a6';
  // Decision/gate nodes colored by decision state (bd-zr374)
  if (issue.issue_type === 'gate' || issue.issue_type === 'decision') {
    const ds = issue._decisionState || (issue.status === 'closed' ? 'resolved' : 'pending');
    return DECISION_COLORS[ds] || DECISION_COLORS.pending;
  }
  // Otherwise by status
  return STATUS_COLORS[issue.status] || '#555';
}

export function nodeSize(issue) {
  const base = PRIORITY_SIZES[issue.priority] ?? 4;
  // Epics are bigger
  if (issue.issue_type === 'epic') return base * 1.8;
  // Agents are the dominant visual element — largest nodes (bd-t1g9o)
  // Floor of 8 ensures agents always stand out; 2.5x makes them bigger than epics
  if (issue.issue_type === 'agent') return Math.max(base, 8) * 2.5;
  return base;
}

export function linkColor(dep) {
  return DEP_TYPE_COLORS[dep.dep_type] || DEP_TYPE_COLORS.default;
}

// Rig colors — deterministic hash-based palette (bd-90ikf)
// Each rig gets a unique, distinct color for badge and conflict edges.
const RIG_PALETTE = [
  '#e06090', // pink
  '#40c0a0', // teal
  '#c070e0', // violet
  '#e0a030', // gold
  '#50b0e0', // sky blue
  '#a0d050', // lime
  '#e07050', // coral
  '#70a0e0', // periwinkle
  '#d0b060', // sand
  '#60d0c0', // mint
];

const rigColorCache = {};
export function rigColor(rigName) {
  if (!rigName) return '#666';
  if (rigColorCache[rigName]) return rigColorCache[rigName];
  let hash = 0;
  for (let i = 0; i < rigName.length; i++) hash = ((hash << 5) - hash + rigName.charCodeAt(i)) | 0;
  rigColorCache[rigName] = RIG_PALETTE[Math.abs(hash) % RIG_PALETTE.length];
  return rigColorCache[rigName];
}

// CSS color string → THREE.js hex number
export function colorToHex(cssColor) {
  if (typeof cssColor === 'number') return cssColor;
  if (cssColor.startsWith('#')) {
    return parseInt(cssColor.slice(1, 7), 16);
  }
  return 0x555555;
}
