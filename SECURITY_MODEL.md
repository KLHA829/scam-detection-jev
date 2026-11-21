# Security model — scam-detection-jev

Threat model for this repository: what it protects, who can reach it, and what a security review should check. Facts marked **(owner)** come from the project owner; the rest is read from the code. Scanners and reviewers should start from this file; update it when the deployment or design changes.

## Owner priorities (owner)
- Nothing is out of scope and no risk is accepted: every finding matters.
- Most important assets: (1) real contacts never being wrongfully blocked/archived and (2) raw PII never reaching the external LLM.
- No separate infrastructure repository exists.

## scam-detection-jev — local WhatsApp anti-scam bot

**Deployment (owner):** runs on the owner's own machine / Raspberry Pi for one WhatsApp account (an elderly user's). `jevlike_serve.py` is bound to `127.0.0.1` only.

**Attackers that matter:** any WhatsApp sender who can DM the account (fully controls message text, URLs, edits, unicode, `@lid` ids, message volume); a malicious/compromised LLM endpoint returning crafted replies; supply chain (npm/pip/HF model downloads). Local processes on the same host are out of the realistic picture because the worker is localhost-only (owner), but note `JEVLIKE_API_KEY` is empty by default.

**Components**
| Component | Code |
|---|---|
| WA Client | `whatsapp-bot.js`, `lib/filters.js`, `lib/lid.js`, `lib/wa-actions.js`, `lib/action-pacer.js` |
| Decision Pipeline | `lib/handle-incoming.js`, `lib/decide-incoming.js`, `lib/link-rules.js`, `lib/scam-intent.js`, `lib/malicious-hosts.js`, `data/malicious-hosts.json`, `lib/block-policy.js`, `lib/thread-context.js`, `lib/llm-review-cooldown.js` |
| PII Mask Worker | `jevlike_serve.py`, `pii_mask_head.py`, `lib/jevlike-client.js`, `lib/pii-xxx.js` |
| LLM Review | `lib/llm-review.js`, `lib/context-llm.js`, `lib/review-prompt.js`, `lib/review-guide.js` |
| Operator Self-Chat | `lib/operator-mode.js`, `lib/operator-commands.js`, `lib/review-queue.js`, `lib/deliver-review.js`, `lib/apply-review-choice.js`, `lib/action-notice.js`, `lib/self-chat.js` |
| Lab & Tooling | `lab/`, `scripts/`, `stub-jevlike.js`, `test/`, `.github/workflows/` |

**Entry points:** `client.on('message' | 'message_edit')` (any sender); `message_create` (only `fromMe`, operator self-chat); `vote_update` (poll votes — must only be accepted from the operator); worker `POST /v1/mask`, `/v1/score`, `GET /health` on 127.0.0.1:8766; LLM HTTP responses; JSON state files (`operator-mode.json`, `review-queue.json`, `llm-review-cooldown.json`, `blocks.jsonl`).

**Assets:** correct block/archive decisions on real contacts (owner: top); raw message text and PII (names, phones, account numbers) not leaving the machine unmasked (owner: top); the linked WhatsApp session in `.wwebjs_auth/`; LLM API key; operator's self-chat integrity.

**Existing controls (code / AGENTS.md):** saved contacts never auto-blocked; only malicious-host URL match blocks unsaved contacts; models never block; mask-before-LLM with fail-closed on any mask error; per-chat cooldown; serial WhatsApp write queue; invariants enforced by `lib/agent-trust.test.js`, `lib/agents-invariants.test.js`.

**Attack ideas worth checking:** mask bypass / PII leak (unmasked text in prompts, logs, guided explanations, receipts); prompt injection in DMs steering the LLM to archive real contacts or suppress real scams; spoofed votes or self-chat commands from non-operators; `@lid`/saved-contact confusion causing a saved contact to be treated as unsaved; malicious-host suffix matching errors; DoS of the pipeline (regex, large messages, cooldown poisoning).

## Open questions
- Does `vote_update` verify the voter is the operator for every poll type?
