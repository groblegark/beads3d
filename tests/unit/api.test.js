import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { BeadsAPI } from '../../src/api.js';

// Mock fetch globally
const mockFetch = vi.fn();
globalThis.fetch = mockFetch;

// Mock EventSource
class MockEventSource {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 2;
  constructor(url) {
    this.url = url;
    this.readyState = MockEventSource.OPEN;
    this._listeners = {};
    // Auto-fire onopen
    setTimeout(() => { if (this.onopen) this.onopen(); }, 0);
  }
  addEventListener(type, fn) {
    this._listeners[type] = this._listeners[type] || [];
    this._listeners[type].push(fn);
  }
  close() { this.readyState = MockEventSource.CLOSED; }
}
globalThis.EventSource = MockEventSource;

function jsonResponse(data, status = 200) {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(data),
    text: () => Promise.resolve(JSON.stringify(data)),
  });
}

function errorResponse(status, body = 'error') {
  return Promise.resolve({
    ok: false,
    status,
    text: () => Promise.resolve(body),
  });
}

describe('BeadsAPI', () => {
  let api;

  beforeEach(() => {
    mockFetch.mockReset();
    api = new BeadsAPI('/api');
  });

  afterEach(() => {
    api.destroy();
  });

  describe('constructor', () => {
    it('sets default base URL', () => {
      const defaultApi = new BeadsAPI();
      expect(defaultApi.baseUrl).toBe('/api');
      defaultApi.destroy();
    });

    it('accepts custom base URL', () => {
      expect(api.baseUrl).toBe('/api');
    });
  });

  describe('_rpc', () => {
    it('sends POST with correct headers and body', async () => {
      mockFetch.mockReturnValueOnce(jsonResponse({ ok: true }));
      await api._rpc('TestMethod', { key: 'value' });

      expect(mockFetch).toHaveBeenCalledWith(
        '/api/bd.v1.BeadsService/TestMethod',
        expect.objectContaining({
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Connect-Protocol-Version': '1',
          },
          body: JSON.stringify({ key: 'value' }),
        }),
      );
    });

    it('throws on non-ok response', async () => {
      mockFetch.mockReturnValueOnce(errorResponse(500, 'internal error'));
      await expect(api._rpc('Fail')).rejects.toThrow('RPC Fail: 500');
    });

    it('returns parsed JSON on success', async () => {
      mockFetch.mockReturnValueOnce(jsonResponse({ nodes: [1, 2, 3] }));
      const result = await api._rpc('Test');
      expect(result).toEqual({ nodes: [1, 2, 3] });
    });
  });

  describe('RPC methods', () => {
    it('ping sends empty body', async () => {
      mockFetch.mockReturnValueOnce(jsonResponse({ status: 'ok' }));
      const result = await api.ping();
      expect(result).toEqual({ status: 'ok' });
      expect(mockFetch).toHaveBeenCalledWith(
        '/api/bd.v1.BeadsService/Ping',
        expect.anything(),
      );
    });

    it('graph sends default opts', async () => {
      mockFetch.mockReturnValueOnce(jsonResponse({ nodes: [], edges: [] }));
      await api.graph();
      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.limit).toBe(500);
      expect(body.include_deps).toBe(true);
      expect(body.include_agents).toBe(true);
    });

    it('graph allows overriding opts', async () => {
      mockFetch.mockReturnValueOnce(jsonResponse({ nodes: [] }));
      await api.graph({ limit: 100, include_agents: false });
      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.limit).toBe(100);
      expect(body.include_agents).toBe(false);
    });

    it('list sends default opts', async () => {
      mockFetch.mockReturnValueOnce(jsonResponse({ issues: [] }));
      await api.list();
      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.limit).toBe(500);
      expect(body.exclude_status).toEqual(['tombstone']);
    });

    it('show sends id', async () => {
      mockFetch.mockReturnValueOnce(jsonResponse({ id: 'bd-123' }));
      await api.show('bd-123');
      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.id).toBe('bd-123');
    });

    it('update sends id and fields', async () => {
      mockFetch.mockReturnValueOnce(jsonResponse({}));
      await api.update('bd-123', { status: 'closed', title: 'Done' });
      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.id).toBe('bd-123');
      expect(body.status).toBe('closed');
      expect(body.title).toBe('Done');
    });

    it('depTree sends id and max_depth', async () => {
      mockFetch.mockReturnValueOnce(jsonResponse({ tree: {} }));
      await api.depTree('bd-123', 3);
      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.id).toBe('bd-123');
      expect(body.max_depth).toBe(3);
    });

    it('stats sends empty body', async () => {
      mockFetch.mockReturnValueOnce(jsonResponse({ total: 42 }));
      const result = await api.stats();
      expect(result).toEqual({ total: 42 });
      expect(mockFetch).toHaveBeenCalledWith(
        '/api/bd.v1.BeadsService/Stats',
        expect.anything(),
      );
    });

    it('ready sends limit 200', async () => {
      mockFetch.mockReturnValueOnce(jsonResponse({ issues: [] }));
      await api.ready();
      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.limit).toBe(200);
    });

    it('blocked sends empty body', async () => {
      mockFetch.mockReturnValueOnce(jsonResponse({ issues: [] }));
      await api.blocked();
      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body).toEqual({});
    });

    it('epicOverview sends empty body', async () => {
      mockFetch.mockReturnValueOnce(jsonResponse({ epics: [] }));
      const result = await api.epicOverview();
      expect(result).toEqual({ epics: [] });
      expect(mockFetch).toHaveBeenCalledWith(
        '/api/bd.v1.BeadsService/EpicOverview',
        expect.anything(),
      );
    });

    it('close sends id', async () => {
      mockFetch.mockReturnValueOnce(jsonResponse({ ok: true }));
      await api.close('bd-456');
      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.id).toBe('bd-456');
    });

    it('depTree uses default max_depth of 5', async () => {
      mockFetch.mockReturnValueOnce(jsonResponse({ tree: {} }));
      await api.depTree('bd-789');
      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.max_depth).toBe(5);
    });
  });

  describe('hasGraph', () => {
    it('returns true when Graph endpoint succeeds', async () => {
      mockFetch.mockReturnValueOnce(jsonResponse({ nodes: [] }));
      const result = await api.hasGraph();
      expect(result).toBe(true);
    });

    it('returns false when Graph endpoint fails', async () => {
      mockFetch.mockReturnValueOnce(errorResponse(404));
      const result = await api.hasGraph();
      expect(result).toBe(false);
    });

    it('caches the result', async () => {
      mockFetch.mockReturnValueOnce(jsonResponse({ nodes: [] }));
      await api.hasGraph();
      await api.hasGraph();
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });
  });

  describe('decision operations', () => {
    it('decisionGet sends issue_id', async () => {
      mockFetch.mockReturnValueOnce(jsonResponse({ decision: {} }));
      await api.decisionGet('bd-gate');
      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.issue_id).toBe('bd-gate');
    });

    it('decisionList sends opts', async () => {
      mockFetch.mockReturnValueOnce(jsonResponse({ decisions: [] }));
      await api.decisionList({ status: 'pending' });
      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.status).toBe('pending');
    });

    it('decisionList sends empty body by default', async () => {
      mockFetch.mockReturnValueOnce(jsonResponse({ decisions: [] }));
      await api.decisionList();
      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body).toEqual({});
    });

    it('decisionListRecent sends since and requested_by', async () => {
      mockFetch.mockReturnValueOnce(jsonResponse({ decisions: [] }));
      await api.decisionListRecent('2026-02-20T00:00:00Z', 'agent-1');
      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.since).toBe('2026-02-20T00:00:00Z');
      expect(body.requested_by).toBe('agent-1');
    });

    it('decisionListRecent omits requested_by when not provided', async () => {
      mockFetch.mockReturnValueOnce(jsonResponse({ decisions: [] }));
      await api.decisionListRecent('2026-02-20T00:00:00Z');
      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.since).toBe('2026-02-20T00:00:00Z');
      expect(body.requested_by).toBeUndefined();
    });

    it('decisionResolve sends all fields', async () => {
      mockFetch.mockReturnValueOnce(jsonResponse({}));
      await api.decisionResolve('bd-gate', 'opt-a', 'reason text', 'human');
      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.issue_id).toBe('bd-gate');
      expect(body.selected_option).toBe('opt-a');
      expect(body.response_text).toBe('reason text');
      expect(body.responded_by).toBe('human');
    });

    it('decisionResolve defaults responded_by to beads3d', async () => {
      mockFetch.mockReturnValueOnce(jsonResponse({}));
      await api.decisionResolve('bd-gate', 'opt-a', '');
      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.responded_by).toBe('beads3d');
    });

    it('decisionCancel sends reason', async () => {
      mockFetch.mockReturnValueOnce(jsonResponse({}));
      await api.decisionCancel('bd-gate', 'no longer needed');
      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.issue_id).toBe('bd-gate');
      expect(body.reason).toBe('no longer needed');
      expect(body.canceled_by).toBe('beads3d');
    });

    it('decisionCancel defaults canceled_by to beads3d', async () => {
      mockFetch.mockReturnValueOnce(jsonResponse({}));
      await api.decisionCancel('bd-gate', 'stale');
      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.canceled_by).toBe('beads3d');
    });

    it('decisionRemind sends issue_id and force', async () => {
      mockFetch.mockReturnValueOnce(jsonResponse({}));
      await api.decisionRemind('bd-gate', true);
      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.issue_id).toBe('bd-gate');
      expect(body.force).toBe(true);
    });

    it('decisionRemind defaults force to false', async () => {
      mockFetch.mockReturnValueOnce(jsonResponse({}));
      await api.decisionRemind('bd-gate');
      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.force).toBe(false);
    });
  });

  describe('sendMail', () => {
    it('creates a message issue', async () => {
      mockFetch.mockReturnValueOnce(jsonResponse({ id: 'msg-1' }));
      await api.sendMail('agent:toolbox', 'Hello', 'Body text');
      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.title).toBe('Hello');
      expect(body.description).toBe('Body text');
      expect(body.issue_type).toBe('message');
      expect(body.assignee).toBe('agent:toolbox');
      expect(body.sender).toBe('beads3d');
    });
  });

  describe('config operations', () => {
    it('configGet sends key', async () => {
      mockFetch.mockReturnValueOnce(jsonResponse({ value: '42' }));
      await api.configGet('theme');
      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.key).toBe('theme');
    });

    it('configSet sends key and value', async () => {
      mockFetch.mockReturnValueOnce(jsonResponse({}));
      await api.configSet('theme', 'dark');
      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.key).toBe('theme');
      expect(body.value).toBe('dark');
    });

    it('configList sends empty body', async () => {
      mockFetch.mockReturnValueOnce(jsonResponse({ configs: [] }));
      const result = await api.configList();
      expect(result).toEqual({ configs: [] });
      expect(mockFetch).toHaveBeenCalledWith(
        '/api/bd.v1.BeadsService/ConfigList',
        expect.anything(),
      );
    });

    it('configUnset sends key', async () => {
      mockFetch.mockReturnValueOnce(jsonResponse({}));
      await api.configUnset('theme');
      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.key).toBe('theme');
    });
  });

  describe('SSE connections', () => {
    it('connectEvents creates EventSource with correct URL', () => {
      const mgr = api.connectEvents(() => {});
      expect(mgr._es.url).toBe('/api/events');
    });

    it('connectBusEvents encodes stream param', () => {
      const mgr = api.connectBusEvents('agents,hooks', () => {});
      expect(mgr._es.url).toBe('/api/bus/events?stream=agents%2Chooks');
    });

    it('connectBusEvents registers listeners for all event types', () => {
      const mgr = api.connectBusEvents('all', () => {});
      const es = mgr._es;
      const types = ['agents', 'hooks', 'oj', 'mutations', 'decisions', 'mail'];
      for (const type of types) {
        expect(es._listeners[type]).toBeDefined();
        expect(es._listeners[type].length).toBe(1);
      }
    });

    it('connectEvents onmessage parses JSON and calls handler', async () => {
      const events = [];
      const mgr = api.connectEvents((data) => events.push(data));
      // Simulate a message event
      mgr._es.onmessage({ data: '{"type":"status","id":"bd-1"}' });
      expect(events).toEqual([{ type: 'status', id: 'bd-1' }]);
    });

    it('connectEvents onmessage skips malformed JSON', () => {
      const events = [];
      const mgr = api.connectEvents((data) => events.push(data));
      mgr._es.onmessage({ data: '{not json}' });
      expect(events).toHaveLength(0);
    });

    it('connectBusEvents listener parses JSON and calls handler', () => {
      const events = [];
      const mgr = api.connectBusEvents('agents', (data) => events.push(data));
      const es = mgr._es;
      // Fire an 'agents' event
      for (const fn of es._listeners['agents']) {
        fn({ data: '{"actor":"wise-fish","event":"heartbeat"}' });
      }
      expect(events).toEqual([{ actor: 'wise-fish', event: 'heartbeat' }]);
    });

    it('connectBusEvents listener skips malformed JSON', () => {
      const events = [];
      const mgr = api.connectBusEvents('agents', (data) => events.push(data));
      const es = mgr._es;
      for (const fn of es._listeners['agents']) {
        fn({ data: 'bad json' });
      }
      expect(events).toHaveLength(0);
    });

    it('destroy closes all connections', () => {
      const mgr1 = api.connectEvents(() => {});
      const mgr2 = api.connectBusEvents('agents', () => {});
      api.destroy();
      expect(mgr1._stopped).toBe(true);
      expect(mgr2._stopped).toBe(true);
    });

    it('destroy with no connections does not throw', () => {
      expect(() => api.destroy()).not.toThrow();
    });

    it('destroy clears manager and eventSource arrays', () => {
      api.connectEvents(() => {});
      api.connectBusEvents('agents', () => {});
      api.destroy();
      expect(api._reconnectManagers).toHaveLength(0);
      expect(api._eventSources).toHaveLength(0);
    });

    it('reconnectAll retries all managers', () => {
      const mgr = api.connectEvents(() => {});
      mgr._stopped = true;
      api.reconnectAll();
      expect(mgr._stopped).toBe(false);
    });
  });

  describe('SSE reconnection logic', () => {
    it('calls onStatus connecting on first connect', () => {
      const statuses = [];
      api.connectEvents(() => {}, { onStatus: (s) => statuses.push(s) });
      expect(statuses).toContain('connecting');
    });

    it('calls onStatus connected when EventSource opens', async () => {
      const statuses = [];
      api.connectEvents(() => {}, { onStatus: (s) => statuses.push(s) });
      // MockEventSource fires onopen asynchronously via setTimeout
      await vi.waitFor(() => expect(statuses).toContain('connected'));
    });

    it('stop clears timer and sets stopped flag', () => {
      const mgr = api.connectEvents(() => {});
      mgr.stop();
      expect(mgr._stopped).toBe(true);
      expect(mgr._es.readyState).toBe(MockEventSource.CLOSED);
    });

    it('retry resets retries and delay', () => {
      const mgr = api.connectEvents(() => {});
      // Simulate some retries happened
      mgr._retries = 10;
      mgr._delay = 16000;
      mgr._stopped = true;
      mgr.retry();
      expect(mgr._stopped).toBe(false);
      expect(mgr._retries).toBe(0);
      expect(mgr._delay).toBe(1000);
    });

    it('scheduleReconnect increments retries and increases delay', () => {
      vi.useFakeTimers();
      const mgr = api.connectEvents(() => {});
      expect(mgr._retries).toBe(0);
      expect(mgr._delay).toBe(1000);

      // Manually trigger reconnect schedule
      mgr._scheduleReconnect();
      expect(mgr._retries).toBe(1);
      // Delay should double (with jitter, hard to check exact value)
      expect(mgr._delay).toBe(2000);

      mgr._scheduleReconnect();
      expect(mgr._retries).toBe(2);
      expect(mgr._delay).toBe(4000);

      vi.useRealTimers();
    });

    it('scheduleReconnect caps delay at SSE_MAX_DELAY (30s)', () => {
      vi.useFakeTimers();
      const mgr = api.connectEvents(() => {});
      // Set delay close to max
      mgr._delay = 16000;
      mgr._scheduleReconnect();
      // 16000 * 2 = 32000, capped to 30000
      expect(mgr._delay).toBe(30000);

      mgr._scheduleReconnect();
      // Still capped
      expect(mgr._delay).toBe(30000);
      vi.useRealTimers();
    });

    it('gives up after max retries and calls onStatus disconnected', () => {
      vi.useFakeTimers();
      const statuses = [];
      const mgr = api.connectEvents(() => {}, {
        onStatus: (s) => statuses.push(s),
      });
      // Set retries to max
      mgr._retries = 50;
      mgr._scheduleReconnect();
      // Should not schedule another attempt
      expect(mgr._retries).toBe(51);
      expect(statuses).toContain('disconnected');
      vi.useRealTimers();
    });

    it('does not reconnect when stopped', () => {
      vi.useFakeTimers();
      const mgr = api.connectEvents(() => {});
      mgr._stopped = true;
      const retriesBefore = mgr._retries;
      mgr._scheduleReconnect();
      // Should bail out immediately
      expect(mgr._retries).toBe(retriesBefore);
      vi.useRealTimers();
    });

    it('onerror with CLOSED readyState schedules reconnect', () => {
      vi.useFakeTimers();
      const statuses = [];
      const mgr = api.connectEvents(() => {}, {
        onStatus: (s, info) => statuses.push({ s, ...info }),
      });
      const es = mgr._es;
      // Simulate EventSource closing
      es.readyState = MockEventSource.CLOSED;
      es.onerror();
      expect(mgr._retries).toBe(1);
      vi.useRealTimers();
    });

    it('onerror does nothing when stopped', () => {
      const mgr = api.connectEvents(() => {});
      mgr._stopped = true;
      const es = mgr._es;
      es.readyState = MockEventSource.CLOSED;
      const retriesBefore = mgr._retries;
      es.onerror();
      expect(mgr._retries).toBe(retriesBefore);
    });

    it('onopen resets retries and delay', async () => {
      const mgr = api.connectEvents(() => {});
      mgr._retries = 5;
      mgr._delay = 8000;
      // MockEventSource fires onopen async
      await vi.waitFor(() => {
        expect(mgr._retries).toBe(0);
        expect(mgr._delay).toBe(1000);
      });
    });
  });

  describe('_rpc edge cases', () => {
    it('includes truncated error text in exception message', async () => {
      const longError = 'x'.repeat(200);
      mockFetch.mockReturnValueOnce(errorResponse(502, longError));
      await expect(api._rpc('Fail')).rejects.toThrow('RPC Fail: 502 ' + 'x'.repeat(100));
    });

    it('handles fetch throwing (network error)', async () => {
      mockFetch.mockRejectedValueOnce(new TypeError('fetch failed'));
      await expect(api._rpc('Fail')).rejects.toThrow('fetch failed');
    });

    it('handles resp.text() failing during error', async () => {
      mockFetch.mockReturnValueOnce(Promise.resolve({
        ok: false,
        status: 500,
        text: () => Promise.reject(new Error('body read fail')),
      }));
      await expect(api._rpc('Fail')).rejects.toThrow('RPC Fail: 500');
    });
  });

  describe('hasGraph caching', () => {
    it('caches false result on error', async () => {
      mockFetch.mockReturnValueOnce(errorResponse(500));
      const r1 = await api.hasGraph();
      expect(r1).toBe(false);
      // Second call should not make a fetch
      const r2 = await api.hasGraph();
      expect(r2).toBe(false);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });
  });
});
