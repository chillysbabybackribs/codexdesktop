import { useRef, type ReactNode } from 'react'
import {
  assignTarget,
  conversationDragMime,
  dropEdgeFromPoint,
  replaceLayoutNode,
  setSplitRatio,
  splitLeafAtEdge,
  type ConversationTarget,
  type DropEdge,
  type LayoutNode
} from './conversation-layout'

type ConversationLayoutTreeProps = {
  layout: LayoutNode
  focusedLeafId: string
  onLayoutChange: (layout: LayoutNode) => void
  onFocusedLeafChange: (leafId: string) => void
  renderPane: (target: ConversationTarget, leafId: string, focused: boolean) => ReactNode
}

export function ConversationLayoutTree({
  layout,
  focusedLeafId,
  onLayoutChange,
  onFocusedLeafChange,
  renderPane
}: ConversationLayoutTreeProps): React.JSX.Element {
  const replaceNode = (nodeId: string, replacement: LayoutNode): void => {
    onLayoutChange(replaceLayoutNode(layout, nodeId, replacement))
  }

  return (
    <div className="conversation-layout-root">
      <LayoutBranch
        node={layout}
        focusedLeafId={focusedLeafId}
        replaceNode={replaceNode}
        onFocusedLeafChange={onFocusedLeafChange}
        renderPane={renderPane}
      />
    </div>
  )
}

function LayoutBranch({
  node,
  focusedLeafId,
  replaceNode,
  onFocusedLeafChange,
  renderPane
}: {
  node: LayoutNode
  focusedLeafId: string
  replaceNode: (nodeId: string, replacement: LayoutNode) => void
  onFocusedLeafChange: (leafId: string) => void
  renderPane: (target: ConversationTarget, leafId: string, focused: boolean) => ReactNode
}): React.JSX.Element {
  if (node.type === 'leaf') {
    return (
      <ConversationPane
        leafId={node.id}
        target={node.target}
        focused={focusedLeafId === node.id}
        onFocus={() => onFocusedLeafChange(node.id)}
        onAssign={(target, edge) => {
          if (edge === 'center') {
            replaceNode(node.id, assignTarget(node, node.id, target))
            onFocusedLeafChange(node.id)
            return
          }
          replaceNode(node.id, splitLeafAtEdge(node, node.id, edge, target))
          onFocusedLeafChange(node.id)
        }}
        renderPane={renderPane}
      />
    )
  }

  const isRow = node.direction === 'row'

  return (
    <div
      className={`conversation-layout-split is-${node.direction}`}
      style={isRow
        ? { gridTemplateColumns: `${node.ratio * 100}% 5px 1fr` }
        : { gridTemplateRows: `${node.ratio * 100}% 5px 1fr` }}
    >
      <LayoutBranch
        node={node.first}
        focusedLeafId={focusedLeafId}
        replaceNode={replaceNode}
        onFocusedLeafChange={onFocusedLeafChange}
        renderPane={renderPane}
      />
      <LayoutDivider
        direction={node.direction}
        onDrag={(ratio) => replaceNode(node.id, setSplitRatio(node, node.id, ratio))}
      />
      <LayoutBranch
        node={node.second}
        focusedLeafId={focusedLeafId}
        replaceNode={replaceNode}
        onFocusedLeafChange={onFocusedLeafChange}
        renderPane={renderPane}
      />
    </div>
  )
}

function ConversationPane({
  leafId,
  target,
  focused,
  onFocus,
  onAssign,
  renderPane
}: {
  leafId: string
  target: ConversationTarget
  focused: boolean
  onFocus: () => void
  onAssign: (target: ConversationTarget, edge: DropEdge) => void
  renderPane: (target: ConversationTarget, leafId: string, focused: boolean) => ReactNode
}): React.JSX.Element {
  const paneRef = useRef<HTMLDivElement | null>(null)
  const dragDepthRef = useRef(0)

  const handleDragEnter = (event: React.DragEvent<HTMLDivElement>): void => {
    if (!event.dataTransfer.types.includes(conversationDragMime)) return
    event.preventDefault()
    dragDepthRef.current += 1
    event.currentTarget.classList.add('is-drop-target')
  }

  const handleDragLeave = (event: React.DragEvent<HTMLDivElement>): void => {
    if (!event.dataTransfer.types.includes(conversationDragMime)) return
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1)
    if (dragDepthRef.current === 0) event.currentTarget.classList.remove('is-drop-target')
  }

  const handleDragOver = (event: React.DragEvent<HTMLDivElement>): void => {
    if (!event.dataTransfer.types.includes(conversationDragMime)) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
    const rect = paneRef.current?.getBoundingClientRect()
    if (!rect) return
    const edge = dropEdgeFromPoint(rect, event.clientX, event.clientY)
    event.currentTarget.dataset.dropEdge = edge
  }

  const handleDrop = (event: React.DragEvent<HTMLDivElement>): void => {
    if (!event.dataTransfer.types.includes(conversationDragMime)) return
    event.preventDefault()
    dragDepthRef.current = 0
    event.currentTarget.classList.remove('is-drop-target')
    delete event.currentTarget.dataset.dropEdge
    const dragged = event.dataTransfer.getData(conversationDragMime)
    if (!dragged) return
    const rect = paneRef.current?.getBoundingClientRect()
    const edge = rect ? dropEdgeFromPoint(rect, event.clientX, event.clientY) : 'center'
    onAssign(dragged, edge)
  }

  return (
    <div
      ref={paneRef}
      className={`conversation-layout-pane ${focused ? 'is-focused' : ''}`}
      data-leaf-id={leafId}
      onMouseDown={onFocus}
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      {renderPane(target, leafId, focused)}
    </div>
  )
}

function LayoutDivider({
  direction,
  onDrag
}: {
  direction: 'row' | 'column'
  onDrag: (ratio: number) => void
}): React.JSX.Element {
  const dividerRef = useRef<HTMLDivElement | null>(null)
  const isRow = direction === 'row'

  const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>): void => {
    const host = dividerRef.current?.parentElement
    if (!host) return
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)

    const hostRect = host.getBoundingClientRect()
    const move = (moveEvent: PointerEvent): void => {
      const ratio = isRow
        ? (moveEvent.clientX - hostRect.left) / hostRect.width
        : (moveEvent.clientY - hostRect.top) / hostRect.height
      onDrag(ratio)
    }

    const finish = (): void => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', finish)
      window.removeEventListener('pointercancel', finish)
    }

    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', finish, { once: true })
    window.addEventListener('pointercancel', finish, { once: true })
  }

  return (
    <div
      ref={dividerRef}
      className={`conversation-layout-divider is-${direction}`}
      onPointerDown={handlePointerDown}
    />
  )
}

export function writeConversationDragTarget(dataTransfer: DataTransfer, target: ConversationTarget): void {
  dataTransfer.setData(conversationDragMime, target)
  dataTransfer.effectAllowed = 'move'
}
