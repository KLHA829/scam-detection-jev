"""Synthetic PII spans for the jevlike mask head.

Labels are the identifier rules plus forms those rules miss: 我叫/我名叫,
Chinese-numeral phones, fullwidth digits, addresses, birthdates, passports,
card expiry/CVV pairs, social handles, and zero-width/Unicode-digit phones. Hard negatives (organisation tails,
role titles, years, bare lure words, common Cantonese words, order/reference
numbers, dates, and amounts) stay unlabelled.

Train and validation use different surnames and sentence frames so a memorised
string is not the measurement.
"""
from __future__ import annotations

import random
import re
import unicodedata

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
_ADDRESS = re.compile(r"((?:(?:香港|九龍|新界)?[\u4e00-\u9fff]{2,8}(?:道|街|路))[0-9]{1,4}號(?:[\u4e00-\u9fff]{1,8}(?:大廈|中心|樓|閣))?(?:[0-9]{1,2}樓)?[A-Z]?室?)")
_ISO_BIRTHDATE = re.compile(r"(?:生日|出生日期)(?:係)?\s*((?:19|20)[0-9]{2}-[0-9]{2}-[0-9]{2})")
_CARD_CVV = re.compile(r"((?:信用卡|扣帳卡|扣账卡)\s*(?:CVV|安全碼)\s*[:：]?\s*[0-9]{3,4})", re.I)
_ZERO_WIDTH = "\u200b\u200c\u200d\ufeff"
_BIRTHDATE = re.compile(r"((?:19|20)[0-9]{2}年[0-9]{1,2}月[0-9]{1,2}日)(?=出生)")
_BIRTHDAY_AFTER = re.compile(r"生日係\s*((?:19|20)[0-9]{2}年[0-9]{1,2}月[0-9]{1,2}日)")
_PASSPORT = re.compile(r"(?:護照(?:號碼)?|passport)\s*[:：#]?\s*([A-Z][0-9]{7,8})", re.I)
_CVV = re.compile(r"(?:CVV|安全碼)\s*[:：]?\s*([0-9]{3,4})", re.I)
_EXPIRY = re.compile(r"(?:到期日|expiry(?:\s*date)?)\s*[:：]?\s*((?:0[1-9]|1[0-2])/[0-9]{2,4})", re.I)
_SOCIAL_HANDLE = re.compile(r"(?<![A-Za-z0-9._%+-])(@[A-Za-z0-9_]{4,32})")

_TRAIN_SURNAMES = list("陳李黃張劉周吳鄭王何梁馬羅歐")
_TEST_SURNAMES = list("蔡楊許謝郭洪曾邱廖司")
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
    "講天氣講食飯講屋企人",
    "屋企人話唔使急",
    "講健康講政府新措施",
    "政府新措施出咗",
    "多謝你，好多事情都順利",
    "許多朋友都話曾經見過",
    "我而家好緊張，因為聽日考試",
    "方法簡單，連埋古董都賣咗",
    "夏天去游水，之後飲湯",
    "馬路旁邊森林好靜",
    "地區官網有新聞，唔係叫你俾驗證碼",
    "我部電話壞咗，遲啲先打",
    "電話號碼之後先話你知",
    "佢叫我小心啲，唔好亂俾驗證碼人",
    "多謝你，唔該晒，收到",
    "生日快樂，今日開心啲",
    "用信用卡買嘢有積分，唔使急",
    "地址證明之後先交",
    "護照過期要續期",
)


_HARD_NEGATIVE_FRAMES = (
    "講天氣講食飯講屋企人講新聞講股票",
    "講健康講政府新措施，之後講旅行",
    "屋企人話唔使急，慢慢嚟",
    "訂單編號 {order}，{month}月{day}日送到",
    "訂單編號 {order} 已經出貨",
    "參考編號 {order} 三月後到期",
    "預約編號 {order} 已經確認",
    "單號 {order} 聽日送到",
    "order number {order} confirmed",
    "reference {order} expires next month",
    "金額 {amount} 蚊已經俾咗",
    "今年係{year}年，{month}月{day}日放假",
    "會議係{year}年{month}月{day}日",
    "下晝{hour}點{minute}分開會",
    "而家{hour}點{minute}分，準備食飯",
    "周末去行山買餸，夜晚睇電影",
    "馬路旁邊森林好靜，適合散步",
    "我而家好緊張，因為聽日考試",
    "多謝你，許多事情都順利",
    "曾經講過健康最重要",
    "方法簡單，連埋古董都賣咗",
    "夏天去游水，之後飲湯",
    "地區官網有新聞，唔係叫你俾驗證碼",
    "電話號碼之後先話你知",
    "我部電話壞咗，遲啲先打",
    "whatsapp 我遲啲覆你",
    "Your OTP code is not needed here",
    "Please call me tomorrow",
    "Your OTP code is private, never share it",
    "Do not share it with anyone",
    "Keep it private, please",
    "HKID copy can wait until tomorrow",
    "passport control opens at {hour}",
    "IG is down today",
    "小心诈骗，不要把验证码告诉别人",
    "😀 屋企人話唔使急 😀",
    "全形金額５０００蚊",
    "講天氣講食飯講屋企人講天氣講食飯講屋企人講天氣講食飯講屋企人講健康講政府新措施",
    "屋企人話唔使急",
    "用信用卡買嘢有積分，唔使急",
    "唔該晒，收到",
    "得閒嚟坐",
    "搬咗啲嘢入屋，得閒嚟坐",
    "影低啲重點，唔使急",
)


