// main.ts is mend, the CLI SPEC.md specifies: one patch tool for every AI edit format.
// It reads a patch in one of four formats (unified diff, SEARCH/REPLACE blocks, V4A, JSON edits),
// finds the lines each edit names at the first of three matching tiers (section 5), and writes
// every change or none, printing what it changed or why it failed. Node 22, the standard library
// alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands
// over to runner.ts (the last lines below): keep that hand-over and runner.ts as they are.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

interface Move {
  old: string;
  new: string;
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/* ---------- files, lines, matching (SPEC.md sections 3 and 5) ---------- */

function trimTrailST(s: string): string {
  return s.replace(/[ \t]+$/, '');
}
function trimST(s: string): string {
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}
function leadingST(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
}

/** A file's lines, its line break, and whether it ends with one (section 3). */
function splitFile(text: string): { lines: string[]; br: string; final: boolean } {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const fin = text.endsWith(br);
  if (fin) parts.pop();
  return { lines: parts, br, final: fin };
}
function joinFile(lines: string[], br: string, fin: boolean): string {
  if (lines.length === 0) return '';
  return lines.join(br) + (fin ? br : '');
}

function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return trimTrailST(a) === trimTrailST(b);
  return trimST(a) === trimST(b);
}

/** All positions where O matches lines at one tier; occurrences may overlap. */
function occurrences(lines: string[], o: string[], tier: number): number[] {
  const out: number[] = [];
  if (o.length === 0 || o.length > lines.length) return out;
  for (let i = 0; i + o.length <= lines.length; i += 1) {
    let ok = true;
    for (let j = 0; j < o.length; j += 1) {
      if (!lineEq(lines[i + j]!, o[j]!, tier)) { ok = false; break; }
    }
    if (ok) out.push(i);
  }
  return out;
}

function tiers(strict: boolean): number[] {
  return strict ? [0] : [0, 1, 2];
}

/** At tier 2, a non-context new line has O's first line's indent replaced by the file's (section 5). */
function reindent(line: string, p: string, f: string): string {
  if (line === '' || trimST(line) === '') return line;
  if (line.startsWith(p)) return f + line.slice(p.length);
  return line;
}

/** One body line of a unified hunk or a V4A chunk: context, old, new, or a `\` line. */
interface BodyLine {
  k: 'c' | 'd' | 'a' | 'b';
  t: string;
}
interface ChunkBody {
  body: BodyLine[];
}

/** O (context + old lines) and N (context + new lines) of a hunk/chunk body, in body order. */
function hunkON(h: ChunkBody): { o: string[]; n: { t: string; ctx: boolean; oi: number }[] } {
  const o: string[] = [];
  const n: { t: string; ctx: boolean; oi: number }[] = [];
  for (const bl of h.body) {
    if (bl.k === 'b') continue;
    if (bl.k === 'c') {
      const oi = o.length;
      o.push(bl.t);
      n.push({ t: bl.t, ctx: true, oi });
    } else if (bl.k === 'd') {
      o.push(bl.t);
    } else {
      n.push({ t: bl.t, ctx: false, oi: -1 });
    }
  }
  return { o, n };
}

/** Whether a `\` line follows the hunk's last context or `+` line. */
function lastCtxOrAddBs(h: ChunkBody): boolean {
  for (let i = h.body.length - 1; i >= 0; i -= 1) {
    const bl = h.body[i]!;
    if (bl.k === 'c' || bl.k === 'a') {
      return i + 1 < h.body.length && h.body[i + 1]!.k === 'b';
    }
  }
  return false;
}

/** The replacement lines for a match at `pos` of O at `tier`: context lines are the file's own. */
function replacement(n: { t: string; ctx: boolean; oi: number }[], o: string[], lines: string[], pos: number, tier: number): string[] {
  return n.map((x) => {
    if (x.ctx) return lines[pos + x.oi]!;
    if (tier === 2) return reindent(x.t, leadingST(o[0]!), leadingST(lines[pos]!));
    return x.t;
  });
}

/* ---------- JSON edits (SPEC.md section 9) ---------- */

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

/* ---------- unified diffs (SPEC.md section 6) ---------- */

