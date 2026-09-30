import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
export type PromptId = 'planner' | 'runtime-reviewer' | 'diagnostic';
const specs: Record<PromptId, { asset: string; sha256: string }> = {
  planner: { asset: 'planner-system.txt', sha256: '7526e222bc7df7ec0211f72f678e1f5dcaecf8344b68f88eeb565dc449726b63' },
  'runtime-reviewer': { asset: 'runtime-reviewer-system.txt', sha256: '5964f89bb5bfb776523ce0c012cd1063508b92b38ebbbf6cc677c7ded7bb132d' },
  diagnostic: { asset: 'diagnostic-system.txt', sha256: '32fbacdb9c912137751b4c0c202a851fb24c4fa60e1dfb211d35bdaddb952285' },
};
const extract = (source: string) => { const start = source.indexOf('```text\n'); if (start < 0) throw new Error('PROMPT_BLOCK_MISSING'); const body = source.slice(start + 8); const end = body.indexOf('\n```'); if (end < 0) throw new Error('PROMPT_BLOCK_MISSING'); return body.slice(0, end) + '\n'; };
export async function loadPrompt(id: PromptId) { const spec = specs[id]; const text = await readFile(fileURLToPath(new URL(`./${spec.asset}`, import.meta.url)), 'utf8'); const sha256 = createHash('sha256').update(text).digest('hex'); if (sha256 !== spec.sha256) throw new Error('PROMPT_HASH_MISMATCH'); if (/\{\{|\}\}|<PLACEHOLDER>|TODO/.test(text)) throw new Error('PROMPT_UNEXPANDED_PLACEHOLDER'); return Object.freeze({ id, text, sha256 }); }
export const promptSpecifications = Object.freeze(Object.fromEntries(Object.entries(specs).map(([id, value]) => [id, Object.freeze({ ...value })])));
