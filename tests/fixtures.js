// Fixed mock data for deterministic screenshot tests.
// Provides a small but representative graph with different node types,
// statuses, priorities, and dependency types.

export const MOCK_GRAPH = {
  nodes: [
    { id: 'bd-epic1', title: 'Epic: Platform Overhaul', status: 'in_progress', priority: 0, issue_type: 'epic', assignee: 'alice', created_at: '2026-01-15T10:00:00Z', updated_at: '2026-02-10T12:00:00Z', labels: ['platform'], dep_count: 3, dep_by_count: 0, blocked_by: [] },
    { id: 'bd-feat1', title: 'Add user authentication', status: 'in_progress', priority: 1, issue_type: 'feature', assignee: 'alice', created_at: '2026-01-20T09:00:00Z', updated_at: '2026-02-18T15:00:00Z', labels: ['auth'], dep_count: 1, dep_by_count: 1, blocked_by: [] },
    { id: 'bd-task1', title: 'Write OAuth integration tests', status: 'open', priority: 2, issue_type: 'task', assignee: 'bob', created_at: '2026-02-01T08:00:00Z', updated_at: '2026-02-17T10:00:00Z', labels: ['testing'], dep_count: 0, dep_by_count: 1, blocked_by: ['bd-feat1'] },
    { id: 'bd-bug1', title: 'Token refresh race condition', status: 'open', priority: 1, issue_type: 'bug', assignee: 'charlie', created_at: '2026-02-05T14:00:00Z', updated_at: '2026-02-19T09:00:00Z', labels: ['auth', 'critical'], dep_count: 0, dep_by_count: 0, blocked_by: [] },
    { id: 'bd-task2', title: 'Database migration script', status: 'open', priority: 2, issue_type: 'task', assignee: 'bob', created_at: '2026-02-10T11:00:00Z', updated_at: '2026-02-19T08:00:00Z', labels: [], dep_count: 0, dep_by_count: 1, blocked_by: [] },
    { id: 'bd-feat2', title: 'API rate limiting', status: 'open', priority: 2, issue_type: 'feature', assignee: '', created_at: '2026-02-12T16:00:00Z', updated_at: '2026-02-18T14:00:00Z', labels: ['api'], dep_count: 1, dep_by_count: 0, blocked_by: ['bd-task2'] },
    { id: 'bd-epic2', title: 'Epic: Observability Stack', status: 'open', priority: 1, issue_type: 'epic', assignee: 'charlie', created_at: '2026-01-10T08:00:00Z', updated_at: '2026-02-15T11:00:00Z', labels: ['infra'], dep_count: 2, dep_by_count: 0, blocked_by: [] },
    { id: 'bd-task3', title: 'Add structured logging', status: 'in_progress', priority: 2, issue_type: 'task', assignee: 'charlie', created_at: '2026-02-08T10:00:00Z', updated_at: '2026-02-19T07:00:00Z', labels: ['logging'], dep_count: 0, dep_by_count: 1, blocked_by: [] },
    { id: 'bd-task4', title: 'Metrics dashboard Helm chart', status: 'open', priority: 3, issue_type: 'task', assignee: '', created_at: '2026-02-14T09:00:00Z', updated_at: '2026-02-18T16:00:00Z', labels: ['helm', 'infra'], dep_count: 0, dep_by_count: 1, blocked_by: ['bd-task3'] },
    { id: 'bd-bug2', title: 'Memory leak in event bus', status: 'open', priority: 0, issue_type: 'bug', assignee: 'alice', created_at: '2026-02-18T20:00:00Z', updated_at: '2026-02-19T10:00:00Z', labels: ['critical'], dep_count: 0, dep_by_count: 0, blocked_by: [] },
    { id: 'bd-task5', title: 'Refactor config loader', status: 'open', priority: 3, issue_type: 'task', assignee: 'bob', created_at: '2026-02-16T12:00:00Z', updated_at: '2026-02-19T06:00:00Z', labels: [], dep_count: 0, dep_by_count: 0, blocked_by: [] },
    { id: 'bd-feat3', title: 'WebSocket event streaming', status: 'open', priority: 2, issue_type: 'feature', assignee: 'charlie', created_at: '2026-02-13T15:00:00Z', updated_at: '2026-02-19T11:00:00Z', labels: ['api', 'realtime'], dep_count: 0, dep_by_count: 0, blocked_by: [] },
  ],
  edges: [
    { source: 'bd-epic1', target: 'bd-feat1', type: 'parent-child' },
    { source: 'bd-epic1', target: 'bd-feat2', type: 'parent-child' },
    { source: 'bd-feat1', target: 'bd-task1', type: 'blocks' },
    { source: 'bd-task2', target: 'bd-feat2', type: 'blocks' },
    { source: 'bd-epic2', target: 'bd-task3', type: 'parent-child' },
    { source: 'bd-epic2', target: 'bd-task4', type: 'parent-child' },
    { source: 'bd-task3', target: 'bd-task4', type: 'blocks' },
    { source: 'bd-feat1', target: 'bd-bug1', type: 'relates-to' },
    { source: 'bd-epic1', target: 'bd-task2', type: 'parent-child' },
    { source: 'bd-feat3', target: 'bd-epic2', type: 'waits-for' },
  ],
  stats: {
    total_open: 8,
    total_in_progress: 3,
    total_blocked: 3,
  },
};

// Minimal response for Ping
export const MOCK_PING = { version: '0.62.6', uptime: 3600 };

// Minimal response for Show (bd-feat1 as example)
export const MOCK_SHOW = {
  id: 'bd-feat1',
  title: 'Add user authentication',
  description: 'Implement OAuth2 authentication flow with PKCE support.\nIntegrate with Claude OAuth provider.\nSupport refresh token rotation.',
  status: 'in_progress',
  priority: 1,
  issue_type: 'feature',
  assignee: 'alice',
  labels: ['auth'],
  design: 'Use authorization code flow with PKCE. Store tokens in secure HTTP-only cookies.',
  notes: 'Blocked by Cloudflare device code endpoint from K8s pods.',
  created_at: '2026-01-20T09:00:00Z',
  updated_at: '2026-02-18T15:00:00Z',
  dependencies: [
    { depends_on_id: 'bd-task1', title: 'Write OAuth integration tests', type: 'blocks', status: 'open', priority: 2 },
  ],
  blocked_by: [],
};
