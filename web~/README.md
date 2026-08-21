# ansible-events

A type-safe pub/sub event aggregator for the web — the TypeScript sibling of
[Ansible Events for Unity](../README.md), which lives in this same repository.

Zero runtime dependencies.

```bash
npm install ansible-events
```

## Why

Systems that react to the same thing shouldn't have to know about each other.

Collecting a coin should play a sound, spawn a particle burst, and increment a
counter. Wire that directly and the pickup needs handles on the audio system,
the effects system, and the HUD — three couplings to author, and a fourth the
day someone wants an achievement to fire too. The pickup grows every time an
unrelated system wants in.

With an aggregator, the coin publishes `CoinCollected` and stops caring. Each
reacting system subscribes on its own, and adding the achievement is a new file
with zero edits to the coin.

Two halves, both deliberate:

- **Fire and forget** — a publisher never learns who listened, or whether
  anyone did.
- **Listen and forget** — a subscriber never learns who published.

## Quick start

Events are **tokens**: values that name an event and carry its payload types.
Declare them in one module — together they are your application's vocabulary of
things that can happen.

```ts
// events.ts
import { defineEvent } from 'ansible-events';

export const CoinCollected = defineEvent<[playerId: number]>('CoinCollected');
export const GameOver = defineEvent('GameOver');
```

```ts
// bus.ts
import { createAggregator } from 'ansible-events';
export const bus = createAggregator();
```

Then publish and subscribe from systems that never import each other:

```ts
// audio.ts
import { bus } from './bus';
import { CoinCollected } from './events';

bus.on(CoinCollected, (playerId) => playPickupSound(playerId));
```

```ts
// coin.ts — knows nothing about audio, effects, or UI
import { bus } from './bus';
import { CoinCollected } from './events';

bus.emit(CoinCollected, playerId);
```

`playerId` is inferred as `number` in both places. Nothing is annotated twice.

```ts
bus.emit(CoinCollected, 'one'); // compile error
bus.emit(CoinCollected);        // compile error: missing payload
```

### Why tokens rather than string keys

Because a token is a real value, *Find All References* on `CoinCollected`
resolves every `emit` and every `on` across the project, and rename-symbol
works. A string key type-checks just as strictly but is invisible to those
tools — the editor can only find the declaration.

That matters more here than it would elsewhere: the entire point of the design
is that reactions to an event are scattered across systems on purpose. Being
able to ask "who reacts to this?" is what keeps decoupling from turning into
opacity.

Tokens are **nominal**: `name` is only a debugging label, so two tokens
declared with the same name are still two different events, exactly as two
identically-named classes would be.

## Subscribing

`on` returns an unsubscribe function, which is usually easier than holding the
handler reference:

```ts
const unsubscribe = bus.on(GameOver, () => showScoreboard());
unsubscribe();
```

It drops straight into framework cleanup:

```ts
useEffect(() => bus.on(CoinCollected, onCoin), []);
```

A handler may ignore trailing payload arguments, or all of them:

```ts
bus.on(CoinCollected, () => incrementTotal());
```

`off(event, handler)` and `once(event, handler)` are also available.

> **Careful with handler identity.** Subscribing the same function twice is a
> no-op, but "the same function" means the same reference. Unlike C# delegates,
> which compare by target and method, every arrow function and every `.bind()`
> produces a new object — so `bus.on(E, () => f())` twice creates *two*
> subscriptions. Hoist the reference, or keep the returned unsubscribe.

## Publishing

Three dispatch modes. They differ **only** in whether the caller awaits
subscribers and in what order subscribers run — error handling is identical
across all three.

| | Awaits subscribers | Order |
|---|---|---|
| `emit` | no | synchronous, in subscription order |
| `emitConcurrent` | yes | all started at once |
| `emitSequential` | yes | one at a time, in subscription order |

```ts
bus.emit(CoinCollected, 1);                  // fire and forget
await bus.emitConcurrent(CoinCollected, 1);  // slowest subscriber
await bus.emitSequential(CoinCollected, 1);  // sum of subscribers
```

Reach for `emitConcurrent` by default. `emitSequential` matters only when a
subscriber genuinely depends on an earlier one having finished, and it costs
the sum of every subscriber's latency rather than the slowest one's.

Async handlers are safe under plain `emit` too: it doesn't await them, but it
does attach a rejection handler, so a failing async subscriber is reported
rather than surfacing as an unhandled rejection.

Each returns the number of subscribers invoked.

## Awaiting a single event

```ts
const [playerId] = await bus.waitFor(CoinCollected);

await bus.waitFor(GameOver, { timeoutMs: 5000 });
await bus.waitFor(GameOver, { signal: controller.signal });
```

## Consuming an event as a stream

```ts
for await (const [playerId] of bus.stream(CoinCollected)) {
  updateCounter(playerId);
  if (done) break; // breaking unsubscribes
}
```

Events published while the consumer is busy are buffered. Pass
`{ bufferSize: n }` to cap the buffer (oldest dropped once full) or
`{ signal }` to end the stream on abort.

## Pausing

Suppresses publishes without touching subscriptions. Publishes made while
paused are dropped, not queued.

```ts
bus.pause(CoinCollected);
bus.emit(CoinCollected, 1); // returns 0, no subscriber runs
bus.resume(CoinCollected);

bus.pause();  // every event
bus.resume(); // every event
```

A `once` subscription is not consumed by a publish that happened while paused.

