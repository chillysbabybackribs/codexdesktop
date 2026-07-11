import assert from 'node:assert/strict'
import test from 'node:test'
import { describeNavigationInput, normalizeNavigationInput } from './url-utils.ts'

test('describeNavigationInput navigates web-safe input', () => {
  assert.deepEqual(describeNavigationInput('https://example.com/a'), { kind: 'navigate', url: 'https://example.com/a' })
  assert.deepEqual(describeNavigationInput('http://example.com'), { kind: 'navigate', url: 'http://example.com' })
  assert.deepEqual(describeNavigationInput('about:blank'), { kind: 'navigate', url: 'about:blank' })
  assert.deepEqual(describeNavigationInput('example.com/path'), { kind: 'navigate', url: 'https://example.com/path' })
  assert.deepEqual(describeNavigationInput('localhost:3000/app'), { kind: 'navigate', url: 'https://localhost:3000/app' })
  assert.deepEqual(describeNavigationInput('127.0.0.1:8080'), { kind: 'navigate', url: 'https://127.0.0.1:8080' })
})

test('describeNavigationInput searches dangerous or unknown schemes', () => {
  assert.equal(describeNavigationInput('javascript:alert(1)').kind, 'search')
  assert.equal(describeNavigationInput('file:///etc/passwd').kind, 'search')
  assert.equal(describeNavigationInput('data:text/html,<b>x</b>').kind, 'search')
  assert.equal(describeNavigationInput('chrome://settings').kind, 'search')
  assert.equal(describeNavigationInput('view-source:https://a.com').kind, 'search')
})

test('describeNavigationInput searches plain queries', () => {
  const result = describeNavigationInput('how to cook rice')
  assert.equal(result.kind, 'search')
  assert.equal(result.url, 'https://www.google.com/search?q=how%20to%20cook%20rice')
})

test('normalizeNavigationInput keeps programmatic schemes and fixes host:port', () => {
  assert.equal(normalizeNavigationInput('data:text/html,x'), 'data:text/html,x')
  assert.equal(normalizeNavigationInput('localhost:3000'), 'https://localhost:3000')
  assert.equal(normalizeNavigationInput('example.com'), 'https://example.com')
  assert.equal(normalizeNavigationInput(''), 'about:blank')
  assert.equal(normalizeNavigationInput('hello world'), 'https://www.google.com/search?q=hello%20world')
})
