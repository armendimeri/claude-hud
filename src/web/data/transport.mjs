export function createBrowserTransport() {
  return {
    connect({ open, error, frame }) {
      const source = new EventSource('/api/stream');
      source.addEventListener('open', open);
      source.addEventListener('error', () => error(source.readyState === EventSource.CLOSED));
      for (const type of ['state', 'plans', 'event']) {
        source.addEventListener(type, event => frame(type, event.data));
      }
      return () => source.close();
    },
    async fetchSnapshot({ signal } = {}) {
      const response = await fetch('/api/state', { cache: 'no-store', signal });
      if (!response.ok) throw new Error('HUD snapshot request failed: ' + response.status);
      return response.json();
    },
  };
}
