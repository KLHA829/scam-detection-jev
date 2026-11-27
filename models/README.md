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

Worker 載入順序：

1. `$JEVLIKE_CKPT` / `$JEVLIKE_CHECKPOINT`（若已設；檔案不存在會直接報錯）
2. 否則只載入 `models/jevlike_hf_chinese_roberta_r1.pt`（現行 head）；缺檔會報錯，**不會**自動改用舊 head

`models/jevlike_hf_chinese_roberta_hn800.pt` 係**舊 baseline**（tag `jevlike-hf-hn800`，誤封 23.0%），須以 `JEVLIKE_CKPT` 明確指定才會載入。現行 `r1` head 喺同一個 366 條真 HK 測試集上誤封 9.6%（archive 線）／5.3%（block 線），代價係召回由 0.575 跌到 0.508。

## 已發布的 PII mask Release

| | |
|--|--|
| Tag | `jevlike-pii-mask-hn2` |
| 頁面 | https://github.com/KLHA829/scam-detection-jev/releases/tag/jevlike-pii-mask-hn2 |
| 資產 | `jevlike_hf_pii_mask_hn2.pt`（約 2.3 MB） |
| SHA-256 | `55a52625d328f58e5aa227039b31f83308f8a5e2b233ca61ad7de614a8a9a5fa` |

```bash
scripts/download_pii_mask_ckpt.sh
```

預設寫入 `models/jevlike_hf_pii_mask.pt`；設咗 `JEVLIKE_MASK_CKPT` 就寫去嗰個路徑（相對路徑由 repo root 計）。腳本會核對 SHA-256。`JEVLIKE_CKPT_FORCE=1` 可以強制重下載。

`hn2` 喺 `fixtures/pii-mask-eval.json`（85 案）嘅固定評估：precision 0.9805、recall 1.0000、F1 0.9901；67/67 個 secret 全遮，36/36 條 hard-negative 冇誤遮。

**不要** 把 `hfl/chinese-roberta-wwm-ext` 編碼器（約 400 MB）commit 進 repo。第一次跑 `python jevlike_serve.py` 會寫入 Hugging Face cache（通常 `~/.cache/huggingface/`），Raspberry Pi 上可能要數分鐘。

## 編碼器 / Encoder

| 變數 | 預設 | 說明 |
|------|------|------|
| `JEVLIKE_ENCODER` | `hfl/chinese-roberta-wwm-ext` | 凍結 HF encoder id；須與訓練時一致 |
| `JEVLIKE_DEVICE` | `cpu` | Pi / 沒有 CUDA 的機器用 CPU |

檢查點只含 attention head（`state_dict` + `config`），不含 encoder 權重。

## 脫敏頭 / PII mask head

`POST /v1/mask` 只用 `models/jevlike_hf_pii_mask.pt`（或 `JEVLIKE_MASK_CKPT`）呢個 jevlike `AttentionHead`。頭未載入就回 503，bot 唔會把原文送出去。呢個檔唔會取代 `r1` 評分頭。識別字規則只係訓練標註同離線 stub，唔會再同頭的結果合併。

下載已發佈 checkpoint（建議）：

```bash
scripts/download_pii_mask_ckpt.sh
```

或者自行訓練（CPU 得，會下載編碼器一次）：

```bash
python scripts/train_pii_mask.py --output models/jevlike_hf_pii_mask.pt
```

有 `r1` 檔時，頭的初始權重從 `r1` 抄出再練（rank 256，同一個凍結編碼器）。輸出唔會覆蓋 `jevlike_hf_chinese_roberta_r1.pt`。標註係合成句子：規則已識嘅電話／戶口，加上規則漏咗嘅「我叫」、中文數字電話、地址、出生日期、護照、到期日/CVV 同社交帳號。負例包括機構名、職銜、年份、淨係講「驗證碼」嘅句子、日常廣東話用字（例如屋企人、政府）、訂單/參考編號、日期、金額、禮貌句同英文 privacy warning。fixture 亦覆蓋 emoji、繁簡/中英混寫、line breaks、全半形、zero-width/Unicode digit 電話、長訊息 chunk boundary，以及地址大廈名同信用卡 CVV 邊界。

固定評估（需要已下載 encoder 同 mask checkpoint）：

```bash
.venv/bin/python scripts/eval_pii_mask.py \
  --checkpoint models/jevlike_hf_pii_mask.pt \
  --output /tmp/pii-mask-eval.json
```

評估 fixture 喺 `fixtures/pii-mask-eval.json`，覆蓋電話、姓名、OTP、證件、戶口、URL secret、地址、生日、護照、CVV、社交帳號、長訊息，同埋唔應該遮嘅日常句子。呢個唔係 366 則真實香港對話嘅數字。運行時唔再用規則補遮。模型標中「驗證碼」「小心」、FPS/PayMe/WhatsApp 呢類證據詞會被抹走，避免大模型睇唔到騙案字眼。權重檔已 gitignore，唔會進 repo。
