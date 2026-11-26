package main

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"go.mau.fi/whatsmeow"
	"go.mau.fi/whatsmeow/appstate"
	"go.mau.fi/whatsmeow/proto/waCommon"
	"go.mau.fi/whatsmeow/proto/waE2E"
	"go.mau.fi/whatsmeow/proto/waSyncAction"
	"go.mau.fi/whatsmeow/store"
	"go.mau.fi/whatsmeow/store/sqlstore"
	"go.mau.fi/whatsmeow/types"
	"go.mau.fi/whatsmeow/types/events"
	waLog "go.mau.fi/whatsmeow/util/log"
	"google.golang.org/protobuf/proto"
	_ "modernc.org/sqlite"
)

const (
	defaultSyncRetryDelay        = 2 * time.Second
	maxSyncAttempts              = 5
	maxArchiveTransitionsPerChat = 64
)

type putArchiveTransition struct {
	prevFound    bool
	prevArchived bool
	archived     bool
}

type archiveTrackingChatSettings struct {
	store.ChatSettingsStore
	onPutArchived func(chatID string, prevFound, prevArchived, newArchived bool)
}

func (w *archiveTrackingChatSettings) PutArchived(ctx context.Context, chat types.JID, archived bool) error {
	var prevFound bool
	var prevArchived bool
	if settings, err := w.ChatSettingsStore.GetChatSettings(ctx, chat); err == nil && settings.Found {
		prevFound = true
		prevArchived = settings.Archived
	}
	if err := w.ChatSettingsStore.PutArchived(ctx, chat, archived); err != nil {
		return err
	}
	if w.onPutArchived != nil {
		if chatID := canonicalJID(chat); chatID != "" {
			w.onPutArchived(chatID, prevFound, prevArchived, archived)
		}
	}
	return nil
}

type WhatsmeowBridge struct {
	db                          *sql.DB
	store                       *BridgeStore
	rawChatSettings             store.ChatSettingsStore
	client                      *whatsmeow.Client
	hub                         *EventHub
	log                         waLog.Logger
	ctx                         context.Context
	cancel                      context.CancelFunc
	fetchContactsFn             func(ctx context.Context, fullSync bool) error
	appStateProc                *appstate.Processor
	contactFetchMu              sync.Mutex
	contactAppStateBackoffUntil time.Time
	syncRetryDelay              time.Duration
	onSyncAttemptDone           func(gen uint64, fullSync bool, err error)
	syncRetryWake               chan struct{}

	mu                sync.RWMutex
	connected         bool
	loggedIn          bool
	readyEmitted      bool
	contactsSynced    bool
	connGen           uint64
	syncEpoch         uint64
	syncAttemptActive bool
	syncNeedsRetry    bool
	syncNeedsFull     bool

	archiveMu       sync.Mutex
	putArchiveQueue map[string][]putArchiveTransition
}

func ensurePrivateSQLiteFile(dbPath string) error {
	if dbPath == "" || dbPath == ":memory:" || strings.HasPrefix(dbPath, "file:") {
		return nil
	}
	dir := filepath.Dir(dbPath)
	if dir != "" && dir != "." {
		if err := os.MkdirAll(dir, 0o700); err != nil {
			return fmt.Errorf("create sqlite dir %q: %w", dir, err)
		}
	}
	f, err := os.OpenFile(dbPath, os.O_RDWR|os.O_CREATE, 0o600)
	if err != nil {
		return fmt.Errorf("create private sqlite file %q: %w", dbPath, err)
	}
	if err := f.Close(); err != nil {
		return fmt.Errorf("close sqlite file %q: %w", dbPath, err)
	}
	_ = os.Chmod(dbPath, 0o600)
	return nil
}

func chmodSQLiteSidecars(dbPath string) {
	if dbPath == "" || dbPath == ":memory:" || strings.HasPrefix(dbPath, "file:") {
		return
	}
	_ = os.Chmod(dbPath, 0o600)
	_ = os.Chmod(dbPath+"-wal", 0o600)
	_ = os.Chmod(dbPath+"-shm", 0o600)
}

func openBridgeSQLite(ctx context.Context, dbPath string) (*sql.DB, error) {
	if err := ensurePrivateSQLiteFile(dbPath); err != nil {
		return nil, err
	}
	db, err := sql.Open("sqlite", dbPath)
	if err != nil {
		return nil, fmt.Errorf("open sqlite %q: %w", dbPath, err)
	}
	db.SetMaxOpenConns(1)
	if _, err := db.ExecContext(ctx, `PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;`); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("configure sqlite pragmas: %w", err)
	}
	chmodSQLiteSidecars(dbPath)
	return db, nil
}

