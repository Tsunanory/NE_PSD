import { readFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { DomainError } from '../domain.js';

export const RUNTIME_REQUIREMENT_IDS = [
  'BINDING.CURRENT_ATTEMPT',
  'MANIFEST.COMPLETE',
  'ARTIFACTS.EXACTLY_THREE',
  'IMAGE.DECODE_FORMAT',
  'IMAGE.DIMENSIONS_COLOR',
  'GEOMETRY.REQUESTED_FIT',
  'CLIPPING.ALPHA_ADJACENCY',
  'VARIANTS.VISIBILITY',
  'SMART_OBJECT.LINEAGE_PROPAGATION',
  'SAFETY.LINKED_ISOLATION',
  'SAFETY.ORIGINALS_UNCHANGED',
  'SAFETY.DOCUMENT_OWNERSHIP',
  'IMAGE.QUALITY',
  'VISUAL.QUALIFIED',
  'EVIDENCE.TRACE_COMPLETE',
] as const;

export type RuntimeRequirementId = (typeof RUNTIME_REQUIREMENT_IDS)[number];
export type FailureScenario =
  | 'mutationTimeout'
  | 'cancelDuringChildSave'
  | 'reviewOffline'
  | 'reviewDigestMismatch'
  | 'oneExportMissing'
  | 'caseCollision'
  | 'sourceChanged'
  | 'crashBeforePublish'
  | 'crashAfterPublishBeforeDb';

export type FakeClock = {
  now(): Date;
};

export function fixedClock(start = '2026-01-01T00:00:00.000Z', stepMs = 1): FakeClock {
  let tick = Date.parse(start);
  if (!Number.isFinite(tick)) throw new Error(`invalid fake clock start: ${start}`);
  return {
    now: () => {
      const current = new Date(tick);
      tick += stepMs;
      return current;
    },
  };
}

export type FailureRule = boolean | number;
export type FailureRules = Partial<Record<FailureScenario, FailureRule>> & Record<string, FailureRule | undefined>;

export class FailureSchedule {
  private readonly remaining: Map<string, FailureRule>;

  constructor(rules: FailureRules = {}) {
    this.remaining = new Map(Object.entries(rules).filter((entry): entry is [string, FailureRule] => entry[1] !== undefined));
  }

  consume(name: string): boolean {
    const rule = this.remaining.get(name);
    if (rule === undefined || rule === false || rule === 0) return false;
    if (rule === true) return true;
    if (rule > 1) this.remaining.set(name, rule - 1);
    else this.remaining.delete(name);
    return true;
  }

  enabled(name: string): boolean {
    const rule = this.remaining.get(name);
    return rule === true || (typeof rule === 'number' && rule > 0);
  }

  snapshot(): Record<string, FailureRule> {
    return Object.fromEntries(this.remaining.entries());
  }
}

export class FakeFailureError extends Error {
  readonly scenario: string;
  readonly testOnly = true as const;
  readonly domainError: DomainError;

  constructor(scenario: string, message = `fake failure: ${scenario}`) {
    super(message);
    this.name = 'FakeFailureError';
    this.scenario = scenario;
    this.domainError = {
      code: `FAKE_${scenario.toUpperCase().replaceAll(/[^A-Z0-9]+/g, '_')}`,
      category: scenario === 'reviewOffline' ? 'capability' : 'transient',
      message,
      retryable: scenario !== 'sourceChanged' && scenario !== 'caseCollision',
      evidencePaths: [`testOnly/errors/${scenario}.json`],
    };
  }
}

export type FakeConfig = {
  clock?: FakeClock;
  failures?: FailureRules;
  storageFailures?: Record<string, FailureRule | undefined>;
  idPrefix?: string;
  extensions?: Readonly<Record<string, unknown>>;
};

export function resolveFailureSchedule(config: FakeConfig): FailureSchedule {
  const rules: FailureRules = { ...(config.failures ?? {}) };
  for (const [operation, rule] of Object.entries(config.storageFailures ?? {})) {
    if (rule !== undefined) rules[`storage:${operation}`] = rule;
  }
  return new FailureSchedule(rules);
}

export function testOnlyPath(path: string): string {
  const normalized = path.replaceAll('\\', '/').replace(/^\/+/, '');
  return normalized === 'testOnly' || normalized.startsWith('testOnly/') ? normalized : `testOnly/${normalized}`;
}

export function asTestOnlyEvidencePaths(paths: readonly string[]): string[] {
  return paths.map(testOnlyPath);
}

export function fixtureRoot(root = process.cwd()): string {
  if (existsSync(join(root, 'capabilities.fake.json'))) return root;
  const candidates = [
    resolve(root, 'tests/fixtures/contracts'),
    resolve(root, '../tests/fixtures/contracts'),
    resolve(dirname(new URL(import.meta.url).pathname), '../../../../tests/fixtures/contracts'),
  ];
  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) throw new Error(`contract fixture root not found from ${root}`);
  return found;
}

export function fixturePath(name: string, root = process.cwd()): string {
  if (name.includes('..') || name.includes('/') || name.includes('\\')) throw new Error('fixture name must be a file name');
  return join(fixtureRoot(root), name);
}

export function loadFixture<T>(name: string, root = process.cwd()): T {
  return JSON.parse(readFileSync(fixturePath(name, root), 'utf8')) as T;
}

export async function loadFixtureAsync<T>(name: string, root = process.cwd()): Promise<T> {
  return JSON.parse(await readFile(fixturePath(name, root), 'utf8')) as T;
}

export function nextId(prefix: string, counter: { value: number }): string {
  counter.value += 1;
  return `${prefix}-${counter.value.toString().padStart(4, '0')}`;
}

export type FakeArtifactBytes = {
  readonly testOnly: true;
  readonly path: string;
  readonly data: Uint8Array;
  readonly format: 'jpeg' | 'png';
  readonly width: number;
  readonly height: number;
  readonly colorSpace: 'sRGB';
};
