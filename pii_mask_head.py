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
)


def clear_lure_chars(text: str, flags: list[bool]) -> list[bool]:
    """A mask head must not hide the words the later model uses as evidence."""
    for word in LURE_WORDS:
        start = 0
        while True:
            idx = text.find(word, start)
            if idx < 0:
                break
            for offset in range(len(word)):
                pos = idx + offset
                if pos < len(flags) and not text[pos].isdigit():
                    flags[pos] = False
            start = idx + len(word)
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
