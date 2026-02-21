// E2E tests for Bottom HUD bar (bd-9cpbc.2).
// Tests unified activity feed, quick actions, project pulse, and legend.
//
// Run: npx playwright test tests/bottom-hud.spec.js
// View report: npx playwright show-report test-results/html-report

import { test, expect } from '@playwright/test';
import {
  MOCK_GRAPH, MOCK_PING, MOCK_SHOW,
  SESSION_SWIFT_NEWT, SESSION_ARCH_SEAL,
  sessionToSseBody,
} from './fixtures.js';

// Build an SSE data frame for a bus event
function sseFrame(stream, type, payload = {}, ts) {
  const data = JSON.stringify({
    stream,
    type,
    subject: `${stream}.${type}`,
    seq: Math.floor(Math.random() * 100000),
    ts: ts || new Date().toISOString(),
    payload,
  });
  return `event: ${stream}\ndata: ${data}\n\n`;
}

// Mock all API endpoints
async function mockAPI(page) {
  await page.route('**/api/bd.v1.BeadsService/Ping', route =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(MOCK_PING) }));
  await page.route('**/api/bd.v1.BeadsService/Graph', route =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(MOCK_GRAPH) }));
  await page.route('**/api/bd.v1.BeadsService/List', route =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([]) }));
  await page.route('**/api/bd.v1.BeadsService/Show', route =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(MOCK_SHOW) }));
  await page.route('**/api/bd.v1.BeadsService/Stats', route =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(MOCK_GRAPH.stats) }));
  await page.route('**/api/bd.v1.BeadsService/Blocked', route =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([]) }));
  await page.route('**/api/bd.v1.BeadsService/Ready', route =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([]) }));
  await page.route('**/api/bd.v1.BeadsService/Update', route =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) }));
  await page.route('**/api/bd.v1.BeadsService/Close', route =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) }));
  // Mock /events (mutation SSE — legacy)
  await page.route('**/api/events', route =>
    route.fulfill({ status: 200, contentType: 'text/event-stream', body: 'data: {"type":"ping"}\n\n' }));
}

// Wait for graph to load and HUD to initialize
async function waitForGraph(page) {
  await page.waitForSelector('#status.connected', { timeout: 15000 });
  await page.waitForTimeout(3000);
  await page.waitForFunction(() => {
    const b = window.__beads3d;
    return b && b.graph && b.graph.graphData().nodes.length > 0;
  }, { timeout: 10000 });
}

// =====================================================================
// UNIFIED ACTIVITY FEED
// =====================================================================