func NewWhatsmeowBridge(ctx context.Context, dbPath, logLevel string) (*WhatsmeowBridge, error) {
	logger := waLog.Stdout("wa-bridge", logLevel, false)
	db, err := openBridgeSQLite(ctx, dbPath)
	if err != nil {
		return nil, err
	}
	container := sqlstore.NewWithDB(db, "sqlite3", logger.Sub("db"))
	if err := container.Upgrade(ctx); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("upgrade whatsmeow sqlite schema: %w", err)
	}
	bridgeStore, err := NewBridgeStore(ctx, db)
	if err != nil {
		_ = db.Close()
		return nil, err
	}
	deviceStore, err := container.GetFirstDevice(ctx)
	if err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("load whatsmeow device: %w", err)
	}
	chmodSQLiteSidecars(dbPath)

	bridgeCtx, bridgeCancel := context.WithCancel(context.Background())
	bridge := &WhatsmeowBridge{
		db:              db,
		store:           bridgeStore,
		hub:             NewEventHub(),
		log:             logger,
		ctx:             bridgeCtx,
		cancel:          bridgeCancel,
		syncRetryDelay:  defaultSyncRetryDelay,
		syncRetryWake:   make(chan struct{}, 1),
		putArchiveQueue: make(map[string][]putArchiveTransition),
		appStateProc:    appstate.NewProcessor(deviceStore, logger.Sub("appstate")),
	}
	cli := whatsmeow.NewClient(deviceStore, logger.Sub("client"))
	bridge.client = cli
	bridge.ensureChatSettingsWrapped()
	bridge.fetchContactsFn = bridge.fetchContactAppState
	cli.AddEventHandler(bridge.handleEvent)
	return bridge, nil
}

func normalizeLidContactMutations(mutations []appstate.Mutation) []appstate.Mutation {
	var normalized []appstate.Mutation
	for i, mutation := range mutations {
		if len(mutation.Index) == 0 || mutation.Index[0] != appstate.IndexLIDContact {
			continue
		}
		if normalized == nil {
			normalized = append([]appstate.Mutation(nil), mutations...)
		}
		converted := mutation
		converted.Index = append([]string(nil), mutation.Index...)
		converted.Index[0] = appstate.IndexContact
		lidAction := mutation.Action.GetLidContactAction()
		contactAction := &waSyncAction.ContactAction{}
		if lidAction != nil {
			contactAction.FullName = lidAction.FullName
			contactAction.FirstName = lidAction.FirstName
			contactAction.Username = lidAction.Username
			contactAction.Birthday = lidAction.Birthday
		}
		action := &waSyncAction.SyncActionValue{ContactAction: contactAction}
		if mutation.Action != nil {
			action.Timestamp = mutation.Action.Timestamp
		}
		converted.Action = action
		normalized[i] = converted
	}
	if normalized != nil {
		return normalized
	}
	return mutations
}

func (b *WhatsmeowBridge) collectContactAppStateMutations(ctx context.Context, mutations []appstate.Mutation, fullSync bool) error {
	return b.client.DangerousInternals().CollectEventsToDispatch(
		ctx,
		appstate.WAPatchCriticalUnblockLow,
		normalizeLidContactMutations(mutations),
		fullSync,
		nil,
	)
}

// fetchContactAppState mirrors whatsmeow's contact sync, with the mutation
// stream visible to the bridge so lid_contact rows are not dropped before
// whatsmeow's bulk contact write. b.contactFetchMu is separate from
// whatsmeow's unexported appStateSyncLock; any concurrent version/hash race
// fails closed and is recovered by syncContacts's fullSync retry, while live
// incremental lid_contact updates are also handled via *events.AppState.
func (b *WhatsmeowBridge) fetchContactAppState(ctx context.Context, fullSync bool) error {
	if b.client == nil || b.client.Store == nil || b.appStateProc == nil {
		return errNotReady
	}
	b.contactFetchMu.Lock()
	defer b.contactFetchMu.Unlock()

	name := appstate.WAPatchCriticalUnblockLow
	if until := b.contactAppStateBackoffUntil; time.Now().Before(until) {
		return fmt.Errorf("%w: not fetching %s until %s", whatsmeow.ErrAppStateRateLimited, name, until.Format(time.RFC3339))
	}
	if fullSync {
		if err := b.client.Store.AppState.DeleteAppStateVersion(ctx, string(name)); err != nil {
			return fmt.Errorf("reset app state %s version: %w", name, err)
		}
	}
	version, hash, err := b.client.Store.AppState.GetAppStateVersion(ctx, string(name))
	if err != nil {
		return fmt.Errorf("get app state %s version: %w", name, err)
	}
	if version == 0 {
		fullSync = true
	}

	state := appstate.HashState{Version: version, Hash: hash}
	hasMore := true
	wantSnapshot := fullSync
	for hasMore {
		patches, err := b.client.DangerousInternals().FetchAppStatePatches(ctx, name, state.Version, wantSnapshot)
		if err != nil {
			var iqErr *whatsmeow.IQError
			if errors.As(err, &iqErr) && iqErr.Code == 429 && iqErr.ErrorNode != nil {
				if backoff := iqErr.ErrorNode.AttrGetter().OptionalInt("backoff"); backoff > 0 {
					b.contactAppStateBackoffUntil = time.Now().Add(time.Duration(backoff) * time.Second)
				}
			}
			return fmt.Errorf("fetch app state %s patches: %w", name, err)
		}
		if !wantSnapshot && patches.Snapshot != nil {
			return fmt.Errorf("server unexpectedly returned snapshot for %s without asking", name)
		}
		if patches.Snapshot != nil && state != (appstate.HashState{}) {
			return fmt.Errorf("unexpected non-empty input state (v%d) for %s when applying snapshot", state.Version, name)
		}
		wantSnapshot = false
		hasMore = patches.HasMorePatches

		mutations, newState, err := b.appStateProc.DecodePatches(ctx, patches, state, true)
		if err != nil {
			if errors.Is(err, appstate.ErrKeyNotFound) {
				b.client.DangerousInternals().RequestMissingAppStateKeys(context.WithoutCancel(ctx), patches)
			}
			return fmt.Errorf("decode app state %s patches: %w", name, err)
		}
		if err := b.collectContactAppStateMutations(ctx, mutations, fullSync); err != nil {
			return fmt.Errorf("apply contact app state %s mutations: %w", name, err)
		}
		state = newState
	}
	return nil
}

