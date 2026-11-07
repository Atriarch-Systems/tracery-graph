/**
 * Projects Flows onto the visualizer contract (SPEC.md §2 "projection to the
 * visualizer contract" and "Projection rules"). Pure; never mutates a Flow.
 */
import type { ActivityActor } from './contract.js';
import { ancestors, assembleTrace } from './trace.js';
import type { EdgeRecord, Flow, NodeRecord, OpRecord } from './flows.js';
import { defaultCatalog } from './catalog.js';
import type { ActivityEdge, ActivityNode, NodePresentation } from './visualizer-ext.js';

export type Scope =
  | { readonly mode: 'flow'; readonly flow: string }
  | { readonly mode: 'ancestors'; readonly flow: string }
  | { readonly mode: 'trace'; readonly trace: string };

export interface ProjectOptions {
  readonly catalog?: (node: NodeRecord, flow: Flow) => NodePresentation;
  readonly now?: number;
  readonly history?: { readonly keepCompletedMs?: number };
}

export interface NodeData {
  readonly flow: string;
  readonly node: NodeRecord;
  readonly ops: OpRecord[];
}

export interface EdgeData {
  readonly flow: string;
  readonly edge: EdgeRecord;
}

export interface FlowGroup {
  readonly id: string;
  readonly label: string;
  readonly flow: string;
  readonly nodeIds: string[];
  readonly actor?: ActivityActor;
  readonly status: Flow['status'];
}

export interface Projection {
  readonly nodes: ActivityNode<NodeData>[];
  readonly edges: ActivityEdge<EdgeData>[];
  readonly groups: FlowGroup[];
}

interface SpawnInfo {
  readonly sourceId: string;
  readonly targetId: string;
  readonly parentNodeId: string;
  readonly childRootNodeId: string;
  readonly parentFlowId: string;
  readonly childOpId?: string;
}

function namespacedId(flow: Flow, nodeId: string, namespaced: boolean): string {
  return namespaced ? `${flow.actor?.id ?? flow.id}::${nodeId}` : nodeId;
}

function rootOpNodeId(flow: Flow): string | undefined {
  for (const op of flow.ops.values()) if (op.root) return op.node;
  return undefined;
}

function rootOpId(flow: Flow): string | undefined {
  for (const op of flow.ops.values()) if (op.root) return op.id;
  return undefined;
}

/**
 * Resolves scope to the set of flows to render, whether node ids should be
 * namespaced by actor, and which flows count as "in scope" (highlighted) vs.
 * present only for context (dimmed via activity.highlighted = false).
 */
function resolveScope(flows: ReadonlyMap<string, Flow>, scope: Scope): { scopeFlows: Flow[]; namespaced: boolean; highlighted: Set<string> } {
  if (scope.mode === 'flow') {
    const flow = flows.get(scope.flow);
    const scopeFlows = flow ? [flow] : [];
    return { scopeFlows, namespaced: false, highlighted: new Set(scopeFlows.map((f) => f.id)) };
  }
  if (scope.mode === 'ancestors') {
    const flow = flows.get(scope.flow);
    if (!flow) return { scopeFlows: [], namespaced: true, highlighted: new Set() };
    const chain = ancestors(flows, scope.flow);
    const ancestorFlows = chain.map((id) => flows.get(id)).filter((f): f is Flow => f !== undefined);
    return { scopeFlows: [...ancestorFlows, flow], namespaced: true, highlighted: new Set([flow.id]) };
  }
  const trace = assembleTrace(flows, scope.trace);
  return { scopeFlows: [...trace.flows], namespaced: true, highlighted: new Set(trace.flows.map((f) => f.id)) };
}

/**
 * Accumulator for one namespaced node id while merging across the flows that
 * contribute to it (SPEC.md §2: "one agent's repeated flows in a trace merge
 * onto shared nodes"). Non-namespaced scopes never have more than one
 * contributor per id, so this degenerates to a plain per-node record there.
 */
interface NodeAgg {
  readonly id: string;
  ops: OpRecord[];
  running: number;
  errorCount: number;
  label: string;
  detail: string | undefined;
  firstFlowId: string;
  canonicalNode: NodeRecord;
  canonicalFlow: Flow;
  lastSeenAt: number;
  completedAt: number | undefined;
  highlighted: boolean;
  layoutParentId: string | undefined;
}

/**
 * Accumulator for one namespaced (source, target, relation, kind) edge tuple,
 * merged the same way as nodes so two flows of the same actor never emit two
 * edges (or a self-loop) between what is now one node.
 */
