package main

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"strings"
	"time"
)

const maxJSONBodyBytes = 1 << 20

type HealthStatus struct {
	OK             bool   `json:"ok"`
	State          string `json:"state"`
	Connected      bool   `json:"connected"`
	LoggedIn       bool   `json:"loggedIn"`
	ContactsSynced bool   `json:"contactsSynced"`
	SelfWid        string `json:"selfWid,omitempty"`
	SelfLid        string `json:"selfLid,omitempty"`
}

type ContactResponse struct {
	ID             string `json:"id"`
	Number         string `json:"number,omitempty"`
	Name           string `json:"name,omitempty"`
	Pushname       string `json:"pushname,omitempty"`
	IsMyContact    *bool  `json:"isMyContact"`
	IsMe           bool   `json:"isMe"`
	ContactsSynced bool   `json:"contactsSynced"`
}

type LidMapping struct {
	Lid string `json:"lid,omitempty"`
	Pn  string `json:"pn,omitempty"`
}

type BridgeBackend interface {
	Health() HealthStatus
	Events() *EventHub
	GetContact(ctx context.Context, rawID string) (*ContactResponse, error)
	ResolveLidMappings(ctx context.Context, ids []string) ([]LidMapping, error)
	SendText(ctx context.Context, chatID, text string) (string, error)
	SendPoll(ctx context.Context, chatID, name string, options []string, allowMultiple bool) (string, error)
	ForwardMessage(ctx context.Context, messageID, targetChatID string) (string, error)
	ArchiveChat(ctx context.Context, chatID string, archived bool) error
	MuteChat(ctx context.Context, chatID string, muted bool) error
	BlockContact(ctx context.Context, id string, blocked bool) error
	SetContactLabel(ctx context.Context, phone, name string) error
}

func isLoopbackHost(host string) bool {
	h := strings.TrimSpace(strings.ToLower(host))
	h = strings.TrimPrefix(strings.TrimSuffix(h, "]"), "[")
	if h == "localhost" {
		return true
	}
	ip := net.ParseIP(h)
	return ip != nil && ip.IsLoopback()
}

