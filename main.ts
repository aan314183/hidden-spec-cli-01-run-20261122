// mend — one patch tool for every AI edit format.
//
// Applies an edit a model wrote (unified diff, SEARCH/REPLACE blocks, a V4A
// patch, or JSON tool calls) to the tree of text files rooted at the working
// directory, following SPEC.md (version 1) of hidden-spec-cli-01-run-20261122.
// Every file is changed or none is: edits apply in order to an in-memory
// copy of the tree and are only written out when none of them failed.
//
// When MAKEFUN_ENV_URL is set, this process is the trial runner instead: it
// hands over to runner.ts, which runs this same CLI once per check the env
// lists. Otherwise it is the CLI itself.

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { runTrial } from './runner.ts';

// ---------------------------------------------------------------------------
// Small helpers

type Brk = '\n' | '\r\n';

/** A file as lines plus the facts needed to write it back the same way. */
interface FileState {
  lines: string[];
  brk: Brk;
  endsWithBreak: boolean;
}

/** Split a file's text the way SPEC section 3 says. */
function parseFileText(text: string): FileState {
  if (text === '') return { lines: [], brk: '\n', endsWithBreak: false };
  const idx = text.indexOf('\n');
  const brk: Brk = idx > 0 && text[idx - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(brk);
  const endsWithBreak = text.endsWith(brk);
  if (endsWithBreak) parts.pop();
  return { lines: parts, brk, endsWithBreak };
}

/** Join a file's lines back, honouring its own break and final break. */
function serializeFile(f: FileState): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.brk) + (f.endsWithBreak ? f.brk : '');
}

/** A patch's lines: split at \n, one trailing \r removed, no empty piece
 *  after a final \n. */
function splitPatchLines(text: string): string[] {
  if (text === '') return [];
  const parts = text.split('\n');
  if (text.endsWith('\n')) parts.pop();
  return parts.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

/** A new_str's lines, by the same rule (SPEC section 9). */
function splitNewStr(s: string): string[] {
  return splitPatchLines(s);
}

function rstripWS(s: string): string {
  let e = s.length;
  while (e > 0 && (s[e - 1] === ' ' || s[e - 1] === '\t')) e -= 1;
  return s.slice(0, e);
}

function stripWS(s: string): string {
  let a = 0;
  while (a < s.length && (s[a] === ' ' || s[a] === '\t')) a += 1;
  let e = s.length;
  while (e > a && (s[e - 1] === ' ' || s[e - 1] === '\t')) e -= 1;
  return s.slice(a, e);
}

function leadingWS(s: string): string {
  let a = 0;
  while (a < s.length && (s[a] === ' ' || s[a] === '\t')) a += 1;
  return s.slice(0, a);
}

function isWSOnly(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== ' ' && s[i] !== '\t') return false;
  }
  return true;
}

