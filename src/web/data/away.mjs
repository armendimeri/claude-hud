const AWAY_MS = 5 * 60_000;

export function createAwayRefresh({ transport, isHidden, onSummary, clock = Date }) {
  const lifetime = new AbortController();
  let hiddenAt = isHidden() ? clock.now() : null;
  let pendingSince = null, summarizedAt = 0, fetching = false;

  async function refresh() {
    if (lifetime.signal.aborted || isHidden() || pendingSince === null || fetching) return;
    fetching = true;
    try {
      const state = await transport.fetchSnapshot({ signal: lifetime.signal });
      if (lifetime.signal.aborted || isHidden() || !Number.isFinite(state?.now) || !Array.isArray(state.feed)) return;
      const receivedAt = clock.now();
      // Feed timestamps use the server clock. Translate the start of the absence at receipt.
      onSummary(state.feed, state.now - (receivedAt - pendingSince));
      pendingSince = null;
      summarizedAt = receivedAt;
    } catch {
      // Retry a pending summary on the next visibility return or stream open.
    } finally {
      fetching = false;
    }
  }

  function resumed(since) {
    if (since !== null) {
      const start = Math.max(since, summarizedAt);
      if (clock.now() - start >= AWAY_MS) pendingSince = Math.min(pendingSince ?? start, start);
    }
    return refresh();
  }

  return {
    resumed,
    visibilityChanged() {
      if (isHidden()) {
        hiddenAt ??= clock.now();
        return;
      }
      const since = hiddenAt;
      hiddenAt = null;
      return resumed(since);
    },
    close: () => lifetime.abort(),
  };
}
