# Graph Report - Scam-Detection-Jev  (2026-11-25)

## Corpus Check
- cluster-only mode — file stats not available

## Summary
- 1886 nodes · 4321 edges · 119 communities (94 shown, 25 thin omitted)
- Extraction: 91% EXTRACTED · 9% INFERRED · 0% AMBIGUOUS · INFERRED: 368 edges (avg confidence: 0.84)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `ed3f512e`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- Community 0
- Community 1
- Community 2
- Community 3
- Community 4
- Community 5
- Community 6
- Community 9
- Community 10
- Community 11
- Community 12
- Community 13
- Community 14
- Community 15
- Community 16
- Community 17
- Community 18
- Community 19
- Community 20
- Community 21
- Community 22
- Community 23
- Community 24
- Community 25
- Community 26
- Community 27
- Community 28
- Community 29
- Community 30
- Community 31
- Community 32
- Community 33
- Community 34
- Community 35
- Community 36
- Community 37
- Community 38
- Community 42
- Community 43
- Community 44
- Community 45
- Community 46
- Community 47
- Community 48
- Community 49
- Community 50
- Community 51
- Community 52
- Community 53
- Community 54
- Community 56
- Community 57
- Community 58
- Community 59
- Community 60
- Community 61
- Community 62
- Community 63
- Community 64
- Community 65
- Community 66
- Community 67
- Community 68
- Community 69
- Community 70
- Community 71
- Community 72
- Community 73
- Community 74
- Community 75
- Community 76
- Community 77
- Community 78
- Community 79
- Community 80
- Community 81
- Community 82
- Community 83
- Community 84
- Community 85
- Community 86
- Community 87
- Community 88
- Community 89
- Community 90
- Community 91
- Community 92
- Community 93
- Community 95
- Community 96
- Community 97
- Community 98
- Community 99
- Community 102
- Community 103
- Community 104
- Community 105
- Community 106
- Community 108
- Community 110
- Community 111
- Community 118

## God Nodes (most connected - your core abstractions)
1. `createStubJevlikeClient()` - 42 edges
2. `WhatsmeowBridge` - 41 edges
3. `processIncomingMessage()` - 35 edges
4. `handleWaMessage()` - 33 edges
5. `createWhatsmeowTransport()` - 30 edges
6. `attachHandlers()` - 30 edges
7. `runIncomingMessage()` - 29 edges
8. `createReviewQueue()` - 27 edges
9. `createActionPacer()` - 26 edges
10. `main()` - 25 edges

## Surprising Connections (you probably didn't know these)
- `handleBridgeRequest()` --indirect_call--> `selfWid()`  [INFERRED]
  lib/mini-whatsapp.js → whatsapp-bot.js
- `healthStatus()` --indirect_call--> `selfWid()`  [INFERRED]
  lib/mini-whatsapp.js → whatsapp-bot.js
- `seedDefaultFixtures()` --indirect_call--> `selfWid()`  [INFERRED]
  lib/mini-whatsapp.js → whatsapp-bot.js
- `sendUserMessage()` --indirect_call--> `selfWid()`  [INFERRED]
  lib/mini-whatsapp.js → whatsapp-bot.js
- `setStateFlags()` --indirect_call--> `selfWid()`  [INFERRED]
  lib/mini-whatsapp.js → whatsapp-bot.js

## Import Cycles
- None detected.

## Communities (119 total, 25 thin omitted)

### Community 0 - "Community 0"
Cohesion: 0.07
Nodes (59): assertLoopbackHost(), canonicalizeJid(), constantTimeTokenMatch(), createMiniWhatsApp(), appendTimelineMessage(), editMessage(), ensureChat(), handleBridgeRequest() (+51 more)

### Community 1 - "Community 1"
Cohesion: 0.06
Nodes (50): allocateLoopbackPort(), createBridgeStateStore(), load(), persist(), createWhatsmeowTransport(), apiRequest(), buildMessageObject(), connectInitialBridgeAndSse() (+42 more)

### Community 2 - "Community 2"
Cohesion: 0.06
Nodes (7): TestExtractMessageContent(), extractContextMeta(), extractMessageContent(), unwrapE2EMessage(), newHubEpoch(), extractedMessage, statusForError()

