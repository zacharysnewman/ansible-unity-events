import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createAggregator } from '../src/index.ts';

type TestEvents = {
  scored: [name: string, points: number];
  ping: [];
  tick: [n: number];
};

const bus = () => createAggregator<TestEvents>();

describe('emit', () => {
  it('invokes subscribers in subscription order with the published args', () => {
    const b = bus();
    const seen: string[] = [];
    b.on('scored', (name, points) => seen.push(`a:${name}:${points}`));
    b.on('scored', (name, points) => seen.push(`b:${name}:${points}`));

    const count = b.emit('scored', 'zack', 10);

    assert.equal(count, 2);
    assert.deepEqual(seen, ['a:zack:10', 'b:zack:10']);
  });

  it('returns 0 and does nothing when the event has no subscribers', () => {
    assert.equal(bus().emit('ping'), 0);
  });

  it('does not invoke a handler twice when it subscribes twice', () => {
    const b = bus();
    let calls = 0;
    const handler = () => {
      calls += 1;
    };
    b.on('ping', handler);
    b.on('ping', handler);

    assert.equal(b.emit('ping'), 1);
    assert.equal(calls, 1);
  });

  it('stops invoking a handler after off()', () => {
    const b = bus();
    let calls = 0;
    const handler = () => {
      calls += 1;
    };
    b.on('ping', handler);
    b.emit('ping');
    b.off('ping', handler);
    b.emit('ping');

    assert.equal(calls, 1);
  });

  it('stops invoking a handler after the returned unsubscribe runs', () => {
    const b = bus();
    let calls = 0;
    const unsubscribe = b.on('ping', () => {
      calls += 1;
    });
    b.emit('ping');
    unsubscribe();
    unsubscribe(); // idempotent
    b.emit('ping');

    assert.equal(calls, 1);
  });
});

describe('dispatch is isolated from mutation', () => {
  it('does not invoke a handler unsubscribed by an earlier handler in the same publish', () => {
    const b = bus();
    const seen: string[] = [];
    const second = () => seen.push('second');
    b.on('ping', () => {
      seen.push('first');
      b.off('ping', second);
    });
    b.on('ping', second);

    b.emit('ping');
    // `second` was already snapshotted, so it still runs this time...
    assert.deepEqual(seen, ['first', 'second']);

    b.emit('ping');
    // ...but not on the next publish.
    assert.deepEqual(seen, ['first', 'second', 'first']);
  });

  it('does not invoke a handler subscribed during the same publish', () => {
    const b = bus();
    const seen: string[] = [];
    b.on('ping', () => {
      seen.push('first');
      b.on('ping', () => seen.push('late'));
    });

    b.emit('ping');
    assert.deepEqual(seen, ['first']);
  });

  it('survives a handler that clears every subscriber mid-dispatch', () => {
    const b = bus();
    const seen: string[] = [];
    b.on('ping', () => {
      seen.push('first');
      b.clear();
    });
    b.on('ping', () => seen.push('second'));

    assert.doesNotThrow(() => b.emit('ping'));
    assert.deepEqual(seen, ['first', 'second']);
    assert.equal(b.listenerCount('ping'), 0);
  });
});

describe('once', () => {
  it('invokes the handler for a single publish only', () => {
    const b = bus();
    let calls = 0;
    b.once('ping', () => {
      calls += 1;
    });

    b.emit('ping');
    b.emit('ping');

    assert.equal(calls, 1);
    assert.equal(b.listenerCount('ping'), 0);
  });

  it('does not re-invoke a once handler that republishes its own event', () => {
    const b = bus();
    let calls = 0;
    b.once('ping', () => {
      calls += 1;
      b.emit('ping'); // would recurse if the registration were still live
    });

    b.emit('ping');
    assert.equal(calls, 1);
  });

  it('can be cancelled before it ever fires', () => {
    const b = bus();
    let calls = 0;
    const unsubscribe = b.once('ping', () => {
      calls += 1;
    });
    unsubscribe();
    b.emit('ping');

    assert.equal(calls, 0);
  });
});

