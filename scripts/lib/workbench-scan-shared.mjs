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
// 运行时补丁器对所有存在的 bundle 共用同一份规则表，扫描也需全部覆盖。
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

// —— 词法感知的字符串提取（正则/注释/模板串感知版）——
//
// 背景：纯字符级扫描（只认引号）会被正则字面量（如 /["']/）里的引号打乱引号配对，
// 一旦失步，后续数十 KB 的代码会被误认成“一个巨大字符串”，大片 UI 文案对扫描器不可见。
// 实测 Cursor 3.15.19：desktop/glass/automations 分别有 64%/57%/56% 的内容被吞进 5KB+ 的假字符串，
// "Browser Automation"、"Automate repetitive tasks…" 等文案因此从未出现在扫描报告中。
//
// 这里实现一个轻量 JS 词法器：识别字符串/模板串（含 ${} 嵌套）/行注释/块注释/正则字面量。
// 正则与除法的判定采用“前一显著 token”启发式：标点/关键字后是正则，标识符/数字/右括号后是除法；
// 右括号通过括号栈区分控制流括号（if(x)/re/）与普通分组括号（(a+b)/2）。

const IDENT_START_PATTERN = /[A-Za-z_$]/;
const IDENT_PART_PATTERN = /[A-Za-z0-9_$]/;

// 这些关键字之后跟的一定是“值位置”，因此 `/` 应解释为正则字面量的开头。
const REGEX_ALLOWED_KEYWORDS = new Set([
  'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw',
  'case', 'do', 'else', 'yield', 'await', 'if', 'while', 'for', 'with', 'switch',
  'catch', 'try', 'finally', 'default', 'export', 'import', 'const', 'let', 'var',
  'function', 'class', 'extends', 'static', 'get', 'set', 'async', 'break',
  'continue', 'debugger'
]);

// 这些括号前的关键字意味着括号是控制流条件，右括号后允许出现正则（如 if(x)/re/.test(s)）。
const CONTROL_PAREN_KEYWORDS = new Set(['if', 'while', 'for', 'with', 'catch']);

function isWhitespace(char) {
  return char === ' ' || char === '\n' || char === '\r' || char === '\t' || char === '\f' || char === '\v';
}

function createLexerState() {
  return {
    // 当前 `/` 是否可能开启正则字面量。
    regexAllowed: true,
    // 最近一个单词 token（用于关键字判定），属性访问（a.foo）后的单词不算关键字。
    lastWord: '',
    // 最近一个显著字符（'w'=单词、'n'=数字、'q'=字符串、其他为标点本身）。
    lastSignificantChar: ''
  };
}

// 尝试从 source[start]（应为 '/'）扫描正则字面量，返回结束后标或 -1（判定为除法/误判）。
// 正则不跨行；字符类 [...] 内的 '/' 不终结正则；反斜杠转义成对跳过。
function tryScanRegexLiteral(source, start) {
  let inCharacterClass = false;
  for (let index = start + 1; index < source.length; index += 1) {
    const char = source[index];
    if (char === '\\') {
      index += 1;
      continue;
    }
    if (char === '\n') {
      return -1;
    }
    if (inCharacterClass) {
      if (char === ']') inCharacterClass = false;
      continue;
    }
    if (char === '[') {
      inCharacterClass = true;
      continue;
    }
    if (char === '/') {
      let end = index + 1;
      while (end < source.length && source[end] >= 'a' && source[end] <= 'z') {
        end += 1;
      }
      return end;
    }
  }
  return -1;
}

// 扫描从 source[start]（应为引号）开始的字符串字面量，返回结束后的索引。
// 普通字符串回调 sink.onString；模板串遇到 ${} 时递归进入 scanCodeRegion，
// 含插值的模板串整体不回调（与旧实现一致：插值文本不是稳定的替换目标）。
function scanStringLiteral(source, start, state, sink) {
  const quote = source[start];
  let raw = '';
  let hasTemplateExpression = false;

  for (let index = start + 1; index < source.length; index += 1) {
    const char = source[index];
    if (char === '\\') {
      raw += source.slice(index, index + 2);
      index += 1;
      continue;
    }
    if (quote === '`' && char === '$' && source[index + 1] === '{') {
      hasTemplateExpression = true;
      // 模板表达式内部是普通 JS 代码：'{' 处于值位置，允许出现正则字面量。
      state.regexAllowed = true;
      state.lastWord = '';
      state.lastSignificantChar = '{';
      const expressionEnd = scanCodeRegion(source, index + 2, state, sink, '}');
      if (expressionEnd >= source.length) {
        return source.length;
      }
      index = expressionEnd; // 循环自增后跳过 '}'
      continue;
    }
    if (char === quote) {
      if (!hasTemplateExpression) {
        sink.onString(raw, source.slice(start, index + 1), start, quote);
      }
      state.regexAllowed = false;
      state.lastWord = '';
      state.lastSignificantChar = 'q';
      return index + 1;
    }
    raw += char;
  }

  state.regexAllowed = false;
  return source.length;
}

