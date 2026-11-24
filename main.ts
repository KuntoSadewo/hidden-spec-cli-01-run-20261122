// mend: apply an edit an AI model wrote to a tree of text files.
//
// One CLI, four patch formats (unified diff, SEARCH/REPLACE blocks, V4A
// patches, JSON edit objects), three tiers of line matching, all-or-nothing
// writes. The behaviour follows SPEC.md section by section. Node's standard
// library alone.
//
// When MAKEFUN_ENV_URL is set the process is not a CLI at all: it hands the
// trial over to runner.ts, which runs this same file once per check.

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { runTrial } from './runner.ts';

/** A parse failure in the patch; `line` is the 1-based patch line to name. */
class ParseFault extends Error {
  line: number;
  constructor(line: number) {
    super(`parse ${line}`);
    this.line = line;
  }
}

/** One edit's failure: a SPEC.md section 2 code and the path it concerns. */
interface EditFailure {
  code: string;
  path: string;
}

/** The result of running one edit against the in-memory tree. */
type EditOutcome = { ok: true } | { ok: false; failure: EditFailure };

const fail = (code: string, path: string): EditOutcome => ({ ok: false, failure: { code, path } });
const OK: EditOutcome = { ok: true };

/* ------------------------------------------------------------------ */
/* Paths, patch lines, file lines (SPEC.md section 3)                  */
/* ------------------------------------------------------------------ */

/** A path is safe when no segment is empty, `.` or `..`, and it holds no
 * backslash and does not start with `/`. */
function isSafePath(p: string): boolean {
  if (p === '' || p.startsWith('/') || p.includes('\\')) return false;
  return p.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..');
}

/** The patch's lines: split at `\n`, one trailing `\r` removed from each,
 * and no empty piece after a final `\n`. */
function splitPatch(text: string): string[] {
  const parts = text.split('\n');
  if (parts.length > 0 && parts[parts.length - 1] === '') parts.pop();
  return parts.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

/** A text file seen as lines: its own line break, its lines, and whether
 * it ends with a line break. */
interface FileLines {
  brk: '\n' | '\r\n';
  lines: string[];
  finalBreak: boolean;
}

function toLines(text: string): FileLines {
  if (text === '') return { brk: '\n', lines: [], finalBreak: false };
  const firstNl = text.indexOf('\n');
  const brk: '\n' | '\r\n' = firstNl > 0 && text[firstNl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(brk);
  let finalBreak = false;
  if (parts[parts.length - 1] === '') {
    parts.pop();
    finalBreak = true;
  }
  return { brk, lines: parts, finalBreak };
}

function fromLines(f: FileLines): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.brk) + (f.finalBreak ? f.brk : '');
}

/* ------------------------------------------------------------------ */
/* The tree, held in memory until every edit has run (section 10)      */
/* ------------------------------------------------------------------ */

class Tree {
  /** Original bytes of every path ever looked at; null means absent. */
  private before = new Map<string, string | null>();
  /** Current bytes of every path an edit changed; null means absent. */
  private now = new Map<string, string | null>();
  /** Move edits that succeeded, as [oldPath, newPath] pairs. */
  moves: Array<[string, string]> = [];

  private disk(p: string): string | null {
    try {
      return readFileSync(join(process.cwd(), ...p.split('/')), 'utf8');
    } catch {
      return null;
    }
  }

  /** The bytes a path had before the patch, remembering them. */
  original(p: string): string | null {
    if (!this.before.has(p)) this.before.set(p, this.disk(p));
    return this.before.get(p) ?? null;
  }

  /** The bytes a path has now: an edit's change, or the disk's. */
  read(p: string): string | null {
    if (this.now.has(p)) return this.now.get(p) ?? null;
    return this.original(p);
  }

  exists(p: string): boolean {
    return this.read(p) !== null;
  }

  write(p: string, text: string): void {
    this.original(p);
    this.now.set(p, text);
  }

  remove(p: string): void {
    this.original(p);
    this.now.set(p, null);
  }

  /** Every path ever looked at, for the exit-0 change report. */
  touched(): string[] {
    return [...this.before.keys()];
  }

  /** Write every change to disk (never called for --check or exit 1). */
  flush(): void {
    for (const [p, text] of this.now) {
      const target = join(process.cwd(), ...p.split('/'));
      if (text === null) {
        rmSync(target, { force: true });
      } else {
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, text);
      }
    }
  }
}

