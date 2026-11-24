package main

import (
	"sync"
)

type BridgeEvent struct {
	Type string `json:"type"`
	Data any    `json:"data,omitempty"`
}

type EventHub struct {
	mu      sync.RWMutex
	subs    map[chan BridgeEvent]struct{}
	lastQR  string
	isReady bool
}

func NewEventHub() *EventHub {
	return &EventHub{
		subs: make(map[chan BridgeEvent]struct{}),
	}
}

func (h *EventHub) Publish(evt BridgeEvent) {
	h.mu.Lock()
	switch evt.Type {
	case "qr":
		if m, ok := evt.Data.(map[string]any); ok {
			if code, ok := m["qr"].(string); ok {
				h.lastQR = code
			}
		}
		h.isReady = false
	case "authenticated":
		h.lastQR = ""
	case "ready":
		h.lastQR = ""
		h.isReady = true
	case "disconnected":
		h.isReady = false
	}
	targets := make([]chan BridgeEvent, 0, len(h.subs))
	for ch := range h.subs {
		targets = append(targets, ch)
	}
	h.mu.Unlock()

	for _, ch := range targets {
		select {
		case ch <- evt:
		default:
		}
	}
}

func (h *EventHub) Subscribe(buffer int) (<-chan BridgeEvent, func()) {
	if buffer <= 0 {
		buffer = 64
	}
	ch := make(chan BridgeEvent, buffer)

	h.mu.Lock()
	h.subs[ch] = struct{}{}
	replayQR := h.lastQR
	h.mu.Unlock()

	if replayQR != "" {
		select {
		case ch <- BridgeEvent{Type: "qr", Data: map[string]any{"qr": replayQR}}:
		default:
		}
	}

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
