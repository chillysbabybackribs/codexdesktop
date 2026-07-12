import { useEffect, useRef, useState, type ReactNode } from 'react'
import {
  assignTarget,
  conversationDragMime,
  dropEdgeFromProfile,
  dropProfileForRect,
  findLeaf,
  MAX_SPLIT_RATIO,
  MIN_SPLIT_RATIO,
  replaceLayoutNode,
  setSplitRatio,
  splitLeafAtEdge,
  type ConversationTarget,
  type DropEdge,
  type DropProfile,
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

type DropTargetState = {
  leafId: string
  rect: DOMRect
  profile: DropProfile
}

export function ConversationLayoutTree({
  layout,
  focusedLeafId,
  tabDragTarget,
  onLayoutChange,
  onFocusedLeafChange,
  renderPane
}: ConversationLayoutTreeProps): React.JSX.Element {
  const rootRef = useRef<HTMLDivElement | null>(null)
  const [dropTarget, setDropTarget] = useState<DropTargetState | null>(null)
  const [activeEdge, setActiveEdge] = useState<DropEdge>('center')

  const replaceNode = (nodeId: string, replacement: LayoutNode): void => {
    onLayoutChange(replaceLayoutNode(layout, nodeId, replacement))
  }

  const assignToLeaf = (leafId: string, target: ConversationTarget, edge: DropEdge): void => {
    const leaf = findLeaf(layout, leafId)
    if (!leaf) return
    if (edge === 'center') {
      replaceNode(leafId, assignTarget(leaf, leafId, target))
    } else {
      replaceNode(leafId, splitLeafAtEdge(leaf, leafId, edge, target))
    }
    onFocusedLeafChange(leafId)
  }

  const resolveDropTarget = (clientX: number, clientY: number): DropTargetState | null => {
    const root = rootRef.current
    if (!root) return null

    const panes = root.querySelectorAll<HTMLElement>('.conversation-layout-pane[data-leaf-id]')
    for (const pane of panes) {
      const rect = pane.getBoundingClientRect()
      if (
        clientX >= rect.left
        && clientX <= rect.right
        && clientY >= rect.top
        && clientY <= rect.bottom
      ) {
        const leafId = pane.dataset.leafId
        if (!leafId) return null
        return { leafId, rect, profile: dropProfileForRect(rect) }
      }
    }

    return null
  }

  useEffect(() => {
    if (!tabDragTarget) {
      setDropTarget(null)
      setActiveEdge('center')
      return
    }

    const handleDragOver = (event: DragEvent): void => {
      if (!event.dataTransfer?.types.includes(conversationDragMime)) return
      event.preventDefault()
      event.dataTransfer.dropEffect = 'move'

      const nextTarget = resolveDropTarget(event.clientX, event.clientY)
      if (!nextTarget) {
        setDropTarget(null)
        return
      }

      setDropTarget(nextTarget)
      setActiveEdge(dropEdgeFromProfile(nextTarget.rect, event.clientX, event.clientY, nextTarget.profile))
    }

    const handleDrop = (event: DragEvent): void => {
      if (!event.dataTransfer?.types.includes(conversationDragMime)) return
      event.preventDefault()
      const nextTarget = resolveDropTarget(event.clientX, event.clientY)
      if (!nextTarget) return
      const edge = dropEdgeFromProfile(nextTarget.rect, event.clientX, event.clientY, nextTarget.profile)
      assignToLeaf(nextTarget.leafId, tabDragTarget, edge)
      setDropTarget(null)
      setActiveEdge('center')
    }

    const handleDragLeave = (event: DragEvent): void => {
      if (event.relatedTarget instanceof Node && rootRef.current?.contains(event.relatedTarget)) return
      setDropTarget(null)
    }

    window.addEventListener('dragover', handleDragOver)
    window.addEventListener('drop', handleDrop)
    window.addEventListener('dragleave', handleDragLeave)
    return () => {
      window.removeEventListener('dragover', handleDragOver)
      window.removeEventListener('drop', handleDrop)
      window.removeEventListener('dragleave', handleDragLeave)
    }
  }, [tabDragTarget, layout])

  const overlayStyle = dropTarget && rootRef.current
    ? (() => {
        const rootRect = rootRef.current.getBoundingClientRect()
        return {
          top: dropTarget.rect.top - rootRect.top,
          left: dropTarget.rect.left - rootRect.left,
          width: dropTarget.rect.width,
          height: dropTarget.rect.height
        }
      })()
    : null

  return (
    <div
      ref={rootRef}
      className={`conversation-layout-root ${tabDragTarget ? 'is-tab-dragging' : ''}`}
    >
      <LayoutBranch
        node={layout}
        focusedLeafId={focusedLeafId}
        dropTargetLeafId={dropTarget?.leafId ?? null}
        replaceNode={replaceNode}
        onFocusedLeafChange={onFocusedLeafChange}
        renderPane={renderPane}
      />
      {tabDragTarget && dropTarget && overlayStyle ? (
        <ConversationDropOverlay
          profile={dropTarget.profile}
          activeEdge={activeEdge}
          compact={dropTarget.rect.width < 260 || dropTarget.rect.height < 220}
          style={overlayStyle}
        />
      ) : null}
    </div>
  )
}

function LayoutBranch({
  node,
  focusedLeafId,
  dropTargetLeafId,
  replaceNode,
  onFocusedLeafChange,
  renderPane
}: {
  node: LayoutNode
  focusedLeafId: string
  dropTargetLeafId: string | null
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
        isDropTarget={dropTargetLeafId === node.id}
        isDragging={dropTargetLeafId !== null}
        onFocus={() => onFocusedLeafChange(node.id)}
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
        dropTargetLeafId={dropTargetLeafId}
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
        dropTargetLeafId={dropTargetLeafId}
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
  isDropTarget,
  isDragging,
  onFocus,
  renderPane
}: {
  leafId: string
  target: ConversationTarget
  focused: boolean
  isDropTarget: boolean
  isDragging: boolean
  onFocus: () => void
  renderPane: (target: ConversationTarget, leafId: string, focused: boolean) => ReactNode
}): React.JSX.Element {
  return (
    <div
      className={[
        'conversation-layout-pane',
        focused ? 'is-focused' : '',
        isDragging ? 'is-drag-passive' : '',
        isDropTarget ? 'is-drop-target' : ''
      ].filter(Boolean).join(' ')}
      data-leaf-id={leafId}
      onMouseDown={onFocus}
    >
      {renderPane(target, leafId, focused)}
    </div>
  )
}

function ConversationDropOverlay({
  profile,
  activeEdge,
  compact,
  style
}: {
  profile: DropProfile
  activeEdge: DropEdge
  compact: boolean
  style: { top: number; left: number; width: number; height: number }
}): React.JSX.Element {
  return (
    <div
      className={`conversation-drop-overlay is-${profile} ${compact ? 'is-compact' : ''}`}
      data-active-edge={activeEdge}
      style={style}
      aria-hidden="true"
    >
      <div className="conversation-drop-zone is-left">
        {!compact ? <span>Side by side</span> : null}
      </div>
      <div className="conversation-drop-zone is-right">
        {!compact ? <span>Side by side</span> : null}
      </div>
      <div className="conversation-drop-zone is-top">
        {!compact ? <span>Stack above</span> : null}
      </div>
      <div className="conversation-drop-zone is-bottom">
        {!compact ? <span>Stack below</span> : null}
      </div>
      <div className="conversation-drop-zone is-center">
        {!compact ? <span>Open here</span> : null}
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