interface Hunk extends ChunkBody {
  a: number;
}
interface Section {
  pairOld: string | null;
  pairNew: string | null;
  renOld: string | null;
  renNew: string | null;
  diffOld: string | null;
  diffNew: string | null;
  create: boolean;
  del: boolean;
  hunks: Hunk[];
}

function stripAB(p: string): string {
  if (p.startsWith('a/') || p.startsWith('b/')) return p.slice(2);
  return p;
}

/** The path after `--- ` / `+++ `: text after the four characters, up to the first tab, trimmed. */
function parsePathField(line: string): string {
  let s = line.slice(4);
  const tab = s.indexOf('\t');
  if (tab >= 0) s = s.slice(0, tab);
  return s.trim();
}

/** Apply a section's hunks in order to a file's text (section 6). */
function applyHunks(before: string, hunks: Hunk[], strict: boolean, failPath: string): string {
  const s = splitFile(before);
  const lines = s.lines;
  const br = s.br;
  let fin = s.final;
  let d = 0;
  for (const h of hunks) {
    const { o, n } = hunkON(h);
    if (o.length > 0) {
      let tierFound = -1;
      let occ: number[] = [];
      for (const t of tiers(strict)) {
        occ = occurrences(lines, o, t);
        if (occ.length > 0) { tierFound = t; break; }
      }
      if (tierFound < 0) throw new Fail('no-match', failPath);
      const target = h.a - 1 + d;
      let best = occ[0]!;
      let bestDist = Math.abs(best - target);
      for (const p of occ) {
        const dist = Math.abs(p - target);
        if (dist < bestDist) { best = p; bestDist = dist; }
      }
      const repl = replacement(n, o, lines, best, tierFound);
      if (best + o.length === lines.length) fin = !lastCtxOrAddBs(h);
      lines.splice(best, o.length, ...repl);
    } else {
      const ins = Math.min(Math.max(h.a + d, 0), lines.length);
      if (ins === lines.length) fin = !lastCtxOrAddBs(h);
      lines.splice(ins, 0, ...n.map((x) => x.t));
    }
    d += n.length - o.length;
  }
  return joinFile(lines, br, fin);
}

function sectionEdit(s: Section, moves: Move[], strict: boolean): Edit {
  const oldPath = s.pairOld ?? s.renOld ?? s.diffOld ?? '';
  const newPath = s.pairNew ?? s.renNew ?? s.diffNew ?? '';
  const isCreate = oldPath === '/dev/null' || s.create;
  const isDelete = newPath === '/dev/null' || s.del;
  if (isCreate) {
    return (tree) => {
      if (!safe(newPath)) throw new Fail('unsafe', newPath);
      if (tree.get(newPath) !== null) throw new Fail('exists', newPath);
      const addLines: string[] = [];
      let noNl = false;
      for (const h of s.hunks) {
        for (let bi = 0; bi < h.body.length; bi += 1) {
          if (h.body[bi]!.k === 'a') {
            addLines.push(h.body[bi]!.t);
            noNl = bi + 1 < h.body.length && h.body[bi + 1]!.k === 'b';
          }
        }
      }
      tree.now.set(newPath, addLines.length === 0 ? '' : addLines.join('\n') + (noNl ? '' : '\n'));
    };
  }
  if (isDelete) {
    return (tree) => {
      if (!safe(oldPath)) throw new Fail('unsafe', oldPath);
      if (tree.get(oldPath) === null) throw new Fail('missing', oldPath);
      tree.now.set(oldPath, null);
    };
  }
  if (oldPath !== newPath) {
    return (tree) => {
      if (!safe(oldPath)) throw new Fail('unsafe', oldPath);
      if (!safe(newPath)) throw new Fail('unsafe', newPath);
      const before = tree.get(oldPath);
      if (before === null) throw new Fail('missing', oldPath);
      if (tree.get(newPath) !== null) throw new Fail('exists', newPath);
      const out = applyHunks(before, s.hunks, strict, oldPath);
      tree.now.set(oldPath, null);
      tree.now.set(newPath, out);
      moves.push({ old: oldPath, new: newPath });
    };
  }
  return (tree) => {
    if (!safe(oldPath)) throw new Fail('unsafe', oldPath);
    const before = tree.get(oldPath);
    if (before === null) throw new Fail('missing', oldPath);
    tree.now.set(oldPath, applyHunks(before, s.hunks, strict, oldPath));
  };
}

