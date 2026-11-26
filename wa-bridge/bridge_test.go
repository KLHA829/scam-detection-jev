package main

import (
	"bufio"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"

	"go.mau.fi/whatsmeow/appstate"
	"go.mau.fi/whatsmeow/proto/waAdv"
	"go.mau.fi/whatsmeow/proto/waCommon"
	"go.mau.fi/whatsmeow/proto/waE2E"
	"go.mau.fi/whatsmeow/proto/waSyncAction"
	"go.mau.fi/whatsmeow/store"
	"go.mau.fi/whatsmeow/types"
	"go.mau.fi/whatsmeow/types/events"
	"google.golang.org/protobuf/proto"
)

func TestJIDCanonicalizationAndParsing(t *testing.T) {
	pnAD := types.JID{User: "85261234567", Device: 12, Server: types.DefaultUserServer}
	if got := canonicalJID(pnAD); got != "85261234567@c.us" {
		t.Fatalf("canonicalJID(%v) = %q, want 85261234567@c.us", pnAD, got)
	}
	if got := phoneDigitsFromJID(pnAD); got != "85261234567" {
		t.Fatalf("phoneDigitsFromJID(%v) = %q", pnAD, got)
	}

	lid := types.JID{User: "201234567890", Device: 3, Server: types.HiddenUserServer}
	if got := canonicalJID(lid); got != "201234567890@lid" {
		t.Fatalf("canonicalJID(lid) = %q", got)
	}
	if got := phoneDigitsFromJID(lid); got != "" {
		t.Fatalf("LID digits must never leak as phone digits, got %q", got)
	}

	parsedCUS, err := parseInputJID("85261234567@c.us")
	if err != nil || parsedCUS.Server != types.DefaultUserServer || parsedCUS.User != "85261234567" {
		t.Fatalf("parseInputJID(@c.us) = (%v, %v)", parsedCUS, err)
	}
	parsedDigits, err := parseInputJID("+852 6123-4567")
	if err != nil || parsedDigits.Server != types.DefaultUserServer || parsedDigits.User != "85261234567" {
		t.Fatalf("parseInputJID(digits) = (%v, %v)", parsedDigits, err)
	}
	parsedLID, err := parseInputJID("99887766@lid")
	if err != nil || parsedLID.Server != types.HiddenUserServer || parsedLID.User != "99887766" {
		t.Fatalf("parseInputJID(@lid) = (%v, %v)", parsedLID, err)
	}
	if _, err := parseInputJID("   "); err == nil {
		t.Fatal("expected error for blank JID")
	}
}

func TestBridgeStorePersistenceAndPollDecoding(t *testing.T) {
	ctx := context.Background()
	dbPath := filepath.Join(t.TempDir(), "bridge.db")

	db, err := openBridgeSQLite(ctx, dbPath)
	if err != nil {
		t.Fatalf("open sqlite: %v", err)
	}
	if runtime.GOOS != "windows" {
		st, err := os.Stat(dbPath)
		if err != nil {
			t.Fatalf("stat db: %v", err)
		}
		if perm := st.Mode().Perm(); perm != 0o600 {
			t.Fatalf("db permissions = %o, want 0600", perm)
		}
	}
	store, err := NewBridgeStore(ctx, db)
	if err != nil {
		t.Fatalf("new store: %v", err)
	}
	options := []string{"封鎖並封存", "只封存", "留低"}
	if err := store.SavePollOptions(ctx, "poll-1", "85299990000@c.us", options); err != nil {
		t.Fatalf("SavePollOptions: %v", err)
	}
	now := time.Now().Truncate(time.Second)
	if err := store.SaveMessage(ctx, StoredMessage{
		ID:        "m-1",
		ChatJID:   "85261112222@c.us",
		SenderJID: "85261112222@c.us",
		FromMe:    false,
		MsgType:   "image",
		Body:      "See attached screenshot",
		Timestamp: now.Add(-10 * time.Second),
	}); err != nil {
		t.Fatalf("SaveMessage m-1: %v", err)
	}
	if err := store.SaveMessage(ctx, StoredMessage{
		ID:        "m-2",
		ChatJID:   "85261112222@c.us",
		SenderJID: "85261112222@c.us",
		FromMe:    true,
		MsgType:   "chat",
		Body:      "second body",
		Timestamp: now,
	}); err != nil {
		t.Fatalf("SaveMessage m-2: %v", err)
	}
	if err := store.PutArchiveState(ctx, "85299990000@s.whatsapp.net", "85261112222@c.us", false); err != nil {
		t.Fatalf("PutArchiveState: %v", err)
	}
	if err := db.Close(); err != nil {
		t.Fatalf("close db: %v", err)
	}

	reopened, err := openBridgeSQLite(ctx, dbPath)
	if err != nil {
		t.Fatalf("reopen sqlite: %v", err)
	}
	defer func() { _ = reopened.Close() }()
	store2, err := NewBridgeStore(ctx, reopened)
	if err != nil {
		t.Fatalf("reopen store: %v", err)
	}

	archived, archiveFound, err := store2.GetArchiveState(ctx, "85299990000@s.whatsapp.net", "85261112222@c.us")
	if err != nil || !archiveFound || archived {
		t.Fatalf("GetArchiveState after reopen = (%v, %v, %v)", archived, archiveFound, err)
	}

	loadedOpts, found, err := store2.GetPollOptions(ctx, "poll-1")
	if err != nil || !found || len(loadedOpts) != 3 {
		t.Fatalf("GetPollOptions after reopen = (%v, %v, %v)", loadedOpts, found, err)
	}
	hash := sha256.Sum256([]byte("封鎖並封存"))
	resolved := ResolvePollVoteOptions(loadedOpts, [][]byte{hash[:]})
	if len(resolved) != 1 || resolved[0] != "封鎖並封存" {
		t.Fatalf("ResolvePollVoteOptions = %v", resolved)
	}

	imgMsg, found, err := store2.GetMessage(ctx, "m-1")
	if err != nil || !found || imgMsg.MsgType != "image" {
		t.Fatalf("GetMessage(m-1) = (%+v, %v, %v)", imgMsg, found, err)
	}

	last, found, err := store2.GetLastChatMessage(ctx, "85261112222@c.us")
	if err != nil || !found || last.ID != "m-2" || !last.FromMe || last.MsgType != "chat" {
		t.Fatalf("GetLastChatMessage = (%+v, %v, %v)", last, found, err)
	}
}

func TestBridgeStoreMigratesLegacyMessagesTable(t *testing.T) {
	ctx := context.Background()
	dbPath := filepath.Join(t.TempDir(), "legacy.db")

	db, err := openBridgeSQLite(ctx, dbPath)
	if err != nil {
		t.Fatalf("open sqlite: %v", err)
	}
	defer func() { _ = db.Close() }()

	_, err = db.ExecContext(ctx, `
CREATE TABLE bridge_messages (
	msg_id TEXT PRIMARY KEY,
	chat_jid TEXT NOT NULL,
	sender_jid TEXT NOT NULL,
	from_me INTEGER NOT NULL,
	body TEXT NOT NULL,
	ts_unix INTEGER NOT NULL
);
INSERT INTO bridge_messages(msg_id, chat_jid, sender_jid, from_me, body, ts_unix)
VALUES ('legacy-1', '85261112222@c.us', '85261112222@c.us', 0, 'old caption or text', 1700000000);
`)
	if err != nil {
		t.Fatalf("seed legacy table: %v", err)
	}

	store, err := NewBridgeStore(ctx, db)
	if err != nil {
		t.Fatalf("NewBridgeStore migration: %v", err)
	}

	legacy, found, err := store.GetMessage(ctx, "legacy-1")
	if err != nil || !found || legacy.MsgType != "unknown" || legacy.Body != "old caption or text" {
		t.Fatalf("legacy row after migration = (%+v, %v, %v)", legacy, found, err)
	}

	if err := store.SaveMessage(ctx, StoredMessage{
		ID:        "new-1",
		ChatJID:   "85261112222@c.us",
		SenderJID: "85261112222@c.us",
		FromMe:    false,
		MsgType:   "chat",
		Body:      "fresh text",
		Timestamp: time.Unix(1700000010, 0),
	}); err != nil {
		t.Fatalf("SaveMessage after migration: %v", err)
	}
	newest, found, err := store.GetLastChatMessage(ctx, "85261112222@c.us")
	if err != nil || !found || newest.ID != "new-1" || newest.MsgType != "chat" {
		t.Fatalf("GetLastChatMessage after migration = (%+v, %v, %v)", newest, found, err)
	}
}

func TestContactSyncFailClosedGate(t *testing.T) {
	jid := types.NewJID("85261234567", types.DefaultUserServer)

	coldUnsaved := buildContactResponse(jid, types.ContactInfo{Found: true, PushName: "Stranger"}, false, "85299990000@c.us", "")
	if coldUnsaved.IsMyContact != nil {
		t.Fatalf("before contactsSynced, unsaved contact must be unknown (nil), got %v", *coldUnsaved.IsMyContact)
	}

	coldSaved := buildContactResponse(jid, types.ContactInfo{Found: true, FullName: "Mum"}, false, "85299990000@c.us", "")
	if coldSaved.IsMyContact == nil || !*coldSaved.IsMyContact || coldSaved.Name != "Mum" {
		t.Fatalf("saved name present before sync should stay true, got %+v", coldSaved)
	}

	syncedUnsaved := buildContactResponse(jid, types.ContactInfo{Found: true, PushName: "Stranger"}, true, "85299990000@c.us", "")
	if syncedUnsaved.IsMyContact == nil || *syncedUnsaved.IsMyContact {
		t.Fatalf("after contactsSynced, contact without saved name must be false, got %+v", syncedUnsaved)
	}

	selfResp := buildContactResponse(
		types.NewJID("85299990000", types.DefaultUserServer),
		types.ContactInfo{},
		true,
		"85299990000@c.us",
		"123@lid",
	)
	if !selfResp.IsMe {
		t.Fatalf("expected IsMe=true for selfWid, got %+v", selfResp)
	}
}

