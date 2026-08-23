/**
 * Shared types for Phase 3 MCP tool handlers.
 *
 * ToolContext is what every tool receives after the bearer is resolved. It is
 * explicitly scoped to the one employee authenticated by that credential;
 * model-authored arguments never select identity.
 *
 * ToolResult matches the MCP streamable-http tool-result shape: a list of
 * content blocks. Phase 3 only emits text blocks. Tool-level errors are
 * signaled by `isError: true` with the error message inside content[0].text —
 * this is the MCP convention for errors that the LLM should see rather than
 * the HTTP layer catching.
 */

export type TrustLevel = 'conservative' | 'standard' | 'autonomous';

export type ToolContext = {
  org_id: string;
  employee_id: string;
  employee_slug: string;
  trust_level: TrustLevel;
};

export type ToolTextContent = { type: 'text'; text: string };

export type ToolResult = {
  content: ToolTextContent[];
  isError?: boolean;
};

/** Convenience wrapper: build a text-only tool result. */
export function textResult(payload: unknown, isError = false): ToolResult {
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
  return { content: [{ type: 'text', text }], isError };
}

/** Convenience wrapper: build an error tool result. */
export function errorResult(message: string): ToolResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}
