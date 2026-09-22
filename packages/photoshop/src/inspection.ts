import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { basename, join } from 'node:path';
import { tmpdir } from 'node:os';
import { CapabilityReportSchema, InspectionReportSchema, type CapabilityReport, type FileRef, type InspectionReport, type LayerSelector, type LayerSegment, type Rect } from '@ne-psd/contracts';
import { structuralFingerprint, type SelectorDocument, type SelectorLayer } from './selectors.js';
import type { SessionLock } from './session-lock.js';

export type LinkageObservation = { sourceKind: 'embedded' | 'linked' | 'unknown'; proven: boolean; source?: FileRef | null };
export type OpenedDocument = { document: SelectorDocument; opened: boolean };
export type InspectionAdapter = {
  lock: Pick<SessionLock, 'runExclusive'>;
  listDocuments(): Promise<readonly SelectorDocument[]>;
  openDocument(template: FileRef): Promise<OpenedDocument>;
  readDocument(documentId: string): Promise<SelectorDocument>;
  readLinkage(documentId: string, viaLayer?: SelectorLayer): Promise<LinkageObservation>;
  openContents(documentId: string, layer: SelectorLayer): Promise<OpenedDocument>;
  closeDiscard(documentId: string): Promise<void>;
  capabilities?: () => Promise<CapabilityReport>;
};
export type InspectionOptions = { evidenceDirectory?: string; inspectionId?: string; signal?: AbortSignal };

const sha = (bytes: Uint8Array | string): string => createHash('sha256').update(bytes).digest('hex');
const abortIf = (signal?: AbortSignal): void => { if (signal?.aborted) throw new Error('inspection cancelled'); };
const shapeOf = (layer: SelectorLayer): SelectorLayer & { effectiveBounds?: Rect | null; rawBounds?: Rect | null } => layer as SelectorLayer & { effectiveBounds?: Rect | null; rawBounds?: Rect | null };
function boundsOf(layer: SelectorLayer): Rect | null { const observed = shapeOf(layer); return layer.kind === 'shape' ? (observed.effectiveBounds ?? null) : (observed.effectiveBounds ?? layer.bounds ?? null); }

async function copyMaster(path: string, evidenceDirectory: string, supplied?: FileRef): Promise<FileRef> {
  const bytes = await readFile(path);
  await mkdir(evidenceDirectory, { recursive: true });
  const relativePath = `template-copy-${sha(bytes).slice(0, 16)}-${basename(path)}`;
  await copyFile(path, join(evidenceDirectory, relativePath));
  return { rootId: supplied?.rootId ?? 'inspection-owned-root', relativePath, sha256: sha(bytes) };
}

function roleHints(layer: SelectorLayer): Array<'target' | 'reference' | 'input' | 'variant'> {
  const n = layer.name.toLocaleLowerCase(); const roles: Array<'target' | 'reference' | 'input' | 'variant'> = [];
  if (n.includes('reference') || n.includes('ref')) roles.push('reference');
  if (n.includes('target') || layer.kind === 'smartObject') roles.push('target');
  if (n.includes('картинка') || /^\d$/.test(n)) roles.push('variant');
  if (n.includes('input') || n.includes('asset')) roles.push('input');
  return roles;
}

type Candidate = { documentKey: string; layer: SelectorLayer; selector: LayerSelector; path: string };
function collectLayers(doc: SelectorDocument, documentKey: string, route: LayerSegment[][] = []): Candidate[] {
  const out: Candidate[] = [];
  const walk = (layers: SelectorLayer[], path: LayerSegment[], prefix: string): void => {
    layers.forEach((layer, index) => {
      const segment = { name: layer.name, kind: layer.kind, fingerprint: structuralFingerprint(layer, layers, [index]) };
      const next = [...path, segment]; out.push({ documentKey, layer, selector: { documentRoute: route, layerPath: next }, path: `${prefix}/${index}` });
      if (layer.children.length) walk(layer.children as SelectorLayer[], next, `${prefix}/${index}`);
    });
  };
  walk(doc.layers, [], 'root'); return out;
}

