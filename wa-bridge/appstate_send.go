// Copyright (c) 2021 Tulir Asokan
// Copyright (c) 2026 KLHA829
//
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.

package main

import (
	"context"
	"fmt"

	"go.mau.fi/whatsmeow"
	"go.mau.fi/whatsmeow/appstate"
	waBinary "go.mau.fi/whatsmeow/binary"
	"go.mau.fi/whatsmeow/proto/waServerSync"
	"go.mau.fi/whatsmeow/types"
)

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
		latestKeyID, err := cli.Store.AppStateKeys.GetLatestAppStateSyncKeyID(ctx)
		if err != nil {
			return fmt.Errorf("failed to get latest app state key ID: %w", err)
		}
		if latestKeyID == nil {
			return fmt.Errorf("no app state keys found, creating app state keys is not supported")
		}

		state := appstate.HashState{Version: version, Hash: hash}
		encodedPatch, err := encodeAppStatePatchWithOperation(ctx, cli.Store, latestKeyID, state, patch, operation)
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
