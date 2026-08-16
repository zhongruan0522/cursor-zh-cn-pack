import {
  extractQuotedEnglishPhrases,
  findBalancedEnd,
  hasEnglishText
} from './workbench-scan-shared.mjs';

function openCharIndex(match, openChar) {
  const relative = match[0].lastIndexOf(openChar);
  return (match.index ?? 0) + relative;
}

function validateBlock(kind, source) {
  switch (kind) {
    case 'function-switch':
      return /switch\s*\(/.test(source)
        && /return"/.test(source)
        && extractQuotedEnglishPhrases(source).length > 0;
    case 'memo-arrow':
      return /=\w+\(\(\)=>\{/.test(source) && /return /.test(source);
    case 'arrow-switch':
      return /=>\{switch/.test(source) && /return"/.test(source);
    case 'items-array':
    case 'array-literal':
      return /label:"/.test(source) && extractQuotedEnglishPhrases(source).length > 0;
    case 'nav-map':
      return /general:"/.test(source) || /chat:"/.test(source) || /appearance:"/.test(source);
    case 'mode-object':
      return /label:"/.test(source) && /(?:placeholder|description):"/.test(source);
    default:
      return true;
  }
}

// 块级提取锚点：只使用语义稳定的结构特征（function/items/id 等语义键名、
// React.memo 箭头形态、导航映射的 general/chat 键），不依赖压缩符号。
export const BLOCK_ANCHORS = [
  {
    kind: 'function-switch',
    regex: /function [A-Za-z_$][\w$]*\([^)]*\)\{/g,
    openChar: '{',
    closeChar: '}'
  },
  {
    // React.memo：X=me(()=>{…})，me 为压缩符号，泛化为任意短标识符
    kind: 'memo-arrow',
    regex: /[A-Za-z_$][\w$]*=[A-Za-z_$][\w$]{0,5}\(\(\)=>\{/g,
    openChar: '{',
    closeChar: '}'
  },
  {
    kind: 'arrow-switch',
    regex: /[A-Za-z_$][\w$]*=\w+=>\{switch/g,
    openChar: '{',
    closeChar: '}'
  },
  {
    kind: 'items-array',
    regex: /items:\[/g,
    openChar: '[',
    closeChar: ']',
    sourcePrefix: 'items:'
  },
  {
    kind: 'array-literal',
    regex: /[A-Za-z_$][\w$]*=\[\{id:/g,
    openChar: '[',
    closeChar: ']'
  },
  {
    // 设置页导航映射：X={general:"General",…}，原锚点 anh= 中的 anh 为压缩符号，
    // 泛化为“对象字面量首个键为 general”，语义稳定。
    kind: 'nav-map',
    regex: /[A-Za-z_$][\w$]*=\{general:"/g,
    openChar: '{',
    closeChar: '}'
  },
  {
    kind: 'mode-object',
    regex: /var [A-Za-z_$][\w$]*=\{id:/g,
    openChar: '{',
    closeChar: '}'
  }
];

export function extractBlockCandidates(workbenchSource, anchors = BLOCK_ANCHORS) {
  const blocks = [];

  for (const anchor of anchors) {
    for (const match of workbenchSource.matchAll(anchor.regex)) {
      const openIndex = openCharIndex(match, anchor.openChar);
      const closeIndex = findBalancedEnd(
        workbenchSource,
        openIndex,
        anchor.openChar,
        anchor.closeChar
      );
      if (closeIndex === -1) continue;

      const startIndex = anchor.sourcePrefix
        ? (match.index ?? 0)
        : (match.index ?? 0);
      const source = workbenchSource.slice(startIndex, closeIndex + 1);
      if (!validateBlock(anchor.kind, source)) continue;
      if (!hasEnglishText(source)) continue;

      blocks.push({
        kind: anchor.kind,
        source,
        index: startIndex,
        key: extractBlockKey(anchor.kind, source)
      });
    }
  }

  return blocks;
}

function extractBlockKey(kind, source) {
  if (kind === 'function-switch') {
    return source.match(/^function ([A-Za-z_$][\w$]*)/)?.[1];
  }
  if (kind === 'memo-arrow' || kind === 'arrow-switch' || kind === 'array-literal') {
    return source.match(/^([A-Za-z_$][\w$]*)=/)?.[1];
  }
  if (kind === 'mode-object') {
    return source.match(/^var ([A-Za-z_$][\w$]*)/)?.[1];
  }
  if (kind === 'nav-map') {
    return 'anh';
  }
  if (kind === 'items-array') {
    return 'items';
  }
  return undefined;
}

export function pruneSubsumedCandidates(candidates) {
  const sorted = [...candidates].sort((a, b) => b.source.length - a.source.length);
  const kept = [];

  for (const candidate of sorted) {
    const subsumed = kept.some((other) => {
      if (other.source === candidate.source) return false;
      return other.source.includes(candidate.source);
    });
    if (!subsumed) {
      kept.push(candidate);
    }
  }

  return kept;
}
