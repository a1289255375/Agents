// Line diff shown in the web console so the user can review what the cloud agent changed.
import { splitLines } from "./text.mjs";

const lcsCellLimit = 250_000;

function editScript(a, b) {
  const n = a.length;
  const m = b.length;
  // The table is quadratic. Past the limit the region is shown as one removed block and one added block.
  if (n * m > lcsCellLimit) return [...a.map((line) => ["-", line]), ...b.map((line) => ["+", line])];
  const width = m + 1;
  const lcs = new Uint32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i * width + j] = a[i] === b[j]
        ? lcs[(i + 1) * width + j + 1] + 1
        : Math.max(lcs[(i + 1) * width + j], lcs[i * width + j + 1]);
    }
  }
  const ops = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push([" ", a[i]]);
      i++;
      j++;
    } else if (lcs[(i + 1) * width + j] >= lcs[i * width + j + 1]) {
      ops.push(["-", a[i++]]);
    } else {
      ops.push(["+", b[j++]]);
    }
  }
  while (i < n) ops.push(["-", a[i++]]);
  while (j < m) ops.push(["+", b[j++]]);
  return ops;
}

export function lineDiff(before, after, { context = 2, maxLines = 200 } = {}) {
  const a = splitLines(before);
  const b = splitLines(after);
  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++;
  let suffix = 0;
  while (suffix < a.length - prefix && suffix < b.length - prefix && a.at(-1 - suffix) === b.at(-1 - suffix)) suffix++;

  const lead = Math.min(context, prefix);
  const ops = [
    ...a.slice(prefix - lead, prefix).map((line) => [" ", line]),
    ...editScript(a.slice(prefix, a.length - suffix), b.slice(prefix, b.length - suffix)),
    ...a.slice(a.length - suffix, a.length - suffix + context).map((line) => [" ", line]),
  ];
  const shown = new Array(ops.length).fill(false);
  ops.forEach(([kind], index) => {
    if (kind === " ") return;
    for (let near = Math.max(0, index - context); near <= Math.min(ops.length - 1, index + context); near++) shown[near] = true;
  });

  const lines = [];
  let lineA = prefix - lead + 1;
  let lineB = lineA;
  for (let index = 0; index < ops.length; index++) {
    const [kind, line] = ops[index];
    if (shown[index]) {
      if (lines.length >= maxLines) {
        lines.push("…（其余改动未显示）");
        break;
      }
      if (!shown[index - 1]) lines.push(`@@ -${lineA} +${lineB} @@`);
      lines.push(kind + line);
    }
    if (kind !== "+") lineA++;
    if (kind !== "-") lineB++;
  }
  return lines.join("\n");
}