func (b *WhatsmeowBridge) Start(ctx context.Context) error {
	if b.client.Store.ID == nil {
		qrChan, err := b.client.GetQRChannel(ctx)
		if err != nil {
			return fmt.Errorf("get qr channel: %w", err)
		}
		if err := b.client.Connect(); err != nil {
			return fmt.Errorf("connect whatsmeow: %w", err)
		}
		go func() {
			for item := range qrChan {
				switch item.Event {
				case "code":
					b.hub.Publish(BridgeEvent{
						Type: "qr",
						Data: map[string]any{"qr": item.Code},
					})
				case "success":
					b.hub.Publish(BridgeEvent{Type: "authenticated"})
				case "timeout", "err-client-outdated", "err-scanned-without-multidevice":
					b.hub.Publish(BridgeEvent{
						Type: "auth_failure",
						Data: map[string]any{"reason": item.Event},
					})
				}
			}
		}()
		return nil
	}
	if err := b.client.Connect(); err != nil {
		return fmt.Errorf("connect whatsmeow: %w", err)
	}
	return nil
}

func (b *WhatsmeowBridge) Close() error {
	if b.cancel != nil {
		b.cancel()
	}
	if b.client != nil {
		b.client.Disconnect()
	}
	if b.db != nil {
		return b.db.Close()
	}
	return nil
}

func (b *WhatsmeowBridge) markContactsSyncedForGen(gen uint64) {
	b.mu.Lock()
	if b.connected && b.loggedIn && b.connGen == gen {
		b.contactsSynced = true
		b.syncAttemptActive = false
		b.syncNeedsRetry = false
		b.syncNeedsFull = false
	}
	b.mu.Unlock()
}

func (b *WhatsmeowBridge) completeContactSyncAttempt(gen, startEpoch uint64) bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	if !b.connected || !b.loggedIn || b.connGen != gen {
		return true
	}
	if b.syncEpoch != startEpoch {
		return false
	}
	b.contactsSynced = true
	b.syncAttemptActive = false
	b.syncNeedsRetry = false
	b.syncNeedsFull = false
	return true
}

func (b *WhatsmeowBridge) isGenActive(gen uint64) bool {
	b.mu.RLock()
	active := b.connected && b.loggedIn && b.connGen == gen
	b.mu.RUnlock()
	return active
}

func (b *WhatsmeowBridge) syncContacts(ctx context.Context, gen uint64) {
	delay := b.syncRetryDelay
	if delay <= 0 {
		delay = defaultSyncRetryDelay
	}
	for attempt := 0; ; attempt++ {
		if !b.isGenActive(gen) {
			return
		}
		b.mu.RLock()
		fullSync := b.syncNeedsFull
		startEpoch := b.syncEpoch
		b.mu.RUnlock()

		syncCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
		err := b.fetchContactsFn(syncCtx, fullSync)
		cancel()
		if err == nil {
			if !b.completeContactSyncAttempt(gen, startEpoch) {
				continue
			}
			if b.onSyncAttemptDone != nil {
				b.onSyncAttemptDone(gen, fullSync, nil)
			}
			return
		}
		b.log.Warnf("contact app state sync attempt %d/%d (fullSync=%v) failed (staying fail-closed): %v", attempt+1, maxSyncAttempts, fullSync, err)
		lastAttempt := attempt+1 >= maxSyncAttempts
		wokeDuringFinal := false
		b.mu.Lock()
		if lastAttempt {
			select {
			case <-b.syncRetryWake:
				wokeDuringFinal = true
			default:
			}
		}
		if b.connGen == gen {
			b.syncNeedsFull = true
			b.syncNeedsRetry = true
			if lastAttempt && !wokeDuringFinal {
				b.syncAttemptActive = false
			}
		}
		b.mu.Unlock()
		if b.onSyncAttemptDone != nil {
			b.onSyncAttemptDone(gen, fullSync, err)
		}
		if lastAttempt {
			if wokeDuringFinal {
				continue
			}
			return
		}
		timer := time.NewTimer(delay)
		select {
		case <-ctx.Done():
			timer.Stop()
			return
		case <-b.syncRetryWake:
			timer.Stop()
		case <-timer.C:
		}
		delay *= 2
	}
}

func (b *WhatsmeowBridge) Events() *EventHub {
	return b.hub
}

func (b *WhatsmeowBridge) selfJIDs() (string, string) {
	if b.client == nil || b.client.Store == nil {
		return "", ""
	}
	return canonicalJID(b.client.Store.GetJID()), canonicalJID(b.client.Store.GetLID())
}

