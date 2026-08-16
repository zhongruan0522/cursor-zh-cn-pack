import { execFile } from 'child_process';
import * as fs from 'fs/promises';
import * as path from 'path';
import { promisify } from 'util';
import { createScopedProgress, ProgressCallback, reportProgress, toPercent, yieldToEventLoop } from './progress';

const execFileAsync = promisify(execFile);

export interface CursorInstallPaths {
  readonly appPackagePath: string;
  readonly nlsKeysPath: string;
  readonly nlsMessagesPath: string;
  readonly workbenchPath: string;
  readonly glassWorkbenchPath: string;
  readonly automationsWorkbenchPath: string;
}

export interface CursorInstall extends CursorInstallPaths {
  readonly root: string;
  readonly source: string;
  readonly version?: string;
  readonly valid: boolean;
  readonly problems: readonly string[];
}

export interface LocateCursorResult {
  readonly install?: CursorInstall;
  readonly candidates: readonly CursorInstall[];
}

interface Candidate {
  readonly root: string;
  readonly source: string;
  readonly maxAncestorDepth?: number;
}

export async function locateCursorInstall(savedRoot?: string, progress?: ProgressCallback): Promise<LocateCursorResult> {
  const candidates: Candidate[] = [];

  if (savedRoot?.trim()) {
    candidates.push({ root: savedRoot.trim(), source: '已保存配置' });
    await reportProgress(progress, { message: '已加入保存的 Cursor 路径', percent: 5, current: candidates.length, total: candidates.length });
  }

  await reportProgress(progress, { message: '检查正在运行的 Cursor 进程与注册表', percent: 10 });
  const powerShellCandidates = await gatherPowerShellCandidates();
  for (const processPath of powerShellCandidates.processPaths) {
    candidates.push({ root: processPath, source: '正在运行的 Cursor.exe' });
  }

  await reportProgress(progress, { message: '读取 PATH 中的 Cursor 候选路径', percent: 35, current: candidates.length, total: candidates.length });
  for (const pathCandidate of getPathCandidates()) {
    candidates.push(pathCandidate);
  }
  await yieldToEventLoop();

  for (const registryCandidate of powerShellCandidates.registryCandidates) {
    candidates.push(registryCandidate);
  }

  await reportProgress(progress, { message: '加入常见安装路径', percent: 45, current: candidates.length, total: candidates.length });
  for (const commonPath of getCommonInstallPaths()) {
    candidates.push({ root: commonPath, source: '常见安装路径', maxAncestorDepth: 0 });
  }

  const validated = await validateCandidates(candidates, createScopedProgress(progress, 50, 98, '校验候选路径'));
  await reportProgress(progress, {
    message: `识别完成，已检查 ${validated.length} 个候选路径`,
    percent: 100,
    current: validated.length,
    total: validated.length
  });
  return {
    install: validated.find(candidate => candidate.valid),
    candidates: validated
  };
}

export async function validateCursorRoot(root: string, source = '手动选择', progress?: ProgressCallback): Promise<CursorInstall> {
  const normalizedRoot = path.resolve(root.trim());
  const paths = getCursorPaths(normalizedRoot);
  const problems: string[] = [];
  const requiredFiles = [
    ['Cursor package.json', paths.appPackagePath],
    ['nls.keys.json', paths.nlsKeysPath],
    ['nls.messages.json', paths.nlsMessagesPath],
    ['workbench.desktop.main.js', paths.workbenchPath]
  ] as const;

  await reportProgress(progress, { message: `校验目录 ${normalizedRoot}`, percent: 0, current: 0, total: requiredFiles.length });
  for (let index = 0; index < requiredFiles.length; index += 1) {
    const [label, filePath] = requiredFiles[index];
    if (!await fileExists(filePath)) {
      problems.push(`缺少 ${label}: ${filePath}`);
    }

    await reportProgress(progress, {
      message: `校验 ${label}`,
      percent: toPercent(index + 1, requiredFiles.length),
      current: index + 1,
      total: requiredFiles.length
    });
    await yieldToEventLoop();
  }

  return {
    root: normalizedRoot,
    source,
    version: await readCursorVersion(paths.appPackagePath),
    valid: problems.length === 0,
    problems,
    ...paths
  };
}

