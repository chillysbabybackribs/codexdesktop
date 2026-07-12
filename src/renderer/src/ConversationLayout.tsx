import { useRef, useState, type ReactNode } from 'react'
import {
  assignTarget,
  conversationDragMime,
  dropEdgeFromGrid,
  MAX_SPLIT_RATIO,
  MIN_SPLIT_RATIO,
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
  tabDragTarget: ConversationTarget | null
  onLayoutChange: (layout: LayoutNode) => void
  onFocusedLeafChange: (leafId: string) => void
  renderPane: (target: ConversationTarget, leafId: string, focused: boolean) => ReactNode
}

export function ConversationLayoutTree({
  layout,
  focusedLeafId,
  tabDragTarget,
  onLayoutChange,
  onFocusedLeafChange,
  renderPane
}: ConversationLayoutTreeProps): React.JSX.Element {
  const replaceNode = (nodeId: string, replacement: LayoutNode): void => {
    onLayoutChange(replaceLayoutNode(layout, nodeId, replacement))
  }

  return (
    <div className={`conversation-layout-root ${tabDragTarget ? 'is-tab-dragging' : ''}`}>
      <LayoutBranch
        node={layout}
        focusedLeafId={focusedLeafId}
        tabDragTarget={tabDragTarget}
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
  tabDragTarget,
  replaceNode,
  onFocusedLeafChange,
  renderPane
}: {
  node: LayoutNode
  focusedLeafId: string
  tabDragTarget: ConversationTarget | null
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
        tabDragTarget={tabDragTarget}
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
  const firstShare = Math.min(MAX_SPLIT_RATIO, Math.max(MIN_SPLIT_RATIO, node.ratio))
  const secondShare = 1 - firstShare

  return (
    <div
      className={`conversation-layout-split is-${node.direction}`}
      style={isRow
        ? { gridTemplateColumns: `minmax(0, ${firstShare}fr) 5px minmax(0, ${secondShare}fr)` }
        : { gridTemplateRows: `minmax(0, ${firstShare}fr) 5px minmax(0, ${secondShare}fr)` }}
    >
      <LayoutBranch
        node={node.first}
        focusedLeafId={focusedLeafId}
        tabDragTarget={tabDragTarget}
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
        tabDragTarget={tabDragTarget}
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
  tabDragTarget,
  onFocus,
  onAssign,
  renderPane
}: {
  leafId: string
  target: ConversationTarget
  focused: boolean
  tabDragTarget: ConversationTarget | null
  onFocus: () => void
  onAssign: (target: ConversationTarget, edge: DropEdge) => void
  renderPane: (target: ConversationTarget, leafId: string, focused: boolean) => ReactNode
}): React.JSX.Element {
  return (
    <div
      className={`conversation-layout-pane ${focused ? 'is-focused' : ''}`}
      data-leaf-id={leafId}
      onMouseDown={onFocus}
    >
      {renderPane(target, leafId, focused)}
      {tabDragTarget ? (
        <ConversationDropOverlay
          onAssign={(edge) => onAssign(tabDragTarget, edge)}
        />
      ) : null}
    </div>
  )
}

function ConversationDropOverlay({
  onAssign
}: {
  onAssign: (edge: DropEdge) => void
}): React.JSX.Element {
  const overlayRef = useRef<HTMLDivElement | null>(null)
  const [activeEdge, setActiveEdge] = useState<DropEdge>('center')

  const handleDragOver = (event: React.DragEvent<HTMLDivElement>): void => {
    if (!event.dataTransfer.types.includes(conversationDragMime)) return
    event.preventDefault()
    event.stopPropagation()
    event.dataTransfer.dropEffect = 'move'
    const rect = overlayRef.current?.getBoundingClientRect()
    if (!rect) return
    setActiveEdge(dropEdgeFromGrid(rect, event.clientX, event.clientY))
  }

  const handleDrop = (event: React.DragEvent<HTMLDivElement>): void => {
    if (!event.dataTransfer.types.includes(conversationDragMime)) return
    event.preventDefault()
    event.stopPropagation()
    const rect = overlayRef.current?.getBoundingClientRect()
    const edge = rect ? dropEdgeFromGrid(rect, event.clientX, event.clientY) : activeEdge
    onAssign(edge)
  }

  return (
    <div
      ref={overlayRef}
      className="conversation-drop-overlay"
      data-active-edge={activeEdge}
      onDragEnter={handleDragOver}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      <div className="conversation-drop-zone is-left">
        <span>Side by side</span>
      </div>
      <div className="conversation-drop-zone is-right">
        <span>Side by side</span>
      </div>
      <div className="conversation-drop-zone is-top">
        <span>Add above</span>
      </div>
      <div className="conversation-drop-zone is-bottom">
        <span>Add below</span>
      </div>
      <div className="conversation-drop-zone is-center">
        <span>Open here</span>
      </div>
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