def extra_gold_spans(text: str) -> list[dict]:
    spans = []
    for match in _CALLED_NAME.finditer(text):
        name = match.group(1) or ""
        if not name:
            continue
        start = match.start(1)
        spans.append({"start": start, "end": start + len(name), "label": "name"})
    for pattern, label in (
        (_CN_PHONE, "phone"),
        (_FW_PHONE, "phone"),
        (_ADDRESS, "address"),
        (_BIRTHDATE, "birthdate"),
        (_BIRTHDAY_AFTER, "birthdate"),
        (_ISO_BIRTHDATE, "birthdate"),
        (_CARD_CVV, "card_cvv"),
        (_PASSPORT, "passport"),
        (_CVV, "cvv"),
        (_EXPIRY, "expiry"),
        (_SOCIAL_HANDLE, "social"),
    ):
        for match in pattern.finditer(text):
            group = 1 if match.lastindex else 0
            spans.append(
                {
                    "start": match.start(group),
                    "end": match.end(group),
                    "label": label,
                }
            )
    spans.extend(_normalized_phone_spans(text))
    return serve._drop_order_reference_spans(text, spans)


def _normalized_phone_spans(text: str) -> list[dict]:
    """Label HK phones split by zero-width characters or written with Unicode digits.

    This is training-label normalization only; the live mask still learns from
    the original text and never rewrites it.
    """
    normalized = []
    owners = []
    for index, char in enumerate(text):
        if char in _ZERO_WIDTH:
            continue
        folded = unicodedata.normalize("NFKC", char)
        for out in folded:
            normalized.append(out)
            owners.append(index)
    body = "".join(normalized)
    patterns = (
        re.compile(r"(?:\+|00)?852[\s-]*[45679][0-9]{3}[\s-]?[0-9]{4}(?![0-9])"),
        re.compile(r"(?<![0-9])[45679][0-9]{3}[\s-]?[0-9]{4}(?![0-9])"),
    )
    spans = []
    for pattern in patterns:
        for match in pattern.finditer(body):
            if match.end() <= match.start():
                continue
            start = owners[match.start()]
            end = owners[match.end() - 1] + 1
            spans.append({"start": start, "end": end, "label": "phone"})
    return spans


def char_set(text: str, spans: list[dict]) -> set[int]:
    """Character indexes a span list covers, skipping whitespace."""
    chosen: set[int] = set()
    body = "" if text is None else str(text)
    for span in spans:
        chosen.update(range(int(span["start"]), int(span["end"])))
    return {index for index in chosen if index < len(body) and not body[index].isspace()}


def prf(gold: set[int], pred: set[int]) -> dict[str, float]:
    tp = len(gold & pred)
    fp = len(pred - gold)
    fn = len(gold - pred)
    precision = tp / (tp + fp) if tp + fp else 1.0
    recall = tp / (tp + fn) if tp + fn else 1.0
    f1 = 2 * precision * recall / (precision + recall) if precision + recall else 0.0
    return {"precision": precision, "recall": recall, "f1": f1, "tp": tp, "fp": fp, "fn": fn}


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
    surname = rng.choice(surnames)
    if surname == "歐":
        surname = "歐陽"
    elif surname == "司":
        surname = "司馬"
    return surname + rng.choice(givens)


