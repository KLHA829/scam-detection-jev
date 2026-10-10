"""Synthetic PII spans for the jevlike mask head.

Labels are the identifier rules plus forms those rules miss: 我叫/我名叫,
Chinese-numeral phones, and fullwidth digits. Hard negatives (organisation
tails, role titles, years, bare lure words) stay unlabelled.

Train and validation use different surnames and sentence frames so a memorised
string is not the measurement.
"""
from __future__ import annotations

import random
import re

import jevlike_serve as serve

_CALLED_NAME = re.compile(
    "(?:我名叫|我叫|叫我)"
    "(?!防騙|防骗|反詐|反诈|銀行|银行|警察|公安|官方|協調|协调|客服|職員|职员|新聞|新闻|政府|入境|海關|海关|順豐|顺丰|whatsapp|收數|收数)"
    f"({serve._NAME_TOKEN})"
)
_CN_DIGITS = "零一二三四五六七八九〇"
_CN_PHONE = re.compile(
    rf"(?:電話|电话|打去|打俾|whatsapp|wa|號碼|号码)[^\n]{{0,6}}([{_CN_DIGITS}]{{8,11}})"
)
_FW_PHONE = re.compile(r"(?<![0-9０-９])[４５６７９][０-９]{7}(?![0-9０-９])")

_TRAIN_SURNAMES = list("陳李黃張劉周吳鄭王何梁馬羅") + ["歐陽"]
_TEST_SURNAMES = list("蔡楊許謝郭洪曾邱廖")
_TRAIN_GIVEN = ("大文", "小明", "嘉怡", "志強", "美玲", "家輝")
_TEST_GIVEN = ("子軒", "曉彤", "詠詩", "凱晴")
_CN_MAP = str.maketrans("0123456789", "零一二三四五六七八九")
_FW_MAP = str.maketrans("0123456789", "０１２３４５６７８９")

_HARD_NEGATIVES = (
    "我係收數公司，你筆數要還",
    "如非本人操作，請即聯絡銀行",
    "我係張經理，下晝三點開會",
    "今晚2026年見，唔好遲到",
    "小心詐騙，唔好將驗證碼話俾人聽",
    "呢單係新聞，講轉帳要小心",
    "朋友話轉數快比我飯錢，唔使急",
    "我係防騙協調中心提醒你",
    "驗證碼過期就要重新申請",
    "五十蚊就得，唔使五百",
)


def extra_gold_spans(text: str) -> list[dict]:
    spans = []
    for match in _CALLED_NAME.finditer(text):
        name = match.group(1) or ""
        if not name:
            continue
        start = match.start(1)
        spans.append({"start": start, "end": start + len(name), "label": "name"})
    for pattern, label in ((_CN_PHONE, "phone"), (_FW_PHONE, "phone")):
        for match in pattern.finditer(text):
            group = 1 if match.lastindex else 0
            spans.append(
                {
                    "start": match.start(group),
                    "end": match.end(group),
                    "label": label,
                }
            )
    return spans


def gold_spans(text: str) -> list[dict]:
    body = "" if text is None else str(text)
    return serve.merge_mask_spans(serve.find_mask_spans(body) + extra_gold_spans(body))


def _local_phone(rng: random.Random) -> str:
    return rng.choice("45679") + "".join(rng.choice("0123456789") for _ in range(7))


def _intl_phone(rng: random.Random) -> str:
    local = _local_phone(rng)
    style = rng.randrange(3)
    if style == 0:
        return f"+852 {local[:4]} {local[4:]}"
    if style == 1:
        return f"852-{local[:4]}-{local[4:]}"
    return local


def _name(rng: random.Random, surnames: list[str], givens: tuple[str, ...]) -> str:
    return rng.choice(surnames) + rng.choice(givens)


def _fill(rng: random.Random, frame: str, surnames: list[str], givens: tuple[str, ...]) -> str:
    phone = _intl_phone(rng)
    name = _name(rng, surnames, givens)
    otp = "".join(rng.choice("0123456789") for _ in range(6))
    email = f"user{rng.randrange(1000, 9999)}@example.com"
    hkid = f"{rng.choice('ABCDEFGHZ')}{rng.randrange(100000, 999999)}({rng.choice('0123456789A')})"
    account = f"{rng.randrange(100, 999)}-{rng.randrange(100000, 999999)}"
    cn_phone = _local_phone(rng).translate(_CN_MAP)
    fw_phone = _local_phone(rng).translate(_FW_MAP)
    return frame.format(
        name=name,
        phone=phone,
        otp=otp,
        email=email,
        hkid=hkid,
        account=account,
        cn_phone=cn_phone,
        fw_phone=fw_phone,
    )


_TRAIN_FRAMES = (
    "你好，我係{name}，電話{phone}",
    "我叫{name}，方便打俾我嗎",
    "驗證碼 {otp} 請你收好",
    "電郵 {email} 回覆我",
    "身份證 {hkid} 影一張",
    "轉數快 {account} 今日過數",
    "我號碼係{cn_phone}，儘快打",
    "全形電話{fw_phone}係我",
    "我係{name}，驗證碼{otp}，電話{phone}",
)
_TEST_FRAMES = (
    "本人{name}，請打{phone}找我",
    "我名叫{name}，之後聯絡",
    "你的驗證碼是{otp}，勿外傳",
    "回信到 {email} 就得",
    "證件號 {hkid} 核對一下",
    "戶口 {account} 係收款",
    "打去{cn_phone}就可以",
    "備用號碼{fw_phone}留低",
    "叫我{name}，代碼 {otp}",
)


def generate_split(split: str, count: int, seed: int) -> list[dict]:
    rng = random.Random(seed + (0 if split == "train" else 10007))
    surnames = _TRAIN_SURNAMES if split == "train" else _TEST_SURNAMES
    givens = _TRAIN_GIVEN if split == "train" else _TEST_GIVEN
    frames = _TRAIN_FRAMES if split == "train" else _TEST_FRAMES
    rows = []
    for _ in range(count):
        text = _fill(rng, rng.choice(frames), surnames, givens)
        rows.append({"text": text, "spans": gold_spans(text), "hard_negative": False})
    negatives = _HARD_NEGATIVES[:5] if split == "train" else _HARD_NEGATIVES[5:]
    for text in negatives:
        rows.append({"text": text, "spans": gold_spans(text), "hard_negative": True})
    rng.shuffle(rows)
    return rows