function byteCompare(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

function writeStdout(lines: string[]): void {
  if (lines.length === 0) return;
  writeSync(1, lines.map((l) => l + '\n').join(''));
}

// ---------------------------------------------------------------------------
// Paths

/** SPEC section 3: a path is safe when it is not empty, does not start with
 *  `/`, holds no `\`, and none of its segments is empty, `.` or `..`. */
function isSafePath(p: string): boolean {
  if (p === '') return false;
  if (p.startsWith('/')) return false;
  if (p.includes('\\')) return false;
  const segs = p.split('/');
  for (const s of segs) {
    if (s === '' || s === '.' || s === '..') return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Line matching (SPEC section 5)

function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return rstripWS(a) === rstripWS(b);
  return stripWS(a) === stripWS(b);
}

/** Every 0-based position at or after `from` where `pat` matches. */
function findOccurrences(lines: string[], pat: string[], tier: number, from = 0): number[] {
  const out: number[] = [];
  if (pat.length === 0) return out;
  for (let i = from; i + pat.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < pat.length; j++) {
      if (!lineEq(lines[i + j], pat[j], tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier (0, then 1, then 2; only 0 when strict) at which `pat`
 *  occurs at or after `from`, with its positions. */
function findTier(
  lines: string[],
  pat: string[],
  strict: boolean,
  from = 0,
): { tier: number; occ: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const occ = findOccurrences(lines, pat, t, from);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

/** One line of N: a context line is written as the file's own matched line,
 *  every other line is written as the patch wrote it, re-indented at tier 2. */
interface NLine {
  text: string;
  ctx: boolean;
  ctxIndex: number; // index of this context line inside O, else -1
}

function buildReplacement(
  lines: string[],
  pos: number,
  nLines: NLine[],
  oLines: string[],
  tier: number,
): string[] {
  const out: string[] = [];
  const p = oLines.length > 0 ? leadingWS(oLines[0]) : '';
  const f = pos < lines.length ? leadingWS(lines[pos]) : '';
  for (const nl of nLines) {
    if (nl.ctx) {
      out.push(lines[pos + nl.ctxIndex]);
    } else if (tier === 2) {
      const t = nl.text;
      if (t !== '' && !isWSOnly(t) && t.startsWith(p)) out.push(f + t.slice(p.length));
      else out.push(t);
    } else {
      out.push(nl.text);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// The tree

type ApplyResult = { ok: true } | { ok: false; code: string; path: string };

function applyFail(code: string, path: string): ApplyResult {
  return { ok: false, code, path };
}

/** The working directory's files, before and as the edits leave them. */
class Tree {
  before = new Map<string, string>();
  dirs = new Set<string>();
  cur = new Map<string, string>();
  moves: Array<[string, string]> = [];

  constructor() {
    this.walk('.');
    this.cur = new Map(this.before);
  }

  private walk(dir: string): void {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = dir === '.' ? e.name : dir + '/' + e.name;
      if (e.isDirectory()) {
        this.dirs.add(p);
        this.walk(p);
      } else if (e.isFile()) {
        try {
          this.before.set(p, readFileSync(p, 'utf8'));
        } catch {
          // An unreadable file is left out of the tree.
        }
      } else if (e.isSymbolicLink()) {
        try {
          const st = statSync(p);
          if (st.isFile()) this.before.set(p, readFileSync(p, 'utf8'));
          else if (st.isDirectory()) {
            this.dirs.add(p);
            this.walk(p);
          }
        } catch {
          // A broken link is left out of the tree.
        }
      }
    }
  }

  exists(p: string): boolean {
    return this.cur.has(p) || this.dirs.has(p);
  }

  read(p: string): string | undefined {
    return this.cur.get(p);
  }
}

/** The change lines for a finished run, writing the tree out unless this is
 *  a --check run. SPEC section 2: one line per path whose state changed, in
 *  byte order of the paths; a move prints `R <old> -> <new>` and sorts by
 *  `<new>`. */
function finish(tree: Tree, checkOnly: boolean): string[] {
  const lines: Array<{ key: string; text: string }> = [];
  const usedOld = new Set<string>();
  const usedNew = new Set<string>();
  for (const [o, n] of tree.moves) {
    if (tree.before.has(o) && !tree.cur.has(o) && !tree.before.has(n) && tree.cur.has(n)) {
      lines.push({ key: n, text: `R ${o} -> ${n}` });
      usedOld.add(o);
      usedNew.add(n);
    }
  }
  const all = new Set<string>([...tree.before.keys(), ...tree.cur.keys()]);
  for (const p of all) {
    if (usedOld.has(p) || usedNew.has(p)) continue;
    const b = tree.before.get(p);
    const a = tree.cur.get(p);
    if (b === undefined && a !== undefined) lines.push({ key: p, text: `A ${p}` });
    else if (b !== undefined && a === undefined) lines.push({ key: p, text: `D ${p}` });
    else if (b !== undefined && a !== undefined && b !== a) lines.push({ key: p, text: `M ${p}` });
  }
  lines.sort((x, y) => byteCompare(x.key, y.key));
  if (!checkOnly) {
    for (const p of all) {
      const b = tree.before.get(p);
      const a = tree.cur.get(p);
      if (b === a) continue;
      if (a === undefined) {
        try {
          unlinkSync(p);
        } catch {
          // The file was already gone.
        }
      } else {
        const d = dirname(p);
        if (d !== '.' && d !== '') mkdirSync(d, { recursive: true });
        writeFileSync(p, a, 'utf8');
      }
    }
  }
  return lines.map((l) => l.text);
}

// ---------------------------------------------------------------------------
// Edits

interface Edit {
  apply(tree: Tree, strict: boolean): ApplyResult;
}

/** One body line of a unified hunk or a V4A chunk. */
interface BodyLine {
  kind: 'ctx' | 'old' | 'new' | 'bs';
  text: string;
}

function parseBodyLine(bl: string): BodyLine {
  if (bl === '') return { kind: 'ctx', text: '' };
  const c = bl[0];
  if (c === ' ') return { kind: 'ctx', text: bl.slice(1) };
  if (c === '-') return { kind: 'old', text: bl.slice(1) };
  if (c === '+') return { kind: 'new', text: bl.slice(1) };
  return { kind: 'bs', text: bl.slice(1) };
}

/** Split a hunk/chunk body into its old lines O and its new lines N. */
function splitBody(body: BodyLine[]): { oParts: string[]; nParts: NLine[] } {
  const oParts: string[] = [];
  const nParts: NLine[] = [];
  let oIdx = 0;
  for (const b of body) {
    if (b.kind === 'ctx') {
      oParts.push(b.text);
      nParts.push({ text: b.text, ctx: true, ctxIndex: oIdx });
      oIdx += 1;
    } else if (b.kind === 'old') {
      oParts.push(b.text);
      oIdx += 1;
    } else if (b.kind === 'new') {
      nParts.push({ text: b.text, ctx: false, ctxIndex: -1 });
    }
  }
  return { oParts, nParts };
}

/** Does a `\` line follow the hunk's last context or `+` line? (SPEC 6.) */
function backslashAfterLastCtxOrNew(body: BodyLine[]): boolean {
  let last = -1;
  for (let i = 0; i < body.length; i++) {
    if (body[i].kind === 'ctx' || body[i].kind === 'new') last = i;
  }
  if (last === -1) return false;
  return last + 1 < body.length && body[last + 1].kind === 'bs';
}

interface Hunk {
  a: number;
  body: BodyLine[];
}

/** Apply a section's hunks in order to a file's lines (SPEC section 6). */
function applyHunks(
  f: FileState,
  hunks: Hunk[],
  strict: boolean,
): { ok: true; file: FileState } | { ok: false; code: string } {
  const lines = [...f.lines];
  let endsWithBreak = f.endsWithBreak;
  let d = 0;
  for (const h of hunks) {
    const { oParts, nParts } = splitBody(h.body);
    if (oParts.length > 0) {
      const found = findTier(lines, oParts, strict);
      if (found === null) return { ok: false, code: 'no-match' };
      const target = h.a - 1 + d;
      let best = found.occ[0];
      let bestDist = Math.abs(best - target);
      for (const p of found.occ) {
        const dist = Math.abs(p - target);
        if (dist < bestDist) {
          best = p;
          bestDist = dist;
        }
      }
      const pos = best;
      const repl = buildReplacement(lines, pos, nParts, oParts, found.tier);
      const oldLen = lines.length;
      const touchesEnd = pos + oParts.length === oldLen;
      lines.splice(pos, oParts.length, ...repl);
      if (touchesEnd) endsWithBreak = !backslashAfterLastCtxOrNew(h.body);
      d += nParts.length - oParts.length;
    } else {
      const oldLen = lines.length;
      let pos = h.a + d;
      if (pos < 0) pos = 0;
      if (pos > oldLen) pos = oldLen;
      const repl = nParts.map((n) => n.text);
      if (repl.length > 0) {
        lines.splice(pos, 0, ...repl);
        if (pos === oldLen) endsWithBreak = !backslashAfterLastCtxOrNew(h.body);
      }
      d += repl.length;
    }
  }
  return { ok: true, file: { lines, brk: f.brk, endsWithBreak } };
}

/** One unified-diff section (SPEC section 6). */
class UnifiedEdit implements Edit {
  oldPath: string | null;
  newPath: string | null;
  isCreate: boolean;
  isDelete: boolean;
  hunks: Hunk[];

  constructor(
    oldPath: string | null,
    newPath: string | null,
    isCreate: boolean,
    isDelete: boolean,
    hunks: Hunk[],
  ) {
    this.oldPath = oldPath;
    this.newPath = newPath;
    this.isCreate = isCreate;
    this.isDelete = isDelete;
    this.hunks = hunks;
  }

  apply(tree: Tree, strict: boolean): ApplyResult {
    if (this.oldPath !== null && !isSafePath(this.oldPath)) return applyFail('unsafe', this.oldPath);
    if (this.newPath !== null && !isSafePath(this.newPath)) return applyFail('unsafe', this.newPath);
    if (this.isCreate) {
      if (this.newPath === null) return { ok: true };
      if (tree.exists(this.newPath)) return applyFail('exists', this.newPath);
      const plusLines: string[] = [];
      let lastPlus: { hunk: Hunk; idx: number } | null = null;
      for (const h of this.hunks) {
        for (let i = 0; i < h.body.length; i++) {
          if (h.body[i].kind === 'new') {
            plusLines.push(h.body[i].text);
            lastPlus = { hunk: h, idx: i };
          }
        }
      }
      let endsWithBreak = false;
      if (plusLines.length > 0) {
        endsWithBreak = true;
        if (lastPlus !== null) {
          const b = lastPlus.hunk.body;
          if (lastPlus.idx + 1 < b.length && b[lastPlus.idx + 1].kind === 'bs') endsWithBreak = false;
        }
      }
      tree.cur.set(this.newPath, serializeFile({ lines: plusLines, brk: '\n', endsWithBreak }));
      return { ok: true };
    }
    if (this.isDelete) {
      if (this.oldPath === null) return { ok: true };
      if (!tree.exists(this.oldPath)) return applyFail('missing', this.oldPath);
      tree.cur.delete(this.oldPath);
      return { ok: true };
    }
    const op = this.oldPath as string;
    if (!tree.exists(op)) return applyFail('missing', op);
    const isMove = this.newPath !== null && this.newPath !== op;
    if (isMove && tree.exists(this.newPath as string)) return applyFail('exists', this.newPath as string);
    const text = tree.read(op);
    if (text === undefined) return applyFail('no-match', op);
    const r = applyHunks(parseFileText(text), this.hunks, strict);
    if (!r.ok) return applyFail(r.code, op);
    if (isMove) {
      tree.cur.set(this.newPath as string, serializeFile(r.file));
      tree.cur.delete(op);
      tree.moves.push([op, this.newPath as string]);
    } else {
      tree.cur.set(op, serializeFile(r.file));
    }
    return { ok: true };
  }
}

/** One SEARCH/REPLACE block (SPEC section 7). */
class SREdit implements Edit {
  path: string;
  oldLines: string[];
  newLines: string[];

  constructor(path: string, oldLines: string[], newLines: string[]) {
    this.path = path;
    this.oldLines = oldLines;
    this.newLines = newLines;
  }

  apply(tree: Tree, strict: boolean): ApplyResult {
    if (!isSafePath(this.path)) return applyFail('unsafe', this.path);
    if (this.oldLines.length === 0) {
      if (tree.exists(this.path)) return applyFail('exists', this.path);
      tree.cur.set(
        this.path,
        serializeFile({ lines: [...this.newLines], brk: '\n', endsWithBreak: this.newLines.length > 0 }),
      );
      return { ok: true };
    }
    if (!tree.exists(this.path)) return applyFail('missing', this.path);
    const text = tree.read(this.path);
    if (text === undefined) return applyFail('no-match', this.path);
    const f = parseFileText(text);
    const found = findTier(f.lines, this.oldLines, strict);
    if (found === null) return applyFail('no-match', this.path);
    if (found.occ.length > 1) return applyFail('ambiguous', this.path);
    const pos = found.occ[0];
    const nParts: NLine[] = this.newLines.map((t) => ({ text: t, ctx: false, ctxIndex: -1 }));
    const repl = buildReplacement(f.lines, pos, nParts, this.oldLines, found.tier);
    const lines = [...f.lines];
    lines.splice(pos, this.oldLines.length, ...repl);
    tree.cur.set(this.path, serializeFile({ lines, brk: f.brk, endsWithBreak: f.endsWithBreak }));
    return { ok: true };
  }
}

/** A V4A Add File section (SPEC section 8). */
class V4AAddEdit implements Edit {
  path: string;
  lines: string[];

  constructor(path: string, lines: string[]) {
    this.path = path;
    this.lines = lines;
  }

  apply(tree: Tree): ApplyResult {
    if (!isSafePath(this.path)) return applyFail('unsafe', this.path);
    if (tree.exists(this.path)) return applyFail('exists', this.path);
    tree.cur.set(
      this.path,
      serializeFile({ lines: [...this.lines], brk: '\n', endsWithBreak: this.lines.length > 0 }),
    );
    return { ok: true };
  }
}

/** A V4A Delete File section (SPEC section 8). */
class V4ADeleteEdit implements Edit {
  path: string;

  constructor(path: string) {
    this.path = path;
  }

  apply(tree: Tree): ApplyResult {
    if (!isSafePath(this.path)) return applyFail('unsafe', this.path);
    if (!tree.exists(this.path)) return applyFail('missing', this.path);
    tree.cur.delete(this.path);
    return { ok: true };
  }
}

interface V4AChunk {
  anchor: string | null;
  eof: boolean;
  body: BodyLine[];
}

/** A V4A Update File section (SPEC section 8). */
class V4AUpdateEdit implements Edit {
  path: string;
  moveTo: string | null;
  chunks: V4AChunk[];

  constructor(path: string, moveTo: string | null, chunks: V4AChunk[]) {
    this.path = path;
    this.moveTo = moveTo;
    this.chunks = chunks;
  }

  apply(tree: Tree, strict: boolean): ApplyResult {
    if (!isSafePath(this.path)) return applyFail('unsafe', this.path);
    if (this.moveTo !== null && !isSafePath(this.moveTo)) return applyFail('unsafe', this.moveTo);
    if (!tree.exists(this.path)) return applyFail('missing', this.path);
    if (this.moveTo !== null && tree.exists(this.moveTo)) return applyFail('exists', this.moveTo);
    const text = tree.read(this.path);
    if (text === undefined) return applyFail('no-match', this.path);
    const f = parseFileText(text);
    const lines = [...f.lines];
    let cursor = 0;
    const tiers = strict ? [0] : [0, 1, 2];
    for (const ch of this.chunks) {
      if (ch.anchor !== null && ch.anchor !== '') {
        let foundIdx = -1;
        for (const t of tiers) {
          for (let i = cursor; i < lines.length; i++) {
            if (lineEq(lines[i], ch.anchor, t)) {
              foundIdx = i;
              break;
            }
          }
          if (foundIdx !== -1) break;
        }
        if (foundIdx === -1) return applyFail('no-match', this.path);
        cursor = foundIdx + 1;
      }
      const { oParts, nParts } = splitBody(ch.body);
      if (oParts.length > 0) {
        let chosen: { tier: number; pos: number } | null = null;
        for (const t of tiers) {
          const occ = findOccurrences(lines, oParts, t, cursor);
          const filtered = ch.eof ? occ.filter((p) => p + oParts.length === lines.length) : occ;
          if (filtered.length > 0) {
            chosen = { tier: t, pos: filtered[0] };
            break;
          }
        }
        if (chosen === null) return applyFail('no-match', this.path);
        const repl = buildReplacement(lines, chosen.pos, nParts, oParts, chosen.tier);
        lines.splice(chosen.pos, oParts.length, ...repl);
        cursor = chosen.pos + repl.length;
      } else {
        const pos = ch.eof ? lines.length : cursor;
        const repl = nParts.map((n) => n.text);
        lines.splice(pos, 0, ...repl);
        cursor = pos + repl.length;
      }
    }
    const out = serializeFile({ lines, brk: f.brk, endsWithBreak: f.endsWithBreak });
    if (this.moveTo !== null) {
      tree.cur.set(this.moveTo, out);
      tree.cur.delete(this.path);
      tree.moves.push([this.path, this.moveTo]);
    } else {
      tree.cur.set(this.path, out);
    }
    return { ok: true };
  }
}

/** A JSON create edit (SPEC section 9). */
class JSONCreateEdit implements Edit {
  path: string;
  fileText: string;

  constructor(path: string, fileText: string) {
    this.path = path;
    this.fileText = fileText;
  }

  apply(tree: Tree): ApplyResult {
    if (!isSafePath(this.path)) return applyFail('unsafe', this.path);
    if (tree.exists(this.path)) return applyFail('exists', this.path);
    tree.cur.set(this.path, this.fileText);
    return { ok: true };
  }
}

/** A JSON str_replace edit (SPEC section 9). */
class JSONStrReplaceEdit implements Edit {
  path: string;
  oldStr: string;
  newStr: string;

  constructor(path: string, oldStr: string, newStr: string) {
    this.path = path;
    this.oldStr = oldStr;
    this.newStr = newStr;
  }

  apply(tree: Tree): ApplyResult {
    if (!isSafePath(this.path)) return applyFail('unsafe', this.path);
    if (!tree.exists(this.path)) return applyFail('missing', this.path);
    const text = tree.read(this.path);
    if (text === undefined) return applyFail('no-match', this.path);
    const nlIdx = text.indexOf('\n');
    const isCRLF = nlIdx > 0 && text[nlIdx - 1] === '\r';
    let hay = text;
    let needle = this.oldStr;
    let repl = this.newStr;
    if (isCRLF) {
      hay = text.replace(/\r\n/g, '\n');
      needle = this.oldStr.replace(/\r\n/g, '\n');
      repl = this.newStr.replace(/\r\n/g, '\n');
    }
    let count = 0;
    let idx = 0;
    while (true) {
      const at = hay.indexOf(needle, idx);
      if (at === -1) break;
      count += 1;
      if (count > 1) break;
      idx = at + 1;
    }
    if (count === 0) return applyFail('no-match', this.path);
    if (count > 1) return applyFail('ambiguous', this.path);
    const at = hay.indexOf(needle);
    let result = hay.slice(0, at) + repl + hay.slice(at + needle.length);
    if (isCRLF) result = result.replace(/\n/g, '\r\n');
    tree.cur.set(this.path, result);
    return { ok: true };
  }
}

/** A JSON insert edit (SPEC section 9). */
class JSONInsertEdit implements Edit {
  path: string;
  insertLine: number;
  newStr: string;

  constructor(path: string, insertLine: number, newStr: string) {
    this.path = path;
    this.insertLine = insertLine;
    this.newStr = newStr;
  }

  apply(tree: Tree): ApplyResult {
    if (!isSafePath(this.path)) return applyFail('unsafe', this.path);
    if (!tree.exists(this.path)) return applyFail('missing', this.path);
    const text = tree.read(this.path);
    if (text === undefined) return applyFail('no-match', this.path);
    const f = parseFileText(text);
    if (this.insertLine < 0 || this.insertLine > f.lines.length) return applyFail('no-match', this.path);
    const ins = splitNewStr(this.newStr);
    const lines = [...f.lines];
    lines.splice(this.insertLine, 0, ...ins);
    tree.cur.set(this.path, serializeFile({ lines, brk: f.brk, endsWithBreak: f.endsWithBreak }));
    return { ok: true };
  }
}

// ---------------------------------------------------------------------------
// Parsing

class ParseErr extends Error {
  line: number;

  constructor(line: number) {
    super(`parse ${line}`);
    this.line = line;
  }
}

/** SPEC section 4: detect the format of an auto patch. */
function detectFormat(lines: string[]): string | null {
  let first = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() !== '') {
      first = i;
      break;
    }
  }
  if (first === -1) return null;
  if (lines[first].trim() === '*** Begin Patch') return 'v4a';
  const m = lines[first].match(/\S/);
  if (m !== null && (m[0] === '[' || m[0] === '{')) return 'json';
  for (const l of lines) {
    if (l.replace(/[ \t]+$/, '') === '<<<<<<< SEARCH') return 'search-replace';
  }
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('diff --git ')) return 'unified';
    if (lines[i].startsWith('--- ') && i + 1 < lines.length && lines[i + 1].startsWith('+++ ')) return 'unified';
  }
  return null;
}

// --- Unified diffs (SPEC section 6) ---

interface RawSection {
  dgOld: string | null;
  dgNew: string | null;
  dashOld: string | null;
  dashNew: string | null;
  hasDash: boolean;
  renameFrom: string | null;
  renameTo: string | null;
  newFile: boolean;
  deletedFile: boolean;
  hunks: Hunk[];
}

/** The path of a `--- ` or `+++ ` line: text after the four characters, up
 *  to the first tab, surrounding spaces removed, a leading `a/` or `b/`
 *  removed, `/dev/null` meaning no file. */
function parseDiffPath(line: string): string | null {
  let p = line.slice(4);
  const tab = p.indexOf('\t');
  if (tab !== -1) p = p.slice(0, tab);
  p = p.trim();
  if (p === '/dev/null') return null;
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p;
}

function parseUnified(lines: string[]): Edit[] {
  const sections: RawSection[] = [];
  let cur: RawSection | null = null;
  let inHeader = false;
  const newSection = (dgOld: string | null, dgNew: string | null): RawSection => {
    const s: RawSection = {
      dgOld,
      dgNew,
      dashOld: null,
      dashNew: null,
      hasDash: false,
      renameFrom: null,
      renameTo: null,
      newFile: false,
      deletedFile: false,
      hunks: [],
    };
    sections.push(s);
    return s;
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
      if (m === null) throw new ParseErr(i + 1);
      cur = newSection(m[1], m[2]);
      inHeader = true;
      i += 1;
      continue;
    }
    if (line.startsWith('@@')) {
      if (cur === null) throw new ParseErr(i + 1);
      const hm = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (hm === null) throw new ParseErr(i + 1);
      const body: BodyLine[] = [];
      i += 1;
      while (i < lines.length) {
        const bl = lines[i];
        if (bl.startsWith('diff --git ')) break;
        if (bl.startsWith('--- ') && i + 1 < lines.length && lines[i + 1].startsWith('+++ ')) break;
        if (bl === '' || bl[0] === ' ' || bl[0] === '-' || bl[0] === '+' || bl[0] === '\\') {
          body.push(parseBodyLine(bl));
          i += 1;
          continue;
        }
        break;
      }
      while (body.length > 0 && body[body.length - 1].kind === 'ctx' && body[body.length - 1].text === '') {
        body.pop();
      }
      cur.hunks.push({ a: parseInt(hm[1], 10), body });
      inHeader = false;
      continue;
    }
    if (line.startsWith('--- ') && i + 1 < lines.length && lines[i + 1].startsWith('+++ ')) {
      if (cur !== null && inHeader && !cur.hasDash) {
        cur.dashOld = parseDiffPath(line);
        cur.dashNew = parseDiffPath(lines[i + 1]);
        cur.hasDash = true;
      } else {
        cur = newSection(null, null);
        cur.dashOld = parseDiffPath(line);
        cur.dashNew = parseDiffPath(lines[i + 1]);
        cur.hasDash = true;
        inHeader = true;
      }
      i += 2;
      continue;
    }
    if (line.startsWith('--- ')) {
      if (cur !== null && inHeader) throw new ParseErr(i + 2);
      i += 1;
      continue;
    }
    if (cur !== null && inHeader) {
      if (line.startsWith('rename from ')) {
        cur.renameFrom = line.slice('rename from '.length).trim();
      } else if (line.startsWith('rename to ')) {
        cur.renameTo = line.slice('rename to '.length).trim();
      } else if (line.startsWith('new file mode')) {
        cur.newFile = true;
      } else if (line.startsWith('deleted file mode')) {
        cur.deletedFile = true;
      }
      i += 1;
      continue;
    }
    i += 1;
  }
  if (sections.length === 0) throw new ParseErr(1);
  return sections.map((s) => {
    let oldPath: string | null;
    let newPath: string | null;
    if (s.hasDash) {
      oldPath = s.dashOld;
      newPath = s.dashNew;
    } else if (s.renameFrom !== null || s.renameTo !== null) {
      oldPath = s.renameFrom !== null ? s.renameFrom : s.dgOld;
      newPath = s.renameTo !== null ? s.renameTo : s.dgNew;
    } else {
      oldPath = s.dgOld;
      newPath = s.dgNew;
    }
    const isCreate = oldPath === null || s.newFile;
    const isDelete = newPath === null || s.deletedFile;
    return new UnifiedEdit(oldPath, newPath, isCreate, isDelete, s.hunks);
  });
}

// --- SEARCH/REPLACE blocks (SPEC section 7) ---

function isSRMarker(line: string, marker: string): boolean {
  return line.replace(/[ \t]+$/, '') === marker;
}

function parseSR(lines: string[]): Edit[] {
  const edits: Edit[] = [];
  let prevEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (isSRMarker(lines[i], '<<<<<<< SEARCH')) {
      const searchNo = i + 1;
      let p: string | null = null;
      for (let j = i - 1; j > prevEnd; j--) {
        const t = lines[j].trim();
        if (t === '') continue;
        if (t.startsWith('```')) continue;
        p = t;
        break;
      }
      if (p === null) {
        if (prevPath === null) throw new ParseErr(searchNo);
        p = prevPath;
      }
      let eq = -1;
      for (let j = i + 1; j < lines.length; j++) {
        if (isSRMarker(lines[j], '=======')) {
          eq = j;
          break;
        }
      }
      if (eq === -1) throw new ParseErr(searchNo);
      let end = -1;
      for (let j = eq + 1; j < lines.length; j++) {
        if (isSRMarker(lines[j], '>>>>>>> REPLACE')) {
          end = j;
          break;
        }
      }
      if (end === -1) throw new ParseErr(searchNo);
      edits.push(new SREdit(p, lines.slice(i + 1, eq), lines.slice(eq + 1, end)));
      prevPath = p;
      prevEnd = end;
      i = end + 1;
      continue;
    }
    i += 1;
  }
  if (edits.length === 0) throw new ParseErr(1);
  return edits;
}

// --- V4A patches (SPEC section 8) ---

/** A section's content lines, [from, to), with blank lines at its end
 *  stripped; `next` is where the next section (or `*** End Patch`) starts. */
function collectV4ASection(
  lines: string[],
  from: number,
  endPatchIdx: number,
): { from: number; to: number; next: number } {
  let j = from;
  while (j < endPatchIdx) {
    const l = lines[j];
    if (l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ')) break;
    j += 1;
  }
  let to = j;
  while (to > from && lines[to - 1].trim() === '') to -= 1;
  return { from, to, next: j };
}

function parseV4A(lines: string[]): Edit[] {
  let first = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() !== '') {
      first = i;
      break;
    }
  }
  if (first === -1) throw new ParseErr(1);
  if (lines[first].trim() !== '*** Begin Patch') throw new ParseErr(first + 1);
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].trim() !== '') {
      last = i;
      break;
    }
  }
  if (lines[last].trim() !== '*** End Patch') throw new ParseErr(lines.length + 1);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i];
    if (line.trim() === '') {
      i += 1;
      continue;
    }
    if (line.startsWith('*** Add File: ')) {
      const p = line.slice('*** Add File: '.length).trim();
      const { from, to, next } = collectV4ASection(lines, i + 1, last);
      const fileLines: string[] = [];
      for (let k = from; k < to; k++) {
        const cl = lines[k];
        if (cl.startsWith('+')) fileLines.push(cl.slice(1));
        else if (cl.trim() === '') fileLines.push('');
        else throw new ParseErr(k + 1);
      }
      edits.push(new V4AAddEdit(p, fileLines));
      i = next;
      continue;
    }
    if (line.startsWith('*** Delete File: ')) {
      const p = line.slice('*** Delete File: '.length).trim();
      const { from, to, next } = collectV4ASection(lines, i + 1, last);
      if (to > from) throw new ParseErr(from + 1);
      edits.push(new V4ADeleteEdit(p));
      i = next;
      continue;
    }
    if (line.startsWith('*** Update File: ')) {
      const p = line.slice('*** Update File: '.length).trim();
      const updateNo = i + 1;
      const { from, to, next } = collectV4ASection(lines, i + 1, last);
      let moveTo: string | null = null;
      const chunks: V4AChunk[] = [];
      let j = from;
      if (j < to && lines[j].startsWith('*** Move to: ')) {
        moveTo = lines[j].slice('*** Move to: '.length).trim();
        j += 1;
      }
      let curChunk: V4AChunk | null = null;
      while (j < to) {
        const l = lines[j];
        if (l.startsWith('@@')) {
          const anchorText = l.slice(2).trim();
          curChunk = { anchor: anchorText === '' ? null : anchorText, eof: false, body: [] };
          chunks.push(curChunk);
          j += 1;
          continue;
        }
        if (l === '*** End of File') {
          if (curChunk === null) throw new ParseErr(j + 1);
          curChunk.eof = true;
          curChunk = null;
          j += 1;
          continue;
        }
        if (l.startsWith('***')) throw new ParseErr(j + 1);
        if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+') {
          if (curChunk === null) {
            curChunk = { anchor: null, eof: false, body: [] };
            chunks.push(curChunk);
          }
          curChunk.body.push(parseBodyLine(l));
          j += 1;
          continue;
        }
        throw new ParseErr(j + 1);
      }
      if (chunks.length === 0 && moveTo === null) throw new ParseErr(updateNo);
      edits.push(new V4AUpdateEdit(p, moveTo, chunks));
      i = next;
      continue;
    }
    throw new ParseErr(i + 1);
  }
  if (edits.length === 0) throw new ParseErr(1);
  return edits;
}