func (b *WhatsmeowBridge) Health() HealthStatus {
	b.mu.RLock()
	connected := b.connected
	loggedIn := b.loggedIn
	contactsSynced := b.contactsSynced
	b.mu.RUnlock()

	selfWid, selfLid := b.selfJIDs()
	state := "connecting"
	if connected && loggedIn {
		state = "ready"
	} else if connected {
		state = "awaiting_qr"
	}
	return HealthStatus{
		OK:             true,
		State:          state,
		Connected:      connected,
		LoggedIn:       loggedIn,
		ContactsSynced: contactsSynced,
		SelfWid:        selfWid,
		SelfLid:        selfLid,
	}
}

func (b *WhatsmeowBridge) handleEvent(rawEvt any) {
	switch evt := rawEvt.(type) {
	case *events.Connected:
		b.ensureChatSettingsWrapped()
		b.mu.Lock()
		b.connGen++
		b.syncEpoch++
		gen := b.connGen
		b.connected = true
		b.loggedIn = b.client.Store != nil && b.client.Store.ID != nil
		b.contactsSynced = false
		b.syncAttemptActive = b.loggedIn
		b.syncNeedsRetry = false
		shouldEmitReady := b.loggedIn && !b.readyEmitted
		if shouldEmitReady {
			b.readyEmitted = true
		}
		isLoggedIn := b.loggedIn
		b.mu.Unlock()

		if isLoggedIn {
			go b.syncContacts(b.ctx, gen)
		}

		if shouldEmitReady {
			selfWid, selfLid := b.selfJIDs()
			b.hub.Publish(BridgeEvent{
				Type: "ready",
				Data: map[string]any{
					"selfWid": selfWid,
					"selfLid": selfLid,
				},
			})
		}

	case *events.PairSuccess:
		b.ensureChatSettingsWrapped()
		b.hub.Publish(BridgeEvent{Type: "authenticated"})

	case *events.AppState:
		if len(evt.Index) > 1 && evt.Index[0] == appstate.IndexLIDContact && evt.SyncActionValue != nil {
			if act := evt.SyncActionValue.GetLidContactAction(); act != nil {
				if jid, err := types.ParseJID(evt.Index[1]); err == nil && !jid.IsEmpty() && b.client != nil && b.client.Store != nil && b.client.Store.Contacts != nil {
					ctx := b.ctx
					if ctx == nil {
						ctx = context.Background()
					}
					if err := b.client.Store.Contacts.PutContactName(ctx, jid, act.GetFirstName(), act.GetFullName()); err != nil {
						b.log.Warnf("failed to store live lid_contact %s: %v", jid.String(), err)
					}
				}
			}
		}

	case *events.AppStateSyncComplete:
		if evt.Name == appstate.WAPatchCriticalUnblockLow {
			var retryGen uint64
			b.mu.Lock()
			if evt.Recovery {
				b.syncEpoch++
				b.contactsSynced = false
				b.syncNeedsRetry = true
				b.syncNeedsFull = true
			}
			if b.connected && b.loggedIn && !b.contactsSynced && b.syncNeedsRetry {
				if b.syncAttemptActive {
					select {
					case b.syncRetryWake <- struct{}{}:
					default:
					}
				} else {
					b.syncAttemptActive = true
					b.syncNeedsRetry = false
					retryGen = b.connGen
				}
			}
			b.mu.Unlock()
			if retryGen != 0 {
				go b.syncContacts(b.ctx, retryGen)
			}
		}

	case *events.Disconnected:
		b.mu.Lock()
		b.connGen++
		b.connected = false
		b.readyEmitted = false
		b.contactsSynced = false
		b.syncAttemptActive = false
		b.syncNeedsRetry = false
		b.mu.Unlock()
		b.hub.Publish(BridgeEvent{
			Type: "disconnected",
			Data: map[string]any{"reason": "disconnected"},
		})

	case *events.LoggedOut:
		b.mu.Lock()
		b.connGen++
		b.connected = false
		b.loggedIn = false
		b.readyEmitted = false
		b.contactsSynced = false
		b.syncAttemptActive = false
		b.syncNeedsRetry = false
		b.syncNeedsFull = false
		b.mu.Unlock()
		b.hub.Publish(BridgeEvent{
			Type: "disconnected",
			Data: map[string]any{"reason": evt.Reason.String()},
		})

	case *events.Message:
		b.handleIncomingMessage(evt)

	case *events.Archive:
		b.handleArchiveEvent(evt)
	}
}

func (b *WhatsmeowBridge) ensureChatSettingsWrapped() {
	if b.client == nil || b.client.Store == nil {
		return
	}
	b.archiveMu.Lock()
	defer b.archiveMu.Unlock()
	cs := b.client.Store.ChatSettings
	if cs == nil {
		return
	}
	if _, ok := cs.(*archiveTrackingChatSettings); ok {
		return
	}
	b.rawChatSettings = cs
	b.client.Store.ChatSettings = &archiveTrackingChatSettings{
		ChatSettingsStore: cs,
		onPutArchived:     b.recordPutArchived,
	}
}

func (b *WhatsmeowBridge) rawChatSettingsStore() store.ChatSettingsStore {
	b.archiveMu.Lock()
	defer b.archiveMu.Unlock()
	return b.rawChatSettings
}