func TestLidContactMutationSavedInFullSync(t *testing.T) {
	ctx := context.Background()
	dbPath := filepath.Join(t.TempDir(), "lid-contact-sync.db")

	bridge, err := NewWhatsmeowBridge(ctx, dbPath, "ERROR")
	if err != nil {
		t.Fatalf("NewWhatsmeowBridge: %v", err)
	}
	defer func() { _ = bridge.Close() }()

	selfJID := types.NewJID("85299990000", types.DefaultUserServer)
	bridge.client.Store.ID = &selfJID
	bridge.client.Store.Account = &waAdv.ADVSignedDeviceIdentity{
		Details:             []byte("details"),
		AccountSignatureKey: make([]byte, 32),
		AccountSignature:    make([]byte, 64),
		DeviceSignature:     make([]byte, 64),
	}
	if err := bridge.client.Store.Save(ctx); err != nil {
		t.Fatalf("save device store: %v", err)
	}

	if !bridge.client.EmitAppStateEventsOnFullSync {
		t.Fatal("full sync must emit app-state events so lid_contact rows reach the bridge")
	}
	emitLidContact := func(jid types.JID, name string) {
		bridge.handleEvent(&events.AppState{
			Index: []string{appstate.IndexLIDContact, jid.String()},
			SyncActionValue: &waSyncAction.SyncActionValue{
				LidContactAction: &waSyncAction.LidContactAction{
					FullName:  proto.String(name),
					FirstName: proto.String(name),
				},
			},
		})
	}

	lidJID := types.NewJID("555000333", types.HiddenUserServer)
	emitLidContact(lidJID, "Mum")

	bridge.mu.Lock()
	bridge.connected = true
	bridge.loggedIn = true
	bridge.connGen = 1
	bridge.mu.Unlock()
	bridge.markContactsSyncedForGen(1)

	contact, err := bridge.GetContact(ctx, lidJID.String())
	if err != nil {
		t.Fatalf("GetContact(lid): %v", err)
	}
	if contact.IsMyContact == nil || !*contact.IsMyContact || contact.Name != "Mum" {
		t.Fatalf("saved lid_contact mutation must read as saved/Mum, got %+v", contact)
	}

	incrementalLID := types.NewJID("555000444", types.HiddenUserServer)
	emitLidContact(incrementalLID, "Auntie")
	incrementalContact, err := bridge.GetContact(ctx, incrementalLID.String())
	if err != nil {
		t.Fatalf("GetContact(incremental lid): %v", err)
	}
	if incrementalContact.IsMyContact == nil || !*incrementalContact.IsMyContact || incrementalContact.Name != "Auntie" {
		t.Fatalf("incremental lid_contact mutation must read as saved/Auntie, got %+v", incrementalContact)
	}
}

func TestContactRecoveryResyncsFailClosed(t *testing.T) {
	ctx := context.Background()
	bridge, err := NewWhatsmeowBridge(ctx, filepath.Join(t.TempDir(), "contact-recovery.db"), "ERROR")
	if err != nil {
		t.Fatalf("NewWhatsmeowBridge: %v", err)
	}
	defer func() { _ = bridge.Close() }()

	type fetchResult struct {
		fullSync      bool
		syncedAtFetch bool
	}
	fetchDone := make(chan fetchResult, 1)
	bridge.fetchContactsFn = func(_ context.Context, fullSync bool) error {
		fetchDone <- fetchResult{fullSync: fullSync, syncedAtFetch: bridge.Health().ContactsSynced}
		return nil
	}
	bridge.mu.Lock()
	bridge.connected = true
	bridge.loggedIn = true
	bridge.connGen = 1
	bridge.contactsSynced = true
	bridge.mu.Unlock()

	bridge.handleEvent(&events.AppStateSyncComplete{Name: appstate.WAPatchCriticalUnblockLow, Recovery: true})
	select {
	case res := <-fetchDone:
		if !res.fullSync {
			t.Fatal("recovery must force a full contact resync")
		}
		if res.syncedAtFetch {
			t.Fatal("recovery must close the contact gate while refetching")
		}
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for recovery contact resync")
	}
	if !bridge.Health().ContactsSynced {
		t.Fatal("successful recovery resync should reopen the contact gate")
	}
}

func TestLidContactLiveAppStateEventSaved(t *testing.T) {
	ctx := context.Background()
	bridge, err := NewWhatsmeowBridge(ctx, filepath.Join(t.TempDir(), "lid-appstate-event.db"), "ERROR")
	if err != nil {
		t.Fatalf("NewWhatsmeowBridge: %v", err)
	}
	defer func() { _ = bridge.Close() }()

	selfJID := types.NewJID("85299990000", types.DefaultUserServer)
	bridge.client.Store.ID = &selfJID
	bridge.client.Store.Account = &waAdv.ADVSignedDeviceIdentity{
		Details:             []byte("details"),
		AccountSignatureKey: make([]byte, 32),
		AccountSignature:    make([]byte, 64),
		DeviceSignature:     make([]byte, 64),
	}
	if err := bridge.client.Store.Save(ctx); err != nil {
		t.Fatalf("save device store: %v", err)
	}

	bridge.mu.Lock()
	bridge.connected = true
	bridge.loggedIn = true
	bridge.connGen = 1
	bridge.mu.Unlock()
	bridge.markContactsSyncedForGen(1)

	lidJID := types.NewJID("555000777", types.HiddenUserServer)
	bridge.handleEvent(&events.AppState{
		Index: []string{appstate.IndexLIDContact, lidJID.String()},
		SyncActionValue: &waSyncAction.SyncActionValue{
			LidContactAction: &waSyncAction.LidContactAction{
				FullName:  proto.String("Live Mum"),
				FirstName: proto.String("Live Mum"),
			},
		},
	})

	contact, err := bridge.GetContact(ctx, lidJID.String())
	if err != nil {
		t.Fatalf("GetContact(live lid): %v", err)
	}
	if contact.IsMyContact == nil || !*contact.IsMyContact || contact.Name != "Live Mum" {
		t.Fatalf("live AppState lid_contact event must save contact as saved/Live Mum, got %+v", contact)
	}
}

func TestContactRecoveryDuringInflightSyncForcesFullResync(t *testing.T) {
	ctx := context.Background()
	bridge, err := NewWhatsmeowBridge(ctx, filepath.Join(t.TempDir(), "recovery-inflight.db"), "ERROR")
	if err != nil {
		t.Fatalf("NewWhatsmeowBridge: %v", err)
	}
	defer func() { _ = bridge.Close() }()

	firstStarted := make(chan struct{})
	releaseFirst := make(chan struct{})
	type attempt struct {
		fullSync      bool
		syncedAtStart bool
	}
	attempts := make(chan attempt, 4)
	var callNum int
	var callMu sync.Mutex

	bridge.fetchContactsFn = func(_ context.Context, fullSync bool) error {
		callMu.Lock()
		callNum++
		n := callNum
		callMu.Unlock()
		attempts <- attempt{fullSync: fullSync, syncedAtStart: bridge.Health().ContactsSynced}
		if n == 1 {
			close(firstStarted)
			<-releaseFirst
		}
		return nil
	}

	bridge.mu.Lock()
	bridge.connected = true
	bridge.loggedIn = true
	bridge.connGen = 1
	bridge.syncAttemptActive = true
	bridge.mu.Unlock()

	done := make(chan struct{})
	go func() {
		bridge.syncContacts(bridge.ctx, 1)
		close(done)
	}()

	<-firstStarted
	bridge.handleEvent(&events.AppStateSyncComplete{Name: appstate.WAPatchCriticalUnblockLow, Recovery: true})
	close(releaseFirst)

	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for syncContacts to finish recovery resync")
	}

	close(attempts)
	var got []attempt
	for a := range attempts {
		got = append(got, a)
	}
	if len(got) != 2 {
		t.Fatalf("expected 2 sync attempts (initial + forced full recovery), got %d: %+v", len(got), got)
	}
	if !got[1].fullSync || got[1].syncedAtStart {
		t.Fatalf("second attempt after inflight recovery must be fullSync=true with ContactsSynced=false, got %+v", got[1])
	}
	if !bridge.Health().ContactsSynced {
		t.Fatal("expected ContactsSynced=true after recovery resync completes")
	}
}

func TestUpgradeFromNonzeroAppStateVersionForcesFullLidReplay(t *testing.T) {
	ctx := context.Background()
	bridge, err := NewWhatsmeowBridge(ctx, filepath.Join(t.TempDir(), "upgrade-lid-replay.db"), "ERROR")
	if err != nil {
		t.Fatalf("NewWhatsmeowBridge: %v", err)
	}
	defer func() { _ = bridge.Close() }()

	selfJID := types.NewJID("85299990000", types.DefaultUserServer)
	bridge.client.Store.ID = &selfJID
	bridge.client.Store.Account = &waAdv.ADVSignedDeviceIdentity{
		Details:             []byte("details"),
		AccountSignatureKey: make([]byte, 32),
		AccountSignature:    make([]byte, 64),
		DeviceSignature:     make([]byte, 64),
	}
	if err := bridge.client.Store.Save(ctx); err != nil {
		t.Fatalf("save device store: %v", err)
	}

	if err := bridge.client.Store.AppState.PutAppStateVersion(ctx, string(appstate.WAPatchCriticalUnblockLow), 100, [128]byte{1}); err != nil {
		t.Fatalf("seed nonzero app state version: %v", err)
	}

	force, err := bridge.shouldForceFullContactImport(ctx, false)
	if err != nil {
		t.Fatalf("shouldForceFullContactImport: %v", err)
	}
	if !force {
		t.Fatal("upgrade without lid_contact_import_revision must force full replay even with nonzero app-state version")
	}

	if err := bridge.fetchContactAppState(ctx, false); err == nil {
		t.Fatal("expected disconnected FetchAppStatePatches to return error")
	}
	versionAfterFailedUpgrade, _, err := bridge.client.Store.AppState.GetAppStateVersion(ctx, string(appstate.WAPatchCriticalUnblockLow))
	if err != nil {
		t.Fatalf("GetAppStateVersion after failed upgrade replay: %v", err)
	}
	if versionAfterFailedUpgrade != 0 {
		t.Fatalf("expected upgrade replay to reset app-state version to 0 before snapshot fetch, got %d", versionAfterFailedUpgrade)
	}
	if _, found, err := bridge.store.GetMeta(ctx, metaKeyContactImportRevision); err != nil || found {
		t.Fatalf("failed upgrade replay must not persist import revision, got found=%v err=%v", found, err)
	}

	if err := bridge.store.SetMeta(ctx, metaKeyContactImportRevision, lidContactImportRevision); err != nil {
		t.Fatalf("SetMeta: %v", err)
	}
	forceAfterReplay, err := bridge.shouldForceFullContactImport(ctx, false)
	if err != nil {
		t.Fatalf("shouldForceFullContactImport after replay: %v", err)
	}
	if forceAfterReplay {
		t.Fatal("after lid_contact_import_revision is persisted, incremental sync should not force full replay")
	}
}

type failingContactNameStore struct {
	store.ContactStore
	err error
}

func (f failingContactNameStore) PutContactName(context.Context, types.JID, string, string) error {
	return f.err
}

