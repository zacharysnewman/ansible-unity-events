import type {
  AggregatorOptions,
  AnyEventToken,
  ErrorContext,
  Handler,
  PayloadOf,
  StreamOptions,
  Unsubscribe,
  WaitForOptions,
} from './types.ts';

interface Registration {
  /** The function the caller passed to `on`/`once`, used for identity. */
  readonly handler: Handler<never>;
  /** Removed from the registry immediately before its first invocation. */
  readonly once: boolean;
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as PromiseLike<unknown>).then === 'function'
  );
}

/**
 * A pub/sub hub. Publishers and subscribers reference the aggregator and their
 * shared event tokens, never each other.
 *
 * Construct with {@link createAggregator} rather than `new`.
 */
export class Aggregator {
  /**
   * token -> (caller's handler -> registration).
   *
   * Keyed by token identity, mirroring the Unity package's
   * `Dictionary<Type, object>`. The inner map is keyed by the original handler
   * so `on` can dedupe and `off` can find a registration in O(1), while
   * preserving insertion order for dispatch.
   */
  readonly #registry = new Map<AnyEventToken, Map<Handler<never>, Registration>>();
  readonly #paused = new Set<AnyEventToken>();
  #allPaused = false;
  readonly #onError: ((error: unknown, context: ErrorContext) => void) | undefined;

  constructor(options: AggregatorOptions = {}) {
    this.#onError = options.onError;
  }

  /**
   * Subscribes to an event. Subscribing the same function twice is a no-op,
   * so a handler never runs more than once per publish.
   *
   * Note that "the same function" means the same reference. Unlike C#
   * delegates, which compare by target and method, two separately created
   * arrow functions or `.bind()` results are always distinct.
   *
   * @returns A function that removes this subscription.
   */
  on<TEvent extends AnyEventToken>(
    event: TEvent,
    handler: Handler<PayloadOf<TEvent>>,
  ): Unsubscribe {
    return this.#add(event, handler, false);
  }

  /**
   * Subscribes for a single publish, then unsubscribes automatically.
   *
   * If the handler is already subscribed via {@link on}, the existing
   * subscription wins and this call is a no-op — a handler is only ever
   * registered once per event.
   */
  once<TEvent extends AnyEventToken>(
    event: TEvent,
    handler: Handler<PayloadOf<TEvent>>,
  ): Unsubscribe {
    return this.#add(event, handler, true);
  }

  /** Removes a subscription. Unsubscribing an unknown handler is a no-op. */
  off<TEvent extends AnyEventToken>(
    event: TEvent,
    handler: Handler<PayloadOf<TEvent>>,
  ): void {
    const handlers = this.#registry.get(event);
    if (handlers === undefined) return;
    handlers.delete(handler as Handler<never>);
    if (handlers.size === 0) this.#registry.delete(event);
  }

  /**
   * Publishes an event, invoking every subscriber synchronously in
   * subscription order.
   *
   * Subscribers are snapshotted first, so subscribing or unsubscribing from
   * inside a handler affects the *next* publish, not this one. A subscriber
   * that throws does not prevent the rest from running; see
   * {@link AggregatorOptions.onError}.
   *
   * Promises returned by async subscribers are not awaited — use
   * {@link emitConcurrent} or {@link emitSequential} for that. Their
   * rejections are still reported, never left floating.
   *
   * @returns The number of subscribers invoked. `0` if the event is paused.
   */
  emit<TEvent extends AnyEventToken>(
    event: TEvent,
    ...args: PayloadOf<TEvent>
  ): number {
    const batch = this.#snapshot(event);
    if (batch.length === 0) return 0;

    for (const registration of batch) {
      try {
        const returned = (registration.handler as Handler<PayloadOf<TEvent>>)(...args);
        // An async subscriber rejects rather than throwing, so it would sail
        // past the catch below and surface as an unhandled rejection. Route it
        // to the same place a synchronous throw goes.
        if (isThenable(returned)) {
          returned.then(undefined, (error: unknown) => {
            this.#reportError(error, event, args);
          });
        }
      } catch (error) {
        this.#reportError(error, event, args);
      }
    }
    return batch.length;
  }

