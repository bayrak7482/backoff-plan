# Backoff Plan

Retry delays with full jitter, bounded by a total time cutoff. Pure and clock-injectable so it never touches wall-clock time in tests.

```js
import { BackoffPlan, BackoffOptions } from 'backoff-plan';

const plan = new BackoffPlan(
  { base: 100, factor: 2, cap: 30_000, cutoff: 5 * 60_000 },
  () => Date.now(),
);

async function retry(operation) {
  for (let attempt = 0; ; attempt++) {
    if (plan.exhausted()) break;
    const wait = plan.delay(attempt);
    await new Promise((resolve) => setTimeout(resolve, wait));
    try {
      return await operation();
    } catch (e) {
      // continue to next attempt
    }
  }
  throw new Error('retry budget exhausted');
}
```

## Why this exists

You need to retry a flaky operation with increasing delays, but you have a hard total deadline (an HTTP request budget, a job timeout, a user's patience). A bare exponential backoff with jitter can run forever; a bare cutoff can cut off mid-sleep. This library gives you both knobs — `cap` per attempt and `cutoff` across all attempts — and ties the jitter range to the *remaining* budget so the final retry inside the window cannot overshoot it.

The trade-off: the plan is a pure description of delays. It does not call your operation, does not sleep, does not catch errors. You wire the loop. That makes it one screen of code, trivially auditable, and testable without a single timer or sleep.

## The awkward edge

`delay(attempt)` returns a random integer in `[0, jitterCap]` where `jitterCap = min(raw, cap, remaining)`. With full jitter and `Math.random() === 0`, the delay is **zero** even on the first attempt. That is intentional — full jitter exists to spread load — but if your operation cannot tolerate a zero-delay retry, wrap the result with your own floor before sleeping.

## Performance

The window keeps a bounded buffer, so `push` is constant time and memory does not
grow with the length of the stream. `peak` and `trough` are linear in the window
size, which is the trade that keeps `push` cheap.

