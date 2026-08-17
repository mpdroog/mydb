// Package bus is a tiny fan-out pub/sub used to push state changes to the
// browser over SSE. A subscriber that cannot keep up loses events rather
// than blocking the publisher, because nothing server-side may ever stall
// on a slow browser.
package bus

import "sync"

// Bus fans values out to every current subscriber.
type Bus[T any] struct {
	subs   map[uint64]chan T
	next   uint64
	buf    int
	mu     sync.Mutex
	closed bool
}

// New returns a Bus giving each subscriber a buffer of buf events.
func New[T any](buf int) *Bus[T] {
	if buf < 1 {
		buf = 1
	}
	return &Bus[T]{subs: make(map[uint64]chan T), buf: buf}
}

// Subscribe returns a channel of events and the func that unsubscribes it.
// The channel is closed once unsubscribed or once the Bus is closed.
func (b *Bus[T]) Subscribe() (<-chan T, func()) {
	b.mu.Lock()
	defer b.mu.Unlock()

	ch := make(chan T, b.buf)
	if b.closed {
		close(ch)
		return ch, func() {}
	}
	id := b.next
	b.next++
	b.subs[id] = ch

	return ch, func() {
		b.mu.Lock()
		defer b.mu.Unlock()
		if sub, ok := b.subs[id]; ok {
			delete(b.subs, id)
			close(sub)
		}
	}
}

// Publish delivers v to every subscriber with room left, dropping it for
// the ones that fell behind.
func (b *Bus[T]) Publish(v T) {
	b.mu.Lock()
	defer b.mu.Unlock()
	for _, ch := range b.subs {
		select {
		case ch <- v:
		default:
		}
	}
}

// Close drops every subscriber. Further Subscribe calls hand back a closed
// channel, further Publish calls are no-ops.
func (b *Bus[T]) Close() {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.closed {
		return
	}
	b.closed = true
	for id, ch := range b.subs {
		delete(b.subs, id)
		close(ch)
	}
}