  /**
   * Publishes an event, starting every subscriber at once and resolving when
   * they have all settled.
   *
   * Subscribers are started in subscription order but not awaited one at a
   * time, so total latency is that of the slowest subscriber rather than the
   * sum of all of them. Use {@link emitSequential} when a subscriber depends
   * on an earlier one having finished.
   *
   * Rejections are routed to {@link AggregatorOptions.onError} and never
   * reject the returned promise, so one failing subscriber cannot stop the
   * others.
   *
   * @returns The number of subscribers invoked. `0` if the event is paused.
   */
  async emitConcurrent<TEvent extends AnyEventToken>(
    event: TEvent,
    ...args: PayloadOf<TEvent>
  ): Promise<number> {
    const batch = this.#snapshot(event);
    if (batch.length === 0) return 0;

    await Promise.all(
      batch.map(async (registration) => {
        try {
          await (registration.handler as Handler<PayloadOf<TEvent>>)(...args);
        } catch (error) {
          this.#reportError(error, event, args);
        }
      }),
    );
    return batch.length;
  }

  /**
   * Publishes an event, awaiting each subscriber to completion before starting
   * the next, in subscription order.
   *
   * This is the dispatch mode the Unity package's `AnsibleEventAsync.Publish`
   * used. Prefer {@link emitConcurrent} unless subscribers genuinely depend on
   * each other's ordering — total latency here is the sum of every subscriber.
   *
   * A subscriber that rejects is reported to
   * {@link AggregatorOptions.onError} and the chain continues to the next one.
   *
   * @returns The number of subscribers invoked. `0` if the event is paused.
   */
  async emitSequential<TEvent extends AnyEventToken>(
    event: TEvent,
    ...args: PayloadOf<TEvent>
  ): Promise<number> {
    const batch = this.#snapshot(event);
    if (batch.length === 0) return 0;

    for (const registration of batch) {
      try {
        await (registration.handler as Handler<PayloadOf<TEvent>>)(...args);
      } catch (error) {
        this.#reportError(error, event, args);
      }
    }
    return batch.length;
  }

  /**
   * Resolves with the next payload published for an event.
   *
   * This is the web-native replacement for the Unity package's coroutine
   * events: `const [playerId] = await bus.waitFor(CoinCollected)`.
   *
   * Rejects if `timeoutMs` elapses or `signal` aborts. Paused events do not
   * publish, so a `waitFor` on a paused event simply keeps waiting.
   */
  waitFor<TEvent extends AnyEventToken>(
    event: TEvent,
    options: WaitForOptions = {},
  ): Promise<PayloadOf<TEvent>> {
    const { timeoutMs, signal } = options;

    return new Promise<PayloadOf<TEvent>>((resolve, reject) => {
      if (signal?.aborted === true) {
        reject(signal.reason);
        return;
      }

      let timer: ReturnType<typeof setTimeout> | undefined;

      const settle = (): void => {
        this.off(event, handler);
        if (timer !== undefined) clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
      };

      const handler = ((...args: PayloadOf<TEvent>): void => {
        settle();
        resolve(args);
      }) as Handler<PayloadOf<TEvent>>;

      const onAbort = (): void => {
        settle();
        reject(signal?.reason);
      };

      this.on(event, handler);
      signal?.addEventListener('abort', onAbort, { once: true });

      if (timeoutMs !== undefined) {
        timer = setTimeout(() => {
          settle();
          reject(
            new Error(
              `Timed out after ${timeoutMs}ms waiting for "${event.name}"`,
            ),
          );
        }, timeoutMs);
      }
    });
  }

  /**
   * Consumes an event as an async iterable:
   *
   * ```ts
   * for await (const [playerId] of bus.stream(CoinCollected)) { ... }
   * ```
   *
   * Events published while the consumer is busy are buffered (see
   * {@link StreamOptions.bufferSize}). Breaking out of the loop, returning, or
   * throwing unsubscribes.
   */
  stream<TEvent extends AnyEventToken>(
    event: TEvent,
    options: StreamOptions = {},
  ): AsyncIterableIterator<PayloadOf<TEvent>> {
    const { bufferSize = Infinity, signal } = options;
    const buffer: PayloadOf<TEvent>[] = [];
    const waiting: ((result: IteratorResult<PayloadOf<TEvent>>) => void)[] = [];
    let done = false;

    const handler = ((...args: PayloadOf<TEvent>): void => {
      const next = waiting.shift();
      if (next !== undefined) {
        next({ value: args, done: false });
        return;
      }
      buffer.push(args);
      if (buffer.length > bufferSize) buffer.shift();
    }) as Handler<PayloadOf<TEvent>>;

    const finish = (): void => {
      if (done) return;
      done = true;
      this.off(event, handler);
      signal?.removeEventListener('abort', finish);
      // Release anyone parked on `next()`.
      for (const resolve of waiting.splice(0)) {
        resolve({ value: undefined, done: true });
      }
    };

    if (signal?.aborted === true) {
      done = true;
    } else {
      this.on(event, handler);
      signal?.addEventListener('abort', finish, { once: true });
    }

    const iterator: AsyncIterableIterator<PayloadOf<TEvent>> = {
      next: (): Promise<IteratorResult<PayloadOf<TEvent>>> => {
        const buffered = buffer.shift();
        if (buffered !== undefined) {
          return Promise.resolve({ value: buffered, done: false });
        }
        if (done) {
          return Promise.resolve({ value: undefined, done: true });
        }
        return new Promise((resolve) => waiting.push(resolve));
      },
      return: (): Promise<IteratorResult<PayloadOf<TEvent>>> => {
        finish();
        return Promise.resolve({ value: undefined, done: true });
      },
      throw: (error?: unknown): Promise<IteratorResult<PayloadOf<TEvent>>> => {
        finish();
        return Promise.reject(error);
      },
      [Symbol.asyncIterator]() {
        return this;
      },
    };
    return iterator;
  }

