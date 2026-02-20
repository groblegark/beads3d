// Interaction tests for beads3d editing features (bd-ibxu4).
// Tests context menu editing, keyboard shortcuts, and status feedback.
// Uses mocked API with request tracking to verify write operations.
//
// Run: npx playwright test tests/interactions.spec.js
// View report: npx playwright show-report test-results/html-report

import { test, expect } from '@playwright/test';
import { MOCK_GRAPH, MOCK_PING, MOCK_SHOW } from './fixtures.js';

// Track API calls for assertions
function createAPITracker() {
  const calls = [];
  return {
    calls,
    getCallsTo(method) {
      return calls.filter(c => c.method === method);
    },
    lastCallTo(method) {
      const matching = this.getCallsTo(method);
      return matching[matching.length - 1] || null;
    },
  };
}

// Mock API with request tracking
async function mockAPI(page, tracker) {
  const handle = async (method, response) => {
    await page.route(`**/api/bd.v1.BeadsService/${method}`, async route => {
      const body = route.request().postDataJSON();
      tracker.calls.push({ method, body, time: Date.now() });
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(response),
      });
    });
  };

  await handle('Ping', MOCK_PING);
  await handle('Graph', MOCK_GRAPH);
  await handle('List', []);
  await handle('Show', MOCK_SHOW);
  await handle('Stats', MOCK_GRAPH.stats);
  await handle('Blocked', []);
  await handle('Ready', []);
  await handle('Update', { ok: true });
  await handle('Close', { ok: true });

  await page.route('**/api/events', async route => {
    await route.fulfill({
      status: 200,
      contentType: 'text/event-stream',
      body: 'data: {"type":"ping"}\n\n',
    });
  });
}

// Wait for graph to render and have node data
async function waitForGraph(page) {
  await page.waitForSelector('#status.connected', { timeout: 15000 });
  await page.waitForTimeout(3000);
  // Poll until graph data is populated (avoids flaky timing issues)
  await page.waitForFunction(() => {
    const b = window.__beads3d;
    return b && b.graph && b.graph.graphData().nodes.length > 0;
  }, { timeout: 10000 });
}

// Trigger a right-click on a node via the graph API (reliable with WebGL canvas).
// Uses the same pattern as visual.spec.js — calls the onNodeRightClick handler directly.
async function rightClickNode(page, nodeId) {
  return page.evaluate((id) => {
    const b = window.__beads3d;
    if (!b || !b.graph) return false;
    const node = b.graph.graphData().nodes.find(n => n.id === id);
    if (!node) return false;
    b.graph.onNodeRightClick()(node, {
      preventDefault: () => {},
      clientX: 400,
      clientY: 300,
    });
    return true;
  }, nodeId);
}

