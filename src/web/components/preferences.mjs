export const prefs = {
  get(k, d) { try { const v = localStorage.getItem('hud.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('hud.' + k, JSON.stringify(v)); } catch {} },
};

export function createMotion(lifetime, root = document.documentElement) {
  const rmQuery = matchMedia('(prefers-reduced-motion: reduce)');
  const motion = {
    rm: rmQuery.matches, fx: prefs.get('effects', true), listeners: new Set(),
    get ambient() { return this.fx && !this.rm; },
    apply() { root.classList.toggle('rm', this.rm); root.classList.toggle('fx', this.ambient); for (const f of this.listeners) f(); },
    setFx(on) { this.fx = !!on; prefs.set('effects', this.fx); this.apply(); },
    setRm(on) { this.rm = !!on; this.apply(); },
    on(f) { this.listeners.add(f); return () => this.listeners.delete(f); },
  };
  lifetime.listen(rmQuery, 'change', e => motion.setRm(e.matches));
  lifetime.onClose(() => { motion.listeners.clear(); root.classList.remove('rm', 'fx'); });
  motion.apply();
  return motion;
}
