import { access, readFile } from 'node:fs/promises';
const required = ['AGENTS.md', 'ARCHITECTURE.md', 'docs/README.md', 'docs/design-docs/index.md', 'docs/design-docs/core-beliefs.md', 'docs/design-docs/system-architecture.md', 'docs/design-docs/functional-design.md', 'docs/product-specs/index.md', 'docs/product-specs/dockyard-mvp.md', 'docs/exec-plans/completed/2026-08-bootstrap.md', 'docs/tech-debt-tracker.md'];
await Promise.all(required.map(async (file) => access(file)));
const [designIndex, productIndex] = await Promise.all(['docs/design-docs/index.md', 'docs/product-specs/index.md'].map((file) => readFile(file, 'utf8')));
for (const [index, linked] of [[designIndex, ['core-beliefs.md', 'system-architecture.md', 'functional-design.md']], [productIndex, ['dockyard-mvp.md']]]) {
  for (const filename of linked) if (!index.includes(filename)) throw new Error(`Documentation index is missing ${filename}`);
}
console.log(`Documentation map healthy (${required.length} required artifacts).`);