interface EdgeAgg {
  readonly id: string;
  readonly source: string;
  readonly target: string;
  readonly relation: string;
  readonly kind: 'call' | 'data';
  readonly flowId: string;
  record: EdgeRecord;
  highlighted: boolean;
}

/** Projects `flows` in `scope` onto nodes/edges/groups the visualizer can draw. */
export function project(flows: ReadonlyMap<string, Flow>, scope: Scope, options?: ProjectOptions): Projection {
  const now = options?.now ?? Date.now();
  const catalogFor = options?.catalog ?? ((node: NodeRecord) => defaultCatalog(node.kind));
  const keepCompletedMs = options?.history?.keepCompletedMs;

  const { scopeFlows, namespaced, highlighted } = resolveScope(flows, scope);
  const scopeFlowIds = new Set(scopeFlows.map((f) => f.id));

  // Pass 1: for namespaced scopes, resolve spawn links whose parent flow is also in scope.
  const spawns = new Map<string, SpawnInfo>();
  if (namespaced) {
    for (const flow of scopeFlows) {
      if (!flow.link) continue;
      const parent = flows.get(flow.link.parentFlow);
      if (!parent || !scopeFlowIds.has(parent.id)) continue;
      const childRootNodeId = rootOpNodeId(flow);
      if (childRootNodeId === undefined) continue;
      const parentNodeId = flow.link.parentNode ?? rootOpNodeId(parent);
      if (parentNodeId === undefined) continue;
      spawns.set(flow.id, {
        sourceId: namespacedId(parent, parentNodeId, true),
        targetId: namespacedId(flow, childRootNodeId, true),
        parentNodeId,
        childRootNodeId,
        parentFlowId: parent.id,
        childOpId: rootOpId(flow),
      });
    }
  }

  // Pass 2: nodes, keyed by namespaced id so two flows of the same actor collapse
  // onto one node instead of colliding ids with divergent (and last-write-wins,
  // effectively random) data.
  const nodeAggs = new Map<string, NodeAgg>();
  const groupNodeIds = new Map<string, string[]>();
  for (const flow of scopeFlows) groupNodeIds.set(flow.id, []);

  for (const flow of scopeFlows) {
    const isHighlighted = highlighted.has(flow.id);
    const spawn = spawns.get(flow.id);

    for (const node of flow.nodes.values()) {
      if (keepCompletedMs !== undefined && node.status !== 'running' && now - node.lastSeenAt > keepCompletedMs) continue;

      const id = namespacedId(flow, node.id, namespaced);
      const ops = node.ops.map((opId) => flow.ops.get(opId)).filter((op): op is OpRecord => op !== undefined);
      const isSpawnTarget = spawn !== undefined && node.id === spawn.childRootNodeId;

      const groupList = groupNodeIds.get(flow.id)!;
      if (!groupList.includes(id)) groupList.push(id);

      const existing = nodeAggs.get(id);
      if (!existing) {
        nodeAggs.set(id, {
          id,
          ops: [...ops],
          running: node.running,
          errorCount: node.errorCount,
          label: node.label,
          detail: node.lastOpName,
          firstFlowId: flow.id,
          canonicalNode: node,
          canonicalFlow: flow,
          lastSeenAt: node.lastSeenAt,
          completedAt: flow.endedAt,
          highlighted: isHighlighted,
          layoutParentId: isSpawnTarget ? spawn!.sourceId : undefined,
        });
        continue;
      }

      existing.ops.push(...ops);
      existing.running += node.running;
      existing.errorCount += node.errorCount;
      existing.highlighted = existing.highlighted || isHighlighted;
      if (existing.layoutParentId === undefined && isSpawnTarget) existing.layoutParentId = spawn!.sourceId;
      if (node.lastSeenAt >= existing.lastSeenAt) {
        // The most recently active contributing flow wins for presentation
        // fields, mirroring the within-flow "last observed value wins" rule.
        existing.label = node.label;
        existing.detail = node.lastOpName;
        existing.canonicalNode = node;
        existing.canonicalFlow = flow;
        existing.lastSeenAt = node.lastSeenAt;
        existing.completedAt = flow.endedAt;
      }
    }
  }

  const nodes: ActivityNode<NodeData>[] = [];
  for (const agg of nodeAggs.values()) {
    const status: NodeRecord['status'] = agg.errorCount > 0 ? 'error' : agg.running > 0 ? 'running' : 'idle';
    nodes.push({
      id: agg.id,
      label: agg.label,
      detail: agg.detail,
      footer: agg.errorCount > 0 ? `${agg.errorCount} errors` : `${agg.ops.length} ops`,
      status,
      active: agg.running > 0,
      ...(agg.layoutParentId !== undefined ? { layout: { parentId: agg.layoutParentId } } : {}),
      presentation: catalogFor(agg.canonicalNode, agg.canonicalFlow),
      activity: { highlighted: agg.highlighted, completedAt: agg.completedAt, updatedAt: agg.lastSeenAt },
      ...(namespaced ? { group: agg.firstFlowId } : {}),
      data: { flow: agg.firstFlowId, node: agg.canonicalNode, ops: agg.ops },
    });
  }

  const groups: FlowGroup[] = scopeFlows.map((flow) => ({
    id: flow.id, label: flow.label, flow: flow.id, nodeIds: groupNodeIds.get(flow.id)!, actor: flow.actor, status: flow.status,
  }));

  // Pass 3: call/data edges, merged by namespaced (source, target, relation, kind)
  // tuple for the same reason as nodes; an edge that collapses onto a single
  // namespaced node (both ends merged together) is suppressed like a self-edge.
  const edgeAggs = new Map<string, EdgeAgg>();

  for (const flow of scopeFlows) {
    const isHighlighted = highlighted.has(flow.id);
    for (const edge of flow.edges) {
      if (edge.source === edge.target) continue; // self-edges suppressed; the op stays in node history
      const sourceId = namespacedId(flow, edge.source, namespaced);
      const targetId = namespacedId(flow, edge.target, namespaced);
      if (sourceId === targetId) continue; // collapsed onto one namespaced node: suppressed like a self-edge

      const key = `${edge.kind}|${sourceId}|${targetId}|${edge.relation}`;
      const existing = edgeAggs.get(key);
      if (!existing) {
        edgeAggs.set(key, {
          id: `${flow.id}:${edge.kind}:${edge.source}->${edge.target}:${edge.relation}`,
          source: sourceId, target: targetId, relation: edge.relation, kind: edge.kind, flowId: flow.id,
          record: { ...edge, ops: [...edge.ops] },
          highlighted: isHighlighted,
        });
        continue;
      }

      const opSet = new Set(existing.record.ops);
      const ops = [...existing.record.ops];
      for (const opId of edge.ops) {
        if (!opSet.has(opId)) {
          opSet.add(opId);
          ops.push(opId);
        }
      }
      existing.record = { ...existing.record, count: existing.record.count + edge.count, ops, lastAt: Math.max(existing.record.lastAt, edge.lastAt) };
      existing.highlighted = existing.highlighted || isHighlighted;
    }
  }

  const edges: ActivityEdge<EdgeData>[] = [];
  for (const agg of edgeAggs.values()) {
    edges.push({
      id: agg.id,
      source: agg.source,
      target: agg.target,
      label: agg.relation,
      count: agg.record.count,
      // A single call reads from the arrow alone; the label shows once it repeats or an end is selected.
      showLabel: false,
      activity: { highlighted: agg.highlighted, updatedAt: agg.record.lastAt },
      kind: agg.kind,
      data: { flow: agg.flowId, edge: agg.record },
    });
  }

  for (const [childFlowId, spawn] of spawns) {
    if (spawn.sourceId === spawn.targetId) continue; // collapsed onto one namespaced node: no self-loop spawn edge
    const child = flows.get(childFlowId)!;
    edges.push({
      id: `spawn:${spawn.parentFlowId}->${childFlowId}`,
      source: spawn.sourceId,
      target: spawn.targetId,
      label: 'spawn',
      count: 1,
      showLabel: true,
      activity: { highlighted: highlighted.has(childFlowId), updatedAt: child.startedAt },
      kind: 'spawn',
      data: {
        flow: childFlowId,
        // Synthesized: spawn links are cross-flow and have no EdgeRecord of their
        // own (EdgeRecord.kind has no 'spawn' variant; that is an
        // ActivityEdge-only distinction added by the visualizer, SPEC.md §3).
        edge: {
          source: spawn.parentNodeId, target: spawn.childRootNodeId, relation: 'spawn',
          count: 1, ops: spawn.childOpId ? [spawn.childOpId] : [], lastAt: child.startedAt ?? now, kind: 'call',
        },
      },
    });
  }

  return { nodes, edges, groups };
}
