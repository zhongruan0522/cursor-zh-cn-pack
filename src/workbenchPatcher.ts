import * as crypto from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';
import { CursorInstall, validateCursorRoot } from './cursorLocator';
import { loadWorkbenchPatchData, WorkbenchPatchRule, WorkbenchPatchRuntimePolicy } from './patchMap';
import { createScopedProgress, ProgressCallback, reportProgress, toPercent, yieldToEventLoop } from './progress';
import { assertBraceBalanceUnchanged, measureBraceBalance } from './braceBalance';
import { countNeedleOccurrences, MultiReplacement, replaceAllMulti, replaceAllWithCount } from './stringPatchUtils';

const metadataKey = 'cursorZhCn.workbenchPatchMetadata';
const desktopBackupFilePrefix = 'workbench.desktop.main.js.cursor-zh-cn-pack.';
const glassBackupFilePrefix = 'workbench.glass.main.js.cursor-zh-cn-pack.';
const automationsBackupFilePrefix = 'workbench.anysphere-ui-automations.js.cursor-zh-cn-pack.';
const backupFilePrefixes = [desktopBackupFilePrefix, glassBackupFilePrefix, automationsBackupFilePrefix] as const;

type WorkbenchPatchTargetId = 'desktop' | 'glass' | 'automations';

interface WorkbenchPatchTarget {
  readonly id: WorkbenchPatchTargetId;
  readonly filePath: string;
  readonly backupFilePrefix: string;
  readonly label: string;
  /** 进度提示用的简短名称，避免把文件名反复拼进提示语。 */
  readonly friendlyName: string;
}

interface PatchTargetRecord {
  readonly id: WorkbenchPatchTargetId;
  readonly filePath: string;
  readonly originalHash: string;
  readonly patchedHash: string;
  readonly backupPath: string;
}

const ruleScanCacheLimit = 6;
const ruleScanCache = new Map<string, readonly PatchRuleStatus[]>();

export type PatchState = 'not-applied' | 'applied' | 'partial' | 'unknown';
export type PatchBackupKind = 'original' | 'before-restore' | 'before-uninstall' | 'unknown';

export interface PatchRuleStatus {
  readonly id: string;
  readonly sourceHits: number;
  readonly targetHits: number;
}

export interface PatchMetadata {
  readonly cursorRoot: string;
  readonly cursorVersion?: string;
  readonly workbenchPath: string;
  readonly originalHash: string;
  readonly patchedHash: string;
  readonly backupPath: string;
  readonly targets?: readonly PatchTargetRecord[];
  readonly appliedRuleIds: readonly string[];
  readonly appliedAt: string;
  readonly restoredAt?: string;
  readonly restoreSafetyBackupPath?: string;
  readonly uninstalledAt?: string;
  readonly uninstallSafetyBackupPath?: string;
}

export interface PatchBackupStatus {
  readonly state: PatchState;
  readonly sourceHits: number;
  readonly targetHits: number;
  readonly matchedRules: number;
}

export interface PatchBackupInfo {
  readonly path: string;
  readonly name: string;
  readonly kind: PatchBackupKind;
  readonly isOriginal: boolean;
  readonly currentMetadataBackup: boolean;
  readonly hash: string;
  readonly size: number;
  readonly modifiedAt: string;
  readonly status: PatchBackupStatus;
}

export interface PatchScanResult {
  readonly state: PatchState;
  readonly filePath: string;
  readonly cursorRoot: string;
  readonly cursorVersion?: string;
  readonly currentHash: string;
  readonly backupPath?: string;
  readonly backups: readonly PatchBackupInfo[];
  readonly totalRules: number;
  readonly sourceHits: number;
  readonly targetHits: number;
  readonly matchedRules: number;
  readonly rules: readonly PatchRuleStatus[];
}

export interface PatchApplyResult {
  readonly changed: boolean;
  readonly backupPath?: string;
  readonly appliedRuleIds: readonly string[];
  readonly appliedOccurrences: number;
  readonly before: PatchScanResult;
  readonly after: PatchScanResult;
}

export interface PatchUnapplyResult {
  readonly changed: boolean;
  readonly safetyBackupPath?: string;
  readonly unappliedRuleIds: readonly string[];
  readonly before: PatchScanResult;
  readonly after: PatchScanResult;
}

export interface PatchRestoreResult {
  readonly restored: boolean;
  readonly backupPath: string;
  readonly safetyBackupPath: string;
  readonly after: PatchScanResult;
}

export async function scanWorkbenchPatch(root: string, context: vscode.ExtensionContext, progress?: ProgressCallback): Promise<PatchScanResult> {
  const install = await validateCursorRoot(root, '补丁扫描', createScopedProgress(progress, 0, 15, '正在检查安装目录'));
  if (!install.valid) {
    throw new Error(install.problems.join('\n'));
  }

  const patchData = await loadWorkbenchPatchData(createScopedProgress(progress, 15, 35, '正在加载翻译规则'));
  const result = await scanInstallPatch(
    install,
    context,
    patchData.rules,
    createScopedProgress(progress, 35, 99, '正在检查汉化状态'),
    undefined,
    { scanBackupRuleStatus: false }
  );
  await reportProgress(progress, { message: '检查完成', percent: 100 });
  return result;
}

