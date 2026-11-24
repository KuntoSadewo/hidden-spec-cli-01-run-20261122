# mend

![make.fun bounty](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)
![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/KuntoSadewo/hidden-spec-cli-01-run-20261122/rank.svg)
![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/KuntoSadewo/hidden-spec-cli-01-run-20261122/reward.svg)

Built for the make.fun bounty [hidden-spec-cli-01-run-20261122](https://make.fun/bounty/hidden-spec-cli-01-run-20261122).

`mend` applies an edit that an AI model wrote to a tree of text files. Models
write edits in four formats — a unified diff (often with wrong line numbers),
SEARCH/REPLACE blocks, the V4A patch format, and text-editor tool calls as
JSON — and mend reads each one the way `SPEC.md` says, then changes every
file or nothing at all.

## Usage

    node main.ts [--format=NAME] [--check] [--strict] [PATCH]

- `PATCH` is the patch file, relative to the working directory, which is the
  root of the tree. When `PATCH` is absent or `-`, the patch is read from
  standard input.
- `--format=NAME` is one of `unified`, `search-replace`, `v4a` or `json`;
  the default, `auto`, detects the format from the patch text.
- `--check` does everything but write: the same output and exit code, and no
  file is created, changed or deleted.
- `--strict` matches lines exactly (tier 0 only).
- Options and `PATCH` may come in any order; `--` ends the options.

Node 22 and its standard library alone; there is nothing to install.

## Output and exit codes

- Exit 0: the tree is written. One line per changed path (`A`, `D`, `M`, or
  `R <old> -> <new>` for a move), sorted by path, then `ok: <n> files`.
- Exit 1: nothing is written. One `error: <code> <path>` line per failed edit
  (`no-match`, `ambiguous`, `missing`, `exists`, `unsafe`), then
  `failed: <k> of <n> edits`.
- Exit 2: exactly one line — `error: usage`, `error: no-patch`,
  `error: format`, or `error: parse <N>` naming the patch line at fault.

## How matching works

Unified hunks, SEARCH/REPLACE blocks and V4A chunks name old lines that are
replaced by new lines. The old lines are looked for at the first of three
tiers that has an occurrence: exact (tier 0), equal once trailing spaces and
tabs are removed (tier 1), and equal once leading and trailing spaces and
tabs are removed (tier 2). Context lines are written back as the file's own
lines, and at tier 2 the new lines are re-indented onto the file's
indentation. Unified hunks pick the occurrence nearest the line number the
hunk claims, which is what makes diffs with wrong line numbers still land.

Files keep their own line breaks (LF or CRLF) and their final line break;
files an edit creates are written with LF breaks. Edits apply in the patch's
order, each to the tree as the earlier edits left it, and a failed edit
changes nothing — if any edit fails, no file is written at all.

## Files

- `main.ts` — the CLI.
- `runner.ts` — the trial hand-over: when `MAKEFUN_ENV_URL` is set, main.ts
  hands over to it and it runs the checks the environment serves.
- `SPEC.md` — the full specification mend implements.
- `LICENSE` — MIT.
