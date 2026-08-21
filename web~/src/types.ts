/**
 * A map of event names to the tuple of arguments each event carries.
 *
 * @example
 * ```ts
 * type AppEvents = {
 *   playerScored: [name: string, points: number];
 *   gameOver: [];
 * };
 * ```
 */
export type EventMap = Record<string, readonly unknown[]>;

/**
 * A subscriber. May be async; see {@link Aggregator.emitConcurrent}.
 *
 * The return type is `unknown` rather than `void | Promise<void>` on purpose.
 * TypeScript only lets a function returning any type be passed where a
 * `void`-returning type is expected; that exemption does not apply to a
 * *union* containing `void`, which would reject ordinary expression-bodied
 * arrows like `() => log.push(x)`. Returned values are ignored, except that
 * the awaiting dispatch modes await them.
 */
export type Handler<TArgs extends readonly unknown[]> = (
  ...args: TArgs
) => unknown;

/** Removes the subscription it was returned from. Idempotent. */
export type Unsubscribe = () => void;

/** Context describing which dispatch an error came from. */
export interface ErrorContext {
  /** The event whose dispatch threw. */
  readonly event: string;
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
