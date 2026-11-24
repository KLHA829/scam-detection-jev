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
	_ = res.Body.Close()

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

	var fetchMu sync.Mutex
	fetchFail := true
	fetchDone := make(chan struct{}, 4)
	bridge.fetchContactsFn = func(context.Context) error {
		fetchMu.Lock()
		fail := fetchFail
		fetchMu.Unlock()
		defer func() { fetchDone <- struct{}{} }()
		if fail {
			return errors.New("app state key not found")
		}
		return nil
	}

	bridge.handleEvent(&events.Connected{})
	select {
	case <-fetchDone:
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

	bridge.handleEvent(&events.AppStateSyncComplete{Name: appstate.WAPatchCriticalUnblockLow})
	select {
	case <-fetchDone:
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for generation-scoped retry after key arrival")
	}
	if !bridge.Health().ContactsSynced {
		t.Fatal("expected ContactsSynced=true after key-recovery retry succeeded")
	}
	unsavedAfterCatchup, err := bridge.GetContact(ctx, "85261234567@c.us")
	if err != nil {
		t.Fatalf("GetContact after key recovery: %v", err)
	}
	if unsavedAfterCatchup.IsMyContact == nil || *unsavedAfterCatchup.IsMyContact {
		t.Fatalf("expected IsMyContact=false after key recovery, got %+v", unsavedAfterCatchup)
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