### Community 3 - "Community 3"
Cohesion: 0.06
Nodes (40): globals, js, dependencies, dotenv@^16.6.1, qrcode-terminal@^0.12.0, whatsapp-web.js@^1.34.8, description, devDependencies (+32 more)

### Community 4 - "Community 4"
Cohesion: 0.13
Nodes (8): BridgeBackend, BridgeStore, fakeBackend, digitsOnly(), parseInputJID(), LidMapping, NewBridgeHandler(), StoredMessage

### Community 5 - "Community 5"
Cohesion: 0.08
Nodes (23): assert, fs, os, path, { test }, assert, fs, { it } (+15 more)

### Community 6 - "Community 6"
Cohesion: 0.11
Nodes (29): RFC-2606, allowEmptyHostsReload(), closeWatcherHandles(), DEFAULT_DATA_PATH, { domainToUnicode }, filenamesMatch(), fs, hostMatchesMalicious() (+21 more)

### Community 9 - "Community 9"
Cohesion: 0.09
Nodes (17): env_int(), env_str(), find_mask_spans(), load_runtime(), main(), merge_mask_spans(), _name_spans(), _otp_spans() (+9 more)

### Community 10 - "Community 10"
Cohesion: 0.09
Nodes (18): createActionPacer(), llmChatResponse(), scamLlmFetch(), createThreadContext(), assert, checkSupersededVerdict(), { describe, it }, fakeClient() (+10 more)

### Community 11 - "Community 11"
Cohesion: 0.09
Nodes (27): ALLOWED_SUFFIXES, bareHostRe(), BRANDS, { domainToUnicode }, EMAIL_HOST, EMAIL_LABEL, EMAIL_LOCAL, EMAIL_RE (+19 more)

### Community 12 - "Community 12"
Cohesion: 0.15
Nodes (23): readRecentBlockRecords(), activeBlockRecords(), blockDisplayName(), digitsMatch(), formatAmbiguousKeepBlocked(), formatAmbiguousUnblock(), formatBlockLine(), formatRecentBlocksList() (+15 more)

### Community 13 - "Community 13"
Cohesion: 0.11
Nodes (20): deliverGuidedCard(), deliverGuidedReview(), deliveries, prepareGuidedReview(), reviewContactName(), extractJsonObject(), assert, { describe, it } (+12 more)

### Community 14 - "Community 14"
Cohesion: 0.12
Nodes (26): serializedId(), createWhatsAppTransport(), ensureTransport(), fs, hasNonEmptyEnv(), isWaTransport(), normalizeMessage(), path (+18 more)

### Community 15 - "Community 15"
Cohesion: 0.15
Nodes (14): count_by(), download_uci_raw(), extract_urls(), main(), map_vanila_label(), map_vanila_lang(), normalize_uci(), normalize_vanila() (+6 more)

### Community 16 - "Community 16"
Cohesion: 0.13
Nodes (14): char_set(), _fill(), generate_split(), gold_spans(), _intl_phone(), _local_phone(), _name(), mask_option_logits() (+6 more)

### Community 17 - "Community 17"
Cohesion: 0.12
Nodes (6): archiveTrackingChatSettings, TestBridgeArchiveEventEmitsLiveTransitionsOnly(), TestNewWhatsmeowBridgeSQLiteInitSyncReconnectAndLID(), NewWhatsmeowBridge(), putArchiveTransition, WhatsmeowBridge

### Community 18 - "Community 18"
Cohesion: 0.17
Nodes (26): buildTranscript(), reviewMaskedTranscript(), contentFromChatCompletion(), createLlmReviewConfig(), envFlag(), envNumber(), HARD_SKIP_ARCHIVE_REASONS, isScoreOnlyArchive() (+18 more)

### Community 19 - "Community 19"
Cohesion: 0.10
Nodes (11): _gap_has_tokens(), mask_coverage_truncated(), mask_payload(), MaskTruncated, model_mask_spans(), LongMessageMaskTests, __call__(), MaskOptionCacheTests (+3 more)

### Community 20 - "Community 20"
Cohesion: 0.11
Nodes (16): buildActionNotice(), chatListName(), composeActionNotice(), finite(), headline(), assert, { describe, it }, textOf() (+8 more)

### Community 21 - "Community 21"
Cohesion: 0.13
Nodes (17): decideIncomingAction(), resolveIncomingMessageLabel(), isChannelId(), isOfficialWhatsAppId(), OFFICIAL_WHATSAPP_IDS, shouldIgnoreMessage(), SKIP_TYPES, inflight (+9 more)

