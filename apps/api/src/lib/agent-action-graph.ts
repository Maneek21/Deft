import { createHash } from 'node:crypto';

export type ProposalIntent = 'read' | 'single_write' | 'compound_write' | 'plan' | 'clarify';

export type ActionGraphNode<T = Record<string, any>> = {
  id: string;
  tool: string;
  params: T;
  depends_on: string[];
  idempotency_key: string;
};

export type ActionGraph = {
  intent: ProposalIntent;
  summary: string;
  actions: ActionGraphNode[];
  clarification?: string;
};

const MAX_ACTION_GRAPH_NODES = 12;

export function buildActionGraph(
  actions: Array<{ action: string; params: Record<string, any> }>,
  sourceMessageId: string,
  summary = '',
): ActionGraph {
  const nodes = actions.map((action, index) => {
    const id = `step_${index + 1}`;
    return {
      id,
      tool: action.action,
      params: action.params,
      depends_on: normalizeDependencies(action.params.depends_on),
      idempotency_key: stableActionKey(sourceMessageId, id, action.action, action.params),
    };
  });
  const graph: ActionGraph = {
    intent: nodes.length > 1 ? 'compound_write' : nodes.length === 1 ? 'single_write' : 'read',
    summary,
    actions: nodes,
  };
  validateActionGraph(graph);
  return graph;
}

export function validateActionGraph(graph: ActionGraph) {
  if (graph.actions.length > MAX_ACTION_GRAPH_NODES) {
    throw new Error(`Action graph exceeds the ${MAX_ACTION_GRAPH_NODES}-step safety limit`);
  }
  const ids = new Set<string>();
  for (const node of graph.actions) {
    if (!node.id || ids.has(node.id)) throw new Error(`Duplicate or empty action node id: ${node.id}`);
    ids.add(node.id);
  }
  for (const node of graph.actions) {
    for (const dependency of node.depends_on) {
      if (!ids.has(dependency)) throw new Error(`Action ${node.id} depends on unknown node ${dependency}`);
      if (dependency === node.id) throw new Error(`Action ${node.id} cannot depend on itself`);
    }
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const byId = new Map(graph.actions.map((node) => [node.id, node]));
  const visit = (id: string) => {
    if (visiting.has(id)) throw new Error(`Action graph contains a dependency cycle at ${id}`);
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of byId.get(id)?.depends_on ?? []) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  };
  for (const node of graph.actions) visit(node.id);
}

function normalizeDependencies(value: unknown) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0))];
}

function stableActionKey(sourceMessageId: string, nodeId: string, tool: string, params: Record<string, any>) {
  const canonical = JSON.stringify(sortValue({ sourceMessageId, nodeId, tool, params }));
  return `defty_${createHash('sha256').update(canonical).digest('hex').slice(0, 32)}`;
}

function sortValue(value: any): any {
  if (Array.isArray(value)) return value.map(sortValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortValue(value[key])]));
}
