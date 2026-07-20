import assert from 'node:assert/strict'
import test from 'node:test'
import {
  chromiumMajorVersion,
  googleAuthClientHints,
  isGoogleAuthHost,
  isGoogleAuthUrl,
  rewriteRequestClientHints
} from './browser-auth-client-hints.ts'

const chromeUA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36'

test('isGoogleAuthHost matches the sign-in hosts and their subdomains', () => {
  assert.equal(isGoogleAuthHost('accounts.google.com'), true)
  assert.equal(isGoogleAuthHost('ACCOUNTS.GOOGLE.COM'), true)
  assert.equal(isGoogleAuthHost('accounts.google.com.'), true)
  assert.equal(isGoogleAuthHost('content.accounts.google.com'), true)
  assert.equal(isGoogleAuthHost('accounts.youtube.com'), true)
  assert.equal(isGoogleAuthHost('accounts.gstatic.com'), true)
})

test('isGoogleAuthHost rejects ordinary and look-alike hosts', () => {
  assert.equal(isGoogleAuthHost('www.google.com'), false)
  assert.equal(isGoogleAuthHost('mail.google.com'), false)
  assert.equal(isGoogleAuthHost('example.com'), false)
  // Suffix match must be on a dot boundary, not a substring.
  assert.equal(isGoogleAuthHost('evilaccounts.google.com.attacker.test'), false)
  assert.equal(isGoogleAuthHost('notaccounts.google.com'.replace('notaccounts', 'not-accounts')), false)
})

test('isGoogleAuthUrl parses the host and ignores malformed URLs', () => {
  assert.equal(isGoogleAuthUrl('https://accounts.google.com/o/oauth2/v2/auth?client_id=x'), true)
  assert.equal(isGoogleAuthUrl('https://www.google.com/search?q=x'), false)
  assert.equal(isGoogleAuthUrl('not a url'), false)
})

test('chromiumMajorVersion parses Chrome token, rejects UA without one', () => {
  assert.equal(chromiumMajorVersion(chromeUA), 138)
  assert.equal(chromiumMajorVersion('Mozilla/5.0 (X11; Linux x86_64) Safari/537.36'), null)
})

test('googleAuthClientHints advertises Google Chrome + Chromium, never Electron', () => {
  const hints = googleAuthClientHints(138, '138.0.0.0')
  assert.equal(hints['sec-ch-ua'], '"Google Chrome";v="138", "Chromium";v="138", "Not/A)Brand";v="24"')
  assert.ok(!hints['sec-ch-ua'].includes('Electron'))
  assert.ok(hints['sec-ch-ua-full-version-list']!.includes('"Google Chrome";v="138.0.0.0"'))
})

test('googleAuthClientHints omits full-version-list when version is malformed', () => {
  assert.equal(googleAuthClientHints(138, 'not-a-version')['sec-ch-ua-full-version-list'], undefined)
  assert.equal(googleAuthClientHints(138)['sec-ch-ua-full-version-list'], undefined)
})

test('rewriteRequestClientHints replaces existing hints, preserving header casing', () => {
  const headers: Record<string, string | string[]> = {
    'Sec-CH-UA': '"Chromium";v="138", "Electron";v="43", "Not/A)Brand";v="99"',
    'Sec-CH-UA-Full-Version-List': '"Chromium";v="138.0.0.0", "Electron";v="43.1.0"',
    'User-Agent': chromeUA
  }
  const hints = googleAuthClientHints(138, '138.0.0.0')
  const changed = rewriteRequestClientHints(headers, hints)

  assert.equal(changed, true)
  assert.equal(headers['Sec-CH-UA'], hints['sec-ch-ua'])
  assert.equal(headers['Sec-CH-UA-Full-Version-List'], hints['sec-ch-ua-full-version-list'])
  // Unrelated headers are untouched.
  assert.equal(headers['User-Agent'], chromeUA)
})

test('rewriteRequestClientHints does not invent hints the request lacked', () => {
  const headers: Record<string, string | string[]> = { 'User-Agent': chromeUA }
  const changed = rewriteRequestClientHints(headers, googleAuthClientHints(138, '138.0.0.0'))

  assert.equal(changed, false)
  assert.equal(headers['sec-ch-ua'], undefined)
})
