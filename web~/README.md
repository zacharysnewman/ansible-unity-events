# ansible-events

A type-safe pub/sub event aggregator for the web — the TypeScript sibling of
[Ansible Events for Unity](../README.md), which lives in this same repository.

Publishers and subscribers never reference each other; both reference the
aggregator. Zero runtime dependencies.

```bash
npm install ansible-events
```

## Quick start

Declare your events as a map of names to payload tuples, and the whole API
infers from it:

```ts
import { createAggregator } from 'ansible-events';

type AppEvents = {
  playerScored: [name: string, points: number];
  gameOver: [];
};

export const bus = createAggregator<AppEvents>();

// `name` is string and `points` is number — inferred, not annotated.
bus.on('playerScored', (name, points) => {
  console.log(`${name} scored ${points}`);
});

bus.emit('playerScored', 'zack', 10);

bus.emit('playerScored', 'zack', 'ten'); // compile error
bus.emit('playerScore', 'zack', 10);     // compile error: unknown event
```

Exporting a single `bus` module is the web equivalent of the Unity package's
static `Ansible` class. Nothing stops you from creating several aggregators if
you want isolated scopes — per-feature, or one per test.

## Subscribing

`on` returns an unsubscribe function, which is usually more convenient than
holding onto the handler reference:

```ts
const unsubscribe = bus.on('gameOver', () => console.log('done'));
unsubscribe();
```

It works directly with framework cleanup:

```ts
useEffect(() => bus.on('playerScored', onScored), []);
```

Subscribing the same function twice is a no-op, so a handler never runs more
than once per publish. `off(event, handler)` and `once(event, handler)` are
also available.

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
bus.emit('playerScored', 'zack', 10);                  // fire and forget
await bus.emitConcurrent('playerScored', 'zack', 10);  // slowest subscriber
await bus.emitSequential('playerScored', 'zack', 10);  // sum of subscribers
```

Reach for `emitConcurrent` by default. `emitSequential` matters only when a
subscriber genuinely depends on an earlier one having finished, and it costs
the sum of every subscriber's latency rather than the slowest one's.

Async handlers are safe under plain `emit` too: it does not await them, but it
does attach a rejection handler, so a failing async subscriber is reported
rather than surfacing as an unhandled rejection.

Each returns the number of subscribers invoked.

## Awaiting a single event

`waitFor` resolves with the next payload, with optional timeout and
`AbortSignal`:

```ts
const [name, points] = await bus.waitFor('playerScored');

await bus.waitFor('gameOver', { timeoutMs: 5000 });
await bus.waitFor('gameOver', { signal: controller.signal });
```

## Consuming an event as a stream

```ts
for await (const [name, points] of bus.stream('playerScored')) {
  console.log(name, points);
  if (points > 100) break; // breaking unsubscribes
}
```

Events published while the consumer is busy are buffered. Pass
`{ bufferSize: n }` to cap the buffer (oldest dropped once full) or
`{ signal }` to end the stream on abort.

## Pausing

Suppresses publishes without touching subscriptions. Publishes made while
paused are dropped, not queued.

```ts
bus.pause('playerScored');
bus.emit('playerScored', 'zack', 10); // returns 0, no subscriber runs
bus.resume('playerScored');

bus.pause();  // every event
bus.resume(); // every event
```

A `once` subscription is not consumed by a publish that happened while paused.

## Error handling

A subscriber that throws never prevents the others from running. By default the
error is rethrown on an empty microtask so it still reaches `window.onerror` /
`process.on('uncaughtException')` instead of vanishing. Pass `onError` to
intercept it instead:

```ts
const bus = createAggregator<AppEvents>({
  onError: (error, { event, args }) => {
    console.error(`subscriber for "${event}" failed`, { error, args });
  },
});
```

## Dispatch is isolated from mutation

The subscriber list is snapshotted before dispatch begins, so subscribing or
unsubscribing from inside a handler affects the *next* publish, not the one in
flight. Handlers that unsubscribe themselves, or clear the aggregator entirely,
are safe.

## API reference

| Member | Description |
|---|---|
| `createAggregator<T>(options?)` | Creates a typed aggregator. |
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
| `events()` | Every event with at least one subscriber. |
| `clear(event?)` | Removes subscribers. |

## Coming from the Unity package

The web version is a rewrite rather than a port, because the C# API's shape is
driven by constraints TypeScript does not have. In Unity, each event is a class
(`class MyEvent : AnsibleEventSync<bool, int> {}`) and every arity needs its own
generic overload, capped at four parameters. TypeScript's variadic tuple types
express the same thing in one declaration with no arity limit.

| Unity / C# | Web / TypeScript |
|---|---|
| `class MyEvent : AnsibleEventSync<string, int> {}` | `type AppEvents = { myEvent: [string, number] }` |
| `Ansible.Get<MyEvent>()` | `bus` (your exported aggregator) |
| `.Subscribe(Handler)` | `.on('myEvent', handler)` |
| `.Unsubscribe(Handler)` | `.off('myEvent', handler)` or the returned unsubscribe |
| `.Publish(a, b)` | `.emit('myEvent', a, b)` |
| `AnsibleEventAsync.Publish` | `.emitSequential(...)` — see below |
| `AnsibleEventCoroutine` | `.waitFor(...)` / `.stream(...)` |
| `.Pause()` / `.Resume()` | `.pause('myEvent')` / `.resume('myEvent')` |
| one to four type parameters | any number, via tuple types |

Three behavioral differences are deliberate, not incidental:

- **Async dispatch order.** `AnsibleEventAsync.Publish` awaits `Task.Run` in a
  loop, so N subscribers take the *sum* of their durations. `emitConcurrent`
  starts them at once and takes the slowest. If you were relying on the
  sequential ordering, `emitSequential` preserves it exactly.
- **Mutation during dispatch.** The C# version iterates a live `HashSet`, so a
  handler that unsubscribes mid-publish throws
  `InvalidOperationException`. Here the list is snapshotted first, so it is
  safe.
- **A throwing subscriber.** In C# it aborts the publish and the remaining
  subscribers never run. Here dispatch always completes and the error is
  reported via `onError`.

Coroutine events have no direct equivalent because coroutines are a Unity
scheduling construct. `waitFor` covers "resume once this happens" and `stream`
covers "keep reacting as these arrive"; both are cancellable with an
`AbortSignal`, which is closer to what `StopCoroutine` was doing for you.

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
projects that consume this repository as a UPM package. It is an ordinary
directory to git, npm, and everything else.

## License

MIT
