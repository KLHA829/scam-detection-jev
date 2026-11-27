package main

import (
	"context"
	"database/sql"
	"fmt"
	"path/filepath"
	"sync"
	"testing"
	"time"
)

func newTestBridgeStore(t *testing.T) (*BridgeStore, *sql.DB) {
	t.Helper()
	ctx := context.Background()
	db, err := openBridgeSQLite(ctx, filepath.Join(t.TempDir(), "bridge.db"))
	if err != nil {
		t.Fatalf("open sqlite: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })
	store, err := NewBridgeStore(ctx, db)
	if err != nil {
		t.Fatalf("new store: %v", err)
	}
	return store, db
}

func countTableRows(t *testing.T, db *sql.DB, table string) int {
	t.Helper()
	var count int
	if err := db.QueryRow(`SELECT COUNT(*) FROM ` + table).Scan(&count); err != nil {
		t.Fatalf("count %s rows: %v", table, err)
	}
	return count
}

func orderedMessageIDs(t *testing.T, db *sql.DB) []string {
	t.Helper()
	rows, err := db.Query(`SELECT msg_id FROM bridge_messages ORDER BY ts_unix DESC, rowid DESC`)
	if err != nil {
		t.Fatalf("query ordered messages: %v", err)
	}
	defer func() { _ = rows.Close() }()
	var out []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			t.Fatalf("scan message id: %v", err)
		}
		out = append(out, id)
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("iterate message ids: %v", err)
	}
	return out
}

func orderedPollIDs(t *testing.T, db *sql.DB) []string {
	t.Helper()
	rows, err := db.Query(`SELECT poll_id FROM bridge_polls ORDER BY created_at DESC, rowid DESC`)
	if err != nil {
		t.Fatalf("query ordered polls: %v", err)
	}
	defer func() { _ = rows.Close() }()
	var out []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			t.Fatalf("scan poll id: %v", err)
		}
		out = append(out, id)
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("iterate poll ids: %v", err)
	}
	return out
}

func saveTestMessage(t *testing.T, store *BridgeStore, id string, ts int64) {
	t.Helper()
	if err := store.SaveMessage(context.Background(), StoredMessage{
		ID:        id,
		ChatJID:   "85261112222@c.us",
		SenderJID: "85261112222@c.us",
		MsgType:   "chat",
		Body:      "body-" + id,
		Timestamp: time.Unix(ts, 0),
	}); err != nil {
		t.Fatalf("SaveMessage(%s): %v", id, err)
	}
}

func assertIDs(t *testing.T, got, want []string) {
	t.Helper()
	if len(got) != len(want) {
		t.Fatalf("ids = %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("ids = %v, want %v", got, want)
		}
	}
}

func TestBridgeStorePruningIsBatched(t *testing.T) {
	ctx := context.Background()
	store, db := newTestBridgeStore(t)
	store.maxStoredMessages = 1
	store.maxStoredPolls = 1
	store.pruneInterval = 3

	saveTestMessage(t, store, "m-1", 100)
	saveTestMessage(t, store, "m-2", 101)
	if got := countTableRows(t, db, "bridge_messages"); got != 2 {
		t.Fatalf("message rows before interval = %d, want 2 (no per-insert prune)", got)
	}
	saveTestMessage(t, store, "m-3", 102)
	if got := countTableRows(t, db, "bridge_messages"); got != 1 {
		t.Fatalf("message rows after interval = %d, want 1", got)
	}
	if _, found, err := store.GetMessage(ctx, "m-3"); err != nil || !found {
		t.Fatalf("newest message after prune found=%v err=%v", found, err)
	}

	for _, id := range []string{"p-1", "p-2"} {
		if err := store.SavePollOptions(ctx, id, "85261112222@c.us", []string{"yes", "no"}); err != nil {
			t.Fatalf("SavePollOptions(%s): %v", id, err)
		}
	}
	if got := countTableRows(t, db, "bridge_polls"); got != 2 {
		t.Fatalf("poll rows before interval = %d, want 2 (no per-insert prune)", got)
	}
	if err := store.SavePollOptions(ctx, "p-3", "85261112222@c.us", []string{"yes", "no"}); err != nil {
		t.Fatalf("SavePollOptions(p-3): %v", err)
	}
	if got := countTableRows(t, db, "bridge_polls"); got != 1 {
		t.Fatalf("poll rows after interval = %d, want 1", got)
	}
	if _, found, err := store.GetPollOptions(ctx, "p-3"); err != nil || !found {
		t.Fatalf("newest poll after prune found=%v err=%v", found, err)
	}
	if got := store.messageWrites.Load(); got != 3 {
		t.Fatalf("message write counter = %d, want 3", got)
	}
	if got := store.pollWrites.Load(); got != 3 {
		t.Fatalf("poll write counter = %d, want 3", got)
	}
}

func TestBridgeStoreMessagePruneUsesTimestampAndRowIDOrder(t *testing.T) {
	store, db := newTestBridgeStore(t)
	store.maxStoredMessages = 3
	store.pruneInterval = 1000

	saveTestMessage(t, store, "old", 100)
	saveTestMessage(t, store, "tie-a", 200)
	saveTestMessage(t, store, "tie-b", 200)
	saveTestMessage(t, store, "tie-c", 200)

	store.pruneInterval = 1
	saveTestMessage(t, store, "tie-new", 200)

	assertIDs(t, orderedMessageIDs(t, db), []string{"tie-new", "tie-c", "tie-b"})
}

