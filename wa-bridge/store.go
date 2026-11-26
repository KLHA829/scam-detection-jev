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
	MsgType   string
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
	msg_type TEXT NOT NULL DEFAULT 'chat',
	body TEXT NOT NULL,
	ts_unix INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_bridge_messages_chat_ts ON bridge_messages(chat_jid, ts_unix DESC);
CREATE INDEX IF NOT EXISTS idx_bridge_messages_ts ON bridge_messages(ts_unix);

CREATE TABLE IF NOT EXISTS bridge_meta (
	key TEXT PRIMARY KEY,
	value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS bridge_archive_state (
	our_jid TEXT NOT NULL DEFAULT '',
	chat_jid TEXT NOT NULL,
	archived INTEGER NOT NULL,
	updated_at INTEGER NOT NULL,
	PRIMARY KEY (our_jid, chat_jid)
);

CREATE TABLE IF NOT EXISTS bridge_bot_contact_labels (
	jid TEXT NOT NULL,
	key_id BLOB NOT NULL,
	index_mac BLOB NOT NULL,
	value_mac BLOB NOT NULL,
	label_name TEXT NOT NULL,
	PRIMARY KEY (jid, key_id)
);

CREATE TABLE IF NOT EXISTS bridge_unreconciled_contacts (
	jid TEXT PRIMARY KEY
);
`
	if _, err := db.ExecContext(ctx, schema); err != nil {
		return nil, fmt.Errorf("init bridge schema: %w", err)
	}
	if err := ensureBridgeMessagesColumns(ctx, db); err != nil {
		return nil, err
	}
	if err := ensureBridgeArchiveStateColumns(ctx, db); err != nil {
		return nil, err
	}
	return &BridgeStore{db: db}, nil
}

func ensureBridgeMessagesColumns(ctx context.Context, db *sql.DB) error {
	rows, err := db.QueryContext(ctx, `PRAGMA table_info(bridge_messages)`)
	if err != nil {
		return fmt.Errorf("inspect bridge_messages schema: %w", err)
	}
	defer func() { _ = rows.Close() }()

	hasMsgType := false
	for rows.Next() {
		var (
			cid        int
			name       string
			colType    string
			notNull    int
			defaultVal sql.NullString
			pk         int
		)
		if err := rows.Scan(&cid, &name, &colType, &notNull, &defaultVal, &pk); err != nil {
			return fmt.Errorf("scan bridge_messages column: %w", err)
		}
		if name == "msg_type" {
			hasMsgType = true
		}
	}
	if err := rows.Err(); err != nil {
		return fmt.Errorf("iterate bridge_messages columns: %w", err)
	}
	if !hasMsgType {
		if _, err := db.ExecContext(ctx, `ALTER TABLE bridge_messages ADD COLUMN msg_type TEXT NOT NULL DEFAULT 'unknown'`); err != nil {
			return fmt.Errorf("migrate bridge_messages.msg_type: %w", err)
		}
	}
	return nil
}

func ensureBridgeArchiveStateColumns(ctx context.Context, db *sql.DB) error {
	rows, err := db.QueryContext(ctx, `PRAGMA table_info(bridge_archive_state)`)
	if err != nil {
		return fmt.Errorf("inspect bridge_archive_state schema: %w", err)
	}
	defer func() { _ = rows.Close() }()

	hasOurJID := false
	for rows.Next() {
		var (
			cid        int
			name       string
			colType    string
			notNull    int
			defaultVal sql.NullString
			pk         int
		)
		if err := rows.Scan(&cid, &name, &colType, &notNull, &defaultVal, &pk); err != nil {
			return fmt.Errorf("scan bridge_archive_state column: %w", err)
		}
		if name == "our_jid" {
			hasOurJID = true
		}
	}
	if err := rows.Err(); err != nil {
		return fmt.Errorf("iterate bridge_archive_state columns: %w", err)
	}
	if !hasOurJID {
		tx, err := db.BeginTx(ctx, nil)
		if err != nil {
			return fmt.Errorf("begin bridge_archive_state migration: %w", err)
		}
		defer func() { _ = tx.Rollback() }()
		if _, err := tx.ExecContext(ctx, `
ALTER TABLE bridge_archive_state RENAME TO bridge_archive_state_old;
CREATE TABLE bridge_archive_state (
	our_jid TEXT NOT NULL DEFAULT '',
	chat_jid TEXT NOT NULL,
	archived INTEGER NOT NULL,
	updated_at INTEGER NOT NULL,
	PRIMARY KEY (our_jid, chat_jid)
);
INSERT INTO bridge_archive_state (our_jid, chat_jid, archived, updated_at)
SELECT COALESCE((SELECT jid FROM whatsmeow_device LIMIT 1), ''), chat_jid, archived, updated_at
FROM bridge_archive_state_old;
DROP TABLE bridge_archive_state_old;`); err != nil {
			return fmt.Errorf("migrate bridge_archive_state.our_jid: %w", err)
		}
		if err := tx.Commit(); err != nil {
			return fmt.Errorf("commit bridge_archive_state migration: %w", err)
		}
	}
	var oldTable string
	err = db.QueryRowContext(ctx, `SELECT name FROM sqlite_master WHERE type='table' AND name='bridge_archive_state_old'`).Scan(&oldTable)
	if err == nil && oldTable == "bridge_archive_state_old" {
		tx, err := db.BeginTx(ctx, nil)
		if err != nil {
			return fmt.Errorf("begin bridge_archive_state_old recovery: %w", err)
		}
		defer func() { _ = tx.Rollback() }()
		if _, err := tx.ExecContext(ctx, `
INSERT OR IGNORE INTO bridge_archive_state (our_jid, chat_jid, archived, updated_at)
SELECT COALESCE((SELECT jid FROM whatsmeow_device LIMIT 1), ''), chat_jid, archived, updated_at
FROM bridge_archive_state_old;
DROP TABLE bridge_archive_state_old;`); err != nil {
			return fmt.Errorf("recover bridge_archive_state_old: %w", err)
		}
		if err := tx.Commit(); err != nil {
			return fmt.Errorf("commit bridge_archive_state_old recovery: %w", err)
		}
	} else if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return fmt.Errorf("check bridge_archive_state_old: %w", err)
	}
	return nil
}

func (s *BridgeStore) GetArchiveState(ctx context.Context, ourJID, chatJID string) (bool, bool, error) {
	var archived bool
	err := s.db.QueryRowContext(ctx, `SELECT archived FROM bridge_archive_state WHERE our_jid=$1 AND chat_jid=$2`, ourJID, chatJID).Scan(&archived)
	if errors.Is(err, sql.ErrNoRows) {
		return false, false, nil
	}
	if err != nil {
		return false, false, fmt.Errorf("get archive state: %w", err)
	}
	return archived, true, nil
}

func (s *BridgeStore) PutArchiveState(ctx context.Context, ourJID, chatJID string, archived bool) error {
	_, err := s.db.ExecContext(ctx, `
INSERT INTO bridge_archive_state (our_jid, chat_jid, archived, updated_at) VALUES ($1, $2, $3, $4)
ON CONFLICT(our_jid, chat_jid) DO UPDATE SET archived=excluded.archived, updated_at=excluded.updated_at
`, ourJID, chatJID, archived, time.Now().Unix())
	if err != nil {
		return fmt.Errorf("put archive state: %w", err)
	}
	return nil
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
	msgType := msg.MsgType
	if msgType == "" {
		msgType = "chat"
	}
	ts := msg.Timestamp
	if ts.IsZero() {
		ts = time.Now()
	}
	_, err := s.db.ExecContext(
		ctx,
		`INSERT INTO bridge_messages(msg_id, chat_jid, sender_jid, from_me, msg_type, body, ts_unix)
		 VALUES (?, ?, ?, ?, ?, ?, ?)
		 ON CONFLICT(msg_id) DO UPDATE SET chat_jid = excluded.chat_jid, sender_jid = excluded.sender_jid, from_me = excluded.from_me, msg_type = excluded.msg_type, body = excluded.body, ts_unix = excluded.ts_unix`,
		msg.ID, msg.ChatJID, msg.SenderJID, fromMe, msgType, msg.Body, ts.Unix(),
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
		`SELECT msg_id, chat_jid, sender_jid, from_me, msg_type, body, ts_unix FROM bridge_messages WHERE msg_id = ?`,
		msgID,
	).Scan(&out.ID, &out.ChatJID, &out.SenderJID, &fromMe, &out.MsgType, &out.Body, &tsUnix)
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
		`SELECT msg_id, chat_jid, sender_jid, from_me, msg_type, body, ts_unix
		 FROM bridge_messages WHERE chat_jid = ? ORDER BY ts_unix DESC LIMIT 1`,
		chatJID,
	).Scan(&out.ID, &out.ChatJID, &out.SenderJID, &fromMe, &out.MsgType, &out.Body, &tsUnix)
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

type BotContactLabelRecord struct {
	JID       string
	KeyID     []byte
	IndexMAC  []byte
	ValueMAC  []byte
	LabelName string
}

func (s *BridgeStore) SaveBotContactLabel(ctx context.Context, jid string, keyID, indexMAC, valueMAC []byte, labelName string) error {
	if s == nil || s.db == nil || jid == "" || len(keyID) == 0 || len(indexMAC) == 0 || len(valueMAC) == 0 {
		return nil
	}
	_, err := s.db.ExecContext(
		ctx,
		`INSERT INTO bridge_bot_contact_labels (jid, key_id, index_mac, value_mac, label_name)
		 VALUES (?, ?, ?, ?, ?)
		 ON CONFLICT(jid, key_id) DO UPDATE SET
			index_mac = excluded.index_mac,
			value_mac = excluded.value_mac,
			label_name = excluded.label_name`,
		jid,
		keyID,
		indexMAC,
		valueMAC,
		labelName,
	)
	if err != nil {
		return fmt.Errorf("save bot contact label: %w", err)
	}
	return nil
}

func (s *BridgeStore) ListBotContactLabels(ctx context.Context, jid string) ([]BotContactLabelRecord, error) {
	if s == nil || s.db == nil || jid == "" {
		return nil, nil
	}
	rows, err := s.db.QueryContext(
		ctx,
		`SELECT key_id, index_mac, value_mac, label_name FROM bridge_bot_contact_labels WHERE jid = ?`,
		jid,
	)
	if err != nil {
		return nil, fmt.Errorf("list bot contact labels: %w", err)
	}
	defer func() { _ = rows.Close() }()
	var out []BotContactLabelRecord
	for rows.Next() {
		rec := BotContactLabelRecord{JID: jid}
		if err := rows.Scan(&rec.KeyID, &rec.IndexMAC, &rec.ValueMAC, &rec.LabelName); err != nil {
			return nil, fmt.Errorf("scan bot contact label: %w", err)
		}
		out = append(out, rec)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate bot contact labels: %w", err)
	}
	return out, nil
}

func (s *BridgeStore) DeleteBotContactLabel(ctx context.Context, jid string, keyID []byte) error {
	if s == nil || s.db == nil || jid == "" || len(keyID) == 0 {
		return nil
	}
	_, err := s.db.ExecContext(ctx, `DELETE FROM bridge_bot_contact_labels WHERE jid = ? AND key_id = ?`, jid, keyID)
	if err != nil {
		return fmt.Errorf("delete bot contact label: %w", err)
	}
	return nil
}

func (s *BridgeStore) MarkUnreconciledContact(ctx context.Context, jid string) error {
	if s == nil || s.db == nil || jid == "" {
		return nil
	}
	_, err := s.db.ExecContext(ctx, `INSERT INTO bridge_unreconciled_contacts (jid) VALUES (?) ON CONFLICT(jid) DO NOTHING`, jid)
	if err != nil {
		return fmt.Errorf("mark unreconciled contact: %w", err)
	}
	return nil
}

func (s *BridgeStore) ClearUnreconciledContact(ctx context.Context, jid string) error {
	if s == nil || s.db == nil || jid == "" {
		return nil
	}
	_, err := s.db.ExecContext(ctx, `DELETE FROM bridge_unreconciled_contacts WHERE jid = ?`, jid)
	if err != nil {
		return fmt.Errorf("clear unreconciled contact: %w", err)
	}
	return nil
}

func (s *BridgeStore) HasUnreconciledContact(ctx context.Context, jid string) (bool, error) {
	if s == nil || s.db == nil || jid == "" {
		return false, nil
	}
	var found int
	err := s.db.QueryRowContext(ctx, `SELECT 1 FROM bridge_unreconciled_contacts WHERE jid = ? LIMIT 1`, jid).Scan(&found)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("query unreconciled contact: %w", err)
	}
	return true, nil
}

func (s *BridgeStore) GetMeta(ctx context.Context, key string) (string, bool, error) {
	if key == "" {
		return "", false, nil
	}
	var val string
	err := s.db.QueryRowContext(ctx, `SELECT value FROM bridge_meta WHERE key = ?`, key).Scan(&val)
	if errors.Is(err, sql.ErrNoRows) {
		return "", false, nil
	}
	if err != nil {
		return "", false, fmt.Errorf("get meta %q: %w", key, err)
	}
	return val, true, nil
}

func (s *BridgeStore) SetMeta(ctx context.Context, key, value string) error {
	if key == "" {
		return errors.New("meta key is required")
	}
	_, err := s.db.ExecContext(
		ctx,
		`INSERT INTO bridge_meta(key, value) VALUES (?, ?)
		 ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
		key, value,
	)
	if err != nil {
		return fmt.Errorf("set meta %q: %w", key, err)
	}
	return nil
}

func (s *BridgeStore) DeleteMeta(ctx context.Context, key string) error {
	if key == "" {
		return errors.New("meta key is required")
	}
	if _, err := s.db.ExecContext(ctx, `DELETE FROM bridge_meta WHERE key = ?`, key); err != nil {
		return fmt.Errorf("delete meta %q: %w", key, err)
	}
	return nil
}
