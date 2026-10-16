# In-repo jevlike evaluation fixtures

These corpora replace the old **366-row private HK WhatsApp export** (`../jevlike-lab` `real_test`) that could not be vendored into this repo. Metrics in README / AGENTS / models docs should be **re-measured** with the commands below, not copied from unreproducible lab artifacts.

## Corpora

| Path | Rows | Balance | Provenance |
|------|------|---------|------------|
| `hk50/hk50_real_eval.jsonl` | 50 | 25 scam / 25 not_scam | Reconstructed from publicly reported HK scam patterns (police / ADCC / news) and public Cantonese everyday chat. **Not** private WhatsApp exports. See `hk50/hk50_real_eval.meta.json`. |
| `data_v2/test.jsonl` | 270 | mixed | Held-out **test** split from the v2 labelled set (synthetic variants, hard negatives, adapted public texts). See `data_v2/stats.json` for counts and sources. |

Schema (both JSONL): one object per line with at least `id`, `text`, `label` (`scam` | `not_scam`). `data_v2` rows may include `lang`, `trope`, `source`, `region`, `axes`.

## Re-run metrics (r1 head)

1. Download the published head: `scripts/download_jevlike_ckpt.sh`
2. Python env with CPU torch + `requirements.txt` (see root README)
3. Run:

```bash
npm run eval:hk
```

This scores every row with the **jevlike-hf-r1** head (`models/jevlike_hf_chinese_roberta_r1.pt`) using the same archive/block/safe thresholds as `scoring-rubric.json`.

Optional:

```bash
npm run eval:hk -- --json
npm run eval:hk -- --write-baseline evals/baselines/r1-hk50-data_v2-test.json
```

Alternatively, point at a running worker (no in-process torch):

```bash
export JEVLIKE_BASE_URL=http://127.0.0.1:8766
npm run eval:hk
```

### What the numbers mean

- **Archive line** (default score ≥ 42): precision, recall, FP/FN — matches what the bot uses to **archive**.
- **Block line** (default score ≥ 80): same counts, **documentation only**. After link-rule hardening, the bot does **not** auto-block on score alone; unsaved block is link rule or explicit context-model `block`.

## Baselines

`baselines/r1-hk50-data_v2-test.json` is a frozen report from a full local run (torch + checkpoint). CI validates fixture schema and that this file parses; it does **not** re-download torch or re-score in GitHub Actions.

## Historical 366-row set

Release notes for tag `jevlike-hf-r1` may still mention a one-off 366-message real HK evaluation (179 scam / 187 innocent). That JSON is **not** in this repository and is not the reproducible bar anymore.