func (f failingContactNameStore) PutAllContactNames(context.Context, []store.ContactEntry) error {
	return f.err
}

func TestLidContactWriteFailureInvalidatesInflightSync(t *testing.T) {
	ctx := context.Background()
	bridge, err := NewWhatsmeowBridge(ctx, filepath.Join(t.TempDir(), "lid-write-error.db"), "ERROR")
	if err != nil {
		t.Fatalf("NewWhatsmeowBridge: %v", err)
	}
	defer func() { _ = bridge.Close() }()

	selfJID := types.NewJID("85299990000", types.DefaultUserServer)
	bridge.client.Store.ID = &selfJID
	bridge.client.Store.Account = &waAdv.ADVSignedDeviceIdentity{
		Details:             []byte("details"),
		AccountSignatureKey: make([]byte, 32),
		AccountSignature:    make([]byte, 64),
		DeviceSignature:     make([]byte, 64),
	}
	if err := bridge.client.Store.Save(ctx); err != nil {
		t.Fatalf("save device store: %v", err)
	}

	rawContacts := bridge.client.Store.Contacts
	writeFail := errors.New("sqlite write failed")
	bridge.client.Store.Contacts = failingContactNameStore{ContactStore: rawContacts, err: writeFail}

	bridge.mu.Lock()
	bridge.connected = true
	bridge.loggedIn = true
	bridge.connGen = 1
	bridge.contactsSynced = true
	bridge.syncAttemptActive = true
	startEpoch := bridge.syncEpoch
	bridge.mu.Unlock()

	lidJID := types.NewJID("555000999", types.HiddenUserServer)
	bridge.handleEvent(&events.AppState{
		Index: []string{appstate.IndexLIDContact, lidJID.String()},
		SyncActionValue: &waSyncAction.SyncActionValue{
			LidContactAction: &waSyncAction.LidContactAction{
				FullName:  proto.String("Mum"),
				FirstName: proto.String("Mum"),
			},
		},
	})

	bridge.mu.RLock()
	defer bridge.mu.RUnlock()
	if bridge.contactsSynced {
		t.Fatal("write failure must keep contactsSynced=false")
	}
	if !bridge.syncNeedsFull || !bridge.syncNeedsRetry {
		t.Fatalf("write failure must force a full retry, needsFull=%v needsRetry=%v", bridge.syncNeedsFull, bridge.syncNeedsRetry)
	}
	if bridge.syncEpoch == startEpoch {
		t.Fatal("write failure must invalidate the in-flight sync epoch")
	}
}

func TestContactWriteObserverSurfacesLegacyAndLIDWriteErrorsBounded(t *testing.T) {
	ctx := context.Background()
	bridge, err := NewWhatsmeowBridge(ctx, filepath.Join(t.TempDir(), "observer-write-err.db"), "ERROR")
	if err != nil {
		t.Fatalf("NewWhatsmeowBridge: %v", err)
	}
	defer func() { _ = bridge.Close() }()

	selfJID := types.NewJID("85299990000", types.DefaultUserServer)
	bridge.client.Store.ID = &selfJID
	bridge.client.Store.Account = &waAdv.ADVSignedDeviceIdentity{
		Details:             []byte("details"),
		AccountSignatureKey: make([]byte, 32),
		AccountSignature:    make([]byte, 64),
		DeviceSignature:     make([]byte, 64),
	}
	if err := bridge.client.Store.Save(ctx); err != nil {
		t.Fatalf("save device store: %v", err)
	}

	bridge.ensureContactWritesWrapped()
	oldAttempt, _ := bridge.contactWrites.beginAttempt()
	newAttempt, _ := bridge.contactWrites.beginAttempt()

	writeFail := errors.New("sqlite write failed")
	bridge.contactWrites.ContactStore = failingContactNameStore{
		ContactStore: bridge.contactWrites.ContactStore,
		err:          writeFail,
	}
	_ = bridge.client.Store.Contacts.PutContactName(ctx, types.NewJID("85261234567", types.DefaultUserServer), "Alice", "Alice")
	if swallowed := bridge.contactWrites.takeErrForAttempt(oldAttempt); swallowed != nil {
		t.Fatalf("obsolete attempt %d must not drain write error from attempt %d, got %v", oldAttempt, newAttempt, swallowed)
	}
	if actual := bridge.contactWrites.takeErrForAttempt(newAttempt); !errors.Is(actual, writeFail) {
		t.Fatalf("expected legacy write failure on attempt %d, got %v", newAttempt, actual)
	}

	var attempts int
	bridge.syncRetryDelay = time.Millisecond
	bridge.fetchContactsFn = func(_ context.Context, _ bool) error {
		attempts++
		bridge.invalidateContactSyncForWriteError(writeFail)
		bridge.handleEvent(&events.AppStateSyncComplete{Name: appstate.WAPatchCriticalUnblockLow})
		return writeFail
	}
	bridge.mu.Lock()
	bridge.connected = true
	bridge.loggedIn = true
	bridge.connGen = 1
	bridge.syncAttemptActive = true
	bridge.mu.Unlock()
	bridge.syncContacts(ctx, 1)
	if attempts != maxSyncAttempts {
		t.Fatalf("expected bounded %d syncAttempts on write failure, got %d", maxSyncAttempts, attempts)
	}
	if bridge.Health().ContactsSynced {
		t.Fatal("exhausted write failure retries must leave ContactsSynced=false")
	}
	if _, found, err := bridge.store.GetMeta(ctx, metaKeyContactImportRevision); err != nil || found {
		t.Fatalf("failed import must not persist import revision, got found=%v err=%v", found, err)
	}
}

func TestIndependentAppStateSyncCompleteWakesFinalAttempt(t *testing.T) {
	ctx := context.Background()
	bridge, err := NewWhatsmeowBridge(ctx, filepath.Join(t.TempDir(), "key-catchup-final.db"), "ERROR")
	if err != nil {
		t.Fatalf("NewWhatsmeowBridge: %v", err)
	}
	defer func() { _ = bridge.Close() }()

	var calls int
	var mu sync.Mutex
	onFinal := make(chan struct{})
	releaseFinal := make(chan struct{})
	bridge.syncRetryDelay = time.Millisecond
	bridge.fetchContactsFn = func(_ context.Context, _ bool) error {
		mu.Lock()
		calls++
		n := calls
		mu.Unlock()
		if n == maxSyncAttempts {
			close(onFinal)
			<-releaseFinal
			return errors.New("err key not found")
		}
		if n < maxSyncAttempts {
			return errors.New("err key not found")
		}
		return nil
	}

	bridge.mu.Lock()
	bridge.connected = true
	bridge.loggedIn = true
	bridge.connGen = 1
	bridge.syncAttemptActive = true
	bridge.mu.Unlock()

	done := make(chan struct{})
	go func() {
		bridge.syncContacts(ctx, 1)
		close(done)
	}()

	<-onFinal
	// Simulate an independent whatsmeow key-share AppStateSyncComplete (Recovery=false)
	// arriving after the bridge's final fetch finishes (bridgeFetchInFlight=false)
	// before syncContacts retires the attempt.
	bridge.mu.Lock()
	bridge.syncNeedsRetry = true
	bridge.bridgeFetchInFlight = false
	bridge.mu.Unlock()
	bridge.handleEvent(&events.AppStateSyncComplete{Name: appstate.WAPatchCriticalUnblockLow, Recovery: false})
	close(releaseFinal)

	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for key-share catch-up retry")
	}
	if !bridge.Health().ContactsSynced {
		t.Fatal("independent AppStateSyncComplete during final attempt must wake a retry and reopen contact gate")
	}
}

func TestPairSuccessInvalidatesContactImportRevision(t *testing.T) {
	ctx := context.Background()
	bridge, err := NewWhatsmeowBridge(ctx, filepath.Join(t.TempDir(), "pair-import-revision.db"), "ERROR")
	if err != nil {
		t.Fatalf("NewWhatsmeowBridge: %v", err)
	}
	defer func() { _ = bridge.Close() }()

	if err := bridge.store.SetMeta(ctx, metaKeyContactImportRevision, lidContactImportRevision); err != nil {
		t.Fatalf("SetMeta: %v", err)
	}
	bridge.handleEvent(&events.PairSuccess{})
	if _, found, err := bridge.store.GetMeta(ctx, metaKeyContactImportRevision); err != nil || found {
		t.Fatalf("PairSuccess must invalidate the prior contact import revision, found=%v err=%v", found, err)
	}
	force, err := bridge.shouldForceFullContactImport(ctx, false)
	if err != nil {
		t.Fatalf("shouldForceFullContactImport: %v", err)
	}
	if !force {
		t.Fatal("PairSuccess must force a full contact replay")
	}
}

func TestBuildContactLabelPatch(t *testing.T) {
	target := types.NewJID("85261234567", types.DefaultUserServer)

	setPatch := buildContactLabelPatch(target, "（可疑推銷）")
	if setPatch.Type != appstate.WAPatchCriticalUnblockLow {
		t.Fatalf("patch type = %q, want %q", setPatch.Type, appstate.WAPatchCriticalUnblockLow)
	}
	if len(setPatch.Mutations) != 1 {
		t.Fatalf("mutations len = %d", len(setPatch.Mutations))
	}
	act := setPatch.Mutations[0].Value.GetContactAction()
	if act.GetFullName() != "（可疑推銷）" || act.GetSaveOnPrimaryAddressbook() {
		t.Fatalf("unexpected ContactAction: %+v", act)
	}

	clearPatch := buildContactLabelPatch(target, "")
	clearAct := clearPatch.Mutations[0].Value.GetContactAction()
	if clearAct.GetFullName() != "" || clearAct.GetFirstName() != "" || clearAct.GetSaveOnPrimaryAddressbook() {
		t.Fatalf("unexpected clear ContactAction: %+v", clearAct)
	}
}