func NewBridgeHandler(backend BridgeBackend, token string) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /health", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, backend.Health())
	})

	authed := func(h http.HandlerFunc) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) {
			if token != "" {
				got := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
				if got == r.Header.Get("Authorization") || subtle.ConstantTimeCompare([]byte(got), []byte(token)) != 1 {
					writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
					return
				}
			}
			h(w, r)
		}
	}

	mux.HandleFunc("GET /v1/events", authed(func(w http.ResponseWriter, r *http.Request) {
		flusher, ok := w.(http.Flusher)
		if !ok {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "streaming unsupported"})
			return
		}
		w.Header().Set("Content-Type", "text/event-stream")
		w.Header().Set("Cache-Control", "no-cache")
		w.Header().Set("Connection", "keep-alive")
		w.WriteHeader(http.StatusOK)
		flusher.Flush()

		ch, cancel := backend.Events().Subscribe(128)
		defer cancel()

		keepalive := time.NewTicker(20 * time.Second)
		defer keepalive.Stop()

		for {
			select {
			case <-r.Context().Done():
				return
			case <-keepalive.C:
				if _, err := io.WriteString(w, ": ping\n\n"); err != nil {
					return
				}
				flusher.Flush()
			case evt, open := <-ch:
				if !open {
					return
				}
				payload, err := json.Marshal(evt)
				if err != nil {
					continue
				}
				if _, err := fmt.Fprintf(w, "event: %s\ndata: %s\n\n", evt.Type, payload); err != nil {
					return
				}
				flusher.Flush()
			}
		}
	}))

	mux.HandleFunc("GET /v1/contact", authed(func(w http.ResponseWriter, r *http.Request) {
		id := strings.TrimSpace(r.URL.Query().Get("id"))
		if id == "" {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "id query parameter is required"})
			return
		}
		contact, err := backend.GetContact(r.Context(), id)
		if err != nil {
			writeJSON(w, statusForError(err), map[string]string{"error": err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, contact)
	}))

	mux.HandleFunc("POST /v1/lid/resolve", authed(func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			IDs []string `json:"ids"`
		}
		if !decodeJSONBody(w, r, &req) {
			return
		}
		mappings, err := backend.ResolveLidMappings(r.Context(), req.IDs)
		if err != nil {
			writeJSON(w, statusForError(err), map[string]string{"error": err.Error()})
			return
		}
		if mappings == nil {
			mappings = []LidMapping{}
		}
		writeJSON(w, http.StatusOK, map[string]any{"mappings": mappings})
	}))

	mux.HandleFunc("POST /v1/send/text", authed(func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			ChatID string `json:"chatId"`
			Text   string `json:"text"`
		}
		if !decodeJSONBody(w, r, &req) {
			return
		}
		if strings.TrimSpace(req.ChatID) == "" || req.Text == "" {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "chatId and text are required"})
			return
		}
		id, err := backend.SendText(r.Context(), req.ChatID, req.Text)
		if err != nil {
			writeJSON(w, statusForError(err), map[string]string{"error": err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, map[string]string{"id": id})
	}))

	mux.HandleFunc("POST /v1/send/poll", authed(func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			ChatID               string   `json:"chatId"`
			Name                 string   `json:"name"`
			Options              []string `json:"options"`
			AllowMultipleAnswers bool     `json:"allowMultipleAnswers"`
		}
		if !decodeJSONBody(w, r, &req) {
			return
		}
		if strings.TrimSpace(req.ChatID) == "" || strings.TrimSpace(req.Name) == "" || len(req.Options) < 2 {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "chatId, name, and at least 2 options are required"})
			return
		}
		id, err := backend.SendPoll(r.Context(), req.ChatID, req.Name, req.Options, req.AllowMultipleAnswers)
		if err != nil {
			writeJSON(w, statusForError(err), map[string]string{"error": err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, map[string]string{"id": id})
	}))

	mux.HandleFunc("POST /v1/message/forward", authed(func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			MessageID    string `json:"messageId"`
			TargetChatID string `json:"targetChatId"`
		}
		if !decodeJSONBody(w, r, &req) {
			return
		}
		if strings.TrimSpace(req.MessageID) == "" || strings.TrimSpace(req.TargetChatID) == "" {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "messageId and targetChatId are required"})
			return
		}
		id, err := backend.ForwardMessage(r.Context(), req.MessageID, req.TargetChatID)
		if err != nil {
			writeJSON(w, statusForError(err), map[string]string{"error": err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, map[string]string{"id": id})
	}))

	mux.HandleFunc("POST /v1/chat/archive", authed(func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			ChatID   string `json:"chatId"`
			Archived *bool  `json:"archived"`
		}
		if !decodeJSONBody(w, r, &req) {
			return
		}
		if strings.TrimSpace(req.ChatID) == "" {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "chatId is required"})
			return
		}
		archived := true
		if req.Archived != nil {
			archived = *req.Archived
		}
		if err := backend.ArchiveChat(r.Context(), req.ChatID, archived); err != nil {
			writeJSON(w, statusForError(err), map[string]string{"error": err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
	}))

	mux.HandleFunc("POST /v1/chat/mute", authed(func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			ChatID string `json:"chatId"`
			Muted  *bool  `json:"muted"`
		}
		if !decodeJSONBody(w, r, &req) {
			return
		}
		if strings.TrimSpace(req.ChatID) == "" {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "chatId is required"})
			return
		}
		muted := true
		if req.Muted != nil {
			muted = *req.Muted
		}
		if err := backend.MuteChat(r.Context(), req.ChatID, muted); err != nil {
			writeJSON(w, statusForError(err), map[string]string{"error": err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
	}))

	mux.HandleFunc("POST /v1/contact/block", authed(func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			ID      string `json:"id"`
			Blocked *bool  `json:"blocked"`
		}
		if !decodeJSONBody(w, r, &req) {
			return
		}
		if strings.TrimSpace(req.ID) == "" {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "id is required"})
			return
		}
		blocked := true
		if req.Blocked != nil {
			blocked = *req.Blocked
		}
		if err := backend.BlockContact(r.Context(), req.ID, blocked); err != nil {
			writeJSON(w, statusForError(err), map[string]string{"error": err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
	}))

	mux.HandleFunc("POST /v1/contact/label", authed(func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			Phone string `json:"phone"`
			Name  string `json:"name"`
		}
		if !decodeJSONBody(w, r, &req) {
			return
		}
		if digitsOnly(req.Phone) == "" {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "phone is required"})
			return
		}
		if err := backend.SetContactLabel(r.Context(), req.Phone, req.Name); err != nil {
			writeJSON(w, statusForError(err), map[string]string{"error": err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
	}))

	return mux
}

var (
	errNotReady   = errors.New("whatsapp client not ready")
	errBadRequest = errors.New("bad request")
	errNotFound   = errors.New("not found")
)

func statusForError(err error) int {
	switch {
	case errors.Is(err, errBadRequest):
		return http.StatusBadRequest
	case errors.Is(err, errNotFound):
		return http.StatusNotFound
	case errors.Is(err, errNotReady):
		return http.StatusServiceUnavailable
	default:
		return http.StatusInternalServerError
	}
}

func decodeJSONBody(w http.ResponseWriter, r *http.Request, dst any) bool {
	r.Body = http.MaxBytesReader(w, r.Body, maxJSONBodyBytes)
	dec := json.NewDecoder(r.Body)
	if err := dec.Decode(dst); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return false
	}
	return true
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}
