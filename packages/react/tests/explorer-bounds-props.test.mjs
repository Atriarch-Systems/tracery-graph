// New explorer props (additive): nodeDetail/nodeFooter overrides, showNodeList, nodeListCollapsible,
// the Fit button, and the --tracery-border / --tracery-canvas-bg / --tracery-panel-bg theme variables.
// Server-rendered like explorer-ssr.test.mjs; the canvas itself needs a browser, so the node text
// overrides are checked through the pure function the explorer applies.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { Journal, buildFlows, project } from '@atriarch-systems/tracery-core';
import { sampleTraceEvents, sampleFlowIds } from '@atriarch-systems/tracery-core/fixtures';
import { ActivityExplorer } from '../dist/ActivityExplorer.js';
import { useJournalSource } from '../dist/useJournalSource.js';
import { withNodeText } from '../dist/node-display.js';
import { rootStyle, styles } from '../dist/style.js';

const journal = new Journal();
journal.append(sampleTraceEvents);

function render(extraProps) {
  function Harness() {
    const source = useJournalSource(journal);
    return createElement(ActivityExplorer, { source, ariaLabel: 'Fixture trace', initialScope: { mode: 'flow', flow: sampleFlowIds.parent }, ...extraProps });
  }
  return renderToString(createElement(Harness));
}

const flows = buildFlows(journal.events());
const projected = project(flows, { mode: 'flow', flow: sampleFlowIds.parent }).nodes;

test('withNodeText returns the same nodes when no override is given', () => {
  assert.equal(withNodeText(projected, flows), projected);
});

test('withNodeText overrides detail and footer from the node record and its flow', () => {
  const seen = [];
  const nodes = withNodeText(
    projected,
    flows,
    (record, flow) => { seen.push([record.id, flow.id]); return `${record.kind} in ${flow.label}`; },
    (record) => `footer ${record.id}`,
  );
  assert.equal(nodes.length, projected.length);
  for (const node of nodes) {
    assert.equal(node.detail, `${node.data.node.kind} in ${flows.get(node.data.flow).label}`);
    assert.equal(node.footer, `footer ${node.data.node.id}`);
  }
  assert.ok(seen.length > 0 && seen.every(([, flowId]) => flows.has(flowId)));
  assert.notEqual(nodes[0], projected[0], 'overridden nodes are copies');
  assert.ok(projected[0].detail !== 'x' && projected[0].footer !== 'x', 'the projection itself is untouched');
});

test('withNodeText keeps the default where an override returns undefined', () => {
  const nodes = withNodeText(projected, flows, () => undefined, (record) => (record.id === projected[0].data.node.id ? 'only this' : undefined));
  assert.equal(nodes[0].footer, 'only this');
  assert.equal(nodes[0].detail, projected[0].detail);
  assert.equal(nodes[1], projected[1], 'a node with nothing overridden keeps its identity');
});

test('showNodeList={false} renders no node list; the default renders one', () => {
  assert.match(render({}), /data-testid="node-list"/);
  assert.doesNotMatch(render({ showNodeList: false }), /data-testid="node-list"/);
});

test('nodeListCollapsible adds a toggle, and nodeListInitiallyCollapsed starts without the rows', () => {
  const open = render({ nodeListCollapsible: true });
  assert.match(open, /data-testid="node-list-toggle"/);
  assert.match(open, /aria-expanded="true"/);
  assert.match(open, /data-testid="node-item"/);
  const closed = render({ nodeListCollapsible: true, nodeListInitiallyCollapsed: true });
  assert.match(closed, /data-testid="node-list-toggle"/);
  assert.match(closed, /aria-expanded="false"/);
  assert.doesNotMatch(closed, /data-testid="node-item"/);
  // not collapsible by default: no toggle
  assert.doesNotMatch(render({}), /node-list-toggle/);
});

test('a Fit button is part of the graph toolbar', () => {
  const markup = render({});
  assert.match(markup, /data-testid="graph-toolbar"/);
  assert.match(markup, /data-testid="fit-view"/);
});

test('theme.border/canvasBg/panelBg set the CSS variables; unset they are left to the host', () => {
  const themed = rootStyle({ border: '#112233', canvasBg: '#010203', panelBg: '#040506' });
  assert.equal(themed['--tracery-border'], '#112233');
  assert.equal(themed['--tracery-canvas-bg'], '#010203');
  assert.equal(themed['--tracery-panel-bg'], '#040506');
  const plain = rootStyle(undefined);
  for (const name of ['--tracery-border', '--tracery-canvas-bg', '--tracery-panel-bg']) assert.equal(name in plain, false, `${name} is not forced`);
  assert.match(render({ theme: { border: '#112233' } }), /--tracery-border:#112233/);
});

test('the inspector, node list and canvas read the theme variables and the node list has a visible top edge', () => {
  assert.match(styles.inspector.borderLeft, /var\(--tracery-border, #262a3a\)/);
  assert.match(styles.nodeList.borderTop, /1px solid var\(--tracery-border, #262a3a\)/);
  assert.match(styles.nodeList.background, /var\(--tracery-panel-bg/);
  assert.match(styles.graphCanvas.background, /var\(--tracery-canvas-bg/);
});
