package main

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"strconv"
	"strings"
	"sync"
	"time"
)

const maxReplayEvents = 256

type BridgeEvent struct {
	ID   string `json:"id,omitempty"`
	Seq  uint64 `json:"seq,omitempty"`
	Type string `json:"type"`
	Data any    `json:"data,omitempty"`
}

type EventHub struct {
	mu      sync.Mutex
	epoch   string
	subs    map[chan BridgeEvent]struct{}
	nextSeq uint64
	history []BridgeEvent
	lastQR  string
	ready   *BridgeEvent
}

func newHubEpoch() string {
	var buf [8]byte
	if _, err := rand.Read(buf[:]); err == nil {
		return hex.EncodeToString(buf[:])
	}
	return strconv.FormatInt(time.Now().UnixNano(), 16)
}

func NewEventHub() *EventHub {
	return &EventHub{
		epoch: newHubEpoch(),
		subs:  make(map[chan BridgeEvent]struct{}),
	}
}

func parseEventCursor(cursor, expectedEpoch string) (uint64, bool) {
	c := strings.TrimSpace(cursor)
	if c == "" {
		return 0, false
	}
	parts := strings.SplitN(c, ":", 2)
	if len(parts) != 2 || parts[0] != expectedEpoch {
		return 0, false
	}
	seq, err := strconv.ParseUint(parts[1], 10, 64)
	if err != nil || seq == 0 {
		return 0, false
	}
	return seq, true
}

func (h *EventHub) Publish(evt BridgeEvent) {
	h.mu.Lock()
	defer h.mu.Unlock()

	h.nextSeq++
	evt.Seq = h.nextSeq
	evt.ID = fmt.Sprintf("%s:%d", h.epoch, evt.Seq)

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
	return h.SubscribeWithCursor(buffer, "")
}

func (h *EventHub) SubscribeWithCursor(buffer int, cursor string) (<-chan BridgeEvent, func()) {
	if buffer <= 0 {
		buffer = 64
	}
	ch := make(chan BridgeEvent, buffer)

	h.mu.Lock()
	var replay []BridgeEvent
	if lastSeq, ok := parseEventCursor(cursor, h.epoch); ok {
		for _, evt := range h.history {
			if evt.Seq > lastSeq {
				replay = append(replay, evt)
			}
		}
	} else {
		readyInHistory := false
		if h.ready != nil {
			for _, evt := range h.history {
				if evt.Seq == h.ready.Seq {
					readyInHistory = true
					break
				}
			}
			if !readyInHistory {
				replay = append(replay, *h.ready)
			}
		}
		replay = append(replay, h.history...)
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
