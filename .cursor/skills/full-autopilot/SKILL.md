---
name: full-autopilot
description: "Full Autopilot (poteto 無人盯內環): goal → split → self-prove with verify-scam-bot → open PR. Use for autonomous agent loops on this repo. Does not reopen settled product decisions (mask→LLM live path, lab-only jevlike score, malicious-host-only auto-block)."
---

# Full Autopilot (無人盯內環)

Short loop for cloud or local agents working on **scam-detection-jev**. Verification and gardener encoding live in [verify-scam-bot](../verify-scam-bot/SKILL.md); this file is only the **outer** loop.

## Loop

1. **Receive goal** — One outcome and explicit success criteria (tests green, a drive proves, a doc section updated, etc.).
2. **Split into verifiable units** — Each unit must have a prove command: `npm test`, a named `bin/drive-*`, or a feature-file `node --test` recipe.
3. **Self-prove before claiming done** — Use [verify-scam-bot](../verify-scam-bot/SKILL.md):
   - `bin/doctor` when stub HTTP is involved (`worth_driving: yes`).
   - Relevant `bin/drive-*` for the area (live-path work: **`drive-mask-before-llm`** as primary smoke; invariants: `drive-agents-invariants`; block policy: `drive-malicious-host-block`; cooldown: `drive-llm-review-cooldown`; lab score only: `drive-score-archive`).
   - `npm test` (and CI-equivalent `node scripts/review-eval.js --llm dry --mode all` when touching LLM fixtures).
4. **Open a PR** — Never merge unless a human explicitly asked to merge.
5. **Swarm when units are independent** — Parallel agents or subtasks are fine; **each** unit still self-proves before the batch is “done.”
6. **Human contact** — Do not ask humans for reversible mid-loop steps (branch, commit, run tests, open draft PR). **Stop and ask** only for product tradeoffs, secrets, live WhatsApp QR sessions, deleting operator data, or changes to block/archive invariants in AGENTS.md.

## Settled product (do not reopen)

- Live inbound: link heuristics → **mask (`POST /v1/mask`) → primary LLM**; no live jevlike `/v1/score` on inbound.
- **Auto-block** only unsaved contacts on **`data/malicious-hosts.json`**; lookalike and soliciting short links require masked AI confirmation to archive; saved contacts are never auto-blocked.
- No model_v2 / LightJev / foreign-number hard-archive paths; phrase tropes alone do not archive or block.

Encode fixes via tests and verify drivers — see the Gardener checklist in verify-scam-bot.

## PR #51 / agent-trust locks (CI)

`lib/agent-trust.test.js` enforces verification and live-path docs. Do not weaken these:

| Lock | Meaning |
|---|---|
| Mask before primary LLM | `maskMessages` runs before `reviewRedactedMessage` / context LLM chat API; no `lab/score-message` on live inbound. |
| `createMaskClient` / `maskClient` | Live path uses mask client naming; no `scoreClient` in `handle-incoming` or `whatsapp-bot.js`. |
| Verify smoke is mask-primary | Canonical skill primary drive is **`drive-mask-before-llm`**; `drive-score-archive` is **lab-only**. |
| Dual-skill alias | `.cursor/skills/verify-scam-detection-jev/` is redirect + `bin/` shims only — **no** second feature map or score-primary smoke docs. |

## Where to drive

All doctor, launch, drive, evidence, and `features/` recipes:

`.cursor/skills/verify-scam-bot/`

Deprecated name alias (same commands): `.cursor/skills/verify-scam-detection-jev/`.

Human manifesto: [AGENTS.md](../../../AGENTS.md) (invariants + gardener note).
