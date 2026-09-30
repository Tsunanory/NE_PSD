import { ModelCapabilityError } from '../profiles/invocation-policy.js';
import { validateTransportRequest, validateTransportResponse, type ModelTransport, type TransportRequest, type TransportResponse } from './model-transport.js';
export type CodexRuntimeBridge = (request: TransportRequest) => Promise<TransportResponse>;
export class CodexTransport implements ModelTransport {
  constructor(private readonly bridge: CodexRuntimeBridge | null = null) {}
  async invoke(request: TransportRequest): Promise<TransportResponse> {
    validateTransportRequest(request);
    if (request.profile.provider !== 'codex' || request.profile.provenance.kind !== 'remote' || request.profile.provenance.provider !== 'codex') throw new ModelCapabilityError('CODEX_PROFILE_REQUIRED', 'Codex bridge requires Codex provenance');
    if (!this.bridge) throw new ModelCapabilityError('CODEX_BRIDGE_UNAVAILABLE', 'documented installed Codex bridge is unavailable; no endpoint is invented');
    return validateTransportResponse(request, await this.bridge(request));
  }
}
