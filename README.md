# Cursor 简体中文语言包

面向 Windows 版 Cursor 的中文语言包扩展：

当前适配版本为**3.15.19**。

## 安装和启用

先安装官方 VS Code 简体中文语言包，再安装本扩展：

```powershell
cursor --install-extension MS-CEINTL.vscode-language-pack-zh-hans
cursor --install-extension .\cursor-zh-cn-pack-<version>.vsix
```

安装后在 Cursor 中：

1. 命令面板运行 `Configure Display Language`，选择 `zh-cn` / `简体中文`，重启 Cursor
2. 打开 **Cursor 汉化管理器**，识别安装目录并 **应用汉化补丁**
3. 使用 **一键重启并清理 Cursor**，然后重新打开 **智能体窗口**（若使用 Agents Window）

### 推荐流程

1. **识别目录** — 一键识别或手动选择
2. **重新扫描状态** — 只读，不写入
3. **应用汉化补丁** — 写入并备份
4. **一键重启并清理 Cursor** — 刷新已加载界面与 UI 缓存
5. **恢复备份**（可选）— Workbench 与 NLS 备份分开恢复

## 补丁范围

管理器会在写入前检查 Cursor 版本、规则命中数和 bundle 结构，并为每个目标文件创建独立备份：

- `workbench.desktop.main.js` — 主 IDE 界面
- `workbench.glass.main.js` — Agents Window（存在时）
- `workbench.anysphere-ui-automations.js` — Automations 面板（存在时）
- `nls.messages.json` — 标准 NLS 和 Cursor 私有消息（按 `nls.keys.json` 的 module/key 定位）

Cursor 升级后 bundle 可能变化。升级后请先重新扫描；如果状态显示“未知”或“部分应用”，不要盲目重复写入。

## 配置项

| 键 | 说明 | 默认 |
|----|------|------|
| `cursorZhCn.cursorRoot` | Cursor 安装根目录，如 `D:\cursor` | 空（由管理器识别） |
| `cursorZhCn.enableWorkbenchPatch` | 是否允许管理器修改 Workbench bundle | `true` |
