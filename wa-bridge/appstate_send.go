// Copyright (c) 2021 Tulir Asokan
// Copyright (c) 2026 KLHA829
//
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.

package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"

	"go.mau.fi/whatsmeow"
	"go.mau.fi/whatsmeow/appstate"
	waBinary "go.mau.fi/whatsmeow/binary"
	"go.mau.fi/whatsmeow/proto/waServerSync"
	"go.mau.fi/whatsmeow/store"
	"go.mau.fi/whatsmeow/types"
)

var errActiveAppStateRecordNotFound = errors.New("active app state record not found for removal")

type appStateKeyIDLister interface {
	ListAppStateSyncKeyIDs(ctx context.Context) ([][]byte, error)
}

type appStateMutationValidator func(ctx context.Context) error

type appStateInternals interface {
	SendIQ(ctx context.Context, query whatsmeow.DangerousInfoQuery) (*waBinary.Node, error)
	DownloadExternalAppStateBlob(ctx context.Context, ref *waServerSync.ExternalBlobReference) ([]byte, error)
	ApplyAppStatePatches(ctx context.Context, name appstate.WAPatchName, state appstate.HashState, patches *appstate.PatchList, fullSync bool, eventsToDispatch *[]any) (appstate.HashState, error)
	FetchAppState(ctx context.Context, name appstate.WAPatchName, fullSync, onlyIfNotSynced bool) ([]any, error)
	DispatchEvent(evt any) bool
}

type appStateOperationSender func(
	ctx context.Context,
	patch appstate.PatchInfo,
	operation waServerSync.SyncdMutation_SyncdOperation,
	allowRetry bool,
	validateAttempt appStateMutationValidator,
) error

// sendAppStateWithOperation mirrors whatsmeow.Client.SendAppState, including
// conflict recovery, while allowing REMOVE mutations. whatsmeow's public patch
// encoder hard-codes SET, so contact removals cannot go through that path.
func (b *WhatsmeowBridge) sendAppStateWithOperation(
	ctx context.Context,
	patch appstate.PatchInfo,
	operation waServerSync.SyncdMutation_SyncdOperation,
	allowRetry bool,
	validateAttempt appStateMutationValidator,
) error {
	if b.client == nil {
		return errNotReady
	}
	return b.sendAppStateWithOperationAndInternals(ctx, patch, operation, allowRetry, validateAttempt, b.client.DangerousInternals())
}

func patchHasActiveMutationWithKey(
	ctx context.Context,
	deviceStore *store.Device,
	patch appstate.PatchInfo,
	keyID []byte,
) (bool, error) {
	if len(patch.Mutations) == 0 {
		return false, nil
	}
	keyData, err := deviceStore.AppStateKeys.GetAppStateSyncKey(ctx, keyID)
	if err != nil {
		return false, fmt.Errorf("failed to get app state key %x: %w", keyID, err)
	}
	if keyData == nil {
		return false, nil
	}
	keys := expandAppStateKeys(keyData.Data)
	for _, mutationInfo := range patch.Mutations {
		indexBytes, err := json.Marshal(mutationInfo.Index)
		if err != nil {
			return false, fmt.Errorf("failed to marshal mutation index: %w", err)
		}
		indexMAC := concatAndHMAC(sha256.New, keys.index, indexBytes)
		prevMAC, err := deviceStore.AppState.GetAppStateMutationMAC(ctx, string(patch.Type), indexMAC)
		if err != nil {
			return false, fmt.Errorf("failed to check active app state mutation MAC: %w", err)
		}
		if prevMAC == nil {
			return false, nil
		}
	}
	return true, nil
}