### Community 22 - "Community 22"
Cohesion: 0.12
Nodes (16): assert, { describe, it }, maskMessages(), rubric, COMMON_TLDS, assert, { describe, it }, rubric (+8 more)

### Community 23 - "Community 23"
Cohesion: 0.13
Nodes (14): assert, { it }, blockAndRename(), canBlock(), canUnblock(), clearUnsavedContactLabel(), deleteNameFn(), labelUnsavedContact() (+6 more)

### Community 24 - "Community 24"
Cohesion: 0.15
Nodes (22): applyContextLlmDecision(), buildChatTranscript(), clearsPitchLabel(), assert, env, { it }, contextLlmEnabled(), contextMeetsMinConfidence() (+14 more)

### Community 25 - "Community 25"
Cohesion: 0.14
Nodes (21): createLlmReviewCooldownStore(), loadFromDisk(), persistToDisk(), pruneInMemory(), defaultStore, envNumber(), isChatLlmCooldownActive(), llmReviewCooldownMs() (+13 more)

### Community 26 - "Community 26"
Cohesion: 0.14
Nodes (13): extra_gold_spans(), prf(), choose_threshold(), clear_lure_chars(), _enclosing_flagged_span(), flags_from_offsets(), flags_from_window_offsets(), predict_spans() (+5 more)

### Community 27 - "Community 27"
Cohesion: 0.10
Nodes (16): assert, cases, fs, { it }, os, path, assert, env (+8 more)

### Community 28 - "Community 28"
Cohesion: 0.10
Nodes (8): contextTurnsFromEnv(), envInt(), assert, { describe, it }, fs, legacy, os, path

### Community 29 - "Community 29"
Cohesion: 0.11
Nodes (6): head_state_from_checkpoint(), HeadStateTests, _install_jevlike_stub(), MaskHeadLoadTests, SyntheticLabelTests, TorchHelperTests

### Community 30 - "Community 30"
Cohesion: 0.19
Nodes (16): scoreMessage(), assignFiniteThreshold(), clamp01(), DEFAULT_RUBRIC_PATH, emptyScoreResult(), fs, jevlikeMaxChars(), jevlikePayloadToScoreResult() (+8 more)

### Community 31 - "Community 31"
Cohesion: 0.11
Nodes (11): assert, deps(), { describe, it }, assert, http, { it }, { once }, clamp01() (+3 more)

### Community 32 - "Community 32"
Cohesion: 0.18
Nodes (12): assert, http, { test }, assertCompleteMask(), JevlikeClient, JevlikeError, parseProbScam(), resolveMaskUrl() (+4 more)

### Community 33 - "Community 33"
Cohesion: 0.17
Nodes (17): assert, { describe, it }, notScamLlmFetch(), fs, main(), BASELINE_PATH, CORPUS_PATH, falsePositives() (+9 more)

### Community 34 - "Community 34"
Cohesion: 0.19
Nodes (15): applyReviewChoice(), applyUnblockChoice(), confirmation(), isSavedContact(), unblockConfirmation(), appendBlockRecord(), defaultBlockLogPath(), fs (+7 more)

### Community 35 - "Community 35"
Cohesion: 0.19
Nodes (16): assert, { describe, it }, fs, os, path, rubric, { spawnSync }, recentReviewBodies() (+8 more)

### Community 36 - "Community 36"
Cohesion: 0.18
Nodes (16): CONTEXT_SYSTEM_PROMPT, createRecentContext(), assert, { describe, it }, harness(), llmJson(), receive(), reviewAfterOwnQuestion() (+8 more)

### Community 37 - "Community 37"
Cohesion: 0.29
Nodes (19): recordChatLlmReviewSuccess(), error(), warn(), messageIdOf(), attachHandlers(), handleCurrent(), confirmOperatorMode(), confirmReviewChoice() (+11 more)

### Community 38 - "Community 38"
Cohesion: 0.12
Nodes (12): path, { randomBytes }, root, { spawnSync }, { createRecentContext }, path, { processIncomingMessage }, root (+4 more)

### Community 42 - "Community 42"
Cohesion: 0.14
Nodes (5): option_index(), scam_probability(), score_text(), move(), ScamProbabilityTests