func TestExtractMessageContent(t *testing.T) {
	plain := extractMessageContent(&waE2E.Message{Conversation: proto.String("hello")})
	if plain.msgType != "chat" || plain.body != "hello" || plain.isEdit || plain.isPollVote {
		t.Fatalf("unexpected plain extract: %+v", plain)
	}

	ext := extractMessageContent(&waE2E.Message{
		EphemeralMessage: &waE2E.FutureProofMessage{
			Message: &waE2E.Message{
				ExtendedTextMessage: &waE2E.ExtendedTextMessage{
					Text: proto.String("check link"),
					ContextInfo: &waE2E.ContextInfo{
						StanzaID:        proto.String("quoted-1"),
						ForwardingScore: proto.Uint32(2),
					},
				},
			},
		},
	})
	if ext.msgType != "chat" || ext.body != "check link" || ext.quotedID != "quoted-1" || !ext.isForwarded {
		t.Fatalf("unexpected extended extract: %+v", ext)
	}

	edit := extractMessageContent(&waE2E.Message{
		ProtocolMessage: &waE2E.ProtocolMessage{
			Type: waE2E.ProtocolMessage_MESSAGE_EDIT.Enum(),
			Key:  &waCommon.MessageKey{ID: proto.String("orig-1")},
			EditedMessage: &waE2E.Message{
				Conversation: proto.String("edited text"),
			},
		},
	})
	if !edit.isEdit || edit.editedTargetID != "orig-1" || edit.body != "edited text" {
		t.Fatalf("unexpected edit extract: %+v", edit)
	}

	vote := extractMessageContent(&waE2E.Message{
		PollUpdateMessage: &waE2E.PollUpdateMessage{
			PollCreationMessageKey: &waCommon.MessageKey{ID: proto.String("poll-1")},
		},
	})
	if !vote.isPollVote {
		t.Fatalf("expected isPollVote=true, got %+v", vote)
	}
}

func TestLoopbackHostValidationAndIPv6Bind(t *testing.T) {
	for _, allowed := range []string{"127.0.0.1", "localhost", "::1", "[::1]"} {
		if !isLoopbackHost(allowed) {
			t.Fatalf("expected loopback allowed for %q", allowed)
		}
	}
	for _, denied := range []string{"", "0.0.0.0", "::", "192.168.1.5", "example.com"} {
		if isLoopbackHost(denied) {
			t.Fatalf("expected non-loopback denied for %q", denied)
		}
	}
	if got := net.JoinHostPort(normalizeBindHost("[::1]"), "8767"); got != "[::1]:8767" {
		t.Fatalf("JoinHostPort for bracketed IPv6 = %q, want [::1]:8767", got)
	}
}

func TestEventHubQRReplayAndHistory(t *testing.T) {
	hub := NewEventHub()
	hub.Publish(BridgeEvent{Type: "qr", Data: map[string]any{"qr": "qr-code-1"}})

	ch, cancel := hub.Subscribe(8)
	select {
	case evt := <-ch:
		if evt.Type != "qr" {
			t.Fatalf("expected replayed qr event, got %+v", evt)
		}
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for replayed qr")
	}
	cancel()

	hub.Publish(BridgeEvent{Type: "auth_failure", Data: map[string]any{"reason": "timeout"}})
	chAfterFail, cancelAfterFail := hub.Subscribe(8)
	for {
		select {
		case evt := <-chAfterFail:
			if evt.Type == "qr" {
				t.Fatalf("expired qr must not replay after auth_failure, got %+v", evt)
			}
		default:
			goto doneFail
		}
	}
doneFail:
	cancelAfterFail()

	hub.Publish(BridgeEvent{Type: "qr", Data: map[string]any{"qr": "qr-code-2"}})
	hub.Publish(BridgeEvent{Type: "disconnected", Data: map[string]any{"reason": "net"}})
	chAfterDisc, cancelAfterDisc := hub.Subscribe(8)
	for {
		select {
		case evt := <-chAfterDisc:
			if evt.Type == "qr" {
				t.Fatalf("expired qr must not replay after disconnect, got %+v", evt)
			}
		default:
			goto doneDisc
		}
	}
doneDisc:
	cancelAfterDisc()

	hub.Publish(BridgeEvent{Type: "ready", Data: map[string]any{"selfWid": "85299990000@c.us"}})
	hub.Publish(BridgeEvent{Type: "message", Data: map[string]any{"id": "early-msg"}})

	var lastCursor string
	chReplay, cancelReplay := hub.Subscribe(16)
	var seenTypes []string
	for {
		select {
		case evt := <-chReplay:
			seenTypes = append(seenTypes, evt.Type)
			lastCursor = evt.ID
		default:
			goto checkReplay
		}
	}
checkReplay:
	cancelReplay()
	if !strings.Contains(strings.Join(seenTypes, ","), "ready,message") {
		t.Fatalf("expected startup ready + early message replay, got %v", seenTypes)
	}

	hub.Publish(BridgeEvent{Type: "message", Data: map[string]any{"id": "newer-msg"}})
	chSince, cancelSince := hub.SubscribeWithCursor(8, lastCursor)
	select {
	case evt := <-chSince:
		if evt.Type != "message" || evt.ID == lastCursor {
			t.Fatalf("expected only newer event after cursor=%q, got %+v", lastCursor, evt)
		}
	case <-time.After(time.Second):
		t.Fatal("expected newer event from SubscribeWithCursor")
	}
	cancelSince()

	restartedHub := NewEventHub()
	restartedHub.Publish(BridgeEvent{Type: "ready", Data: map[string]any{"selfWid": "85299990000@c.us"}})
	restartedHub.Publish(BridgeEvent{Type: "message", Data: map[string]any{"id": "post-restart"}})
	chAfterRestart, cancelAfterRestart := restartedHub.SubscribeWithCursor(16, lastCursor)
	var afterRestartTypes []string
	for {
		select {
		case evt := <-chAfterRestart:
			afterRestartTypes = append(afterRestartTypes, evt.Type)
		default:
			goto checkRestart
		}
	}
checkRestart:
	cancelAfterRestart()
	if strings.Join(afterRestartTypes, ",") != "ready,message" {
		t.Fatalf("stale cursor from prior hub epoch must replay startup ready+message, got %v", afterRestartTypes)
	}

	evictHub := NewEventHub()
	evictHub.Publish(BridgeEvent{Type: "ready", Data: map[string]any{"selfWid": "85299990000@c.us"}})
	for i := 0; i < maxReplayEvents+5; i++ {
		evictHub.Publish(BridgeEvent{Type: "message", Data: map[string]any{"n": i}})
	}
	chEvicted, cancelEvicted := evictHub.Subscribe(maxReplayEvents + 16)
	defer cancelEvicted()
	var evictedEvents []BridgeEvent
	for {
		select {
		case evt := <-chEvicted:
			evictedEvents = append(evictedEvents, evt)
		default:
			goto checkEvicted
		}
	}
checkEvicted:
	if len(evictedEvents) != maxReplayEvents+1 {
		t.Fatalf("expected prepended ready + %d retained messages, got %d", maxReplayEvents, len(evictedEvents))
	}
	if evictedEvents[0].Type != "ready" {
		t.Fatalf("expected first replayed event to be retained ready, got %+v", evictedEvents[0])
	}
	if evictedEvents[1].Type != "message" || evictedEvents[1].Seq <= evictedEvents[0].Seq {
		t.Fatalf("expected messages in sequence order after ready, got %+v", evictedEvents[1])
	}
}

func TestEventHubConcurrentPublishAndCancel(t *testing.T) {
	hub := NewEventHub()
	var wg sync.WaitGroup
	stop := make(chan struct{})

	for i := 0; i < 4; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for {
				select {
				case <-stop:
					return
				default:
					hub.Publish(BridgeEvent{Type: "qr", Data: map[string]any{"qr": "rotating"}})
				}
			}
		}()
	}

	for i := 0; i < 100; i++ {
		ch, cancel := hub.Subscribe(2)
		select {
		case <-ch:
		default:
		}
		cancel()
	}
	close(stop)
	wg.Wait()
}

type fakeBackend struct {
	hub              *EventHub
	health           HealthStatus
	lastCall         string
	notReady         bool
	unsupportedMedia bool
}

func (f *fakeBackend) Health() HealthStatus { return f.health }
func (f *fakeBackend) Events() *EventHub    { return f.hub }
func (f *fakeBackend) GetContact(_ context.Context, rawID string) (*ContactResponse, error) {
	f.lastCall = "contact:" + rawID
	flag := false
	return &ContactResponse{ID: rawID, Number: "85261230001", IsMyContact: &flag, ContactsSynced: true}, nil
}
func (f *fakeBackend) ResolveLidMappings(_ context.Context, ids []string) ([]LidMapping, error) {
	f.lastCall = "lid:" + strings.Join(ids, ",")
	return []LidMapping{{Lid: "123@lid", Pn: "85261230001@c.us"}}, nil
}
func (f *fakeBackend) SendText(_ context.Context, chatID, text string) (string, error) {
	if f.notReady {
		return "", errNotReady
	}
	f.lastCall = "text:" + chatID + ":" + text
	return "msg-text-1", nil
}
func (f *fakeBackend) SendPoll(_ context.Context, chatID, name string, options []string, _ bool) (string, error) {
	f.lastCall = "poll:" + chatID + ":" + name + ":" + strings.Join(options, "|")
	return "msg-poll-1", nil
}
func (f *fakeBackend) ForwardMessage(_ context.Context, messageID, targetChatID string) (string, error) {
	if f.unsupportedMedia {
		return "", errUnsupportedMedia
	}
	f.lastCall = "forward:" + messageID + ":" + targetChatID
	return "msg-fwd-1", nil
}
func (f *fakeBackend) ArchiveChat(_ context.Context, chatID string, archived bool) error {
	f.lastCall = "archive:" + chatID
	if !archived {
		f.lastCall = "unarchive:" + chatID
	}
	return nil
}
func (f *fakeBackend) MuteChat(_ context.Context, chatID string, muted bool) error {
	f.lastCall = "mute:" + chatID
	if !muted {
		f.lastCall = "unmute:" + chatID
	}
	return nil
}
func (f *fakeBackend) BlockContact(_ context.Context, id string, blocked bool) error {
	f.lastCall = "block:" + id
	if !blocked {
		f.lastCall = "unblock:" + id
	}
	return nil
}
func (f *fakeBackend) SetContactLabel(_ context.Context, phone, name string) error {
	f.lastCall = "label:" + phone + ":" + name
	return nil
}

