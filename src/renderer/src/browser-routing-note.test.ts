import assert from 'node:assert/strict';
import test from 'node:test';
import { stripLegacyBrowserRoutingNote } from './browser-routing-note.ts';

const note =
  '[browser routing] mode=dual (quality-max): search-shaped or freshness-sensitive: verify live in the visible tab while parallel background research corroborates. Start with browser_research_dual unless the request clearly needs no external evidence.';

test('legacy browser routing hints are hidden from stored user messages', () => {
  assert.equal(stripLegacyBrowserRoutingNote(`Find the latest release\n\n${note}`), 'Find the latest release');
  assert.equal(stripLegacyBrowserRoutingNote(`Find the latest release\n${note}`), 'Find the latest release');
  assert.equal(stripLegacyBrowserRoutingNote(note), '');
});

test('ordinary user-authored browser text is preserved', () => {
  const text = 'Please explain [browser routing] and mode=dual in this source.';
  assert.equal(stripLegacyBrowserRoutingNote(text), text);
});