describe('pause / resume', () => {
  it('drops publishes for a paused event but keeps its subscribers', () => {
    const b = bus();
    let calls = 0;
    b.on('ping', () => {
      calls += 1;
    });

    b.pause('ping');
    assert.equal(b.isPaused('ping'), true);
    assert.equal(b.emit('ping'), 0);
    assert.equal(b.listenerCount('ping'), 1);

    b.resume('ping');
    assert.equal(b.emit('ping'), 1);
    assert.equal(calls, 1);
  });

  it('leaves other events unaffected', () => {
    const b = bus();
    let pings = 0;
    let ticks = 0;
    b.on('ping', () => {
      pings += 1;
    });
    b.on('tick', () => {
      ticks += 1;
    });

    b.pause('ping');
    b.emit('ping');
    b.emit('tick', 1);

    assert.equal(pings, 0);
    assert.equal(ticks, 1);
  });

  it('pauses and resumes every event when called with no argument', () => {
    const b = bus();
    let calls = 0;
    b.on('ping', () => {
      calls += 1;
    });
    b.on('tick', () => {
      calls += 1;
    });

    b.pause();
    b.emit('ping');
    b.emit('tick', 1);
    assert.equal(calls, 0);
    assert.equal(b.isPaused('tick'), true);

    b.resume();
    b.emit('ping');
    b.emit('tick', 1);
    assert.equal(calls, 2);
  });

  it('does not consume a once subscription while paused', () => {
    const b = bus();
    let calls = 0;
    b.once('ping', () => {
      calls += 1;
    });

    b.pause('ping');
    b.emit('ping');
    b.resume('ping');
    b.emit('ping');

    assert.equal(calls, 1);
  });
});

describe('error handling', () => {
  it('continues dispatch after a handler throws and reports it', () => {
    const errors: { error: unknown; event: string; args: readonly unknown[] }[] = [];
    const b = createAggregator<TestEvents>({
      onError: (error, context) =>
        errors.push({ error, event: context.event, args: context.args }),
    });
    const seen: string[] = [];

    b.on('scored', () => {
      throw new Error('boom');
    });
    b.on('scored', () => seen.push('after'));

    const count = b.emit('scored', 'zack', 10);

    assert.equal(count, 2);
    assert.deepEqual(seen, ['after']);
    assert.equal(errors.length, 1);
    assert.equal((errors[0]!.error as Error).message, 'boom');
    assert.equal(errors[0]!.event, 'scored');
    assert.deepEqual(errors[0]!.args, ['zack', 10]);
  });

  it('reports a rejection from an async subscriber dispatched via emit', async () => {
    const errors: unknown[] = [];
    const b = createAggregator<TestEvents>({ onError: (e) => errors.push(e) });
    let reached = false;

    // An async handler rejects rather than throwing; `emit` does not await it,
    // so without explicit handling this escapes as an unhandled rejection.
    b.on('ping', async () => {
      throw new Error('floating boom');
    });
    b.on('ping', () => {
      reached = true;
    });

    assert.equal(b.emit('ping'), 2);
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

    b.on('tick', async (n) => {
      await new Promise((r) => setTimeout(r, 20));
      finished.push(`slow:${n}`);
    });
    b.on('tick', async (n) => {
      finished.push(`fast:${n}`);
    });

    const count = await b.emitConcurrent('tick', 1);

    assert.equal(count, 2);
    assert.equal(finished.length, 2);
    assert.ok(finished.includes('slow:1'));
    assert.ok(finished.includes('fast:1'));
  });

  it('starts subscribers at once rather than one at a time', async () => {
    const b = bus();
    for (let i = 0; i < 4; i += 1) {
      b.on('tick', async () => {
        await new Promise((r) => setTimeout(r, 40));
      });
    }

    const started = Date.now();
    await b.emitConcurrent('tick', 1);
    const elapsed = Date.now() - started;

    // Sequential would be ~160ms; concurrent should land near one delay.
    assert.ok(elapsed < 120, `expected concurrent dispatch, took ${elapsed}ms`);
  });

  it('isolates a rejecting subscriber and never rejects the caller', async () => {
    const errors: unknown[] = [];
    const b = createAggregator<TestEvents>({ onError: (e) => errors.push(e) });
    let reached = false;

    b.on('ping', async () => {
      throw new Error('async boom');
    });
    b.on('ping', async () => {
      reached = true;
    });

    await assert.doesNotReject(() => b.emitConcurrent('ping'));
    assert.equal(reached, true);
    assert.equal(errors.length, 1);
    assert.equal((errors[0] as Error).message, 'async boom');
  });

  it('returns 0 for a paused event', async () => {
    const b = bus();
    b.on('ping', () => {});
    b.pause('ping');

    assert.equal(await b.emitConcurrent('ping'), 0);
  });
});

