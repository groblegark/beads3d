// Beads daemon HTTP API client
// Uses Vite proxy in dev (/api → daemon), direct URL in prod

// In dev: use /api proxy (handles CORS + auth via vite.config.js)
// In prod or with URL param override: use direct URL
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
    return this._rpc('Ready', { limit: 100 });
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