def _fill(rng: random.Random, frame: str, surnames: list[str], givens: tuple[str, ...]) -> str:
    phone = _intl_phone(rng)
    name = _name(rng, surnames, givens)
    nick = f"阿{rng.choice(('明', '強', '珍', '輝', '玲', '文'))}"
    otp = "".join(rng.choice("0123456789") for _ in range(6))
    email_style = rng.randrange(4)
    if email_style == 0:
        email = f"user{rng.randrange(1000, 9999)}@example.com"
    elif email_style == 1:
        email = f"test{rng.randrange(100, 999)}@gmail.com"
    elif email_style == 2:
        email = f"{rng.choice(('chan', 'wong', 'lee', 'lau'))}.{rng.choice(('kwok', 'cheung', 'lau', 'ng'))}+test@example.com"
    else:
        email = f"{rng.choice(('contact', 'info', 'hello'))}{rng.randrange(10, 99)}@{rng.choice(('example.com', 'mail.test'))}"
    hkid = f"{rng.choice('ABCDEFGHZ')}{rng.randrange(100000, 999999)}({rng.choice('0123456789A')})"
    id18 = f"44030119{rng.randrange(70, 99)}{rng.randrange(10, 12)}{rng.randrange(10, 28)}{rng.randrange(1000, 9999)}"
    account = f"{rng.randrange(100, 999)}-{rng.randrange(100000, 999999)}"
    long_acct = "".join(rng.choice("0123456789") for _ in range(16))
    payme_handle = f"payme.hsbc/u{rng.randrange(1000, 9999)}abc"
    fps_handle = f"FPS ID: HK{rng.randrange(100000, 999999)}"
    url_path = f"https://example{rng.randrange(10, 99)}.test/login?token=secret{rng.randrange(1000, 9999)}"
    url_user = f"https://user{rng.randrange(100, 999)}@example{rng.randrange(10, 99)}.test/home"
    short_url = f"https://bit.ly/ref{rng.randrange(1000, 9999)}"
    url_verify = f"https://secure-login-example.test/verify?session=abcd{rng.randrange(1000, 9999)}"
    cn_phone = _local_phone(rng).translate(_CN_MAP)
    fw_phone = _local_phone(rng).translate(_FW_MAP)
    district = rng.choice(("香港", "九龍", "新界"))
    street = rng.choice(("彌敦道", "皇后大道", "青山道", "英皇道", "德輔道"))
    building = rng.choice(("", "示範大廈", "美麗大廈", "幸福中心", "安康樓"))
    address = f"{district}{street}{rng.randrange(1, 999)}號{building}{rng.randrange(1, 40)}樓{rng.choice('ABCDE')}室"
    birthdate = f"{rng.randrange(1940, 2010)}年{rng.randrange(1, 13)}月{rng.randrange(1, 29)}日"
    iso_birthdate = f"{rng.randrange(1940, 2010)}-{rng.randrange(1, 13):02d}-{rng.randrange(1, 29):02d}"
    zw_source = _local_phone(rng)
    zw_phone = zw_source[:4] + "\u200b" + zw_source[4:]
    homoglyph_phone = "".join(chr(0x1D7CE + int(digit)) for digit in _local_phone(rng))
    mixed_width_phone = fw_phone[:4] + _local_phone(rng)[4:]
    passport = f"{rng.choice('EHKZ')}{rng.randrange(10000000, 99999999)}"
    expiry = f"{rng.randrange(1, 13):02d}/{rng.randrange(26, 35)}"
    cvv = f"{rng.randrange(100, 999)}"
    telegram = f"@{rng.choice(('chan', 'wong', 'lee', 'lau'))}{rng.randrange(1000, 9999)}"
    return frame.format(
        name=name,
        nick=nick,
        phone=phone,
        otp=otp,
        email=email,
        hkid=hkid,
        id18=id18,
        account=account,
        long_acct=long_acct,
        payme_handle=payme_handle,
        fps_handle=fps_handle,
        url_path=url_path,
        url_user=url_user,
        short_url=short_url,
        url_verify=url_verify,
        cn_phone=cn_phone,
        fw_phone=fw_phone,
        address=address,
        birthdate=birthdate,
        iso_birthdate=iso_birthdate,
        zw_phone=zw_phone,
        homoglyph_phone=homoglyph_phone,
        mixed_width_phone=mixed_width_phone,
        passport=passport,
        expiry=expiry,
        cvv=cvv,
        telegram=telegram,
    )


