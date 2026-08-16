import fs from 'node:fs/promises';
import path from 'node:path';

export async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

// Cursor 前端 bundle 清单：desktop 为主界面，glass 为 Agents 窗口，automations 为 Automations 面板。
// 运行时补丁器对 desktop/glass 共用同一份规则表，automations 尚未接入补丁，扫描需全部覆盖。
export const WORKBENCH_BUNDLES = [
  { id: 'desktop', file: 'workbench.desktop.main.js', label: '主界面' },
  { id: 'glass', file: 'workbench.glass.main.js', label: 'Agents 窗口' },
  { id: 'automations', file: 'workbench.anysphere-ui-automations.js', label: 'Automations 面板' }
];

async function findAppDir(cursorRoot) {
  const root = path.resolve(cursorRoot);
  if (await exists(path.join(root, 'out', 'vs', 'workbench', 'workbench.desktop.main.js'))) {
    return root;
  }
  const appDir = path.join(root, 'resources', 'app');
  if (await exists(path.join(appDir, 'out', 'vs', 'workbench', 'workbench.desktop.main.js'))) {
    return appDir;
  }
  return undefined;
}

// 自动探测 Cursor 安装目录：系统级 Program Files → 用户级 LocalAppData → 其他盘 Program Files → 旧默认 D:\cursor。
export async function resolveCursorRoot(explicit) {
  const candidates = [];
  if (explicit) candidates.push(explicit);
  if (process.env.CURSOR_ROOT) candidates.push(process.env.CURSOR_ROOT);
  candidates.push('C:\\Program Files\\Cursor');
  if (process.env.LOCALAPPDATA) {
    candidates.push(path.join(process.env.LOCALAPPDATA, 'Programs', 'Cursor'));
  }
  for (const driveLetter of 'DEFGHIJKLMNOPQRSTUVWXYZ') {
    candidates.push(`${driveLetter}:\\Program Files\\Cursor`);
  }
  candidates.push('D:\\cursor');

  const tried = [];
  for (const candidate of candidates) {
    const appDir = await findAppDir(candidate);
    if (appDir) return appDir;
    tried.push(candidate);
  }

  throw new Error(`没有找到 Cursor 安装目录，已尝试：${[...new Set(tried)].join('、')}`);
}

// 解析全部可用的 workbench bundle 扫描目标。
export async function resolveWorkbenchTargets(cursorRootInput) {
  const appDir = cursorRootInput
    ? (await findAppDir(cursorRootInput)) ?? (await resolveCursorRoot())
    : await resolveCursorRoot();

  const targets = [];
  for (const bundle of WORKBENCH_BUNDLES) {
    const filePath = path.join(appDir, 'out', 'vs', 'workbench', bundle.file);
    if (await exists(filePath)) {
      targets.push({ ...bundle, filePath });
    }
  }

  if (targets.length === 0) {
    throw new Error(`在 ${appDir} 下没有找到任何 workbench bundle`);
  }
  return { appDir, targets };
}

export async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, 'utf8'));
}

export async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

