// Driver for the hand-rolled Markdown parser.
//
// The harness runs `node /bot/main.ts` on Node 22. It reads every case
// from /input/cases.json (a JSON array of {id, markdown}), renders each
// one on its own with parse() from parse.js, and writes
// /output/html.json: a JSON array of the HTML strings, one per case and
// in the same order as the input. When running outside a container,
// MAKEFUN_INPUT_DIR and MAKEFUN_OUTPUT_DIR stand in for /input and
// /output. This driver does no caching, reads no clock, and touches only
// the input directory (read) and the output directory (write).

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from './parse.js';

const inputDir = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const outputDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

type InputCase = { id: string; markdown: string };

const cases = JSON.parse(readFileSync(join(inputDir, 'cases.json'), 'utf8')) as InputCase[];

const rendered: string[] = new Array(cases.length);
for (let i = 0; i < cases.length; i++) {
  rendered[i] = parse(cases[i].markdown);
}

mkdirSync(outputDir, { recursive: true });
writeFileSync(join(outputDir, 'html.json'), JSON.stringify(rendered));