### Community 43 - "Community 43"
Cohesion: 0.16
Nodes (17): closeServer(), createMockServer(), fs, http, listen(), main(), { once }, os (+9 more)

### Community 44 - "Community 44"
Cohesion: 0.18
Nodes (17): assert, baseEnv(), closeServer(), createMockServer(), executeScenario(), fs, http, isContextRequest() (+9 more)

### Community 45 - "Community 45"
Cohesion: 0.15
Nodes (11): envInt(), assert, deliver(), { it }, assert, main(), fs, measureGuidedLatency() (+3 more)

### Community 46 - "Community 46"
Cohesion: 0.16
Nodes (13): BRIDGE_DIR, buildWaBridge(), defaultBinaryName(), fs, hostGoarch(), hostGoos(), path, resolveTargetPath() (+5 more)

### Community 47 - "Community 47"
Cohesion: 0.13
Nodes (15): args, CONCURRENCY, { createRecentContext }, { createStubJevlikeClient }, fs, handler, here, loadRows() (+7 more)

### Community 48 - "Community 48"
Cohesion: 0.12
Nodes (15): description, label, options, placeholder, value, body, attributes, id (+7 more)

### Community 49 - "Community 49"
Cohesion: 0.18
Nodes (13): assert, fs, { it }, os, path, queueForTest(), createReviewQueue(), save() (+5 more)

### Community 50 - "Community 50"
Cohesion: 0.15
Nodes (10): createBotContactNames(), persist(), path, readNames(), assert, { describe, it }, fs, http (+2 more)

### Community 51 - "Community 51"
Cohesion: 0.17
Nodes (13): defaultBotContactNamesPath(), contextLlmMessageLimit(), invalidatePendingGuidedReview(), createMaskClient(), defaultLlmReviewCooldownPath(), SETUP_INTRO, UNBLOCK_OPTIONS, defaultUserRestoredChatsPath() (+5 more)

### Community 52 - "Community 52"
Cohesion: 0.13
Nodes (14): description, label, placeholder, value, body, attributes, id, type (+6 more)

### Community 53 - "Community 53"
Cohesion: 0.22
Nodes (13): backupCorruptFile(), fs, path, readJsonFile(), renameWithRetry(), RETRY_CODES, SLEEP_BUFFER, sleepSync() (+5 more)

### Community 54 - "Community 54"
Cohesion: 0.27
Nodes (14): hasPaymentLinkAsk(), hasShortLinkSolicit(), analyzeScamIntent(), hasImpersonationClaim(), hasMoneyTransferAsk(), hasNewNumberLanguage(), hasOtpForwardAsk(), hasSecrecyAsk() (+6 more)

### Community 56 - "Community 56"
Cohesion: 0.24
Nodes (6): TestContactSyncFailClosedGate(), TestJIDCanonicalizationAndParsing(), buildContactResponse(), ContactResponse, canonicalJID(), phoneDigitsFromJID()

### Community 57 - "Community 57"
Cohesion: 0.19
Nodes (13): applyBlockPolicy(), llmReviewEnabled(), shouldTriggerLlmReview(), arg(), dryTransport(), FROM_RUN, fs, LLM (+5 more)

### Community 58 - "Community 58"
Cohesion: 0.14
Nodes (13): compilerOptions, allowJs, checkJs, forceConsistentCasingInFileNames, module, moduleResolution, noEmit, skipLibCheck (+5 more)

### Community 59 - "Community 59"
Cohesion: 0.21
Nodes (11): TestBuildContactLabelPatch(), TestEventHubConcurrentPublishAndCancel(), TestEventHubQRReplayAndHistory(), TestHTTPAndSSEServer(), TestLoopbackHostValidationAndIPv6Bind(), buildContactLabelPatch(), NewEventHub(), envOr() (+3 more)

### Community 60 - "Community 60"
Cohesion: 0.18
Nodes (3): maybe_load_mask_head(), resolve_mask_checkpoint(), UnloadedWorkerTests

### Community 61 - "Community 61"
Cohesion: 0.15
Nodes (6): assert, { describe, it }, fs, os, path, rubric

### Community 62 - "Community 62"
Cohesion: 0.15
Nodes (10): assert, { describe, it }, fs, os, path, assert, { describe, it }, fs (+2 more)