/* ------------------------------------------------------------------ */
/* Matching lines at three tiers (section 5)                           */
/* ------------------------------------------------------------------ */

function normLine(s: string, tier: number): string {
  if (tier === 0) return s;
  if (tier === 1) return s.replace(/[ \t]+$/, '');
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

interface Match {
  tier: number;
  positions: number[];
}

/** Every occurrence of `old` in `lines` at or after `from`, at the first
 * tier that has one. With `endAtEnd`, only occurrences that finish on the
 * file's last line count. Null when no tier has an occurrence. */
function findMatch(
  lines: string[],
  old: string[],
  strict: boolean,
  from = 0,
  endAtEnd = false,
): Match | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const tier of tiers) {
    const positions: number[] = [];
    for (let i = from; i + old.length <= lines.length; i += 1) {
      if (endAtEnd && i + old.length !== lines.length) continue;
      let hit = true;
      for (let k = 0; k < old.length; k += 1) {
        if (normLine(lines[i + k], tier) !== normLine(old[k], tier)) {
          hit = false;
          break;
        }
      }
      if (hit) positions.push(i);
    }
    if (positions.length > 0) return { tier, positions };
  }
  return null;
}

/** One body line of a hunk or chunk: context, removed, or added. A `\` line
 * in a unified body sets `noBreak` on the body line before it. */
interface Op {
  kind: 'ctx' | 'del' | 'add';
  text: string;
  noBreak: boolean;
}

function oldTexts(ops: Op[]): string[] {
  return ops.filter((o) => o.kind !== 'add').map((o) => o.text);
}

/** The lines a match writes: context lines come from the file itself; at
 * tier 2 every other new line is re-indented from the patch's first old
 * line onto the file's first matched line. */
function writtenLines(ops: Op[], fileLines: string[], pos: number, tier: number): string[] {
  const out: string[] = [];
  let oi = 0;
  const firstOld = oldTexts(ops)[0] ?? '';
  const pIndent = /^[ \t]*/.exec(firstOld)?.[0] ?? '';
  const fIndent = /^[ \t]*/.exec(fileLines[pos] ?? '')?.[0] ?? '';
  for (const op of ops) {
    if (op.kind === 'ctx') {
      out.push(fileLines[pos + oi]);
      oi += 1;
    } else if (op.kind === 'del') {
      oi += 1;
    } else if (tier === 2 && op.text.trim() !== '' && op.text.startsWith(pIndent)) {
      out.push(fIndent + op.text.slice(pIndent.length));
    } else {
      out.push(op.text);
    }
  }
  return out;
}

/** Whether a `\` line follows the hunk's last context or `+` line. */
function noBreakAfterLastWritten(ops: Op[]): boolean {
  for (let i = ops.length - 1; i >= 0; i -= 1) {
    if (ops[i].kind !== 'del') return ops[i].noBreak;
  }
  return false;
}

/* ------------------------------------------------------------------ */
/* Unified diffs (section 6)                                           */
/* ------------------------------------------------------------------ */

interface Hunk {
  a: number;
  ops: Op[];
}

interface Section {
  diffOld?: string;
  diffNew?: string;
  headOld?: string | null;
  headNew?: string | null;
  renameFrom?: string;
  renameTo?: string;
  newFile: boolean;
  deletedFile: boolean;
  hunks: Hunk[];
}

/** The path a `---` or `+++` line names: text after the four characters,
 * up to the first tab, spaces removed, `/dev/null` read as no file, and a
 * leading `a/` or `b/` removed. */
function headerPath(line: string): string | null {
  let text = line.slice(4);
  const tab = text.indexOf('\t');
  if (tab >= 0) text = text.slice(0, tab);
  text = text.trim();
  if (text === '/dev/null') return null;
  if (text.startsWith('a/') || text.startsWith('b/')) text = text.slice(2);
  return text;
}

