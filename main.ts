// Entry point the harness executes with `node /bot/main.ts` (Node 22
// strips the types natively; only erasable syntax is used here).
//
// It loads every case from cases.json in the input directory, renders
// each one in isolation through parse() from ./parse.js, and writes the
// HTML strings — one per case, same order — as a JSON array to
// html.json in the output directory.
//
// Outside the grading container the two directories can be pointed
// elsewhere with MAKEFUN_INPUT_DIR / MAKEFUN_OUTPUT_DIR. Nothing is
// cached between cases, no clock is read, and the only files touched
// are the input read and the output write.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from './parse.js';

const inDir = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const outDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

interface Case {
  id: string;
  markdown: string;
}

const cases = JSON.parse(readFileSync(join(inDir, 'cases.json'), 'utf8')) as Case[];

const html: string[] = [];
for (const c of cases) html.push(parse(c.markdown));

mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'html.json'), JSON.stringify(html));