### Community 63 - "Community 63"
Cohesion: 0.29
Nodes (12): CONTEXT_LLM_DEFAULT_OFF, fail(), fs, gateContextLlmDefault(), gateScorePrimaryDocs(), gateVerifyAliasRedirect(), listMdUnder(), pass() (+4 more)

### Community 64 - "Community 64"
Cohesion: 0.23
Nodes (3): authorized(), Handler, LabelMetricTests

### Community 65 - "Community 65"
Cohesion: 0.26
Nodes (12): static-gates, runs-on, steps, if, name, run, shell, uses (+4 more)

### Community 66 - "Community 66"
Cohesion: 0.29
Nodes (11): maskMessages(), applyXxx(), findMaskSpans(), mergeSpans(), NAME_RE, nameSpans(), otpSpans(), RULES (+3 more)

### Community 67 - "Community 67"
Cohesion: 0.25
Nodes (9): cmdlineForPid(), fetchHealthJson(), fs, http, path, pidLooksLikeStub(), { spawnSync }, win32RecordedStubOk() (+1 more)

### Community 68 - "Community 68"
Cohesion: 0.18
Nodes (8): assert, { describe, it }, { execSync }, fs, path, ROOT, SCORE_PRIMARY_BANNED, VERIFY_SKILL_ROOTS

### Community 69 - "Community 69"
Cohesion: 0.22
Nodes (10): assert, envReads(), files, fs, { it }, LAB_ONLY, path, readRepo() (+2 more)

### Community 70 - "Community 70"
Cohesion: 0.18
Nodes (5): assert, fs, { it }, os, path

### Community 71 - "Community 71"
Cohesion: 0.51
Nodes (9): contactIdIsLid(), extractDigits(), isLidId(), isLidObject(), phoneFromLidMapping(), phoneLookupId(), resolveRealNumber(), loadSenderContact() (+1 more)

### Community 72 - "Community 72"
Cohesion: 0.36
Nodes (10): createOperatorState(), reload(), update(), defaultOperatorModePath(), normalizeMode(), path, readOperatorModeFile(), readOperatorModeState() (+2 more)

### Community 73 - "Community 73"
Cohesion: 0.18
Nodes (5): assert, { describe, it }, fs, os, path

### Community 74 - "Community 74"
Cohesion: 0.31
Nodes (3): BridgeEvent, EventHub, parseEventCursor()

### Community 75 - "Community 75"
Cohesion: 0.33
Nodes (10): hasCommonTld(), hostMatchesSuffix(), hostnameOf(), isAllowlistedHost(), isLookalike(), isPublicHost(), isShortHost(), isWarningOnly() (+2 more)

### Community 76 - "Community 76"
Cohesion: 0.20
Nodes (8): assert, { describe, it }, DIRECT_HARVEST_CASES, ENGLISH_ADVICE, ENGLISH_SCAMS, maskMessages(), OFFER_CASES, rubric

### Community 77 - "Community 77"
Cohesion: 0.22
Nodes (9): runs-on, jobs, e2e-whatsapp-boot, lint, wa-bridge, env, runs-on, steps (+1 more)

### Community 78 - "Community 78"
Cohesion: 0.22
Nodes (9): PUPPETEER_SKIP_DOWNLOAD, test, typecheck, env, runs-on, steps, env, runs-on (+1 more)

### Community 79 - "Community 79"
Cohesion: 0.22
Nodes (9): with, cache, cache-dependency-path, go-version-file, if-no-files-found, name, node-version, path (+1 more)

### Community 80 - "Community 80"
Cohesion: 0.31
Nodes (8): TestBridgeStoreMigratesLegacyMessagesTable(), TestBridgeStorePersistenceAndPollDecoding(), chmodSQLiteSidecars(), ensurePrivateSQLiteFile(), openBridgeSQLite(), ensureBridgeMessagesColumns(), NewBridgeStore(), ResolvePollVoteOptions()

### Community 82 - "Community 82"
Cohesion: 0.39
Nodes (8): primaryScoreResult(), runIncomingMessage(), emit(), formatExtra(), info(), LEVELS, ok(), scan()

### Community 83 - "Community 83"
Cohesion: 0.28
Nodes (9): brandTokens(), decodePart(), exactBrandLabel(), foldHomoglyphs(), labelIsBrand(), labelLooksLikeBrand(), levenshtein(), squash() (+1 more)

### Community 84 - "Community 84"
Cohesion: 0.22
Nodes (7): assert, { describe, it }, fs, os, path, rubric, { spawn }