function parseUnified(lines: string[]): Section[] {
  const sections: Section[] = [];
  let sec: Section | null = null;
  let i = 0;
  const startsPair = (j: number): boolean =>
    lines[j].startsWith('--- ') && j + 1 < lines.length && lines[j + 1].startsWith('+++ ');

  while (i < lines.length) {
    const line = lines[i];
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
      if (m === null) throw new ParseFault(i + 1);
      sec = { diffOld: m[1], diffNew: m[2], newFile: false, deletedFile: false, hunks: [] };
      sections.push(sec);
      i += 1;
      continue;
    }
    if (line.startsWith('--- ') && startsPair(i)) {
      if (sec !== null && sec.hunks.length === 0 && sec.headOld === undefined) {
        sec.headOld = headerPath(line);
        sec.headNew = headerPath(lines[i + 1]);
      } else {
        sec = { newFile: false, deletedFile: false, hunks: [] };
        sec.headOld = headerPath(line);
        sec.headNew = headerPath(lines[i + 1]);
        sections.push(sec);
      }
      i += 2;
      continue;
    }
    if (line.startsWith('--- ') && sec !== null && sec.hunks.length === 0) {
      // A `---` line inside a section's header with no `+++` after it.
      throw new ParseFault(i + 2);
    }
    if (line.startsWith('@@')) {
      if (sec === null) throw new ParseFault(i + 1);
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (m === null) throw new ParseFault(i + 1);
      const a = Number(m[1]);
      i += 1;
      const body: string[] = [];
      while (i < lines.length) {
        const b = lines[i];
        if (b.startsWith('diff --git ')) break;
        if (b.startsWith('--- ') && startsPair(i)) break;
        const c = b.charAt(0);
        if (b === '' || c === ' ' || c === '-' || c === '+' || c === '\\') {
          body.push(b);
          i += 1;
        } else break;
      }
      while (body.length > 0 && body[body.length - 1] === '') body.pop();
      const ops: Op[] = [];
      for (const raw of body) {
        if (raw === '') ops.push({ kind: 'ctx', text: '', noBreak: false });
        else if (raw.startsWith('\\')) {
          if (ops.length > 0) ops[ops.length - 1].noBreak = true;
        } else if (raw.charAt(0) === ' ') ops.push({ kind: 'ctx', text: raw.slice(1), noBreak: false });
        else if (raw.charAt(0) === '-') ops.push({ kind: 'del', text: raw.slice(1), noBreak: false });
        else ops.push({ kind: 'add', text: raw.slice(1), noBreak: false });
      }
      sec.hunks.push({ a, ops });
      continue;
    }
    if (sec !== null && sec.hunks.length === 0) {
      // Header lines before the first hunk; anything unlisted is ignored.
      if (line.startsWith('rename from ')) sec.renameFrom = line.slice(12).trim();
      else if (line.startsWith('rename to ')) sec.renameTo = line.slice(10).trim();
      else if (line.startsWith('new file mode')) sec.newFile = true;
      else if (line.startsWith('deleted file mode')) sec.deletedFile = true;
      i += 1;
      continue;
    }
    i += 1; // Prose and fences outside sections are ignored.
  }
  return sections;
}

/** Apply one section's hunks to a file's lines, in order, each to the
 * result of the ones before it. Null (with `code` set) when a hunk fails. */
function applyHunks(
  sec: Section,
  file: FileLines,
  strict: boolean,
): { lines: string[]; finalBreak: boolean } | { code: string } {
  const lines = [...file.lines];
  let finalBreak = file.finalBreak;
  let d = 0;
  for (const hunk of sec.hunks) {
    const old = oldTexts(hunk.ops);
    const newCount = hunk.ops.filter((o) => o.kind !== 'del').length;
    if (old.length === 0) {
      const pos = Math.min(hunk.a + d, lines.length);
      const added = hunk.ops.filter((o) => o.kind === 'add').map((o) => o.text);
      lines.splice(pos, 0, ...added);
      if (pos === lines.length - added.length && hunk.ops.length > 0) {
        finalBreak = !noBreakAfterLastWritten(hunk.ops);
      }
    } else {
      const match = findMatch(lines, old, strict);
      if (match === null) return { code: 'no-match' };
      const target = hunk.a - 1 + d;
      let pos = match.positions[0];
      for (const p of match.positions) {
        if (Math.abs(p - target) < Math.abs(pos - target)) pos = p;
      }
      const written = writtenLines(hunk.ops, lines, pos, match.tier);
      const reachesEnd = pos + old.length === lines.length;
      lines.splice(pos, old.length, ...written);
      if (reachesEnd) finalBreak = !noBreakAfterLastWritten(hunk.ops);
    }
    d += newCount - old.length;
  }
  return { lines, finalBreak };
}