export async function applyWorkbenchPatch(root: string, context: vscode.ExtensionContext, progress?: ProgressCallback): Promise<PatchApplyResult> {
  const install = await validateCursorRoot(root, '补丁应用', createScopedProgress(progress, 0, 5, '正在检查安装目录'));
  if (!install.valid) {
    throw new Error(install.problems.join('\n'));
  }

  const patchData = await loadWorkbenchPatchData(createScopedProgress(progress, 5, 15, '正在加载翻译规则'));
  const targets = await filterExistingPatchTargets(resolveWorkbenchPatchTargets(install));
  if (targets.length === 0) {
    throw new Error('未找到可补丁的 workbench 文件。');
  }

  const before = await scanInstallPatch(
    install,
    context,
    patchData.rules,
    createScopedProgress(progress, 20, 35, '正在分析当前状态'),
    undefined,
    { scanBackupRuleStatus: false }
  );
  if (before.state === 'applied') {
    await reportProgress(progress, { message: '汉化已是最新状态', percent: 100 });
    return {
      changed: false,
      backupPath: before.backupPath,
      appliedRuleIds: [],
      appliedOccurrences: 0,
      before,
      after: before
    };
  }

  if (before.sourceHits === 0 && before.targetHits === 0) {
    throw new Error('当前 workbench 文件中没有命中可补丁的英文源文案，也没有命中已补丁中文文案。请确认 Cursor 版本是否已变化。');
  }

  const rules = patchData.rules;
  const targetRecords: PatchTargetRecord[] = [];
  let changed = false;
  let totalAppliedOccurrences = 0;
  const appliedRuleIds = new Set<string>();
  let primaryBackupPath: string | undefined;

  for (let targetIndex = 0; targetIndex < targets.length; targetIndex += 1) {
    const target = targets[targetIndex];
    const targetProgress = createScopedProgress(
      progress,
      35 + toPercent(targetIndex, targets.length) * 55,
      35 + toPercent(targetIndex + 1, targets.length) * 55,
      targets.length > 1 ? target.friendlyName : undefined
    );
    const result = await applyPatchToTarget(
      target,
      install,
      context,
      rules,
      patchData.runtimePolicy,
      targetProgress,
      targets.length > 1
    );

    if (result.changed) {
      changed = true;
      totalAppliedOccurrences += result.appliedOccurrences;
      for (const ruleId of result.appliedRuleIds) {
        appliedRuleIds.add(ruleId);
      }
    }

    targetRecords.push(result.record);
    if (!primaryBackupPath && result.record.backupPath) {
      primaryBackupPath = result.record.backupPath;
    }
  }

  const desktopRecord = targetRecords.find(record => record.id === 'desktop');
  const metadata: PatchMetadata = {
    cursorRoot: install.root,
    cursorVersion: install.version,
    workbenchPath: install.workbenchPath,
    originalHash: desktopRecord?.originalHash ?? targetRecords[0]?.originalHash ?? '',
    patchedHash: desktopRecord?.patchedHash ?? targetRecords[0]?.patchedHash ?? '',
    backupPath: desktopRecord?.backupPath ?? targetRecords[0]?.backupPath ?? '',
    targets: targetRecords,
    appliedRuleIds: [...appliedRuleIds],
    appliedAt: new Date().toISOString()
  };
  await reportProgress(progress, { message: '正在保存记录', percent: 92 });
  await context.globalState.update(metadataKey, metadata);

  const after = await scanInstallPatch(
    install,
    context,
    rules,
    createScopedProgress(progress, 94, 99, '正在复核结果'),
    undefined,
    { scanBackupRuleStatus: false }
  );
  await reportProgress(progress, { message: '界面汉化完成', percent: 100 });
  return {
    changed,
    backupPath: primaryBackupPath,
    appliedRuleIds: [...appliedRuleIds],
    appliedOccurrences: totalAppliedOccurrences,
    before,
    after
  };
}

interface ApplyPatchToTargetResult {
  readonly changed: boolean;
  readonly appliedRuleIds: readonly string[];
  readonly appliedOccurrences: number;
  readonly record: PatchTargetRecord;
}

