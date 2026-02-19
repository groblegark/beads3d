// Beads daemon HTTP API client
// Uses Vite proxy in dev (/api → daemon), direct URL in prod

const DEFAULT_BASE = '/api';

export class BeadsAPI {
  constructor(baseUrl = DEFAULT_BASE) {
    this.baseUrl = baseUrl;
  }

  async _rpc(method, body = {}) {
    const headers = {
      'Content-Type': 'application/json',
      'Connect-Protocol-Version': '1',
    };

    const resp = await fetch(`${this.baseUrl}/bd.v1.BeadsService/${method}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new Error(`RPC ${method}: ${resp.status} ${text.slice(0, 100)}`);
    }

    return resp.json();
  }

  async ping() {
    return this._rpc('Ping', {});
  }

  // Graph API — single endpoint for visualization data (bd-hpk9f)
  // Returns { nodes: [...], edges: [...], stats: {...} }
  async graph(opts = {}) {
    return this._rpc('Graph', {
      limit: 500,
      include_deps: true,
      ...opts,
    });
  }

  async list(opts = {}) {
    return this._rpc('List', {
      limit: 500,
      exclude_status: ['tombstone'],
      ...opts,
    });
  }

  async show(id) {
    return this._rpc('Show', { id });
  }

  async stats() {
    return this._rpc('Stats', {});
  }

  async ready() {
    return this._rpc('Ready', { limit: 200 });
  }

  async blocked() {
    return this._rpc('Blocked', {});
  }

  async depTree(id, maxDepth = 5) {
    return this._rpc('DepTree', { id, max_depth: maxDepth });
  }

  async epicOverview() {
    return this._rpc('EpicOverview', {});
  }

  // Check if Graph endpoint is available (probe with empty body)
  async hasGraph() {
    try {
      await this._rpc('Graph', { limit: 1 });
      return true;
    } catch {
      return false;
    }
  }

  // SSE event stream for live updates
  connectEvents(onEvent) {
    const url = `${this.baseUrl}/events`;
    const es = new EventSource(url);

    es.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data);
        onEvent(data);
      } catch { /* skip malformed */ }
    };

    es.onerror = () => {
      // EventSource auto-reconnects
    };

    return es;
  }
}
