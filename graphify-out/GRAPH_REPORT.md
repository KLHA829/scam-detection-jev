> **快照說明**
>
> 這是 `main` 在 commit `8c3be3ba`（2026-10-21）的時點程式碼圖，不包括草稿 PR #60。之後程式碼再改，這份圖就會過時，請勿當成架構依據；架構以 [AGENTS.md](../AGENTS.md) 為準。用 Graphify 0.9.106 產生：`graphify extract . --code-only`，然後 `graphify cluster-only . --no-label`；沒有呼叫 LLM，亦沒有上傳。

# Graph Report - scam-detection-jev  (2026-11-12)

## Corpus Check
- cluster-only mode — file stats not available

## Summary
- 1012 nodes · 2273 edges · 59 communities (37 shown, 22 thin omitted)
- Extraction: 92% EXTRACTED · 8% INFERRED · 0% AMBIGUOUS · INFERRED: 177 edges (avg confidence: 0.85)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `8c3be3ba`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- Community 0
- Community 1
- Community 2
- Community 3
- Community 4
- Community 7
- Community 8
- Community 9
- Community 10
- Community 11
- Community 12
- Community 13
- Community 14
- Community 15
- Community 16
- Community 19
- Community 20
- Community 21
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
- Community 39
- Community 40
- Community 41
- Community 42
- Community 43
- Community 44
- Community 45
- Community 49
- Community 51
- Community 52

## God Nodes (most connected - your core abstractions)
1. `createStubJevlikeClient()` - 30 edges
2. `runIncomingMessage()` - 26 edges
3. `loadRubric()` - 24 edges
4. `main()` - 23 edges
5. `processIncomingMessage()` - 21 edges
6. `shouldTriggerLlmReview()` - 18 edges
7. `createLlmReviewConfig()` - 17 edges
8. `explainSuspicion()` - 16 edges
9. `attachHandlers()` - 16 edges
10. `handleWaMessage()` - 14 edges

## Surprising Connections (you probably didn't know these)
- `baseDeps()` --calls--> `createStubJevlikeClient()`  [EXTRACTED]
  lib/llm-review-cooldown.test.js → stub-jevlike.js
- `deps()` --calls--> `createStubJevlikeClient()`  [EXTRACTED]
  lib/action-pacer.test.js → stub-jevlike.js
- `maskMessages()` --calls--> `createStubJevlikeClient()`  [EXTRACTED]
  lib/agents-invariants.test.js → stub-jevlike.js
- `main()` --calls--> `TtlCache`  [EXTRACTED]
  whatsapp-bot.js → lib/cache.js
- `main()` --calls--> `createLlmReviewConfig()`  [EXTRACTED]
  whatsapp-bot.js → lib/llm-review.js

## Import Cycles
- None detected.

## Communities (59 total, 22 thin omitted)

### Community 0 - "Community 0"
Cohesion: 0.06
Nodes (72): applyBlockPolicy(), applyContextLlmDecision(), buildTranscript(), CONTEXT_SYSTEM_PROMPT, contextMeetsMinConfidence(), maskMessagesForLlm(), maskOneForLlm(), parseContextReview() (+64 more)

### Community 1 - "Community 1"
Cohesion: 0.05
Nodes (72): RFC-2606, resolveIncomingMessageLabel(), ALLOWED_SUFFIXES, bareHostRe(), BRANDS, brandTokens(), decodePart(), { domainToUnicode } (+64 more)

### Community 2 - "Community 2"
Cohesion: 0.07
Nodes (61): applyUnblockChoice(), readRecentBlockRecords(), contextLlmEnabled(), contextLlmMessageLimit(), createRecentContext(), envFlag(), processIncomingMessage(), withChatLock() (+53 more)

### Community 3 - "Community 3"
Cohesion: 0.08
Nodes (26): cacheKeyForMessage(), TtlCache, isOfficialWhatsAppId(), OFFICIAL_WHATSAPP_IDS, shouldIgnoreMessage(), SKIP_TYPES, assertCompleteMask(), createMaskClient() (+18 more)

### Community 4 - "Community 4"
Cohesion: 0.07
Nodes (38): PUPPETEER_SKIP_DOWNLOAD, jobs, static-gates, test, verify-smoke-ubuntu, verify-smoke-windows, name, on (+30 more)

