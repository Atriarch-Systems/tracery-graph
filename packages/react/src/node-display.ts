/**
 * The host's `nodeDetail` / `nodeFooter` overrides (see `ActivityExplorerProps`), applied to the
 * placed nodes just before they reach the graph. Pure, so the explorer can memoise it and tests can
 * check it without a canvas.
 */
import type { ActivityNode, Flow, NodeData, NodeRecord } from '@atriarch-systems/tracery-core';

export type NodeText = (node: NodeRecord, flow: Flow) => string | undefined;

/**
 * Returns `nodes` itself when neither override is given. Otherwise each node whose override returns a
 * string gets that string as its `detail` / `footer`; a node whose override returns `undefined` (or whose
 * flow is unknown) keeps the projection's default, and an untouched node keeps its identity.
 */
export function withNodeText(
  nodes: readonly ActivityNode<NodeData>[],
  flows: ReadonlyMap<string, Flow>,
  nodeDetail?: NodeText,
  nodeFooter?: NodeText,
): readonly ActivityNode<NodeData>[] {
  if (!nodeDetail && !nodeFooter) return nodes;
  return nodes.map((node) => {
    const record = node.data?.node;
    const flow = node.data ? flows.get(node.data.flow) : undefined;
    if (!record || !flow) return node;
    const detail = nodeDetail?.(record, flow);
    const footer = nodeFooter?.(record, flow);
    if (detail === undefined && footer === undefined) return node;
    return { ...node, detail: detail ?? node.detail, footer: footer ?? node.footer };
  });
}
