// Color scheme — biological cell aesthetic
// Dark background, bioluminescent nodes, organic feel

export const STATUS_COLORS = {
  open:        '#2d8a4e',  // green — alive, ready
  in_progress: '#d4a017',  // amber — active metabolism
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
  0: 10,  // P0 critical — largest
  1: 7,   // P1 high
  2: 5,   // P2 medium
  3: 3.5, // P3 low
  4: 2.5, // P4 backlog — smallest
};

export const DEP_TYPE_COLORS = {
  blocks:      '#d04040',
  'waits-for': '#d4a017',
  'relates-to':'#4a9eff33',
  'parent-child':'#8b45a644',
  default:     '#2a2a3a',
};

export function nodeColor(issue) {
  // Blocked nodes glow red
  if (issue._blocked) return '#d04040';
  // Agents get special orange
  if (issue.issue_type === 'agent') return '#ff6b35';
  // Epics always purple
  if (issue.issue_type === 'epic') return '#8b45a6';
  // Otherwise by status
  return STATUS_COLORS[issue.status] || '#555';
}

export function nodeSize(issue) {
  const base = PRIORITY_SIZES[issue.priority] ?? 4;
  // Epics are bigger
  if (issue.issue_type === 'epic') return base * 1.8;
  // Agents slightly bigger
  if (issue.issue_type === 'agent') return base * 1.4;
  return base;
}

export function linkColor(dep) {
  return DEP_TYPE_COLORS[dep.dep_type] || DEP_TYPE_COLORS.default;
}