async function applyPatchToTarget(
  target: WorkbenchPatchTarget,
  install: CursorInstall,
  context: vscode.ExtensionContext,
  rules: readonly WorkbenchPatchRule[],
  runtimePolicy: WorkbenchPatchRuntimePolicy,
  progress?: ProgressCallback,
  multiTarget = false
): Promise<ApplyPatchToTargetResult> {
  await reportProgress(progress, { message: '正在读取文件', percent: 5 });
  const originalContent = await fs.readFile(target.filePath, 'utf8');
  const originalHash = sha256(originalContent);

  await reportProgress(progress, { message: '正在备份原文件', percent: 15 });
  const backupPath = await ensureBackup(target, install, originalContent, context);
  let patchedContent = originalContent;
  let appliedOccurrences = 0;
  const appliedRuleIds: string[] = [];

  // 单趟替换：一次 Aho-Corasick 遍历完成全部规则，替代逐条全文扫描；
  // 规则冲突（命中区间重叠 / target 内含其他 source）时返回 undefined，回退逐条。
  const replacements: readonly MultiReplacement[] = rules;
  const multi = await replaceAllMulti(originalContent, replacements, {
    onChunk: async (scanned, total) => {
      await reportProgress(progress, {
        message: multiTarget ? `正在写入${target.friendlyName}翻译` : '正在写入翻译',
        percent: 20 + toPercent(scanned, total) * 0.55
      });
      await yieldToEventLoop();
    }
  });

  if (multi) {
    patchedContent = multi.value;
    for (const rule of rules) {
      const count = multi.counts.get(rule.source) ?? 0;
      if (count > 0) {
        appliedOccurrences += count;
        appliedRuleIds.push(rule.id);
      }
    }
  } else {
    for (let index = 0; index < rules.length; index += 1) {
      const rule = rules[index];
      const replacement = replaceAllWithCount(patchedContent, rule.source, rule.target);
      if (replacement.count > 0) {
        patchedContent = replacement.value;
        appliedOccurrences += replacement.count;
        appliedRuleIds.push(rule.id);
      }

      if (shouldYieldPatchProgress(index + 1, rules.length, progress)) {
        await reportProgress(progress, {
          message: multiTarget ? `正在写入${target.friendlyName}翻译` : '正在写入翻译',
          percent: 20 + toPercent(index + 1, rules.length) * 0.55
        });
        await yieldToEventLoop();
      }
    }
  }

  if (patchedContent === originalContent) {
    return {
      changed: false,
      appliedRuleIds,
      appliedOccurrences,
      record: {
        id: target.id,
        filePath: target.filePath,
        originalHash,
        patchedHash: originalHash,
        backupPath
      }
    };
  }

  await assertRuntimePatchIsSafe(
    originalContent,
    patchedContent,
    appliedRuleIds,
    appliedOccurrences,
    runtimePolicy,
    rules.length,
    createScopedProgress(progress, 78, 86, '正在校验补丁')
  );

  await reportProgress(progress, { message: '正在保存文件', percent: 90 });
  await fs.writeFile(target.filePath, patchedContent, 'utf8');

  return {
    changed: true,
    appliedRuleIds,
    appliedOccurrences,
    record: {
      id: target.id,
      filePath: target.filePath,
      originalHash,
      patchedHash: sha256(patchedContent),
      backupPath
    }
  };
}

export async function unapplyWorkbenchPatch(root: string, context: vscode.ExtensionContext, progress?: ProgressCallback): Promise<PatchUnapplyResult> {
  const install = await validateCursorRoot(root, '补丁卸载', createScopedProgress(progress, 0, 5, '正在检查安装目录'));
  if (!install.valid) {
    throw new Error(install.problems.join('\n'));
  }

  const patchData = await loadWorkbenchPatchData(createScopedProgress(progress, 5, 15, '正在加载翻译规则'));
  const targets = await filterExistingPatchTargets(resolveWorkbenchPatchTargets(install));
  const before = await scanInstallPatch(
    install,
    context,
    patchData.rules,
    createScopedProgress(progress, 20, 35, '正在分析当前状态'),
    undefined,
    { scanBackupRuleStatus: false }
  );
  if (before.targetHits === 0) {
    await reportProgress(progress, { message: '未检测到已应用的中文补丁', percent: 100 });
    return {
      changed: false,
      unappliedRuleIds: [],
      before,
      after: before
    };
  }

  const rules = patchData.rules;
  let changed = false;
  let safetyBackupPath: string | undefined;
  const unappliedRuleIds = new Set<string>();

  for (let targetIndex = 0; targetIndex < targets.length; targetIndex += 1) {
    const target = targets[targetIndex];
    const targetProgress = createScopedProgress(
      progress,
      35 + toPercent(targetIndex, targets.length) * 55,
      35 + toPercent(targetIndex + 1, targets.length) * 55,
      targets.length > 1 ? target.friendlyName : undefined
    );
    const result = await unapplyPatchFromTarget(target, install, rules, patchData.runtimePolicy, targetProgress, targets.length > 1);
    if (result.changed) {
      changed = true;
      safetyBackupPath = result.safetyBackupPath;
      for (const ruleId of result.unappliedRuleIds) {
        unappliedRuleIds.add(ruleId);
      }
    }
  }

  const metadata = getPatchMetadata(context);
  if (metadata && changed) {
    const updatedMetadata: PatchMetadata = {
      ...metadata,
      uninstalledAt: new Date().toISOString(),
      uninstallSafetyBackupPath: safetyBackupPath
    };
    await context.globalState.update(metadataKey, updatedMetadata);
  }

  const after = await scanInstallPatch(
    install,
    context,
    rules,
    createScopedProgress(progress, 92, 99, '正在复核结果'),
    undefined,
    { scanBackupRuleStatus: false }
  );
  await reportProgress(progress, { message: '汉化已还原', percent: 100 });
  return {
    changed,
    safetyBackupPath,
    unappliedRuleIds: [...unappliedRuleIds],
    before,
    after
  };
}

interface UnapplyPatchFromTargetResult {
  readonly changed: boolean;
  readonly safetyBackupPath?: string;
  readonly unappliedRuleIds: readonly string[];
}