func TestHTTPAndSSEServer(t *testing.T) {
	backend := &fakeBackend{
		hub: NewEventHub(),
		health: HealthStatus{
			OK:             true,
			State:          "ready",
			Connected:      true,
			LoggedIn:       true,
			ContactsSynced: true,
			SelfWid:        "85299990000@c.us",
			SelfLid:        "1234567890@lid",
		},
	}

	emptyTokenSrv := httptest.NewServer(NewBridgeHandler(backend, ""))
	defer emptyTokenSrv.Close()
	failClosedResp, err := http.Get(emptyTokenSrv.URL + "/v1/contact?id=85261230001@c.us")
	if err != nil || failClosedResp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("empty token must fail closed with 401, got (%v, %v)", failClosedResp, err)
	}
	_ = failClosedResp.Body.Close()

	backend.hub.Publish(BridgeEvent{Type: "qr", Data: map[string]any{"qr": "hello-qr"}})

	srv := httptest.NewServer(NewBridgeHandler(backend, "secret-token"))
	defer srv.Close()

	res, err := http.Get(srv.URL + "/health")
	if err != nil || res.StatusCode != http.StatusOK {
		t.Fatalf("GET /health = (%v, %v)", res, err)
	}
	var unauthHealth HealthStatus
	if err := json.NewDecoder(res.Body).Decode(&unauthHealth); err != nil {
		t.Fatalf("decode unauth /health: %v", err)
	}
	_ = res.Body.Close()
	if unauthHealth.SelfWid != "" || unauthHealth.SelfLid != "" {
		t.Fatalf("unauthenticated /health must omit selfWid/selfLid, got %+v", unauthHealth)
	}

	authHealthReq, err := http.NewRequest(http.MethodGet, srv.URL+"/health", nil)
	if err != nil {
		t.Fatalf("new auth /health request: %v", err)
	}
	authHealthReq.Header.Set("Authorization", "Bearer secret-token")
	authHealthRes, err := http.DefaultClient.Do(authHealthReq)
	if err != nil || authHealthRes.StatusCode != http.StatusOK {
		t.Fatalf("authenticated GET /health = (%v, %v)", authHealthRes, err)
	}
	var authHealth HealthStatus
	if err := json.NewDecoder(authHealthRes.Body).Decode(&authHealth); err != nil {
		t.Fatalf("decode auth /health: %v", err)
	}
	_ = authHealthRes.Body.Close()
	if authHealth.SelfWid == "" || authHealth.SelfLid == "" {
		t.Fatalf("authenticated /health should include selfWid and selfLid, got %+v", authHealth)
	}

	unauth, err := http.Get(srv.URL + "/v1/contact?id=85261230001@c.us")
	if err != nil || unauth.StatusCode != http.StatusUnauthorized {
		t.Fatalf("expected 401 without token, got (%v, %v)", unauth, err)
	}
	_ = unauth.Body.Close()

	doReq := func(method, path string, body any) *http.Response {
		t.Helper()
		var rdr *bytes.Reader
		if body != nil {
			raw, _ := json.Marshal(body)
			rdr = bytes.NewReader(raw)
		} else {
			rdr = bytes.NewReader(nil)
		}
		req, err := http.NewRequest(method, srv.URL+path, rdr)
		if err != nil {
			t.Fatalf("new request: %v", err)
		}
		req.Header.Set("Authorization", "Bearer secret-token")
		req.Header.Set("Content-Type", "application/json")
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatalf("%s %s: %v", method, path, err)
		}
		return resp
	}

	for _, tc := range []struct {
		method string
		path   string
		body   any
		want   string
	}{
		{"GET", "/v1/contact?id=85261230001@c.us", nil, "contact:85261230001@c.us"},
		{"POST", "/v1/lid/resolve", map[string]any{"ids": []string{"123@lid"}}, "lid:123@lid"},
		{"POST", "/v1/send/text", map[string]any{"chatId": "852@c.us", "text": "hi"}, "text:852@c.us:hi"},
		{"POST", "/v1/send/poll", map[string]any{"chatId": "852@c.us", "name": "Q", "options": []string{"A", "B"}}, "poll:852@c.us:Q:A|B"},
		{"POST", "/v1/message/forward", map[string]any{"messageId": "m1", "targetChatId": "me@c.us"}, "forward:m1:me@c.us"},
		{"POST", "/v1/chat/archive", map[string]any{"chatId": "852@c.us"}, "archive:852@c.us"},
		{"POST", "/v1/chat/mute", map[string]any{"chatId": "852@c.us", "muted": false}, "unmute:852@c.us"},
		{"POST", "/v1/contact/block", map[string]any{"id": "852@c.us"}, "block:852@c.us"},
		{"POST", "/v1/contact/label", map[string]any{"phone": "85261230001", "name": "（可疑推銷）"}, "label:85261230001:（可疑推銷）"},
	} {
		resp := doReq(tc.method, tc.path, tc.body)
		if resp.StatusCode != http.StatusOK {
			t.Fatalf("%s %s status = %d", tc.method, tc.path, resp.StatusCode)
		}
		_ = resp.Body.Close()
		if backend.lastCall != tc.want {
			t.Fatalf("%s %s lastCall = %q, want %q", tc.method, tc.path, backend.lastCall, tc.want)
		}
	}

	backend.notReady = true
	notReadyResp := doReq("POST", "/v1/send/text", map[string]any{"chatId": "852@c.us", "text": "hi"})
	if notReadyResp.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("expected 503 when not ready, got %d", notReadyResp.StatusCode)
	}
	_ = notReadyResp.Body.Close()

	backend.unsupportedMedia = true
	mediaResp := doReq("POST", "/v1/message/forward", map[string]any{"messageId": "img-1", "targetChatId": "me@c.us"})
	if mediaResp.StatusCode != http.StatusUnprocessableEntity {
		t.Fatalf("expected 422 for unsupported media forward, got %d", mediaResp.StatusCode)
	}
	_ = mediaResp.Body.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	sseReq, _ := http.NewRequestWithContext(ctx, "GET", srv.URL+"/v1/events", nil)
	sseReq.Header.Set("Authorization", "Bearer secret-token")
	sseResp, err := http.DefaultClient.Do(sseReq)
	if err != nil || sseResp.StatusCode != http.StatusOK {
		t.Fatalf("GET /v1/events = (%v, %v)", sseResp, err)
	}
	defer func() { _ = sseResp.Body.Close() }()

	scanner := bufio.NewScanner(sseResp.Body)
	var lines []string
	for scanner.Scan() {
		line := scanner.Text()
		if line != "" {
			lines = append(lines, line)
		}
		if len(lines) >= 2 {
			break
		}
	}
	joined := strings.Join(lines, "\n")
	if !strings.Contains(joined, "event: qr") || !strings.Contains(joined, "hello-qr") {
		t.Fatalf("unexpected SSE output: %q", joined)
	}

	readSSEEvents := func(url, lastEventID string, count int) []string {
		t.Helper()
		rctx, rcancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer rcancel()
		req, _ := http.NewRequestWithContext(rctx, "GET", url+"/v1/events", nil)
		req.Header.Set("Authorization", "Bearer secret-token")
		if lastEventID != "" {
			req.Header.Set("Last-Event-ID", lastEventID)
		}
		resp, err := http.DefaultClient.Do(req)
		if err != nil || resp.StatusCode != http.StatusOK {
			t.Fatalf("SSE %s = (%v, %v)", url, resp, err)
		}
		defer func() { _ = resp.Body.Close() }()
		sc := bufio.NewScanner(resp.Body)
		var blocks []string
		var cur []string
		for sc.Scan() {
			line := sc.Text()
			if line == "" {
				if len(cur) > 0 {
					blocks = append(blocks, strings.Join(cur, "\n"))
					cur = nil
					if len(blocks) >= count {
						break
					}
				}
				continue
			}
			cur = append(cur, line)
		}
		return blocks
	}

	backend.hub.Publish(BridgeEvent{Type: "ready", Data: map[string]any{"selfWid": "85299990000@c.us"}})
	backend.hub.Publish(BridgeEvent{Type: "message", Data: map[string]any{"id": "wire-1"}})
	initialBlocks := readSSEEvents(srv.URL, "", 2)
	if len(initialBlocks) != 2 || !strings.Contains(initialBlocks[1], "wire-1") {
		t.Fatalf("unexpected initial wire SSE blocks: %v", initialBlocks)
	}
	var wireID string
	for _, l := range strings.Split(initialBlocks[1], "\n") {
		if strings.HasPrefix(l, "id: ") {
			wireID = strings.TrimPrefix(l, "id: ")
		}
	}
	if wireID == "" {
		t.Fatalf("missing SSE id line in %q", initialBlocks[1])
	}

	backend.hub.Publish(BridgeEvent{Type: "message", Data: map[string]any{"id": "wire-2"}})
	resumedBlocks := readSSEEvents(srv.URL, wireID, 1)
	if len(resumedBlocks) != 1 || !strings.Contains(resumedBlocks[0], "wire-2") {
		t.Fatalf("Last-Event-ID=%q should resume at wire-2, got %v", wireID, resumedBlocks)
	}

	restartedBackend := &fakeBackend{hub: NewEventHub(), health: backend.health}
	restartedBackend.hub.Publish(BridgeEvent{Type: "ready", Data: map[string]any{"selfWid": "85299990000@c.us"}})
	restartedBackend.hub.Publish(BridgeEvent{Type: "message", Data: map[string]any{"id": "wire-post-restart"}})
	restartedSrv := httptest.NewServer(NewBridgeHandler(restartedBackend, "secret-token"))
	defer restartedSrv.Close()

	restartedBlocks := readSSEEvents(restartedSrv.URL, wireID, 2)
	if len(restartedBlocks) != 2 || !strings.Contains(restartedBlocks[0], "event: ready") || !strings.Contains(restartedBlocks[1], "wire-post-restart") {
		t.Fatalf("stale Last-Event-ID=%q after restart must replay ready + wire-post-restart, got %v", wireID, restartedBlocks)
	}
}

