import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createAggregator, defineEvent } from '../src/index.ts';

const Scored = defineEvent<[name: string, points: number]>('Scored');
const Ping = defineEvent('Ping');
const Tick = defineEvent<[n: number]>('Tick');

const bus = () => createAggregator();

describe('emit', () => {
  it('invokes subscribers in subscription order with the published args', () => {
    const b = bus();
    const seen: string[] = [];
    b.on(Scored, (name, points) => seen.push(`a:${name}:${points}`));
    b.on(Scored, (name, points) => seen.push(`b:${name}:${points}`));

    const count = b.emit(Scored, 'zack', 10);

    assert.equal(count, 2);
    assert.deepEqual(seen, ['a:zack:10', 'b:zack:10']);
  });

  it('returns 0 and does nothing when the event has no subscribers', () => {
    assert.equal(bus().emit(Ping), 0);
  });

  it('does not invoke a handler twice when it subscribes twice', () => {
    const b = bus();
    let calls = 0;
    const handler = () => {
      calls += 1;
    };
    b.on(Ping, handler);
    b.on(Ping, handler);

    assert.equal(b.emit(Ping), 1);
    assert.equal(calls, 1);
  });

  it('stops invoking a handler after off()', () => {
    const b = bus();
    let calls = 0;
    const handler = () => {
      calls += 1;
    };
    b.on(Ping, handler);
    b.emit(Ping);
    b.off(Ping, handler);
    b.emit(Ping);

    assert.equal(calls, 1);
  });

  it('stops invoking a handler after the returned unsubscribe runs', () => {
    const b = bus();
    let calls = 0;
    const unsubscribe = b.on(Ping, () => {
      calls += 1;
    });
    b.emit(Ping);
    unsubscribe();
    unsubscribe(); // idempotent
    b.emit(Ping);

    assert.equal(calls, 1);
  });
});

describe('dispatch is isolated from mutation', () => {
  it('does not invoke a handler unsubscribed by an earlier handler in the same publish', () => {
    const b = bus();
    const seen: string[] = [];
    const second = () => seen.push('second');
    b.on(Ping, () => {
      seen.push('first');
      b.off(Ping, second);
    });
    b.on(Ping, second);

    b.emit(Ping);
    // `second` was already snapshotted, so it still runs this time...
    assert.deepEqual(seen, ['first', 'second']);

    b.emit(Ping);
    // ...but not on the next publish.
    assert.deepEqual(seen, ['first', 'second', 'first']);
  });

  it('does not invoke a handler subscribed during the same publish', () => {
    const b = bus();
    const seen: string[] = [];
    b.on(Ping, () => {
      seen.push('first');
      b.on(Ping, () => seen.push('late'));
    });

    b.emit(Ping);
    assert.deepEqual(seen, ['first']);
  });

  it('survives a handler that clears every subscriber mid-dispatch', () => {
    const b = bus();
    const seen: string[] = [];
    b.on(Ping, () => {
      seen.push('first');
      b.clear();
    });
    b.on(Ping, () => seen.push('second'));

    assert.doesNotThrow(() => b.emit(Ping));
    assert.deepEqual(seen, ['first', 'second']);
    assert.equal(b.listenerCount(Ping), 0);
  });
});

describe('once', () => {
  it('invokes the handler for a single publish only', () => {
    const b = bus();
    let calls = 0;
    b.once(Ping, () => {
      calls += 1;
    });

    b.emit(Ping);
    b.emit(Ping);

    assert.equal(calls, 1);
    assert.equal(b.listenerCount(Ping), 0);
  });

  it('does not re-invoke a once handler that republishes its own event', () => {
    const b = bus();
    let calls = 0;
    b.once(Ping, () => {
      calls += 1;
      b.emit(Ping); // would recurse if the registration were still live
    });

    b.emit(Ping);
    assert.equal(calls, 1);
  });

  it('can be cancelled before it ever fires', () => {
    const b = bus();
    let calls = 0;
    const unsubscribe = b.once(Ping, () => {
      calls += 1;
    });
    unsubscribe();
    b.emit(Ping);

    assert.equal(calls, 0);
  });
});