export async function resolveCursorRoot(input: string, source = '候选路径', progress?: ProgressCallback): Promise<CursorInstall | undefined> {
  const roots = expandPossibleRoots(input);
  for (let index = 0; index < roots.length; index += 1) {
    const install = await validateCursorRoot(roots[index], source, createScopedProgress(progress, toPercent(index, roots.length), toPercent(index + 1, roots.length)));
    if (install.valid) {
      return install;
    }
  }

  return undefined;
}

export function getCursorPaths(root: string): CursorInstallPaths {
  const appRoot = path.join(root, 'resources', 'app');
  return {
    appPackagePath: path.join(appRoot, 'package.json'),
    nlsKeysPath: path.join(appRoot, 'out', 'nls.keys.json'),
    nlsMessagesPath: path.join(appRoot, 'out', 'nls.messages.json'),
    workbenchPath: path.join(appRoot, 'out', 'vs', 'workbench', 'workbench.desktop.main.js'),
    glassWorkbenchPath: path.join(appRoot, 'out', 'vs', 'workbench', 'workbench.glass.main.js'),
    automationsWorkbenchPath: path.join(appRoot, 'out', 'vs', 'workbench', 'workbench.anysphere-ui-automations.js')
  };
}

async function validateCandidates(candidates: readonly Candidate[], progress?: ProgressCallback): Promise<CursorInstall[]> {
  const seen = new Set<string>();
  const validated: CursorInstall[] = [];
  let processed = 0;
  const estimatedTotal = candidates.reduce(
    (sum, candidate) => sum + expandPossibleRoots(candidate.root, candidate.maxAncestorDepth).length,
    0
  );

  await reportProgress(progress, { message: '开始校验候选路径', percent: 0, current: 0, total: estimatedTotal });
  for (const candidate of candidates) {
    for (const root of expandPossibleRoots(candidate.root, candidate.maxAncestorDepth)) {
      processed += 1;
      const key = root.toLowerCase();
      if (seen.has(key)) {
        continue;
      }

      seen.add(key);
      const install = await validateCursorRoot(root, candidate.source);
      validated.push(install);
      if (install.valid) {
        // 找到有效安装后立即停止，不再遍历剩余兜底候选。
        await reportProgress(progress, {
          message: `识别到有效安装目录: ${root}`,
          percent: 100,
          current: processed,
          total: processed
        });
        return validated;
      }

      if (processed % 12 === 0 || processed === estimatedTotal) {
        await reportProgress(progress, {
          message: `校验候选路径 ${processed}/${estimatedTotal}`,
          percent: toPercent(processed, estimatedTotal),
          current: processed,
          total: estimatedTotal
        });
        await yieldToEventLoop();
      }
    }
  }

  return validated;
}

function expandPossibleRoots(input: string, maxAncestorDepth = 8): string[] {
  const roots: string[] = [];
  const push = (value: string) => {
    const normalized = path.resolve(stripExecutableArguments(value));
    if (!roots.some(existing => existing.toLowerCase() === normalized.toLowerCase())) {
      roots.push(normalized);
    }
  };

  push(input);

  const lower = input.toLowerCase();
  if (lower.endsWith('.exe') || lower.endsWith('.cmd') || lower.endsWith('.bat')) {
    push(path.dirname(input));
  }

  let current = path.resolve(stripExecutableArguments(input));
  for (let i = 0; i < maxAncestorDepth; i++) {
    push(current);
    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }

  return roots;
}