function applySection(tree: Tree, sec: Section, strict: boolean): EditOutcome {
  const oldPath = sec.headOld !== undefined ? sec.headOld : sec.renameFrom ?? sec.diffOld;
  const newPath = sec.headNew !== undefined ? sec.headNew : sec.renameTo ?? sec.diffNew;
  const isCreate = oldPath === null || sec.newFile;
  const isDelete = newPath === null || sec.deletedFile;

  if (isCreate) {
    const target = newPath ?? oldPath;
    if (target === undefined || target === null) return fail('unsafe', '');
    if (!isSafePath(target)) return fail('unsafe', target);
    if (tree.exists(target)) return fail('exists', target);
    const created: string[] = [];
    let lastAdd: Op | undefined;
    for (const hunk of sec.hunks) {
      for (const op of hunk.ops) {
        if (op.kind === 'add') {
          created.push(op.text);
          lastAdd = op;
        }
      }
    }
    const finalBreak = created.length > 0 && !(lastAdd?.noBreak ?? false);
    tree.write(target, fromLines({ brk: '\n', lines: created, finalBreak }));
    return OK;
  }
  if (oldPath === undefined || oldPath === null) return fail('unsafe', '');
  if (!isSafePath(oldPath)) return fail('unsafe', oldPath);
  if (isDelete) {
    if (!tree.exists(oldPath)) return fail('missing', oldPath);
    tree.remove(oldPath);
    return OK;
  }
  if (newPath === undefined || newPath === null) return fail('unsafe', '');
  if (newPath !== oldPath && !isSafePath(newPath)) return fail('unsafe', newPath);
  if (!tree.exists(oldPath)) return fail('missing', oldPath);
  if (newPath !== oldPath && tree.exists(newPath)) return fail('exists', newPath);
  const file = toLines(tree.read(oldPath) ?? '');
  const applied = applyHunks(sec, file, strict);
  if ('code' in applied) return fail(applied.code, oldPath);
  const out: FileLines = { brk: file.brk, lines: applied.lines, finalBreak: applied.finalBreak };
  if (newPath !== oldPath) {
    tree.write(newPath, fromLines(out));
    tree.remove(oldPath);
    tree.moves.push([oldPath, newPath]);
  } else {
    tree.write(oldPath, fromLines(out));
  }
  return OK;
}

/* ------------------------------------------------------------------ */
/* SEARCH/REPLACE blocks (section 7)                                   */
/* ------------------------------------------------------------------ */

interface Block {
  path: string;
  oldLines: string[];
  newLines: string[];
}

