export function countOccurrences(value: string, needle: string): number {
  if (!needle || !value.includes(needle)) {
    return 0;
  }

  let count = 0;
  let index = 0;
  while ((index = value.indexOf(needle, index)) !== -1) {
    count += 1;
    index += Math.max(needle.length, 1);
  }

  return count;
}

export interface CountNeedlesOptions {
  readonly chunkSize?: number;
  readonly onChunk?: (scanned: number, total: number) => void | Promise<void>;
}

const defaultCountChunkSize = 4 * 1024 * 1024;

/**
 * 一次全文遍历统计多个 needle 的出现次数（Aho-Corasick），
 * 替代「每个 needle 各做一遍 indexOf」的 O(N*M) 扫描。
 * 计数语义与 countOccurrences 一致：从左到右非重叠匹配（UTF-16 code unit）。
 */
export async function countNeedleOccurrences(
  content: string,
  needles: readonly string[],
  options?: CountNeedlesOptions
): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  const unique: string[] = [];

  for (const needle of needles) {
    if (!needle || counts.has(needle)) {
      continue;
    }

    counts.set(needle, 0);
    unique.push(needle);
  }

  if (unique.length === 0 || content.length === 0) {
    return counts;
  }

  const automaton = buildAhoCorasick(unique);
  const { children, failLinks, nodePatterns } = automaton;
  const lastEndExclusive = new Int32Array(unique.length);
  const chunkSize = Math.max(1024, options?.chunkSize ?? defaultCountChunkSize);

  let node = 0;
  for (let chunkStart = 0; chunkStart < content.length; chunkStart += chunkSize) {
    const chunkEnd = Math.min(chunkStart + chunkSize, content.length);
    for (let index = chunkStart; index < chunkEnd; index += 1) {
      const code = content.charCodeAt(index);
      let next = children[node].get(code);
      while (next === undefined && node !== 0) {
        node = failLinks[node];
        next = children[node].get(code);
      }

      if (next === undefined) {
        node = 0;
        continue;
      }

      node = next;
      const patterns = nodePatterns[node];
      if (patterns.length === 0) {
        continue;
      }

      // nodePatterns 已在构建阶段沿 fail 链合并（output consolidation），
      // 此处只需检查当前节点，无需运行时遍历 fail 链。
      const matchEnd = index + 1;
      for (const patternIndex of patterns) {
        const patternStart = matchEnd - unique[patternIndex].length;
        if (patternStart >= lastEndExclusive[patternIndex]) {
          lastEndExclusive[patternIndex] = matchEnd;
          counts.set(unique[patternIndex], (counts.get(unique[patternIndex]) ?? 0) + 1);
        }
      }
    }

    if (options?.onChunk) {
      await options.onChunk(chunkEnd, content.length);
    }
  }

  return counts;
}

interface AhoCorasickAutomaton {
  readonly children: Array<Map<number, number>>;
  readonly failLinks: readonly number[];
  readonly nodePatterns: Array<readonly number[]>;
}

function buildAhoCorasick(patterns: readonly string[]): AhoCorasickAutomaton {
  const children: Array<Map<number, number>> = [new Map()];
  const failLinks: number[] = [0];
  const nodePatterns: number[][] = [[]];

  for (let patternIndex = 0; patternIndex < patterns.length; patternIndex += 1) {
    const pattern = patterns[patternIndex];
    let node = 0;
    for (let index = 0; index < pattern.length; index += 1) {
      const code = pattern.charCodeAt(index);
      let next = children[node].get(code);
      if (next === undefined) {
        next = children.length;
        children.push(new Map());
        failLinks.push(0);
        nodePatterns.push([]);
        children[node].set(code, next);
      }
      node = next;
    }
    nodePatterns[node].push(patternIndex);
  }

  const queue: number[] = [...children[0].values()];
  for (let head = 0; head < queue.length; head += 1) {
    const node = queue[head];
    for (const [code, child] of children[node]) {
      let fail = failLinks[node];
      let next = children[fail].get(code);
      while (next === undefined && fail !== 0) {
        fail = failLinks[fail];
        next = children[fail].get(code);
      }

      failLinks[child] = next !== undefined && next !== child ? next : 0;
      // 输出合并：把 fail 节点的模式并入子节点（BFS 序保证 fail 节点先完成合并），
      // 运行时命中当前节点即可拿到所有以后缀结尾的模式。
      const failNode = failLinks[child];
      if (failNode !== 0 && nodePatterns[failNode].length > 0) {
        nodePatterns[child].push(...nodePatterns[failNode]);
      }
      queue.push(child);
    }
  }

  return { children, failLinks, nodePatterns };
}

