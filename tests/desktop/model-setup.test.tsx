import React from 'react';
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ModelSetup } from '../../apps/desktop/src/renderer/setup/ModelSetup.js';
import { evaluateModelSetup, evaluateModelSelection, validateModelTrigger, weightsOnlyLowerBoundGb } from '../../apps/desktop/src/renderer/setup/model-state.js';
import { modelCase, modelCases } from './fixtures/model-cases.js';

describe('desktop exact model setup', () => {
  it.each(['offline', 'wrongModel', 'wrongArtifact', 'badDigest', 'wrongRuntime', 'wrongChatTemplate', 'schemaFailed', 'toolsFailed', 'visionFailed', 'capacityFailed', 'reviewUnavailable', 'unqualified', 'synthetic'] as const)('blocks %s', (name) => {
    expect(evaluateModelSetup(modelCases[name]).ready).toBe(false);
  });
  it.each(['Q4', 'Q6', 'Q8'] as const)('applies identical gates to %s', (quantization) => {
    const evidence = modelCase(quantization);
    expect(evaluateModelSetup(evidence).ready).toBe(true);
    expect(evaluateModelSetup({ ...evidence, capabilities: { ...evidence.capabilities, tools: false } }).ready).toBe(false);
  });
  it('requires an independently qualified visual reviewer', () => {
    const planner = modelCase('Q4');
    const reviewer = modelCase('Q6');
    expect(evaluateModelSelection(planner, reviewer).ready).toBe(true);
    expect(evaluateModelSelection(planner, { ...reviewer, capabilities: { ...reviewer.capabilities, vision: false } }).automatedVisual).toBe(false);
    expect(evaluateModelSelection(planner, { ...reviewer, qualification: { qualified: false, evidencePaths: [], errors: [] } }).ready).toBe(false);
  });
  it('does not turn text-only review into a visual pass', () => {
    const evidence = modelCases.visionFailed;
    expect(evaluateModelSetup(evidence).automatedVisual).toBe(false);
    expect(renderToStaticMarkup(<ModelSetup evidence={evidence} />)).toContain('Модель не проверяет изображение визуально');
  });
  it('renders distinct gates and measured capacity', () => {
    const markup = renderToStaticMarkup(<ModelSetup evidence={modelCase('Q4')} reviewer={modelCase('Q6')} />);
    expect(markup).toContain('JSON Schema');
    expect(markup).toContain('Инструменты');
    expect(markup).toContain('Зрение');
    expect(markup).toContain('Q6');
    expect(markup).toContain('RAM');
    expect(weightsOnlyLowerBoundGb('Q4')).toBe(13.5);
    expect(weightsOnlyLowerBoundGb('Q6')).toBe(20.3);
    expect(weightsOnlyLowerBoundGb('Q8')).toBe(27);
  });
  it('rejects scheduled local Qwen and does not offer model fallback', () => {
    expect(validateModelTrigger('local-qwen', 'scheduled').allowed).toBe(false);
    expect(validateModelTrigger('luna', 'scheduled').reason).toContain('deferred');
    expect(evaluateModelSetup(modelCases.wrongModel).message).toContain('Указанная модель не подтверждена');
  });
});