test.describe('context menu editing', () => {

  test('right-click shows edit menu with status and priority submenus', async ({ page }) => {
    const tracker = createAPITracker();
    await mockAPI(page, tracker);
    await page.goto('/');
    await waitForGraph(page);

    // Right-click node via graph API (reliable with WebGL)
    const clicked = await rightClickNode(page, 'bd-task1');
    expect(clicked).toBe(true);
    await page.waitForTimeout(500);

    // Context menu should be visible
    const menu = page.locator('#context-menu');
    await expect(menu).toBeVisible();

    // Should contain status and priority submenus
    await expect(menu.locator('.ctx-submenu:has-text("status")')).toBeVisible();
    await expect(menu.locator('.ctx-submenu:has-text("priority")')).toBeVisible();
    await expect(menu.locator('[data-action="claim"]')).toBeVisible();
    await expect(menu.locator('[data-action="close-bead"]')).toBeVisible();

    // Should also have the original actions
    await expect(menu.locator('[data-action="expand-deps"]')).toBeVisible();
    await expect(menu.locator('[data-action="copy-id"]')).toBeVisible();
  });

  test('right-click on agent node does NOT show context menu', async ({ page }) => {
    const tracker = createAPITracker();
    await mockAPI(page, tracker);
    await page.goto('/');
    await waitForGraph(page);

    // Right-click agent node via graph API
    const clicked = await rightClickNode(page, 'agent:alice');
    if (!clicked) {
      test.skip(); // Agent node not in graph data
      return;
    }
    await page.waitForTimeout(500);

    // Context menu should NOT be visible for agent nodes
    const menu = page.locator('#context-menu');
    await expect(menu).not.toBeVisible();
  });

  test('status submenu sends Update API call', async ({ page }) => {
    const tracker = createAPITracker();
    await mockAPI(page, tracker);
    await page.goto('/');
    await waitForGraph(page);

    // Right-click → open context menu
    const clicked = await rightClickNode(page, 'bd-task1');
    expect(clicked).toBe(true);
    await page.waitForTimeout(500);

    // Hover over "status" to open submenu
    await page.locator('#context-menu .ctx-submenu:has-text("status")').hover();
    await page.waitForTimeout(200);

    // Click "in progress" in the submenu
    await page.locator('.ctx-sub-item:has-text("in progress")').click();
    await page.waitForTimeout(500);

    // Verify Update API was called with correct args
    const updateCalls = tracker.getCallsTo('Update');
    expect(updateCalls.length).toBeGreaterThanOrEqual(1);
    const lastUpdate = updateCalls[updateCalls.length - 1];
    expect(lastUpdate.body.id).toBe('bd-task1');
    expect(lastUpdate.body.status).toBe('in_progress');

    // Verify a refresh was triggered (Graph re-fetched)
    const graphCalls = tracker.getCallsTo('Graph');
    expect(graphCalls.length).toBeGreaterThan(1); // initial + refresh
  });

  test('priority submenu sends Update API call', async ({ page }) => {
    const tracker = createAPITracker();
    await mockAPI(page, tracker);
    await page.goto('/');
    await waitForGraph(page);

    const clicked = await rightClickNode(page, 'bd-task1');
    expect(clicked).toBe(true);
    await page.waitForTimeout(500);

    // Hover over "priority" to open submenu
    await page.locator('#context-menu .ctx-submenu:has-text("priority")').hover();
    await page.waitForTimeout(200);

    // Click "P0 critical"
    await page.locator('.ctx-sub-item:has-text("P0 critical")').click();
    await page.waitForTimeout(500);

    const updateCalls = tracker.getCallsTo('Update');
    expect(updateCalls.length).toBeGreaterThanOrEqual(1);
    const lastUpdate = updateCalls[updateCalls.length - 1];
    expect(lastUpdate.body.id).toBe('bd-task1');
    expect(lastUpdate.body.priority).toBe(0);
  });

  test('close action sends Close API call', async ({ page }) => {
    const tracker = createAPITracker();
    await mockAPI(page, tracker);
    await page.goto('/');
    await waitForGraph(page);

    const clicked = await rightClickNode(page, 'bd-task1');
    expect(clicked).toBe(true);
    await page.waitForTimeout(500);

    await page.locator('#context-menu [data-action="close-bead"]').click();
    await page.waitForTimeout(500);

    const closeCalls = tracker.getCallsTo('Close');
    expect(closeCalls.length).toBe(1);
    expect(closeCalls[0].body.id).toBe('bd-task1');
  });

  test('claim action sends Update with in_progress status', async ({ page }) => {
    const tracker = createAPITracker();
    await mockAPI(page, tracker);
    await page.goto('/');
    await waitForGraph(page);

    const clicked = await rightClickNode(page, 'bd-task1');
    expect(clicked).toBe(true);
    await page.waitForTimeout(500);

    await page.locator('#context-menu [data-action="claim"]').click();
    await page.waitForTimeout(500);

    const updateCalls = tracker.getCallsTo('Update');
    expect(updateCalls.length).toBeGreaterThanOrEqual(1);
    const lastUpdate = updateCalls[updateCalls.length - 1];
    expect(lastUpdate.body.id).toBe('bd-task1');
    expect(lastUpdate.body.status).toBe('in_progress');
  });

  test('status toast appears after successful action', async ({ page }) => {
    const tracker = createAPITracker();
    await mockAPI(page, tracker);
    await page.goto('/');
    await waitForGraph(page);

    const clicked = await rightClickNode(page, 'bd-task1');
    expect(clicked).toBe(true);
    await page.waitForTimeout(500);

    await page.locator('#context-menu [data-action="close-bead"]').click();

    // Status bar should briefly show the toast message
    const status = page.locator('#status');
    await expect(status).toContainText('bd-task1', { timeout: 1000 });
  });
});

