declare const phantom: unique symbol;

/**
 * A handle identifying one event and carrying its payload types.
 *
 * Tokens are the web analogue of the Unity package's event classes. There,
 * `class PlayerScored : AnsibleEventSync<string, int> {}` makes the event a
 * named type and the registry is keyed by `System.Type`; here `defineEvent`
 * makes it a named value and the registry is keyed by object identity. Both
 * are nominal: two tokens with the same name are still two different events,
 * exactly as two identically-named C# classes would be.
 *
 * Keying on a value rather than a string literal is what lets an editor answer
 * "which systems react to this event?" — Find All References on a token
 * resolves every `emit` and `on` site, which a string key cannot do.
 */
export interface EventToken<TArgs extends readonly unknown[]> {
  /** Label used in error messages and debugging. Not an identity. */
  readonly name: string;
  /**
   * Phantom type carrier. Never present at runtime — it exists only so the
   * payload tuple has somewhere to live on the type.
   */
  readonly [phantom]: TArgs;
}

/** Any event token, whatever its payload. */
export type AnyEventToken = EventToken<readonly unknown[]>;

/** The payload tuple carried by an event token. */
export type PayloadOf<T extends AnyEventToken> =
  T extends EventToken<infer TArgs> ? TArgs : never;

/**
 * Declares an event.
 *
 * Collect these in one module — the aggregate of them is your application's
 * vocabulary of things that can happen:
 *
 * ```ts
 * // events.ts
 * export const CoinCollected = defineEvent<[playerId: number]>('CoinCollected');
 * export const GameOver = defineEvent<[]>('GameOver');
 * ```
 *
 * @param name Label for debugging. Does not identify the event — two calls
 *   with the same name produce two distinct events.
 */
export function defineEvent<TArgs extends readonly unknown[] = []>(
  name: string,
): EventToken<TArgs> {
  return { name } as EventToken<TArgs>;
}

/** A subscriber. May be async; see {@link Aggregator.emitConcurrent}. */
export type Handler<TArgs extends readonly unknown[]> = (
  ...args: TArgs
) => unknown;

/** Removes the subscription it was returned from. Idempotent. */
export type Unsubscribe = () => void;

/** Context describing which dispatch an error came from. */
export interface ErrorContext {
  /** The event whose dispatch threw. Use `.name` for logging. */
  readonly event: AnyEventToken;
  /** The arguments the event was published with. */
  readonly args: readonly unknown[];
}

export interface AggregatorOptions {
  /**
   * Called when a subscriber throws (or rejects, in any dispatch mode).
   *
   * Dispatch always continues to the remaining subscribers regardless. If this
   * is omitted, the error is rethrown on an empty microtask so it reaches
   * `window.onerror` / `process.on('uncaughtException')` instead of vanishing.
   */
  readonly onError?: (error: unknown, context: ErrorContext) => void;
}

export interface WaitForOptions {
  /** Reject once this many milliseconds elapse. */
  readonly timeoutMs?: number;
  /** Reject when this signal aborts. */
  readonly signal?: AbortSignal;
}

export interface StreamOptions {
  /**
   * How many events to buffer while the consumer is busy. Once full, the
   * oldest buffered event is dropped. Defaults to `Infinity` (never drop).
   */
  readonly bufferSize?: number;
  /** End the stream when this signal aborts. */
  readonly signal?: AbortSignal;
}