function parseUnified(lines: string[], moves: Move[], strict: boolean): Edit[] {
  const sections: Section[] = [];
  let cur: Section | null = null;
  let curHunk: Hunk | null = null;
  const endHunk = (): void => {
    if (curHunk !== null && cur !== null) {
      while (curHunk.body.length > 0) {
        const last = curHunk.body[curHunk.body.length - 1]!;
        if (last.k === 'c' && last.t === '') curHunk.body.pop();
        else break;
      }
      cur.hunks.push(curHunk);
    }
    curHunk = null;
  };
  const newSection = (): Section => {
    const s: Section = { pairOld: null, pairNew: null, renOld: null, renNew: null, diffOld: null, diffNew: null, create: false, del: false, hunks: [] };
    sections.push(s);
    cur = s;
    return s;
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (curHunk !== null) {
      if (line.startsWith('diff --git ') || line.startsWith('@@') || (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ '))) {
        endHunk();
        continue;
      }
      if (line === '' || line[0] === ' ' || line[0] === '-' || line[0] === '+' || line[0] === '\\') {
        const k: BodyLine['k'] = line === '' ? 'c' : line[0] === ' ' ? 'c' : line[0] === '-' ? 'd' : line[0] === '+' ? 'a' : 'b';
        curHunk.body.push({ k, t: line === '' ? '' : line.slice(1) });
        i += 1;
        continue;
      }
      endHunk();
      continue;
    }
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(\S+) b\/(\S+)\s*$/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const s = newSection();
      s.diffOld = m[1]!;
      s.diffNew = m[2]!;
      i += 1;
      continue;
    }
    if (line.startsWith('@@')) {
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      curHunk = { a: parseInt(m[1]!, 10), body: [] };
      i += 1;
      continue;
    }
    if (line.startsWith('--- ')) {
      if ((lines[i + 1] ?? '').startsWith('+++ ')) {
        const oldP = stripAB(parsePathField(line));
        const newP = stripAB(parsePathField(lines[i + 1]!));
        if (cur !== null && cur.hunks.length === 0 && cur.pairOld === null) {
          cur.pairOld = oldP;
          cur.pairNew = newP;
        } else {
          const s = newSection();
          s.pairOld = oldP;
          s.pairNew = newP;
        }
        i += 2;
        continue;
      }
      if (cur !== null && cur.hunks.length === 0) throw new Exit2(`error: parse ${i + 2}`);
      i += 1;
      continue;
    }
    if (cur !== null && cur.hunks.length === 0) {
      if (line.startsWith('rename from ')) {
        if (cur.renOld === null) cur.renOld = line.slice('rename from '.length).trim();
      } else if (line.startsWith('rename to ')) {
        if (cur.renNew === null) cur.renNew = line.slice('rename to '.length).trim();
      } else if (line.startsWith('new file mode')) {
        cur.create = true;
      } else if (line.startsWith('deleted file mode')) {
        cur.del = true;
      }
      i += 1;
      continue;
    }
    i += 1;
  }
  endHunk();
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections.map((s) => sectionEdit(s, moves, strict));
}

/* ---------- SEARCH/REPLACE blocks (SPEC.md section 7) ---------- */

function srEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    const s = splitFile(before);
    const lines = s.lines;
    let tierFound = -1;
    let occ: number[] = [];
    for (const t of tiers(strict)) {
      occ = occurrences(lines, oldLines, t);
      if (occ.length > 0) { tierFound = t; break; }
    }
    if (tierFound < 0) throw new Fail('no-match', path);
    if (occ.length > 1) throw new Fail('ambiguous', path);
    const pos = occ[0]!;
    const repl = newLines.map((l) => (tierFound === 2 ? reindent(l, leadingST(oldLines[0]!), leadingST(lines[pos]!)) : l));
    lines.splice(pos, oldLines.length, ...repl);
    tree.now.set(path, joinFile(lines, s.br, s.final));
  };
}

