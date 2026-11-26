// Angles are degrees clockwise from the top.
export function arcD(cx, cy, r, a0, a1) {
  const P = a => { const t = (a - 90) * Math.PI / 180; return [cx + r * Math.cos(t), cy + r * Math.sin(t)]; };
  const [x0, y0] = P(a0), [x1, y1] = P(a1);
  return `M${x0.toFixed(2)} ${y0.toFixed(2)}A${r} ${r} 0 ${a1 - a0 > 180 ? 1 : 0} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
}
export function ellArc(cx, cy, rx, ry, a0, a1, ccw) {
  const P = a => { const t = (a - 90) * Math.PI / 180; return [cx + rx * Math.cos(t), cy + ry * Math.sin(t)]; };
  const [x0, y0] = P(a0), [x1, y1] = P(a1);
  return `M${x0.toFixed(1)} ${y0.toFixed(1)}A${rx.toFixed(1)} ${ry.toFixed(1)} 0 ${Math.abs(a1 - a0) > 180 ? 1 : 0} ${ccw ? 0 : 1} ${x1.toFixed(1)} ${y1.toFixed(1)}`;
}
export function placeFlow(f, p, q) {
  const dx = q.x - p.x, dy = q.y - p.y;
  f.style.width = Math.hypot(dx, dy).toFixed(1) + 'px';
  f.style.transform = `translate(${p.x.toFixed(1)}px, ${p.y.toFixed(1)}px) rotate(${Math.atan2(dy, dx).toFixed(4)}rad)`;
}
export const hexPts = R => [-90, -30, 30, 90, 150, 210].map(a => { const t = a * Math.PI / 180; return (R * Math.cos(t)).toFixed(2) + ',' + (R * Math.sin(t)).toFixed(2); }).join(' ');
