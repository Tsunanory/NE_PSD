import { describe, expect, it } from 'vitest';
import { assertFreshMessages } from '@ne-psd/intelligence';
import { makeIntelligenceHarness } from './helpers/harness.js';
describe('fresh transport context', () => {
  it('accepts only one system and one current user message', () => {
    expect(() => assertFreshMessages([{ role: 'system', content: 's' }, { role: 'user', content: 'u' }])).not.toThrow();
    expect(() => assertFreshMessages([{ role: 'system', content: 's' }, { role: 'assistant' as never, content: 'old' }])).toThrow(/exactly one/i);
  });
  it('records three fresh calls without carrying planner or first-asset state', async () => {
    const harness = makeIntelligenceHarness(); await harness.propose(harness.fixtures.validProposalRequest); await harness.review('asset-1'); await harness.review('asset-2');
    expect(harness.calls).toHaveLength(3); expect(new Set(harness.calls.map((call) => call.sessionId)).size).toBe(3);
    for (const call of harness.calls) { expect(call.messages.map((message) => message.role)).toEqual(['system', 'user']); expect(call.tools).toBeUndefined(); expect(call.conversationId).toBeUndefined(); }
    expect(harness.calls[1]?.messages[0]?.content).not.toBe(harness.calls[0]?.messages[0]?.content); expect(harness.userText(harness.calls[1]!.messages[1])).not.toContain(harness.fixtures.plannerOnlyCanary); expect(harness.userText(harness.calls[2]!.messages[1])).not.toContain(harness.fixtures.firstAssetOnlyCanary);
  });
});