_TRAIN_FRAMES = (
    "你好，我係{name}，電話{phone}",
    "我叫{name}，方便打俾我嗎",
    "叫我{nick}，電話{phone}",
    "驗證碼 {otp} 請你收好",
    "電郵 {email} 回覆我",
    "身份證 {hkid} 影一張",
    "證件 {id18} 核對清楚",
    "轉數快 {account} 今日過數",
    "銀行卡 {long_acct} 收到未",
    "PayMe ID: u{otp}ab 過數俾我",
    "{fps_handle} 麻煩入數",
    "請開 {url_path} 睇詳情",
    "登入 {url_user} 確認",
    "按 {short_url} 領取",
    "我號碼係{cn_phone}，儘快打",
    "全形電話{fw_phone}係我",
    "我係{name}，驗證碼{otp}，電話{phone}",
    "叫我{nick}，今晚聯絡",
    "我係{nick}，得閒傾",
    "whatsapp {phone} 搵我",
    "Your OTP code is {otp}",
    "我住{address}，今晚喺屋企",
    "我{birthdate}出生，身份證明天補俾你",
    "護照號碼 {passport}，下星期飛",
    "卡到期日 {expiry}，CVV {cvv}",
    "加我 Telegram {telegram}",
    "個OTP係 {otp}，快啲入",
    "email係 {email}，send 文件過嚟",
    "入去 {url_verify}",
    "HKID: {hkid} 唔該",
    "我本passport係 {passport}，check 下",
    "IG {telegram} 加我",
    "信用卡CVV {cvv}",
    "生日 {iso_birthdate}",
    "住址 {address}",
    "我叫{name}，电话{phone}，请回复",
    "验证码 {otp} 请收好",
    "😀 我係{name}，電話{phone} 😀",
    "我係{name}\n電話{phone}\n唔該",
    "電話 {zw_phone} 搵我",
    "號碼 {homoglyph_phone} 留低",
    "電話 {mixed_width_phone} 留低",
    "講天氣講食飯講屋企人講新聞講股票，電話{phone}，之後講返工講放假講飲茶講行山",
    "住址 {address}，唔該",
    "我搬咗去{address}，得閒嚟坐",
    "我叫{name}，whatsapp {phone} 搵我",
    "身份證 {hkid} 影低",
)


_TEST_FRAMES = (
    "本人{name}，請打{phone}找我",
    "我名叫{name}，之後聯絡",
    "我係{nick}，今晚聯絡",
    "你的驗證碼是{otp}，勿外傳",
    "回信到 {email} 就得",
    "證件號 {hkid} 核對一下",
    "回鄉證 {id18} 請查收",
    "戶口 {account} 係收款",
    "帳號 {long_acct} 請轉帳",
    "用 PayMe: pm{otp}xy 付款",
    "{fps_handle} 係我收款號",
    "點擊 {url_path} 處理",
    "前往 {url_user} 下載",
    "查看 {short_url} 通知",
    "打去{cn_phone}就可以",
    "備用號碼{fw_phone}留低",
    "叫我{name}，代碼 {otp}",
    "叫我{nick}，之後聯絡",
    "whatsapp {phone} 先",
    "Your verification code is {otp}",
    "我而家住{address}，遲啲見",
    "生日係{birthdate}，唔好記錯",
    "passport: {passport} 請核對",
    "expiry date {expiry}，安全碼 {cvv}",
    "telegram {telegram} 加我",
    "OTP {otp} 快啲用",
    "email: {email} 麻煩你",
    "前往 {url_verify} 驗證",
    "HKID: {hkid} 請核對",
    "我本passport係 {passport}，唔該",
    "IG {telegram} 加朋友",
    "信用卡CVV {cvv} 請收好",
    "生日 {iso_birthdate} 唔好記錯",
    "住址 {address} 今晚見",
    "我叫{name}，电话{phone}，请回复",
    "验证码 {otp} 请收好",
    "😀 我係{name}，電話{phone} 😀",
    "我係{name}\n電話{phone}\n今晚聯絡",
    "電話 {zw_phone} 搵我",
    "號碼 {homoglyph_phone} 留低",
)


def _negative_fill(rng: random.Random, frame: str) -> str:
    return frame.format(
        order="".join(rng.choice("0123456789") for _ in range(rng.choice((8, 10)))),
        amount=rng.choice((68, 128, 500, 1250, 5000, 50000)),
        year=rng.randrange(2024, 2031),
        month=rng.randrange(1, 13),
        day=rng.randrange(1, 29),
        hour=rng.randrange(1, 13),
        minute=rng.choice(("00", "15", "30", "45")),
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
    for _ in range(max(10, count // 2)):
        text = _negative_fill(rng, rng.choice(_HARD_NEGATIVE_FRAMES))
        rows.append({"text": text, "spans": gold_spans(text), "hard_negative": True})
    rng.shuffle(rows)
    return rows
