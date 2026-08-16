// 扫描 Cursor 的 NLS 消息表（out/nls.messages.json + nls.keys.json）中的未汉化文案。
//
// 为什么需要这个通道：workbench bundle（尤其 Agents 窗口的 glass）内有上千处
// mt(<id>,"English") 形式的标准 NLS 调用，运行时从 globalThis._VSCODE_NLS_MESSAGES
// 取文案——即本消息表。对消息表打补丁（nlsMessagePatcher）一次即可让 desktop 与
// glass 两个窗口同时生效，是覆盖面/成本比最高的汉化通道。

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hasCjkText, hasEnglishText, normalizeText, readJson, resolveCursorRoot, writeJson } from './lib/workbench-scan-shared.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, '..');
const cursorRootInput = process.argv[2] || process.env.CURSOR_ROOT || '';
const reportsDir = path.join(projectRoot, 'reports');
const nlsPatchesPath = path.join(projectRoot, 'data', 'nls-message-patches.json');

// Cursor 私有模块（含 cursor/glass/anysphere 字样）必然没有官方翻译，全部纳入候选；
// 标准 VS Code 模块的文案量大，只对高可见核心模块做增量比对。
const PRIVATE_MODULE_PATTERN = /cursor|glass|anysphere/i;
const CORE_MODULE_PATTERNS = [
  /^vs\/workbench\/contrib\/terminal\//,
  /^vs\/workbench\/contrib\/files\//,
  /^vs\/workbench\/contrib\/search\//,
  /^vs\/workbench\/contrib\/scm\//,
  /^vs\/editor\/contrib\//,
  /^vs\/base\/browser\/ui\//,
  /^vs\/code\/electron-sandbox\//
];

function isCandidateModule(moduleName) {
  if (PRIVATE_MODULE_PATTERN.test(moduleName)) return true;
  return CORE_MODULE_PATTERNS.some((pattern) => pattern.test(moduleName));
}

function isEnglishUiText(value) {
  if (!hasEnglishText(value)) return false;
  if (hasCjkText(value)) return false;
  // 过滤纯占位符/快捷键记号，要求至少有 3 个连续真实英文字母（忽略 && mnemonic 记号）
  return /[A-Za-z]{3}/.test(value.replace(/&&/g, ''));
}

async function main() {
  const appDir = await resolveCursorRoot(cursorRootInput);

  const [messages, keys, existingPatches] = await Promise.all([
    readJson(path.join(appDir, 'out', 'nls.messages.json')),
    readJson(path.join(appDir, 'out', 'nls.keys.json')),
    readJson(nlsPatchesPath).catch(() => [])
  ]);

  const patchedByLocation = new Map(existingPatches.map((rule) => [`${rule.module} ${rule.key}`, rule]));

  const candidateModules = [];
  const summaryOnlyModules = [];
  let totalEntries = 0;
  let englishEntries = 0;
  let alreadyPatched = 0;
  let cursorIndex = 0;

  for (const [moduleName, moduleKeys] of keys) {
    const entries = [];

    for (const key of moduleKeys) {
      const message = messages[cursorIndex];
      cursorIndex += 1;
      totalEntries += 1;

      if (!isEnglishUiText(normalizeText(message))) continue;

      if (patchedByLocation.has(`${moduleName} ${key}`)) {
        alreadyPatched += 1;
        continue;
      }

      englishEntries += 1;
      entries.push({ key, message });
    }

    if (entries.length === 0) continue;

    if (isCandidateModule(moduleName)) {
      candidateModules.push({
        module: moduleName,
        isCursorPrivate: PRIVATE_MODULE_PATTERN.test(moduleName),
        untranslatedCount: entries.length,
        entries
      });
    } else {
      // 非候选模块仅计数，不进明细，避免报告爆炸
      summaryOnlyModules.push({
        module: moduleName,
        untranslatedCount: entries.length
      });
    }
  }

  candidateModules.sort((a, b) => {
    if (a.isCursorPrivate !== b.isCursorPrivate) return a.isCursorPrivate ? -1 : 1;
    return b.untranslatedCount - a.untranslatedCount;
  });

  const report = {
    appDir,
    scannedAt: new Date().toISOString(),
    totalEntries,
    englishEntries,
    alreadyPatched,
    candidateModuleCount: candidateModules.length,
    summaryOnlyModuleCount: summaryOnlyModules.length,
    modules: candidateModules,
    summaryOnlyModules
  };

  await writeJson(path.join(reportsDir, 'nls-untranslated.json'), report);

  console.log(`NLS 消息表：${totalEntries} 条，其中英文 ${englishEntries} 条，已入补丁表 ${alreadyPatched} 条`);
  console.log(`候选模块：${candidateModules.length} 个（Cursor 私有模块优先），仅计数模块：${summaryOnlyModules.length} 个`);
  for (const module of candidateModules.slice(0, 20)) {
    console.log(`  ${module.isCursorPrivate ? '[私有]' : '[核心]'} ${module.module}：${module.untranslatedCount} 条`);
  }
  console.log(`JSON 报告：${path.join(reportsDir, 'nls-untranslated.json')}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