function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let i = 0;
  let prevEnd = 0;
  let prevPath: string | null = null;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') { i += 1; continue; }
    const searchNo = i + 1;
    let path: string | null = null;
    for (let j = i - 1; j >= prevEnd; j -= 1) {
      const t = lines[j]!.trim();
      if (t === '' || t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) throw new Exit2(`error: parse ${searchNo}`);
    let eq = -1;
    for (let j = i + 1; j < lines.length; j += 1) {
      const t = lines[j]!.trimEnd();
      if (t === '=======') { eq = j; break; }
      if (t === '>>>>>>> REPLACE' || t === '<<<<<<< SEARCH') throw new Exit2(`error: parse ${searchNo}`);
    }
    if (eq < 0) throw new Exit2(`error: parse ${searchNo}`);
    let end = -1;
    for (let j = eq + 1; j < lines.length; j += 1) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') { end = j; break; }
    }
    if (end < 0) throw new Exit2(`error: parse ${searchNo}`);
    edits.push(srEdit(path, lines.slice(i + 1, eq), lines.slice(eq + 1, end), strict));
    prevPath = path;
    prevEnd = end + 1;
    i = end + 1;
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

/* ---------- V4A patches (SPEC.md section 8) ---------- */

interface VChunk extends ChunkBody {
  anchor: string | null;
  eof: boolean;
}

function v4aAddEdit(path: string, fileLines: string[]): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) !== null) throw new Fail('exists', path);
    tree.now.set(path, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
  };
}
function v4aDeleteEdit(path: string): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) === null) throw new Fail('missing', path);
    tree.now.set(path, null);
  };
}
function v4aUpdateEdit(path: string, moveTo: string | null, chunks: VChunk[], moves: Move[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    const s = splitFile(before);
    const lines = s.lines;
    const br = s.br;
    const fin = s.final;
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null) {
        let found = -1;
        for (const t of tiers(strict)) {
          for (let j = cursor; j < lines.length; j += 1) {
            if (lineEq(lines[j]!, ch.anchor, t)) { found = j; break; }
          }
          if (found >= 0) break;
        }
        if (found < 0) throw new Fail('no-match', path);
        cursor = found + 1;
      }
      const { o, n } = hunkON(ch);
      if (o.length > 0) {
        let tierFound = -1;
        let pos = -1;
        for (const t of tiers(strict)) {
          const occ = occurrences(lines, o, t).filter((p) => p >= cursor && (!ch.eof || p + o.length === lines.length));
          if (occ.length > 0) { tierFound = t; pos = occ[0]!; break; }
        }
        if (pos < 0) throw new Fail('no-match', path);
        const repl = replacement(n, o, lines, pos, tierFound);
        lines.splice(pos, o.length, ...repl);
        cursor = pos + repl.length;
      } else {
        const ins = ch.eof ? lines.length : cursor;
        lines.splice(ins, 0, ...n.map((x) => x.t));
        cursor = ins + n.length;
      }
    }
    const out = joinFile(lines, br, fin);
    if (moveTo !== null) {
      tree.now.set(path, null);
      tree.now.set(moveTo, out);
      moves.push({ old: path, new: moveTo });
    } else {
      tree.now.set(path, out);
    }
  };
}