// --- JSON edits (SPEC section 9) ---

function validateEditObject(obj: unknown, lineNo: number): Edit {
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) throw new ParseErr(lineNo);
  const o = obj as Record<string, unknown>;
  if (typeof o.path !== 'string') throw new ParseErr(lineNo);
  if (typeof o.command !== 'string') throw new ParseErr(lineNo);
  if (o.command === 'create') {
    if (typeof o.file_text !== 'string') throw new ParseErr(lineNo);
    return new JSONCreateEdit(o.path, o.file_text);
  }
  if (o.command === 'str_replace') {
    if (typeof o.old_str !== 'string' || o.old_str === '') throw new ParseErr(lineNo);
    if (o.new_str !== undefined && typeof o.new_str !== 'string') throw new ParseErr(lineNo);
    return new JSONStrReplaceEdit(o.path, o.old_str, (o.new_str as string | undefined) ?? '');
  }
  if (o.command === 'insert') {
    if (typeof o.insert_line !== 'number' || !Number.isInteger(o.insert_line)) throw new ParseErr(lineNo);
    if (typeof o.new_str !== 'string') throw new ParseErr(lineNo);
    return new JSONInsertEdit(o.path, o.insert_line, o.new_str);
  }
  throw new ParseErr(lineNo);
}

function lineOfOffset(text: string, offset: number): number {
  let n = 1;
  for (let i = 0; i < offset; i++) {
    if (text[i] === '\n') n += 1;
  }
  return n;
}

