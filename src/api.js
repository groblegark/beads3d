// Beads daemon HTTP API client
// Uses Vite proxy in dev (/api → daemon), direct URL in prod

const DEFAULT_BASE = '/api';

export class BeadsAPI {
  constructor(baseUrl = DEFAULT_BASE) {
    this.baseUrl = baseUrl;
    this._eventSources = []; // track SSE connections for cleanup (bd-7n4g8)
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
      include_agents: true,
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

  // --- Write operations (bd-9g7f0) ---

  async update(id, fields) {
    return this._rpc('Update', { id, ...fields });
  }

  async close(id) {
    return this._rpc('Close', { id });
  }

  // Check if Graph endpoint is available (probe once, cache result)
  async hasGraph() {
    if (this._hasGraphCached !== undefined) return this._hasGraphCached;
    try {
      await this._rpc('Graph', { limit: 1 });
      this._hasGraphCached = true;
      return true;
    } catch {
      this._hasGraphCached = false;
      return false;
    }
  }

  // SSE event stream for live updates (mutation events)
  connectEvents(onEvent) {
    const url = `${this.baseUrl}/events`;
    const es = new EventSource(url);

    es.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data);
        onEvent(data);
      } catch { /* skip malformed */ }
    };

    es.onopen = () => console.log('[beads3d] mutation SSE connected');
    es.onerror = () => {
      if (es.readyState === EventSource.CLOSED) console.warn('[beads3d] mutation SSE closed:', url);
    };

    this._eventSources.push(es);
    return es;
  }

  // SSE bus event stream — all NATS event streams (bd-c7723)
  // streams: comma-separated stream names (e.g., "agents,hooks,oj") or "all"
  connectBusEvents(streams, onEvent) {
    const url = `${this.baseUrl}/bus/events?stream=${encodeURIComponent(streams)}`;
    const es = new EventSource(url);

    es.addEventListener('agents', (e) => {
      try { onEvent(JSON.parse(e.data)); } catch { /* skip */ }
    });
    es.addEventListener('hooks', (e) => {
      try { onEvent(JSON.parse(e.data)); } catch { /* skip */ }
    });
    es.addEventListener('oj', (e) => {
      try { onEvent(JSON.parse(e.data)); } catch { /* skip */ }
    });
    es.addEventListener('mutations', (e) => {
      try { onEvent(JSON.parse(e.data)); } catch { /* skip */ }
    });
    es.addEventListener('decisions', (e) => {
      try { onEvent(JSON.parse(e.data)); } catch { /* skip */ }
    });
    es.addEventListener('mail', (e) => {
      try { onEvent(JSON.parse(e.data)); } catch { /* skip */ }
    });

    es.onopen = () => console.log('[beads3d] bus SSE connected:', streams);
    es.onerror = () => {
      if (es.readyState === EventSource.CLOSED) console.warn('[beads3d] bus SSE closed:', url);
    };

    this._eventSources.push(es);
    return es;
  }

  // --- Decision operations (bd-g0tmq) ---

  async decisionGet(issueId) {
    return this._rpc('DecisionGet', { issue_id: issueId });
  }

  async decisionList(opts = {}) {
    return this._rpc('DecisionList', opts);
  }

  async decisionListRecent(since, requestedBy) {
    const args = { since };
    if (requestedBy) args.requested_by = requestedBy;
    return this._rpc('DecisionListRecent', args);
  }

  async decisionResolve(issueId, selectedOption, responseText, respondedBy = 'beads3d') {
    return this._rpc('DecisionResolve', {
      issue_id: issueId,
      selected_option: selectedOption,
      response_text: responseText,
      responded_by: respondedBy,
    });
  }

  async decisionCancel(issueId, reason, canceledBy = 'beads3d') {
    return this._rpc('DecisionCancel', {
      issue_id: issueId,
      reason,
      canceled_by: canceledBy,
    });
  }

  async decisionRemind(issueId, force = false) {
    return this._rpc('DecisionRemind', { issue_id: issueId, force });
  }

  // Send mail to an agent (bd-t76aw): creates a message issue targeting the agent
  async sendMail(toAgent, subject, body = '') {
    return this._rpc('Create', {
      title: subject,
      description: body,
      issue_type: 'message',
      assignee: toAgent,
      sender: 'beads3d',
      priority: 2,
    });
  }

  // --- Config operations (bd-8o2gd phase 3) ---

  async configList() {
    return this._rpc('ConfigList', {});
  }

  async configGet(key) {
    return this._rpc('GetConfig', { key });
  }

  async configSet(key, value) {
    return this._rpc('ConfigSet', { key, value });
  }

  async configUnset(key) {
    return this._rpc('ConfigUnset', { key });
  }

  // Close all SSE connections (bd-7n4g8)
  destroy() {
    for (const es of this._eventSources) {
      es.close();
    }
    this._eventSources.length = 0;
  }
}
