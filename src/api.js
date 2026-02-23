// Beads daemon HTTP API client
// Uses Vite proxy in dev (/api → daemon), direct URL in prod

/** @type {string} Default base URL for API requests */
const DEFAULT_BASE = '/api';

// SSE reconnection with exponential backoff (bd-ki6im)
/** @type {number} Initial delay in ms before first SSE reconnection attempt */
const SSE_INITIAL_DELAY = 1000;
/** @type {number} Maximum delay in ms between SSE reconnection attempts */
const SSE_MAX_DELAY = 30000;
/** @type {number} Maximum number of SSE reconnection attempts before giving up */
const SSE_MAX_RETRIES = 50;
/** @type {number} Multiplier applied to delay after each failed reconnection attempt */
const SSE_BACKOFF_FACTOR = 2;

/**
 * HTTP client for the beads daemon Connect-RPC API.
 * Provides methods for issue CRUD, graph queries, decision management,
 * config operations, and SSE event streaming with automatic reconnection.
 * @class
 */
export class BeadsAPI {
  /**
   * Create a new BeadsAPI client.
   * @param {string} [baseUrl='/api'] - Base URL for API requests (proxied in dev, direct in prod)
   */
  constructor(baseUrl = DEFAULT_BASE) {
    this.baseUrl = baseUrl;
    this._eventSources = []; // track SSE connections for cleanup (bd-7n4g8)
    this._reconnectManagers = []; // track reconnection managers (bd-ki6im)
  }

  /**
   * Make a Connect-RPC JSON call to the beads daemon.
   * @param {string} method - The RPC method name (e.g. 'List', 'Show')
   * @param {Object} [body={}] - The request body to send as JSON
   * @returns {Promise<Object>} The parsed JSON response
   * @throws {Error} If the HTTP response is not ok
   * @private
   */
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

  /**
   * Ping the daemon to check connectivity.
   * @returns {Promise<Object>} Empty response on success
   */
  async ping() {
    return this._rpc('Ping', {});
  }

  /**
   * Fetch the full graph for 3D visualization (bd-hpk9f).
   * Returns nodes, edges, and aggregate stats in a single call.
   * @param {Object} [opts={}] - Override default graph query parameters
   * @param {number} [opts.limit=500] - Maximum number of nodes to return
   * @param {boolean} [opts.include_deps=true] - Include dependency edges
   * @param {boolean} [opts.include_agents=true] - Include agent nodes
   * @returns {Promise<{nodes: Object[], edges: Object[], stats: Object}>} Graph data
   */
  async graph(opts = {}) {
    return this._rpc('Graph', {
      limit: 500,
      include_deps: true,
      include_agents: true,
      ...opts,
    });
  }

  /**
   * List issues with optional filtering.
   * @param {Object} [opts={}] - Override default list query parameters
   * @param {number} [opts.limit=500] - Maximum number of issues to return
   * @param {string[]} [opts.exclude_status=['tombstone']] - Statuses to exclude
   * @returns {Promise<Object>} List response with issues array
   */
  async list(opts = {}) {
    return this._rpc('List', {
      limit: 500,
      exclude_status: ['tombstone'],
      ...opts,
    });
  }

  /**
   * Fetch full details for a single issue.
   * @param {string} id - The issue ID (e.g. 'bd-abc12')
   * @returns {Promise<Object>} The issue object with all fields
   */
  async show(id) {
    return this._rpc('Show', { id });
  }

  /**
   * Fetch aggregate statistics for the issue store.
   * @returns {Promise<Object>} Stats object with counts by status, type, etc.
   */
  async stats() {
    return this._rpc('Stats', {});
  }

  /**
   * Fetch issues that are ready to work on (unblocked, open).
   * @returns {Promise<Object>} Response with ready issues array
   */
  async ready() {
    return this._rpc('Ready', { limit: 200 });
  }

  /**
   * Fetch issues that are currently blocked by dependencies.
   * @returns {Promise<Object>} Response with blocked issues array
   */
  async blocked() {
    return this._rpc('Blocked', {});
  }