func TestBridgeStorePollPruneUsesTimestampAndRowIDOrder(t *testing.T) {
	ctx := context.Background()
	store, db := newTestBridgeStore(t)
	for _, id := range []string{"tie-a", "tie-b", "tie-c"} {
		if _, err := db.ExecContext(ctx, `
INSERT INTO bridge_polls(poll_id, chat_jid, options_json, created_at)
VALUES (?, '85261112222@c.us', '["yes","no"]', 1000)`, id); err != nil {
			t.Fatalf("seed poll %s: %v", id, err)
		}
	}
	store.maxStoredPolls = 2
	store.pruneInterval = 1

	if err := store.SavePollOptions(ctx, "new", "85261112222@c.us", []string{"yes", "no"}); err != nil {
		t.Fatalf("SavePollOptions(new): %v", err)
	}

	assertIDs(t, orderedPollIDs(t, db), []string{"new", "tie-c"})
}

func TestBridgeStoreUpsertsStillUpdateRows(t *testing.T) {
	ctx := context.Background()
	store, db := newTestBridgeStore(t)
	store.maxStoredMessages = 2
	store.maxStoredPolls = 2
	store.pruneInterval = 1

	saveTestMessage(t, store, "m-upsert", 100)
	if err := store.SaveMessage(ctx, StoredMessage{
		ID:        "m-upsert",
		ChatJID:   "85261112222@c.us",
		SenderJID: "85261112222@c.us",
		MsgType:   "image",
		Body:      "updated body",
		Timestamp: time.Unix(200, 0),
	}); err != nil {
		t.Fatalf("SaveMessage upsert: %v", err)
	}
	if got := countTableRows(t, db, "bridge_messages"); got != 1 {
		t.Fatalf("message rows after upsert = %d, want 1", got)
	}
	msg, found, err := store.GetMessage(ctx, "m-upsert")
	if err != nil || !found || msg.Body != "updated body" || msg.MsgType != "image" || msg.Timestamp.Unix() != 200 {
		t.Fatalf("upserted message = (%+v, %v, %v)", msg, found, err)
	}

	if err := store.SavePollOptions(ctx, "p-upsert", "85261112222@c.us", []string{"old"}); err != nil {
		t.Fatalf("SavePollOptions initial: %v", err)
	}
	if err := store.SavePollOptions(ctx, "p-upsert", "85261112222@c.us", []string{"new", "options"}); err != nil {
		t.Fatalf("SavePollOptions upsert: %v", err)
	}
	if got := countTableRows(t, db, "bridge_polls"); got != 1 {
		t.Fatalf("poll rows after upsert = %d, want 1", got)
	}
	options, found, err := store.GetPollOptions(ctx, "p-upsert")
	if err != nil || !found || len(options) != 2 || options[0] != "new" || options[1] != "options" {
		t.Fatalf("upserted poll options = (%v, %v, %v)", options, found, err)
	}
}

func TestBridgeStoreConcurrentWritesAreRaceFree(t *testing.T) {
	store, db := newTestBridgeStore(t)
	store.maxStoredMessages = 20
	store.maxStoredPolls = 10
	store.pruneInterval = 5

	const (
		goroutines      = 8
		writesPerWorker = 25
	)
	totalWrites := goroutines * writesPerWorker
	ctx := context.Background()
	errCh := make(chan error, totalWrites*2)
	var wg sync.WaitGroup
	for g := 0; g < goroutines; g++ {
		wg.Add(1)
		go func(worker int) {
			defer wg.Done()
			for i := 0; i < writesPerWorker; i++ {
				n := worker*writesPerWorker + i
				id := fmt.Sprintf("m-%03d", n)
				if err := store.SaveMessage(ctx, StoredMessage{
					ID:        id,
					ChatJID:   "85261112222@c.us",
					SenderJID: "85261112222@c.us",
					MsgType:   "chat",
					Body:      "concurrent",
					Timestamp: time.Unix(int64(1000+n), 0),
				}); err != nil {
					errCh <- fmt.Errorf("SaveMessage(%s): %w", id, err)
				}
				pollID := fmt.Sprintf("p-%03d", n)
				if err := store.SavePollOptions(ctx, pollID, "85261112222@c.us", []string{"yes", "no"}); err != nil {
					errCh <- fmt.Errorf("SavePollOptions(%s): %w", pollID, err)
				}
			}
		}(g)
	}
	wg.Wait()
	close(errCh)
	for err := range errCh {
		t.Error(err)
	}
	if t.Failed() {
		return
	}

	if got := store.messageWrites.Load(); got != int64(totalWrites) {
		t.Fatalf("message write counter = %d, want %d", got, totalWrites)
	}
	if got := store.pollWrites.Load(); got != int64(totalWrites) {
		t.Fatalf("poll write counter = %d, want %d", got, totalWrites)
	}
	messages := countTableRows(t, db, "bridge_messages")
	if messages < store.maxStoredMessages || messages > store.maxStoredMessages+store.pruneInterval-1 {
		t.Fatalf("message rows after concurrent writes = %d, want within [%d, %d]", messages, store.maxStoredMessages, store.maxStoredMessages+store.pruneInterval-1)
	}
	polls := countTableRows(t, db, "bridge_polls")
	if polls < store.maxStoredPolls || polls > store.maxStoredPolls+store.pruneInterval-1 {
		t.Fatalf("poll rows after concurrent writes = %d, want within [%d, %d]", polls, store.maxStoredPolls, store.maxStoredPolls+store.pruneInterval-1)
	}
}
