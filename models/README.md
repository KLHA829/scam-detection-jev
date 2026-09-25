# 模型權重（不進 git）

此目錄放 **jevlike 微調頭**（約 2.3 MB）。凍結的 Hugging Face 編碼器 **不會** 放進 git，執行時由 Hub 下載。

This folder holds the **jevlike scorer head** only (~2.3 MB). The frozen encoder is **not** in git; `jevlike_serve.py` downloads it from Hugging Face Hub on first run.

## 已發布的 Release（不用再等上傳）

| | |
|--|--|
| Tag | `jevlike-hf-r1` |
| 頁面 | https://github.com/KLHA829/scam-detection-jev/releases/tag/jevlike-hf-r1 |
| 資產 | `jevlike_hf_chinese_roberta_r1.pt`（約 2.3 MB） |
| 下載 URL | https://github.com/KLHA829/scam-detection-jev/releases/download/jevlike-hf-r1/jevlike_hf_chinese_roberta_r1.pt |

```bash
# 建議用腳本（私有 repo 會自動改走 gh；公開時打下面那條 URL）
scripts/download_jevlike_ckpt.sh

# 或（需已登入 GitHub 的瀏覽器 / 公開 repo）：
# curl -L -o models/jevlike_hf_chinese_roberta_r1.pt \
#   https://github.com/KLHA829/scam-detection-jev/releases/download/jevlike-hf-r1/jevlike_hf_chinese_roberta_r1.pt
```

會放到：

- `models/jevlike_hf_chinese_roberta_r1.pt`（Release 原檔名）
- `models/jevlike_hf_chinese_roberta.pt`（程式預設路徑）

也可以設：

```bash
JEVLIKE_CKPT=/path/to/jevlike_hf_chinese_roberta_r1.pt
```

Worker 也會依序嘗試：

1. `$JEVLIKE_CKPT` / `$JEVLIKE_CHECKPOINT`
2. `models/jevlike_hf_chinese_roberta_r1.pt`（現行 head）
3. `models/jevlike_hf_chinese_roberta.pt`
4. `models/hf_chinese_roberta_hn800.pt`

`models/jevlike_hf_chinese_roberta_hn800.pt` 係**舊 baseline**（tag `jevlike-hf-hn800`，誤封 23.0%）。現行 `r1` head 喺同一個 366 條真 HK 測試集上誤封 9.6%（archive 線）／5.3%（block 線），代價係召回由 0.575 跌到 0.508。

**不要** 把 `hfl/chinese-roberta-wwm-ext` 編碼器（約 400 MB）commit 進 repo。第一次跑 `python jevlike_serve.py` 會寫入 Hugging Face cache（通常 `~/.cache/huggingface/`），Raspberry Pi 上可能要數分鐘。

## 編碼器 / Encoder

| 變數 | 預設 | 說明 |
|------|------|------|
| `JEVLIKE_ENCODER` | `hfl/chinese-roberta-wwm-ext` | 凍結 HF encoder id；須與訓練時一致 |
| `JEVLIKE_DEVICE` | `cpu` | Pi / 沒有 CUDA 的機器用 CPU |

檢查點只含 attention head（`state_dict` + `config`），不含 encoder 權重。
