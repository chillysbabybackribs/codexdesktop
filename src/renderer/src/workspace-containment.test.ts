import assert from 'node:assert/strict'
import test from 'node:test'
import { outOfWorkspacePaths } from './workspace-containment.ts'

const WS = '/home/dp/projects/app'

test('write commands targeting home paths outside the workspace are flagged', () => {
  const flagged = outOfWorkspacePaths({
    commands: ['mkdir -p ~/og-check && cd ~/og-check', 'git init /home/dp/other'],
    filePaths: [],
    workspace: WS,
  })
  assert.deepEqual(flagged, ['/home/dp/og-check', '/home/dp/other'])
})

test('reads and in-workspace or system paths never flag', () => {
  assert.deepEqual(
    outOfWorkspacePaths({
      commands: [
        'ls /home/dp/notes', // no write hint
        `mkdir -p ${WS}/src/new`, // inside workspace
        'cp /usr/share/dict/words ./words', // ignored system prefix
        'tee /tmp/scratch.log', // tmp ignored
        'node cli.js --check', // no absolute path
      ],
      filePaths: ['src/relative.ts'],
      workspace: WS,
    }),
    []
  )
})

test('~ and $HOME paths are outside by construction for a non-home workspace', () => {
  const flagged = outOfWorkspacePaths({
    commands: ['mkdir -p ~/og-check', 'tee $HOME/notes.md'],
    filePaths: [],
    workspace: '/tmp/scratch/verify-ws8',
  })
  assert.deepEqual(flagged, ['~/og-check', '$HOME/notes.md'])
})

test('editor writes to absolute outside paths flag without a write verb', () => {
  const flagged = outOfWorkspacePaths({
    commands: [],
    filePaths: ['/home/dp/elsewhere/file.ts', 'inside/relative.ts'],
    workspace: WS,
  })
  assert.deepEqual(flagged, ['/home/dp/elsewhere/file.ts'])
})

test('null workspace disables the check and results are capped at five', () => {
  assert.deepEqual(
    outOfWorkspacePaths({ commands: ['mkdir ~/x'], filePaths: [], workspace: null }),
    []
  )
  const many = outOfWorkspacePaths({
    commands: Array.from({ length: 8 }, (_, i) => `mkdir /home/dp/out-${i}`),
    filePaths: [],
    workspace: WS,
  })
  assert.equal(many.length, 5)
})

test('redirect writes count as write hints', () => {
  const flagged = outOfWorkspacePaths({
    commands: ['echo hi > /home/dp/loose-note.txt'],
    filePaths: [],
    workspace: WS,
  })
  assert.deepEqual(flagged, ['/home/dp/loose-note.txt'])
})
