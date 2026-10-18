---
name: verify-scam-detection-jev
description: "Deprecated alias — use verify-scam-bot. Same repo, same offline harness: stub POST /v1/mask, mask→LLM smoke, AGENTS invariants, malicious-host block. This skill only redirects; do not add a second feature map here."
---

# verify-scam-detection-jev (redirect)

**Canonical verification skill:** [verify-scam-bot](../verify-scam-bot/SKILL.md).

This directory name is kept so older agent prompts still resolve. **All** doctor, launch, drive, evidence, and feature recipes live under `.cursor/skills/verify-scam-bot/`. Do not teach live `POST /v1/score` or score-archive as primary smoke here.

## Use these commands (canonical paths)

```bash
.cursor/skills/verify-scam-bot/bin/launch-stub
.cursor/skills/verify-scam-bot/bin/doctor
.cursor/skills/verify-scam-bot/bin/drive-mask-before-llm    # primary smoke
.cursor/skills/verify-scam-bot/bin/drive-agents-invariants
.cursor/skills/verify-scam-bot/bin/drive-malicious-host-block
.cursor/skills/verify-scam-bot/bin/drive-llm-review-cooldown
.cursor/skills/verify-scam-bot/bin/cleanup
```

Lab-only jevlike score: `drive-score-archive` (see `features/lab-jevlike-score.md` in verify-scam-bot).

Feature map: [verify-scam-bot/features/README.md](../verify-scam-bot/features/README.md).

## Compatibility shims

Scripts under **this** skill's `bin/` forward to the same names under `verify-scam-bot/bin/` (exit code preserved). `bin/prove-malicious-host-block` runs launch → doctor → `drive-malicious-host-block` → cleanup using the canonical harness; proof lands under `verify-scam-bot/evidence/`. This alias has **no** local `artifacts/` or evidence directory.

## Maintenance

Encode behavior changes only in **verify-scam-bot** (tests, `features/`, `bin/drive-*`). Update this file only if the redirect text drifts.
