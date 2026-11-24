package main

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"time"
)

const (
	maxStoredPolls    = 5000
	maxStoredMessages = 10000
)

type StoredMessage struct {
	ID        string
	ChatJID   string
	SenderJID string
	FromMe    bool
	Body      string
	Timestamp time.Time
}

type BridgeStore struct {
	db *sql.DB
}

func NewBridgeStore(ctx context.Context, db *sql.DB) (*BridgeStore, error) {
	if db == nil {
		return nil, errors.New("sqlite db is required")
	}
	schema := `
CREATE TABLE IF NOT EXISTS bridge_polls (
	poll_id TEXT PRIMARY KEY,
	chat_jid TEXT NOT NULL,
	options_json TEXT NOT NULL,
	created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_bridge_polls_created ON bridge_polls(created_at);

CREATE TABLE IF NOT EXISTS bridge_messages (
	msg_id TEXT PRIMARY KEY,
	chat_jid TEXT NOT NULL,
	sender_jid TEXT NOT NULL,
	from_me INTEGER NOT NULL,
	body TEXT NOT NULL,
	ts_unix INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_bridge_messages_chat_ts ON bridge_messages(chat_jid, ts_unix DESC);
CREATE INDEX IF NOT EXISTS idx_bridge_messages_ts ON bridge_messages(ts_unix);
`
	if _, err := db.ExecContext(ctx, schema); err != nil {
		return nil, fmt.Errorf("init bridge schema: %w", err)
	}
	return &BridgeStore{db: db}, nil
}

func (s *BridgeStore) SavePollOptions(ctx context.Context, pollID, chatJID string, options []string) error {
	if pollID == "" {
		return errors.New("poll_id is required")
	}
	encoded, err := json.Marshal(options)
	if err != nil {
		return fmt.Errorf("marshal poll options: %w", err)
	}
	now := time.Now().UnixMilli()
	_, err = s.db.ExecContext(
		ctx,
		`INSERT INTO bridge_polls(poll_id, chat_jid, options_json, created_at)
		 VALUES (?, ?, ?, ?)
		 ON CONFLICT(poll_id) DO UPDATE SET chat_jid = excluded.chat_jid, options_json = excluded.options_json, created_at = excluded.created_at`,
		pollID, chatJID, string(encoded), now,
	)
	if err != nil {
		return fmt.Errorf("save poll options: %w", err)
	}
	_, _ = s.db.ExecContext(
		ctx,
		`DELETE FROM bridge_polls WHERE poll_id NOT IN (
			SELECT poll_id FROM bridge_polls ORDER BY created_at DESC LIMIT ?
		)`,
		maxStoredPolls,
	)
	return nil
}

func (s *BridgeStore) GetPollOptions(ctx context.Context, pollID string) ([]string, bool, error) {
	if pollID == "" {
		return nil, false, nil
	}
	var raw string
	err := s.db.QueryRowContext(ctx, `SELECT options_json FROM bridge_polls WHERE poll_id = ?`, pollID).Scan(&raw)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, fmt.Errorf("query poll options: %w", err)
	}
	var options []string
	if err := json.Unmarshal([]byte(raw), &options); err != nil {
		return nil, false, fmt.Errorf("unmarshal poll options: %w", err)
	}
	return options, true, nil
}

func ResolvePollVoteOptions(options []string, selectedHashes [][]byte) []string {
	if len(options) == 0 || len(selectedHashes) == 0 {
		return nil
	}
	byHash := make(map[string]string, len(options))
	for _, opt := range options {
		sum := sha256.Sum256([]byte(opt))
		byHash[hex.EncodeToString(sum[:])] = opt
	}
	resolved := make([]string, 0, len(selectedHashes))
	for _, h := range selectedHashes {
		if name, ok := byHash[hex.EncodeToString(h)]; ok {
			resolved = append(resolved, name)
		}
	}
	return resolved
}

func (s *BridgeStore) SaveMessage(ctx context.Context, msg StoredMessage) error {
	if msg.ID == "" {
		return nil
	}
	fromMe := 0
	if msg.FromMe {
		fromMe = 1
	}
	ts := msg.Timestamp
	if ts.IsZero() {
		ts = time.Now()
	}
	_, err := s.db.ExecContext(
		ctx,
		`INSERT INTO bridge_messages(msg_id, chat_jid, sender_jid, from_me, body, ts_unix)
		 VALUES (?, ?, ?, ?, ?, ?)
		 ON CONFLICT(msg_id) DO UPDATE SET chat_jid = excluded.chat_jid, sender_jid = excluded.sender_jid, from_me = excluded.from_me, body = excluded.body, ts_unix = excluded.ts_unix`,
		msg.ID, msg.ChatJID, msg.SenderJID, fromMe, msg.Body, ts.Unix(),
	)
	if err != nil {
		return fmt.Errorf("save message: %w", err)
	}
	_, _ = s.db.ExecContext(
		ctx,
		`DELETE FROM bridge_messages WHERE msg_id NOT IN (
			SELECT msg_id FROM bridge_messages ORDER BY ts_unix DESC LIMIT ?
		)`,
		maxStoredMessages,
	)
	return nil
}

func (s *BridgeStore) GetMessage(ctx context.Context, msgID string) (StoredMessage, bool, error) {
	if msgID == "" {
		return StoredMessage{}, false, nil
	}
	var out StoredMessage
	var fromMe int
	var tsUnix int64
	err := s.db.QueryRowContext(
		ctx,
		`SELECT msg_id, chat_jid, sender_jid, from_me, body, ts_unix FROM bridge_messages WHERE msg_id = ?`,
		msgID,
	).Scan(&out.ID, &out.ChatJID, &out.SenderJID, &fromMe, &out.Body, &tsUnix)
	if errors.Is(err, sql.ErrNoRows) {
		return StoredMessage{}, false, nil
	}
	if err != nil {
		return StoredMessage{}, false, fmt.Errorf("query message: %w", err)
	}
	out.FromMe = fromMe != 0
	out.Timestamp = time.Unix(tsUnix, 0)
	return out, true, nil
}

func (s *BridgeStore) GetLastChatMessage(ctx context.Context, chatJID string) (StoredMessage, bool, error) {
	if chatJID == "" {
		return StoredMessage{}, false, nil
	}
	var out StoredMessage
	var fromMe int
	var tsUnix int64
	err := s.db.QueryRowContext(
		ctx,
		`SELECT msg_id, chat_jid, sender_jid, from_me, body, ts_unix
		 FROM bridge_messages WHERE chat_jid = ? ORDER BY ts_unix DESC LIMIT 1`,
		chatJID,
	).Scan(&out.ID, &out.ChatJID, &out.SenderJID, &fromMe, &out.Body, &tsUnix)
	if errors.Is(err, sql.ErrNoRows) {
		return StoredMessage{}, false, nil
	}
	if err != nil {
		return StoredMessage{}, false, fmt.Errorf("query last chat message: %w", err)
	}
	out.FromMe = fromMe != 0
	out.Timestamp = time.Unix(tsUnix, 0)
	return out, true, nil
}
