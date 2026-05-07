// docs/superpowers/audits/agent-byoa/lib/llm-loop.ts
import Anthropic from '@anthropic-ai/sdk';
import type { McpClient } from './mcp-client.js';

export interface LlmLoopResult {
  finalText: string;
  toolCalls: Array<{ name: string; input: any; result: any }>;
  steps: number;
}

export async function runLlmLoop(opts: {
  apiKey: string;
  model: string;
  systemPrompt: string;
  userPrompt: string;
  mcp: McpClient;
  callerSlug: string;
  maxSteps?: number;
}): Promise<LlmLoopResult> {
  const anthropic = new Anthropic({ apiKey: opts.apiKey });

  // Pull the live tool schemas from MCP and convert them to Anthropic tool-use format
  const list = await opts.mcp.toolsList();
  const tools = list.tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema as any,
  }));

  const messages: Anthropic.MessageParam[] = [
    { role: 'user', content: opts.userPrompt },
  ];
  const toolCalls: LlmLoopResult['toolCalls'] = [];
  const maxSteps = opts.maxSteps ?? 8;
  let finalText = '';

  for (let step = 0; step < maxSteps; step++) {
    const resp = await anthropic.messages.create({
      model: opts.model,
      max_tokens: 4096,
      system: opts.systemPrompt,
      tools: tools as any,
      messages,
    });

    const assistantBlocks = resp.content;
    messages.push({ role: 'assistant', content: assistantBlocks });

    if (resp.stop_reason === 'end_turn' || resp.stop_reason === 'stop_sequence') {
      finalText = assistantBlocks
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map((b) => b.text).join('\n');
      return { finalText, toolCalls, steps: step + 1 };
    }

    // Tool-use turn — execute every tool_use block
    if (resp.stop_reason === 'tool_use') {
      const toolUseBlocks = assistantBlocks.filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');
      const toolResults: Anthropic.ToolResultBlockParam[] = [];
      for (const tu of toolUseBlocks) {
        const args = { ...(tu.input as Record<string, unknown>), caller_employee_slug: (tu.input as any)?.caller_employee_slug ?? opts.callerSlug };
        let result: unknown;
        try {
          result = await opts.mcp.toolsCall(tu.name, args);
        } catch (e) {
          result = { error: e instanceof Error ? e.message : String(e) };
        }
        toolCalls.push({ name: tu.name, input: tu.input, result });
        toolResults.push({
          type: 'tool_result',
          tool_use_id: tu.id,
          content: JSON.stringify(result),
        });
      }
      messages.push({ role: 'user', content: toolResults });
      continue;
    }

    // Unexpected stop reason
    finalText = assistantBlocks
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text).join('\n');
    break;
  }
  return { finalText, toolCalls, steps: maxSteps };
}