describe('pause / resume', () => {
  it('drops publishes for a paused event but keeps its subscribers', () => {
    const b = bus();
    let calls = 0;
    b.on(Ping, () => {
      calls += 1;
    });

    b.pause(Ping);
    assert.equal(b.isPaused(Ping), true);
    assert.equal(b.emit(Ping), 0);
    assert.equal(b.listenerCount(Ping), 1);

    b.resume(Ping);
    assert.equal(b.emit(Ping), 1);
    assert.equal(calls, 1);
  });

  it('leaves other events unaffected', () => {
    const b = bus();
    let pings = 0;
    let ticks = 0;
    b.on(Ping, () => {
      pings += 1;
    });
    b.on(Tick, () => {
      ticks += 1;
    });

    b.pause(Ping);
    b.emit(Ping);
    b.emit(Tick, 1);

    assert.equal(pings, 0);
    assert.equal(ticks, 1);
  });

  it('pauses and resumes every event when called with no argument', () => {
    const b = bus();
    let calls = 0;
    b.on(Ping, () => {
      calls += 1;
    });
    b.on(Tick, () => {
      calls += 1;
    });

    b.pause();
    b.emit(Ping);
    b.emit(Tick, 1);
    assert.equal(calls, 0);
    assert.equal(b.isPaused(Tick), true);

    b.resume();
    b.emit(Ping);
    b.emit(Tick, 1);
    assert.equal(calls, 2);
  });

  it('does not consume a once subscription while paused', () => {
    const b = bus();
    let calls = 0;
    b.once(Ping, () => {
      calls += 1;
    });

    b.pause(Ping);
    b.emit(Ping);
    b.resume(Ping);
    b.emit(Ping);

    assert.equal(calls, 1);
  });
});

describe('error handling', () => {
  it('continues dispatch after a handler throws and reports it', () => {
    const errors: { error: unknown; event: string; args: readonly unknown[] }[] = [];
    const b = createAggregator({
      onError: (error, context) =>
        errors.push({ error, event: context.event.name, args: context.args }),
    });
    const seen: string[] = [];

    b.on(Scored, () => {
      throw new Error('boom');
    });
    b.on(Scored, () => seen.push('after'));

    const count = b.emit(Scored, 'zack', 10);

    assert.equal(count, 2);
    assert.deepEqual(seen, ['after']);
    assert.equal(errors.length, 1);
    assert.equal((errors[0]!.error as Error).message, 'boom');
    assert.equal(errors[0]!.event, 'Scored');
    assert.deepEqual(errors[0]!.args, ['zack', 10]);
  });

  it('reports a rejection from an async subscriber dispatched via emit', async () => {
    const errors: unknown[] = [];
    const b = createAggregator({ onError: (e) => errors.push(e) });
    let reached = false;

    // An async handler rejects rather than throwing; `emit` does not await it,
    // so without explicit handling this escapes as an unhandled rejection.
    b.on(Ping, async () => {
      throw new Error('floating boom');
    });
    b.on(Ping, () => {
      reached = true;
    });

    assert.equal(b.emit(Ping), 2);
    assert.equal(reached, true);

    await new Promise((r) => setTimeout(r, 10));
    assert.equal(errors.length, 1);
    assert.equal((errors[0] as Error).message, 'floating boom');
  });
});

