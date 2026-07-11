import assert from 'node:assert/strict'
import test from 'node:test'
import { buildDomSnapshotModel } from './dom-snapshot.ts'

test('DOM snapshot model returns bounded interactive and semantic nodes', () => {
  const strings = [
    '#document', 'HTML', 'BODY', 'A', '#text', 'BUTTON', 'INPUT', 'H1',
    'href', '/docs', 'aria-label', 'Documentation', 'type', 'checkbox',
    'checked', '', 'Read the docs', 'Save', 'Enabled', 'Welcome'
  ]
  const model = buildDomSnapshotModel({
    strings,
    documents: [{
      documentURL: 9,
      nodes: {
        nodeName: [0, 1, 2, 3, 4, 5, 4, 6, 4, 7, 4],
        nodeType: [9, 1, 1, 1, 3, 1, 3, 1, 3, 1, 3],
        nodeValue: [-1, -1, -1, -1, 16, -1, 17, -1, 18, -1, 19],
        parentIndex: [-1, 0, 1, 2, 3, 2, 5, 2, 7, 2, 9],
        backendNodeId: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
        attributes: [[], [], [], [8, 9, 10, 11], [], [], [], [12, 13, 14, 15], [], [], []]
      },
      layout: {
        nodeIndex: [3, 5, 7, 9],
        bounds: [[10, 20, 100, 30], [10, 60, 90, 30], [10, 100, 20, 20], [10, 140, 200, 40]]
      }
    }]
  })

  assert.equal(model.documentCount, 1)
  assert.equal(model.totalNodeCount, 11)
  assert.deepEqual(model.nodes.map((node) => ({ tag: node.tag, role: node.role, name: node.name, visible: node.visible })), [
    { tag: 'a', role: 'link', name: 'Documentation', visible: true },
    { tag: 'button', role: 'button', name: 'Save', visible: true },
    { tag: 'input', role: 'checkbox', name: 'Enabled', visible: true },
    { tag: 'h1', role: 'heading', name: 'Welcome', visible: true }
  ])
  assert.equal(model.nodes[2]?.checked, true)
  assert.equal(model.nodes[0]?.href, '/docs')
})

test('DOM snapshot model caps returned nodes without changing total count', () => {
  const strings = ['A', 'href', '/target']
  const model = buildDomSnapshotModel({
    strings,
    documents: [{
      nodes: {
        nodeName: Array.from({ length: 10 }, () => 0),
        nodeType: Array.from({ length: 10 }, () => 1),
        nodeValue: Array.from({ length: 10 }, () => -1),
        parentIndex: Array.from({ length: 10 }, () => -1),
        backendNodeId: Array.from({ length: 10 }, (_, index) => index + 1),
        attributes: Array.from({ length: 10 }, () => [1, 2])
      },
      layout: { nodeIndex: [], bounds: [] }
    }]
  }, 3)

  assert.equal(model.totalNodeCount, 10)
  assert.equal(model.nodeCount, 3)
  assert.equal(model.omittedNodeCount, 7)
})

test('DOM snapshot model prioritizes main-content interactions over navigation descendants', () => {
  const strings = ['NAV', 'MAIN', 'A', 'href', '/nav', '/main']
  const model = buildDomSnapshotModel({
    strings,
    documents: [{
      nodes: {
        nodeName: [0, 2, 1, 2],
        nodeType: [1, 1, 1, 1],
        nodeValue: [-1, -1, -1, -1],
        parentIndex: [-1, 0, -1, 2],
        backendNodeId: [1, 2, 3, 4],
        attributes: [[], [3, 4], [], [3, 5]]
      },
      layout: { nodeIndex: [], bounds: [] }
    }]
  }, 1)

  assert.equal(model.nodes[0]?.href, '/main')
})