async function unapplyPatchFromTarget(
  target: WorkbenchPatchTarget,
  install: CursorInstall,
  rules: readonly WorkbenchPatchRule[],
  runtimePolicy: WorkbenchPatchRuntimePolicy,
  progress?: ProgressCallback,
  multiTarget = false
): Promise<UnapplyPatchFromTargetResult> {
  await reportProgress(progress, { message: '正在读取文件', percent: 5 });
  const currentContent = await fs.readFile(target.filePath, 'utf8');
  let restoredContent = currentContent;
  let unappliedOccurrences = 0;
  const unappliedRuleIds: string[] = [];

  // 反向替换（target→source）同样优先走单趟遍历，冲突时回退逐条。
  const replacements: MultiReplacement[] = rules.map(rule => ({ source: rule.target, target: rule.source }));
  const multi = await replaceAllMulti(currentContent, replacements, {
    onChunk: async (scanned, total) => {
      await reportProgress(progress, {
        message: multiTarget ? `正在还原${target.friendlyName}翻译` : '正在还原翻译',
        percent: 20 + toPercent(scanned, total) * 0.55
      });
      await yieldToEventLoop();
    }
  });

  if (multi) {
    restoredContent = multi.value;
    for (const rule of rules) {
      const count = multi.counts.get(rule.target) ?? 0;
      if (count > 0) {
        unappliedOccurrences += count;
        unappliedRuleIds.push(rule.id);
      }
    }
  } else {
    for (let index = 0; index < rules.length; index += 1) {
      const rule = rules[index];
      const replacement = replaceAllWithCount(restoredContent, rule.target, rule.source);
      if (replacement.count > 0) {
        restoredContent = replacement.value;
        unappliedOccurrences += replacement.count;
        unappliedRuleIds.push(rule.id);
      }

      if (shouldYieldPatchProgress(index + 1, rules.length, progress)) {
        await reportProgress(progress, {
          message: multiTarget ? `正在还原${target.friendlyName}翻译` : '正在还原翻译',
          percent: 20 + toPercent(index + 1, rules.length) * 0.55
        });
        await yieldToEventLoop();
      }
    }
  }

  if (restoredContent === currentContent) {
    return { changed: false, unappliedRuleIds };
  }

  await assertRuntimePatchIsSafe(
    restoredContent,
    currentContent,
    unappliedRuleIds,
    unappliedOccurrences,
    runtimePolicy,
    rules.length,
    createScopedProgress(progress, 78, 86, '正在校验还原结果')
  );

  const safetyBackupPath = backupPathFor(target, install, 'before-uninstall');
  await reportProgress(progress, { message: '正在保存卸载前快照', percent: 88 });
  await fs.writeFile(safetyBackupPath, currentContent, 'utf8');
  await reportProgress(progress, { message: '正在保存文件', percent: 94 });
  await fs.writeFile(target.filePath, restoredContent, 'utf8');

  return {
    changed: true,
    safetyBackupPath,
    unappliedRuleIds
  };
}

export async function restoreWorkbenchBackup(root: string, context: vscode.ExtensionContext, backupPath?: string, progress?: ProgressCallback): Promise<PatchRestoreResult> {
  const install = await validateCursorRoot(root, '补丁恢复', createScopedProgress(progress, 0, 8, '正在检查安装目录'));
  if (!install.valid) {
    throw new Error(install.problems.join('\n'));
  }

  const patchData = await loadWorkbenchPatchData(createScopedProgress(progress, 8, 15, '正在加载翻译规则'));
  const metadata = getPatchMetadata(context);
  const backups = await scanAllBackupFiles(
    install,
    context,
    patchData.rules,
    metadata,
    createScopedProgress(progress, 15, 45, '正在查找备份'),
    true
  );
  const selectedBackup = backupPath
    ? backups.find(backup => samePath(backup.path, backupPath))
    : backups.find(backup => metadata?.backupPath && samePath(backup.path, metadata.backupPath));

  if (!selectedBackup) {
    throw new Error(backupPath ? `所选备份文件不在当前 Cursor 安装的备份列表中: ${backupPath}` : '没有选择可恢复的补丁备份。');
  }

  const target = getPatchTargetFromBackupName(selectedBackup.name, install);
  if (!target) {
    throw new Error(`无法识别备份文件对应的目标: ${selectedBackup.name}`);
  }

  await reportProgress(progress, { message: '正在校验备份', percent: 50 });
  await assertFile(selectedBackup.path, '备份文件不存在');

  await reportProgress(progress, { message: '正在读取当前文件', percent: 58 });
  const currentContent = await fs.readFile(target.filePath, 'utf8');
  const safetyBackupPath = backupPathFor(target, install, 'before-restore');
  await reportProgress(progress, { message: '正在保存恢复前快照', percent: 68 });
  await fs.writeFile(safetyBackupPath, currentContent, 'utf8');

  await reportProgress(progress, { message: '正在读取备份', percent: 78 });
  const backupContent = await fs.readFile(selectedBackup.path, 'utf8');
  await reportProgress(progress, { message: '正在恢复备份', percent: 88 });
  await fs.writeFile(target.filePath, backupContent, 'utf8');

  if (metadata) {
    const updatedMetadata: PatchMetadata = {
      ...metadata,
      restoredAt: new Date().toISOString(),
      restoreSafetyBackupPath: safetyBackupPath
    };
    await context.globalState.update(metadataKey, updatedMetadata);
  }

  const after = await scanInstallPatch(
    install,
    context,
    patchData.rules,
    createScopedProgress(progress, 92, 99, '正在复核结果'),
    backupContent,
    { scanBackupRuleStatus: false }
  );
  await reportProgress(progress, { message: '恢复完成', percent: 100 });
  return {
    restored: true,
    backupPath: selectedBackup.path,
    safetyBackupPath,
    after
  };
}

