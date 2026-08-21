/**
 * Compile-time assertions. This file is type-checked, never executed —
 * `npm run typecheck` fails if inference regresses.
 */
import { createAggregator } from '../src/index.ts';

type AppEvents = {
  scored: [name: string, points: number];
  ping: [];
  payload: [{ id: number; tags: string[] }];
};

const bus = createAggregator<AppEvents>();

/** Fails to compile unless T and U are identical. */
type Exact<T, U> = [T] extends [U] ? ([U] extends [T] ? true : false) : false;
const assertExact = <T, U>(_ok: Exact<T, U>): void => {};

// Handler parameters are inferred positionally from the tuple.
bus.on('scored', (name, points) => {
  assertExact<typeof name, string>(true);
  assertExact<typeof points, number>(true);
});

// Zero-argument events infer a zero-argument handler.
bus.on('ping', (...args) => {
  assertExact<typeof args, []>(true);
});

// Object payloads keep their shape.
bus.on('payload', (value) => {
  assertExact<typeof value, { id: number; tags: string[] }>(true);
});

// emit is variadic over the same tuple.
bus.emit('scored', 'zack', 10);
bus.emit('ping');
bus.emit('payload', { id: 1, tags: ['a'] });

// waitFor resolves to the whole tuple.
const scoredPayload = await bus.waitFor('scored');
assertExact<typeof scoredPayload, [name: string, points: number]>(true);

// stream yields the whole tuple.
for await (const value of bus.stream('scored')) {
  assertExact<typeof value, [name: string, points: number]>(true);
  break;
}

// emit returns the number of subscribers invoked.
assertExact<ReturnType<typeof bus.emit<'ping'>>, number>(true);

// on returns an unsubscribe function.
const unsubscribe = bus.on('ping', () => {});
assertExact<typeof unsubscribe, () => void>(true);

// @ts-expect-error unknown event name
bus.emit('nope');
// @ts-expect-error wrong argument type
bus.emit('scored', 'zack', 'ten');
// @ts-expect-error too few arguments
bus.emit('scored', 'zack');
// @ts-expect-error zero-arg event takes no payload
bus.emit('ping', 1);
// @ts-expect-error handler parameter type must match the tuple
bus.on('scored', (_name: number) => {});
// @ts-expect-error unknown event name on subscribe
bus.on('nope', () => {});
