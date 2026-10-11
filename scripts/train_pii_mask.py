#!/usr/bin/env python3
"""Train a jevlike AttentionHead to mark characters that should become XXX.

The frozen encoder is hfl/chinese-roberta-wwm-ext, the same one the scam
scorer uses. If models/jevlike_hf_chinese_roberta_r1.pt is present, the head
is initialised from those weights and then trained on token-level PII labels.
The scam checkpoint is never overwritten.

    python scripts/train_pii_mask.py --output models/jevlike_hf_pii_mask.pt
"""
from __future__ import annotations

import argparse
import json
import random
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import torch
from torch.nn import functional as F

from jevlike.model import AttentionHead, make_system

from pii_mask_data import char_set, generate_split, gold_spans
from pii_mask_head import (
    KEEP_OPTION,
    MASK_OPTION,
    choose_threshold,
    head_state_from_checkpoint,
    mask_option_logits,
    pool_token_hidden,
)

DEFAULT_ENCODER = "hfl/chinese-roberta-wwm-ext"
R1_PATH = ROOT / "models" / "jevlike_hf_chinese_roberta_r1.pt"


def encode_options(tokenizer, encoder, device):
    encoded = tokenizer(
        [MASK_OPTION, KEEP_OPTION],
        truncation=True,
        max_length=16,
        add_special_tokens=True,
        return_tensors="pt",
        padding=True,
    )
    encoded = {key: value.to(device) for key, value in encoded.items()}
    with torch.no_grad():
        hidden = encoder(
            input_ids=encoded["input_ids"],
            attention_mask=encoded["attention_mask"],
        ).last_hidden_state
        pooled = pool_token_hidden(hidden, encoded["attention_mask"].bool())
    return pooled.detach()


def cache_split(rows, tokenizer, encoder, device, max_length: int):
    texts = [row["text"] for row in rows]
    encoded = tokenizer(
        texts,
        truncation=True,
        max_length=max_length,
        add_special_tokens=True,
        return_offsets_mapping=True,
        return_tensors="pt",
        padding=True,
    )
    offsets = encoded["offset_mapping"].tolist()
    input_ids = encoded["input_ids"]
    attention = encoded["attention_mask"].bool()
    labels = torch.zeros(input_ids.shape, dtype=torch.float32)
    special = torch.zeros(input_ids.shape, dtype=torch.bool)
    for row_index, row in enumerate(rows):
        gold = char_set(row["text"], row["spans"])
        for token_index, (start, end) in enumerate(offsets[row_index]):
            if end <= start or not bool(attention[row_index, token_index]):
                special[row_index, token_index] = True
                continue
            if any(pos in gold for pos in range(start, end)):
                labels[row_index, token_index] = 1.0
    hiddens = []
    encoder.eval()
    with torch.no_grad():
        for start in range(0, input_ids.shape[0], 16):
            stop = start + 16
            hidden = encoder(
                input_ids=input_ids[start:stop].to(device),
                attention_mask=attention[start:stop].to(device).long(),
            ).last_hidden_state
            hiddens.append(hidden.cpu())
    return {
        "hidden": torch.cat(hiddens, dim=0),
        "attention": attention,
        "labels": labels,
        "special": special,
        "offsets": offsets,
        "texts": texts,
        "rows": rows,
    }


def batched_logits(head, hidden, option_hidden, attention, batch_size: int):
    pieces = []
    for start in range(0, hidden.shape[0], batch_size):
        stop = start + batch_size
        logits = mask_option_logits(head, hidden[start:stop], option_hidden)
        pieces.append(logits)
    return torch.cat(pieces, dim=0)