// 扫描代码区域：从 from 开始，直到 stopChar（仅 '}'，用于模板表达式收尾）在 0 层出现或到达末尾。
// 返回停止位置（指向 stopChar）或 source.length。所有字符串/注释/正则都会被正确跳过。
function scanCodeRegion(source, from, state, sink, stopChar) {
  const parenStack = [];
  let braceDepth = 0;
  let index = from;

  while (index < source.length) {
    const char = source[index];

    if (isWhitespace(char)) {
      index += 1;
      continue;
    }

    // 行注释与块注释
    if (char === '/' && source[index + 1] === '/') {
      const newlineIndex = source.indexOf('\n', index + 2);
      index = newlineIndex === -1 ? source.length : newlineIndex + 1;
      sink.onComment();
      continue;
    }
    if (char === '/' && source[index + 1] === '*') {
      const closeIndex = source.indexOf('*/', index + 2);
      index = closeIndex === -1 ? source.length : closeIndex + 2;
      sink.onComment();
      continue;
    }

    if (char === '\'' || char === '"' || char === '`') {
      index = scanStringLiteral(source, index, state, sink);
      continue;
    }

    // 标识符与关键字
    if (IDENT_START_PATTERN.test(char)) {
      let end = index + 1;
      while (end < source.length && IDENT_PART_PATTERN.test(source[end])) {
        end += 1;
      }
      const word = source.slice(index, end);
      const isPropertyAccess = state.lastSignificantChar === '.';
      state.lastWord = isPropertyAccess ? '' : word;
      state.regexAllowed = !isPropertyAccess && REGEX_ALLOWED_KEYWORDS.has(word);
      state.lastSignificantChar = 'w';
      index = end;
      continue;
    }

    // 数字（含 0x1f、1e9 等粗粒度形态；数字后一定是除法）
    if (char >= '0' && char <= '9') {
      let end = index + 1;
      while (end < source.length && IDENT_PART_PATTERN.test(source[end])) {
        end += 1;
      }
      state.regexAllowed = false;
      state.lastWord = '';
      state.lastSignificantChar = 'n';
      index = end;
      continue;
    }

    if (char === '/') {
      if (state.regexAllowed) {
        const regexEnd = tryScanRegexLiteral(source, index);
        if (regexEnd !== -1) {
          sink.onRegex();
          state.regexAllowed = false;
          state.lastWord = '';
          state.lastSignificantChar = '/';
          index = regexEnd;
          continue;
        }
      }
      // 除法（或 /=）：运算符是标点，其后回到“值位置”
      state.regexAllowed = true;
      state.lastWord = '';
      state.lastSignificantChar = '/';
      index += 1;
      continue;
    }

    if (char === '(') {
      parenStack.push(CONTROL_PAREN_KEYWORDS.has(state.lastWord));
      state.regexAllowed = true;
      state.lastWord = '';
      state.lastSignificantChar = '(';
      index += 1;
      continue;
    }
    if (char === ')') {
      const wasControlParen = parenStack.length > 0 ? parenStack.pop() : false;
      state.regexAllowed = wasControlParen;
      state.lastWord = '';
      state.lastSignificantChar = ')';
      index += 1;
      continue;
    }
    if (char === '[') {
      state.regexAllowed = true;
      state.lastWord = '';
      state.lastSignificantChar = '[';
      index += 1;
      continue;
    }
    if (char === ']') {
      state.regexAllowed = false;
      state.lastWord = '';
      state.lastSignificantChar = ']';
      index += 1;
      continue;
    }
    if (char === '{') {
      braceDepth += 1;
      state.regexAllowed = true;
      state.lastWord = '';
      state.lastSignificantChar = '{';
      index += 1;
      continue;
    }
    if (char === '}') {
      if (stopChar === '}') {
        braceDepth -= 1;
        if (braceDepth < 0) {
          return index;
        }
      }
      state.regexAllowed = true;
      state.lastWord = '';
      state.lastSignificantChar = '}';
      index += 1;
      continue;
    }

    // 其余一律按标点处理（= , ; : ? ! & | % * + - < > ~ ^ . 等）：其后是值位置，允许正则。
    state.regexAllowed = true;
    state.lastWord = '';
    state.lastSignificantChar = char;
    index += 1;
  }

  return source.length;
}

