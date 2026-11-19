// Closed ASCII row frames use the same lexical order as the former Array#sort.
// Each merge pass compares at most n pairs and writes at most n references.
// No value encoding or user comparator is invoked by this algorithm.
export function historyFrameSortCost(length: number): { comparisons: number; moves: number; slots: number } {
  const passes = length < 2 ? 0 : Math.ceil(Math.log2(length));
  return { comparisons: length * passes, moves: length * (passes + 1), slots: length < 2 ? length : 2 * length };
}

export function sortHistoryFrames(input: readonly string[]): string[] {
  let source = [...input];
  const size = source.length;
  if (size < 2) return source;
  let target = new Array<string>(size);
  for (let width = 1; width < size; width *= 2) {
    for (let start = 0; start < size; start += 2 * width) {
      const middle = Math.min(start + width, size), end = Math.min(start + 2 * width, size);
      let left = start, right = middle;
      for (let out = start; out < end; out++) {
        target[out] = right === end || left < middle && source[left]! <= source[right]!
          ? source[left++]! : source[right++]!;
      }
    }
    [source, target] = [target, source];
  }
  return source;
}