## Error handling

A subscriber that throws never prevents the others from running. By default the
error is rethrown on an empty microtask so it still reaches `window.onerror` /
`process.on('uncaughtException')`. Pass `onError` to intercept it instead:

```ts
const bus = createAggregator({
  onError: (error, { event, args }) => {
    console.error(`subscriber for "${event.name}" failed`, { error, args });
  },
});
```

## Dispatch is isolated from mutation

The subscriber list is snapshotted before dispatch begins, so subscribing or
unsubscribing from inside a handler affects the *next* publish, not the one in
flight. Handlers that unsubscribe themselves, or clear the aggregator entirely,
are safe.

## Scoping

`createAggregator()` is the only way to get a bus, so having more than one is
the normal shape rather than a workaround. A single module-level instance suits
most apps; a per-player instance is what keeps local multiplayer from
cross-wiring, which the Unity package's static `Ansible` class cannot express.

## API reference

| Member | Description |
|---|---|
| `defineEvent<[...]>(name)` | Declares an event and its payload types. |
| `createAggregator(options?)` | Creates an aggregator. |
| `on(event, handler)` | Subscribes; returns an unsubscribe function. |
| `once(event, handler)` | Subscribes for a single publish. |
| `off(event, handler)` | Unsubscribes. |
| `emit(event, ...args)` | Synchronous dispatch; returns subscriber count. |
| `emitConcurrent(event, ...args)` | Starts all subscribers at once; awaits all. |
| `emitSequential(event, ...args)` | Awaits each subscriber before the next. |
| `waitFor(event, options?)` | Resolves with the next payload. |
| `stream(event, options?)` | Async-iterates payloads. |
| `pause(event?)` / `resume(event?)` | Suppresses/restores publishing. |
| `isPaused(event)` | Whether publishes are suppressed. |
| `listenerCount(event)` | Subscriber count for an event. |
| `events()` | Every token with at least one subscriber. |
| `clear(event?)` | Removes subscribers. |
| `PayloadOf<typeof Token>` | The payload tuple of a token. |

## What this doesn't do

- **It notifies; it doesn't store.** A subscriber that starts late has missed
  everything published before it existed — no replay, no last value. Events are
  for *"this happened"*; current state belongs somewhere else.
- **It carries no sender identity.** If you'll ever need to know *which*
  player or peer an event came from, put it in the payload from the start
  rather than retrofitting it into every signature later.

## Coming from the Unity package

The web version is a rewrite rather than a port, because the C# API's shape is
driven by constraints TypeScript doesn't have. There, each event is a class and
every arity needs its own generic overload, capped at four parameters. Variadic
tuple types express the same thing in one declaration with no arity limit, and
give payload slots real names.

| Unity / C# | Web / TypeScript |
|---|---|
| `class CoinCollected : AnsibleEventSync<int> {}` | `const CoinCollected = defineEvent<[playerId: number]>('CoinCollected')` |
| `Ansible.Get<CoinCollected>()` | `bus` (your exported aggregator) |
| `.Subscribe(Handler)` | `.on(CoinCollected, handler)` |
| `.Unsubscribe(Handler)` | `.off(...)`, or the returned unsubscribe |
| `.Publish(a)` | `.emit(CoinCollected, a)` |
| `AnsibleEventAsync.Publish` | `.emitSequential(...)` — see below |
| `AnsibleEventCoroutine` | `.waitFor(...)` / `.stream(...)` |
| `.Pause()` / `.Resume()` | `.pause(token)` / `.resume(token)` |
| one to four type parameters | any number, via tuple types |
| static `Ansible` | one `createAggregator()` per scope |

Registry keying is the closest parallel: C# keys a `Dictionary<Type, object>`
by `System.Type`, and this keys a `Map` by token identity. Both are nominal, so
neither can collide on a name.

Four behavioral differences are deliberate:

- **Async dispatch order.** `AnsibleEventAsync.Publish` awaits `Task.Run` in a
  loop, so N subscribers cost the *sum* of their durations, and subscribers run
  off the main thread — meaning they can't touch the Unity API at all.
  `emitConcurrent` starts them at once and costs the slowest;
  `emitSequential` preserves the original ordering exactly.
- **Subscriber order.** C# stores subscribers in a `HashSet`, whose
  enumeration order is unspecified. Here it's a `Map`, so subscription order is
  a guarantee.
- **Mutation during dispatch.** The C# version iterates a live `HashSet`, so a
  handler that unsubscribes mid-publish throws `InvalidOperationException`.
  Here the list is snapshotted first, so it's safe.
- **A throwing subscriber.** In C# it aborts the publish and the remaining
  subscribers never run. Here dispatch always completes and the error is
  reported via `onError`.

Coroutine events have no direct equivalent, because coroutines are a Unity
scheduling construct. `waitFor` covers "resume once this happens" and `stream`
covers "keep reacting as these arrive"; both take an `AbortSignal`, which is
closer to what `StopCoroutine` was doing for you, and both are re-armable
rather than one-shot.

## Development

```bash
cd 'web~'
npm install
npm run typecheck   # includes compile-time inference assertions
npm test
npm run build
```

The directory is named `web~` on purpose: Unity's asset importer ignores any
folder whose name ends in `~`, so this TypeScript package is invisible to Unity
projects consuming this repository as a UPM package. It's an ordinary directory
to git, npm, and everything else.

## License

MIT