func TestNewWhatsmeowBridgeSQLiteInitSyncReconnectAndLID(t *testing.T) {
	ctx := context.Background()
	dbPath := filepath.Join(t.TempDir(), "whatsmeow.db")

	bridge, err := NewWhatsmeowBridge(ctx, dbPath, "ERROR")
	if err != nil {
		t.Fatalf("NewWhatsmeowBridge: %v", err)
	}
	defer func() { _ = bridge.Close() }()

	health := bridge.Health()
	if !health.OK || health.ContactsSynced {
		t.Fatalf("unexpected initial health: %+v", health)
	}
	if _, err := bridge.GetContact(ctx, "85261234567@c.us"); !errors.Is(err, errNotReady) {
		t.Fatalf("expected errNotReady before login, got %v", err)
	}

	selfJID := types.NewJID("85299990000", types.DefaultUserServer)
	bridge.client.Store.ID = &selfJID
	bridge.client.Store.Account = &waAdv.ADVSignedDeviceIdentity{
		Details:             []byte("details"),
		AccountSignatureKey: make([]byte, 32),
		AccountSignature:    make([]byte, 64),
		DeviceSignature:     make([]byte, 64),
	}
	if err := bridge.client.Store.Save(ctx); err != nil {
		t.Fatalf("save device store: %v", err)
	}
	savedJID := types.NewJID("85261110001", types.DefaultUserServer)
	if err := bridge.client.Store.Contacts.PutContactName(ctx, savedJID, "Mum", "Mum"); err != nil {
		t.Fatalf("put saved contact: %v", err)
	}
	savedLID := types.NewJID("555000111", types.HiddenUserServer)
	if err := bridge.client.Store.LIDs.PutLIDMapping(ctx, savedLID, savedJID); err != nil {
		t.Fatalf("put lid mapping: %v", err)
	}
	unsavedPN := types.NewJID("85261234567", types.DefaultUserServer)
	unsavedLID := types.NewJID("555000222", types.HiddenUserServer)
	if err := bridge.client.Store.LIDs.PutLIDMapping(ctx, unsavedLID, unsavedPN); err != nil {
		t.Fatalf("put unsaved lid mapping: %v", err)
	}

	unknownBeforeSync, err := bridge.GetContact(ctx, "85261234567@c.us")
	if err != nil {
		t.Fatalf("GetContact before sync: %v", err)
	}
	if unknownBeforeSync.IsMyContact != nil {
		t.Fatalf("expected unknown IsMyContact before sync, got %v", *unknownBeforeSync.IsMyContact)
	}

	savedBeforeSync, err := bridge.GetContact(ctx, "85261110001@c.us")
	if err != nil {
		t.Fatalf("GetContact saved before sync: %v", err)
	}
	if savedBeforeSync.IsMyContact == nil || !*savedBeforeSync.IsMyContact {
		t.Fatalf("expected saved contact to stay true before sync, got %+v", savedBeforeSync)
	}

	bridge.mu.Lock()
	bridge.connected = true
	bridge.loggedIn = true
	bridge.connGen = 1
	bridge.mu.Unlock()
	bridge.markContactsSyncedForGen(1)

	if !bridge.Health().ContactsSynced {
		t.Fatal("expected ContactsSynced=true for current connection gen 1")
	}

	unsavedAfterSync, err := bridge.GetContact(ctx, "85261234567@c.us")
	if err != nil {
		t.Fatalf("GetContact after sync: %v", err)
	}
	if unsavedAfterSync.IsMyContact == nil || *unsavedAfterSync.IsMyContact {
		t.Fatalf("expected IsMyContact=false after sync, got %+v", unsavedAfterSync)
	}

	lidSavedContact, err := bridge.GetContact(ctx, "555000111@lid")
	if err != nil {
		t.Fatalf("GetContact(savedLID): %v", err)
	}
	if lidSavedContact.IsMyContact == nil || !*lidSavedContact.IsMyContact || lidSavedContact.Name != "Mum" {
		t.Fatalf("expected LID saved via phone contact to be true/Mum, got %+v", lidSavedContact)
	}

	lidUnsavedContact, err := bridge.GetContact(ctx, "555000222@lid")
	if err != nil {
		t.Fatalf("GetContact(unsavedLID): %v", err)
	}
	if lidUnsavedContact.IsMyContact == nil || *lidUnsavedContact.IsMyContact {
		t.Fatalf("expected phone-verified unsaved LID to be false, got %+v", lidUnsavedContact)
	}

	unmappedLID, err := bridge.GetContact(ctx, "999888777@lid")
	if err != nil {
		t.Fatalf("GetContact(unmappedLID): %v", err)
	}
	if unmappedLID.IsMyContact != nil {
		t.Fatalf("unmapped LID must fail closed as unknown (nil), got %v", *unmappedLID.IsMyContact)
	}

	bridge.handleEvent(&events.Disconnected{})
	if bridge.Health().ContactsSynced {
		t.Fatal("Disconnected must invalidate ContactsSynced")
	}

	type syncAttempt struct {
		fullSync bool
		err      error
	}
	var fetchMu sync.Mutex
	fetchFail := true
	fetchCalls := 0
	attemptDone := make(chan syncAttempt, 16)
	bridge.syncRetryDelay = 800 * time.Millisecond
	bridge.onSyncAttemptDone = func(_ uint64, fullSync bool, err error) {
		attemptDone <- syncAttempt{fullSync: fullSync, err: err}
	}
	bridge.fetchContactsFn = func(_ context.Context, fullSync bool) error {
		fetchMu.Lock()
		fetchCalls++
		fail := fetchFail
		fetchMu.Unlock()
		if fail {
			return errors.New("app state key not found after snapshot checkpoint")
		}
		if !fullSync {
			return errors.New("incremental retry cannot recover skipped snapshot contacts")
		}
		return nil
	}

	bridge.handleEvent(&events.Connected{})
	select {
	case res := <-attemptDone:
		if res.err == nil || res.fullSync {
			t.Fatalf("expected initial incremental sync attempt to fail, got %+v", res)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for initial failing syncContacts")
	}
	if bridge.Health().ContactsSynced {
		t.Fatal("failed syncContacts (missing key) must leave ContactsSynced=false")
	}

	bridge.mu.RLock()
	curGen := bridge.connGen
	bridge.mu.RUnlock()

	bridge.markContactsSyncedForGen(curGen - 1)
	if bridge.Health().ContactsSynced {
		t.Fatal("stale connection generation must not reopen contact gate")
	}

	unknownBeforeKey, err := bridge.GetContact(ctx, "85261234567@c.us")
	if err != nil {
		t.Fatalf("GetContact before key recovery: %v", err)
	}
	if unknownBeforeKey.IsMyContact != nil {
		t.Fatalf("expected unknown IsMyContact before key recovery, got %v", *unknownBeforeKey.IsMyContact)
	}

	fetchMu.Lock()
	fetchFail = false
	fetchMu.Unlock()
	select {
	case bridge.syncRetryWake <- struct{}{}:
	default:
	}

	deadline := time.After(2 * time.Second)
	for {
		select {
		case res := <-attemptDone:
			if res.err == nil {
				if !res.fullSync {
					t.Fatal("retry after failed fetch must force fullSync=true")
				}
				goto recovered
			}
		case <-deadline:
			t.Fatal("timed out waiting for generation-scoped fullSync retry after key recovery")
		}
	}
recovered:
	if !bridge.Health().ContactsSynced {
		t.Fatal("expected ContactsSynced=true after fullSync retry succeeded")
	}
	fetchMu.Lock()
	callsAfterRecovery := fetchCalls
	fetchMu.Unlock()
	if callsAfterRecovery != 2 {
		t.Fatalf("successful retry must complete without an extra full refetch, got %d fetches", callsAfterRecovery)
	}
	unsavedAfterCatchup, err := bridge.GetContact(ctx, "85261234567@c.us")
	if err != nil {
		t.Fatalf("GetContact after key recovery: %v", err)
	}
	if unsavedAfterCatchup.IsMyContact == nil || *unsavedAfterCatchup.IsMyContact {
		t.Fatalf("expected IsMyContact=false after key recovery, got %+v", unsavedAfterCatchup)
	}

	bridge.handleEvent(&events.Disconnected{})
	var finalAttemptCount int
	var finalMu sync.Mutex
	finalDone := make(chan syncAttempt, 16)
	bridge.syncRetryDelay = 2 * time.Millisecond
	bridge.onSyncAttemptDone = func(_ uint64, fullSync bool, err error) {
		finalDone <- syncAttempt{fullSync: fullSync, err: err}
	}
	bridge.fetchContactsFn = func(_ context.Context, fullSync bool) error {
		finalMu.Lock()
		finalAttemptCount++
		n := finalAttemptCount
		finalMu.Unlock()
		if n < maxSyncAttempts {
			return errors.New("still missing key")
		}
		if n == maxSyncAttempts {
			bridge.handleEvent(&events.AppStateSyncComplete{Name: appstate.WAPatchCriticalUnblockLow})
			return errors.New("key arrived mid-final-attempt")
		}
		if !fullSync {
			return errors.New("expected fullSync on wake retry")
		}
		return nil
	}
	bridge.handleEvent(&events.Connected{})
	finalDeadline := time.After(2 * time.Second)
	completedAttempts := 0
	for completedAttempts < maxSyncAttempts {
		select {
		case res := <-finalDone:
			if res.err == nil {
				t.Fatal("ordinary AppStateSyncComplete during the final failed attempt must not bypass the retry budget")
			}
			completedAttempts++
		case <-finalDeadline:
			t.Fatalf("timed out waiting for bounded sync attempts, got %d", completedAttempts)
		}
	}
	finalMu.Lock()
	gotFinalAttempts := finalAttemptCount
	finalMu.Unlock()
	if gotFinalAttempts != maxSyncAttempts {
		t.Fatalf("ordinary AppStateSyncComplete wake must not extend attempts beyond %d, got %d", maxSyncAttempts, gotFinalAttempts)
	}
	if bridge.Health().ContactsSynced {
		t.Fatal("expected ContactsSynced=false after bounded final-attempt failure")
	}

	if err := bridge.store.SaveMessage(ctx, StoredMessage{
		ID:        "img-msg-1",
		ChatJID:   "85261234567@c.us",
		SenderJID: "85261234567@c.us",
		MsgType:   "image",
		Body:      "See screenshot",
	}); err != nil {
		t.Fatalf("SaveMessage image: %v", err)
	}
	if _, err := bridge.ForwardMessage(ctx, "img-msg-1", "85299990000@c.us"); !errors.Is(err, errUnsupportedMedia) {
		t.Fatalf("expected errUnsupportedMedia when forwarding image, got %v", err)
	}
}

func TestBridgeArchiveEventReconcilesSyncRestores(t *testing.T) {
	ctx := context.Background()
	dbPath := filepath.Join(t.TempDir(), "archive-events.db")

	bridge, err := NewWhatsmeowBridge(ctx, dbPath, "ERROR")
	if err != nil {
		t.Fatalf("NewWhatsmeowBridge: %v", err)
	}
	defer func() { _ = bridge.Close() }()

	if !bridge.client.EmitAppStateEventsOnFullSync {
		t.Fatal("expected EmitAppStateEventsOnFullSync=true so full sync emits lid_contact rows")
	}

	selfJID := types.NewJID("85299990000", types.DefaultUserServer)
	bridge.client.Store.ID = &selfJID
	bridge.client.Store.Account = &waAdv.ADVSignedDeviceIdentity{
		Details:             []byte("details"),
		AccountSignatureKey: make([]byte, 32),
		AccountSignature:    make([]byte, 64),
		DeviceSignature:     make([]byte, 64),
	}
	if err := bridge.client.Store.Save(ctx); err != nil {
		t.Fatalf("save device store: %v", err)
	}

	ch, cancel := bridge.Events().Subscribe(16)
	defer cancel()

	// Simulates initial QR pairing completing Store initialization and installing the archive wrapper.
	bridge.handleEvent(&events.PairSuccess{})
	select {
	case evt := <-ch:
		if evt.Type != "authenticated" {
			t.Fatalf("expected authenticated event after PairSuccess, got %+v", evt)
		}
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for authenticated event")
	}

	chatJID := types.NewJID("85261112222", types.DefaultUserServer)
	raceJID := types.NewJID("85264443333", types.DefaultUserServer)
	if err := bridge.client.Store.ChatSettings.PutArchived(ctx, raceJID, false); err != nil {
		t.Fatalf("PutArchived sync restore before live archive: %v", err)
	}
	if err := bridge.client.Store.ChatSettings.PutArchived(ctx, raceJID, true); err != nil {
		t.Fatalf("PutArchived live archive after sync restore: %v", err)
	}
	bridge.handleEvent(&events.Archive{
		JID:          raceJID,
		Timestamp:    time.Now(),
		FromFullSync: false,
		Action:       &waSyncAction.ArchiveChatAction{Archived: proto.Bool(true)},
	})
	select {
	case evt := <-ch:
		if evt.Type != "chat_archived" {
			t.Fatalf("expected live archive event before sync completion, got %+v", evt)
		}
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for live archive event")
	}
	bridge.handleEvent(&events.AppStateSyncComplete{Name: appstate.WAPatchRegularLow})
	select {
	case unexpected := <-ch:
		t.Fatalf("sync completion must use the final archived=true state, got %+v", unexpected)
	case <-time.After(30 * time.Millisecond):
	}

	t1 := time.Date(2026, 11, 24, 10, 0, 0, 0, time.UTC)
	t2 := t1.Add(time.Minute)
	t3 := t2.Add(time.Minute)
	t4 := t3.Add(time.Minute)

	// Full sync seeds whatsmeow_chat_settings directly through Store.ChatSettings.PutArchived without emitting SSE events.
	if err := bridge.client.Store.ChatSettings.PutArchived(ctx, chatJID, true); err != nil {
		t.Fatalf("PutArchived full-sync seed: %v", err)
	}
	select {
	case unexpected := <-ch:
		t.Fatalf("full-sync ChatSettings seeding must not emit SSE event, got %+v", unexpected)
	case <-time.After(30 * time.Millisecond):
	}

	readNext := func() BridgeEvent {
		t.Helper()
		select {
		case evt := <-ch:
			return evt
		case <-time.After(time.Second):
			t.Fatal("timed out waiting for chat_archived event")
			return BridgeEvent{}
		}
	}

	// Un-archiving after full sync updates ChatSettings first and emits archived=false, wasArchived=true.
	if err := bridge.client.Store.ChatSettings.PutArchived(ctx, chatJID, false); err != nil {
		t.Fatalf("PutArchived live un-archive: %v", err)
	}
	bridge.handleEvent(&events.Archive{
		JID:          chatJID,
		Timestamp:    t2,
		FromFullSync: false,
		Action:       &waSyncAction.ArchiveChatAction{Archived: proto.Bool(false)},
	})
	evt := readNext()
	data, _ := evt.Data.(map[string]any)
	if evt.Type != "chat_archived" || data["chatId"] != "85261112222@c.us" || data["isGroup"] != false || data["isChannel"] != false || data["archived"] != false || data["wasArchived"] != true {
		t.Fatalf("unexpected un-archive event payload: %+v", evt)
	}

	// Redundant live un-archive uses stored prev=false so wasArchived=false.
	if err := bridge.client.Store.ChatSettings.PutArchived(ctx, chatJID, false); err != nil {
		t.Fatalf("PutArchived duplicate un-archive: %v", err)
	}
	bridge.handleEvent(&events.Archive{
		JID:          chatJID,
		Timestamp:    t2,
		FromFullSync: false,
		Action:       &waSyncAction.ArchiveChatAction{Archived: proto.Bool(false)},
	})
	dup := readNext()
	dupData, _ := dup.Data.(map[string]any)
	if dupData["archived"] != false || dupData["wasArchived"] != false {
		t.Fatalf("duplicate un-archive must preserve wasArchived=false, got %+v", dup)
	}

	// Recovery updates ChatSettings directly via PutArchived (no events.Archive emitted) and updates baseline state.
	if err := bridge.client.Store.ChatSettings.PutArchived(ctx, chatJID, true); err != nil {
		t.Fatalf("PutArchived live archive before recovery: %v", err)
	}
	bridge.handleEvent(&events.Archive{
		JID:          chatJID,
		Timestamp:    t3,
		FromFullSync: false,
		Action:       &waSyncAction.ArchiveChatAction{Archived: proto.Bool(true)},
	})
	_ = readNext()

	if err := bridge.client.Store.ChatSettings.PutArchived(ctx, chatJID, false); err != nil {
		t.Fatalf("PutArchived recovery un-archive: %v", err)
	}
	select {
	case unexpected := <-ch:
		t.Fatalf("recovery ChatSettings write must not emit SSE event, got %+v", unexpected)
	case <-time.After(30 * time.Millisecond):
	}
	settingsAfterRecovery, err := bridge.rawChatSettingsStore().GetChatSettings(ctx, chatJID)
	if err != nil || !settingsAfterRecovery.Found || settingsAfterRecovery.Archived {
		t.Fatalf("expected recovery ChatSettings Archived=false, got (%+v, %v)", settingsAfterRecovery, err)
	}
	bridge.handleEvent(&events.AppStateSyncComplete{Name: appstate.WAPatchCriticalUnblockLow})
	select {
	case unexpected := <-ch:
		t.Fatalf("contact sync completion must leave archive restores pending, got %+v", unexpected)
	case <-time.After(30 * time.Millisecond):
	}
	bridge.handleEvent(&events.AppStateSyncComplete{Name: appstate.WAPatchRegularLow})
	recoveryEvt := readNext()
	recoveryData, _ := recoveryEvt.Data.(map[string]any)
	if recoveryData["chatId"] != "85261112222@c.us" || recoveryData["archived"] != false || recoveryData["wasArchived"] != true {
		t.Fatalf("sync completion must reconcile the recovery un-archive, got %+v", recoveryEvt)
	}

	// Redundant live un-archive after recovery reads recovered prev=false so wasArchived=false.
	if err := bridge.client.Store.ChatSettings.PutArchived(ctx, chatJID, false); err != nil {
		t.Fatalf("PutArchived duplicate un-archive after recovery: %v", err)
	}
	bridge.handleEvent(&events.Archive{
		JID:          chatJID,
		Timestamp:    t4,
		FromFullSync: false,
		Action:       &waSyncAction.ArchiveChatAction{Archived: proto.Bool(false)},
	})
	afterRecoveryDup := readNext()
	afterRecoveryDupData, _ := afterRecoveryDup.Data.(map[string]any)
	if afterRecoveryDupData["archived"] != false || afterRecoveryDupData["wasArchived"] != false {
		t.Fatalf("redundant un-archive after recovery must report wasArchived=false, got %+v", afterRecoveryDup)
	}

	// Valid live restore whose event timestamp precedes a prior archive (e.g. phone clock skew) still emits wasArchived=true.
	if err := bridge.client.Store.ChatSettings.PutArchived(ctx, chatJID, true); err != nil {
		t.Fatalf("PutArchived live archive before clock-skewed restore: %v", err)
	}
	bridge.handleEvent(&events.Archive{
		JID:          chatJID,
		Timestamp:    t3,
		FromFullSync: false,
		Action:       &waSyncAction.ArchiveChatAction{Archived: proto.Bool(true)},
	})
	_ = readNext()

	if err := bridge.client.Store.ChatSettings.PutArchived(ctx, chatJID, false); err != nil {
		t.Fatalf("PutArchived clock-skewed restore: %v", err)
	}
	bridge.handleEvent(&events.Archive{
		JID:          chatJID,
		Timestamp:    t1,
		FromFullSync: false,
		Action:       &waSyncAction.ArchiveChatAction{Archived: proto.Bool(false)},
	})
	skewedEvt := readNext()
	skewedData, _ := skewedEvt.Data.(map[string]any)
	if skewedData["archived"] != false || skewedData["wasArchived"] != true {
		t.Fatalf("clock-skewed valid restore must not be dropped and must keep wasArchived=true, got %+v", skewedEvt)
	}

	// Out-of-order concurrent live dispatch preserves each transition's recorded prior state.
	if err := bridge.client.Store.ChatSettings.PutArchived(ctx, chatJID, true); err != nil {
		t.Fatalf("PutArchived out-of-order archive: %v", err)
	}
	if err := bridge.client.Store.ChatSettings.PutArchived(ctx, chatJID, false); err != nil {
		t.Fatalf("PutArchived out-of-order restore: %v", err)
	}
	bridge.handleEvent(&events.Archive{
		JID:          chatJID,
		Timestamp:    t4,
		FromFullSync: false,
		Action:       &waSyncAction.ArchiveChatAction{Archived: proto.Bool(false)},
	})
	oooRestore := readNext()
	oooRestoreData, _ := oooRestore.Data.(map[string]any)
	if oooRestoreData["archived"] != false || oooRestoreData["wasArchived"] != true {
		t.Fatalf("out-of-order restore must keep wasArchived=true, got %+v", oooRestore)
	}
	bridge.handleEvent(&events.Archive{
		JID:          chatJID,
		Timestamp:    t3,
		FromFullSync: false,
		Action:       &waSyncAction.ArchiveChatAction{Archived: proto.Bool(true)},
	})
	oooArchive := readNext()
	oooArchiveData, _ := oooArchive.Data.(map[string]any)
	if oooArchiveData["archived"] != true || oooArchiveData["wasArchived"] != false {
		t.Fatalf("out-of-order archive must keep wasArchived=false, got %+v", oooArchive)
	}

	// First restore of an unseen chat after PutArchived(false) still defaults wasArchived to true.
	unseenJID := types.NewJID("85263334444", types.DefaultUserServer)
	if err := bridge.client.Store.ChatSettings.PutArchived(ctx, unseenJID, false); err != nil {
		t.Fatalf("PutArchived unseen chat restore: %v", err)
	}
	bridge.handleEvent(&events.Archive{
		JID:          unseenJID,
		Timestamp:    t4,
		FromFullSync: false,
		Action:       &waSyncAction.ArchiveChatAction{Archived: proto.Bool(false)},
	})
	unseenEvt := readNext()
	unseenData, _ := unseenEvt.Data.(map[string]any)
	if unseenData["chatId"] != "85263334444@c.us" || unseenData["archived"] != false || unseenData["wasArchived"] != true {
		t.Fatalf("first restore of unseen chat must emit wasArchived=true, got %+v", unseenEvt)
	}

	// Full sync applies archive mutations through ChatSettings without emitting events;
	// completing regular_low reconciles only unconsumed unarchived states that were not already unarchived.
	alreadyUnarchivedJID := types.NewJID("85265558888", types.DefaultUserServer)
	if err := bridge.rawChatSettingsStore().PutArchived(ctx, alreadyUnarchivedJID, false); err != nil {
		t.Fatalf("raw PutArchived already-unarchived seed: %v", err)
	}
	if err := bridge.store.PutArchiveState(ctx, bridge.selfDeviceJID(), canonicalJID(alreadyUnarchivedJID), false); err != nil {
		t.Fatalf("seed explicit already-unarchived archive state: %v", err)
	}
	if err := bridge.client.Store.ChatSettings.PutArchived(ctx, alreadyUnarchivedJID, false); err != nil {
		t.Fatalf("PutArchived full-sync already-unarchived chat: %v", err)
	}
	fullSyncJID := types.NewJID("85265556666", types.DefaultUserServer)
	if err := bridge.client.Store.ChatSettings.PutArchived(ctx, fullSyncJID, false); err != nil {
		t.Fatalf("PutArchived full-sync restore: %v", err)
	}
	mutedRestoreJID := types.NewJID("85265559999", types.DefaultUserServer)
	if err := bridge.rawChatSettingsStore().PutMutedUntil(ctx, mutedRestoreJID, time.Now().Add(time.Hour)); err != nil {
		t.Fatalf("raw PutMutedUntil mute-only seed: %v", err)
	}
	if err := bridge.client.Store.ChatSettings.PutArchived(ctx, mutedRestoreJID, false); err != nil {
		t.Fatalf("PutArchived full-sync muted restore: %v", err)
	}
	stillArchivedJID := types.NewJID("85265557777", types.DefaultUserServer)
	if err := bridge.client.Store.ChatSettings.PutArchived(ctx, stillArchivedJID, true); err != nil {
		t.Fatalf("PutArchived full-sync still-archived chat: %v", err)
	}
	bridge.handleEvent(&events.AppStateSyncComplete{Name: appstate.WAPatchCriticalUnblockLow})
	select {
	case unexpected := <-ch:
		t.Fatalf("critical_unblock_low completion must not flush regular_low restores, got %+v", unexpected)
	case <-time.After(30 * time.Millisecond):
	}
	bridge.handleEvent(&events.AppStateSyncComplete{Name: appstate.WAPatchRegularLow})
	restored := make(map[string]bool)
	for range []string{"85265556666@c.us", "85265559999@c.us"} {
		fullSyncEvt := readNext()
		fullSyncData, _ := fullSyncEvt.Data.(map[string]any)
		chatID, _ := fullSyncData["chatId"].(string)
		if fullSyncData["archived"] != false || fullSyncData["wasArchived"] != true {
			t.Fatalf("full-sync restore must emit wasArchived=true, got %+v", fullSyncEvt)
		}
		restored[chatID] = true
	}
	for _, chatID := range []string{"85265556666@c.us", "85265559999@c.us"} {
		if !restored[chatID] {
			t.Fatalf("full-sync reconciliation missing %s, got %v", chatID, restored)
		}
	}
	select {
	case unexpected := <-ch:
		t.Fatalf("live-consumed, already-unarchived, or archived=true chats must not emit a restore, got %+v", unexpected)
	case <-time.After(30 * time.Millisecond):
	}

	// Defensive guard: FromFullSync=true events are ignored, and group chats set isGroup=true.
	bridge.handleEvent(&events.Archive{
		JID:          chatJID,
		Timestamp:    t1,
		FromFullSync: true,
		Action:       &waSyncAction.ArchiveChatAction{Archived: proto.Bool(true)},
	})
	select {
	case unexpected := <-ch:
		t.Fatalf("FromFullSync=true event must not emit SSE event, got %+v", unexpected)
	case <-time.After(30 * time.Millisecond):
	}
	groupJID := types.NewJID("1203630000", types.GroupServer)
	if err := bridge.client.Store.ChatSettings.PutArchived(ctx, groupJID, false); err != nil {
		t.Fatalf("PutArchived unseen group restore: %v", err)
	}
	bridge.handleEvent(&events.Archive{
		JID:          groupJID,
		Timestamp:    t4,
		FromFullSync: false,
		Action:       &waSyncAction.ArchiveChatAction{Archived: proto.Bool(false)},
	})
	grpEvt := readNext()
	grpData, _ := grpEvt.Data.(map[string]any)
	if grpData["chatId"] != "1203630000@g.us" || grpData["isGroup"] != true || grpData["archived"] != false || grpData["wasArchived"] != true {
		t.Fatalf("unexpected group un-archive event: %+v", grpEvt)
	}
}

func TestBridgeArchiveTrackingEdgeCases(t *testing.T) {
	ctx := context.Background()
	dbPath := filepath.Join(t.TempDir(), "archive-edge.db")

	bridge, err := NewWhatsmeowBridge(ctx, dbPath, "ERROR")
	if err != nil {
		t.Fatalf("NewWhatsmeowBridge: %v", err)
	}
	defer func() { _ = bridge.Close() }()

	selfJID := types.NewJID("85299990001", types.DefaultUserServer)
	bridge.client.Store.ID = &selfJID
	bridge.client.Store.Account = &waAdv.ADVSignedDeviceIdentity{
		Details:             []byte("details"),
		AccountSignatureKey: make([]byte, 32),
		AccountSignature:    make([]byte, 64),
		DeviceSignature:     make([]byte, 64),
	}
	if err := bridge.client.Store.Save(ctx); err != nil {
		t.Fatalf("save device store: %v", err)
	}

	ch, cancel := bridge.Events().Subscribe(16)
	defer cancel()
	bridge.handleEvent(&events.PairSuccess{})
	<-ch // authenticated

	// 1. Previously unpinned chat (whatsmeow_chat_settings row with archived=false, pinned=false,
	// muted_until=0 and no bridge_archive_state row) must still emit a restore on first PutArchived(false).
	unpinnedJID := types.NewJID("85261001111", types.DefaultUserServer)
	if err := bridge.rawChatSettingsStore().PutPinned(ctx, unpinnedJID, false); err != nil {
		t.Fatalf("raw PutPinned unpinned row: %v", err)
	}
	if err := bridge.client.Store.ChatSettings.PutArchived(ctx, unpinnedJID, false); err != nil {
		t.Fatalf("PutArchived after unpin: %v", err)
	}
	bridge.handleEvent(&events.AppStateSyncComplete{Name: appstate.WAPatchRegularLow})
	select {
	case evt := <-ch:
		data, _ := evt.Data.(map[string]any)
		if evt.Type != "chat_archived" || data["chatId"] != "85261001111@c.us" || data["archived"] != false || data["wasArchived"] != true {
			t.Fatalf("expected restore for previously unpinned chat, got %+v", evt)
		}
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for restore after unpin")
	}

	// 2. Secondary putArchiveState failure must still enqueue and emit the restore on sync completion.
	tracker := bridge.client.Store.ChatSettings.(*archiveTrackingChatSettings)
	origPut := tracker.putArchiveState
	tracker.putArchiveState = func(ctx context.Context, chatID string, archived bool) error {
		return errors.New("simulated sqlite full")
	}
	failStateJID := types.NewJID("85261002222", types.DefaultUserServer)
	if err := bridge.client.Store.ChatSettings.PutArchived(ctx, failStateJID, false); err == nil {
		t.Fatal("expected PutArchived to return simulated secondary write error")
	}
	tracker.putArchiveState = origPut
	bridge.handleEvent(&events.AppStateSyncComplete{Name: appstate.WAPatchRegularLow})
	select {
	case evt := <-ch:
		data, _ := evt.Data.(map[string]any)
		if evt.Type != "chat_archived" || data["chatId"] != "85261002222@c.us" || data["archived"] != false || data["wasArchived"] != true {
			t.Fatalf("expected restore despite secondary write failure, got %+v", evt)
		}
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for restore after secondary write failure")
	}

	// 3. Device scoping: bridge_archive_state baselines are isolated per full device JID (including :AD).
	if foundArchived, found, err := bridge.store.GetArchiveState(ctx, "85299990001:2@s.whatsapp.net", canonicalJID(unpinnedJID)); err != nil || found || foundArchived {
		t.Fatalf("expected other linked device JID to have no archive baseline, got (%v, %v, %v)", foundArchived, found, err)
	}

	// 4. Schema upgrade from 3-column bridge_archive_state preserves existing baselines.
	if _, err := bridge.db.ExecContext(ctx, `
DROP TABLE bridge_archive_state;
CREATE TABLE bridge_archive_state (
	chat_jid TEXT PRIMARY KEY,
	archived INTEGER NOT NULL,
	updated_at INTEGER NOT NULL
);
INSERT INTO bridge_archive_state (chat_jid, archived, updated_at) VALUES ('85261003333@c.us', 0, 12345);`); err != nil {
		t.Fatalf("seed legacy 3-column bridge_archive_state: %v", err)
	}
	migratedStore, err := NewBridgeStore(ctx, bridge.db)
	if err != nil {
		t.Fatalf("NewBridgeStore migration: %v", err)
	}
	if archived, found, err := migratedStore.GetArchiveState(ctx, selfJID.String(), "85261003333@c.us"); err != nil || !found || archived {
		t.Fatalf("expected migrated baseline preserved for selfJID, got (%v, %v, %v)", archived, found, err)
	}

	// 5. Interrupted upgrade recovery copies leftover old rows without dropping rows already in the new table.
	if _, err := bridge.db.ExecContext(ctx, `
INSERT OR REPLACE INTO bridge_archive_state (our_jid, chat_jid, archived, updated_at) VALUES (?, '85261004444@c.us', 0, 12346);
CREATE TABLE bridge_archive_state_old (
	chat_jid TEXT PRIMARY KEY,
	archived INTEGER NOT NULL,
	updated_at INTEGER NOT NULL
);
INSERT INTO bridge_archive_state_old (chat_jid, archived, updated_at) VALUES ('85261005555@c.us', 0, 12347);`, selfJID.String()); err != nil {
		t.Fatalf("seed interrupted bridge_archive_state migration: %v", err)
	}
	recoveredStore, err := NewBridgeStore(ctx, bridge.db)
	if err != nil {
		t.Fatalf("NewBridgeStore interrupted migration recovery: %v", err)
	}
	for _, chatID := range []string{"85261004444@c.us", "85261005555@c.us"} {
		if archived, found, err := recoveredStore.GetArchiveState(ctx, selfJID.String(), chatID); err != nil || !found || archived {
			t.Fatalf("expected recovered baseline for %s, got (%v, %v, %v)", chatID, archived, found, err)
		}
	}
}