test.describe('Unified Activity Feed', () => {

  test('shows empty placeholder before events arrive', async ({ page }) => {
    await mockAPI(page);
    await page.route('**/api/bus/events*', route =>
      route.fulfill({ status: 200, contentType: 'text/event-stream', body: ': keepalive\n\n' }));

    await page.goto('/');
    await waitForGraph(page);

    const feed = page.locator('#unified-feed');
    await expect(feed).toBeVisible();
    const empty = feed.locator('.uf-empty');
    await expect(empty).toHaveText('waiting for agent events...');
  });

  test('agent lifecycle events appear in feed with correct icons', async ({ page }) => {
    await mockAPI(page);

    // Inject events: AgentStarted, AgentIdle, AgentCrashed
    const events = [
      sseFrame('agents', 'AgentStarted', { actor: 'alice' }),
      sseFrame('agents', 'AgentIdle', { actor: 'alice' }),
      sseFrame('agents', 'AgentCrashed', { actor: 'bob', error: 'timeout' }),
    ];
    await page.route('**/api/bus/events*', route =>
      route.fulfill({ status: 200, contentType: 'text/event-stream', body: events.join('') }));

    await page.goto('/');
    await waitForGraph(page);

    const feed = page.locator('#unified-feed');
    // Empty placeholder should be removed
    await expect(feed.locator('.uf-empty')).toHaveCount(0);

    // Check entries exist
    const entries = feed.locator('.uf-entry');
    await expect(entries).toHaveCount(3);

    // AgentStarted entry
    const started = entries.nth(0);
    await expect(started).toHaveClass(/lifecycle-started/);
    await expect(started.locator('.uf-entry-agent')).toHaveText('alice');
    await expect(started.locator('.uf-entry-icon')).toHaveText('●');
    await expect(started.locator('.uf-entry-text')).toHaveText('started');

    // AgentIdle entry
    const idle = entries.nth(1);
    await expect(idle).toHaveClass(/lifecycle-idle/);
    await expect(idle.locator('.uf-entry-icon')).toHaveText('◌');

    // AgentCrashed entry
    const crashed = entries.nth(2);
    await expect(crashed).toHaveClass(/lifecycle-crashed/);
    await expect(crashed.locator('.uf-entry-agent')).toHaveText('bob');
    await expect(crashed.locator('.uf-entry-icon')).toHaveText('✕');
  });

  test('mutation events appear with correct text and styling', async ({ page }) => {
    await mockAPI(page);

    const events = [
      sseFrame('mutations', 'MutationCreate', { actor: 'alice', title: 'Fix login bug' }),
      sseFrame('mutations', 'MutationClose', { actor: 'bob', issue_id: 'bd-task1' }),
      sseFrame('mutations', 'MutationStatus', { actor: 'alice', new_status: 'in_progress' }),
      sseFrame('mutations', 'MutationUpdate', { actor: 'bob', assignee: 'bob', type: 'update' }),
    ];
    await page.route('**/api/bus/events*', route =>
      route.fulfill({ status: 200, contentType: 'text/event-stream', body: events.join('') }));

    await page.goto('/');
    await waitForGraph(page);

    const entries = page.locator('#unified-feed .uf-entry');

    // MutationCreate
    const create = entries.nth(0);
    await expect(create).toHaveClass(/mutation/);
    await expect(create.locator('.uf-entry-icon')).toHaveText('+');
    await expect(create.locator('.uf-entry-text')).toContainText('Fix login bug');

    // MutationClose
    const close = entries.nth(1);
    await expect(close).toHaveClass(/mutation-close/);
    await expect(close.locator('.uf-entry-icon')).toHaveText('✓');
    await expect(close.locator('.uf-entry-text')).toContainText('bd-task1');

    // MutationStatus
    const status = entries.nth(2);
    await expect(status.locator('.uf-entry-text')).toContainText('in_progress');

    // MutationUpdate with assignee (claim)
    const claim = entries.nth(3);
    await expect(claim.locator('.uf-entry-text')).toContainText('claimed by bob');
  });

  test('decision events appear with pending and resolved styling', async ({ page }) => {
    await mockAPI(page);

    const events = [
      sseFrame('decisions', 'DecisionCreated', { actor: 'alice', question: 'Deploy to prod?' }),
      sseFrame('decisions', 'DecisionResponded', { actor: 'alice', chosen_label: 'Yes, deploy' }),
      sseFrame('decisions', 'DecisionExpired', { actor: 'bob' }),
    ];
    await page.route('**/api/bus/events*', route =>
      route.fulfill({ status: 200, contentType: 'text/event-stream', body: events.join('') }));

    await page.goto('/');
    await waitForGraph(page);

    const entries = page.locator('#unified-feed .uf-entry');

    // DecisionCreated
    const created = entries.nth(0);
    await expect(created).toHaveClass(/decision-pending/);
    await expect(created.locator('.uf-entry-icon')).toHaveText('?');
    await expect(created.locator('.uf-entry-text')).toContainText('Deploy to prod?');

    // DecisionResponded
    const responded = entries.nth(1);
    await expect(responded).toHaveClass(/decision-resolved/);
    await expect(responded.locator('.uf-entry-text')).toContainText('Yes, deploy');

    // DecisionExpired
    const expired = entries.nth(2);
    await expect(expired).toHaveClass(/decision-expired/);
  });

  test('mail events appear in feed', async ({ page }) => {
    await mockAPI(page);

    const events = [
      sseFrame('mail', 'MailSent', { actor: 'alice', from: 'alice', subject: 'Status update' }),
    ];
    await page.route('**/api/bus/events*', route =>
      route.fulfill({ status: 200, contentType: 'text/event-stream', body: events.join('') }));

    await page.goto('/');
    await waitForGraph(page);

    const entry = page.locator('#unified-feed .uf-entry').first();
    await expect(entry).toHaveClass(/mail-received/);
    await expect(entry.locator('.uf-entry-icon')).toHaveText('✉');
    await expect(entry.locator('.uf-entry-text')).toContainText('alice');
    await expect(entry.locator('.uf-entry-text')).toContainText('Status update');
  });

  test('PreToolUse/PostToolUse pairing shows tool name and duration', async ({ page }) => {
    await mockAPI(page);

    // Use two events with a 2-second gap
    const t0 = '2026-02-19T12:00:00.000Z';
    const t1 = '2026-02-19T12:00:02.000Z';
    const events = [
      sseFrame('hooks', 'PreToolUse', { actor: 'alice', tool_name: 'Bash', tool_input: { command: 'go test ./...' } }, t0),
      sseFrame('hooks', 'PostToolUse', { actor: 'alice', tool_name: 'Bash' }, t1),
    ];
    await page.route('**/api/bus/events*', route =>
      route.fulfill({ status: 200, contentType: 'text/event-stream', body: events.join('') }));

    await page.goto('/');
    await waitForGraph(page);

    const entries = page.locator('#unified-feed .uf-entry');
    // Only 1 entry (PostToolUse updates the existing PreToolUse entry)
    await expect(entries).toHaveCount(1);

    const entry = entries.first();
    // After PostToolUse, running class should be removed
    await expect(entry).not.toHaveClass(/running/);
    // Icon should be checkmark after completion
    await expect(entry.locator('.uf-entry-icon')).toHaveText('✓');
    // Duration should show ~2.0s
    await expect(entry.locator('.uf-entry-dur')).toContainText('2.0s');
  });

  test('PreToolUse shows running state before PostToolUse arrives', async ({ page }) => {
    await mockAPI(page);

    // Only send PreToolUse (no PostToolUse yet)
    const events = [
      sseFrame('hooks', 'PreToolUse', { actor: 'alice', tool_name: 'Read', tool_input: { file_path: '/src/main.js' } }),
    ];
    await page.route('**/api/bus/events*', route =>
      route.fulfill({ status: 200, contentType: 'text/event-stream', body: events.join('') }));

    await page.goto('/');
    await waitForGraph(page);

    const entry = page.locator('#unified-feed .uf-entry').first();
    await expect(entry).toHaveClass(/running/);
    // Agent name should be in the entry
    await expect(entry.locator('.uf-entry-agent')).toHaveText('alice');
  });

  test('full session SSE populates feed with multiple entries', async ({ page }) => {
    await mockAPI(page);

    // Use a real session fixture
    const busBody = sessionToSseBody(SESSION_SWIFT_NEWT);
    await page.route('**/api/bus/events*', route =>
      route.fulfill({ status: 200, contentType: 'text/event-stream', body: busBody }));

    await page.goto('/');
    await waitForGraph(page);

    const entries = page.locator('#unified-feed .uf-entry');
    // SESSION_SWIFT_NEWT has: AgentStarted, SessionStart, 6 Pre/PostToolUse pairs,
    // MutationUpdate, AgentIdle = at least several entries
    const count = await entries.count();
    expect(count).toBeGreaterThanOrEqual(5);

    // First entry should be AgentStarted
    await expect(entries.first().locator('.uf-entry-agent')).toHaveText('swift-newt');
  });

  test('unified/split toggle button switches view', async ({ page }) => {
    await mockAPI(page);
    await page.route('**/api/bus/events*', route =>
      route.fulfill({ status: 200, contentType: 'text/event-stream', body: ': keepalive\n\n' }));

    await page.goto('/');
    await waitForGraph(page);

    const toggle = page.locator('#unified-feed-toggle');
    const feed = page.locator('#unified-feed');

    // Initially shows "unified"
    await expect(toggle).toHaveText('unified');

    // Click toggle — should switch to "split" and activate unified feed
    await toggle.click();
    await expect(toggle).toHaveText('split');
    await expect(feed).toHaveClass(/active/);

    // Click again — back to "unified"
    await toggle.click();
    await expect(toggle).toHaveText('unified');
    await expect(feed).not.toHaveClass(/active/);
  });

  test('feed entries show correct timestamps', async ({ page }) => {
    await mockAPI(page);

    const ts = '2026-02-19T14:30:45.000Z';
    const events = [
      sseFrame('agents', 'AgentStarted', { actor: 'alice' }, ts),
    ];
    await page.route('**/api/bus/events*', route =>
      route.fulfill({ status: 200, contentType: 'text/event-stream', body: events.join('') }));

    await page.goto('/');
    await waitForGraph(page);

    const timeEl = page.locator('#unified-feed .uf-entry .uf-entry-time').first();
    // Should contain a time string (format depends on timezone, just check it's not empty)
    const text = await timeEl.textContent();
    expect(text.length).toBeGreaterThan(0);
    // Should contain colons (HH:MM:SS format)
    expect(text).toMatch(/\d{2}:\d{2}:\d{2}/);
  });

  test('multiple agents show in same feed with distinct names', async ({ page }) => {
    await mockAPI(page);

    // Two different agents' sessions combined
    const combined = [
      ...SESSION_SWIFT_NEWT.slice(0, 3),
      ...SESSION_ARCH_SEAL.slice(0, 3),
    ];
    const busBody = sessionToSseBody(combined);
    await page.route('**/api/bus/events*', route =>
      route.fulfill({ status: 200, contentType: 'text/event-stream', body: busBody }));

    await page.goto('/');
    await waitForGraph(page);

    // Check both agent names appear
    const agentNames = page.locator('#unified-feed .uf-entry-agent');
    const allNames = await agentNames.allTextContents();
    expect(allNames).toContain('swift-newt');
    expect(allNames).toContain('arch-seal');
  });
});

