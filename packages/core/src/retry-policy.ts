import { isRetryableTransportError } from './recovery.js';
export function mayRetryAttempt(error: unknown, attempt: number): boolean { return attempt === 1 && isRetryableTransportError(error); }