func (b *WhatsmeowBridge) recordPutArchived(chatID string, prevFound, prevArchived, newArchived bool) {
	if chatID == "" {
		return
	}
	b.archiveMu.Lock()
	defer b.archiveMu.Unlock()
	if b.putArchiveQueue == nil {
		b.putArchiveQueue = make(map[string][]putArchiveTransition)
	}
	if _, exists := b.putArchiveQueue[chatID]; !exists && len(b.putArchiveQueue) >= maxStoredMessages {
		clear(b.putArchiveQueue)
	}
	q := append(b.putArchiveQueue[chatID], putArchiveTransition{
		prevFound:    prevFound,
		prevArchived: prevArchived,
		archived:     newArchived,
	})
	if len(q) > maxArchiveTransitionsPerChat {
		q = q[len(q)-maxArchiveTransitionsPerChat:]
	}
	b.putArchiveQueue[chatID] = q
}

func (b *WhatsmeowBridge) consumePutArchived(chatID string, expectedArchived bool) (putArchiveTransition, bool) {
	b.archiveMu.Lock()
	defer b.archiveMu.Unlock()
	if b.putArchiveQueue == nil {
		return putArchiveTransition{}, false
	}
	q := b.putArchiveQueue[chatID]
	for i := len(q) - 1; i >= 0; i-- {
		if q[i].archived == expectedArchived {
			tr := q[i]
			q = append(q[:i], q[i+1:]...)
			if len(q) == 0 {
				delete(b.putArchiveQueue, chatID)
			} else {
				b.putArchiveQueue[chatID] = q
			}
			return tr, true
		}
	}
	return putArchiveTransition{}, false
}

func (b *WhatsmeowBridge) handleArchiveEvent(evt *events.Archive) {
	if evt == nil || evt.Action == nil {
		return
	}
	chatID := canonicalJID(evt.JID)
	if chatID == "" {
		return
	}
	archived := evt.Action.GetArchived()
	if evt.FromFullSync {
		return
	}

	ctx := b.ctx
	if ctx == nil {
		ctx = context.Background()
	}
	trans, matchedPut := b.consumePutArchived(chatID, archived)

	rawCS := b.rawChatSettingsStore()
	var wasArchived bool
	switch {
	case matchedPut:
		if trans.prevFound {
			wasArchived = trans.prevArchived
		} else {
			wasArchived = !archived
		}
	case rawCS != nil:
		if settings, err := rawCS.GetChatSettings(ctx, evt.JID); err == nil && settings.Found {
			wasArchived = settings.Archived
		} else {
			wasArchived = !archived
		}
	default:
		wasArchived = !archived
	}

	b.hub.Publish(BridgeEvent{
		Type: "chat_archived",
		Data: map[string]any{
			"chatId":      chatID,
			"isGroup":     evt.JID.Server == types.GroupServer,
			"isChannel":   evt.JID.Server == types.NewsletterServer,
			"archived":    archived,
			"wasArchived": wasArchived,
		},
	})
}

type extractedMessage struct {
	msgType        string
	body           string
	quotedID       string
	isForwarded    bool
	isEdit         bool
	editedTargetID string
	isPollVote     bool
}

func unwrapE2EMessage(msg *waE2E.Message) *waE2E.Message {
	cur := msg
	for cur != nil {
		switch {
		case cur.GetDeviceSentMessage().GetMessage() != nil:
			cur = cur.GetDeviceSentMessage().GetMessage()
		case cur.GetEphemeralMessage().GetMessage() != nil:
			cur = cur.GetEphemeralMessage().GetMessage()
		case cur.GetViewOnceMessage().GetMessage() != nil:
			cur = cur.GetViewOnceMessage().GetMessage()
		case cur.GetViewOnceMessageV2().GetMessage() != nil:
			cur = cur.GetViewOnceMessageV2().GetMessage()
		case cur.GetEditedMessage().GetMessage() != nil:
			cur = cur.GetEditedMessage().GetMessage()
		default:
			return cur
		}
	}
	return nil
}

func extractContextMeta(ci *waE2E.ContextInfo) (quotedID string, isForwarded bool) {
	if ci == nil {
		return "", false
	}
	return ci.GetStanzaID(), ci.GetIsForwarded() || ci.GetForwardingScore() > 0
}

