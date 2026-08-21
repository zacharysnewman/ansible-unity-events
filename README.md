# Ansible Unity Events

A Pub/Sub Event Aggregator for Unity. It's really an "anything" aggregator, but it's very useful for aggregating events so they can be subscribed and published to without the subscriber and publisher directly referencing each other.

## Why

Systems that react to the same thing shouldn't have to know about each other.

Collecting a coin should play a sound, spawn a particle burst, and increment a
counter. Wire that directly and the coin needs a reference to the audio system,
the VFX system, and the HUD — three references to author, and a fourth the day
someone wants an achievement to fire too. The pickup script grows every time an
unrelated system wants in.

With an aggregator, the coin publishes `CoinCollected` and stops caring. Each
reacting system subscribes on its own. Adding the achievement is a new file and
zero edits to the coin:

    // The coin knows nothing about sound, particles, or UI.
    Ansible.Get<CoinCollected>().Publish(playerId);

Two halves, both deliberate:

- **Fire and forget** — a publisher never learns who listened, or whether
  anyone did.
- **Listen and forget** — a subscriber never learns who published.

Events are strongly typed, so this stays navigable: each event is a real class,
which means *Find All References* on it lists every publisher and every
subscriber across the project. Decoupling costs you nothing in traceability.

### The name

An *ansible* is Ursula K. Le Guin's coinage (*Rocannon's World*, 1966, later
borrowed by Orson Scott Card) — a device for instantaneous communication across
any distance, with no physical link between the endpoints. That's the idea:
messages arrive without the sender and receiver being connected to each other.
No relation to the configuration-management tool of the same name.

## The three event types

- **AnsibleEventSync** — the default. Subscribers run immediately, on the
  calling thread, before `Publish` returns. Use this unless you have a reason
  not to.
- **AnsibleEventAsync** — `Publish` returns a `Task` and subscribers run on the
  thread pool. **Subscribers must not touch the Unity API**, since that is only
  legal on the main thread. Use this for I/O or pure computation only.
- **AnsibleEventCoroutine** — subscribers are coroutines, started via a
  `CoroutineBehaviour` in your scene. Parameters aren't supported, because
  coroutine methods can't receive arguments. See
  [Coroutine events](#coroutine-events) for the required setup.

> **Using this outside Unity?** A TypeScript rewrite for web and Node lives in
> [`web~/`](web~) in this repository and ships to npm as
> [`ansible-events`](https://www.npmjs.com/package/ansible-events). It keeps the
> same publisher/subscriber-decoupling idea, with payload types carried by
> event tokens. See [`web~/README.md`](web~/README.md) for the API and a
> Unity-to-TypeScript migration table.

## Defining Custom Events

Namespace for defining events:

    using AnsibleEvents.Events;

Defining an event:

    public class MySyncEventWithNoParameters : AnsibleEventSync {}

AnsibleEventSync and AnsibleEventAsync events can also be defined with 1-4 parameters:

    public class MySyncEventWithFourParameters : AnsibleEventSync<bool, int, float, string> {}

AnsibleEventCoroutine events can't be defined with parameters because coroutine methods can't receive arguments:

    public class MyCoroutineEvent : AnsibleEventCoroutine {}

## Consuming Events

Namespace for getting and consuming events:

    using AnsibleEvents;

Subscribe to an event:
    
    Ansible.Get<MyEvent>().Subscribe(SomeMethod);
    
Unsubscribe from an event:

    Ansible.Get<MyEvent>().Unsubscribe(SomeMethod);

Publish an event:
    
    Ansible.Get<MyEvent>().Publish(SomeValue);

## Example

Consuming within a MonoBehaviour:

    private void OnEnable()
    {
        Ansible.Get<MyEvent>().Subscribe(OnMyEvent);
    }
    
    private void OnDisable()
    {
        Ansible.Get<MyEvent>().Unsubscribe(OnMyEvent);    
    }
    
    private void OnMyEvent()
    {
        Debug.Log("MyEvent was Published");
    }

Publishing within a MonoBehaviour:

    private void Update()
    {
        if(Time.frameCount % 60 == 0)
        {
            Ansible.Get<MyEvent>().Publish();
        }
    }

## Pausing Events

Every event can be suppressed without touching its subscribers. Publishes made
while paused are **dropped, not queued** — nothing replays on resume.

    Ansible.Get<MyEvent>().Pause();
    Ansible.Get<MyEvent>().Publish();   // no subscriber runs
    Ansible.Get<MyEvent>().Resume();

Useful for cutscenes, menus, or anything that should freeze one channel of
gameplay reactions without unsubscribing everything.

## Coroutine events

`AnsibleEventCoroutine` starts its subscribers through a shared
`CoroutineBehaviour`, so **one `CoroutineBehaviour` component must exist in the
scene** before any coroutine event is published. Without it, `Publish` throws a
`NullReferenceException`. Exactly one — a second instance throws on `Awake`.

Note also that subscribers are `IEnumerator` *instances*, and an `IEnumerator`
can only be walked once. After the first publish drains it, later publishes
hand `StartCoroutine` an already-exhausted enumerator, so it completes
immediately. Treat coroutine subscriptions as one-shot, or re-subscribe a fresh
enumerator each time.

## Unsubscribing matters

`Ansible` is static, so it outlives your GameObjects and survives scene loads.
A subscription you never remove keeps a dead object's method in the invocation
list, and calling it later throws — usually as a
`MissingReferenceException` that points nowhere near the real cause.

Pair every `Subscribe` with an `Unsubscribe`, which is why the example above
uses `OnEnable`/`OnDisable` rather than `Start`.

## What this doesn't do

Worth knowing before you build on it:

- **It notifies; it doesn't store.** A subscriber that starts late has missed
  everything published before it existed — there's no replay or last-value. A
  HUD instantiated mid-level reads zero coins until the next pickup. Events are
  for *"this happened"*; current state belongs somewhere else.
- **It's a single static instance.** `Ansible.Get<T>()` always returns the same
  event object process-wide, so local multiplayer publishing `CoinCollected`
  from two players cross-wires their subscribers. `Aggregator` is a public
  class you can instantiate per player, but the static `Ansible` facade gives
  you no way to reach it.
- **Subscriber order is not defined.** Subscribers live in a `HashSet`, whose
  enumeration order is unspecified and does change after removals. Don't build
  anything order-dependent — including lockstep netcode — on top of it.
- **A throwing subscriber cancels the rest.** There's no per-subscriber
  isolation, so the first exception aborts the publish and later subscribers
  silently never run.
- **Publishing during a publish will throw.** Subscribing or unsubscribing from
  inside a handler mutates the collection being iterated, which raises
  `InvalidOperationException`.

For multiplayer specifically: this makes the *presentation* layer easier —
once state is replicated, fanning out to sound, effects, and UI is exactly as
pleasant for remote players as local ones. It does not address authority,
replication scope, serialization, or ordering, which is where the actual
difficulty lives. Events here carry no sender identity, so plan on putting a
player or peer id in the payload from the start rather than retrofitting it
into every signature later.
