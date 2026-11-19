const EDGE = new Set(
  Array.from(`.,;:!?'"()[]{}<>，。；：！？、“”‘’（）【】《》「」『』、·-—`),
);

export function textKey(text: string): string {
  const compact = text.normalize('NFKC').trim().replace(/\s+/g, '');
  let start = 0;
  let end = compact.length;
  while (start < end && EDGE.has(compact[start])) start += 1;
  while (end > start && EDGE.has(compact[end - 1])) end -= 1;
  return compact.slice(start, end).replace(/[A-Z]/g, (char) => char.toLowerCase());
}
