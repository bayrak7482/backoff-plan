import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BackoffPlan, BackoffOptions } from '../src/index.js';

// A fake clock: returns whatever counter it holds, advances only when told.
class FakeClock {
  constructor(start = 0) {
    this.t = start;
  }
  now() {
    return this.t;
  }
  advance(ms) {
    this.t += ms;
  }
}

// Deterministic Math.random so jitter tests are reproducible.
// Returns a fixed value in [0, 1); we vary it per test to exercise bounds.
function withRandom(value, fn) {
  const orig = Math.random;
  Math.random = () => value;
  try {
    return fn();
  } finally {
    Math.random = orig;
  }
}

test('BackoffOptions applies defaults', () => {
  const o = new BackoffOptions();
  assert.equal(o.base, 100);
  assert.equal(o.factor, 2);
  assert.equal(o.cap, 30_000);
  assert.equal(o.cutoff, 300_000);
});

test('BackoffOptions overrides provided fields', () => {
  const o = new BackoffOptions({ base: 50, factor: 3, cap: 1000, cutoff: 5000 });
  assert.deepEqual({ base: o.base, factor: o.factor, cap: o.cap, cutoff: o.cutoff },
    { base: 50, factor: 3, cap: 1000, cutoff: 5000 });
});

test('BackoffOptions rejects non-finite base', () => {
  assert.throws(() => new BackoffOptions({ base: Infinity }), RangeError);
  assert.throws(() => new BackoffOptions({ base: NaN }), RangeError);
});

test('BackoffOptions rejects negative cap', () => {
  assert.throws(() => new BackoffOptions({ cap: -1 }), RangeError);
});

test('BackoffPlan accepts a plain object and coerces to BackoffOptions', () => {
  const clock = new FakeClock();
  const plan = new BackoffPlan({ base: 10, factor: 2, cap: 100, cutoff: 1000 }, () => clock.t);
  // Attempt 0 raw = 10, jitter in [0, 10]; with random = 0.5 we get 5.
  const d = withRandom(0.5, () => plan.delay(0));
  assert.equal(d, 5);
});

test('delay(0) with random=0 returns 0', () => {
  const clock = new FakeClock();
  const plan = new BackoffPlan({ base: 100, factor: 2, cap: 1000, cutoff: 10000 }, () => clock.t);
  const d = withRandom(0, () => plan.delay(0));
  assert.equal(d, 0);
});

test('delay(0) with random just below 1 hits jitterCap exactly (minus 1 for floor)', () => {
  // raw = 100, cap = 1000, remaining = 10000 -> jitterCap = 100.
  // floor(0.999... * 101) = 100. We use random = 1 - epsilon to land on 100.
  const clock = new FakeClock();
  const plan = new BackoffPlan({ base: 100, factor: 2, cap: 1000, cutoff: 10000 }, () => clock.t);
  const d = withRandom(0.999999, () => plan.delay(0));
  assert.equal(d, 100);
});

test('delay grows exponentially with attempt when cap and cutoff are loose', () => {
  const clock = new FakeClock();
  const plan = new BackoffPlan({ base: 10, factor: 2, cap: 10_000, cutoff: 1_000_000 }, () => clock.t);
  // random = 1 - eps gives jitterCap for each.
  const d0 = withRandom(0.999999, () => plan.delay(0)); // 10
  const d1 = withRandom(0.999999, () => plan.delay(1)); // 20
  const d2 = withRandom(0.999999, () => plan.delay(2)); // 40
  const d3 = withRandom(0.999999, () => plan.delay(3)); // 80
  assert.deepEqual([d0, d1, d2, d3], [10, 20, 40, 80]);
});

test('per-attempt cap clamps the raw delay before jitter', () => {
  const clock = new FakeClock();
  // cap = 50; attempt 3 raw = 10 * 8 = 80, clamped to 50.
  const plan = new BackoffPlan({ base: 10, factor: 2, cap: 50, cutoff: 1_000_000 }, () => clock.t);
  const d = withRandom(0.999999, () => plan.delay(3));
  assert.equal(d, 50);
});

test('remaining reflects elapsed time since plan creation', () => {
  const clock = new FakeClock(1000);
  const plan = new BackoffPlan({ base: 10, factor: 2, cap: 1000, cutoff: 5000 }, () => clock.t);
  assert.equal(plan.remaining(0), 5000);
  clock.advance(2000);
  assert.equal(plan.remaining(0), 3000);
  clock.advance(3000);
  assert.equal(plan.remaining(0), 0);
});

test('delay returns 0 when cutoff budget is exhausted', () => {
  const clock = new FakeClock();
  const plan = new BackoffPlan({ base: 100, factor: 2, cap: 1000, cutoff: 1000 }, () => clock.t);
  clock.advance(1000);
  const d = withRandom(0.5, () => plan.delay(0));
  assert.equal(d, 0);
});

test('delay ties jitter to remaining budget so the last attempt cannot overshoot', () => {
  const clock = new FakeClock();
  const plan = new BackoffPlan({ base: 1000, factor: 2, cap: 10_000, cutoff: 3000 }, () => clock.t);
  clock.advance(2500); // remaining = 500
  // raw = 1000, cap = 10_000, remaining = 500 -> jitterCap = 500.
  const d = withRandom(0.999999, () => plan.delay(0));
  assert.equal(d, 500);
});

test('exhausted is true once remaining hits zero', () => {
  const clock = new FakeClock();
  const plan = new BackoffPlan({ base: 10, factor: 2, cap: 1000, cutoff: 1000 }, () => clock.t);
  assert.equal(plan.exhausted(), false);
  clock.advance(1000);
  assert.equal(plan.exhausted(), true);
});

test('delay rejects negative attempt', () => {
  const clock = new FakeClock();
  const plan = new BackoffPlan({}, () => clock.t);
  assert.throws(() => plan.delay(-1), RangeError);
});

test('delay rejects non-integer attempt', () => {
  const clock = new FakeClock();
  const plan = new BackoffPlan({}, () => clock.t);
  assert.throws(() => plan.delay(1.5), RangeError);
});

test('remaining rejects non-integer attempt', () => {
  const clock = new FakeClock();
  const plan = new BackoffPlan({}, () => clock.t);
  assert.throws(() => plan.remaining('x'), RangeError);
});

test('factor of 1 yields constant base delay (capped by remaining)', () => {
  const clock = new FakeClock();
  const plan = new BackoffPlan({ base: 50, factor: 1, cap: 1000, cutoff: 10_000 }, () => clock.t);
  const d0 = withRandom(0.999999, () => plan.delay(0));
  const d5 = withRandom(0.999999, () => plan.delay(5));
  assert.equal(d0, 50);
  assert.equal(d5, 50);
});

test('base of 0 with any random value always returns 0', () => {
  const clock = new FakeClock();
  const plan = new BackoffPlan({ base: 0, factor: 2, cap: 1000, cutoff: 10_000 }, () => clock.t);
  for (const r of [0, 0.25, 0.5, 0.75, 0.999999]) {
    const d = withRandom(r, () => plan.delay(3));
    assert.equal(d, 0);
  }
});