export function getPatchMetadata(context: vscode.ExtensionContext): PatchMetadata | undefined {
  return context.globalState.get<PatchMetadata>(metadataKey);
}

function resolveWorkbenchPatchTargets(install: CursorInstall): readonly WorkbenchPatchTarget[] {
  const targets: WorkbenchPatchTarget[] = [{
    id: 'desktop',
    filePath: install.workbenchPath,
    backupFilePrefix: desktopBackupFilePrefix,
    label: 'workbench.desktop.main.js',
    friendlyName: '主界面'
  }];

  if (install.glassWorkbenchPath) {
    targets.push({
      id: 'glass',
      filePath: install.glassWorkbenchPath,
      backupFilePrefix: glassBackupFilePrefix,
      label: 'workbench.glass.main.js',
      friendlyName: 'Agents 窗口'
    });
  }

  if (install.automationsWorkbenchPath) {
    targets.push({
      id: 'automations',
      filePath: install.automationsWorkbenchPath,
      backupFilePrefix: automationsBackupFilePrefix,
      label: 'workbench.anysphere-ui-automations.js',
      friendlyName: 'Automations 面板'
    });
  }

  return targets;
}

function formatPatchFilePaths(targets: readonly WorkbenchPatchTarget[]): string {
  return targets.map(target => target.filePath).join('\n');
}

function getPatchTargetFromBackupName(name: string, install: CursorInstall): WorkbenchPatchTarget | undefined {
  if (name.startsWith(automationsBackupFilePrefix)) {
    return resolveWorkbenchPatchTargets(install).find(target => target.id === 'automations');
  }

  if (name.startsWith(glassBackupFilePrefix)) {
    return resolveWorkbenchPatchTargets(install).find(target => target.id === 'glass');
  }

  return resolveWorkbenchPatchTargets(install).find(target => target.id === 'desktop');
}

function getMetadataTargetRecord(metadata: PatchMetadata | undefined, targetId: WorkbenchPatchTargetId): PatchTargetRecord | undefined {
  return metadata?.targets?.find(record => record.id === targetId);
}

function mergePatchRuleStatuses(allStatuses: readonly (readonly PatchRuleStatus[])[]): readonly PatchRuleStatus[] {
  const merged = new Map<string, PatchRuleStatus>();

  for (const statuses of allStatuses) {
    for (const status of statuses) {
      const existing = merged.get(status.id);
      if (!existing) {
        merged.set(status.id, { ...status });
        continue;
      }

      merged.set(status.id, {
        id: status.id,
        sourceHits: existing.sourceHits + status.sourceHits,
        targetHits: existing.targetHits + status.targetHits
      });
    }
  }

  return [...merged.values()];
}

interface ScanInstallPatchOptions {
  readonly scanBackupRuleStatus?: boolean;
}

async function scanTargetPatch(
  target: WorkbenchPatchTarget,
  install: CursorInstall,
  context: vscode.ExtensionContext,
  rules: readonly WorkbenchPatchRule[],
  progress?: ProgressCallback,
  content?: string,
  options?: ScanInstallPatchOptions
): Promise<PatchScanResult> {
  if (!content) {
    await reportProgress(progress, { message: '正在读取文件', percent: 5 });
  }

  const resolvedContent = content ?? await fs.readFile(target.filePath, 'utf8');
  const currentHash = sha256(resolvedContent);
  const ruleStatuses = await getPatchRuleStatuses(
    resolvedContent,
    rules,
    currentHash,
    createScopedProgress(progress, 15, 75, '正在扫描翻译状态')
  );
  const status = getPatchStatusFromRules(ruleStatuses);
  const metadata = getPatchMetadata(context);
  const backups = await scanBackupFiles(
    install,
    target,
    context,
    rules,
    metadata,
    createScopedProgress(progress, 80, 98, '正在检查备份'),
    options?.scanBackupRuleStatus ?? true
  );

  await reportProgress(progress, { message: '检查完成', percent: 100 });
  return {
    state: status.state,
    filePath: target.filePath,
    cursorRoot: install.root,
    cursorVersion: install.version,
    currentHash,
    backupPath: getMetadataTargetRecord(metadata, target.id)?.backupPath ?? (target.id === 'desktop' ? metadata?.backupPath : undefined),
    backups,
    totalRules: rules.length,
    sourceHits: status.sourceHits,
    targetHits: status.targetHits,
    matchedRules: status.matchedRules,
    rules: ruleStatuses
  };
}