function parseJSON(lines: string[], patchText: string): Edit[] {
  const firstNonWs = patchText.search(/\S/);
  if (firstNonWs === -1) throw new ParseErr(1);
  if (patchText[firstNonWs] === '[') {
    const startLine = lineOfOffset(patchText, firstNonWs);
    let arr: unknown;
    try {
      arr = JSON.parse(patchText);
    } catch {
      throw new ParseErr(startLine);
    }
    if (!Array.isArray(arr)) throw new ParseErr(startLine);
    const edits = arr.map((el) => validateEditObject(el, startLine));
    if (edits.length === 0) throw new ParseErr(1);
    return edits;
  }
  const edits: Edit[] = [];
  for (let idx = 0; idx < lines.length; idx++) {
    const l = lines[idx];
    if (l.trim() === '') continue;
    let obj: unknown;
    try {
      obj = JSON.parse(l);
    } catch {
      throw new ParseErr(idx + 1);
    }
    edits.push(validateEditObject(obj, idx + 1));
  }
  if (edits.length === 0) throw new ParseErr(1);
  return edits;
}

// ---------------------------------------------------------------------------
// The CLI (SPEC sections 1, 2 and 10)

function exitWith(lines: string[], code: number): number {
  writeStdout(lines);
  return code;
}

function cliMain(): number {
  const args = process.argv.slice(2);
  let format = 'auto';
  let check = false;
  let strict = false;
  let seenFormat = false;
  let seenCheck = false;
  let seenStrict = false;
  const positional: string[] = [];
  let endOpts = false;
  for (const a of args) {
    if (!endOpts) {
      if (a === '--') {
        endOpts = true;
        continue;
      }
      if (a === '--check') {
        if (seenCheck) return exitWith(['error: usage'], 2);
        seenCheck = true;
        check = true;
        continue;
      }
      if (a === '--strict') {
        if (seenStrict) return exitWith(['error: usage'], 2);
        seenStrict = true;
        strict = true;
        continue;
      }
      if (a.startsWith('--format=')) {
        if (seenFormat) return exitWith(['error: usage'], 2);
        seenFormat = true;
        const v = a.slice('--format='.length);
        if (v !== 'unified' && v !== 'search-replace' && v !== 'v4a' && v !== 'json' && v !== 'auto') {
          return exitWith(['error: usage'], 2);
        }
        format = v;
        continue;
      }
      if (a.startsWith('-') && a !== '-') return exitWith(['error: usage'], 2);
    }
    positional.push(a);
  }
  if (positional.length > 1) return exitWith(['error: usage'], 2);
  const patchArg = positional.length === 1 ? positional[0] : null;

  let patchText: string;
  try {
    patchText = patchArg === null || patchArg === '-' ? readFileSync(0, 'utf8') : readFileSync(patchArg, 'utf8');
  } catch {
    return exitWith(['error: no-patch'], 2);
  }
  const lines = splitPatchLines(patchText);

  let fmt = format;
  if (fmt === 'auto') {
    const d = detectFormat(lines);
    if (d === null) return exitWith(['error: format'], 2);
    fmt = d;
  }

  let edits: Edit[];
  try {
    if (fmt === 'unified') edits = parseUnified(lines);
    else if (fmt === 'search-replace') edits = parseSR(lines);
    else if (fmt === 'v4a') edits = parseV4A(lines);
    else edits = parseJSON(lines, patchText);
  } catch (e) {
    if (e instanceof ParseErr) return exitWith([`error: parse ${e.line}`], 2);
    throw e;
  }

  const tree = new Tree();
  const failures: Array<{ code: string; path: string }> = [];
  for (const ed of edits) {
    const r = ed.apply(tree, strict);
    if (!r.ok) failures.push({ code: r.code, path: r.path });
  }
  if (failures.length > 0) {
    const out = failures.map((f) => `error: ${f.code} ${f.path}`);
    out.push(`failed: ${failures.length} of ${edits.length} edits`);
    return exitWith(out, 1);
  }
  const changeLines = finish(tree, check);
  const out = [...changeLines, changeLines.length === 1 ? 'ok: 1 file' : `ok: ${changeLines.length} files`];
  return exitWith(out, 0);
}

// ---------------------------------------------------------------------------
// Entry point: a trial hands over to the runner, anything else is the CLI.

const envUrl = process.env.MAKEFUN_ENV_URL;
if (envUrl !== undefined && envUrl !== '') {
  runTrial(envUrl).catch((err: unknown) => {
    process.stderr.write(`runTrial failed: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
} else {
  process.exit(cliMain());
}
