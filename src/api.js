// Beads daemon HTTP API client
// Uses Vite proxy in dev (/api → daemon), direct URL in prod

const DEFAULT_BASE = '/api';

// SSE reconnection with exponential backoff (bd-ki6im)
const SSE_INITIAL_DELAY = 1000;
const SSE_MAX_DELAY = 30000;
const SSE_MAX_RETRIES = 50;
const SSE_BACKOFF_FACTOR = 2;

export class BeadsAPI {
  constructor(baseUrl = DEFAULT_BASE) {
    this.baseUrl = baseUrl;
    this._eventSources = []; // track SSE connections for cleanup (bd-7n4g8)
    this._reconnectManagers = []; // track reconnection managers (bd-ki6im)
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

  // SSE reconnection manager (bd-ki6im)
  // Creates an EventSource with automatic reconnection on error/close.
  // callbacks: { onStatus(state, info) } where state is 'connecting'|'connected'|'reconnecting'|'disconnected'
  // setupFn(es): called to attach event listeners to a new EventSource
  _connectWithReconnect(url, label, setupFn, callbacks = {}) {
    const mgr = {
      url,
      label,
      _es: null,
      _retries: 0,
      _delay: SSE_INITIAL_DELAY,
      _timer: null,
      _stopped: false,

      connect: () => {
        if (mgr._stopped) return;

        const isReconnect = mgr._retries > 0;
        if (isReconnect) {
          console.log(`[beads3d] ${label} SSE reconnecting (attempt ${mgr._retries}/${SSE_MAX_RETRIES})...`);
          callbacks.onStatus?.('reconnecting', { attempt: mgr._retries, maxRetries: SSE_MAX_RETRIES });
        } else {
          callbacks.onStatus?.('connecting', {});
        }

        const es = new EventSource(url);
        mgr._es = es;

        es.onopen = () => {
          console.log(`[beads3d] ${label} SSE connected`);
          mgr._retries = 0;
          mgr._delay = SSE_INITIAL_DELAY;
          callbacks.onStatus?.('connected', {});
        };

        es.onerror = () => {
          if (mgr._stopped) return;
          // EventSource auto-reconnects for CONNECTING state, but not for CLOSED
          if (es.readyState === EventSource.CLOSED) {
            console.warn(`[beads3d] ${label} SSE closed, scheduling reconnect`);
            es.close();
            mgr._scheduleReconnect();
          }
          // For CONNECTING state: EventSource handles it natively, but if it
          // keeps failing, readyState will eventually become CLOSED
        };

        setupFn(es);

        // Track for cleanup
        const idx = this._eventSources.indexOf(mgr._prevEs);
        if (idx >= 0) this._eventSources.splice(idx, 1);
        mgr._prevEs = es;
        this._eventSources.push(es);
      },

      _scheduleReconnect: () => {
        if (mgr._stopped) return;
        mgr._retries++;
        if (mgr._retries > SSE_MAX_RETRIES) {
          console.error(`[beads3d] ${label} SSE gave up after ${SSE_MAX_RETRIES} retries`);
          callbacks.onStatus?.('disconnected', {});
          return;
        }
        const jitter = Math.random() * 0.3 * mgr._delay;
        const wait = mgr._delay + jitter;
        console.log(`[beads3d] ${label} SSE reconnect in ${Math.round(wait)}ms`);
        mgr._timer = setTimeout(() => {
          mgr.connect();
        }, wait);
        mgr._delay = Math.min(mgr._delay * SSE_BACKOFF_FACTOR, SSE_MAX_DELAY);
      },

      stop: () => {
        mgr._stopped = true;
        clearTimeout(mgr._timer);
        if (mgr._es) mgr._es.close();
      },

      // Manual reconnect (for retry button)
      retry: () => {
        mgr._stopped = false;
        mgr._retries = 0;
        mgr._delay = SSE_INITIAL_DELAY;
        clearTimeout(mgr._timer);
        if (mgr._es) mgr._es.close();
        mgr.connect();
      },
    };

    this._reconnectManagers.push(mgr);
    mgr.connect();
    return mgr;
  }

  // SSE event stream for live updates with reconnection (bd-ki6im)
  connectEvents(onEvent, callbacks = {}) {
    const url = `${this.baseUrl}/events`;
    return this._connectWithReconnect(url, 'mutation', (es) => {
      es.onmessage = (e) => {
        try {
          const data = JSON.parse(e.data);
          onEvent(data);
        } catch { /* skip malformed */ }
      };
    }, callbacks);
  }

  // SSE bus event stream with reconnection — all NATS event streams (bd-c7723, bd-ki6im)
  // streams: comma-separated stream names (e.g., "agents,hooks,oj") or "all"
  connectBusEvents(streams, onEvent, callbacks = {}) {
    const url = `${this.baseUrl}/bus/events?stream=${encodeURIComponent(streams)}`;
    const eventTypes = ['agents', 'hooks', 'oj', 'mutations', 'decisions', 'mail'];
    return this._connectWithReconnect(url, 'bus', (es) => {
      for (const type of eventTypes) {
        es.addEventListener(type, (e) => {
          try { onEvent(JSON.parse(e.data)); } catch { /* skip */ }
        });
      }
    }, callbacks);
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

  // Close all SSE connections and stop reconnection (bd-7n4g8, bd-ki6im)
  destroy() {
    for (const mgr of this._reconnectManagers) {
      mgr.stop();
    }
    this._reconnectManagers.length = 0;
    for (const es of this._eventSources) {
      es.close();
    }
    this._eventSources.length = 0;
  }

  // Manual reconnect all SSE streams (bd-ki6im, for retry button)
  reconnectAll() {
    for (const mgr of this._reconnectManagers) {
      mgr.retry();
    }
  }
}