function parseSearchReplace(lines: string[]): Block[] {
  const blocks: Block[] = [];
  let prevPath: string | undefined;
  let searchFrom = 0;
  let i = 0;
  while (i < lines.length) {
    if (lines[i].replace(/[ \t]+$/, '') !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchLine = i;
    // The path is the nearest qualifying line before the SEARCH line.
    let path = prevPath;
    for (let j = searchLine - 1; j >= searchFrom; j -= 1) {
      const t = lines[j].trim();
      if (t === '' || t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === undefined) throw new ParseFault(searchLine + 1);
    let sep = -1;
    for (let j = searchLine + 1; j < lines.length; j += 1) {
      if (lines[j].replace(/[ \t]+$/, '') === '=======') {
        sep = j;
        break;
      }
    }
    let end = -1;
    if (sep >= 0) {
      for (let j = sep + 1; j < lines.length; j += 1) {
        if (lines[j].replace(/[ \t]+$/, '') === '>>>>>>> REPLACE') {
          end = j;
          break;
        }
      }
    }
    if (sep < 0 || end < 0) throw new ParseFault(searchLine + 1);
    blocks.push({
      path,
      oldLines: lines.slice(searchLine + 1, sep),
      newLines: lines.slice(sep + 1, end),
    });
    prevPath = path;
    searchFrom = end + 1;
    i = end + 1;
  }
  return blocks;
}

function applyBlock(tree: Tree, block: Block, strict: boolean): EditOutcome {
  if (!isSafePath(block.path)) return fail('unsafe', block.path);
  if (block.oldLines.length === 0) {
    if (tree.exists(block.path)) return fail('exists', block.path);
    tree.write(
      block.path,
      fromLines({ brk: '\n', lines: block.newLines, finalBreak: block.newLines.length > 0 }),
    );
    return OK;
  }
  if (!tree.exists(block.path)) return fail('missing', block.path);
  const file = toLines(tree.read(block.path) ?? '');
  const match = findMatch(file.lines, block.oldLines, strict);
  if (match === null) return fail('no-match', block.path);
  if (match.positions.length > 1) return fail('ambiguous', block.path);
  const pos = match.positions[0];
  const ops: Op[] = [
    ...block.oldLines.map((text): Op => ({ kind: 'del', text, noBreak: false })),
    ...block.newLines.map((text): Op => ({ kind: 'add', text, noBreak: false })),
  ];
  const lines = [...file.lines];
  lines.splice(pos, block.oldLines.length, ...writtenLines(ops, file.lines, pos, match.tier));
  tree.write(block.path, fromLines({ brk: file.brk, lines, finalBreak: file.finalBreak }));
  return OK;
}

/* ------------------------------------------------------------------ */
/* V4A patches (section 8)                                             */
/* ------------------------------------------------------------------ */

interface Chunk {
  anchor: string | null;
  eof: boolean;
  ops: Op[];
}

interface VSection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  lineNo: number;
  fileLines: string[];
  moveTo?: string;
  chunks: Chunk[];
}

function parseV4a(lines: string[]): VSection[] {
  const isBlank = (s: string): boolean => s.trim() === '';
  let first = -1;
  let last = -1;
  for (let j = 0; j < lines.length; j += 1) {
    if (!isBlank(lines[j])) {
      if (first < 0) first = j;
      last = j;
    }
  }
  if (first < 0) throw new ParseFault(1);
  if (lines[first].trim() !== '*** Begin Patch') throw new ParseFault(first + 1);
  if (lines[last].trim() !== '*** End Patch') throw new ParseFault(lines.length + 1);

  const headerOf = (s: string): { kind: VSection['kind']; path: string } | null => {
    if (s.startsWith('*** Add File: ')) return { kind: 'add', path: s.slice(14).trim() };
    if (s.startsWith('*** Delete File: ')) return { kind: 'delete', path: s.slice(17).trim() };
    if (s.startsWith('*** Update File: ')) return { kind: 'update', path: s.slice(17).trim() };
    return null;
  };

  const sections: VSection[] = [];
  let i = first + 1;
  while (i < last) {
    if (isBlank(lines[i])) {
      i += 1;
      continue;
    }
    const head = headerOf(lines[i]);
    if (head === null) throw new ParseFault(i + 1);
    const startLine = i + 1;
    i += 1;
    const raw: Array<{ text: string; no: number }> = [];
    while (i < last && headerOf(lines[i]) === null) {
      raw.push({ text: lines[i], no: i + 1 });
      i += 1;
    }
    while (raw.length > 0 && raw[raw.length - 1].text.trim() === '') raw.pop();

    if (head.kind === 'add') {
      const fileLines: string[] = [];
      for (const r of raw) {
        if (r.text === '') fileLines.push('');
        else if (r.text.startsWith('+')) fileLines.push(r.text.slice(1));
        else throw new ParseFault(r.no);
      }
      sections.push({ kind: 'add', path: head.path, lineNo: startLine, fileLines, chunks: [] });
    } else if (head.kind === 'delete') {
      for (const r of raw) {
        if (r.text.trim() !== '') throw new ParseFault(r.no);
      }
      sections.push({ kind: 'delete', path: head.path, lineNo: startLine, fileLines: [], chunks: [] });
    } else {
      const vs: VSection = { kind: 'update', path: head.path, lineNo: startLine, fileLines: [], chunks: [] };
      let chunk: Chunk | null = null;
      let seenContent = false;
      for (const r of raw) {
        if (r.text.startsWith('*** Move to: ')) {
          if (seenContent) throw new ParseFault(r.no);
          vs.moveTo = r.text.slice(12).trim();
          seenContent = true;
          continue;
        }
        seenContent = true;
        if (r.text.startsWith('@@')) {
          const anchor = r.text.slice(2).trim();
          chunk = { anchor: anchor === '' ? null : anchor, eof: false, ops: [] };
          vs.chunks.push(chunk);
          continue;
        }
        if (r.text.replace(/[ \t]+$/, '') === '*** End of File') {
          if (chunk === null) throw new ParseFault(r.no);
          chunk.eof = true;
          chunk = null;
          continue;
        }
        const c = r.text.charAt(0);
        if (r.text === '' || c === ' ' || c === '-' || c === '+') {
          if (chunk === null) {
            chunk = { anchor: null, eof: false, ops: [] };
            vs.chunks.push(chunk);
          }
          if (r.text === '') chunk.ops.push({ kind: 'ctx', text: '', noBreak: false });
          else if (c === ' ') chunk.ops.push({ kind: 'ctx', text: r.text.slice(1), noBreak: false });
          else if (c === '-') chunk.ops.push({ kind: 'del', text: r.text.slice(1), noBreak: false });
          else chunk.ops.push({ kind: 'add', text: r.text.slice(1), noBreak: false });
          continue;
        }
        throw new ParseFault(r.no);
      }
      if (vs.chunks.length === 0 && vs.moveTo === undefined) throw new ParseFault(startLine);
      sections.push(vs);
    }
  }
  return sections;
}

function applyVSection(tree: Tree, vs: VSection, strict: boolean): EditOutcome {
  if (!isSafePath(vs.path)) return fail('unsafe', vs.path);
  if (vs.kind === 'add') {
    if (tree.exists(vs.path)) return fail('exists', vs.path);
    tree.write(
      vs.path,
      fromLines({ brk: '\n', lines: vs.fileLines, finalBreak: vs.fileLines.length > 0 }),
    );
    return OK;
  }
  if (vs.kind === 'delete') {
    if (!tree.exists(vs.path)) return fail('missing', vs.path);
    tree.remove(vs.path);
    return OK;
  }
  if (!tree.exists(vs.path)) return fail('missing', vs.path);
  if (vs.moveTo !== undefined) {
    if (!isSafePath(vs.moveTo)) return fail('unsafe', vs.moveTo);
    if (tree.exists(vs.moveTo)) return fail('exists', vs.moveTo);
  }
  const file = toLines(tree.read(vs.path) ?? '');
  const lines = [...file.lines];
  let cursor = 0;
  for (const chunk of vs.chunks) {
    if (chunk.anchor !== null) {
      const tiers = strict ? [0] : [0, 1, 2];
      let found = -1;
      for (const tier of tiers) {
        for (let j = cursor; j < lines.length; j += 1) {
          if (normLine(lines[j], tier) === normLine(chunk.anchor, tier)) {
            found = j;
            break;
          }
        }
        if (found >= 0) break;
      }
      if (found < 0) return fail('no-match', vs.path);
      cursor = found + 1;
    }
    const old = oldTexts(chunk.ops);
    if (old.length === 0) {
      const pos = chunk.eof ? lines.length : Math.min(cursor, lines.length);
      const added = writtenLines(chunk.ops, lines, Math.min(pos, lines.length), 0);
      lines.splice(pos, 0, ...added);
      cursor = pos + added.length;
    } else {
      const match = findMatch(lines, old, strict, cursor, chunk.eof);
      if (match === null) return fail('no-match', vs.path);
      const pos = match.positions[0];
      const written = writtenLines(chunk.ops, lines, pos, match.tier);
      lines.splice(pos, old.length, ...written);
      cursor = pos + written.length;
    }
  }
  const out = fromLines({ brk: file.brk, lines, finalBreak: file.finalBreak });
  if (vs.moveTo !== undefined) {
    tree.write(vs.moveTo, out);
    tree.remove(vs.path);
    tree.moves.push([vs.path, vs.moveTo]);
  } else {
    tree.write(vs.path, out);
  }
  return OK;
}

/* ------------------------------------------------------------------ */
/* JSON edits (section 9)                                              */
/* ------------------------------------------------------------------ */

type JsonEdit =
  | { command: 'create'; path: string; fileText: string }
  | { command: 'str_replace'; path: string; oldStr: string; newStr: string }
  | { command: 'insert'; path: string; insertLine: number; newStr: string };

/** A value read as one edit object, or null when it is not one. */
function asEdit(value: unknown): JsonEdit | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const o = value as Record<string, unknown>;
  if (typeof o.path !== 'string' || typeof o.command !== 'string') return null;
  if (o.command === 'create') {
    if (typeof o.file_text !== 'string') return null;
    return { command: 'create', path: o.path, fileText: o.file_text };
  }
  if (o.command === 'str_replace') {
    if (typeof o.old_str !== 'string' || o.old_str === '') return null;
    if (o.new_str !== undefined && typeof o.new_str !== 'string') return null;
    return { command: 'str_replace', path: o.path, oldStr: o.old_str, newStr: (o.new_str as string) ?? '' };
  }
  if (o.command === 'insert') {
    if (typeof o.insert_line !== 'number' || !Number.isInteger(o.insert_line)) return null;
    if (typeof o.new_str !== 'string') return null;
    return { command: 'insert', path: o.path, insertLine: o.insert_line, newStr: o.new_str };
  }
  return null;
}