  /**
   * Fetch the dependency tree rooted at a given issue.
   * @param {string} id - The root issue ID
   * @param {number} [maxDepth=5] - Maximum depth to traverse
   * @returns {Promise<Object>} Tree structure with nested dependencies
   */
  async depTree(id, maxDepth = 5) {
    return this._rpc('DepTree', { id, max_depth: maxDepth });
  }

  /**
   * Fetch an overview of all epics with progress summaries.
   * @returns {Promise<Object>} Epic overview with child counts and status breakdowns
   */
  async epicOverview() {
    return this._rpc('EpicOverview', {});
  }

  // --- Write operations (bd-9g7f0) ---

  /**
   * Update fields on an existing issue.
   * @param {string} id - The issue ID to update
   * @param {Object} fields - Key-value pairs of fields to update
   * @returns {Promise<Object>} The updated issue object
   */
  async update(id, fields) {
    return this._rpc('Update', { id, ...fields });
  }

  /**
   * Close an issue by ID.
   * @param {string} id - The issue ID to close
   * @returns {Promise<Object>} The closed issue object
   */
  async close(id) {
    return this._rpc('Close', { id });
  }

  /**
   * Check if the Graph endpoint is available on this daemon.
   * Probes once and caches the result for subsequent calls.
   * @returns {Promise<boolean>} True if Graph RPC is supported
   */
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

  /**
   * Create an SSE EventSource with automatic exponential-backoff reconnection (bd-ki6im).
   * @param {string} url - The SSE endpoint URL
   * @param {string} label - Human-readable label for logging (e.g. 'mutation', 'bus')
   * @param {Function} setupFn - Called with each new EventSource to attach event listeners
   * @param {Object} [callbacks={}] - Lifecycle callbacks
   * @param {Function} [callbacks.onStatus] - Called with (state, info) where state is 'connecting'|'connected'|'reconnecting'|'disconnected'
   * @returns {Object} Reconnection manager with connect(), stop(), and retry() methods
   * @private
   */
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

  /**
   * Connect to the mutation SSE event stream for live issue updates (bd-ki6im).
   * Automatically reconnects with exponential backoff on disconnection.
   * @param {Function} onEvent - Callback invoked with each parsed event object
   * @param {Object} [callbacks={}] - SSE lifecycle callbacks
   * @param {Function} [callbacks.onStatus] - Called with (state, info) for connection state changes
   * @returns {Object} Reconnection manager with connect(), stop(), and retry() methods
   */
  connectEvents(onEvent, callbacks = {}) {
    const url = `${this.baseUrl}/events`;
    return this._connectWithReconnect(
      url,
      'mutation',
      (es) => {
        es.onmessage = (e) => {
          try {
            const data = JSON.parse(e.data);
            onEvent(data);
          } catch {
            /* skip malformed */
          }
        };
      },
      callbacks,
    );
  }

  /**
   * Connect to the NATS bus SSE event stream for agent, hook, and job events (bd-c7723, bd-ki6im).
   * Listens to multiple named event types (agents, hooks, oj, mutations, decisions, mail).
   * @param {string} streams - Comma-separated stream names (e.g. 'agents,hooks,oj') or 'all'
   * @param {Function} onEvent - Callback invoked with each parsed event object
   * @param {Object} [callbacks={}] - SSE lifecycle callbacks
   * @param {Function} [callbacks.onStatus] - Called with (state, info) for connection state changes
   * @returns {Object} Reconnection manager with connect(), stop(), and retry() methods
   */
  connectBusEvents(streams, onEvent, callbacks = {}) {
    const url = `${this.baseUrl}/bus/events?stream=${encodeURIComponent(streams)}`;
    const eventTypes = ['agents', 'hooks', 'oj', 'mutations', 'decisions', 'mail'];
    return this._connectWithReconnect(
      url,
      'bus',
      (es) => {
        for (const type of eventTypes) {
          es.addEventListener(type, (e) => {
            try {
              onEvent(JSON.parse(e.data));
            } catch {
              /* skip */
            }
          });
        }
      },
      callbacks,
    );
  }

  // --- Decision operations (bd-g0tmq) ---

