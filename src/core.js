/**
 * Core backoff plan: generate retry delays bounded by a total cutoff.
 *
 * The single design decision that shapes this module: a "plan" is a pure
 * description of *what delays to use*, never *when to run them*. The caller
 * decides when to sleep and when to stop. This keeps the plan deterministic
 * and trivially testable — every function here is a pure function of its
 * arguments and the injected clock.
 */

/**
 * Options for building a BackoffPlan.
 *
 * `base` is the first delay, in milliseconds. `factor` multiplies the base
 * on each subsequent attempt (so factor=2 gives exponential growth). `cap`
 * is the per-attempt maximum: any computed delay above this is clamped down
 * to it. `cutoff` is the total time budget across all attempts, measured
 * from the moment the plan is created (via the clock).
 */
export class BackoffOptions {
  constructor({
    base = 100,
    factor = 2,
    cap = 30_000,
    cutoff = 5 * 60_000,
  } = {}) {
    if (!Number.isFinite(base) || base < 0) {
      throw new RangeError(`base must be a non-negative finite number, got ${base}`);
    }
    if (!Number.isFinite(factor) || factor < 0) {
      throw new RangeError(`factor must be a non-negative finite number, got ${factor}`);
    }
    if (!Number.isFinite(cap) || cap < 0) {
      throw new RangeError(`cap must be a non-negative finite number, got ${cap}`);
    }
    if (!Number.isFinite(cutoff) || cutoff < 0) {
      throw new RangeError(`cutoff must be a non-negative finite number, got ${cutoff}`);
    }
    this.base = base;
    this.factor = factor;
    this.cap = cap;
    this.cutoff = cutoff;
  }
}

/**
 * A pure backoff schedule.
 *
 * Call `delay(attempt)` to get the delay in ms for a given attempt number
 * (0-based). Call `remaining(attempt)` to find out how much of the total
 * cutoff budget is left *before* sleeping for that attempt. If `remaining`
 * returns 0, you should stop retrying.
 *
 * The clock is injected so tests never touch wall-clock time. We default to
 * `Date.now` for production use; tests pass a fake that returns integers.
 */
export class BackoffPlan {
  #opts;
  #clock;
  #start;

  constructor(opts = new BackoffOptions(), clock = () => Date.now()) {
    if (!(opts instanceof BackoffOptions)) {
      opts = new BackoffOptions(opts);
    }
    this.#opts = opts;
    this.#clock = clock;
    this.#start = clock();
  }

  /**
   * Per-attempt delay before attempt N (0-based), with full jitter.
   *
   * Full jitter means we pick a uniform random value in [0, raw]. This is
   * the "Decorrelated Jitter #4" alternative from the AWS architecture blog;
   * we use plain full jitter because it is simple and bounds the actual
   * sleep strictly below the exponential curve, which matters when many
   * clients retry simultaneously.
   *
   * We clamp raw by `cap` *before* jittering so the random range never
   * exceeds the per-attempt cap. jitterCap = min(raw, cap, remaining).
   * Tying jitter to the remaining budget means the very last attempt inside
   * the cutoff window cannot accidentally overshoot it.
   */
  delay(attempt) {
    if (!Number.isInteger(attempt) || attempt < 0) {
      throw new RangeError(`attempt must be a non-negative integer, got ${attempt}`);
    }
    const { base, factor, cap, cutoff } = this.#opts;
    const elapsed = this.#clock() - this.#start;
    const remaining = Math.max(0, cutoff - elapsed);
    if (remaining <= 0) {
      return 0;
    }
    const raw = base * Math.pow(factor, attempt);
    const jitterCap = Math.min(raw, cap, remaining);
    return Math.floor(Math.random() * (jitterCap + 1));
  }

  /**
   * How many ms remain in the total cutoff budget *before* attempt N sleeps.
   * Returns 0 once the budget is exhausted.
   */
  remaining(attempt) {
    if (!Number.isInteger(attempt) || attempt < 0) {
      throw new RangeError(`attempt must be a non-negative integer, got ${attempt}`);
    }
    const elapsed = this.#clock() - this.#start;
    return Math.max(0, this.#opts.cutoff - elapsed);
  }

  /**
   * Has the cutoff budget been exhausted? Convenience over `remaining === 0`.
   */
  exhausted() {
    return this.remaining(0) <= 0;
  }
}
