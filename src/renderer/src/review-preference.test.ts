import assert from 'node:assert/strict';
import test from 'node:test';
import {
  alwaysKeepAllStorageKey,
  isAlwaysKeepAllStored,
  storedAlwaysKeepAllValue,
} from './review-preference.js';

test('always keep all uses one stable persisted preference', () => {
  assert.equal(alwaysKeepAllStorageKey, 'codexdesktop.alwaysKeepAll');
  assert.equal(isAlwaysKeepAllStored(null), false);
  assert.equal(isAlwaysKeepAllStored('0'), false);
  assert.equal(isAlwaysKeepAllStored('1'), true);
  assert.equal(storedAlwaysKeepAllValue(false), '0');
  assert.equal(storedAlwaysKeepAllValue(true), '1');
});
