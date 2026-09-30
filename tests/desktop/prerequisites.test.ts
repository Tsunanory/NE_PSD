import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { evaluatePrerequisites, inspectOutputDirectory, checkPrerequisites, prerequisiteMessages } from '../../apps/desktop/src/main/prerequisites.js';

describe('desktop prerequisites', () => {
  it('reports every missing prerequisite without treating a Photoshop process as a license check', async () => {
    const result = await checkPrerequisites({ photoshop: async () => ({ connected: true, controllerQualified: true, licenseVerified: false }), model: async () => ({ reachable: false, artifactQualified: false }), runtime: async () => ({ verified: false }), output: async () => ({ writable: false, freeBytes: 0 }) });
    expect(result.ready).toBe(false);
    expect(result.messages).toEqual(expect.arrayContaining([prerequisiteMessages.photoshop, prerequisiteMessages.model, prerequisiteMessages.runtime, prerequisiteMessages.output]));
  });
  it('requires all qualified hooks and a writable rename-capable output', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'NE PSD Тест '));
    try {
      const output = await inspectOutputDirectory(dir, 1);
      expect(output.writable).toBe(true);
      const result = await checkPrerequisites({ photoshop: async () => ({ connected: true, controllerQualified: true, licenseVerified: true }), model: async () => ({ reachable: true, artifactQualified: true }), runtime: async () => ({ verified: true }), output: async () => output });
      expect(result.ready).toBe(true);
      expect(result.output?.freeBytes).toBeGreaterThan(0);
      expect(evaluatePrerequisites({ photoshop: false, model: false, runtime: false, output: false }).ready).toBe(false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
