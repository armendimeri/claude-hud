/** Own the browser resources that can outlive the DOM of a mounted component. */
export function createLifetime() {
  const controller = new AbortController();
  const disposers = new Set();
  const timers = new Set();
  const intervals = new Set();
  const frames = new Set();
  const animations = new Set();

  function listen(target, type, handler, options) {
    target.addEventListener(type, handler, { ...options, signal: controller.signal });
  }
  function onClose(dispose) {
    disposers.add(dispose);
  }
  function delay(callback, ms) {
    if (controller.signal.aborted) return;
    const id = setTimeout(() => {
      timers.delete(id);
      callback();
    }, ms);
    timers.add(id);
    return id;
  }
  function cancelDelay(id) {
    clearTimeout(id);
    timers.delete(id);
  }
  function repeat(callback, ms) {
    if (controller.signal.aborted) return;
    const id = setInterval(callback, ms);
    intervals.add(id);
    return id;
  }
  function cancelRepeat(id) {
    clearInterval(id);
    intervals.delete(id);
  }
  function frame(callback) {
    if (controller.signal.aborted) return;
    const id = requestAnimationFrame(time => {
      frames.delete(id);
      callback(time);
    });
    frames.add(id);
    return id;
  }
  function cancelFrame(id) {
    cancelAnimationFrame(id);
    frames.delete(id);
  }
  function animate(element, keyframes, options) {
    const animation = element.animate(keyframes, options);
    const forget = () => animations.delete(animation);
    animations.add(animation);
    animation.addEventListener('finish', forget, { once: true });
    animation.addEventListener('cancel', forget, { once: true });
    return animation;
  }
  function observeResize(element, callback) {
    const observer = new ResizeObserver(callback);
    observer.observe(element);
    onClose(() => observer.disconnect());
  }
  function close() {
    if (controller.signal.aborted) return;
    controller.abort();
    for (const id of timers) clearTimeout(id);
    for (const id of intervals) clearInterval(id);
    for (const id of frames) cancelAnimationFrame(id);
    for (const animation of animations) animation.cancel();
    for (const dispose of disposers) dispose();
    timers.clear();
    intervals.clear();
    frames.clear();
    animations.clear();
    disposers.clear();
  }
  return { signal: controller.signal, listen, onClose, delay, cancelDelay, repeat, cancelRepeat,
    frame, cancelFrame, animate, observeResize, close };
}
