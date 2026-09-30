import { createHash, randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
  ConfigurationProposalSchema,
  InspectionReportSchema,
  type ConfigurationProposal,
  type InspectionReport,
} from '@ne-psd/contracts';

type InspectionRecord = { inspection: InspectionReport; sourcePath: string; evidence: Array<{ path: string; sha256: string }> };
type ProposalRecord = { proposal: ConfigurationProposal; inspectionId: string };

export function withinRoot(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

export function verifiedFileInRoot(root: string, path: string): string {
  if (!isAbsolute(path) || path.includes('\0') || !withinRoot(root, resolve(path))) throw new Error('path is outside qualification root');
  const real = realpathSync(path);
  if (!withinRoot(root, real)) throw new Error('path escapes qualification root');
  let current = root;
  for (const part of relative(root, resolve(path)).split(sep)) {
    current = join(current, part);
    if (lstatSync(current).isSymbolicLink()) throw new Error('qualification path contains a symlink');
  }
  if (!lstatSync(path).isFile()) throw new Error('qualification path is not a file');
  return real;
}

export class QualificationStore {
  readonly root: string;

  constructor(root: string) {
    if (!isAbsolute(root) || root.includes('\0')) throw new Error('qualification root must be absolute');
    mkdirSync(root, { recursive: true });
    if (lstatSync(root).isSymbolicLink()) throw new Error('qualification root cannot be a symlink');
    this.root = realpathSync(root);
  }

  private recordPath(kind: 'inspections' | 'proposals', id: string): string {
    const key = createHash('sha256').update(id).digest('hex');
    const directory = join(this.root, kind);
    mkdirSync(directory, { recursive: true });
    if (lstatSync(directory).isSymbolicLink()) throw new Error('qualification store directory is a symlink');
    return join(directory, `${key}.json`);
  }

  private write(path: string, value: unknown): void {
    const temporary = `${path}.${randomUUID()}.tmp`;
    writeFileSync(temporary, JSON.stringify(value), { flag: 'wx', mode: 0o600 });
    renameSync(temporary, path);
  }

  saveInspection(inspection: InspectionReport, sourcePath: string, evidence: InspectionRecord['evidence']): void {
    const parsed = InspectionReportSchema.parse(inspection);
    const path = this.recordPath('inspections', parsed.inspectionId);
    try { if (this.getInspection(parsed.inspectionId)) throw new Error('inspection ID already exists'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    this.write(path, { inspection: parsed, sourcePath: realpathSync(sourcePath), evidence } satisfies InspectionRecord);
  }

  getInspection(id: string): InspectionRecord | null {
    let record: unknown;
    try { record = JSON.parse(readFileSync(this.recordPath('inspections', id), 'utf8')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
    if (!record || typeof record !== 'object' || !('inspection' in record) || !('sourcePath' in record) || typeof record.sourcePath !== 'string' || !('evidence' in record) || !Array.isArray(record.evidence)) throw new Error('persisted inspection is invalid');
    const inspection = InspectionReportSchema.parse(record.inspection);
    if (inspection.inspectionId !== id) throw new Error('persisted inspection ID mismatch');
    const evidence = record.evidence as InspectionRecord['evidence'];
    if (evidence.some((item) => !item || typeof item.path !== 'string' || !/^[a-f0-9]{64}$/.test(item.sha256))) throw new Error('persisted inspection evidence is invalid');
    return { inspection, sourcePath: record.sourcePath, evidence };
  }

  createEvidenceDirectory(qualificationId: string): string {
    const parent = join(this.root, 'qualifications');
    mkdirSync(parent, { recursive: true });
    if (lstatSync(parent).isSymbolicLink() || realpathSync(parent) !== parent) throw new Error('qualification evidence parent is redirected');
    const directory = join(parent, qualificationId);
    mkdirSync(directory);
    if (lstatSync(directory).isSymbolicLink() || realpathSync(directory) !== directory) throw new Error('qualification evidence directory is redirected');
    return directory;
  }

  saveProposal(proposal: ConfigurationProposal): void {
    const parsed = ConfigurationProposalSchema.parse(proposal);
    this.write(this.recordPath('proposals', parsed.inspectionId), { proposal: parsed, inspectionId: parsed.inspectionId } satisfies ProposalRecord);
  }

  getProposal(inspectionId: string): ConfigurationProposal | null {
    let record: unknown;
    try { record = JSON.parse(readFileSync(this.recordPath('proposals', inspectionId), 'utf8')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
    if (!record || typeof record !== 'object' || !('proposal' in record)) throw new Error('persisted proposal is invalid');
    const proposal = ConfigurationProposalSchema.parse(record.proposal);
    if (proposal.inspectionId !== inspectionId) throw new Error('persisted proposal ID mismatch');
    return proposal;
  }
}