### Community 85 - "Community 85"
Cohesion: 0.22
Nodes (7): { composeActionNotice }, { createThreadContext }, { explainSuspicion }, { llmOffDeps }, path, { processIncomingMessage }, root

### Community 86 - "Community 86"
Cohesion: 0.25
Nodes (7): name, on, pull_request, push, permissions, contents, branches

### Community 87 - "Community 87"
Cohesion: 0.29
Nodes (6): child, fs, logFd, path, script, { spawn }

### Community 88 - "Community 88"
Cohesion: 0.33
Nodes (7): steps, env, runs-on, steps, e2e-whatsmeow-boot, continue-on-error, id

### Community 89 - "Community 89"
Cohesion: 0.29
Nodes (5): assert, fs, { it }, os, path

### Community 90 - "Community 90"
Cohesion: 0.52
Nodes (6): blockEligibility(), blockEnabled(), botWroteName(), isOperatorSavedContact(), isUnsavedContact(), savedContactStatus()

### Community 91 - "Community 91"
Cohesion: 0.29
Nodes (6): assert, fs, { it }, os, path, { spawnSync }

### Community 92 - "Community 92"
Cohesion: 0.38
Nodes (6): assert, env, main(), measure(), median(), path

### Community 95 - "Community 95"
Cohesion: 0.40
Nodes (5): fs, path, resolveBash(), spawnSkillScript(), { spawnSync }

### Community 96 - "Community 96"
Cohesion: 0.53
Nodes (4): applyXxx(), mergeSpans(), assert, { describe, it }

### Community 97 - "Community 97"
Cohesion: 0.33
Nodes (3): python, run, { spawnSync }

### Community 98 - "Community 98"
Cohesion: 0.60
Nodes (5): download_direct(), download_with_api(), download_with_gh(), looks_like_checkpoint(), download_jevlike_ckpt.sh script

### Community 99 - "Community 99"
Cohesion: 0.33
Nodes (5): env, jsRun, pyRun, { spawnSync }, UNSET_ENV

### Community 102 - "Community 102"
Cohesion: 0.50
Nodes (4): env, runs-on, steps, e2e

### Community 103 - "Community 103"
Cohesion: 0.50
Nodes (4): verify-smoke-ubuntu, env, needs, runs-on

### Community 104 - "Community 104"
Cohesion: 0.50
Nodes (4): verify-smoke-windows, env, needs, runs-on

## Knowledge Gaps
- **3 isolated node(s):** `PUPPETEER_SKIP_DOWNLOAD`, `github.com/KLHA829/scam-detection-jev/wa-bridge`, `RFC-2606`
  These have ≤1 connection - possible missing edges. (Counts symbols only; 842 node(s) total have ≤1 connection when file, concept and rationale nodes are included.)
- **25 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `createWhatsmeowTransport()` connect `Community 1` to `Community 0`, `Community 50`, `Community 14`?**
  _High betweenness centrality (0.018) - this node is a cross-community bridge._
- **What connects `PUPPETEER_SKIP_DOWNLOAD`, `github.com/KLHA829/scam-detection-jev/wa-bridge`, `RFC-2606` to the rest of the system?**
  _3 weakly-connected nodes found - possible missing edges._
- **Should `Community 0` be split into smaller, more focused modules?**
  _Cohesion score 0.06540825285338016 - nodes in this community are weakly interconnected._
- **Why does `createStubJevlikeClient()` connect `Community 22` to `Community 33`, `Community 36`, `Community 10`, `Community 76`, `Community 13`, `Community 57`, `Community 92`, `Community 44`, `Community 50`, `Community 20`, `Community 84`, `Community 21`, `Community 25`, `Community 27`, `Community 28`, `Community 61`, `Community 30`, `Community 31`?**
  _High betweenness centrality (0.014) - this node is a cross-community bridge._
- **Should `Community 1` be split into smaller, more focused modules?**
  _Cohesion score 0.06103896103896104 - nodes in this community are weakly interconnected._
- **Why does `qrcode-terminal` connect `Community 3` to `Community 51`?**
  _High betweenness centrality (0.012) - this node is a cross-community bridge._
- **Should `Community 2` be split into smaller, more focused modules?**
  _Cohesion score 0.06363636363636363 - nodes in this community are weakly interconnected._