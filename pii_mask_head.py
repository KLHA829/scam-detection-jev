"""Token-level PII head on top of a frozen jevlike encoder.

The stock jevlike loss picks one option for a whole message. Desensitisation
needs a yes/no on each token. This module trains and runs the same
AttentionHead, but the supervision is the mask option's score on every
context token, not a single scam/not-scam label.

The r1 scam checkpoint is only an initialisation. Training writes a separate
file and does not replace the scorer.
"""
from __future__ import annotations

import math

MASK_OPTION = "個人資料要遮"
KEEP_OPTION = "普通用字留低"
LURE_WORDS = (
    "驗證碼",
    "验证码",
    "轉帳",
    "转账",
    "轉賬",
    "密碼",
    "密码",
    "防騙",
    "防骗",
    "小心",
    "新聞",
    "新闻",
    "轉數快",
    "转数快",
    "FPS",
    "fps",
    "PayMe",
    "payme",
    "WhatsApp",
    "whatsapp",
    "OTP",
    "otp",
    "code",
    "CODE",
)


_LURE_STOP_BEFORE = set(",，。:：;；!！?？()（）\"'「」『』")
_NAME_PREFIX_CHARS = set(
    "陳李黃張劉周吳鄭王何梁馬羅蔡楊許謝郭洪曾邱廖賴徐朱葉沈韓馮鄧曹彭鍾蔣蕭潘譚汪陸蘇盧唐孫魏方石余姚戴宋范杜丁傅江夏高林胡袁于董程呂阮莊簡連康雷畢翁游伍古屈甄聶湯岑霍龍莫嚴龔區丘韋麥尹駱黎尤陽馬官葛狐甫容徒轅阿abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._+-"
)


def _enclosing_flagged_span(flags: list[bool], idx: int, end: int) -> tuple[int, int]:
    run_start = idx
    while run_start > 0 and flags[run_start - 1]:
        run_start -= 1
    run_end = end
    while run_end < len(flags) and flags[run_end]:
        run_end += 1
    return run_start, run_end


def clear_lure_chars(text: str, flags: list[bool]) -> list[bool]:
    """A mask head must not hide the words the later model uses as evidence,
    nor unmask lure substrings embedded inside a flagged PII entity (name/email/URL).
    """
    for word in LURE_WORDS:
        start = 0
        while True:
            idx = text.find(word, start)
            if idx < 0:
                break
            end = idx + len(word)
            run_start, run_end = _enclosing_flagged_span(flags, idx, end)
            span_slice = text[run_start:run_end]
            inside_url_or_email = "@" in span_slice or "/" in span_slice
            preceded_by_name_char = (
                idx > 0
                and flags[idx - 1]
                and (
                    text[idx - 1] in _NAME_PREFIX_CHARS
                    or (
                        idx >= 2
                        and flags[idx - 2]
                        and text[idx - 2] in _NAME_PREFIX_CHARS
                        and not text[idx - 1].isspace()
                        and not text[idx - 1].isdigit()
                        and text[idx - 1] not in _LURE_STOP_BEFORE
                    )
                )
            )
            if not inside_url_or_email and not preceded_by_name_char:
                for pos in range(idx, end):
                    if pos < len(flags) and not text[pos].isdigit():
                        flags[pos] = False
            start = end
    return flags


def spans_from_flags(text: str, flags: list[bool], label: str = "model") -> list[dict]:
    spans = []
    index = 0
    length = len(text)
    while index < length:
        if index < len(flags) and flags[index] and not text[index].isspace():
            end = index + 1
            while end < length and end < len(flags) and flags[end]:
                end += 1
            stop = end
            while stop > index and text[stop - 1].isspace():
                stop -= 1
            if stop > index:
                spans.append({"start": index, "end": stop, "label": label})
            index = end
        else:
            index += 1
    return spans


def flags_from_offsets(text: str, offsets, probs, threshold: float) -> list[bool]:
    flags = [False] * len(text)
    for span, prob in zip(offsets, probs):
        if prob < threshold:
            continue
        start, end = int(span[0]), int(span[1])
        if end <= start:
            continue
        for pos in range(max(0, start), min(len(text), end)):
            flags[pos] = True
    clear_lure_chars(text, flags)
    return flags


