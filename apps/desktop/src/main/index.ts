import { startDesktop } from './bootstrap.js';

const mode = process.env.NODE_ENV === 'development' ? 'development' : 'production';
startDesktop(mode, undefined, mode === 'development' && process.env.NE_PSD_DEV_FAKE === '1');