def loss_on(logits, labels, special, attention, pos_weight):
    keep = attention & ~special
    if not bool(keep.any()):
        return logits.sum() * 0.0
    return F.binary_cross_entropy_with_logits(
        logits[keep],
        labels[keep],
        pos_weight=pos_weight,
    )


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, default=ROOT / "models" / "jevlike_hf_pii_mask.pt")
    parser.add_argument("--init", type=Path, default=R1_PATH)
    parser.add_argument("--encoder", default=DEFAULT_ENCODER)
    parser.add_argument("--device", default="cpu")
    parser.add_argument("--epochs", type=int, default=8)
    parser.add_argument("--train-size", type=int, default=480)
    parser.add_argument("--val-size", type=int, default=160)
    parser.add_argument("--max-length", type=int, default=96)
    parser.add_argument("--batch-size", type=int, default=32)
    parser.add_argument("--learning-rate", type=float, default=1e-3)
    parser.add_argument("--seed", type=int, default=17)
    args = parser.parse_args()
    if args.output.resolve() == R1_PATH.resolve():
        raise SystemExit("refusing to overwrite the r1 scam checkpoint")

    random.seed(args.seed)
    torch.manual_seed(args.seed)
    device = torch.device(args.device)
    train_rows = generate_split("train", args.train_size, args.seed)
    val_rows = generate_split("validation", args.val_size, args.seed)

    # Build the encoder through jevlike so the checkpoint config matches the worker.
    init_payload = None
    rank = 32
    encoder_name = args.encoder
    if args.init.is_file():
        init_payload = torch.load(args.init, map_location="cpu", weights_only=True)
        rank = int((init_payload.get("config") or {}).get("rank") or 32)
        encoder_name = (init_payload.get("config") or {}).get("hf_model") or args.encoder
        print(json.dumps({"init": str(args.init), "rank": rank, "encoder": encoder_name}))
    else:
        print(json.dumps({"init": None, "rank": rank, "encoder": encoder_name}))

    config = {
        "encoder": "hf",
        "hf_model": encoder_name,
        "rank": rank,
        "width": rank,
        "context_tokens": args.max_length,
        "option_tokens": 16,
        "task": "pii_mask",
        "mask_option": MASK_OPTION,
        "keep_option": KEEP_OPTION,
    }
    model, collator = make_system(config, device)
    if init_payload is not None:
        model.head.load_state_dict(
            head_state_from_checkpoint(init_payload["state_dict"]),
            strict=True,
        )
    encoder = model.encoder
    encoder.eval()
    for parameter in encoder.parameters():
        parameter.requires_grad_(False)
    tokenizer = collator.tokenizer
    head = model.head
    head.train()

    print("[INFO] caching encoder states", flush=True)
    train_cache = cache_split(train_rows, tokenizer, encoder, device, args.max_length)
    val_cache = cache_split(val_rows, tokenizer, encoder, device, args.max_length)
    option_hidden = encode_options(tokenizer, encoder, device).cpu()

    positive = float(train_cache["labels"][train_cache["attention"] & ~train_cache["special"]].sum())
    kept = int((train_cache["attention"] & ~train_cache["special"]).sum())
    negative = max(1.0, kept - positive)
    pos_weight = torch.tensor(min(20.0, negative / max(1.0, positive)))
    print(json.dumps({"train_rows": len(train_rows), "positive_tokens": positive, "pos_weight": float(pos_weight)}))

    optimiser = torch.optim.AdamW(head.parameters(), lr=args.learning_rate, weight_decay=1e-4)
    best_f1 = -1.0
    best_state = None
    for epoch in range(args.epochs):
        head.train()
        order = torch.randperm(train_cache["hidden"].shape[0])
        total = 0.0
        seen = 0
        for start in range(0, order.numel(), args.batch_size):
            batch_ids = order[start : start + args.batch_size]
            hidden = train_cache["hidden"][batch_ids].to(device)
            logits = mask_option_logits(head, hidden, option_hidden.to(device))
            loss = loss_on(
                logits,
                train_cache["labels"][batch_ids].to(device),
                train_cache["special"][batch_ids].to(device),
                train_cache["attention"][batch_ids].to(device),
                pos_weight.to(device),
            )
            optimiser.zero_grad(set_to_none=True)
            loss.backward()
            torch.nn.utils.clip_grad_norm_(head.parameters(), 1.0)
            optimiser.step()
            total += float(loss.detach()) * int(batch_ids.numel())
            seen += int(batch_ids.numel())
        head.eval()
        with torch.no_grad():
            val_logits = batched_logits(
                head, val_cache["hidden"].to(device), option_hidden.to(device), val_cache["attention"], args.batch_size
            ).cpu()
            val_probs = torch.sigmoid(val_logits).tolist()
        threshold, stats = choose_threshold(val_cache, val_probs)
        print(json.dumps({
            "epoch": epoch + 1,
            "train_bce": total / max(1, seen),
            "val_f1": stats["f1"],
            "val_precision": stats["precision"],
            "val_recall": stats["recall"],
            "extra_recall": stats["extra_recall"],
            "hard_negative_rows_flagged": stats["hard_negative_rows_flagged"],
            "threshold": threshold,
        }))
        if stats["f1"] > best_f1:
            best_f1 = stats["f1"]
            best_state = {key: value.detach().cpu().clone() for key, value in head.state_dict().items()}
            best_stats = dict(stats)

    if best_state is None:
        raise SystemExit("training produced no checkpoint")
    head.load_state_dict(best_state)
    config["mask_threshold"] = best_stats["threshold"]
    config["val_f1"] = best_stats["f1"]
    config["extra_recall"] = best_stats["extra_recall"]
    args.output.parent.mkdir(parents=True, exist_ok=True)
    torch.save(
        {
            "config": config,
            "state_dict": {f"head.{key}": value for key, value in best_state.items()},
        },
        args.output,
    )
    # Sanity: gold helper still agrees with a couple of held-out strings.
    sample = "我名叫蔡子軒，打去九一二三四五六七"
    print(json.dumps({
        "checkpoint": str(args.output),
        "best": best_stats,
        "sample_gold": gold_spans(sample),
        "sample": sample,
    }, ensure_ascii=False))


if __name__ == "__main__":
    main()