### Community 7 - "Community 7"
Cohesion: 0.15
Nodes (14): count_by(), download_uci_raw(), extract_urls(), main(), map_vanila_label(), map_vanila_lang(), normalize_uci(), normalize_vanila() (+6 more)

### Community 8 - "Community 8"
Cohesion: 0.12
Nodes (12): model_mask_spans(), prf(), choose_threshold(), clear_lure_chars(), flags_from_offsets(), mask_option_logits(), predict_spans(), score_threshold() (+4 more)

### Community 9 - "Community 9"
Cohesion: 0.14
Nodes (14): char_set(), extra_gold_spans(), _fill(), generate_split(), gold_spans(), _intl_phone(), _local_phone(), _name() (+6 more)

### Community 10 - "Community 10"
Cohesion: 0.12
Nodes (20): loadFromDisk(), persistToDisk(), defaultStore, envNumber(), fs, isChatLlmCooldownActive(), llmReviewCooldownMs(), path (+12 more)

### Community 11 - "Community 11"
Cohesion: 0.11
Nodes (11): env_int(), env_str(), load_runtime(), main(), parse_options(), _to_utf16_spans(), _url_host_needle(), _url_spans() (+3 more)

### Community 12 - "Community 12"
Cohesion: 0.15
Nodes (18): blockEligibility(), blockEnabled(), contactNameForBlock(), finiteNumber(), HEURISTIC_CONTACT_LABELS, resolveBlockThreshold(), deliverGuidedReview(), reviewContactName() (+10 more)

### Community 13 - "Community 13"
Cohesion: 0.19
Nodes (16): scoreMessage(), assignFiniteThreshold(), clamp01(), DEFAULT_RUBRIC_PATH, emptyScoreResult(), fs, jevlikeMaxChars(), jevlikePayloadToScoreResult() (+8 more)

### Community 14 - "Community 14"
Cohesion: 0.18
Nodes (13): buildActionNotice(), chatListName(), composeActionNotice(), finite(), headline(), assert, { describe, it }, textOf() (+5 more)

### Community 15 - "Community 15"
Cohesion: 0.14
Nodes (13): assert, { describe, it }, fs, os, path, rubric, incomingDeps(), llmChatResponse() (+5 more)

### Community 16 - "Community 16"
Cohesion: 0.12
Nodes (19): dependencies, dotenv@^16.6.1, qrcode-terminal@^0.12.0, whatsapp-web.js@^1.34.1, description, engines, node, main (+11 more)

### Community 19 - "Community 19"
Cohesion: 0.14
Nodes (8): find_mask_spans(), mask_payload(), merge_mask_spans(), _name_spans(), _otp_spans(), _spans_from_regex(), MaskSpanTests, SyntheticLabelTests

### Community 20 - "Community 20"
Cohesion: 0.21
Nodes (15): assert, { describe, it }, fs, os, path, rubric, { spawnSync }, matchOption() (+7 more)

### Community 21 - "Community 21"
Cohesion: 0.15
Nodes (14): llmReviewDeps(), llmOffDeps(), joinWindow(), assert, { describe, it }, maskMessages(), rubric, clamp01() (+6 more)

### Community 23 - "Community 23"
Cohesion: 0.12
Nodes (6): assert, { describe, it }, fs, os, path, rubric

### Community 24 - "Community 24"
Cohesion: 0.12
Nodes (6): assert, { describe, it }, maskMessages(), rubric, assert, { describe, it }

### Community 25 - "Community 25"
Cohesion: 0.20
Nodes (12): assert, { describe, it }, fs, os, path, rubric, { spawn }, benignMinCharsFromEnv() (+4 more)

### Community 27 - "Community 27"
Cohesion: 0.16
Nodes (6): createActionPacer(), envInt(), assert, deps(), { describe, it }, rubric

### Community 28 - "Community 28"
Cohesion: 0.26
Nodes (11): applyXxx(), { domainToUnicode }, findMaskSpans(), mergeSpans(), NAME_RE, nameSpans(), otpSpans(), RULES (+3 more)