def flags_from_window_offsets(
    text: str,
    window_offsets,
    window_probs,
    threshold: float,
) -> list[bool]:
    """Combine overlapping window token probabilities by union (any window flagging masks the character)."""
    flat_offsets = [span for win in window_offsets for span in win]
    flat_probs = [prob for win in window_probs for prob in win]
    return flags_from_offsets(text, flat_offsets, flat_probs, threshold)


def mask_option_logits(head, context_hidden, option_hidden, mask_index: int = 0):
    """Pre-softmax score of the mask option at each context token.

    context_hidden: [batch, length, hidden]
    option_hidden: [options, hidden] or [batch, options, hidden]
    """
    import torch

    if option_hidden.dim() == 2:
        option_hidden = option_hidden.unsqueeze(0).expand(context_hidden.shape[0], -1, -1)
    context = head.context_norm(context_hidden.float())
    options = head.option_norm(option_hidden.float())
    query = head.query(options)
    key = head.key(context)
    scores = torch.einsum("bnr,blr->bnl", query, key) / math.sqrt(head.rank)
    return scores[:, mask_index, :]


def pool_token_hidden(hidden, mask):
    """Same mean pool as jevlike FrozenTransformerScorer."""
    weights = mask.unsqueeze(-1).to(hidden.dtype)
    return (hidden * weights).sum(1) / weights.sum(1).clamp_min(1)


def predict_spans(text, offsets, probs, threshold: float) -> list[dict]:
    flags = flags_from_offsets(text, offsets, probs, threshold)
    return spans_from_flags(text, flags)


def score_threshold(cache, probs, threshold: float) -> dict:
    from pii_mask_data import char_set, extra_gold_spans, prf

    gold_all: set[tuple[int, int]] = set()
    pred_all: set[tuple[int, int]] = set()
    hard_fp_rows = 0
    extra_gold: set[tuple[int, int]] = set()
    extra_hit: set[tuple[int, int]] = set()
    for index, row in enumerate(cache["rows"]):
        text = row["text"]
        gold = char_set(text, row["spans"])
        pred_spans = predict_spans(text, cache["offsets"][index], probs[index], threshold)
        pred = char_set(text, pred_spans)
        for pos in gold:
            gold_all.add((index, pos))
        for pos in pred:
            pred_all.add((index, pos))
        if row["hard_negative"] and pred:
            hard_fp_rows += 1
        extra = char_set(text, extra_gold_spans(text))
        for pos in extra:
            extra_gold.add((index, pos))
            if pos in pred:
                extra_hit.add((index, pos))
    stats = prf(gold_all, pred_all)
    stats["hard_negative_rows_flagged"] = hard_fp_rows
    stats["extra_recall"] = len(extra_hit) / len(extra_gold) if extra_gold else 1.0
    return stats


def choose_threshold(cache, probs) -> tuple[float, dict]:
    best = None
    best_threshold = 0.5
    best_key = None
    for step in range(20, 95, 5):
        threshold = step / 100
        stats = score_threshold(cache, probs, threshold)
        # Character F1 already charges false-masked hard-negative characters as FP.
        # Prefer recall/privacy balance over a degenerate checkpoint that merely keeps
        # every hard-negative row untouched; use row flags only as a tie-breaker.
        key = (stats["f1"], -stats["hard_negative_rows_flagged"], threshold)
        if best_key is None or key > best_key:
            best_key = key
            best = stats
            best_threshold = threshold
    if best is None:
        best_threshold = 0.9
        best = score_threshold(cache, probs, best_threshold)
    best["threshold"] = best_threshold
    return best_threshold, best


def head_state_from_checkpoint(state: dict) -> dict:
    """Keep AttentionHead weights whether they are stored as head.* or bare."""
    filtered = {}
    for key, value in state.items():
        if key.startswith("encoder."):
            continue
        if key.startswith("head."):
            filtered[key[len("head.") :]] = value
        elif key.split(".", 1)[0] in {"context_norm", "option_norm", "query", "key", "value"}:
            filtered[key] = value
    if not filtered:
        raise ValueError("checkpoint has no AttentionHead weights")
    return filtered