export function replaceAll(value: string, source: string, target: string): string {
  return replaceAllWithCount(value, source, target).value;
}

export function replaceAllWithCount(value: string, source: string, target: string): { readonly value: string; readonly count: number } {
  if (!source || source === target || !value.includes(source)) {
    return { value, count: 0 };
  }

  const parts: string[] = [];
  let index = 0;
  let position = 0;
  let count = 0;
  while ((position = value.indexOf(source, index)) !== -1) {
    parts.push(value.slice(index, position));
    parts.push(target);
    index = position + source.length;
    count += 1;
  }

  parts.push(value.slice(index));
  return { value: parts.join(''), count };
}

export interface MultiReplacement {
  readonly source: string;
  readonly target: string;
}

export interface MultiReplaceResult {
  readonly value: string;
  readonly counts: ReadonlyMap<string, number>;
}

interface MultiMatchRecord {
  readonly start: number;
  readonly end: number;
  readonly ruleIndex: number;
}

/**
 * 单趟遍历（Aho-Corasick）应用多条 source→target 替换，
 * 替代「每条规则各做一遍全文 replaceAllWithCount」的 O(N*M) 逐条替换。
 *
 * 与逐条顺序替换保持等价（含每条规则从左到右非重叠语义）：
 * - 相同 source 去重保留首条（后续同 source 规则在逐条模式下必然空转）；
 * - 不同规则的命中区间重叠时，按规则顺序以先到先得消解 —— 与逐条模式中
 *   「先替换的规则会破坏后续规则的重叠命中」语义一致；
 * - 拼接后再对结果做一次全量扫描（含重叠命中）：逐条语义下规则 i 只会替换
 *   「它执行之前就已存在」的文本，因此结果中允许残留的 source 命中必须
 *   完全落在「序号大于 i 的规则插入的 target」内；一旦命中触及任何序号
 *   更小的插入区（或裸露在原文里），说明两种语义不等价，返回 undefined
 *   由调用方回退逐条替换。
 */
