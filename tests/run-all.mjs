// `node --test tests/` runs this file (tests/package.json "main"): newer Node versions take a folder argument as a
// module, not as a folder of tests. It loads every *.test.mjs here, in name order, in this one test process.
// `node --test` with no argument finds the same files by itself and never loads this one.
import fs from 'node:fs';

const here = new URL('./', import.meta.url);
for (const file of fs.readdirSync(here).filter(f => f.endsWith('.test.mjs')).sort()) await import(new URL(file, here));
