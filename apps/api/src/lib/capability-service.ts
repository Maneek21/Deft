import {
  mcpCapabilityProvider,
  type McpCapabilityDiscoveryRequest,
  type McpCapabilityDiscoveryResult,
} from './capability-providers/mcp.js';

export type CapabilityDiscoveryRequest = McpCapabilityDiscoveryRequest;
export type CapabilityDiscoveryResult = McpCapabilityDiscoveryResult;

interface McpCapabilityProviderPort {
  discover(request: McpCapabilityDiscoveryRequest): Promise<McpCapabilityDiscoveryResult>;
}

/**
 * Provider-neutral internal seam for discovery now and invocation in the next
 * cutover loops. The provider union is intentionally closed.
 */
export class CapabilityService {
  constructor(
    private readonly mcpProvider: McpCapabilityProviderPort = mcpCapabilityProvider,
  ) {}

  async discover(request: CapabilityDiscoveryRequest): Promise<CapabilityDiscoveryResult> {
    switch (request.provider_kind) {
      case 'mcp':
        return this.mcpProvider.discover(request);
    }

    throw new Error('Unsupported capability provider kind');
  }
}

export const capabilityService = new CapabilityService();
