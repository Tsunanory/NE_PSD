export type FitMode = 'cover' | 'contain' | 'stretch';
export type SetupStatus = 'synthetic' | 'unqualified' | 'qualified' | 'blocked';
export type SelectorDetails = { candidateId: string; route: string; fingerprint: string; linked: boolean };
export type SetupState = { templateLabel: string; inputLabel: string; outputLabel: string; status: SetupStatus; fitMode: FitMode; supportedFits: readonly FitMode[]; selectors: readonly SelectorDetails[]; previews: readonly string[] };
export const initialSetupState: SetupState = { templateLabel: 'Шаблон не выбран', inputLabel: 'Входная папка не выбрана', outputLabel: 'Папка результатов не выбрана', status: 'synthetic', fitMode: 'cover', supportedFits: ['cover'], selectors: [{ candidateId: 'synthetic-target', route: 'Корень документа → Target', fingerprint: 'synthetic-target-fp', linked: false }], previews: ['Синтетический вариант 1', 'Синтетический вариант 2', 'Синтетический вариант 3'] };