describe('emitConcurrent', () => {
  it('waits for every async subscriber to settle', async () => {
    const b = bus();
    const finished: string[] = [];

    b.on(Tick, async (n) => {
      await new Promise((r) => setTimeout(r, 20));
      finished.push(`slow:${n}`);
    });
    b.on(Tick, async (n) => {
      finished.push(`fast:${n}`);
    });

    const count = await b.emitConcurrent(Tick, 1);

    assert.equal(count, 2);
    assert.equal(finished.length, 2);
    assert.ok(finished.includes('slow:1'));
    assert.ok(finished.includes('fast:1'));
  });

  it('starts subscribers at once rather than one at a time', async () => {
    const b = bus();
    for (let i = 0; i < 4; i += 1) {
      b.on(Tick, async () => {
        await new Promise((r) => setTimeout(r, 40));
      });
    }

    const started = Date.now();
    await b.emitConcurrent(Tick, 1);
    const elapsed = Date.now() - started;

    // Sequential would be ~160ms; concurrent should land near one delay.
    assert.ok(elapsed < 120, `expected concurrent dispatch, took ${elapsed}ms`);
  });

  it('isolates a rejecting subscriber and never rejects the caller', async () => {
    const errors: unknown[] = [];
    const b = createAggregator({ onError: (e) => errors.push(e) });
    let reached = false;

    b.on(Ping, async () => {
      throw new Error('async boom');
    });
    b.on(Ping, async () => {
      reached = true;
    });

    await assert.doesNotReject(() => b.emitConcurrent(Ping));
    assert.equal(reached, true);
    assert.equal(errors.length, 1);
    assert.equal((errors[0] as Error).message, 'async boom');
  });

  it('returns 0 for a paused event', async () => {
    const b = bus();
    b.on(Ping, () => {});
    b.pause(Ping);

    assert.equal(await b.emitConcurrent(Ping), 0);
  });
});

describe('emitSequential', () => {
  it('awaits each subscriber before starting the next', async () => {
    const b = bus();
    const order: string[] = [];

    b.on(Tick, async () => {
      order.push('a:start');
      await new Promise((r) => setTimeout(r, 30));
      order.push('a:end');
    });
    b.on(Tick, async () => {
      order.push('b:start');
      await new Promise((r) => setTimeout(r, 5));
      order.push('b:end');
    });

    const count = await b.emitSequential(Tick, 1);

    assert.equal(count, 2);
    assert.deepEqual(order, ['a:start', 'a:end', 'b:start', 'b:end']);
  });

  it('continues the chain after a subscriber rejects', async () => {
    const errors: unknown[] = [];
    const b = createAggregator({ onError: (e) => errors.push(e) });
    let reached = false;

    b.on(Ping, async () => {
      throw new Error('link broke');
    });
    b.on(Ping, async () => {
      reached = true;
    });

    await assert.doesNotReject(() => b.emitSequential(Ping));
    assert.equal(reached, true);
    assert.equal(errors.length, 1);
    assert.equal((errors[0] as Error).message, 'link broke');
  });

  it('returns 0 for a paused event', async () => {
    const b = bus();
    b.on(Ping, () => {});
    b.pause(Ping);

    assert.equal(await b.emitSequential(Ping), 0);
  });
});

describe('waitFor', () => {
  it('resolves with the next payload', async () => {
    const b = bus();
    setTimeout(() => b.emit(Scored, 'zack', 10), 5);

    const [name, points] = await b.waitFor(Scored);

    assert.equal(name, 'zack');
    assert.equal(points, 10);
  });

  it('unsubscribes once it resolves', async () => {
    const b = bus();
    setTimeout(() => b.emit(Ping), 5);

    await b.waitFor(Ping);

    assert.equal(b.listenerCount(Ping), 0);
  });

  it('rejects and unsubscribes on timeout', async () => {
    const b = bus();

    await assert.rejects(() => b.waitFor(Ping, { timeoutMs: 10 }), /Timed out/);
    assert.equal(b.listenerCount(Ping), 0);
  });

  it('rejects when the signal aborts', async () => {
    const b = bus();
    const controller = new AbortController();
    setTimeout(() => controller.abort(new Error('cancelled')), 5);

    await assert.rejects(
      () => b.waitFor(Ping, { signal: controller.signal }),
      /cancelled/,
    );
    assert.equal(b.listenerCount(Ping), 0);
  });

  it('rejects immediately when given an already-aborted signal', async () => {
    const b = bus();

    await assert.rejects(
      () => b.waitFor(Ping, { signal: AbortSignal.abort(new Error('nope')) }),
      /nope/,
    );
    assert.equal(b.listenerCount(Ping), 0);
  });
});

