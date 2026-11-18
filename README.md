# 库房管理系统 · 桌面版 V2（kufang）

学校库房管理系统课程项目 —— **教师端** Windows 桌面应用源码。

基于 Electron 构建，界面为单页应用（`app/index.html`），主进程负责本机数据、协议注册、免登录会话、审计日志、文件导入导出与打印等能力。

- 当前版本：**2.0.2**
- 安装包名称：`库房管理系统-桌面版 V2 Setup 2.0.2.exe`
- 目标平台：Windows x64

## 功能概览

| 模块 | 说明 |
| --- | --- |
| 入库 / 出库 | 物资入库、出库单据录入，支持键盘楔式条码扫描枪连续扫码 |
| 库存查询 | 按名称 / 编号 / 分类 / 状态检索，低库存提醒 |
| 导入导出 | Excel / CSV 批量导入导出，导出文件走系统保存对话框 |
| 审计日志 | 登录、授权、敏感操作与导出行为记录，可查询 |
| 收据打印 | 出库单据打印，适配数位板签名 |
| 权限与会话 | 教师 / 管理员角色权限表，免登录快速进入（guest 会话） |

## 目录结构

```
app/index.html            渲染进程界面（单页，含样式与业务逻辑）
src/main/main.js          主进程入口：窗口、协议、启动自检、单实例
src/main/ipc.js           IPC 通道注册与权限校验
src/main/auth.js          角色 / 权限 / 会话（含免登录 guest 模式）
src/main/audit.js         审计日志写入与读取
src/main/seed.js          首次启动种子数据导入（seed.db → IndexedDB）
src/main/download.js      导出文件下载
src/main/file-save.js     另存为 / 文件落盘
src/main/protocol.js      自定义 app:// 协议注册
src/preload/index.js      预加载脚本（contextBridge 暴露 API）
src/shared/permissions.js 角色与权限常量
resources/app.ico         应用图标
build/icon.ico            安装包图标
seed/seed.db              首次启动种子数据库（SQLite）
tests/                    端到端流程、扫码、安装包等验证脚本
```

## 本地运行

需要 Node.js 18+ 与 npm。

```bash
npm install
npm start
```

## 打包安装包

```bash
npm run dist
```

产物输出到 `release4/` 目录，安装包命名规则见 `package.json` 中的 `build.nsis.artifactName`。

> 打包使用 `electron-builder`，Windows 下建议在纯 ASCII 路径的工作目录执行，避免中文路径导致的沙箱加载问题（主进程已对非 ASCII 安装路径做了兼容处理）。

## 数据存储说明

应用实际以 IndexedDB（`app://local` 源）持久化业务数据，存放于 Electron `userData` 目录；`seed/seed.db` 仅在首次启动（无 `seeded.flag`）时导入一次。V2 与旧版共用同一份 `userData`，因此升级安装后原有库存与单据不会丢失。

## 备注

- `node_modules/`、`release*/`、构建日志与安装测试目录均不纳入版本管理。
- 仓库仅包含源码与构建所需资源，不含打包产物（安装包请见发布附件 / 本地构建）。
