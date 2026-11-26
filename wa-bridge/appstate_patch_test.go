package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"testing"

	"go.mau.fi/whatsmeow/appstate"
	"go.mau.fi/whatsmeow/appstate/lthash"
	"go.mau.fi/whatsmeow/proto/waServerSync"
	"go.mau.fi/whatsmeow/proto/waSyncAction"
	wastore "go.mau.fi/whatsmeow/store"
	"go.mau.fi/whatsmeow/types"
	"go.mau.fi/whatsmeow/util/cbcutil"
	"google.golang.org/protobuf/proto"
)

type memoryAppStateKeys struct {
	keys map[string]wastore.AppStateSyncKey
}

func newMemoryAppStateKeys() *memoryAppStateKeys {
	return &memoryAppStateKeys{keys: make(map[string]wastore.AppStateSyncKey)}
}

func (m *memoryAppStateKeys) PutAppStateSyncKey(_ context.Context, id []byte, key wastore.AppStateSyncKey) error {
	m.keys[string(id)] = key
	return nil
}

func (m *memoryAppStateKeys) GetAppStateSyncKey(_ context.Context, id []byte) (*wastore.AppStateSyncKey, error) {
	key, ok := m.keys[string(id)]
	if !ok {
		return nil, nil
	}
	return &key, nil
}

func (m *memoryAppStateKeys) GetLatestAppStateSyncKeyID(context.Context) ([]byte, error) {
	for id := range m.keys {
		return []byte(id), nil
	}
	return nil, nil
}

func (m *memoryAppStateKeys) GetAllAppStateSyncKeys(context.Context) ([]*wastore.AppStateSyncKey, error) {
	out := make([]*wastore.AppStateSyncKey, 0, len(m.keys))
	for _, key := range m.keys {
		keyCopy := key
		out = append(out, &keyCopy)
	}
	return out, nil
}

type memoryAppState struct {
	macs map[string][]byte
}

func newMemoryAppState() *memoryAppState {
	return &memoryAppState{macs: make(map[string][]byte)}
}

func memoryAppStateMACKey(name string, indexMAC []byte) string {
	return name + "\x00" + string(indexMAC)
}

func (m *memoryAppState) PutAppStateVersion(context.Context, string, uint64, [128]byte) error {
	return nil
}

func (m *memoryAppState) GetAppStateVersion(context.Context, string) (uint64, [128]byte, error) {
	return 0, [128]byte{}, nil
}

func (m *memoryAppState) DeleteAppStateVersion(context.Context, string) error {
	return nil
}

func (m *memoryAppState) PutAppStateMutationMACs(_ context.Context, name string, _ uint64, mutations []wastore.AppStateMutationMAC) error {
	for _, mutation := range mutations {
		m.macs[memoryAppStateMACKey(name, mutation.IndexMAC)] = append([]byte(nil), mutation.ValueMAC...)
	}
	return nil
}

func (m *memoryAppState) DeleteAppStateMutationMACs(_ context.Context, name string, indexMACs [][]byte) error {
	for _, indexMAC := range indexMACs {
		delete(m.macs, memoryAppStateMACKey(name, indexMAC))
	}
	return nil
}

func (m *memoryAppState) GetAppStateMutationMAC(_ context.Context, name string, indexMAC []byte) ([]byte, error) {
	valueMAC, ok := m.macs[memoryAppStateMACKey(name, indexMAC)]
	if !ok {
		return nil, nil
	}
	return append([]byte(nil), valueMAC...), nil
}

func decodeAppStateMutationForTest(t *testing.T, encoded []byte) (*waServerSync.SyncdPatch, *waServerSync.SyncdMutation) {
	t.Helper()
	var patch waServerSync.SyncdPatch
	if err := proto.Unmarshal(encoded, &patch); err != nil {
		t.Fatalf("unmarshal encoded patch: %v", err)
	}
	if len(patch.GetMutations()) != 1 {
		t.Fatalf("encoded mutations len = %d", len(patch.GetMutations()))
	}
	mutation := patch.GetMutations()[0]
	blob := mutation.GetRecord().GetValue().GetBlob()
	if len(blob) < 16+32 {
		t.Fatalf("mutation blob too short: %d", len(blob))
	}
	return &patch, mutation
}

func decryptAppStateMutationForTest(
	t *testing.T,
	mutation *waServerSync.SyncdMutation,
	keyData []byte,
) *waSyncAction.SyncActionData {
	t.Helper()
	keys := expandAppStateKeys(keyData)
	blob := mutation.GetRecord().GetValue().GetBlob()
	encryptedContent, valueMAC := blob[:len(blob)-32], blob[len(blob)-32:]
	expectedValueMAC := appStateContentMAC(mutation.GetOperation(), encryptedContent, mutation.GetRecord().GetKeyID().GetID(), keys.valueMAC)
	if !bytes.Equal(valueMAC, expectedValueMAC) {
		t.Fatalf("mutation content MAC does not match its %s operation", mutation.GetOperation())
	}
	iv, ciphertext := encryptedContent[:16], encryptedContent[16:]
	plaintext, err := cbcutil.Decrypt(keys.valueEncryption, iv, ciphertext)
	if err != nil {
		t.Fatalf("decrypt mutation: %v", err)
	}
	var action waSyncAction.SyncActionData
	if err := proto.Unmarshal(plaintext, &action); err != nil {
		t.Fatalf("unmarshal mutation plaintext: %v", err)
	}
	return &action
}

