package main

import (
	"sync"
)

const maxReplayEvents = 256

type BridgeEvent struct {
	Seq  uint64 `json:"seq,omitempty"`
	Type string `json:"type"`
	Data any    `json:"data,omitempty"`
}

type EventHub struct {
	mu      sync.Mutex
	subs    map[chan BridgeEvent]struct{}
	nextSeq uint64
	history []BridgeEvent
	lastQR  string
	ready   *BridgeEvent
}

func NewEventHub() *EventHub {
	return &EventHub{
		subs: make(map[chan BridgeEvent]struct{}),
	}
}

func (h *EventHub) Publish(evt BridgeEvent) {
	h.mu.Lock()
	defer h.mu.Unlock()

	h.nextSeq++
	evt.Seq = h.nextSeq

	switch evt.Type {
	case "qr":
		if m, ok := evt.Data.(map[string]any); ok {
			if code, ok := m["qr"].(string); ok {
				h.lastQR = code
			}
		}
		h.ready = nil
	case "authenticated", "auth_failure":
		h.lastQR = ""
	case "ready":
		h.lastQR = ""
		copied := evt
		h.ready = &copied
	case "disconnected":
		h.lastQR = ""
		h.ready = nil
	}

	if evt.Type != "qr" {
		h.history = append(h.history, evt)
		if len(h.history) > maxReplayEvents {
			h.history = h.history[len(h.history)-maxReplayEvents:]
		}
	}

	for ch := range h.subs {
		select {
		case ch <- evt:
		default:
		}
	}
}

func (h *EventHub) Subscribe(buffer int) (<-chan BridgeEvent, func()) {
	return h.SubscribeSince(buffer, 0)
}

func (h *EventHub) SubscribeSince(buffer int, lastSeq uint64) (<-chan BridgeEvent, func()) {
	if buffer <= 0 {
		buffer = 64
	}
	ch := make(chan BridgeEvent, buffer)

	h.mu.Lock()
	var replay []BridgeEvent
	if lastSeq > 0 {
		for _, evt := range h.history {
			if evt.Seq > lastSeq {
				replay = append(replay, evt)
			}
		}
	} else {
		if len(h.history) > 0 {
			replay = append(replay, h.history...)
		} else if h.ready != nil {
			replay = append(replay, *h.ready)
		}
	}
	if h.lastQR != "" {
		replay = append(replay, BridgeEvent{
			Type: "qr",
			Data: map[string]any{"qr": h.lastQR},
		})
	}
	for _, evt := range replay {
		select {
		case ch <- evt:
		default:
		}
	}
	h.subs[ch] = struct{}{}
	h.mu.Unlock()

	cancel := func() {
		h.mu.Lock()
		if _, ok := h.subs[ch]; ok {
			delete(h.subs, ch)
			close(ch)
		}
		h.mu.Unlock()
	}
	return ch, cancel
}
