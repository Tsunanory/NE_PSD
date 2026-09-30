import { ModelCapabilityError } from '../profiles/invocation-policy.js';
import { validateTransportRequest, validateTransportResponse, type ModelTransport, type TransportRequest, type TransportResponse } from './model-transport.js';

const loopback = (endpoint: string) => { const url = new URL(endpoint); return (url.protocol === 'http:' || url.protocol === 'https:') && (url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '::1') && !url.username && !url.password; };
export type LocalHandshake = { modelId: string; artifactSha256: string; chatTemplateSha256: string; revision: string | null; runtimeVersion: string; jsonSchema: boolean; contextTokens: number; maxOutputTokens: number; capabilities: { vision: boolean; tools: boolean; imageInput: boolean }; supportsNonStreaming: boolean };
export type LocalRuntimeBridge = (request: TransportRequest) => Promise<TransportResponse>;
export class LocalRuntimeTransport implements ModelTransport {
  constructor(private readonly handshake: LocalHandshake | null = null, private readonly bridge: LocalRuntimeBridge | null = null) {}
  async invoke(request: TransportRequest): Promise<TransportResponse> {
    validateTransportRequest(request);
    if (request.profile.provenance?.kind !== 'local') throw new ModelCapabilityError('LOCAL_HANDSHAKE_UNQUALIFIED', 'local runtime provenance is unverified');
    try { if (!loopback(request.profile.endpoint)) throw new ModelCapabilityError('LOCAL_ENDPOINT_REQUIRED', 'local runtime endpoint must be loopback'); } catch { throw new ModelCapabilityError('LOCAL_ENDPOINT_REQUIRED', 'local runtime endpoint must be a valid loopback URL'); }
    if (!this.handshake || this.handshake.modelId !== request.profile.modelId || (request.profile.provenance.kind === 'local' && (this.handshake.runtimeVersion !== request.profile.provenance.runtimeVersion || this.handshake.artifactSha256 !== request.profile.provenance.artifactSha256 || this.handshake.chatTemplateSha256 !== request.profile.provenance.chatTemplateSha256)) || this.handshake.jsonSchema !== request.profile.capabilities.jsonSchema || this.handshake.contextTokens !== request.profile.contextTokens || this.handshake.maxOutputTokens !== request.profile.maxOutputTokens || this.handshake.capabilities.vision !== request.profile.capabilities.vision || this.handshake.capabilities.tools !== request.profile.capabilities.tools || this.handshake.capabilities.imageInput !== request.profile.capabilities.vision || !this.handshake.supportsNonStreaming) throw new ModelCapabilityError('LOCAL_HANDSHAKE_UNQUALIFIED', 'runtime identity, provenance, limits or capabilities are unverified');
    if (!this.bridge) throw new ModelCapabilityError('LOCAL_RUNTIME_UNAVAILABLE', 'installed local runtime bridge is not configured');
    return validateTransportResponse(request, await this.bridge(request));
  }
}
export const isLoopbackEndpoint = loopback;