async function inspectWithAdapter(path: string, adapter: InspectionAdapter, supplied: FileRef | undefined, options: InspectionOptions): Promise<InspectionReport> {
  const evidenceDirectory = options.evidenceDirectory ?? join(tmpdir(), 'ne-psd-inspection-evidence');
  return adapter.lock.runExclusive(options.inspectionId ?? 'inspection', async () => {
    abortIf(options.signal);
    const template = await copyMaster(path, evidenceDirectory, supplied);
    const preExisting = new Set((await adapter.listDocuments()).map((doc) => doc.id));
    const opened: string[] = [];
    const unresolvedLinks: string[] = [];
    const docs: Array<{ doc: SelectorDocument; key: string; parentKey: string | null; viaLayer: LayerSelector | null; sourceKind: 'root' | 'embedded' | 'linked' | 'unknown'; source: FileRef | null }> = [];
    try {
      const rootOpened = await adapter.openDocument(template);
      if (rootOpened.opened && !preExisting.has(rootOpened.document.id)) opened.push(rootOpened.document.id);
      const root = await adapter.readDocument(rootOpened.document.id);
      docs.push({ doc: root, key: 'root', parentKey: null, viaLayer: null, sourceKind: 'root', source: template });
      const candidates: Candidate[] = [];
      const visit = async (doc: SelectorDocument, key: string, route: LayerSegment[][]): Promise<void> => {
        const layers = collectLayers(doc, key, route); candidates.push(...layers);
        for (const item of layers) {
          if (item.layer.kind !== 'smartObject') continue;
          const linkage = await adapter.readLinkage(doc.id, item.layer);
          if (!linkage.proven || linkage.sourceKind === 'unknown') { unresolvedLinks.push(`${key}:${item.path}:linkage-unproven`); continue; }
          const childOpened = await adapter.openContents(doc.id, item.layer);
          if (childOpened.opened && !preExisting.has(childOpened.document.id)) opened.push(childOpened.document.id);
          const child = childOpened.document;
          const childKey = `child-${docs.length}`; const via = item.selector.layerPath;
          docs.push({ doc: child, key: childKey, parentKey: key, viaLayer: { documentRoute: route, layerPath: via }, sourceKind: linkage.sourceKind, source: linkage.source ?? null });
          await visit(child, childKey, [...route, [via.at(-1)!]]);
        }
      };
      await visit(root, 'root', []);
      const reportCandidates = candidates.map((item, index) => ({ candidateId: `candidate-${index + 1}`, documentKey: item.documentKey, selector: item.selector, bounds: boundsOf(item.layer), visible: item.layer.visible, clipped: item.layer.clipped, belowCandidateId: null, roleHints: roleHints(item.layer) }));
      const capability = adapter.capabilities ? CapabilityReportSchema.parse(await adapter.capabilities()) : null;
      const status = capability && unresolvedLinks.length === 0 ? 'liveObserved' as const : 'staticCandidate' as const;
      const report = InspectionReportSchema.parse({ schemaVersion: 1, inspectionId: options.inspectionId ?? `inspection-${sha(template.sha256).slice(0, 24)}`, evidenceStatus: status, template, capabilities: status === 'liveObserved' ? capability : null, documents: docs.map((d) => ({ documentKey: d.key, parentKey: d.parentKey, viaLayer: d.viaLayer, sourceKind: d.sourceKind, source: d.source, width: d.doc.width, height: d.doc.height, colorMode: 'RGB', bitDepth: 8 })), candidates: reportCandidates, observedVariantStates: reportCandidates.filter((c) => c.roleHints.includes('variant')).map((c) => ({ candidateId: c.candidateId, visible: c.visible })), unresolvedLinks, evidencePaths: ['inspection/report.json', 'inspection/trace.json'] });
      await mkdir(join(evidenceDirectory, 'inspection'), { recursive: true });
      await writeFile(join(evidenceDirectory, 'inspection/report.json'), JSON.stringify(report, null, 2));
      await writeFile(join(evidenceDirectory, 'inspection/trace.json'), JSON.stringify({ preExistingDocumentIds: [...preExisting], openedDocumentIds: opened, lifecycle: docs.map((d) => ({ documentKey: d.key, parentKey: d.parentKey, viaLayer: d.viaLayer, save: 'never', close: opened.includes(d.doc.id) ? 'discard' : 'preserve' })), geometry: candidates.map((item) => ({ candidateId: reportCandidates.find((candidate) => candidate.selector === item.selector)?.candidateId ?? null, path: item.path, rawBounds: shapeOf(item.layer).rawBounds ?? item.layer.bounds ?? null, effectiveBounds: shapeOf(item.layer).effectiveBounds ?? null, mask: shapeOf(item.layer).mask ?? null, vectorMetadata: shapeOf(item.layer).typeMetadata ?? null, visible: item.layer.visible, clipped: item.layer.clipped })) }, null, 2));
      return report;
    } finally { for (const id of [...opened].reverse()) await adapter.closeDiscard(id); }
  }, options.signal);
}

export async function inspect(templatePath: string, adapter: InspectionAdapter, options?: InspectionOptions & { template?: FileRef }): Promise<InspectionReport>;
export async function inspect(adapter: InspectionAdapter, templatePath: string, options?: InspectionOptions & { template?: FileRef }): Promise<InspectionReport>;
export async function inspect(first: string | InspectionAdapter, second: string | InspectionAdapter, options: InspectionOptions & { template?: FileRef } = {}): Promise<InspectionReport> { return typeof first === 'string' ? inspectWithAdapter(first, second as InspectionAdapter, options.template, options) : inspectWithAdapter(second as string, first, options.template, options); }
export const inspectTemplate = inspect;
