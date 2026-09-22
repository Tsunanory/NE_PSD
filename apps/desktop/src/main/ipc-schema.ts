import { JobSpecSchema } from '@ne-psd/contracts';

export const IPC_CHANNELS = ['job.validate', 'job.start', 'job.pause', 'job.resume', 'job.cancel', 'job.snapshot', 'job.subscribe', 'setup.inspect', 'setup.propose', 'setup.qualify', 'app.diagnostic', 'onEvent'] as const;
export type IpcChannel = typeof IPC_CHANNELS[number];
const channelSet = new Set<string>(IPC_CHANNELS);

function noAbsolute(value: unknown): void {
  if (typeof value === 'string' && (value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value) || value.includes('\\'))) throw new Error('absolute or platform path is not allowed');
  if (Array.isArray(value)) value.forEach(noAbsolute);
  else if (value && typeof value === 'object') Object.values(value).forEach(noAbsolute);
}

export function validateRequest(channel: string, payload: unknown): unknown {
  if (!channelSet.has(channel)) throw new Error(`unknown IPC channel: ${channel}`);
  noAbsolute(payload);
  if (channel === 'job.validate' || channel === 'job.start') {
    const value = (payload as { spec?: unknown })?.spec;
    const parsed = JobSpecSchema.safeParse(value);
    if (!parsed.success) throw new Error('invalid JobSpec');
    return parsed.data;
  }
  return payload;
}

export type BridgeTransport = { invoke(channel: IpcChannel, payload?: unknown): Promise<unknown>; subscribe(listener: (event: unknown) => void): () => void };
export function createBridgeApi(transport: BridgeTransport): Record<string, unknown> & { onEvent(listener: (event: unknown) => void): () => void } {
  const api: Record<string, unknown> = {};
  for (const channel of IPC_CHANNELS) {
    api[channel] = channel === 'onEvent' ? (listener: (event: unknown) => void) => transport.subscribe(listener) : (payload?: unknown) => transport.invoke(channel, payload);
  }
  return api as Record<string, unknown> & { onEvent(listener: (event: unknown) => void): () => void };
}
