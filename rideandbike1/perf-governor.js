/*
 * RIDE AND BIKE — dynamic resolution governor.
 *
 * When a scene cannot hold its refresh rate there are two things to give up:
 * frames, or pixels. Giving up frames is the wrong trade — motion is what the
 * eye judges smoothness by, and a capped 30 reads as sluggish no matter how
 * sharp it is. Giving up pixels is nearly invisible on a phone held at arm's
 * length, especially on a scene that is mostly dark asphalt and sky.
 *
 * So this watches how long frames actually take and moves the render scale up
 * and down to keep inside the budget. Every game engine ships this; it is the
 * standard answer to "hold 60 on hardware you do not control".
 *
 * Design notes that matter:
 *   - Discrete rungs, not a continuous dial. Changing the pixel ratio
 *     reallocates every framebuffer, so it must be rare and deliberate.
 *   - Asymmetric hysteresis: drop quickly when frames are late (the visitor is
 *     feeling it now), climb back slowly (avoid oscillating across a rung).
 *   - A settle period after each change, so the cost of the reallocation is
 *     never itself measured as a slow frame.
 *   - Medians, not means. One 300 ms compile stall must not drag the scale to
 *     the floor for a scene that is otherwise comfortable.
 */

const RUNGS = [1.0, 0.85, 0.72, 0.6, 0.5];

export function createPerfGovernor({
  renderer,
  composer = null,
  baseRatio,
  targetMs = 1000 / 60,
  /* How far the scale may fall. A dark background can afford to go soft; the
     product itself is the thing being sold and gets a higher floor, so it
     degrades later and never becomes the blurriest object on screen. */
  minScale = 0.5,
  enabled = true,
  onChange = null
} = {}) {
  const rungs = RUNGS.filter(function (r) { return r >= minScale - 1e-6; });
  const samples = [];
  let rung = 0;
  let settleUntil = 0;
  let lastCheck = 0;
  let lastFrame = 0;

  function currentRatio() {
    return baseRatio * rungs[rung];
  }

  /* The governor owns the ratio; the host owns what resizing means for its
     particular pass chain. Splitting it this way keeps the governor from
     needing to know about composers, render targets or camera aspects — it
     sets the ratio and asks the host to re-run its own resize path. */
  function applyRatio() {
    const ratio = currentRatio();
    renderer.setPixelRatio(ratio);
    if (composer) composer.setPixelRatio(ratio);
    onChange?.(ratio, rungs[rung]);
  }

  function median(values) {
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[sorted.length >> 1];
  }

  return {
    get scale() { return rungs[rung]; },
    get ratio() { return currentRatio(); },

    /** Call once per rendered frame, at the end of it.

        What matters is the interval between presented frames, not how long
        this scene's own JavaScript took. Two layers stacked over the same
        pixels each measure a comfortable slice while the visitor sees a
        stuttering composite; only the wall-clock cadence catches that. */
    sample() {
      if (!enabled) return;
      const now = performance.now();
      const interval = lastFrame ? now - lastFrame : 0;
      lastFrame = now;
      if (now < settleUntil) return;

      // Ignore obvious outliers: shader compiles, GC pauses, tab wake-ups.
      if (interval > 0 && interval < 200) samples.push(interval);
      if (samples.length < 45) return;
      if (now - lastCheck < 900) { samples.length = 0; return; }
      lastCheck = now;

      const typical = median(samples);
      samples.length = 0;

      if (typical > targetMs * 1.25 && rung < rungs.length - 1) {
        // Late frames now: step down immediately.
        rung++;
        settleUntil = now + 500;
        lastFrame = 0;
        applyRatio();
      } else if (typical < targetMs * 0.62 && rung > 0) {
        // Comfortable for a while: try one rung back up.
        rung--;
        settleUntil = now + 1400;
        lastFrame = 0;
        applyRatio();
      }
    },

    /** Re-apply after an external resize, which resets the renderer's size. */
    reapply() {
      if (!enabled) return currentRatio();
      renderer.setPixelRatio(currentRatio());
      if (composer) composer.setPixelRatio(currentRatio());
      return currentRatio();
    }
  };
}