func extractMessageContent(raw *waE2E.Message) extractedMessage {
	msg := unwrapE2EMessage(raw)
	if msg == nil {
		return extractedMessage{msgType: "unknown"}
	}
	if msg.GetPollUpdateMessage() != nil {
		return extractedMessage{msgType: "poll_vote", isPollVote: true}
	}
	if pm := msg.GetProtocolMessage(); pm != nil {
		if pm.GetType() == waE2E.ProtocolMessage_MESSAGE_EDIT && pm.GetEditedMessage() != nil {
			inner := extractMessageContent(pm.GetEditedMessage())
			return extractedMessage{
				msgType:        inner.msgType,
				body:           inner.body,
				quotedID:       inner.quotedID,
				isForwarded:    inner.isForwarded,
				isEdit:         true,
				editedTargetID: pm.GetKey().GetID(),
			}
		}
		return extractedMessage{msgType: "protocol"}
	}
	if text := msg.GetConversation(); text != "" {
		return extractedMessage{msgType: "chat", body: text}
	}
	if ext := msg.GetExtendedTextMessage(); ext != nil {
		quotedID, isForwarded := extractContextMeta(ext.GetContextInfo())
		return extractedMessage{
			msgType:     "chat",
			body:        ext.GetText(),
			quotedID:    quotedID,
			isForwarded: isForwarded,
		}
	}
	if img := msg.GetImageMessage(); img != nil {
		quotedID, isForwarded := extractContextMeta(img.GetContextInfo())
		return extractedMessage{msgType: "image", body: img.GetCaption(), quotedID: quotedID, isForwarded: isForwarded}
	}
	if vid := msg.GetVideoMessage(); vid != nil {
		quotedID, isForwarded := extractContextMeta(vid.GetContextInfo())
		return extractedMessage{msgType: "video", body: vid.GetCaption(), quotedID: quotedID, isForwarded: isForwarded}
	}
	if doc := msg.GetDocumentMessage(); doc != nil {
		quotedID, isForwarded := extractContextMeta(doc.GetContextInfo())
		return extractedMessage{msgType: "document", body: doc.GetCaption(), quotedID: quotedID, isForwarded: isForwarded}
	}
	if msg.GetAudioMessage() != nil {
		return extractedMessage{msgType: "audio"}
	}
	if msg.GetStickerMessage() != nil {
		return extractedMessage{msgType: "sticker"}
	}
	return extractedMessage{msgType: "unknown"}
}