function getPathCandidates(): Candidate[] {
  const values = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  const candidates: Candidate[] = [];

  for (const directory of values) {
    // PATH 中的启动器通常紧邻安装根目录，限制上溯层数避免生成大量无效父目录。
    candidates.push({ root: path.join(directory, 'cursor.cmd'), source: 'PATH 中的 cursor.cmd', maxAncestorDepth: 2 });
    candidates.push({ root: path.join(directory, 'Cursor.exe'), source: 'PATH 中的 Cursor.exe', maxAncestorDepth: 2 });
  }

  return candidates;
}

function getCommonInstallPaths(): string[] {
  const paths = [
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Programs', 'Cursor') : undefined,
    process.env.PROGRAMFILES ? path.join(process.env.PROGRAMFILES, 'Cursor') : undefined,
    process.env['ProgramFiles(x86)'] ? path.join(process.env['ProgramFiles(x86)'], 'Cursor') : undefined,
    'C:\\cursor',
    'D:\\cursor',
    'E:\\cursor'
  ];

  return paths.filter((value): value is string => Boolean(value));
}

const powerShellProcessMarker = '===CURSOR-ZH-CN-PROCESSES===';
const powerShellRegistryMarker = '===CURSOR-ZH-CN-REGISTRY===';

/**
 * 一次 PowerShell 调用同时获取运行中的 Cursor.exe 路径与注册表卸载项，
 * 避免两次进程冷启动（每次约 1-3 秒）。
 */
async function gatherPowerShellCandidates(): Promise<{ processPaths: string[]; registryCandidates: Candidate[] }> {
  if (process.platform !== 'win32') {
    return { processPaths: [], registryCandidates: [] };
  }

  const command = [
    `'${powerShellProcessMarker}';`,
    "Get-CimInstance Win32_Process -Filter \"name = 'Cursor.exe'\" | Select-Object -ExpandProperty ExecutablePath | Sort-Object -Unique;",
    `'${powerShellRegistryMarker}';`,
    "$keys = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*';",
    "Get-ItemProperty $keys -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -like '*Cursor*' } | ForEach-Object { $_.InstallLocation; $_.DisplayIcon; $_.UninstallString }"
  ].join(' ');

  const lines = await runPowerShellLines(command, 6000);
  const processPaths: string[] = [];
  const registryLines: string[] = [];
  let section: 'processes' | 'registry' = 'processes';

  for (const line of lines) {
    if (line === powerShellProcessMarker) {
      section = 'processes';
      continue;
    }
    if (line === powerShellRegistryMarker) {
      section = 'registry';
      continue;
    }
    if (section === 'processes') {
      processPaths.push(line);
    } else {
      registryLines.push(line);
    }
  }

  return {
    processPaths,
    registryCandidates: registryLines.map(root => ({ root, source: '注册表卸载项' }))
  };
}

async function runPowerShellLines(command: string, timeout: number): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command], {
      timeout,
      windowsHide: true,
      maxBuffer: 1024 * 1024
    });

    return stdout
      .split(/\r?\n/g)
      .map(line => line.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

function stripExecutableArguments(value: string): string {
  let result = value.trim();

  if (result.startsWith('"')) {
    const end = result.indexOf('"', 1);
    if (end > 0) {
      result = result.slice(1, end);
    }
  }

  result = result.replace(/^'([^']+)'.*$/, '$1');
  result = result.replace(/^"([^"]+)".*$/, '$1');
  result = result.replace(/,\d+$/, '');

  if (/\.exe\s+/i.test(result)) {
    result = result.replace(/^(.*?\.exe)\s+.*$/i, '$1');
  }

  return result;
}

async function readCursorVersion(packageJsonPath: string): Promise<string | undefined> {
  try {
    const raw = await fs.readFile(packageJsonPath, 'utf8');
    const parsed = JSON.parse(raw) as { version?: unknown };
    return typeof parsed.version === 'string' ? parsed.version : undefined;
  } catch {
    return undefined;
  }
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(filePath);
    return stat.isFile();
  } catch {
    return false;
  }
}
