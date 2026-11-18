"""NSIS 安装向导自动化：只操作 release3 的 2.0.1 安装器，验证自定义安装路径。"""
import ctypes
import os
import subprocess
import time
from ctypes import wintypes

from PIL import ImageGrab

u = ctypes.windll.user32
k32 = ctypes.windll.kernel32
BASE = r"C:\Users\zhangyouwen\WorkBuddy\2026-11-08-10-13-30\warehouse-v2"
EXE = BASE + r"\release3\库房管理系统-桌面版 V2 Setup 2.0.1.exe"
TARGET = BASE + r"\installtest3"
SCALE = 1.5

WM_SETTEXT, WM_GETTEXT, WM_GETTEXTLENGTH = 0x000C, 0x000D, 0x000E
BM_CLICK, WM_CLOSE = 0x00F5, 0x0010


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


def find_dialog(want_substr, timeout=30):
    """找标题含「库房」且 exe 路径含 want_substr 的对话框。"""
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
        r = wintypes.RECT()
        u.GetWindowRect(h, ctypes.byref(r))
        out.append({"h": h, "cls": cn.value, "text": b.value.strip(),
                    "rect": (r.left, r.top, r.right, r.bottom)})
        return True

    u.EnumChildWindows(hwnd, ctypes.WINFUNCTYPE(ctypes.c_bool, wintypes.HWND, wintypes.LPARAM)(cb), 0)
    return out


def click(hwnd, needle):
    for k in kids(hwnd):
        if k["cls"] == "Button" and needle in k["text"]:
            u.SendMessageW(k["h"], BM_CLICK, 0, 0)
            return k["text"]
    return None


def edit_value(h):
    n = u.SendMessageW(h, WM_GETTEXTLENGTH, 0, 0)
    buf = ctypes.create_unicode_buffer(n + 1)
    u.SendMessageW(h, WM_GETTEXT, n + 1, ctypes.byref(buf))
    return buf.value


def shot(hwnd, name):
    r = wintypes.RECT()
    u.GetWindowRect(hwnd, ctypes.byref(r))
    box = (int(r.left * SCALE), int(r.top * SCALE),
           int(r.right * SCALE), int(r.bottom * SCALE))
    u.SetForegroundWindow(hwnd)
    time.sleep(0.7)
    ImageGrab.grab(bbox=box).save(os.path.join(BASE, "tests", name))


print("launch:", EXE)
subprocess.Popen([EXE])
got = find_dialog("release3")
if not got:
    raise SystemExit("未找到 2.0.1 安装器窗口")
dlg, path = got
print("dialog:", dlg, "|", path)
time.sleep(1)
print("page:", [k["text"] for k in kids(dlg) if k["text"]][:5])

# 若在「安装选项」页，直接点下一步（默认仅为我安装）
btn = click(dlg, "下一步")
print("clicked next:", btn)
time.sleep(2)
print("page2:", [k["text"] for k in kids(dlg) if k["text"]][:6])

edits = [k for k in kids(dlg) if k["cls"] == "Edit"]
print("edit before:", [edit_value(e["h"]) for e in edits])
if edits:
    u.SendMessageW(edits[0]["h"], WM_SETTEXT, 0, ctypes.c_wchar_p(TARGET))
    time.sleep(0.6)
    print("edit after:", [edit_value(e["h"]) for e in edits])
    shot(dlg, "wizard-dir-custom.png")

btn = click(dlg, "安装")
print("clicked install:", btn)

# 等待完成页
end = time.time() + 120
done = False
while time.time() < end:
    ts = [k["text"] for k in kids(dlg) if k["text"]]
    if any("完成" in t for t in ts) or any("运行" in t for t in ts):
        done = True
        break
    time.sleep(1)
print("finish page:", done, [k["text"] for k in kids(dlg) if k["text"]][:6])
if done:
    shot(dlg, "wizard-done.png")
print("files in target:", sum(len(fs) for _, _, fs in os.walk(TARGET)))
