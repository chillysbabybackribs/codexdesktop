import assert from 'node:assert/strict'
import test from 'node:test'
import { isBlankPopupUrl, isExternalHttpUrl } from './window-open-policy.ts'

test('isBlankPopupUrl treats empty and about:blank as blank popups', () => {
  assert.equal(isBlankPopupUrl(undefined), true)
  assert.equal(isBlankPopupUrl(''), true)
  assert.equal(isBlankPopupUrl('   '), true)
  assert.equal(isBlankPopupUrl('about:blank'), true)
  assert.equal(isBlankPopupUrl('https://accounts.google.com/o/oauth2/v2/auth'), false)
})

test('isExternalHttpUrl matches http and https URLs only', () => {
  assert.equal(isExternalHttpUrl('https://accounts.google.com/signin'), true)
  assert.equal(isExternalHttpUrl('http://localhost:3000/callback'), true)
  assert.equal(isExternalHttpUrl('about:blank'), false)
  assert.equal(isExternalHttpUrl(''), false)
  assert.equal(isExternalHttpUrl('javascript:alert(1)'), false)
})
