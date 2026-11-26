// Copyright (c) 2021 Tulir Asokan
// Copyright (c) 2026 KLHA829
//
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.

package main

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"crypto/sha512"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"hash"
	"time"

	"go.mau.fi/whatsmeow/appstate"
	"go.mau.fi/whatsmeow/appstate/lthash"
	"go.mau.fi/whatsmeow/proto/waServerSync"
	"go.mau.fi/whatsmeow/proto/waSyncAction"
	"go.mau.fi/whatsmeow/store"
	"go.mau.fi/whatsmeow/util/cbcutil"
	"go.mau.fi/whatsmeow/util/hkdfutil"
	"google.golang.org/protobuf/proto"
)

type expandedAppStateKeys struct {
	index           []byte
	valueEncryption []byte
	valueMAC        []byte
	snapshotMAC     []byte
	patchMAC        []byte
}

func expandAppStateKeys(keyData []byte) expandedAppStateKeys {
	expanded := hkdfutil.SHA256(keyData, nil, []byte("WhatsApp Mutation Keys"), 160)
	return expandedAppStateKeys{
		index:           expanded[0:32],
		valueEncryption: expanded[32:64],
		valueMAC:        expanded[64:96],
		snapshotMAC:     expanded[96:128],
		patchMAC:        expanded[128:160],
	}
}

func concatAndHMAC(alg func() hash.Hash, key []byte, data ...[]byte) []byte {
	h := hmac.New(alg, key)
	for _, item := range data {
		_, _ = h.Write(item)
	}
	return h.Sum(nil)
}

func uint64ToBytes(val uint64) []byte {
	data := make([]byte, 8)
	binary.BigEndian.PutUint64(data, val)
	return data
}

func appStateContentMAC(operation waServerSync.SyncdMutation_SyncdOperation, data, keyID, key []byte) []byte {
	operationBytes := []byte{byte(operation) + 1}
	keyDataLength := uint64ToBytes(uint64(len(keyID) + 1))
	return concatAndHMAC(sha512.New, key, operationBytes, keyID, data, keyDataLength)[:32]
}

func appStateSnapshotMAC(state appstate.HashState, name appstate.WAPatchName, key []byte) []byte {
	return concatAndHMAC(sha256.New, key, state.Hash[:], uint64ToBytes(state.Version), []byte(name))
}

func appStatePatchMAC(patch *waServerSync.SyncdPatch, name appstate.WAPatchName, key []byte, version uint64) []byte {
	dataToHash := make([][]byte, len(patch.GetMutations())+3)
	dataToHash[0] = patch.GetSnapshotMAC()
	for i, mutation := range patch.Mutations {
		val := mutation.GetRecord().GetValue().GetBlob()
		dataToHash[i+1] = val[len(val)-32:]
	}
	dataToHash[len(dataToHash)-2] = uint64ToBytes(version)
	dataToHash[len(dataToHash)-1] = []byte(name)
	return concatAndHMAC(sha256.New, key, dataToHash...)
}

func updateOutgoingAppStateHash(
	ctx context.Context,
	deviceStore *store.Device,
	name appstate.WAPatchName,
	state *appstate.HashState,
	mutations []*waServerSync.SyncdMutation,
) error {
	var added, removed [][]byte
	for _, mutation := range mutations {
		if mutation.GetOperation() == waServerSync.SyncdMutation_SET {
			value := mutation.GetRecord().GetValue().GetBlob()
			added = append(added, value[len(value)-32:])
		}
		indexMAC := mutation.GetRecord().GetIndex().GetBlob()
		previousValueMAC, err := deviceStore.AppState.GetAppStateMutationMAC(ctx, string(name), indexMAC)
		if err != nil {
			return fmt.Errorf("failed to get value MAC of previous SET operation: %w", err)
		}
		if previousValueMAC != nil {
			removed = append(removed, previousValueMAC)
		}
	}
	lthash.WAPatchIntegrity.SubtractThenAddInPlace(state.Hash[:], removed, added)
	return nil
}

