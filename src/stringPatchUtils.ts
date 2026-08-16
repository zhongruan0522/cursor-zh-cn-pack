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