func (b *WhatsmeowBridge) handleIncomingMessage(evt *events.Message) {
	if evt == nil || evt.Message == nil {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	extracted := extractMessageContent(evt.Message)
	if extracted.isPollVote {
		b.handlePollVote(ctx, evt)
		return
	}
	if extracted.msgType == "protocol" {
		return
	}

	chatID := canonicalJID(evt.Info.Chat)
	senderID := canonicalJID(evt.Info.Sender)
	isGroup := evt.Info.IsGroup
	isChannel := evt.Info.Chat.Server == types.NewsletterServer

	if extracted.isEdit {
		targetID := extracted.editedTargetID
		if targetID == "" {
			targetID = string(evt.Info.ID)
		}
		prevBody := ""
		if prev, found, err := b.store.GetMessage(ctx, targetID); err == nil && found {
			prevBody = prev.Body
		}
		_ = b.store.SaveMessage(ctx, StoredMessage{
			ID:        targetID,
			ChatJID:   chatID,
			SenderJID: senderID,
			FromMe:    evt.Info.IsFromMe,
			MsgType:   extracted.msgType,
			Body:      extracted.body,
			Timestamp: evt.Info.Timestamp,
		})
		b.hub.Publish(BridgeEvent{
			Type: "message_edit",
			Data: map[string]any{
				"id":           targetID,
				"chatId":       chatID,
				"from":         chatID,
				"author":       senderID,
				"fromMe":       evt.Info.IsFromMe,
				"type":         extracted.msgType,
				"body":         extracted.body,
				"newBody":      extracted.body,
				"prevBody":     prevBody,
				"isGroup":      isGroup,
				"isChannel":    isChannel,
				"isForwarded":  extracted.isForwarded,
				"notifyName":   evt.Info.PushName,
				"hasQuotedMsg": extracted.quotedID != "",
				"quotedId":     extracted.quotedID,
			},
		})
		return
	}

	msgID := string(evt.Info.ID)
	_ = b.store.SaveMessage(ctx, StoredMessage{
		ID:        msgID,
		ChatJID:   chatID,
		SenderJID: senderID,
		FromMe:    evt.Info.IsFromMe,
		MsgType:   extracted.msgType,
		Body:      extracted.body,
		Timestamp: evt.Info.Timestamp,
	})

	payload := map[string]any{
		"id":           msgID,
		"chatId":       chatID,
		"from":         chatID,
		"author":       senderID,
		"fromMe":       evt.Info.IsFromMe,
		"type":         extracted.msgType,
		"body":         extracted.body,
		"isGroup":      isGroup,
		"isChannel":    isChannel,
		"isForwarded":  extracted.isForwarded,
		"notifyName":   evt.Info.PushName,
		"hasQuotedMsg": extracted.quotedID != "",
		"quotedId":     extracted.quotedID,
	}
	if evt.Info.IsFromMe {
		b.hub.Publish(BridgeEvent{Type: "message_create", Data: payload})
		return
	}
	b.hub.Publish(BridgeEvent{Type: "message", Data: payload})
}

func (b *WhatsmeowBridge) handlePollVote(ctx context.Context, evt *events.Message) {
	pollUpdate := unwrapE2EMessage(evt.Message).GetPollUpdateMessage()
	if pollUpdate == nil {
		return
	}
	parentID := pollUpdate.GetPollCreationMessageKey().GetID()
	if parentID == "" {
		return
	}
	voteMsg, err := b.client.DecryptPollVote(ctx, evt)
	if err != nil {
		b.log.Warnf("failed to decrypt poll vote for %s: %v", parentID, err)
		return
	}
	options, found, err := b.store.GetPollOptions(ctx, parentID)
	if err != nil || !found {
		return
	}
	selected := ResolvePollVoteOptions(options, voteMsg.GetSelectedOptions())
	b.hub.Publish(BridgeEvent{
		Type: "vote_update",
		Data: map[string]any{
			"parentMessageId": parentID,
			"selectedOptions": selected,
		},
	})
}

func buildContactResponse(
	jid types.JID,
	info types.ContactInfo,
	contactsSynced bool,
	selfWid string,
	selfLid string,
) *ContactResponse {
	id := canonicalJID(jid)
	savedName := strings.TrimSpace(info.FullName)
	if savedName == "" {
		savedName = strings.TrimSpace(info.FirstName)
	}
	var isMyContact *bool
	if savedName != "" {
		t := true
		isMyContact = &t
	} else if contactsSynced {
		f := false
		isMyContact = &f
	}
	isMe := id != "" && (id == selfWid || id == selfLid)
	return &ContactResponse{
		ID:             id,
		Number:         phoneDigitsFromJID(jid),
		Name:           savedName,
		Pushname:       strings.TrimSpace(info.PushName),
		IsMyContact:    isMyContact,
		IsMe:           isMe,
		ContactsSynced: contactsSynced,
	}
}

func (b *WhatsmeowBridge) sampleSyncState() (synced bool, gen uint64) {
	b.mu.RLock()
	synced = b.contactsSynced
	gen = b.connGen
	b.mu.RUnlock()
	return synced, gen
}

func (b *WhatsmeowBridge) GetContact(ctx context.Context, rawID string) (*ContactResponse, error) {
	if b.client == nil || b.client.Store == nil || b.client.Store.Contacts == nil {
		return nil, errNotReady
	}
	jid, err := parseInputJID(rawID)
	if err != nil {
		return nil, fmt.Errorf("%w: %v", errBadRequest, err)
	}

	syncedBefore, genBefore := b.sampleSyncState()
	info, err := b.client.Store.Contacts.GetContact(ctx, jid)
	if err != nil {
		return nil, fmt.Errorf("read contact %s: %w", rawID, err)
	}

	resolvedNumber := phoneDigitsFromJID(jid)
	lidPhoneVerified := jid.Server != types.HiddenUserServer
	savedName := strings.TrimSpace(info.FullName)
	if savedName == "" {
		savedName = strings.TrimSpace(info.FirstName)
	}
	if jid.Server == types.HiddenUserServer && savedName == "" && b.client.Store.LIDs != nil {
		if pn, err := b.client.Store.LIDs.GetPNForLID(ctx, jid); err == nil && !pn.IsEmpty() {
			if pnInfo, err := b.client.Store.Contacts.GetContact(ctx, pn); err == nil {
				lidPhoneVerified = true
				resolvedNumber = phoneDigitsFromJID(pn)
				pnSaved := strings.TrimSpace(pnInfo.FullName)
				if pnSaved == "" {
					pnSaved = strings.TrimSpace(pnInfo.FirstName)
				}
				if pnSaved != "" {
					info.FullName = pnInfo.FullName
					info.FirstName = pnInfo.FirstName
				}
				if strings.TrimSpace(info.PushName) == "" {
					info.PushName = pnInfo.PushName
				}
			}
		}
	}

	syncedAfter, genAfter := b.sampleSyncState()
	authoritative := syncedBefore && syncedAfter && genBefore == genAfter && lidPhoneVerified
	selfWid, selfLid := b.selfJIDs()
	resp := buildContactResponse(jid, info, authoritative, selfWid, selfLid)
	if resolvedNumber != "" {
		resp.Number = resolvedNumber
	}
	return resp, nil
}

func (b *WhatsmeowBridge) ResolveLidMappings(ctx context.Context, ids []string) ([]LidMapping, error) {
	if b.client == nil || b.client.Store == nil || b.client.Store.LIDs == nil {
		return nil, errNotReady
	}
	out := make([]LidMapping, 0, len(ids))
	for _, raw := range ids {
		jid, err := parseInputJID(raw)
		if err != nil {
			continue
		}
		if jid.Server == types.HiddenUserServer {
			pn, err := b.client.Store.LIDs.GetPNForLID(ctx, jid)
			if err != nil || pn.IsEmpty() {
				continue
			}
			out = append(out, LidMapping{
				Lid: canonicalJID(jid),
				Pn:  canonicalJID(pn),
			})
		} else if jid.Server == types.DefaultUserServer {
			lid, err := b.client.Store.LIDs.GetLIDForPN(ctx, jid)
			if err != nil || lid.IsEmpty() {
				continue
			}
			out = append(out, LidMapping{
				Lid: canonicalJID(lid),
				Pn:  canonicalJID(jid),
			})
		}
	}
	return out, nil
}

func (b *WhatsmeowBridge) ensureLoggedIn() error {
	b.mu.RLock()
	ready := b.connected && b.loggedIn
	b.mu.RUnlock()
	if !ready {
		return errNotReady
	}
	return nil
}

func (b *WhatsmeowBridge) SendText(ctx context.Context, chatID, text string) (string, error) {
	if err := b.ensureLoggedIn(); err != nil {
		return "", err
	}
	target, err := parseInputJID(chatID)
	if err != nil {
		return "", fmt.Errorf("%w: %v", errBadRequest, err)
	}
	resp, err := b.client.SendMessage(ctx, target, &waE2E.Message{
		Conversation: proto.String(text),
	})
	if err != nil {
		return "", fmt.Errorf("send text: %w", err)
	}
	return string(resp.ID), nil
}

func (b *WhatsmeowBridge) SendPoll(ctx context.Context, chatID, name string, options []string, allowMultiple bool) (string, error) {
	if err := b.ensureLoggedIn(); err != nil {
		return "", err
	}
	target, err := parseInputJID(chatID)
	if err != nil {
		return "", fmt.Errorf("%w: %v", errBadRequest, err)
	}
	selectable := 1
	if allowMultiple {
		selectable = 0
	}
	msg := b.client.BuildPollCreation(name, options, selectable)
	resp, err := b.client.SendMessage(ctx, target, msg)
	if err != nil {
		return "", fmt.Errorf("send poll: %w", err)
	}
	pollID := string(resp.ID)
	if err := b.store.SavePollOptions(ctx, pollID, canonicalJID(target), options); err != nil {
		b.log.Warnf("failed to persist poll options for %s: %v", pollID, err)
	}
	return pollID, nil
}

func (b *WhatsmeowBridge) ForwardMessage(ctx context.Context, messageID, targetChatID string) (string, error) {
	if err := b.ensureLoggedIn(); err != nil {
		return "", err
	}
	target, err := parseInputJID(targetChatID)
	if err != nil {
		return "", fmt.Errorf("%w: %v", errBadRequest, err)
	}
	stored, found, err := b.store.GetMessage(ctx, messageID)
	if err != nil {
		return "", err
	}
	if !found {
		return "", fmt.Errorf("%w: message %s not cached", errNotFound, messageID)
	}
	if stored.MsgType != "" && stored.MsgType != "chat" {
		return "", fmt.Errorf("%w: cannot forward %s attachment as text", errUnsupportedMedia, stored.MsgType)
	}
	resp, err := b.client.SendMessage(ctx, target, &waE2E.Message{
		ExtendedTextMessage: &waE2E.ExtendedTextMessage{
			Text: proto.String(stored.Body),
			ContextInfo: &waE2E.ContextInfo{
				IsForwarded:     proto.Bool(true),
				ForwardingScore: proto.Uint32(1),
			},
		},
	})
	if err != nil {
		return "", fmt.Errorf("forward message: %w", err)
	}
	return string(resp.ID), nil
}

func (b *WhatsmeowBridge) ArchiveChat(ctx context.Context, chatID string, archived bool) error {
	if err := b.ensureLoggedIn(); err != nil {
		return err
	}
	target, err := parseInputJID(chatID)
	if err != nil {
		return fmt.Errorf("%w: %v", errBadRequest, err)
	}
	var lastTS time.Time
	var lastKey *waCommon.MessageKey
	if last, found, err := b.store.GetLastChatMessage(ctx, canonicalJID(target)); err == nil && found {
		lastTS = last.Timestamp
		lastKey = &waCommon.MessageKey{
			RemoteJID: proto.String(target.String()),
			FromMe:    proto.Bool(last.FromMe),
			ID:        proto.String(last.ID),
		}
	}
	return b.client.SendAppState(ctx, appstate.BuildArchive(target, archived, lastTS, lastKey))
}

func (b *WhatsmeowBridge) MuteChat(ctx context.Context, chatID string, muted bool) error {
	if err := b.ensureLoggedIn(); err != nil {
		return err
	}
	target, err := parseInputJID(chatID)
	if err != nil {
		return fmt.Errorf("%w: %v", errBadRequest, err)
	}
	return b.client.SendAppState(ctx, appstate.BuildMute(target, muted, 0))
}

func (b *WhatsmeowBridge) BlockContact(ctx context.Context, id string, blocked bool) error {
	if err := b.ensureLoggedIn(); err != nil {
		return err
	}
	target, err := parseInputJID(id)
	if err != nil {
		return fmt.Errorf("%w: %v", errBadRequest, err)
	}
	action := events.BlocklistChangeActionUnblock
	if blocked {
		action = events.BlocklistChangeActionBlock
	}
	_, err = b.client.UpdateBlocklist(ctx, target, action, "")
	return err
}

func buildContactLabelPatch(target types.JID, name string) appstate.PatchInfo {
	clean := strings.TrimSpace(name)
	return appstate.PatchInfo{
		Type: appstate.WAPatchCriticalUnblockLow,
		Mutations: []appstate.MutationInfo{{
			Index:   []string{appstate.IndexContact, target.String()},
			Version: 2,
			Value: &waSyncAction.SyncActionValue{
				ContactAction: &waSyncAction.ContactAction{
					FullName:                 proto.String(clean),
					FirstName:                proto.String(clean),
					SaveOnPrimaryAddressbook: proto.Bool(false),
				},
			},
		}},
	}
}

func (b *WhatsmeowBridge) SetContactLabel(ctx context.Context, phone, name string) error {
	if err := b.ensureLoggedIn(); err != nil {
		return err
	}
	digits := digitsOnly(phone)
	if digits == "" {
		return fmt.Errorf("%w: invalid phone %q", errBadRequest, phone)
	}
	target := types.NewJID(digits, types.DefaultUserServer)
	if err := b.client.SendAppState(ctx, buildContactLabelPatch(target, name)); err != nil {
		return fmt.Errorf("send contact label app state: %w", err)
	}
	if b.client.Store != nil && b.client.Store.Contacts != nil {
		clean := strings.TrimSpace(name)
		_ = b.client.Store.Contacts.PutContactName(ctx, target, clean, clean)
	}
	return nil
}