// 词法感知版字符串提取：返回 { literals: [{ value, literal, index }], stats }。
// stats.suspect* 统计超长（>5KB）“字符串”——正常 bundle 里几乎没有，
// 数量暴涨说明词法判定又被新的代码形态打乱（desync 预警指标）。
export function extractStringLiterals(source) {
  const state = createLexerState();
  const literals = [];
  const stats = {
    stringLiteralCount: 0,
    regexLiteralCount: 0,
    commentCount: 0,
    suspectCount: 0,
    suspectBytes: 0
  };
  const sink = {
    onString(raw, literal, index) {
      try {
        const value = decodeJsString(raw);
        literals.push({ value, literal, index });
        stats.stringLiteralCount += 1;
        if (literal.length > 5000) {
          stats.suspectCount += 1;
          stats.suspectBytes += literal.length;
        }
      } catch {
        // Ignore non-JSON-compatible JavaScript escape sequences.
      }
    },
    onRegex() {
      stats.regexLiteralCount += 1;
    },
    onComment() {
      stats.commentCount += 1;
    }
  };

  scanCodeRegion(source, 0, state, sink, null);
  return { literals, stats };
}

// 词法感知版括号配平（旧版不识别正则/注释，块级提取会在失步区失效）。
// 语义与旧版一致：只统计 openChar/closeChar 的配对，其余括号类型忽略。
export function findBalancedEndSmart(source, startIndex, openChar = '{', closeChar = '}') {
  const state = createLexerState();
  const noopSink = { onString() {}, onRegex() {}, onComment() {} };
  let depth = 0;
  let index = startIndex;

  while (index < source.length) {
    const char = source[index];

    if (isWhitespace(char)) {
      index += 1;
      continue;
    }
    if (char === '/' && source[index + 1] === '/') {
      const newlineIndex = source.indexOf('\n', index + 2);
      index = newlineIndex === -1 ? source.length : newlineIndex + 1;
      continue;
    }
    if (char === '/' && source[index + 1] === '*') {
      const closeIndex = source.indexOf('*/', index + 2);
      index = closeIndex === -1 ? source.length : closeIndex + 2;
      continue;
    }
    if (char === '\'' || char === '"' || char === '`') {
      index = scanStringLiteral(source, index, state, noopSink);
      continue;
    }
    if (char === '/') {
      if (state.regexAllowed) {
        const regexEnd = tryScanRegexLiteral(source, index);
        if (regexEnd !== -1) {
          index = regexEnd;
          state.regexAllowed = false;
          state.lastWord = '';
          state.lastSignificantChar = '/';
          continue;
        }
      }
      state.regexAllowed = true;
      state.lastWord = '';
      state.lastSignificantChar = '/';
      index += 1;
      continue;
    }

    // 维护词法状态（单词/数字/括号），保证后续正则判定正确
    if (IDENT_START_PATTERN.test(char)) {
      let end = index + 1;
      while (end < source.length && IDENT_PART_PATTERN.test(source[end])) {
        end += 1;
      }
      const word = source.slice(index, end);
      const isPropertyAccess = state.lastSignificantChar === '.';
      state.lastWord = isPropertyAccess ? '' : word;
      state.regexAllowed = !isPropertyAccess && REGEX_ALLOWED_KEYWORDS.has(word);
      state.lastSignificantChar = 'w';
      index = end;
      continue;
    }
    if (char >= '0' && char <= '9') {
      let end = index + 1;
      while (end < source.length && IDENT_PART_PATTERN.test(source[end])) {
        end += 1;
      }
      state.regexAllowed = false;
      state.lastWord = '';
      state.lastSignificantChar = 'n';
      index = end;
      continue;
    }
    if (char === '(' || char === '[' || char === '{') {
      state.regexAllowed = true;
      state.lastWord = '';
      state.lastSignificantChar = char;
    } else if (char === ')' || char === ']') {
      state.regexAllowed = false;
      state.lastWord = '';
      state.lastSignificantChar = char;
    } else {
      state.regexAllowed = true;
      state.lastWord = '';
      state.lastSignificantChar = char;
    }

    if (char === openChar) {
      depth += 1;
    } else if (char === closeChar) {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
    index += 1;
  }

  return -1;
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
    // 任意“键:"带引号英文值”形态（label/title/description/section/automation/protection/…）。
    // 通用模式让新出现的 UI 键名（如 Browser 设置块的 showLocalhostLinks/openWebLinks）也能被摘要。
    /[A-Za-z_$][\w$]*:"((?:[^"\\]|\\.)*)"/g,
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
