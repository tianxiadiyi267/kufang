"""NSIS 安装向导自动化（2.0.2，改进版）

只按「精确按钮文本」点击，避免误点到「为使用这台电脑的任何人安装」这类单选按钮。
流程：安装选项（仅为我安装）→ 选定安装位置（写入自定义路径）→ 安装 → 完成页。
"""
import ctypes
import os
import re
import subprocess
import time
from ctypes import wintypes

BASE = r"C:\Users\zhangyouwen\WorkBuddy\2026-11-08-10-13-30\warehouse-v2"
EXE = BASE + r"\release4\库房管理系统-桌面版 V2 Setup 2.0.2.exe"
TARGET = r"C:\Users\zhangyouwen\AppData\Local\Programs"

u = ctypes.windll.user32
k32 = ctypes.windll.kernel32
WM_SETTEXT, WM_GETTEXT, WM_GETTEXTLENGTH = 0x000C, 0x000D, 0x000E
BM_CLICK = 0x00F5


def window_exe(hwnd):
    pid = wintypes.DWORD()
    u.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
    h = k32.OpenProcess(0x1000, False, pid.value)
    if not h:
        return ""
    buf = ctypes.create_unicode_buffer(1024)
    size = wintypes.DWORD(1024)
    ok = k32.QueryFullProcessImageNameW(h, 0, buf, ctypes.byref(size))
    k32.CloseHandle(h)
    return buf.value if ok else ""


def find_dialog(want_substr, timeout=90):
    end = time.time() + timeout
    while time.time() < end:
        hits = []

        def cb(h, l):
            if not u.IsWindowVisible(h):
                return True
            cn = ctypes.create_unicode_buffer(64)
            u.GetClassNameW(h, cn, 64)
            if cn.value != "#32770":
                return True
            n = u.GetWindowTextLengthW(h)
            if not n:
                return True
            b = ctypes.create_unicode_buffer(n + 1)
            u.GetWindowTextW(h, b, n + 1)
            if "库房" in b.value:
                path = window_exe(h)
                if want_substr.lower() in path.lower():
                    hits.append((h, path))
            return True

        u.EnumWindows(ctypes.WINFUNCTYPE(ctypes.c_bool, wintypes.HWND, wintypes.LPARAM)(cb), 0)
        if hits:
            return hits[0]
        time.sleep(0.5)
    return None


def kids(hwnd):
    out = []

    def cb(h, l):
        cn = ctypes.create_unicode_buffer(64)
        u.GetClassNameW(h, cn, 64)
        ln = u.GetWindowTextLengthW(h)
        b = ctypes.create_unicode_buffer(ln + 1)
        u.GetWindowTextW(h, b, ln + 1)
        out.append({"h": h, "cls": cn.value, "text": b.value.strip()})
        return True

    u.EnumChildWindows(hwnd, ctypes.WINFUNCTYPE(ctypes.c_bool, wintypes.HWND, wintypes.LPARAM)(cb), 0)
    return out


def norm(t):
    t = re.sub(r"&.", "", t)                  # 去掉 &N / &I 这类快捷键标记
    return re.sub(r"[()\s>]", "", t).strip()  # 去掉「(所有用户)」「>」等装饰


def click_exact(hwnd, wanted):
    for k in kids(hwnd):
        if k["cls"] == "Button" and norm(k["text"]) == wanted:
            u.SendMessageW(k["h"], BM_CLICK, 0, 0)
            return k["text"]
    return None


def click_startswith(hwnd, prefix):
    for k in kids(hwnd):
        if k["cls"] == "Button" and k["text"].startswith(prefix):
            u.SendMessageW(k["h"], BM_CLICK, 0, 0)
            return k["text"]
    return None


def edit_value(h):
    n = u.SendMessageW(h, WM_GETTEXTLENGTH, 0, 0)
    buf = ctypes.create_unicode_buffer(n + 1)
    u.SendMessageW(h, WM_GETTEXT, n + 1, ctypes.byref(buf))
    return buf.value


print("launch:", EXE)
subprocess.Popen([EXE])
got = find_dialog("release4")
if not got:
    raise SystemExit("未找到安装器窗口")
dlg, path = got
print("dialog:", dlg, path)
time.sleep(2)

texts = [k["text"] for k in kids(dlg) if k["text"]]
print("step1 texts:", texts[:8])
print("pick per-user:", click_startswith(dlg, "仅为我安装"))
time.sleep(0.8)
print("next:", click_exact(dlg, "下一步"))
time.sleep(2.5)

texts = [k["text"] for k in kids(dlg) if k["text"]]
print("step2 texts:", texts[:8])
edits = [k for k in kids(dlg) if k["cls"] == "Edit"]
print("edits:", [edit_value(e["h"]) for e in edits])
if edits:
    u.SendMessageW(edits[0]["h"], WM_SETTEXT, 0, ctypes.c_wchar_p(TARGET))
    time.sleep(0.8)
    print("edits after:", [edit_value(e["h"]) for e in edits])

installed = click_exact(dlg, "安装")
print("install:", installed)
if not installed:
    print("buttons:", [k["text"] for k in kids(dlg) if k["cls"] == "Button"])

end = time.time() + 180
while time.time() < end:
    texts = [k["text"] for k in kids(dlg) if k["text"]]
    if any("完成" in t for t in texts):
        break
    time.sleep(1)
print("finish texts:", [k["text"] for k in kids(dlg) if k["text"]][:8])

print("---- install result ----")
for root, dirs, files in os.walk(TARGET):
    depth = root[len(TARGET):].count(os.sep)
    if depth <= 2:
        print("dir:", root, "files:", len(files))
u.SendMessageW(dlg, 0x0010, 0, 0)   # WM_CLOSE 收尾，避免残留窗口
print("desktop lnk:", os.path.exists(r"C:\Users\zhangyouwen\Desktop\库房管理系统-桌面版 V2.lnk"))