export async function replaceAllMulti(
  value: string,
  replacements: readonly MultiReplacement[],
  options?: CountNeedlesOptions
): Promise<MultiReplaceResult | undefined> {
  const rules: MultiReplacement[] = [];
  const seenSources = new Set<string>();
  for (const item of replacements) {
    if (!item.source || item.source === item.target || seenSources.has(item.source)) {
      continue;
    }
    seenSources.add(item.source);
    rules.push(item);
  }

  const counts = new Map<string, number>();
  if (rules.length === 0 || value.length === 0) {
    return { value, counts };
  }

  const sources = rules.map(rule => rule.source);
  const automaton = buildAhoCorasick(sources);
  const { children, failLinks, nodePatterns } = automaton;
  const lastEndExclusive = new Int32Array(rules.length);
  const matches: MultiMatchRecord[] = [];
  const chunkSize = Math.max(1024, options?.chunkSize ?? defaultCountChunkSize);

  let node = 0;
  for (let chunkStart = 0; chunkStart < value.length; chunkStart += chunkSize) {
    const chunkEnd = Math.min(chunkStart + chunkSize, value.length);
    for (let index = chunkStart; index < chunkEnd; index += 1) {
      const code = value.charCodeAt(index);
      let next = children[node].get(code);
      while (next === undefined && node !== 0) {
        node = failLinks[node];
        next = children[node].get(code);
      }

      if (next === undefined) {
        node = 0;
        continue;
      }

      node = next;
      const patterns = nodePatterns[node];
      if (patterns.length === 0) {
        continue;
      }

      const matchEnd = index + 1;
      for (const ruleIndex of patterns) {
        const start = matchEnd - sources[ruleIndex].length;
        if (start >= lastEndExclusive[ruleIndex]) {
          lastEndExclusive[ruleIndex] = matchEnd;
          matches.push({ start, end: matchEnd, ruleIndex });
        }
      }
    }

    if (options?.onChunk) {
      await options.onChunk(chunkEnd, value.length);
    }
  }

  if (matches.length === 0) {
    return { value, counts };
  }

  // 按规则顺序（先到先得）消解跨规则重叠：与逐条替换中先应用规则破坏后续重叠命中的行为一致。
  const accepted = resolveMatchesByRulePriority(matches);

  const parts: string[] = [];
  const initialRegions: MultiRegionRecord[] = [];
  let regions: readonly MultiRegionRecord[] = initialRegions;
  let cursor = 0;
  let resultLength = 0;
  for (const match of accepted) {
    const piece = value.slice(cursor, match.start);
    parts.push(piece);
    resultLength += piece.length;

    const target = rules[match.ruleIndex].target;
    parts.push(target);
    initialRegions.push({ start: resultLength, end: resultLength + target.length, ruleIndex: match.ruleIndex });
    resultLength += target.length;

    const source = sources[match.ruleIndex];
    counts.set(source, (counts.get(source) ?? 0) + 1);
    cursor = match.end;
  }

  parts.push(value.slice(cursor));

  // 逐条语义下，规则 i 还会替换「更早规则插入的 target 中」出现的 i.source（链式替换）。
  // 单趟主扫描无法在一遍内复现：事后全量扫描结果，发现此类命中时补一轮替换，直到收敛。
  for (let round = 0; round < maxMultiReplaceRounds; round += 1) {
    const text = parts.join('');
    const incompatible = await findIncompatibleOccurrences(automaton, sources, text, regions);
    if (incompatible === undefined) {
      return undefined;
    }
    if (incompatible.length === 0) {
      return { value: text, counts };
    }

    const splices = resolveMatchesByRulePriority(incompatible);
    const rewritten = applySplices(text, regions, splices, rules, counts);
    parts.length = 0;
    parts.push(rewritten.text);
    regions = rewritten.regions;
  }

  return undefined;
}

interface MultiRegionRecord {
  readonly start: number;
  readonly end: number;
  readonly ruleIndex: number;
}

/** 链式替换补偿的最大轮数：超过说明规则间存在超长替换链，保守回退逐条替换。 */
const maxMultiReplaceRounds = 8;

/**
 * 事后校验：在单趟结果里再扫一遍所有 source（含重叠命中）。
 * 逐条替换语义下，规则 i 只会替换「它执行之前就已存在」的文本：
 * - 命中触及序号小于 i 的规则插入的 target → 逐条模式在规则 i 时必然替换它，
 *   收集为待补替换命中（链式替换补偿）；
 * - 命中完全落在序号大于等于 i 的插入区内 / 只触及更晚的插入区 → 两种语义都会保留，等价；
 * - 命中未触及任何插入区却仍存在 → 理论不可达，返回 undefined 由调用方整体回退。
 */
async function findIncompatibleOccurrences(
  automaton: AhoCorasickAutomaton,
  sources: readonly string[],
  value: string,
  regions: readonly MultiRegionRecord[]
): Promise<MultiMatchRecord[] | undefined> {
  const incompatible: MultiMatchRecord[] = [];

  const classify = (patternIndex: number, start: number, end: number): 0 | 1 | 2 => {
    let touchesRegion = false;
    for (const region of regions) {
      if (region.start >= end) {
        break;
      }
      if (region.end > start) {
        if (region.ruleIndex < patternIndex) {
          return 1;
        }
        touchesRegion = true;
      }
    }
    return touchesRegion ? 0 : 2;
  };

  const { children, failLinks, nodePatterns } = automaton;
  const chunkSize = defaultCountChunkSize;
  let node = 0;

  for (let chunkStart = 0; chunkStart < value.length; chunkStart += chunkSize) {
    const chunkEnd = Math.min(chunkStart + chunkSize, value.length);
    for (let index = chunkStart; index < chunkEnd; index += 1) {
      const code = value.charCodeAt(index);
      let next = children[node].get(code);
      while (next === undefined && node !== 0) {
        node = failLinks[node];
        next = children[node].get(code);
      }

      if (next === undefined) {
        node = 0;
        continue;
      }

      node = next;
      const patterns = nodePatterns[node];
      if (patterns.length === 0) {
        continue;
      }

      const matchEnd = index + 1;
      for (const patternIndex of patterns) {
        const verdict = classify(patternIndex, matchEnd - sources[patternIndex].length, matchEnd);
        if (verdict === 1) {
          incompatible.push({ start: matchEnd - sources[patternIndex].length, end: matchEnd, ruleIndex: patternIndex });
        } else if (verdict === 2) {
          return undefined;
        }
      }
    }

    await new Promise<void>(resolve => setTimeout(resolve, 0));
  }

  return incompatible;
}

