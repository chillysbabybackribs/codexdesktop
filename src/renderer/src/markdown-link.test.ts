import assert from 'node:assert/strict'
import test from 'node:test'
import { classifyMarkdownHref } from './markdown-link.ts'

test('chat web links route to the embedded browser', () => {
  assert.equal(classifyMarkdownHref('https://example.com/docs'), 'browser')
  assert.equal(classifyMarkdownHref('HTTP://example.com'), 'browser')
})

test('chat links cannot navigate the Electron renderer', () => {
  assert.equal(classifyMarkdownHref('file:///tmp/private.txt'), 'blocked')
  assert.equal(classifyMarkdownHref('javascript:alert(1)'), 'blocked')
  assert.equal(classifyMarkdownHref('/relative-page'), 'blocked')
  assert.equal(classifyMarkdownHref('#details'), 'anchor')
})