test.describe('keyboard shortcuts', () => {

  test('/ focuses search input', async ({ page }) => {
    const tracker = createAPITracker();
    await mockAPI(page, tracker);
    await page.goto('/');
    await waitForGraph(page);

    await page.keyboard.press('/');
    const searchInput = page.locator('#search-input');
    await expect(searchInput).toBeFocused();
  });

  test('Escape clears search and closes panels', async ({ page }) => {
    const tracker = createAPITracker();
    await mockAPI(page, tracker);
    await page.goto('/');
    await waitForGraph(page);

    // Type in search
    await page.keyboard.press('/');
    await page.keyboard.type('epic');
    await page.waitForTimeout(200);

    // Press Escape
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);

    const searchInput = page.locator('#search-input');
    await expect(searchInput).toHaveValue('');
  });

  test('r triggers refresh (Graph API re-fetched)', async ({ page }) => {
    const tracker = createAPITracker();
    await mockAPI(page, tracker);
    await page.goto('/');
    await waitForGraph(page);

    const initialGraphCalls = tracker.getCallsTo('Graph').length;
    await page.keyboard.press('r');
    await page.waitForTimeout(1000);

    expect(tracker.getCallsTo('Graph').length).toBeGreaterThan(initialGraphCalls);
  });
});

// --- Bulk mutation tests (bd-d8189) ---
// Programmatically set multiSelected and trigger bulk menu,
// then verify API calls and local graph state changes.

// Helper: click a bulk menu action item directly via DOM
// CSS :hover submenus are fragile in Playwright, so we reveal + click via evaluate
async function clickBulkAction(page, action, value) {
  await page.evaluate(({ action, value }) => {
    // Hide all submenu panels first to avoid overlap/interception
    document.querySelectorAll('#bulk-menu .bulk-submenu-panel').forEach(p => p.style.display = 'none');
    // Find the target item and reveal only its parent submenu panel
    const selector = value !== undefined
      ? `#bulk-menu [data-action="${action}"][data-value="${value}"]`
      : `#bulk-menu [data-action="${action}"]`;
    const item = document.querySelector(selector);
    if (item) {
      const panel = item.closest('.bulk-submenu-panel');
      if (panel) panel.style.display = 'block';
      item.click();
    }
  }, { action, value });
  await page.waitForTimeout(300);
}

// Helper: programmatically multi-select nodes and open the bulk menu
async function setupBulkSelection(page, nodeIds) {
  await page.evaluate(({ ids }) => {
    const b = window.__beads3d;
    if (!b) return;
    const sel = b.multiSelected();
    sel.clear();
    for (const id of ids) sel.add(id);
    b.showBulkMenu(400, 300);
  }, { ids: nodeIds });
  await page.waitForTimeout(300);
}

