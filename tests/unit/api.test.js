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

    it('destroy closes all connections', () => {
      const mgr1 = api.connectEvents(() => {});
      const mgr2 = api.connectBusEvents('agents', () => {});
      api.destroy();
      expect(mgr1._stopped).toBe(true);
      expect(mgr2._stopped).toBe(true);
    });

    it('reconnectAll retries all managers', () => {
      const mgr = api.connectEvents(() => {});
      mgr._stopped = true;
      api.reconnectAll();
      expect(mgr._stopped).toBe(false);
    });
  });
});