function parseJson(text: string, lines: string[]): JsonEdit[] {
  const firstChar = /\S/.exec(text)?.[0];
  if (firstChar === '[') {
    const startLine = lines.findIndex((l) => l.trim() !== '') + 1;
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      throw new ParseFault(startLine);
    }
    if (!Array.isArray(value)) throw new ParseFault(startLine);
    return value.map((v) => {
      const edit = asEdit(v);
      if (edit === null) throw new ParseFault(startLine);
      return edit;
    });
  }
  const edits: JsonEdit[] = [];
  for (let j = 0; j < lines.length; j += 1) {
    if (lines[j].trim() === '') continue;
    let value: unknown;
    try {
      value = JSON.parse(lines[j]);
    } catch {
      throw new ParseFault(j + 1);
    }
    const edit = asEdit(value);
    if (edit === null) throw new ParseFault(j + 1);
    edits.push(edit);
  }
  return edits;
}

function applyJsonEdit(tree: Tree, edit: JsonEdit): EditOutcome {
  if (!isSafePath(edit.path)) return fail('unsafe', edit.path);
  if (edit.command === 'create') {
    if (tree.exists(edit.path)) return fail('exists', edit.path);
    tree.write(edit.path, edit.fileText);
    return OK;
  }
  if (!tree.exists(edit.path)) return fail('missing', edit.path);
  const content = tree.read(edit.path) ?? '';
  if (edit.command === 'str_replace') {
    const crlf = toLines(content).brk === '\r\n';
    const un = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
    const hay = un(content);
    const oldStr = un(edit.oldStr);
    const newStr = un(edit.newStr);
    let count = 0;
    let at = -1;
    for (let j = hay.indexOf(oldStr); j >= 0; j = hay.indexOf(oldStr, j + 1)) {
      count += 1;
      at = j;
    }
    if (count === 0) return fail('no-match', edit.path);
    if (count > 1) return fail('ambiguous', edit.path);
    let out = hay.slice(0, at) + newStr + hay.slice(at + oldStr.length);
    if (crlf) out = out.replaceAll('\n', '\r\n');
    tree.write(edit.path, out);
    return OK;
  }
  const file = toLines(content);
  if (edit.insertLine < 0 || edit.insertLine > file.lines.length) return fail('no-match', edit.path);
  const parts = edit.newStr.split('\n');
  if (parts.length > 0 && parts[parts.length - 1] === '') parts.pop();
  const inserted = parts.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
  const lines = [...file.lines];
  lines.splice(edit.insertLine, 0, ...inserted);
  tree.write(edit.path, fromLines({ brk: file.brk, lines, finalBreak: file.finalBreak }));
  return OK;
}

