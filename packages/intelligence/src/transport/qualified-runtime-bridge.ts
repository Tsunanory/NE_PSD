import { lstat, realpath } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { QualificationOptions, QualificationRuntime } from '../cli/qualify-model.js';

/** The operator supplies an installed runtime module explicitly; this package has no model endpoint to infer. */
export async function createQualificationRuntime(options: QualificationOptions): Promise<QualificationRuntime> {
  const configured = process.env.NE_PSD_QUALIFIED_RUNTIME_BRIDGE_MODULE;
  if (!configured || !isAbsolute(configured)) throw new Error('OPERATOR_RUNTIME_BRIDGE_NOT_CONFIGURED');
  const physical = await realpath(configured);
  if (physical !== configured || !(await lstat(physical)).isFile()) throw new Error('OPERATOR_RUNTIME_BRIDGE_INVALID_FILE');
  const loaded = await import(pathToFileURL(physical).href) as { createQualificationRuntime?: (options: QualificationOptions) => Promise<QualificationRuntime> };
  if (typeof loaded.createQualificationRuntime !== 'function') throw new Error('OPERATOR_RUNTIME_BRIDGE_EXPORT_MISSING');
  const runtime = await loaded.createQualificationRuntime(options);
  if (!runtime || runtime.provenance !== 'live' || !Number.isSafeInteger(runtime.deadlineMs) || runtime.deadlineMs <= 0 ||
      !runtime.locks || typeof runtime.probe !== 'function' || typeof runtime.beginMeasurement !== 'function' ||
      !runtime.transport || typeof runtime.transport.invoke !== 'function' || typeof runtime.counterFor !== 'function' ||
      typeof runtime.measure !== 'function') throw new Error('OPERATOR_RUNTIME_BRIDGE_INVALID');
  return runtime;
}
