import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ReviewBar } from './ReviewBar'

function renderReviewBar(alwaysKeepAll: boolean): string {
  return renderToStaticMarkup(
    createElement(ReviewBar, {
      changes: [],
      workspace: null,
      undonePaths: new Set<string>(),
      alwaysKeepAll,
      onKeepAll: () => undefined,
      onSetAlwaysKeepAll: () => undefined,
      onUndoAll: () => undefined,
      onUndoFile: () => undefined
    })
  )
}

test('always keep all is an accessible persistent-mode toggle', () => {
  const inactive = renderReviewBar(false)
  assert.match(inactive, /aria-pressed="false"/)
  assert.match(inactive, />Always keep all<\/button>/)

  const active = renderReviewBar(true)
  assert.match(active, /class="review-always-keep is-active"/)
  assert.match(active, /aria-pressed="true"/)
})
