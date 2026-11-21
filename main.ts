// main.ts — the program the harness runs: reads every case from
// /input/cases.json, answers each with solve.js's run, and writes
// /output/answers.json. Like the house baseline, it turns V8's incremental
// marking off before it imports solve.js.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { setFlagsFromString } from 'node:v8';

try {
  setFlagsFromString('--no-incremental-marking');
} catch {}

const { run } = await import('./solve.js');

const cases = JSON.parse(readFileSync('/input/cases.json', 'utf8'));
const answers = new Array(cases.length);
for (let k = 0; k < cases.length; k++) answers[k] = run(cases[k].input);
mkdirSync('/output', { recursive: true });
writeFileSync('/output/answers.json', JSON.stringify(answers));
