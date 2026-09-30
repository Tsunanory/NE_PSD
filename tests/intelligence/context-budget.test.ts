import { describe, expect, it } from 'vitest';
import { calculateContextBudget, preflightContextBudget, invokeWithinBudget } from '@ne-psd/intelligence';
describe('context budget', () => {
  it('includes schema wrappers output safety and image tokens', () => {
    const result = calculateContextBudget({ systemTokens: 100, userTokens: 100, schemaTokens: 100, wrapperTokens: 100, imageTokens: 100, reservedOutputTokens: 100, safetyTokens: 100, modelContextTokens: 1000, runtimeContextTokens: 800 });
    expect(result.inputTokens).toBe(500); expect(result.allowance).toBe(600); expect(result.fits).toBe(true);
  });
  it('uses the smaller verified context and fails before invocation', () => { expect(calculateContextBudget({ systemTokens: 500, userTokens: 200, schemaTokens: 100, wrapperTokens: 100, imageTokens: 100, reservedOutputTokens: 100, safetyTokens: 100, modelContextTokens: 1000, runtimeContextTokens: 800 }).fits).toBe(false); });
  it('rejects invalid limits and throws before transport on overflow', () => { expect(() => calculateContextBudget({ systemTokens: -1, userTokens: 0, schemaTokens: 0, wrapperTokens: 0, imageTokens: 0, reservedOutputTokens: 1, safetyTokens: 1, modelContextTokens: 10, runtimeContextTokens: 10 })).toThrow(); expect(() => preflightContextBudget({ systemTokens: 500, userTokens: 200, schemaTokens: 100, wrapperTokens: 100, imageTokens: 100, reservedOutputTokens: 100, safetyTokens: 100, modelContextTokens: 1000, runtimeContextTokens: 800 })).toThrow(/CONTEXT_BUDGET_EXCEEDED/); });
  it('does not call transport on integrated budget overflow', async () => { let calls = 0; await expect(invokeWithinBudget({ invoke: async () => { calls++; return undefined as never; } }, {} as never, { systemTokens: 500, userTokens: 200, schemaTokens: 100, wrapperTokens: 100, imageTokens: 100, reservedOutputTokens: 100, safetyTokens: 100, modelContextTokens: 1000, runtimeContextTokens: 800 })).rejects.toThrow(/CONTEXT_BUDGET_EXCEEDED/); expect(calls).toBe(0); });
});