  /**
   * Suppresses publishes for one event, or for every event when called with
   * no argument. Subscriptions are left intact; publishes made while paused
   * are dropped, not queued.
   */
  pause(event?: AnyEventToken): void {
    if (event === undefined) {
      this.#allPaused = true;
      return;
    }
    this.#paused.add(event);
  }

  /** Reverses {@link pause}. */
  resume(event?: AnyEventToken): void {
    if (event === undefined) {
      this.#allPaused = false;
      this.#paused.clear();
      return;
    }
    this.#paused.delete(event);
  }

  /** Whether publishes for an event are currently suppressed. */
  isPaused(event: AnyEventToken): boolean {
    return this.#allPaused || this.#paused.has(event);
  }

  /** How many subscribers an event has. */
  listenerCount(event: AnyEventToken): number {
    return this.#registry.get(event)?.size ?? 0;
  }

  /**
   * Every event that currently has at least one subscriber. Useful for
   * answering "what is listening right now?" while debugging a fan-out.
   */
  events(): AnyEventToken[] {
    return [...this.#registry.keys()];
  }

  /**
   * Removes every subscriber for an event, or for all events when called
   * with no argument. Does not change paused state.
   */
  clear(event?: AnyEventToken): void {
    if (event === undefined) {
      this.#registry.clear();
      return;
    }
    this.#registry.delete(event);
  }

  #add<TEvent extends AnyEventToken>(
    event: TEvent,
    handler: Handler<PayloadOf<TEvent>>,
    once: boolean,
  ): Unsubscribe {
    let handlers = this.#registry.get(event);
    if (handlers === undefined) {
      handlers = new Map();
      this.#registry.set(event, handlers);
    }
    const key = handler as Handler<never>;
    if (!handlers.has(key)) {
      handlers.set(key, { handler: key, once });
    }
    return () => {
      this.off(event, handler);
    };
  }

  /**
   * Freezes the subscriber list for a dispatch and retires `once`
   * registrations up front, so a handler cannot be invoked twice even if it
   * republishes the same event.
   */
  #snapshot(event: AnyEventToken): Registration[] {
    if (this.isPaused(event)) return [];

    const handlers = this.#registry.get(event);
    if (handlers === undefined || handlers.size === 0) return [];

    const batch = [...handlers.values()];
    for (const registration of batch) {
      if (registration.once) handlers.delete(registration.handler);
    }
    if (handlers.size === 0) this.#registry.delete(event);
    return batch;
  }

  #reportError(
    error: unknown,
    event: AnyEventToken,
    args: readonly unknown[],
  ): void {
    if (this.#onError === undefined) {
      // Surface it to the platform's unhandled-error path without
      // interrupting the dispatch loop.
      queueMicrotask(() => {
        throw error;
      });
      return;
    }
    this.#onError(error, { event, args });
  }
}

/**
 * Creates an aggregator.
 *
 * Create one per scope that should not share events. A single module-level
 * instance is the usual shape, but a per-player instance is what keeps local
 * multiplayer from cross-wiring — something the Unity package's static
 * `Ansible` class cannot express.
 *
 * @example
 * ```ts
 * // events.ts
 * export const CoinCollected = defineEvent<[playerId: number]>('CoinCollected');
 *
 * // bus.ts
 * export const bus = createAggregator();
 *
 * // anywhere
 * bus.on(CoinCollected, (playerId) => playSound(playerId));
 * bus.emit(CoinCollected, 1);
 * ```
 */
export function createAggregator(options?: AggregatorOptions): Aggregator {
  return new Aggregator(options);
}