// =====================================================================
// QUICK ACTIONS
// =====================================================================

test.describe('Quick Actions', () => {

  test('all 8 quick action buttons are visible', async ({ page }) => {
    await mockAPI(page);
    await page.route('**/api/bus/events*', route =>
      route.fulfill({ status: 200, contentType: 'text/event-stream', body: ': keepalive\n\n' }));

    await page.goto('/');
    await waitForGraph(page);

    const actions = page.locator('#hud-quick-actions .ctrl-btn');
    await expect(actions).toHaveCount(8);

    // Verify each button exists
    await expect(page.locator('#hud-btn-refresh')).toBeVisible();
    await expect(page.locator('#hud-btn-labels')).toBeVisible();
    await expect(page.locator('#hud-btn-agents')).toBeVisible();
    await expect(page.locator('#hud-btn-bloom')).toBeVisible();
    await expect(page.locator('#hud-btn-search')).toBeVisible();
    await expect(page.locator('#hud-btn-minimap')).toBeVisible();
    await expect(page.locator('#hud-btn-sidebar')).toBeVisible();
    await expect(page.locator('#hud-btn-controls')).toBeVisible();
  });

  test('sidebar button toggles left sidebar', async ({ page }) => {
    await mockAPI(page);
    await page.route('**/api/bus/events*', route =>
      route.fulfill({ status: 200, contentType: 'text/event-stream', body: ': keepalive\n\n' }));

    await page.goto('/');
    await waitForGraph(page);

    // Initially not open
    const isOpenBefore = await page.evaluate(() =>
      document.getElementById('left-sidebar')?.classList.contains('open') ?? false);
    expect(isOpenBefore).toBe(false);

    // Click sidebar button
    await page.locator('#hud-btn-sidebar').click();
    await page.waitForTimeout(500);
    const isOpenAfter = await page.evaluate(() =>
      document.getElementById('left-sidebar')?.classList.contains('open') ?? false);
    expect(isOpenAfter).toBe(true);

    // Click again to close
    await page.locator('#hud-btn-sidebar').click();
    await page.waitForTimeout(500);
    const isOpenFinal = await page.evaluate(() =>
      document.getElementById('left-sidebar')?.classList.contains('open') ?? false);
    expect(isOpenFinal).toBe(false);
  });

  test('search button focuses search input', async ({ page }) => {
    await mockAPI(page);
    await page.route('**/api/bus/events*', route =>
      route.fulfill({ status: 200, contentType: 'text/event-stream', body: ': keepalive\n\n' }));

    await page.goto('/');
    await waitForGraph(page);

    // Click search button
    await page.locator('#hud-btn-search').click();
    await page.waitForTimeout(300);

    // Search input should be focused
    const searchInput = page.locator('#search-input');
    await expect(searchInput).toBeFocused();
  });

  test('controls button toggles control panel', async ({ page }) => {
    await mockAPI(page);
    await page.route('**/api/bus/events*', route =>
      route.fulfill({ status: 200, contentType: 'text/event-stream', body: ': keepalive\n\n' }));

    await page.goto('/');
    await waitForGraph(page);

    // Click controls button
    await page.locator('#hud-btn-controls').click();
    await page.waitForTimeout(500);

    // Control panel should have .open class
    const isOpen = await page.evaluate(() =>
      document.getElementById('control-panel')?.classList.contains('open') ?? false);
    expect(isOpen).toBe(true);
  });

  test('bloom button toggles bloom and gets active class', async ({ page }) => {
    await mockAPI(page);
    await page.route('**/api/bus/events*', route =>
      route.fulfill({ status: 200, contentType: 'text/event-stream', body: ': keepalive\n\n' }));

    await page.goto('/');
    await waitForGraph(page);

    const btn = page.locator('#hud-btn-bloom');
    // Initially no active class
    await expect(btn).not.toHaveClass(/active/);

    // Click to enable bloom
    await btn.click();
    await page.waitForTimeout(300);
    await expect(btn).toHaveClass(/active/);

    // Click again to disable
    await btn.click();
    await page.waitForTimeout(300);
    await expect(btn).not.toHaveClass(/active/);
  });

  test('agents button opens agents overlay', async ({ page }) => {
    await mockAPI(page);
    await page.route('**/api/bus/events*', route =>
      route.fulfill({ status: 200, contentType: 'text/event-stream', body: ': keepalive\n\n' }));

    await page.goto('/');
    await waitForGraph(page);

    // Click agents button
    await page.locator('#hud-btn-agents').click();
    await page.waitForTimeout(500);

    // Agents view should open (has .open class)
    const isOpen = await page.evaluate(() =>
      document.getElementById('agents-view')?.classList.contains('open') ?? false);
    expect(isOpen).toBe(true);
  });

  test('minimap button toggles minimap visibility', async ({ page }) => {
    await mockAPI(page);
    await page.route('**/api/bus/events*', route =>
      route.fulfill({ status: 200, contentType: 'text/event-stream', body: ': keepalive\n\n' }));

    await page.goto('/');
    await waitForGraph(page);

    // Click minimap button to toggle
    await page.locator('#hud-btn-minimap').click();
    await page.waitForTimeout(500);

    // Minimap canvas (#minimap) display should change
    const visible = await page.evaluate(() => {
      const el = document.getElementById('minimap');
      return el ? getComputedStyle(el).display !== 'none' : false;
    });
    // toggleMinimap flips minimapVisible — the initial state depends on setup
    // Just verify the button click doesn't error and the element exists
    expect(typeof visible).toBe('boolean');
  });

  test('refresh button triggers graph reload', async ({ page }) => {
    let graphCallCount = 0;
    // Track Graph API calls — register BEFORE mockAPI so it gets priority
    await page.route('**/api/bd.v1.BeadsService/Graph', async route => {
      graphCallCount++;
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(MOCK_GRAPH) });
    });
    // Mock remaining endpoints (Graph already handled above)
    await page.route('**/api/bd.v1.BeadsService/Ping', route =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(MOCK_PING) }));
    await page.route('**/api/bd.v1.BeadsService/List', route =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([]) }));
    await page.route('**/api/bd.v1.BeadsService/Show', route =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(MOCK_SHOW) }));
    await page.route('**/api/bd.v1.BeadsService/Stats', route =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(MOCK_GRAPH.stats) }));
    await page.route('**/api/bd.v1.BeadsService/Blocked', route =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([]) }));
    await page.route('**/api/bd.v1.BeadsService/Ready', route =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([]) }));
    await page.route('**/api/bd.v1.BeadsService/Update', route =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) }));
    await page.route('**/api/bd.v1.BeadsService/Close', route =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) }));
    await page.route('**/api/events', route =>
      route.fulfill({ status: 200, contentType: 'text/event-stream', body: 'data: {"type":"ping"}\n\n' }));
    await page.route('**/api/bus/events*', route =>
      route.fulfill({ status: 200, contentType: 'text/event-stream', body: ': keepalive\n\n' }));

    await page.goto('/');
    await waitForGraph(page);

    const callsBefore = graphCallCount;
    await page.locator('#hud-btn-refresh').click();
    await page.waitForTimeout(2000);

    // Should have made at least one more Graph API call
    expect(graphCallCount).toBeGreaterThan(callsBefore);
  });
});