// encodeAppStatePatchWithOperation is the upstream whatsmeow app-state encoder
// with the mutation operation caller-selectable. whatsmeow v0.0.0-20261116172437
// hard-codes SET, which cannot encode a contact removal.
func encodeAppStatePatchWithOperation(
	ctx context.Context,
	deviceStore *store.Device,
	keyID []byte,
	state appstate.HashState,
	patchInfo appstate.PatchInfo,
	operation waServerSync.SyncdMutation_SyncdOperation,
) ([]byte, error) {
	if deviceStore == nil || deviceStore.AppStateKeys == nil || deviceStore.AppState == nil {
		return nil, fmt.Errorf("app state store unavailable")
	}
	keyData, err := deviceStore.AppStateKeys.GetAppStateSyncKey(ctx, keyID)
	if err != nil {
		return nil, fmt.Errorf("failed to get app state key details with key ID %x: %w", keyID, err)
	}
	if keyData == nil {
		return nil, fmt.Errorf("failed to get app state key details with key ID %x: %w", keyID, appstate.ErrKeyNotFound)
	}
	keys := expandAppStateKeys(keyData.Data)

	if patchInfo.Timestamp.IsZero() {
		patchInfo.Timestamp = time.Now()
	}

	mutations := make([]*waServerSync.SyncdMutation, 0, len(patchInfo.Mutations))
	for _, mutationInfo := range patchInfo.Mutations {
		if mutationInfo.Value == nil {
			return nil, fmt.Errorf("mutation %v has no value", mutationInfo.Index)
		}
		mutationInfo.Value.Timestamp = proto.Int64(patchInfo.Timestamp.UnixMilli())

		indexBytes, err := json.Marshal(mutationInfo.Index)
		if err != nil {
			return nil, fmt.Errorf("failed to marshal mutation index: %w", err)
		}

		pbObj := &waSyncAction.SyncActionData{
			Index:   indexBytes,
			Value:   mutationInfo.Value,
			Padding: []byte{},
			Version: &mutationInfo.Version,
		}
		content, err := proto.Marshal(pbObj)
		if err != nil {
			return nil, fmt.Errorf("failed to marshal mutation: %w", err)
		}
		encryptedContent, err := cbcutil.Encrypt(keys.valueEncryption, nil, content)
		if err != nil {
			return nil, fmt.Errorf("failed to encrypt mutation: %w", err)
		}

		valueMAC := appStateContentMAC(operation, encryptedContent, keyID, keys.valueMAC)
		indexMAC := concatAndHMAC(sha256.New, keys.index, indexBytes)
		mutations = append(mutations, &waServerSync.SyncdMutation{
			Operation: operation.Enum(),
			Record: &waServerSync.SyncdRecord{
				Index: &waServerSync.SyncdIndex{Blob: indexMAC},
				Value: &waServerSync.SyncdValue{Blob: append(encryptedContent, valueMAC...)},
				KeyID: &waServerSync.KeyId{ID: keyID},
			},
		})
	}

	if err := updateOutgoingAppStateHash(ctx, deviceStore, patchInfo.Type, &state, mutations); err != nil {
		return nil, fmt.Errorf("failed to update state hash: %w", err)
	}
	state.Version += 1

	syncdPatch := &waServerSync.SyncdPatch{
		SnapshotMAC: appStateSnapshotMAC(state, patchInfo.Type, keys.snapshotMAC),
		KeyID:       &waServerSync.KeyId{ID: keyID},
		Mutations:   mutations,
	}
	syncdPatch.PatchMAC = appStatePatchMAC(syncdPatch, patchInfo.Type, keys.patchMAC, state.Version)

	result, err := proto.Marshal(syncdPatch)
	if err != nil {
		return nil, fmt.Errorf("failed to marshal compiled patch: %w", err)
	}
	return result, nil
}