/* ------------------------------------------------------------------ */
/* Detecting the format (section 4)                                    */
/* ------------------------------------------------------------------ */

type Format = 'unified' | 'search-replace' | 'v4a' | 'json';

function detectFormat(lines: string[]): Format | null {
  const firstIdx = lines.findIndex((l) => l.trim() !== '');
  if (firstIdx >= 0) {
    if (lines[firstIdx].trim() === '*** Begin Patch') return 'v4a';
    const c = /\S/.exec(lines[firstIdx])?.[0];
    if (c === '[' || c === '{') return 'json';
  }
  if (lines.some((l) => l.replace(/[ \t]+$/, '') === '<<<<<<< SEARCH')) return 'search-replace';
  for (let j = 0; j < lines.length; j += 1) {
    if (lines[j].startsWith('diff --git ')) return 'unified';
    if (lines[j].startsWith('--- ') && j + 1 < lines.length && lines[j + 1].startsWith('+++ ')) return 'unified';
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* The command line (sections 1, 2 and 10)                             */
/* ------------------------------------------------------------------ */

function byteCompare(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

function runCli(argv: string[]): number {
  const out: string[] = [];
  const say = (line: string): void => {
    out.push(line);
  };
  const finish = (code: number): number => {
    if (out.length > 0) process.stdout.write(out.join('\n') + '\n');
    return code;
  };

  let formatOpt = 'auto';
  let checkOnly = false;
  let strict = false;
  let patchArg: string | undefined;
  let usageError = false;
  const seen = new Set<string>();
  let positionalOnly = false;
  for (const arg of argv) {
    if (!positionalOnly && arg === '--') {
      positionalOnly = true;
      continue;
    }
    if (!positionalOnly && arg.startsWith('-') && arg !== '-') {
      if (arg === '--check' || arg === '--strict') {
        if (seen.has(arg)) usageError = true;
        seen.add(arg);
        if (arg === '--check') checkOnly = true;
        else strict = true;
      } else if (arg.startsWith('--format=')) {
        if (seen.has('--format')) usageError = true;
        seen.add('--format');
        formatOpt = arg.slice('--format='.length);
        if (!['unified', 'search-replace', 'v4a', 'json', 'auto'].includes(formatOpt)) usageError = true;
      } else {
        usageError = true;
      }
      continue;
    }
    if (patchArg !== undefined) usageError = true;
    else patchArg = arg;
  }
  if (usageError) {
    say('error: usage');
    return finish(2);
  }

  let patchText: string;
  if (patchArg === undefined || patchArg === '-') {
    patchText = readFileSync(0, 'utf8');
  } else {
    try {
      patchText = readFileSync(join(process.cwd(), patchArg), 'utf8');
    } catch {
      say('error: no-patch');
      return finish(2);
    }
  }
  const patchLines = splitPatch(patchText);

  let format: Format | null;
  if (formatOpt === 'auto') {
    format = detectFormat(patchLines);
    if (format === null) {
      say('error: format');
      return finish(2);
    }
  } else {
    format = formatOpt as Format;
  }

  const tree = new Tree();
  let total = 0;
  const failures: EditFailure[] = [];
  try {
    if (format === 'unified') {
      const sections = parseUnified(patchLines);
      if (sections.length === 0) throw new ParseFault(1);
      total = sections.length;
      for (const sec of sections) {
        const r = applySection(tree, sec, strict);
        if (!r.ok) failures.push(r.failure);
      }
    } else if (format === 'search-replace') {
      const blocks = parseSearchReplace(patchLines);
      if (blocks.length === 0) throw new ParseFault(1);
      total = blocks.length;
      for (const block of blocks) {
        const r = applyBlock(tree, block, strict);
        if (!r.ok) failures.push(r.failure);
      }
    } else if (format === 'v4a') {
      const sections = parseV4a(patchLines);
      if (sections.length === 0) throw new ParseFault(1);
      total = sections.length;
      for (const vs of sections) {
        const r = applyVSection(tree, vs, strict);
        if (!r.ok) failures.push(r.failure);
      }
    } else {
      const edits = parseJson(patchText, patchLines);
      if (edits.length === 0) throw new ParseFault(1);
      total = edits.length;
      for (const edit of edits) {
        const r = applyJsonEdit(tree, edit);
        if (!r.ok) failures.push(r.failure);
      }
    }
  } catch (err) {
    if (err instanceof ParseFault) {
      say(`error: parse ${err.line}`);
      return finish(2);
    }
    throw err;
  }

  if (failures.length > 0) {
    for (const f of failures) say(`error: ${f.code} ${f.path}`);
    say(`failed: ${failures.length} of ${total} edits`);
    return finish(1);
  }

  // Every edit ran: report the paths whose state changed, then write.
  const changes: Array<{ sortKey: string; line: string }> = [];
  const covered = new Set<string>();
  for (const [oldP, newP] of tree.moves) {
    if (
      tree.original(oldP) !== null &&
      tree.read(oldP) === null &&
      tree.original(newP) === null &&
      tree.read(newP) !== null
    ) {
      changes.push({ sortKey: newP, line: `R ${oldP} -> ${newP}` });
      covered.add(oldP);
      covered.add(newP);
    }
  }
  for (const p of tree.touched()) {
    if (covered.has(p)) continue;
    const before = tree.original(p);
    const after = tree.read(p);
    if (before === after) continue;
    if (before === null) changes.push({ sortKey: p, line: `A ${p}` });
    else if (after === null) changes.push({ sortKey: p, line: `D ${p}` });
    else changes.push({ sortKey: p, line: `M ${p}` });
  }
  changes.sort((x, y) => byteCompare(x.sortKey, y.sortKey));
  for (const c of changes) say(c.line);
  say(changes.length === 1 ? 'ok: 1 file' : `ok: ${changes.length} files`);
  if (!checkOnly) tree.flush();
  return finish(0);
}

/* ------------------------------------------------------------------ */
/* Entry: a trial when the env says so, the CLI otherwise              */
/* ------------------------------------------------------------------ */

const envUrl = process.env.MAKEFUN_ENV_URL;
if (envUrl) {
  await runTrial(envUrl);
} else {
  process.exitCode = runCli(process.argv.slice(2));
}
