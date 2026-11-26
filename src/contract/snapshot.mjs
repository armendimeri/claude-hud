/**
 * A published snapshot. Times are epoch milliseconds except for the uptime duration.
 * The provider and board DTOs retain their existing JSON shapes. Demo snapshots omit codex.
 * @typedef {object} HudSnapshot
 * @property {number} now
 * @property {number} uptime
 * @property {false | true | 'dense'} demo
 * @property {string} version
 * @property {string} host
 * @property {boolean} hooksInstalled
 * @property {object[]} sessions
 * @property {object[]} projects
 * @property {object[]} plans
 * @property {object} board
 * @property {object[]} alerts
 * @property {FeedLine[]} feed
 * @property {object | null} account
 * @property {object} totals
 * @property {object[]} external
 * @property {string | null} externalError
 * @property {{ enabled: boolean, lastError: string | null }} push
 * @property {{ readable: boolean, error: string | null, directories: string[] }} [codex]
 */

/**
 * @typedef {object} FeedLine
 * @property {number} at
 * @property {string | null} sessionId
 * @property {string | null} project
 * @property {string} kind
 * @property {string} text
 * @property {string} [action]
 */

/** @typedef {{ snapshot: HudSnapshot, lines: FeedLine[] }} HudUpdate */

/**
 * @typedef {object} HudSource
 * @property {() => HudSnapshot} readSnapshot
 * @property {(listener: (update: HudUpdate) => void) => () => void} subscribeUpdates
 * @property {() => Promise<void>} close
 */

/** @param {HudSnapshot} snapshot */
export function withClock(snapshot, now) {
  return { ...snapshot, now, uptime: Math.max(0, snapshot.uptime + now - snapshot.now) };
}

/** @param {HudSnapshot} snapshot */
export function streamState({ plans, feed, now, uptime, ...state }) {
  return state;
}
