/**
 * Stable identity of a session or one of its subagents: the JSON array [sessionId, agentId].
 * The cockpit scene (cockpit/projection.mjs) and the inspector (inspector/state.mjs) use the same string, so a row
 * can be found again after the DOM is rebuilt. Compare whole keys; never split them.
 */
export const entityKey = (sessionId, agentId = null) => JSON.stringify([sessionId, agentId ?? null]);

/** Find the element carrying a key, in any view. */
export function findEntityElement(key, scope = document) {
  for (const el of scope.querySelectorAll('[data-entity-key]')) if (el.dataset.entityKey === key) return el;
  return null;
}