describe('stream', () => {
  it('yields published payloads in order', async () => {
    const b = bus();
    const seen: number[] = [];

    setTimeout(() => {
      b.emit(Tick, 1);
      b.emit(Tick, 2);
      b.emit(Tick, 3);
    }, 5);

    for await (const [n] of b.stream(Tick)) {
      seen.push(n);
      if (seen.length === 3) break;
    }

    assert.deepEqual(seen, [1, 2, 3]);
  });

  it('unsubscribes when the consumer breaks out of the loop', async () => {
    const b = bus();
    setTimeout(() => b.emit(Tick, 1), 5);

    for await (const _ of b.stream(Tick)) {
      break;
    }

    assert.equal(b.listenerCount(Tick), 0);
  });

  it('buffers events published before the consumer asks for them', async () => {
    const b = bus();
    const stream = b.stream(Tick);
    b.emit(Tick, 1);
    b.emit(Tick, 2);

    assert.deepEqual((await stream.next()).value, [1]);
    assert.deepEqual((await stream.next()).value, [2]);
    await stream.return!();
  });

  it('drops the oldest event once bufferSize is exceeded', async () => {
    const b = bus();
    const stream = b.stream(Tick, { bufferSize: 2 });
    b.emit(Tick, 1);
    b.emit(Tick, 2);
    b.emit(Tick, 3);

    assert.deepEqual((await stream.next()).value, [2]);
    assert.deepEqual((await stream.next()).value, [3]);
    await stream.return!();
  });

  it('ends the stream when the signal aborts', async () => {
    const b = bus();
    const controller = new AbortController();
    const seen: number[] = [];

    setTimeout(() => b.emit(Tick, 1), 5);
    setTimeout(() => controller.abort(), 15);

    for await (const [n] of b.stream(Tick, { signal: controller.signal })) {
      seen.push(n);
    }

    assert.deepEqual(seen, [1]);
    assert.equal(b.listenerCount(Tick), 0);
  });
});

describe('token identity', () => {
  it('treats two tokens sharing a name as different events', () => {
    const a = defineEvent<[n: number]>('Duplicate');
    const b = defineEvent<[n: number]>('Duplicate');
    const seen: string[] = [];

    const bus = createAggregator();
    bus.on(a, (n) => seen.push(`a:${n}`));
    bus.on(b, (n) => seen.push(`b:${n}`));

    bus.emit(a, 1);

    assert.deepEqual(seen, ['a:1']);
    assert.equal(bus.listenerCount(b), 1);
  });

  it('keys the registry by token identity, not by name', () => {
    const bus = createAggregator();
    const other = defineEvent<[n: number]>('Tick');

    bus.on(Tick, () => {});

    assert.equal(bus.listenerCount(Tick), 1);
    assert.equal(bus.listenerCount(other), 0);
  });

  it('accepts a handler that ignores some or all of the payload', () => {
    const bus = createAggregator();
    let calls = 0;
    let firstOnly: string | undefined;

    // Inference must come from the token, not from the handler's arity.
    bus.on(Tick, () => {
      calls += 1;
    });
    bus.on(Scored, (name) => {
      firstOnly = name;
    });

    bus.emit(Tick, 1);
    bus.emit(Scored, 'zack', 10);

    assert.equal(calls, 1);
    assert.equal(firstOnly, 'zack');
  });

  it('carries the token into the error context for logging', () => {
    const names: string[] = [];
    const bus = createAggregator({
      onError: (_e, context) => names.push(context.event.name),
    });
    bus.on(Scored, () => {
      throw new Error('boom');
    });

    bus.emit(Scored, 'zack', 10);

    assert.deepEqual(names, ['Scored']);
  });
});

describe('introspection', () => {
  it('reports listener counts and known events, and clears them', () => {
    const b = bus();
    b.on(Ping, () => {});
    b.on(Ping, () => {});
    b.on(Tick, () => {});

    assert.equal(b.listenerCount(Ping), 2);
    assert.equal(b.listenerCount(Scored), 0);
    assert.deepEqual(b.events().map((t) => t.name).sort(), ['Ping', 'Tick']);

    b.clear(Ping);
    assert.equal(b.listenerCount(Ping), 0);
    assert.deepEqual(b.events().map((t) => t.name), ['Tick']);

    b.clear();
    assert.deepEqual(b.events(), []);
  });
});
