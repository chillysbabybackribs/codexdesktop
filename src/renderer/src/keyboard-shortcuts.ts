const textEditingSelector =
  'input, textarea, [contenteditable=""], [contenteditable="true"], [role="textbox"]'

export function isTextEditingEventTarget(target: EventTarget | null): boolean {
  const candidate = target as { closest?: (selector: string) => unknown } | null
  return typeof candidate?.closest === 'function' && Boolean(candidate.closest(textEditingSelector))
}

export function shouldHandleChatSplitShortcut(
  event: Pick<
    KeyboardEvent,
    'key' | 'code' | 'ctrlKey' | 'metaKey' | 'altKey' | 'defaultPrevented' | 'target'
  >,
): boolean {
  return Boolean(
    (event.ctrlKey || event.metaKey) &&
      !event.altKey &&
      !event.defaultPrevented &&
      event.code === 'Backslash' &&
      (event.key === '\\' || event.key === '|') &&
      !isTextEditingEventTarget(event.target),
  )
}
