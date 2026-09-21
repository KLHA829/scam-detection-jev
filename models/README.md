# 模型權重（不進 git）

此目錄放 **jevlike 微調頭**（約 2.4 MB）。凍結的 Hugging Face 編碼器 **不會** 放進 git，執行時由 Hub 下載。

This folder holds the **jevlike scorer head** only (~2.4 MB). The frozen encoder is **not** in git; `jevlike_serve.py` downloads it from Hugging Face Hub on first run.

## 下載檢查點 / Download the checkpoint

GitHub Release 資產名稱（請保持一致）：

`jevlike_hf_chinese_roberta_hn800.pt`

Release tag：`jevlike-hf-hn800`

```bash
# 需要 gh 已登入（私有 repo），或設定 GH_TOKEN / GITHUB_TOKEN
scripts/download_jevlike_ckpt.sh
```

會放到：

- `models/jevlike_hf_chinese_roberta_hn800.pt`（Release 原檔名）
- `models/jevlike_hf_chinese_roberta.pt`（程式預設路徑）

或手動下載 Release 資產後放到上述其中一個路徑，或設：

```bash
JEVLIKE_CKPT=/path/to/hf_chinese_roberta_hn800.pt
```

Worker 也會依序嘗試：

1. `$JEVLIKE_CKPT` / `$JEVLIKE_CHECKPOINT`
2. `models/jevlike_hf_chinese_roberta.pt`
3. `models/jevlike_hf_chinese_roberta_hn800.pt`
4. `models/hf_chinese_roberta_hn800.pt`

**不要** 把 `hfl/chinese-roberta-wwm-ext` 編碼器（約 400 MB）commit 進 repo。第一次跑 `python jevlike_serve.py` 會寫入 Hugging Face cache（通常 `~/.cache/huggingface/`），Raspberry Pi 上可能要數分鐘。

## 編碼器 / Encoder

| 變數 | 預設 | 說明 |
|------|------|------|
| `JEVLIKE_ENCODER` | `hfl/chinese-roberta-wwm-ext` | 凍結 HF encoder id；須與訓練時一致 |
| `JEVLIKE_DEVICE` | `cpu` | Pi / 沒有 CUDA 的機器用 CPU |

檢查點只含 attention head（`state_dict` + `config`），不含 encoder 權重。

## model_v2 後備

`SCORER=model_v2`（或 `lightjev`）走 **原本 LightJev 0.6B 多維 rubric**，權重仍由 `python lightjev_serve.py` 從 Hub 拉 `rongxinzy/LightJev-0.6B-v0.1`（約 2.4 GB），不放在這個資料夾。