func (b *WhatsmeowBridge) listAppStateSyncKeyIDs(ctx context.Context) ([][]byte, error) {
	cli := b.client
	if cli == nil || cli.Store == nil {
		return nil, errNotReady
	}
	if lister, ok := cli.Store.AppStateKeys.(appStateKeyIDLister); ok {
		return lister.ListAppStateSyncKeyIDs(ctx)
	}
	if b.db == nil || cli.Store.ID == nil {
		return nil, nil
	}
	rows, err := b.db.QueryContext(ctx, `SELECT key_id FROM whatsmeow_app_state_sync_keys WHERE jid = $1 ORDER BY timestamp DESC`, cli.Store.ID.String())
	if err != nil {
		return nil, fmt.Errorf("list app state sync key IDs: %w", err)
	}
	defer func() { _ = rows.Close() }()
	var ids [][]byte
	for rows.Next() {
		var id []byte
		if err := rows.Scan(&id); err != nil {
			return nil, fmt.Errorf("scan app state sync key ID: %w", err)
		}
		ids = append(ids, id)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate app state sync key IDs: %w", err)
	}
	return ids, nil
}

func (b *WhatsmeowBridge) resolveAppStateKeyIDsForRemove(
	ctx context.Context,
	patch appstate.PatchInfo,
) ([][]byte, error) {
	cli := b.client
	if cli == nil || cli.Store == nil || cli.Store.AppStateKeys == nil || cli.Store.AppState == nil {
		return nil, errNotReady
	}
	latestKeyID, err := cli.Store.AppStateKeys.GetLatestAppStateSyncKeyID(ctx)
	if err != nil {
		return nil, fmt.Errorf("failed to get latest app state key ID: %w", err)
	}
	if latestKeyID == nil {
		return nil, fmt.Errorf("no app state keys found, creating app state keys is not supported")
	}
	var matchingKeys [][]byte
	matched, err := patchHasActiveMutationWithKey(ctx, cli.Store, patch, latestKeyID)
	if err != nil {
		return nil, err
	}
	if matched {
		matchingKeys = append(matchingKeys, latestKeyID)
	}
	candidateIDs, err := b.listAppStateSyncKeyIDs(ctx)
	if err != nil {
		return nil, err
	}
	for _, candidateID := range candidateIDs {
		if bytes.Equal(candidateID, latestKeyID) {
			continue
		}
		alreadyAdded := false
		for _, seen := range matchingKeys {
			if bytes.Equal(seen, candidateID) {
				alreadyAdded = true
				break
			}
		}
		if alreadyAdded {
			continue
		}
		matched, err := patchHasActiveMutationWithKey(ctx, cli.Store, patch, candidateID)
		if err != nil {
			return nil, err
		}
		if matched {
			matchingKeys = append(matchingKeys, candidateID)
		}
	}
	if len(matchingKeys) == 0 {
		return nil, fmt.Errorf("%w: %s", errActiveAppStateRecordNotFound, patch.Type)
	}
	return matchingKeys, nil
}

func (b *WhatsmeowBridge) sendAppStateWithOperationAndInternals(
	ctx context.Context,
	patch appstate.PatchInfo,
	operation waServerSync.SyncdMutation_SyncdOperation,
	allowRetry bool,
	validateAttempt appStateMutationValidator,
	internals appStateInternals,
) error {
	cli := b.client
	if cli == nil || cli.Store == nil {
		return errNotReady
	}
	if operation == waServerSync.SyncdMutation_REMOVE {
		// Validate ownership and version before resolving keys so conflict-retry tests
		// and stale-name checks run in the expected order.
		if _, _, err := cli.Store.AppState.GetAppStateVersion(ctx, string(patch.Type)); err != nil {
			return err
		}
		if validateAttempt != nil {
			if err := validateAttempt(ctx); err != nil {
				return err
			}
		}
		keyIDs, err := b.resolveAppStateKeyIDsForRemove(ctx, patch)
		if err != nil {
			return err
		}
		for i, keyID := range keyIDs {
			attemptValidator := validateAttempt
			if i > 0 && validateAttempt != nil {
				// Previous REMOVE in this batch may have already cleared the local contact
				// name via FetchAppState; still abort if a user saved a different name.
				attemptValidator = func(validateCtx context.Context) error {
					err := validateAttempt(validateCtx)
					if errors.Is(err, errContactLabelAlreadyCleared) {
						return nil
					}
					return err
				}
			}
			if err := b.sendAppStatePatchWithKeyLoop(ctx, patch, operation, keyID, allowRetry, attemptValidator, internals); err != nil {
				return err
			}
		}
		return nil
	}
	latestKeyID, err := cli.Store.AppStateKeys.GetLatestAppStateSyncKeyID(ctx)
	if err != nil {
		return fmt.Errorf("failed to get latest app state key ID: %w", err)
	}
	if latestKeyID == nil {
		return fmt.Errorf("no app state keys found, creating app state keys is not supported")
	}
	return b.sendAppStatePatchWithKeyLoop(ctx, patch, operation, latestKeyID, allowRetry, validateAttempt, internals)
}