async function scanInstallPatch(
  install: CursorInstall,
  context: vscode.ExtensionContext,
  rules: readonly WorkbenchPatchRule[],
  progress?: ProgressCallback,
  content?: string,
  options?: ScanInstallPatchOptions
): Promise<PatchScanResult> {
  const targets = await filterExistingPatchTargets(resolveWorkbenchPatchTargets(install));
  if (targets.length === 0) {
    throw new Error('未找到可补丁的 workbench 文件。');
  }

  if (content !== undefined && targets.length === 1) {
    return scanTargetPatch(targets[0], install, context, rules, progress, content, options);
  }

  const scans: PatchScanResult[] = [];
  for (let index = 0; index < targets.length; index += 1) {
    const target = targets[index];
    scans.push(await scanTargetPatch(
      target,
      install,
      context,
      rules,
      createScopedProgress(progress, toPercent(index, targets.length), toPercent(index + 1, targets.length)),
      undefined,
      options
    ));
  }

  const mergedRules = mergePatchRuleStatuses(scans.map(scan => scan.rules));
  const mergedStatus = getPatchStatusFromRules(mergedRules);
  const backups = scans.flatMap(scan => scan.backups).sort((left, right) => Date.parse(right.modifiedAt) - Date.parse(left.modifiedAt));

  return {
    state: mergedStatus.state,
    filePath: formatPatchFilePaths(targets),
    cursorRoot: install.root,
    cursorVersion: install.version,
    currentHash: scans.map(scan => `${scan.filePath}:${scan.currentHash}`).join('\n'),
    backupPath: scans.find(scan => scan.backupPath)?.backupPath,
    backups,
    totalRules: rules.length,
    sourceHits: mergedStatus.sourceHits,
    targetHits: mergedStatus.targetHits,
    matchedRules: mergedStatus.matchedRules,
    rules: mergedRules
  };
}

async function filterExistingPatchTargets(targets: readonly WorkbenchPatchTarget[]): Promise<WorkbenchPatchTarget[]> {
  const existing: WorkbenchPatchTarget[] = [];

  for (const target of targets) {
    if (await fileExists(target.filePath)) {
      existing.push(target);
    }
  }

  return existing;
}

async function scanAllBackupFiles(
  install: CursorInstall,
  context: vscode.ExtensionContext,
  rules: readonly WorkbenchPatchRule[],
  metadata: PatchMetadata | undefined,
  progress?: ProgressCallback,
  scanRuleStatus = true
): Promise<PatchBackupInfo[]> {
  const targets = await filterExistingPatchTargets(resolveWorkbenchPatchTargets(install));
  const backups: PatchBackupInfo[] = [];

  for (const target of targets) {
    backups.push(...await scanBackupFiles(
      install,
      target,
      context,
      rules,
      metadata,
      progress,
      scanRuleStatus
    ));
  }

  return backups.sort((left, right) => Date.parse(right.modifiedAt) - Date.parse(left.modifiedAt));
}

async function scanBackupFiles(
  install: CursorInstall,
  target: WorkbenchPatchTarget,
  context: vscode.ExtensionContext,
  rules: readonly WorkbenchPatchRule[],
  metadata: PatchMetadata | undefined,
  progress?: ProgressCallback,
  scanRuleStatus = true
): Promise<PatchBackupInfo[]> {
  const directory = path.dirname(target.filePath);
  let entries: string[];

  await reportProgress(progress, { message: '正在读取备份目录', percent: 0 });
  try {
    entries = await fs.readdir(directory);
  } catch {
    await reportProgress(progress, { message: '备份目录不可读取', percent: 100 });
    return [];
  }

  const names = entries.filter(name => name.startsWith(target.backupFilePrefix));
  const backups: PatchBackupInfo[] = [];
  if (names.length === 0) {
    await reportProgress(progress, { message: '未发现备份文件', percent: 100 });
    return [];
  }

  for (let index = 0; index < names.length; index += 1) {
    const backup = await readPatchBackupInfo(target, directory, names[index], metadata, rules, scanRuleStatus);
    if (backup) {
      backups.push(backup);
    }

    if (shouldYieldPatchProgress(index + 1, names.length, progress)) {
      await reportProgress(progress, {
        message: '正在检查备份',
        percent: toPercent(index + 1, names.length)
      });
      await yieldToEventLoop();
    }
  }

  return backups.sort((left, right) => Date.parse(right.modifiedAt) - Date.parse(left.modifiedAt));
}

async function readPatchBackupInfo(
  target: WorkbenchPatchTarget,
  directory: string,
  name: string,
  metadata: PatchMetadata | undefined,
  rules: readonly WorkbenchPatchRule[],
  scanRuleStatus: boolean
): Promise<PatchBackupInfo | undefined> {
  const filePath = path.join(directory, name);

  try {
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) {
      return undefined;
    }

    const kind = getPatchBackupKind(name);
    if (!scanRuleStatus) {
      const hash = getBackupInferredHash(filePath, metadata);
      const status = inferBackupPatchStatus(hash, kind, metadata) ?? {
        state: 'unknown',
        sourceHits: 0,
        targetHits: 0,
        matchedRules: 0
      };

      return {
        path: filePath,
        name,
        kind,
        isOriginal: kind === 'original' && status.state === 'not-applied',
        currentMetadataBackup: isCurrentMetadataBackup(filePath, target.id, metadata),
        hash,
        size: stat.size,
        modifiedAt: stat.mtime.toISOString(),
        status
      };
    }

    const content = await fs.readFile(filePath, 'utf8');
    const hash = sha256(content);
    const status = await getPatchContentStatus(content, rules);

    return {
      path: filePath,
      name,
      kind,
      isOriginal: kind === 'original' && status.state === 'not-applied',
      currentMetadataBackup: isCurrentMetadataBackup(filePath, target.id, metadata),
      hash,
      size: stat.size,
      modifiedAt: stat.mtime.toISOString(),
      status
    };
  } catch {
    return undefined;
  }
}