describe('emitSequential', () => {
  it('awaits each subscriber before starting the next', async () => {
    const b = bus();
    const order: string[] = [];

    b.on('tick', async () => {
      order.push('a:start');
      await new Promise((r) => setTimeout(r, 30));
      order.push('a:end');
    });
    b.on('tick', async () => {
      order.push('b:start');
      await new Promise((r) => setTimeout(r, 5));
      order.push('b:end');
    });

    const count = await b.emitSequential('tick', 1);

    assert.equal(count, 2);
    assert.deepEqual(order, ['a:start', 'a:end', 'b:start', 'b:end']);
  });

  it('continues the chain after a subscriber rejects', async () => {
    const errors: unknown[] = [];
    const b = createAggregator<TestEvents>({ onError: (e) => errors.push(e) });
    let reached = false;

    b.on('ping', async () => {
      throw new Error('link broke');
    });
    b.on('ping', async () => {
      reached = true;
    });

    await assert.doesNotReject(() => b.emitSequential('ping'));
    assert.equal(reached, true);
    assert.equal(errors.length, 1);
    assert.equal((errors[0] as Error).message, 'link broke');
  });

  it('returns 0 for a paused event', async () => {
    const b = bus();
    b.on('ping', () => {});
    b.pause('ping');

    assert.equal(await b.emitSequential('ping'), 0);
  });
});

describe('waitFor', () => {
  it('resolves with the next payload', async () => {
    const b = bus();
    setTimeout(() => b.emit('scored', 'zack', 10), 5);

    const [name, points] = await b.waitFor('scored');

    assert.equal(name, 'zack');
    assert.equal(points, 10);
  });

  it('unsubscribes once it resolves', async () => {
    const b = bus();
    setTimeout(() => b.emit('ping'), 5);

    await b.waitFor('ping');

    assert.equal(b.listenerCount('ping'), 0);
  });

  it('rejects and unsubscribes on timeout', async () => {
    const b = bus();

    await assert.rejects(() => b.waitFor('ping', { timeoutMs: 10 }), /Timed out/);
    assert.equal(b.listenerCount('ping'), 0);
  });

  it('rejects when the signal aborts', async () => {
    const b = bus();
    const controller = new AbortController();
    setTimeout(() => controller.abort(new Error('cancelled')), 5);

    await assert.rejects(
      () => b.waitFor('ping', { signal: controller.signal }),
      /cancelled/,
    );
    assert.equal(b.listenerCount('ping'), 0);
  });

  it('rejects immediately when given an already-aborted signal', async () => {
    const b = bus();

    await assert.rejects(
      () => b.waitFor('ping', { signal: AbortSignal.abort(new Error('nope')) }),
      /nope/,
    );
    assert.equal(b.listenerCount('ping'), 0);
  });
});

describe('stream', () => {
  it('yields published payloads in order', async () => {
    const b = bus();
    const seen: number[] = [];

    setTimeout(() => {
      b.emit('tick', 1);
      b.emit('tick', 2);
      b.emit('tick', 3);
    }, 5);

    for await (const [n] of b.stream('tick')) {
      seen.push(n);
      if (seen.length === 3) break;
    }

    assert.deepEqual(seen, [1, 2, 3]);
  });

  it('unsubscribes when the consumer breaks out of the loop', async () => {
    const b = bus();
    setTimeout(() => b.emit('tick', 1), 5);

    for await (const _ of b.stream('tick')) {
      break;
    }

    assert.equal(b.listenerCount('tick'), 0);
  });

  it('buffers events published before the consumer asks for them', async () => {
    const b = bus();
    const stream = b.stream('tick');
    b.emit('tick', 1);
    b.emit('tick', 2);

    assert.deepEqual((await stream.next()).value, [1]);
    assert.deepEqual((await stream.next()).value, [2]);
    await stream.return!();
  });

  it('drops the oldest event once bufferSize is exceeded', async () => {
    const b = bus();
    const stream = b.stream('tick', { bufferSize: 2 });
    b.emit('tick', 1);
    b.emit('tick', 2);
    b.emit('tick', 3);

    assert.deepEqual((await stream.next()).value, [2]);
    assert.deepEqual((await stream.next()).value, [3]);
    await stream.return!();
  });

  it('ends the stream when the signal aborts', async () => {
    const b = bus();
    const controller = new AbortController();
    const seen: number[] = [];

    setTimeout(() => b.emit('tick', 1), 5);
    setTimeout(() => controller.abort(), 15);

    for await (const [n] of b.stream('tick', { signal: controller.signal })) {
      seen.push(n);
    }

    assert.deepEqual(seen, [1]);
    assert.equal(b.listenerCount('tick'), 0);
  });
});

describe('introspection', () => {
  it('reports listener counts and known events, and clears them', () => {
    const b = bus();
    b.on('ping', () => {});
    b.on('ping', () => {});
    b.on('tick', () => {});

    assert.equal(b.listenerCount('ping'), 2);
    assert.equal(b.listenerCount('scored'), 0);
    assert.deepEqual(b.events().sort(), ['ping', 'tick']);

    b.clear('ping');
    assert.equal(b.listenerCount('ping'), 0);
    assert.deepEqual(b.events(), ['tick']);

    b.clear();
    assert.deepEqual(b.events(), []);
  });
});
