"""NSIS 安装向导自动化（2.0.2）：验证自定义安装路径可用、新装不删除旧版。

流程：启动安装器 → 逐页打印控件文本 → 若出现路径输入框则写入 TARGET
→ 依次点「下一步 / 安装」→ 等完成页 → 统计目标目录文件数。
"""
import ctypes
import os
import subprocess
import time
from ctypes import wintypes

from PIL import ImageGrab

u = ctypes.windll.user32
k32 = ctypes.windll.kernel32
BASE = r"C:\Users\zhangyouwen\WorkBuddy\2026-11-08-10-13-30\warehouse-v2"
EXE = BASE + r"\release4\库房管理系统-桌面版 V2 Setup 2.0.2.exe"
TARGET = r"C:\Users\zhangyouwen\AppData\Local\Programs"
SCALE = 1.5

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


def find_dialog(want_substr, timeout=60):
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
  try:
    r = wintypes.RECT()
    u.GetWindowRect(hwnd, ctypes.byref(r))
    box = (int(r.left * SCALE), int(r.top * SCALE),
           int(r.right * SCALE), int(r.bottom * SCALE))
    u.SetForegroundWindow(hwnd)
    time.sleep(0.8)
    im = ImageGrab.grab(bbox=box)
    if im.size[0] > 0 and im.size[1] > 0:
        im.save(os.path.join(BASE, "tests", name))
  except Exception as e:
    print("shot skip:", e)


print("launch:", EXE)
subprocess.Popen([EXE])
got = find_dialog("release4", timeout=120)
if not got:
    raise SystemExit("未找到 2.0.2 安装器窗口")
dlg, path = got
print("dialog:", dlg, "|", path)
time.sleep(1.5)

step = 0
while step < 6:
    step += 1
    texts = [k["text"] for k in kids(dlg) if k["text"]]
    print(f"page{step}:", texts[:10])
    edits = [k for k in kids(dlg) if k["cls"] == "Edit"]
    if edits:
        print("edit before:", [edit_value(e["h"]) for e in edits])
        u.SendMessageW(edits[0]["h"], WM_SETTEXT, 0, ctypes.c_wchar_p(TARGET))
        time.sleep(0.6)
        print("edit after:", [edit_value(e["h"]) for e in edits])
        shot(dlg, "v202-wizard-path.png")

    if any("完成" in t for t in texts):
        print("reached finish page")
        break

    btn = click(dlg, "安装") or click(dlg, "下一步")
    print("clicked:", btn)
    if not btn:
        # 可能是「安装」按钮文案不同，打印所有按钮
        print("buttons:", [k["text"] for k in kids(dlg) if k["cls"] == "Button"])
        break
    time.sleep(3 if btn == "安装" else 1.5)

end = time.time() + 150
while time.time() < end:
    texts = [k["text"] for k in kids(dlg) if k["text"]]
    if any("完成" in t for t in texts):
        break
    time.sleep(1)
print("finish:", [k["text"] for k in kids(dlg) if k["text"]][:8])
shot(dlg, "v202-wizard-done.png")

print("TARGET exists:", os.path.isdir(TARGET))
for name in os.listdir(TARGET):
    p = os.path.join(TARGET, name)
    if os.path.isdir(p) and "warehouse" in name.lower():
        cnt = sum(len(fs) for _, _, fs in os.walk(p))
        print("installed dir:", p, "files:", cnt)
