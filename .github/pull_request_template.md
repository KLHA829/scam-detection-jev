## Summary

<!-- What changed and why? Link the issue if applicable: Closes # -->

## High-Risk Area Check (for fast human review)

Mark `Yes` / `No` (or `[x]` where applicable):

- [ ] **LLM prompts** changed (`lib/context-llm.js`, `lib/llm-review.js`)
- [ ] **Block / archive / contact policy** changed (`lib/block-policy.js`, `lib/decide-incoming.js`, `lib/apply-review-choice.js`, `lib/bot-contact-names.js`)
- [ ] **Legit FPR baseline** changed (`fixtures/legit-fpr-baseline.json`)
- [ ] **Live WhatsApp Web handlers** changed (`whatsapp-bot.js`, `lib/wa-actions.js`) — *not covered by real WhatsApp login in CI*
- [ ] **Malicious hosts** changed (`data/malicious-hosts.json`)

## Verification

- [ ] `npm test`
- [ ] `npm run lint` / `ruff check .`
- [ ] `npm run typecheck`
- [ ] `npm run test:e2e`
- [ ] `verify-scam-bot` drives (list which `bin/drive-*` ran, if any)
- [ ] `node scripts/review-eval.js --mode all --llm dry` (or `--llm live` if prompts/rules changed)

## Notes for Reviewer

<!-- Any edge cases, assumptions, or manual checks needed before merging -->