test.describe('bulk menu mutations', () => {

  test('bulk set-status sends Update for each selected node', async ({ page }) => {
    const tracker = createAPITracker();
    await mockAPI(page, tracker);
    await page.goto('/');
    await waitForGraph(page);

    const targetIds = ['bd-task1', 'bd-task2', 'bd-feat2'];
    await setupBulkSelection(page, targetIds);

    // Verify bulk menu is visible
    const bulkMenu = page.locator('#bulk-menu');
    await expect(bulkMenu).toBeVisible();
    await expect(bulkMenu).toContainText('3 beads selected');

    // Hover "set status" to open submenu, then click "in progress"
    await clickBulkAction(page, 'bulk-status', 'in_progress');
    await page.waitForTimeout(500);

    // Verify Update was called for each selected node
    const updateCalls = tracker.getCallsTo('Update');
    expect(updateCalls.length).toBe(3);
    const updatedIds = updateCalls.map(c => c.body.id).sort();
    expect(updatedIds).toEqual(targetIds.sort());
    for (const call of updateCalls) {
      expect(call.body.status).toBe('in_progress');
    }
  });

  test('bulk set-status optimistically updates local node state', async ({ page }) => {
    const tracker = createAPITracker();
    await mockAPI(page, tracker);
    await page.goto('/');
    await waitForGraph(page);

    const targetIds = ['bd-task1', 'bd-task5'];
    await setupBulkSelection(page, targetIds);

    // Click bulk set-status → closed
    await clickBulkAction(page, 'bulk-status', 'closed');
    await page.waitForTimeout(300);

    // Verify local graph state updated optimistically
    const statuses = await page.evaluate((ids) => {
      const b = window.__beads3d;
      if (!b) return null;
      const nodes = b.graphData().nodes;
      return ids.map(id => {
        const n = nodes.find(n => n.id === id);
        return n ? n.status : null;
      });
    }, targetIds);
    expect(statuses).toEqual(['closed', 'closed']);
  });

  test('bulk set-priority sends Update with correct priority values', async ({ page }) => {
    const tracker = createAPITracker();
    await mockAPI(page, tracker);
    await page.goto('/');
    await waitForGraph(page);

    const targetIds = ['bd-bug1', 'bd-feat3'];
    await setupBulkSelection(page, targetIds);

    // Hover "set priority" and click "P0 critical"
    await clickBulkAction(page, 'bulk-priority', '0');
    await page.waitForTimeout(500);

    const updateCalls = tracker.getCallsTo('Update');
    expect(updateCalls.length).toBe(2);
    for (const call of updateCalls) {
      expect(call.body.priority).toBe(0);
    }
    const updatedIds = updateCalls.map(c => c.body.id).sort();
    expect(updatedIds).toEqual(targetIds.sort());
  });

  test('bulk set-priority optimistically updates local node state', async ({ page }) => {
    const tracker = createAPITracker();
    await mockAPI(page, tracker);
    await page.goto('/');
    await waitForGraph(page);

    const targetIds = ['bd-task1', 'bd-bug1'];
    await setupBulkSelection(page, targetIds);

    // Force all submenu panels visible and directly trigger the bulk action
    // (CSS hover-based submenus are fragile in Playwright)
    await clickBulkAction(page, 'bulk-priority', '4');
    await page.waitForTimeout(500);

    const priorities = await page.evaluate((ids) => {
      const b = window.__beads3d;
      if (!b) return null;
      const nodes = b.graphData().nodes;
      return ids.map(id => {
        const n = nodes.find(n => n.id === id);
        return n ? n.priority : null;
      });
    }, targetIds);
    expect(priorities).toEqual([4, 4]);
  });

  test('bulk close-all sends Close for each selected node', async ({ page }) => {
    const tracker = createAPITracker();
    await mockAPI(page, tracker);
    await page.goto('/');
    await waitForGraph(page);

    const targetIds = ['bd-task2', 'bd-task5', 'bd-feat3'];
    await setupBulkSelection(page, targetIds);

    // Click "close all"
    await page.locator('#bulk-menu .bulk-item[data-action="bulk-close"]').click();
    await page.waitForTimeout(500);

    const closeCalls = tracker.getCallsTo('Close');
    expect(closeCalls.length).toBe(3);
    const closedIds = closeCalls.map(c => c.body.id).sort();
    expect(closedIds).toEqual(targetIds.sort());
  });

  test('bulk close-all optimistically sets nodes to closed status', async ({ page }) => {
    const tracker = createAPITracker();
    await mockAPI(page, tracker);
    await page.goto('/');
    await waitForGraph(page);

    const targetIds = ['bd-task1', 'bd-bug1'];
    await setupBulkSelection(page, targetIds);

    await page.locator('#bulk-menu .bulk-item[data-action="bulk-close"]').click();
    await page.waitForTimeout(300);

    const statuses = await page.evaluate((ids) => {
      const b = window.__beads3d;
      if (!b) return null;
      const nodes = b.graphData().nodes;
      return ids.map(id => {
        const n = nodes.find(n => n.id === id);
        return n ? n.status : null;
      });
    }, targetIds);
    expect(statuses).toEqual(['closed', 'closed']);
  });

  test('bulk clear-selection dismisses menu without API calls', async ({ page }) => {
    const tracker = createAPITracker();
    await mockAPI(page, tracker);
    await page.goto('/');
    await waitForGraph(page);

    const targetIds = ['bd-task1', 'bd-task2'];
    await setupBulkSelection(page, targetIds);

    const updatesBefore = tracker.getCallsTo('Update').length;
    const closesBefore = tracker.getCallsTo('Close').length;

    await page.locator('#bulk-menu .bulk-item[data-action="bulk-clear"]').click();
    await page.waitForTimeout(300);

    // No new API calls
    expect(tracker.getCallsTo('Update').length).toBe(updatesBefore);
    expect(tracker.getCallsTo('Close').length).toBe(closesBefore);

    // Menu should be hidden
    await expect(page.locator('#bulk-menu')).not.toBeVisible();

    // Selection should be cleared
    const selCount = await page.evaluate(() => {
      const b = window.__beads3d;
      return b ? b.multiSelected().size : -1;
    });
    expect(selCount).toBe(0);
  });

  test('bulk status toast shows operation summary', async ({ page }) => {
    const tracker = createAPITracker();
    await mockAPI(page, tracker);
    await page.goto('/');
    await waitForGraph(page);

    const targetIds = ['bd-task1', 'bd-task2'];
    await setupBulkSelection(page, targetIds);

    await page.locator('#bulk-menu .bulk-item[data-action="bulk-close"]').click();

    // Status bar should show the toast
    const status = page.locator('#status');
    await expect(status).toContainText('closed 2', { timeout: 2000 });
  });

  test('bulk operation rolls back on API failure', async ({ page }) => {
    const tracker = createAPITracker();

    // Set up mock API but with Update returning 500 errors
    const handle = async (method, response) => {
      await page.route(`**/api/bd.v1.BeadsService/${method}`, async route => {
        const body = route.request().postDataJSON();
        tracker.calls.push({ method, body, time: Date.now() });
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(response),
        });
      });
    };

    await handle('Ping', MOCK_PING);
    await handle('Graph', MOCK_GRAPH);
    await handle('List', []);
    await handle('Show', MOCK_SHOW);
    await handle('Stats', MOCK_GRAPH.stats);
    await handle('Blocked', []);
    await handle('Ready', []);
    await handle('Close', { ok: true });

    // Update returns 500 to test rollback
    await page.route('**/api/bd.v1.BeadsService/Update', async route => {
      tracker.calls.push({ method: 'Update', body: route.request().postDataJSON(), time: Date.now() });
      await route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"server error"}' });
    });

    await page.route('**/api/events', async route => {
      await route.fulfill({ status: 200, contentType: 'text/event-stream', body: 'data: {"type":"ping"}\n\n' });
    });

    await page.goto('/');
    await waitForGraph(page);

    // Record original statuses
    const originalStatuses = await page.evaluate((ids) => {
      const b = window.__beads3d;
      if (!b) return null;
      return ids.map(id => {
        const n = b.graphData().nodes.find(n => n.id === id);
        return n ? n.status : null;
      });
    }, ['bd-task1', 'bd-task2']);

    const targetIds = ['bd-task1', 'bd-task2'];
    await setupBulkSelection(page, targetIds);

    await clickBulkAction(page, 'bulk-status', 'in_progress');
    await page.waitForTimeout(1500);

    // Statuses should be rolled back to originals
    const rolledBackStatuses = await page.evaluate((ids) => {
      const b = window.__beads3d;
      if (!b) return null;
      return ids.map(id => {
        const n = b.graphData().nodes.find(n => n.id === id);
        return n ? n.status : null;
      });
    }, ['bd-task1', 'bd-task2']);
    expect(rolledBackStatuses).toEqual(originalStatuses);

    // Verify Update API was actually called (confirming the action fired)
    const updateCalls = tracker.getCallsTo('Update');
    expect(updateCalls.length).toBe(2);
  });
});
