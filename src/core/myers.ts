/**
 * Shortest edit script between two sequences of strings (Myers). Lines for
 * the block diff; words for the inline diff in the webview, so this module
 * must stay free of dependencies.
 */
export interface LineDiff {
  /** Per line (or token) of the new side: not present in the old side. */
  added: boolean[];
  /** Per line of the old side: not present in the new side. */
  removed: boolean[];
  /** Per line of the old side: the new line it sits at (matched, or where it was removed). */
  oldToNew: number[];
}

/** Beyond this many edits the texts are treated as entirely different. */
const MAX_EDITS = 5000;

export function splitLines(text: string): string[] {
  return text.split(/\r?\n/);
}

export function diffLines(a: string[], b: string[]): LineDiff {
  // Common prefix and suffix are the usual case; keep them out of the search.
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) {
    pre++;
  }
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) {
    suf++;
  }
  const ops = myers(a.slice(pre, a.length - suf), b.slice(pre, b.length - suf));

  const result: LineDiff = {
    added: new Array<boolean>(b.length).fill(false),
    removed: new Array<boolean>(a.length).fill(false),
    oldToNew: new Array<number>(a.length).fill(0),
  };
  let i = 0;
  let j = 0;
  const equal = (count: number) => {
    for (let c = 0; c < count; c++) {
      result.oldToNew[i++] = j++;
    }
  };
  equal(pre);
  for (const op of ops) {
    if (op === '=') {
      equal(1);
    } else if (op === '-') {
      result.removed[i] = true;
      result.oldToNew[i++] = j;
    } else {
      result.added[j++] = true;
    }
  }
  equal(suf);
  return result;
}

type Op = '=' | '-' | '+';

/** Shortest edit script from `a` to `b` (Myers, O((N+M)·D)). */
function myers(a: string[], b: string[]): Op[] {
  const n = a.length;
  const m = b.length;
  const max = Math.min(n + m, MAX_EDITS);
  const off = max + 1;
  const v = new Int32Array(2 * max + 3);
  // trace[d] holds v for k ∈ [-d-1, d+1] as it was before step d.
  const trace: Int32Array[] = [];
  for (let d = 0; d <= max; d++) {
    trace.push(v.slice(off - d - 1, off + d + 2));
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]) ? v[off + k + 1] : v[off + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[off + k] = x;
      if (x >= n && y >= m) {
        return backtrack(trace, n, m);
      }
    }
  }
  return [...new Array<Op>(n).fill('-'), ...new Array<Op>(m).fill('+')];
}

function backtrack(trace: Int32Array[], n: number, m: number): Op[] {
  const ops: Op[] = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 1; d >= 0; d--) {
    const v = trace[d];
    const at = (k: number) => v[k + d + 1];
    const k = x - y;
    const prevK = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1;
    const prevX = d === 0 ? 0 : at(prevK);
    const prevY = d === 0 ? 0 : prevX - prevK;
    while (x > prevX && y > prevY) {
      ops.push('=');
      x--;
      y--;
    }
    if (d > 0) {
      ops.push(x === prevX ? '+' : '-');
    }
    x = prevX;
    y = prevY;
  }
  return ops.reverse();
}