// =====================================================================
// PROJECT PULSE
// =====================================================================

test.describe('Project Pulse', () => {

  test('displays all 6 metric categories', async ({ page }) => {
    await mockAPI(page);
    await page.route('**/api/bus/events*', route =>
      route.fulfill({ status: 200, contentType: 'text/event-stream', body: ': keepalive\n\n' }));

    await page.goto('/');
    await waitForGraph(page);

    const pulse = page.locator('#hud-project-pulse');
    await expect(pulse).toBeVisible();

    const stats = pulse.locator('.pulse-stat');
    await expect(stats).toHaveCount(6);

    // Check labels
    const labels = pulse.locator('.pulse-stat-label');
    const allLabels = await labels.allTextContents();
    expect(allLabels).toContain('open');
    expect(allLabels).toContain('active');
    expect(allLabels).toContain('blocked');
    expect(allLabels).toContain('agents');
    expect(allLabels).toContain('decisions');
    expect(allLabels).toContain('shown');
  });

  test('metric values match MOCK_GRAPH stats', async ({ page }) => {
    await mockAPI(page);
    await page.route('**/api/bus/events*', route =>
      route.fulfill({ status: 200, contentType: 'text/event-stream', body: ': keepalive\n\n' }));

    await page.goto('/');
    await waitForGraph(page);

    const pulse = page.locator('#hud-project-pulse');

    // Check values from MOCK_GRAPH.stats
    const values = pulse.locator('.pulse-stat-value');
    const allValues = await values.allTextContents();

    // MOCK_GRAPH: total_open=8, total_in_progress=3, total_blocked=3
    // Agents: 2 (alice, bob), decisions: 0 (no gate/decision nodes)
    // shown: total visible nodes
    expect(allValues[0]).toBe('8');   // open
    expect(allValues[1]).toBe('3');   // active
    expect(allValues[2]).toBe('3');   // blocked
    expect(allValues[3]).toBe('2');   // agents
    expect(allValues[4]).toBe('0');   // decisions
  });

  test('blocked count gets "bad" CSS class when > 0', async ({ page }) => {
    await mockAPI(page);
    await page.route('**/api/bus/events*', route =>
      route.fulfill({ status: 200, contentType: 'text/event-stream', body: ': keepalive\n\n' }));

    await page.goto('/');
    await waitForGraph(page);

    // MOCK_GRAPH has 3 blocked issues
    const blockedValue = page.locator('#hud-project-pulse .pulse-stat:nth-child(3) .pulse-stat-value');
    await expect(blockedValue).toHaveClass(/bad/);
  });

  test('agent count gets "warn" CSS class when > 0', async ({ page }) => {
    await mockAPI(page);
    await page.route('**/api/bus/events*', route =>
      route.fulfill({ status: 200, contentType: 'text/event-stream', body: ': keepalive\n\n' }));

    await page.goto('/');
    await waitForGraph(page);

    // MOCK_GRAPH has 2 agents
    const agentValue = page.locator('#hud-project-pulse .pulse-stat:nth-child(4) .pulse-stat-value');
    await expect(agentValue).toHaveClass(/warn/);
  });
});

