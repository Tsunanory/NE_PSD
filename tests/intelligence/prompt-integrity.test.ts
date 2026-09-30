import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { loadPrompt, promptSpecifications } from '@ne-psd/intelligence';
const sourceFiles = { planner: 'docs/superpowers/prompts/planner-system.md', 'runtime-reviewer': 'docs/superpowers/prompts/runtime-reviewer-system.md', diagnostic: 'docs/superpowers/prompts/diagnostic-system.md' } as const;
const extract = (source: string) => { const start = source.indexOf('```text\n'); const body = source.slice(start + 8); return body.slice(0, body.indexOf('\n```')) + '\n'; };
describe('approved prompt integrity', () => {
  it.each(['planner', 'runtime-reviewer', 'diagnostic'] as const)('loads the exact %s packaged literal block', async (id) => { const prompt = await loadPrompt(id); const source = extract(await readFile(sourceFiles[id], 'utf8')); expect(prompt.text).toBe(source); expect(prompt.sha256).toBe(createHash('sha256').update(source).digest('hex')); });
  it('does not expose mutable prompt specification entries', async () => { const before = await loadPrompt('planner'); expect(() => { (promptSpecifications.planner as { sha256: string }).sha256 = 'changed'; }).toThrow(); const after = await loadPrompt('planner'); expect(after.sha256).toBe(before.sha256); });
});