func TestBuildContactRemovalPatch(t *testing.T) {
	target := types.NewJID("85261234567", types.DefaultUserServer)
	patch := buildContactRemovalPatch(target)
	if patch.Type != appstate.WAPatchCriticalUnblockLow {
		t.Fatalf("patch type = %q, want %q", patch.Type, appstate.WAPatchCriticalUnblockLow)
	}
	if len(patch.Mutations) != 1 {
		t.Fatalf("mutations len = %d", len(patch.Mutations))
	}
	mutation := patch.Mutations[0]
	if len(mutation.Index) != 2 || mutation.Index[0] != appstate.IndexContact || mutation.Index[1] != target.String() {
		t.Fatalf("unexpected mutation index: %+v", mutation.Index)
	}
	action := mutation.Value.GetContactAction()
	if action.GetFullName() != "" || action.FirstName != nil || action.GetSaveOnPrimaryAddressbook() {
		t.Fatalf("unexpected removal ContactAction: %+v", action)
	}
}

func TestEncodeContactRemovalPatchUsesRemoveOperation(t *testing.T) {
	ctx := context.Background()
	keyStore := newMemoryAppStateKeys()
	appStateStore := newMemoryAppState()
	deviceStore := &wastore.Device{AppStateKeys: keyStore, AppState: appStateStore}

	keyID := bytes.Repeat([]byte{0x42}, 8)
	keyData := bytes.Repeat([]byte{0x7}, 32)
	if err := keyStore.PutAppStateSyncKey(ctx, keyID, wastore.AppStateSyncKey{Data: keyData}); err != nil {
		t.Fatalf("put app state key: %v", err)
	}

	target := types.NewJID("85261234567", types.DefaultUserServer)
	patchInfo := buildContactRemovalPatch(target)
	keys := expandAppStateKeys(keyData)
	indexBytes, err := json.Marshal(patchInfo.Mutations[0].Index)
	if err != nil {
		t.Fatalf("marshal index: %v", err)
	}
	indexMAC := concatAndHMAC(sha256.New, keys.index, indexBytes)
	previousValueMAC := bytes.Repeat([]byte{0x99}, 32)
	if err := deviceStore.AppState.PutAppStateMutationMACs(ctx, string(patchInfo.Type), 7, []wastore.AppStateMutationMAC{{
		IndexMAC: indexMAC,
		ValueMAC: previousValueMAC,
	}}); err != nil {
		t.Fatalf("put previous mutation MAC: %v", err)
	}

	var initialHash [128]byte
	for i := range initialHash {
		initialHash[i] = byte(i)
	}
	encoded, err := encodeAppStatePatchWithOperation(
		ctx,
		deviceStore,
		keyID,
		appstate.HashState{Version: 7, Hash: initialHash},
		patchInfo,
		waServerSync.SyncdMutation_REMOVE,
	)
	if err != nil {
		t.Fatalf("encode removal patch: %v", err)
	}

	patch, mutation := decodeAppStateMutationForTest(t, encoded)
	if mutation.GetOperation() != waServerSync.SyncdMutation_REMOVE {
		t.Fatalf("mutation operation = %s, want REMOVE", mutation.GetOperation())
	}
	if !bytes.Equal(mutation.GetRecord().GetKeyID().GetID(), keyID) {
		t.Fatalf("mutation key ID mismatch")
	}
	action := decryptAppStateMutationForTest(t, mutation, keyData)
	var decodedIndex []string
	if err := json.Unmarshal(action.GetIndex(), &decodedIndex); err != nil {
		t.Fatalf("unmarshal mutation index: %v", err)
	}
	if len(decodedIndex) != 2 || decodedIndex[0] != appstate.IndexContact || decodedIndex[1] != target.String() {
		t.Fatalf("unexpected decrypted index: %+v", decodedIndex)
	}
	contactAction := action.GetValue().GetContactAction()
	if contactAction.GetFullName() != "" || contactAction.FirstName != nil || contactAction.GetSaveOnPrimaryAddressbook() {
		t.Fatalf("unexpected encrypted removal ContactAction: %+v", contactAction)
	}

	expectedHash := initialHash
	lthash.WAPatchIntegrity.SubtractThenAddInPlace(expectedHash[:], [][]byte{previousValueMAC}, nil)
	expectedState := appstate.HashState{Version: 8, Hash: expectedHash}
	expectedSnapshotMAC := appStateSnapshotMAC(expectedState, patchInfo.Type, keys.snapshotMAC)
	if !bytes.Equal(patch.GetSnapshotMAC(), expectedSnapshotMAC) {
		t.Fatalf("snapshot MAC does not remove the previous contact mutation exactly once")
	}
	if len(patch.GetPatchMAC()) != 32 {
		t.Fatalf("patch MAC len = %d", len(patch.GetPatchMAC()))
	}

	setEncoded, err := encodeAppStatePatchWithOperation(
		ctx,
		deviceStore,
		keyID,
		appstate.HashState{Version: 7, Hash: initialHash},
		patchInfo,
		waServerSync.SyncdMutation_SET,
	)
	if err != nil {
		t.Fatalf("encode control SET patch: %v", err)
	}
	_, setMutation := decodeAppStateMutationForTest(t, setEncoded)
	if setMutation.GetOperation() != waServerSync.SyncdMutation_SET {
		t.Fatalf("control mutation operation = %s, want SET", setMutation.GetOperation())
	}
}
