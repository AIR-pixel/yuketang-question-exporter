#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
应急修复 v2.1.0 导出的 Markdown（不动原文件，另存 *_已修复.md）。

v2.1.0 的导出块长这样（真实雨课堂页面结构）：
    ### 9. 单选题
    <空白>
    伊拉克战争…公里。          <- ① .problem-body 的 innerText 开头就是题干
    A                          <- ② 紧接着是它自带的选项文本（裸字母 + 顿号行）
    、150
    B
    、160
    伊拉克战争…公里。          <- ③ 另一个元素又给了一份纯题干
    <空白>
    - A. A                     <- ④ 真正的选项区，但字母重复、还断成两行
      、150

所以「删相邻重复行」不够用（③ 和 ① 之间隔着 ②）。本脚本改成**按题目块重建**：
   · 题干区：只留正文行，丢掉裸字母行 / 顿号开头的半截行 / 与已出现行重复的行
   · 选项区：把断行并回上一行，剥掉与序号重复的字母前缀
   · 判断题：`_（无选项）_` 换成 `- A. 正确` / `- B. 错误`
   · 文件头补一行说明，文件末尾追加给 AI 的提示词

注意：本脚本只修「格式」。v2.1.0 遇到人机验证时可能**整道题没读到**，
      那是数据缺失，脚本无从恢复 —— 要完整的题必须用 v2.3.0 重跑一遍。

用法：
    python test/repair-export.py <输入.md> [输出.md]
"""
import io
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
PROMPT_FILE = os.path.join(HERE, "ai-prompt.grouped.txt")

JUDGE_OPTIONS = ["- A. 正确", "- B. 错误"]
NO_OPTION_MARK = "_（无选项）_"
HEADER_NOTE = "- 说明：判断题页面未渲染出可读选项，已按题型补「正确 / 错误」两项"

RE_QUESTION = re.compile(r"^###\s+\d+\.\s*(.+?)\s*$")
RE_CHAPTER = re.compile(r"^#{1,2}\s+")
RE_OPTION = re.compile(r"^-[ \t]([A-Za-z])[.．、][ \t]*(.*)$")
RE_LONE_LETTER = re.compile(r"^[A-Za-z]$")
RE_DUN = re.compile(r"^[、.．,，:：]")
RE_LEAD_OPT = re.compile(r"^([A-Za-z])[ \t]*(?:\n[ \t]*)?([、.．,，:：)）])[ \t]*")


def norm(s):
    return re.sub(r"\s+", "", s)


def clean_option_text(text, letter):
    """剥掉与序号重复的字母前缀（'A、 1998年12月29日' -> '1998年12月29日'）"""
    t = text.strip()
    m = RE_LEAD_OPT.match(t)
    if m and m.group(1).upper() == letter.upper():
        t = t[m.end():]
    else:
        t = re.sub(r"^[、.．,，:：][ \t]*", "", t)
    return t.strip()


def split_block(body):
    """把题目块正文切成 (题干行, 选项行)；没有选项行时第二项为空"""
    for i, line in enumerate(body):
        if RE_OPTION.match(line) or line.strip() == NO_OPTION_MARK:
            return body[:i], body[i:]
    return body, []


def rebuild_block(qtype, body, stats):
    head, tail = split_block(body)

    # ── 选项区：先把断行并回上一行 ─────────────────────────────
    merged = []
    for line in tail:
        if RE_OPTION.match(line) or line.strip() == NO_OPTION_MARK:
            merged.append(line)
        elif not line.strip():
            continue                      # 选项之间的空行丢掉
        elif merged and merged[-1].strip() != NO_OPTION_MARK:
            merged[-1] = merged[-1].rstrip() + " " + line.strip()
        else:
            merged.append(line)

    # ── 选项文本归一化 ───────────────────────────────────────
    options = []
    for line in merged:
        m = RE_OPTION.match(line)
        if not m:
            continue
        options.append(clean_option_text(m.group(2), m.group(1)))

    # ── 题干区：去噪 + 去重 ───────────────────────────────────
    opt_keys = {norm(o) for o in options if norm(o)}
    kept, seen = [], set()
    for line in head:
        k = norm(line)
        if not k:
            kept.append("")
            continue
        if RE_LONE_LETTER.match(k):        # ② 裸字母
            continue
        if RE_DUN.match(k):                # ② 「、150」这种半截
            continue
        if k in opt_keys:                  # 整行就是某个选项
            continue
        if k in seen:                      # ③ 重复题干
            stats["dedup"] += 1
            continue
        seen.add(k)
        kept.append(line)

    while kept and not kept[-1].strip():
        kept.pop()
    while kept and not kept[0].strip():
        kept.pop(0)

    # ── 判断题补选项 ─────────────────────────────────────────
    if not options and "判断" in qtype:
        options = ["正确", "错误"]
        stats["judge_filled"] += 1

    out = list(kept)
    if options:
        out.append("")
        for i, o in enumerate(options):
            out.append("- %s. %s" % ("ABCDEFGH"[i], o))
    return out


def repair(text):
    lines = text.split("\n")
    out, buf = [], []          # buf = 当前题目块正文
    qtype = None
    stats = {"dedup": 0, "judge_filled": 0, "questions": 0, "options": 0}

    def flush():
        if qtype is None:
            return
        body = rebuild_block(qtype, buf, stats)
        out.extend(body)
        out.append("")                      # 块之间留空行，否则 ### 会粘在选项后面
        stats["options"] += sum(1 for l in body if RE_OPTION.match(l))

    for raw in lines:
        line = raw.rstrip("\r")
        m = RE_QUESTION.match(line)
        if m:
            flush()
            qtype = m.group(1).strip()
            stats["questions"] += 1
            buf = []
            out.append(line)
            out.append("")
            continue
        if RE_CHAPTER.match(line):
            flush()
            qtype = None
            out.append(line)
            continue
        if qtype is None:
            out.append(line)
        else:
            buf.append(line)
    flush()

    body = "\n".join(out)
    body = re.sub(r"[ \t]+\n", "\n", body)
    body = re.sub(r"\n{3,}", "\n\n", body).rstrip("\n") + "\n"

    if HEADER_NOTE not in body:
        for anchor in (r"(\n- 字体解密：[^\n]*\n)", r"(\n- 总题量：[^\n]*\n)"):
            new = re.sub(anchor, r"\1" + HEADER_NOTE + "\n", body, count=1)
            if new != body:
                body = new
                break

    if "【提示词】" not in body:
        prompt = io.open(PROMPT_FILE, encoding="utf-8").read().rstrip("\n")
        body = body.rstrip("\n") + "\n\n" + prompt + "\n"

    return body, stats


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        return 1
    src = sys.argv[1]
    dst = sys.argv[2] if len(sys.argv) > 2 else re.sub(r"\.md$", "_已修复.md", src)
    if not os.path.exists(PROMPT_FILE):
        print("缺少提示词文件：%s" % PROMPT_FILE)
        return 1

    text = io.open(src, encoding="utf-8").read()
    body, stats = repair(text)
    io.open(dst, "w", encoding="utf-8", newline="\n").write(body)

    print("源文件    : %s (%d 字节)" % (src, len(text.encode("utf-8"))))
    print("输出      : %s (%d 字节)" % (dst, len(body.encode("utf-8"))))
    print("题目块    : %d" % stats["questions"])
    print("选项行    : %d" % stats["options"])
    print("去掉重复题干行: %d" % stats["dedup"])
    print("补判断题选项  : %d 道" % stats["judge_filled"])
    return 0


if __name__ == "__main__":
    sys.exit(main())