### Community 29 - "Community 29"
Cohesion: 0.29
Nodes (12): CONTEXT_LLM_DEFAULT_OFF, fail(), fs, gateContextLlmDefault(), gateScorePrimaryDocs(), gateVerifyAliasRedirect(), listMdUnder(), pass() (+4 more)

### Community 30 - "Community 30"
Cohesion: 0.23
Nodes (3): authorized(), Handler, LabelMetricTests

### Community 31 - "Community 31"
Cohesion: 0.18
Nodes (8): child, fs, logFd, path, script, { spawn }, fs, path

### Community 32 - "Community 32"
Cohesion: 0.21
Nodes (5): maybe_load_mask_head(), resolve_mask_checkpoint(), head_state_from_checkpoint(), HeadStateTests, UnloadedWorkerTests

### Community 33 - "Community 33"
Cohesion: 0.24
Nodes (5): option_index(), scam_probability(), score_text(), move(), ScamProbabilityTests

### Community 34 - "Community 34"
Cohesion: 0.17
Nodes (6): assert, { describe, it }, fs, os, path, rubric

### Community 35 - "Community 35"
Cohesion: 0.25
Nodes (9): cmdlineForPid(), fetchHealthJson(), fs, http, path, pidLooksLikeStub(), { spawnSync }, win32RecordedStubOk() (+1 more)

### Community 36 - "Community 36"
Cohesion: 0.18
Nodes (8): assert, { describe, it }, { execSync }, fs, path, ROOT, SCORE_PRIMARY_BANNED, VERIFY_SKILL_ROOTS

### Community 37 - "Community 37"
Cohesion: 0.35
Nodes (10): createOperatorState(), reload(), update(), defaultOperatorModePath(), fs, normalizeMode(), path, readOperatorModeFile() (+2 more)

### Community 39 - "Community 39"
Cohesion: 0.33
Nodes (8): createReviewQueue(), save(), defaultReviewQueuePath(), fs, path, readQueue(), trimItems(), writeQueue()

### Community 40 - "Community 40"
Cohesion: 0.22
Nodes (5): assert, { describe, it }, fs, os, path

### Community 42 - "Community 42"
Cohesion: 0.40
Nodes (5): fs, path, resolveBash(), spawnSkillScript(), { spawnSync }

### Community 44 - "Community 44"
Cohesion: 0.33
Nodes (3): python, run, { spawnSync }

### Community 45 - "Community 45"
Cohesion: 0.60
Nodes (5): download_direct(), download_with_api(), download_with_gh(), looks_like_checkpoint(), download_jevlike_ckpt.sh script

## Knowledge Gaps
- **2 isolated node(s):** `RFC-2606`, `PUPPETEER_SKIP_DOWNLOAD`
  These have ≤1 connection - possible missing edges. (Counts symbols only; 454 node(s) total have ≤1 connection when file, concept and rationale nodes are included.)
- **22 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `whatsapp-web.js` connect `Community 16` to `Community 2`, `Community 23`?**
  _High betweenness centrality (0.020) - this node is a cross-community bridge._
- **What connects `RFC-2606`, `PUPPETEER_SKIP_DOWNLOAD` to the rest of the system?**
  _2 weakly-connected nodes found - possible missing edges._
- **Should `Community 0` be split into smaller, more focused modules?**
  _Cohesion score 0.06406112253893623 - nodes in this community are weakly interconnected._
- **Why does `createStubJevlikeClient()` connect `Community 21` to `Community 0`, `Community 1`, `Community 34`, `Community 3`, `Community 10`, `Community 13`, `Community 14`, `Community 15`, `Community 23`, `Community 24`, `Community 25`, `Community 27`?**
  _High betweenness centrality (0.015) - this node is a cross-community bridge._
- **Should `Community 1` be split into smaller, more focused modules?**
  _Cohesion score 0.05092592592592592 - nodes in this community are weakly interconnected._
- **Why does `TtlCache` connect `Community 3` to `Community 25`, `Community 2`, `Community 20`?**
  _High betweenness centrality (0.011) - this node is a cross-community bridge._
- **Should `Community 2` be split into smaller, more focused modules?**
  _Cohesion score 0.07082494969818913 - nodes in this community are weakly interconnected._