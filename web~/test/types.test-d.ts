/**
 * Compile-time assertions. This file is type-checked, never executed —
 * `npm run typecheck` fails if inference regresses.
 */
import { createAggregator, defineEvent } from '../src/index.ts';
import type { PayloadOf } from '../src/index.ts';

const Scored = defineEvent<[name: string, points: number]>('Scored');
const GameOver = defineEvent('GameOver');
const Payload = defineEvent<[{ id: number; tags: string[] }]>('Payload');

const bus = createAggregator();

/** Fails to compile unless T and U are identical. */
type Exact<T, U> = [T] extends [U] ? ([U] extends [T] ? true : false) : false;
const assertExact = <T, U>(_ok: Exact<T, U>): void => {};

// Handler parameters are inferred positionally from the token's tuple.
bus.on(Scored, (name, points) => {
  assertExact<typeof name, string>(true);
  assertExact<typeof points, number>(true);
});

// A token declared with no payload infers a zero-argument handler.
bus.on(GameOver, (...args) => {
  assertExact<typeof args, []>(true);
});

// A handler may ignore trailing payload arguments, or all of them. Inference
// must come from the token alone — if the handler's arity drove it, these
// would resolve the payload to [] or [string] and reject the token.
bus.on(Scored, () => {});
bus.on(Scored, (name) => {
  assertExact<typeof name, string>(true);
});
bus.emit(Scored, 'zack', 10);

// Object payloads keep their shape.
bus.on(Payload, (value) => {
  assertExact<typeof value, { id: number; tags: string[] }>(true);
});

// emit is variadic over the same tuple.
bus.emit(Scored, 'zack', 10);
bus.emit(GameOver);
bus.emit(Payload, { id: 1, tags: ['a'] });

// waitFor resolves to the whole tuple.
const scoredPayload = await bus.waitFor(Scored);
assertExact<typeof scoredPayload, [name: string, points: number]>(true);

// stream yields the whole tuple.
for await (const value of bus.stream(Scored)) {
  assertExact<typeof value, [name: string, points: number]>(true);
  break;
}

// PayloadOf recovers the tuple from a token.
assertExact<PayloadOf<typeof Scored>, [name: string, points: number]>(true);
assertExact<PayloadOf<typeof GameOver>, []>(true);

// emit returns the number of subscribers invoked.
assertExact<ReturnType<typeof bus.emit<typeof GameOver>>, number>(true);

// on returns an unsubscribe function.
const unsubscribe = bus.on(GameOver, () => {});
assertExact<typeof unsubscribe, () => void>(true);

// Tokens are nominal: two tokens sharing a name are still distinct events,
// and a token's payload type is not interchangeable with another's.
const alsoScored = defineEvent<[flag: boolean]>('Scored');
// @ts-expect-error payload tuples differ despite the identical name
const wrong: typeof Scored = alsoScored;
void wrong;

// @ts-expect-error wrong argument type
bus.emit(Scored, 'zack', 'ten');
// @ts-expect-error too few arguments
bus.emit(Scored, 'zack');
// @ts-expect-error zero-payload event takes no arguments
bus.emit(GameOver, 1);
// @ts-expect-error handler parameter type must match the tuple
bus.on(Scored, (_name: number) => {});
// @ts-expect-error a bare string is not a token
bus.emit('Scored', 'zack', 10);
// @ts-expect-error a bare string is not a token
bus.on('Scored', () => {});