export function decodeJsString(raw) {
  const jsonReady = raw
    .replace(/"/g, '\\"')
    .replace(/\\'/g, "'")
    .replace(/\\`/g, '`')
    .replace(/\\x([0-9a-fA-F]{2})/g, (_match, hex) => `\\u00${hex}`)
    .replace(/\\0(?![0-9])/g, '\\u0000')
    .replace(/\\\r?\n/g, '');

  return JSON.parse(`"${jsonReady}"`);
}

export function normalizeText(value) {
  return value.replace(/\s+/g, ' ').trim();
}

export function hasEnglishText(value) {
  return /[A-Za-z]{2}/.test(value);
}

export function hasCjkText(value) {
  return /[\u3400-\u9fff]/.test(value);
}

export function compilePatterns(patterns) {
  return (patterns || []).map((pattern) => new RegExp(pattern, 'u'));
}

export function compileContextTags(tags) {
  return (tags || [])
    .filter((tag) => tag && typeof tag.id === 'string' && Array.isArray(tag.patterns))
    .map((tag) => ({
      id: tag.id,
      label: typeof tag.label === 'string' ? tag.label : tag.id,
      patterns: compilePatterns(tag.patterns)
    }));
}

export function contextTagsFor(value, tagDefinitions) {
  return tagDefinitions
    .filter((tag) => tag.patterns.some((pattern) => pattern.test(value)))
    .map((tag) => tag.id);
}

export function buildLineStarts(source) {
  const starts = [0];

  for (let i = 0; i < source.length; i += 1) {
    if (source.charCodeAt(i) === 10) {
      starts.push(i + 1);
    }
  }

  return starts;
}

export function lineColumnAt(lineStarts, index) {
  let low = 0;
  let high = lineStarts.length - 1;

  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    if (lineStarts[middle] <= index) {
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }

  const lineIndex = Math.max(0, high);
  return {
    line: lineIndex + 1,
    column: index - lineStarts[lineIndex] + 1
  };
}

export function contextAt(source, index, length, surroundingChars) {
  const start = Math.max(0, index - surroundingChars);
  const end = Math.min(source.length, index + length + surroundingChars);
  return source.slice(start, end).replace(/\s+/g, ' ').trim();
}

export function slugifyId(value) {
  return normalizeText(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'text';
}

export function countOccurrences(source, needle) {
  if (!needle) return 0;
  let count = 0;
  let index = 0;
  while ((index = source.indexOf(needle, index)) !== -1) {
    count += 1;
    index += Math.max(needle.length, 1);
  }
  return count;
}

function isQuote(char) {
  return char === '\'' || char === '"' || char === '`';
}

export function skipQuotedString(source, start, quote) {
  for (let i = start + 1; i < source.length; i += 1) {
    const char = source[i];
    if (char === '\\') {
      i += 1;
      continue;
    }
    if (quote === '`' && char === '$' && source[i + 1] === '{') {
      i = skipTemplateExpression(source, i + 2) - 1;
      continue;
    }
    if (char === quote) {
      return i + 1;
    }
  }
  return source.length;
}

function skipTemplateExpression(source, start) {
  let depth = 1;
  for (let i = start; i < source.length; i += 1) {
    const char = source[i];
    if (isQuote(char)) {
      i = skipQuotedString(source, i, char) - 1;
      continue;
    }
    if (char === '{') {
      depth += 1;
      continue;
    }
    if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        return i + 1;
      }
    }
  }
  return source.length;
}

export function findBalancedEnd(source, startIndex, openChar = '{', closeChar = '}') {
  let depth = 0;
  for (let i = startIndex; i < source.length; i += 1) {
    const char = source[i];
    if (isQuote(char)) {
      i = skipQuotedString(source, i, char) - 1;
      continue;
    }
    if (char === openChar) {
      depth += 1;
    }
    if (char === closeChar) {
      depth -= 1;
      if (depth === 0) {
        return i;
      }
    }
  }
  return -1;
}

export function extractQuotedEnglishPhrases(code) {
  const phrases = [];
  const patterns = [
    /return"((?:[^"\\]|\\.)*)"/g,
    /return'((?:[^'\\]|\\.)*)'/g,
    /label:"((?:[^"\\]|\\.)*)"/g,
    /title:"((?:[^"\\]|\\.)*)"/g,
    /description:"((?:[^"\\]|\\.)*)"/g,
    /placeholder:"((?:[^"\\]|\\.)*)"/g,
    /general:"((?:[^"\\]|\\.)*)"/g,
    /chat:"((?:[^"\\]|\\.)*)"/g,
    /appearance:"((?:[^"\\]|\\.)*)"/g
  ];

  for (const pattern of patterns) {
    for (const match of code.matchAll(pattern)) {
      try {
        const text = normalizeText(decodeJsString(match[1]));
        if (!text || !hasEnglishText(text) || hasCjkText(text)) continue;
        phrases.push(text);
      } catch {
        // Ignore invalid escape sequences.
      }
    }
  }

  return [...new Set(phrases)];
}

export function summarizeCodeBlock(code, maxLength = 320) {
  const phrases = extractQuotedEnglishPhrases(code);
  if (phrases.length === 0) {
    return '';
  }
  const summary = phrases.join(' | ');
  return summary.length > maxLength ? `${summary.slice(0, maxLength - 1)}…` : summary;
}