function parseV4a(lines: string[], moves: Move[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (!blank(lines[i]!)) { last = i; break; }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const isSectionStart = (l: string): boolean => l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (blank(line)) { i += 1; continue; }
    if (line.startsWith('*** Add File: ')) {
      const path = line.slice('*** Add File: '.length).trim();
      i += 1;
      const fileLines: string[] = [];
      while (i < last && !isSectionStart(lines[i]!)) {
        const l = lines[i]!;
        if (l.startsWith('+')) fileLines.push(l.slice(1));
        else if (l === '') fileLines.push('');
        else throw new Exit2(`error: parse ${i + 1}`);
        i += 1;
      }
      while (fileLines.length > 0 && fileLines[fileLines.length - 1] === '') fileLines.pop();
      edits.push(v4aAddEdit(path, fileLines));
      continue;
    }
    if (line.startsWith('*** Delete File: ')) {
      const path = line.slice('*** Delete File: '.length).trim();
      i += 1;
      edits.push(v4aDeleteEdit(path));
      continue;
    }
    if (line.startsWith('*** Update File: ')) {
      const updateLineNo = i + 1;
      const path = line.slice('*** Update File: '.length).trim();
      i += 1;
      let moveTo: string | null = null;
      if (i < last && lines[i]!.startsWith('*** Move to: ')) {
        moveTo = lines[i]!.slice('*** Move to: '.length).trim();
        i += 1;
      }
      const chunks: VChunk[] = [];
      let curChunk: VChunk | null = null;
      const pushChunk = (): void => {
        if (curChunk !== null) { chunks.push(curChunk); curChunk = null; }
      };
      while (i < last && !isSectionStart(lines[i]!)) {
        const l = lines[i]!;
        if (l.trim() === '*** End of File') {
          if (curChunk === null) throw new Exit2(`error: parse ${i + 1}`);
          curChunk.eof = true;
          pushChunk();
          i += 1;
          continue;
        }
        if (l.startsWith('@@')) {
          pushChunk();
          const anchorText = l.slice(2).trim();
          curChunk = { anchor: anchorText === '' ? null : anchorText, eof: false, body: [] };
          i += 1;
          continue;
        }
        if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+') {
          if (curChunk === null && chunks.length > 0) throw new Exit2(`error: parse ${i + 1}`);
          if (curChunk === null) curChunk = { anchor: null, eof: false, body: [] };
          const k: BodyLine['k'] = l === '' ? 'c' : l[0] === ' ' ? 'c' : l[0] === '-' ? 'd' : 'a';
          curChunk.body.push({ k, t: l === '' ? '' : l.slice(1) });
          i += 1;
          continue;
        }
        throw new Exit2(`error: parse ${i + 1}`);
      }
      pushChunk();
      if (chunks.length > 0) {
        const lc = chunks[chunks.length - 1]!;
        while (lc.body.length > 0) {
          const b = lc.body[lc.body.length - 1]!;
          if (b.k === 'c' && b.t === '') lc.body.pop();
          else break;
        }
        while (chunks.length > 0) {
          const c = chunks[chunks.length - 1]!;
          if (c.body.length === 0 && c.anchor === null && !c.eof) chunks.pop();
          else break;
        }
      }
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${updateLineNo}`);
      edits.push(v4aUpdateEdit(path, moveTo, chunks, moves, strict));
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

/* ---------- invocation, output and exit codes (SPEC.md sections 1, 2 and 10) ---------- */

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  const moves: Move[] = [];
  let edits: Edit[];
  try {
    edits = kind === 'json' ? jsonEdits(text, lines)
      : kind === 'unified' ? parseUnified(lines, moves, strict)
      : kind === 'search-replace' ? parseSearchReplace(lines, strict)
      : parseV4a(lines, moves, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const byteCmp = (a: string, b: string): number => Buffer.compare(Buffer.from(a), Buffer.from(b));
  const rows: { key: string; text: string }[] = [];
  for (const p of [...tree.now.keys()].sort(byteCmp)) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  for (const mv of moves) {
    const oldWas = tree.original(mv.old);
    const oldNow = tree.now.get(mv.old);
    const newWas = tree.original(mv.new);
    const newNow = tree.now.get(mv.new);
    if (oldWas !== null && oldNow === null && newWas === null && newNow !== null) {
      const oi = rows.findIndex((r) => r.key === mv.old && r.text.startsWith('D '));
      const ni = rows.findIndex((r) => r.key === mv.new && r.text.startsWith('A '));
      if (oi >= 0 && ni >= 0) {
        rows.splice(Math.max(oi, ni), 1);
        rows.splice(Math.min(oi, ni), 1);
        rows.push({ key: mv.new, text: `R ${mv.old} -> ${mv.new}` });
      }
    }
  }
  rows.sort((a, b) => byteCmp(a.key, b.key));
  if (!check) {
    for (const p of [...tree.now.keys()].sort(byteCmp)) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...rows.map((r) => r.text), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}


const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