func (b *WhatsmeowBridge) sendAppStatePatchWithKeyLoop(
	ctx context.Context,
	patch appstate.PatchInfo,
	operation waServerSync.SyncdMutation_SyncdOperation,
	keyID []byte,
	allowRetry bool,
	validateAttempt appStateMutationValidator,
	internals appStateInternals,
) error {
	cli := b.client
	for {
		version, hash, err := cli.Store.AppState.GetAppStateVersion(ctx, string(patch.Type))
		if err != nil {
			return err
		}
		if validateAttempt != nil {
			if err := validateAttempt(ctx); err != nil {
				return err
			}
		}

		state := appstate.HashState{Version: version, Hash: hash}
		encodedPatch, err := encodeAppStatePatchWithOperation(ctx, cli.Store, keyID, state, patch, operation)
		if err != nil {
			return err
		}

		resp, err := internals.SendIQ(ctx, whatsmeow.DangerousInfoQuery{
			Namespace: "w:sync:app:state",
			Type:      "set",
			To:        types.ServerJID,
			Content: []waBinary.Node{{
				Tag: "sync",
				Content: []waBinary.Node{{
					Tag: "collection",
					Attrs: waBinary.Attrs{
						"name":            string(patch.Type),
						"version":         version,
						"return_snapshot": false,
					},
					Content: []waBinary.Node{{
						Tag:     "patch",
						Content: encodedPatch,
					}},
				}},
			}},
		})
		if err != nil {
			return err
		}

		respCollection, ok := resp.GetOptionalChildByTag("sync", "collection")
		if !ok {
			return &whatsmeow.ElementMissingError{Tag: "collection", In: "app state send response"}
		}
		if respCollection.AttrGetter().OptionalString("type") == "error" {
			errorTag, hasErrorTag := respCollection.GetOptionalChildByTag("error")
			mainErr := fmt.Errorf("%w: %s", whatsmeow.ErrAppStateUpdate, &respCollection)
			if hasErrorTag {
				mainErr = fmt.Errorf("%w (%s): %s", whatsmeow.ErrAppStateUpdate, patch.Type, &errorTag)
			}
			if hasErrorTag && errorTag.AttrGetter().Int("code") == 409 && allowRetry {
				b.log.Warnf("app state %s update conflict; applying server patches before retry: %v", patch.Type, mainErr)
				var eventsToDispatch []any
				patches, err := appstate.ParsePatchList(ctx, &respCollection, internals.DownloadExternalAppStateBlob)
				if err != nil {
					return fmt.Errorf("%w (also, parsing patches in the response failed: %w)", mainErr, err)
				}
				if _, err = internals.ApplyAppStatePatches(ctx, patch.Type, state, patches, false, &eventsToDispatch); err != nil {
					return fmt.Errorf("%w (also, applying patches in the response failed: %w)", mainErr, err)
				}
				go func() {
					for _, evt := range eventsToDispatch {
						internals.DispatchEvent(evt)
					}
				}()
				// Loop rather than recursing so the ownership validator cannot be dropped on retry.
				allowRetry = false
				continue
			}
			return mainErr
		}

		eventsToDispatch, err := internals.FetchAppState(ctx, patch.Type, false, false)
		if err != nil {
			return fmt.Errorf("failed to fetch app state after sending update: %w", err)
		}
		go func() {
			for _, evt := range eventsToDispatch {
				internals.DispatchEvent(evt)
			}
		}()
		return nil
	}
}