function shouldYieldPatchProgress(current: number, total: number, progress?: ProgressCallback): boolean {
  if (!progress) {
    return false;
  }

  return current % 50 === 0 || current === total;
}

function getBackupInferredHash(filePath: string, metadata: PatchMetadata | undefined): string {
  if (metadata?.targets) {
    for (const target of metadata.targets) {
      if (samePath(filePath, target.backupPath)) {
        return target.originalHash;
      }
    }
  }

  if (metadata?.backupPath && samePath(filePath, metadata.backupPath)) {
    return metadata.originalHash;
  }

  return '';
}

function inferBackupPatchStatus(
  hash: string,
  kind: PatchBackupKind,
  metadata: PatchMetadata | undefined
): PatchBackupStatus | undefined {
  if (metadata?.targets) {
    for (const target of metadata.targets) {
      if (target.originalHash && hash === target.originalHash) {
        return { state: 'not-applied', sourceHits: 0, targetHits: 0, matchedRules: 0 };
      }

      if (target.patchedHash && hash === target.patchedHash) {
        return { state: 'applied', sourceHits: 0, targetHits: 0, matchedRules: 0 };
      }
    }
  }

  if (metadata?.originalHash && hash === metadata.originalHash) {
    return { state: 'not-applied', sourceHits: 0, targetHits: 0, matchedRules: 0 };
  }

  if (metadata?.patchedHash && hash === metadata.patchedHash) {
    return { state: 'applied', sourceHits: 0, targetHits: 0, matchedRules: 0 };
  }

  if (kind === 'original') {
    return { state: 'not-applied', sourceHits: 0, targetHits: 0, matchedRules: 0 };
  }

  return undefined;
}

function getPatchBackupKind(name: string): PatchBackupKind {
  for (const prefix of backupFilePrefixes) {
    if (name.startsWith(`${prefix}bak.`)) {
      return 'original';
    }

    if (name.startsWith(`${prefix}before-restore.`)) {
      return 'before-restore';
    }

    if (name.startsWith(`${prefix}before-uninstall.`)) {
      return 'before-uninstall';
    }
  }

  return 'unknown';
}

function isCurrentMetadataBackup(filePath: string, targetId: WorkbenchPatchTargetId, metadata: PatchMetadata | undefined): boolean {
  const targetRecord = getMetadataTargetRecord(metadata, targetId);
  if (targetRecord?.backupPath) {
    return samePath(filePath, targetRecord.backupPath);
  }

  return targetId === 'desktop' ? Boolean(metadata?.backupPath && samePath(filePath, metadata.backupPath)) : false;
}

async function getPatchContentStatus(content: string, rules: readonly WorkbenchPatchRule[]): Promise<PatchBackupStatus> {
  return getPatchStatusFromRules(await getPatchRuleStatuses(content, rules, sha256(content)));
}

async function getPatchRuleStatuses(
  content: string,
  rules: readonly WorkbenchPatchRule[],
  contentHash: string,
  progress?: ProgressCallback
): Promise<PatchRuleStatus[]> {
  const cacheKey = `${contentHash}|${getRuleFingerprint(rules)}`;
  const cached = ruleScanCache.get(cacheKey);
  if (cached) {
    ruleScanCache.delete(cacheKey);
    ruleScanCache.set(cacheKey, cached);
    await reportProgress(progress, { message: '正在扫描翻译状态', percent: 100 });
    return [...cached];
  }

  await reportProgress(progress, { message: '正在扫描翻译状态', percent: 0 });

  const needles = new Set<string>();
  for (const rule of rules) {
    needles.add(rule.source);
    needles.add(rule.target);
  }

  const counts = await countNeedleOccurrences(content, [...needles], {
    onChunk: async (scanned, total) => {
      await reportProgress(progress, {
        message: '正在扫描翻译状态',
        percent: toPercent(scanned, total)
      });
      await yieldToEventLoop();
    }
  });

  const statuses = rules.map(rule => ({
    id: rule.id,
    sourceHits: counts.get(rule.source) ?? 0,
    targetHits: counts.get(rule.target) ?? 0
  }));

  ruleScanCache.set(cacheKey, statuses);
  if (ruleScanCache.size > ruleScanCacheLimit) {
    const oldestKey = ruleScanCache.keys().next().value;
    if (oldestKey !== undefined) {
      ruleScanCache.delete(oldestKey);
    }
  }

  return statuses;
}

function getRuleFingerprint(rules: readonly WorkbenchPatchRule[]): string {
  if (rules.length === 0) {
    return '0';
  }

  return crypto.createHash('sha1').update(rules.map(rule => rule.id).join('\n'), 'utf8').digest('hex');
}