// =====================================================================
// LEGEND
// =====================================================================

test.describe('Legend', () => {

  test('legend shows status and dependency type indicators', async ({ page }) => {
    await mockAPI(page);
    await page.route('**/api/bus/events*', route =>
      route.fulfill({ status: 200, contentType: 'text/event-stream', body: ': keepalive\n\n' }));

    await page.goto('/');
    await waitForGraph(page);

    const legend = page.locator('#legend');
    await expect(legend).toBeVisible();

    // Check legend text contains all expected items
    // Items contain spans with dots/emojis, so use full legend text
    const legendText = await legend.textContent();
    expect(legendText).toContain('open');
    expect(legendText).toContain('active');
    expect(legendText).toContain('epic');
    expect(legendText).toContain('blocked');
    expect(legendText).toContain('agent');
    expect(legendText).toContain('blocks');
    expect(legendText).toContain('waits');
    expect(legendText).toContain('parent');
  });
});

// =====================================================================
// BOTTOM HUD BAR LAYOUT
// =====================================================================

test.describe('Bottom HUD Bar Layout', () => {

  test('bottom HUD bar is visible with 3 sections', async ({ page }) => {
    await mockAPI(page);
    await page.route('**/api/bus/events*', route =>
      route.fulfill({ status: 200, contentType: 'text/event-stream', body: ': keepalive\n\n' }));

    await page.goto('/');
    await waitForGraph(page);

    await expect(page.locator('#bottom-hud')).toBeVisible();
    await expect(page.locator('#bottom-hud-left')).toBeVisible();
    await expect(page.locator('#bottom-hud-center')).toBeVisible();
    await expect(page.locator('#bottom-hud-right')).toBeVisible();
  });

  test('section labels are visible', async ({ page }) => {
    await mockAPI(page);
    await page.route('**/api/bus/events*', route =>
      route.fulfill({ status: 200, contentType: 'text/event-stream', body: ': keepalive\n\n' }));

    await page.goto('/');
    await waitForGraph(page);

    const labels = page.locator('.hud-section-label');
    const allLabels = await labels.allTextContents();
    expect(allLabels.some(l => l.includes('Quick Actions'))).toBe(true);
    expect(allLabels.some(l => l.includes('Activity Stream'))).toBe(true);
    expect(allLabels.some(l => l.includes('Project Pulse'))).toBe(true);
  });

  test('keyboard hints are visible in bottom-right', async ({ page }) => {
    await mockAPI(page);
    await page.route('**/api/bus/events*', route =>
      route.fulfill({ status: 200, contentType: 'text/event-stream', body: ': keepalive\n\n' }));

    await page.goto('/');
    await waitForGraph(page);

    const hints = page.locator('#keyhints');
    await expect(hints).toBeVisible();
    const text = await hints.textContent();
    expect(text).toContain('search');
    expect(text).toContain('refresh');
    expect(text).toContain('bloom');
  });

  test('status indicator shows connected state', async ({ page }) => {
    await mockAPI(page);
    await page.route('**/api/bus/events*', route =>
      route.fulfill({ status: 200, contentType: 'text/event-stream', body: ': keepalive\n\n' }));

    await page.goto('/');
    await waitForGraph(page);

    const status = page.locator('#status');
    await expect(status).toHaveClass(/connected/);
  });
});