/**
 * 链式替换补偿：把事后校验发现的命中应用到当前文本上。
 * 被替换区间变成新插入区（ruleIndex 取补替换规则），
 * 旧插入区未被覆盖的残留片段平移后保留原 ruleIndex，供下一轮校验继续判定。
 */
function applySplices(
  text: string,
  regions: readonly MultiRegionRecord[],
  splices: readonly MultiMatchRecord[],
  rules: readonly MultiReplacement[],
  counts: Map<string, number>
): { readonly text: string; readonly regions: readonly MultiRegionRecord[] } {
  const pieces: string[] = [];
  const spliceRegions: MultiRegionRecord[] = [];
  let cursor = 0;
  let length = 0;

  for (const splice of splices) {
    const piece = text.slice(cursor, splice.start);
    pieces.push(piece);
    length += piece.length;

    const rule = rules[splice.ruleIndex];
    pieces.push(rule.target);
    spliceRegions.push({ start: length, end: length + rule.target.length, ruleIndex: splice.ruleIndex });
    length += rule.target.length;
    counts.set(rule.source, (counts.get(rule.source) ?? 0) + 1);
    cursor = splice.end;
  }

  pieces.push(text.slice(cursor));
  const nextText = pieces.join('');

  // splices 与 regions 均按位置有序且各自互不重叠，双指针把旧 region 切成残留段并平移。
  const shifted: MultiRegionRecord[] = [];
  let spliceIndex = 0;
  let delta = 0;
  for (const region of regions) {
    let start = region.start;
    while (start < region.end) {
      while (spliceIndex < splices.length && splices[spliceIndex].end <= start) {
        const consumed = splices[spliceIndex];
        delta += rules[consumed.ruleIndex].target.length - (consumed.end - consumed.start);
        spliceIndex += 1;
      }

      const upcoming = splices[spliceIndex];
      if (upcoming === undefined || upcoming.start >= region.end) {
        shifted.push({ start: start + delta, end: region.end + delta, ruleIndex: region.ruleIndex });
        break;
      }

      if (upcoming.start > start) {
        shifted.push({ start: start + delta, end: upcoming.start + delta, ruleIndex: region.ruleIndex });
      }

      start = Math.max(start, upcoming.end);
      delta += rules[upcoming.ruleIndex].target.length - (upcoming.end - upcoming.start);
      spliceIndex += 1;
    }
  }

  const nextRegions = [...spliceRegions, ...shifted].sort((left, right) => left.start - right.start);
  return { text: nextText, regions: nextRegions };
}

/** 以规则顺序为优先级消解重叠命中，返回按位置排序且互不重叠的命中列表。 */
function resolveMatchesByRulePriority(matches: MultiMatchRecord[]): MultiMatchRecord[] {
  const byRuleOrder = [...matches].sort((left, right) => left.ruleIndex - right.ruleIndex || left.start - right.start);
  const acceptedStarts: number[] = [];
  const accepted: MultiMatchRecord[] = [];

  for (const match of byRuleOrder) {
    // 二分定位插入点，检查与已接受区间是否重叠。
    let low = 0;
    let high = acceptedStarts.length;
    while (low < high) {
      const mid = (low + high) >> 1;
      if (acceptedStarts[mid] <= match.start) {
        low = mid + 1;
      } else {
        high = mid;
      }
    }

    const previous = low - 1;
    if (previous >= 0 && accepted[previous].end > match.start) {
      continue;
    }

    if (low < accepted.length && accepted[low].start < match.end) {
      continue;
    }

    acceptedStarts.splice(low, 0, match.start);
    accepted.splice(low, 0, match);
  }

  return accepted;
}