function getPatchStatusFromRules(rules: readonly PatchRuleStatus[]): PatchBackupStatus {
  const sourceHits = rules.reduce((sum, rule) => sum + rule.sourceHits, 0);
  const targetHits = rules.reduce((sum, rule) => sum + rule.targetHits, 0);
  const matchedRules = rules.filter(rule => rule.sourceHits > 0 || rule.targetHits > 0).length;

  return {
    state: getPatchState(sourceHits, targetHits, matchedRules),
    sourceHits,
    targetHits,
    matchedRules
  };
}

async function ensureBackup(
  target: WorkbenchPatchTarget,
  install: CursorInstall,
  content: string,
  context: vscode.ExtensionContext
): Promise<string> {
  const metadata = getPatchMetadata(context);
  const existingBackupPath = getMetadataTargetRecord(metadata, target.id)?.backupPath
    ?? (target.id === 'desktop' ? metadata?.backupPath : undefined);

  if (existingBackupPath && await fileExists(existingBackupPath)) {
    return existingBackupPath;
  }

  const backupPath = backupPathFor(target, install, 'bak');
  await fs.writeFile(backupPath, content, 'utf8');
  return backupPath;
}

function backupPathFor(target: WorkbenchPatchTarget, install: CursorInstall, kind: 'bak' | 'before-restore' | 'before-uninstall'): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const version = install.version ?? 'unknown';
  return path.join(path.dirname(target.filePath), `${target.backupFilePrefix}${kind}.${version}.${timestamp}`);
}

function samePath(left: string, right: string): boolean {
  const normalizedLeft = path.resolve(left);
  const normalizedRight = path.resolve(right);

  return process.platform === 'win32'
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

function getPatchState(sourceHits: number, targetHits: number, matchedRules: number): PatchState {
  if (targetHits > 0 && sourceHits === 0) {
    return 'applied';
  }

  if (targetHits > 0 && sourceHits > 0) {
    return 'partial';
  }

  if (sourceHits > 0) {
    return 'not-applied';
  }

  return matchedRules > 0 ? 'partial' : 'unknown';
}

async function assertRuntimePatchIsSafe(
  originalContent: string,
  patchedContent: string,
  appliedRuleIds: readonly string[],
  appliedOccurrences: number,
  policy: WorkbenchPatchRuntimePolicy,
  ruleCount: number,
  progress?: ProgressCallback
): Promise<void> {
  const maxHits = resolveMaxRuntimePatchHits(policy, ruleCount);
  if (appliedOccurrences > maxHits) {
    throw new Error(`补丁命中 ${appliedOccurrences} 处，超过运行时安全阈值 ${maxHits}，已取消写入。`);
  }

  await reportProgress(progress, { message: '正在校验补丁', percent: 30 });
  const changedLines = countChangedLines(originalContent, patchedContent);
  const maxChangedLines = resolveMaxRuntimePatchChangedLines(policy, ruleCount);
  if (changedLines > maxChangedLines) {
    throw new Error(`补丁将修改 ${changedLines} 行，超过运行时安全阈值 ${maxChangedLines}，已取消写入。`);
  }

  assertBraceBalanceUnchanged(
    measureBraceBalance(originalContent),
    measureBraceBalance(patchedContent),
    '补丁汇总'
  );

  const guardedNeedles = policy.guardedRuntimeNeedles;
  if (guardedNeedles.length > 0) {
    const [beforeCounts, afterCounts] = [
      await countNeedleOccurrences(originalContent, guardedNeedles),
      await countNeedleOccurrences(patchedContent, guardedNeedles)
    ];

    for (let index = 0; index < guardedNeedles.length; index += 1) {
      const needle = guardedNeedles[index];
      if ((beforeCounts.get(needle) ?? 0) !== (afterCounts.get(needle) ?? 0)) {
        throw new Error(`补丁触及受保护运行时关键字 ${needle}，已取消写入。`);
      }

      if (shouldYieldPatchProgress(index + 1, guardedNeedles.length, progress)) {
        await reportProgress(progress, {
          message: '正在校验补丁',
          percent: 30 + toPercent(index + 1, guardedNeedles.length) * 0.7
        });
        await yieldToEventLoop();
      }
    }
  }

  void appliedRuleIds;
}

function resolveMaxRuntimePatchHits(policy: WorkbenchPatchRuntimePolicy, ruleCount: number): number {
  return Math.max(policy.maxRuntimePatchRuleHits, Math.ceil(ruleCount * 1.25));
}

function resolveMaxRuntimePatchChangedLines(policy: WorkbenchPatchRuntimePolicy, ruleCount: number): number {
  return Math.max(policy.maxRuntimePatchChangedLines, Math.ceil(ruleCount * 0.75));
}

function countChangedLines(before: string, after: string): number {
  const beforeLines = before.split(/\r?\n/g);
  const afterLines = after.split(/\r?\n/g);
  const length = Math.max(beforeLines.length, afterLines.length);
  let changed = 0;

  for (let index = 0; index < length; index += 1) {
    if ((beforeLines[index] ?? '') !== (afterLines[index] ?? '')) {
      changed += 1;
    }
  }

  return changed;
}

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(filePath);
    return stat.isFile();
  } catch {
    return false;
  }
}

async function assertFile(filePath: string, message: string): Promise<void> {
  if (!await fileExists(filePath)) {
    throw new Error(`${message}: ${filePath}`);
  }
}
