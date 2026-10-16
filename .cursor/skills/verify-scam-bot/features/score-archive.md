# Score archive

A 1:1 DM whose jevlike score reaches the archive line is archived. The same score, including one at the block line, does not block the contact. A failed score leaves the chat alone.

## Sub-features

- `score-high` labels a stub scam preset as `scam` and archives with reason `jevlike_score`.
- `score-low` labels a benign preset as `not_scam` and does not archive.
- `score-band` uses archive 42 and safe 18 from `scoring-rubric.json`. A score of 25 stays `unknown` and is not an archive by itself.
- `score-no-block` archives an unsaved contact at score 96 and does not call block.
- `score-fail-closed` turns a timeout, HTTP 5xx, or invalid JSON into `unknown` and does not archive.
- `score-jevlike-only` keeps HF jevlike when `SCORER` is `model_v2` or `lightjev`. A low score from a non-`852` number is ignored.

## How to get to it (user POV)

- Live session, after `[OK] WhatsApp client ready`: someone sends a 1:1 chat message. Groups, your own messages, and official WhatsApp chats are ignored before scoring.
- The bot `POST`s `{"text":"..."}` to `{JEVLIKE_BASE_URL}/v1/score` (default `http://127.0.0.1:8766/v1/score`).
- Smoke path: the same POST against the stub from `bin/launch-stub`, plus the `node --test` cases that call `processIncomingMessage` with the in-process stub client.

## Driving it with verify-scam-bot

Preconditions:

- `bin/doctor` prints `worth_driving: yes` for the stub on `http://127.0.0.1:18766` (or the `VERIFY_PORT` you launched).
- `scoring-rubric.json` thresholds are archive 42, safe 18, block 80, and those env overrides are unset.

- **Scripted proof.** Run `.cursor/skills/verify-scam-bot/bin/drive-score-archive`. Exit code `0`. `summary.json` has `"proved": true`. `score-scam.json` has `"model":"stub-jevlike"`, `"label":"scam"`, and `"score"` >= 42. `score-benign.json` has `"label":"not_scam"` and `"score"` <= 18. `node-test.txt` contains `# fail 0` and an `ok` line for every test named below.
- **High score.** `POST /v1/score` body `{"text":"[stub:scam] 請立即轉帳"}`. Response label `scam`, score 96.
- **Low score.** `POST /v1/score` body `{"text":"今晚飲茶？"}`. Response label `not_scam`, score 4.
- **Decision tests.** From the repo root, with the threshold env vars unset:

```bash
node --test --test-reporter tap \
  --test-name-pattern 'archives on score >= T for any sender|labels using archive / safe thresholds|returns stub scam as scam|returns stub benign as not_scam|archives a high score and does not block on the score alone|archives an unsaved high score without blocking|does not archive a failed score that still carries a high number|ignores unknown for unsaved non-local and local unsaved|does not archive unsaved non-local numbers from score-or-heuristic alone|ignores low score for local unsaved and for saved foreign|createScoreClient always builds a JevlikeClient \(SCORER env is ignored\)|archives jevlike_score for a high stub score|archives via callback on high stub score|fails closed on timeout / 5xx / invalid JSON|fails closed on jevlike timeout without archiving|fails closed on jevlike HTTP 5xx without archiving' \
  whatsapp-bot.test.js lib/block-policy.test.js lib/scorer.test.js
```

Exit code `0`. TAP includes `archives an unsaved high score without blocking` as `ok` (action stays `archive`, block callback is not used) and `createScoreClient always builds a JevlikeClient (SCORER env is ignored)` as `ok`.

## Gotchas

- A score at or above 80 archives. It does not block. Auto-block is the malicious-host list only ([malicious-host-block](./malicious-host-block.md)).
- `unknown` from a timeout, 5xx, or invalid JSON does not archive, even when the payload still contains a high number.
- There is no foreign-number archive rule. A clean low score from any country code is ignored. Phone digit extraction lives in `lib/lid.js`.
- `[stub:scam]` changes the stub preset. `jevlike_serve.py` scores the text with the r1 head and ignores the tag.
- Phrase text such as 轉數快 or 驗證碼 does not archive or block by itself. Those cases belong to the score and to the link rule when a short link is also present.
- `drive-score-archive` refuses to run unless doctor sees `model` `stub-jevlike`.
