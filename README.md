# Ansible Unity Events

A Pub/Sub Event Aggregator for Unity. It's really an "anything" aggregator, but it's very useful for aggregating events so they can be subscribed and published to without the subscriber and publisher directly referencing each other.

There are 3 different types of events included:
- AnsibleEventSync
- AnsibleEventAsync
- AnsibleEventCoroutine

> **Using this outside Unity?** A TypeScript rewrite for web and Node lives in
> [`web~/`](web~) in this repository and ships to npm as
> [`ansible-events`](https://www.npmjs.com/package/ansible-events). It keeps the
> same publisher/subscriber-decoupling idea, with payload types inferred from a
> single event map. See [`web~/README.md`](web~/README.md) for the API and a
> Unity-to-TypeScript migration table.

## Defining Custom Events

Namespace for defining events:

    using AnsibleEvents.Events;

Defining an event:

    public class MySyncEventWithNoParameters : AnsibleEventSync {}

AnsibleEventSync and AnsibleEventAsync events can also be defined with 1-4 parameters:

    public class MySyncEventWithFourParameters : AnisbleEventSync<bool, int, float, string> {}

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
