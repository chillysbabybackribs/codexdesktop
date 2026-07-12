import assert from 'node:assert/strict'
import test from 'node:test'
import {
  isBlankPopupUrl,
  isExternalHttpUrl,
  isUnsafePopupUrl,
  resolveWindowOpenAction
} from './window-open-policy.ts'

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

test('isUnsafePopupUrl blocks javascript and file URLs', () => {
  assert.equal(isUnsafePopupUrl('javascript:alert(1)'), true)
  assert.equal(isUnsafePopupUrl('file:///etc/passwd'), true)
  assert.equal(isUnsafePopupUrl('https://accounts.google.com'), false)
})

test('ordinary new-page requests navigate the current embedded page', () => {
  assert.equal(
    resolveWindowOpenAction({
      url: 'https://example.com/article',
      disposition: 'foreground-tab',
      frameName: '_blank',
      features: ''
    }),
    'current-page'
  )
  assert.equal(
    resolveWindowOpenAction({
      url: 'https://example.com/article',
      disposition: 'new-window',
      frameName: '_blank',
      features: ''
    }),
    'current-page'
  )
})

test('scripted OAuth-style popups retain a real child window', () => {
  assert.equal(
    resolveWindowOpenAction({
      url: 'https://accounts.google.com/o/oauth2/auth',
      disposition: 'new-window',
      frameName: 'google-oauth',
      features: 'width=500,height=650'
    }),
    'popup'
  )
  assert.equal(resolveWindowOpenAction({ url: 'about:blank', disposition: 'new-window' }), 'popup')
})

test('window-open policy denies unsafe and unsupported protocols', () => {
  assert.equal(resolveWindowOpenAction({ url: 'javascript:alert(1)' }), 'deny')
  assert.equal(resolveWindowOpenAction({ url: 'file:///etc/passwd' }), 'deny')
  assert.equal(resolveWindowOpenAction({ url: 'data:text/html,hello' }), 'deny')
})