  /**
   * Fetch a decision by its associated issue ID.
   * @param {string} issueId - The issue ID of the decision (e.g. 'bd-abc12')
   * @returns {Promise<Object>} The decision object
   */
  async decisionGet(issueId) {
    return this._rpc('DecisionGet', { issue_id: issueId });
  }

  /**
   * List decisions with optional filtering.
   * @param {Object} [opts={}] - Query parameters for filtering
   * @returns {Promise<Object>} Response with decisions array
   */
  async decisionList(opts = {}) {
    return this._rpc('DecisionList', opts);
  }

  /**
   * List decisions created since a given timestamp, optionally filtered by requester.
   * @param {string} since - ISO 8601 timestamp to filter from
   * @param {string} [requestedBy] - Filter to decisions requested by this agent
   * @returns {Promise<Object>} Response with recent decisions array
   */
  async decisionListRecent(since, requestedBy) {
    const args = { since };
    if (requestedBy) args.requested_by = requestedBy;
    return this._rpc('DecisionListRecent', args);
  }

  /**
   * Resolve a pending decision by selecting an option.
   * @param {string} issueId - The issue ID of the decision
   * @param {string} selectedOption - The chosen option key
   * @param {string} responseText - Free-text response or rationale
   * @param {string} [respondedBy='beads3d'] - Identity of the responder
   * @returns {Promise<Object>} The resolved decision object
   */
  async decisionResolve(issueId, selectedOption, responseText, respondedBy = 'beads3d') {
    return this._rpc('DecisionResolve', {
      issue_id: issueId,
      selected_option: selectedOption,
      response_text: responseText,
      responded_by: respondedBy,
    });
  }

  /**
   * Cancel a pending decision with a reason.
   * @param {string} issueId - The issue ID of the decision
   * @param {string} reason - Reason for cancellation
   * @param {string} [canceledBy='beads3d'] - Identity of the canceler
   * @returns {Promise<Object>} The canceled decision object
   */
  async decisionCancel(issueId, reason, canceledBy = 'beads3d') {
    return this._rpc('DecisionCancel', {
      issue_id: issueId,
      reason,
      canceled_by: canceledBy,
    });
  }

  /**
   * Send a reminder notification for a pending decision.
   * @param {string} issueId - The issue ID of the decision
   * @param {boolean} [force=false] - Send even if recently reminded
   * @returns {Promise<Object>} Reminder response
   */
  async decisionRemind(issueId, force = false) {
    return this._rpc('DecisionRemind', { issue_id: issueId, force });
  }

  /**
   * Send mail to an agent by creating a message-type issue (bd-t76aw).
   * @param {string} toAgent - The target agent name (assigned as assignee)
   * @param {string} subject - The message subject (becomes the issue title)
   * @param {string} [body=''] - The message body (becomes the issue description)
   * @returns {Promise<Object>} The created message issue object
   */
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

  /**
   * List all configuration keys and values.
   * @returns {Promise<Object>} Response with config entries
   */
  async configList() {
    return this._rpc('ConfigList', {});
  }

  /**
   * Get a single configuration value by key.
   * @param {string} key - The config key to retrieve
   * @returns {Promise<Object>} Response with the config value
   */
  async configGet(key) {
    return this._rpc('GetConfig', { key });
  }

  /**
   * Set a configuration key to a value.
   * @param {string} key - The config key to set
   * @param {string} value - The value to assign
   * @returns {Promise<Object>} Confirmation response
   */
  async configSet(key, value) {
    return this._rpc('ConfigSet', { key, value });
  }

  /**
   * Remove a configuration key.
   * @param {string} key - The config key to remove
   * @returns {Promise<Object>} Confirmation response
   */
  async configUnset(key) {
    return this._rpc('ConfigUnset', { key });
  }

  /**
   * Close all SSE connections and stop all reconnection managers (bd-7n4g8, bd-ki6im).
   * Call this when the API client is no longer needed to prevent resource leaks.
   * @returns {void}
   */
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

  /**
   * Manually reconnect all SSE streams by resetting and restarting each manager (bd-ki6im).
   * Used by the retry button in the UI when connection is lost.
   * @returns {void}
   */
  reconnectAll() {
    for (const mgr of this._reconnectManagers) {
      mgr.retry();
    }
  }
}
