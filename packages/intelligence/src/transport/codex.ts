import { ModelCapabilityError } from '../profiles/invocation-policy.js';
import { validateTransportRequest, type ModelTransport, type TransportRequest, type TransportResponse } from './model-transport.js';
export class CodexTransport implements ModelTransport {
  async invoke(request: TransportRequest): Promise<TransportResponse> { validateTransportRequest(request); throw new ModelCapabilityError('CODEX_BRIDGE_UNAVAILABLE', 'documented installed Codex bridge is unavailable; no endpoint is invented'); }
}
