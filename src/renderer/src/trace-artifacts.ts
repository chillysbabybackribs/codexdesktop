import type { TraceArtifact, TraceInputItem } from './trace-types'

export function traceArtifacts(items: TraceInputItem[]): TraceArtifact[] {
  const artifacts = new Map<string, TraceArtifact>()
  for (const item of items) {
    if (item.type === 'fileChange') {
      for (const change of item.changes) {
        addTraceArtifact(artifacts, {
          path: change.path,
          kind: 'workspaceChange',
          originEventId: item.id,
          availability: 'pathOnly'
        })
      }
      continue
    }
    if (item.type === 'dynamicToolCall' && (item.tool === 'browser_cdp' || item.tool === 'browser_screenshot' || item.tool === 'app_screenshot' || item.tool === 'browser_flow' || item.tool === 'browser_run')) {
      for (const content of item.contentItems ?? []) {
        if (content.type !== 'inputText') continue
        try {
          const parsed = JSON.parse(content.text) as {
            result?: unknown
            screenshot?: { artifactPath?: unknown }
            pdf?: { artifactPath?: unknown }
            trace?: { artifactPath?: unknown }
            snapshot?: { artifactPath?: unknown }
            responseBody?: { artifactPath?: unknown }
            artifact?: { artifactPath?: unknown }
          }
          const result = parsed.result && typeof parsed.result === 'object'
            ? parsed.result as typeof parsed
            : parsed
          for (const artifact of [result.screenshot, result.pdf, result.trace, result.snapshot, result.responseBody, parsed.artifact]) {
            if (typeof artifact?.artifactPath !== 'string') continue
            addTraceArtifact(artifacts, {
              path: artifact.artifactPath,
              kind: 'generatedFile',
              originEventId: item.id,
              availability: 'pathOnly'
            })
          }
        } catch {
          // A failed or non-JSON CDP result is not an artifact.
        }
      }
      continue
    }
    if (item.type === 'dynamicToolCall' && item.tool === 'research_web') {
      for (const content of item.contentItems ?? []) {
        if (content.type !== 'inputText') continue
        try {
          const result = JSON.parse(content.text) as {
            artifactDir?: unknown
            pages?: Array<{ artifactPath?: unknown; htmlPath?: unknown }>
          }
          if (typeof result.artifactDir === 'string') {
            addTraceArtifact(artifacts, {
              path: result.artifactDir,
              kind: 'researchCapsule',
              originEventId: item.id,
              availability: 'pathOnly'
            })
          }
          for (const page of Array.isArray(result.pages) ? result.pages : []) {
            for (const path of [page.artifactPath, page.htmlPath]) {
              if (typeof path !== 'string') continue
              addTraceArtifact(artifacts, {
                path,
                kind: 'generatedFile',
                originEventId: item.id,
                availability: 'pathOnly'
              })
            }
          }
        } catch {
          // A failed or partial tool result is not promoted into the artifact index.
        }
      }
      continue
    }
    if (item.type !== 'commandExecution') continue
    const searchable = `${item.command}\n${item.aggregatedOutput ?? ''}`
    for (const match of searchable.matchAll(/\/tmp\/codexdesktop-tasks\/[A-Za-z0-9._/-]+/g)) {
      const path = match[0].replace(/[.,;:)\]]+$/g, '').replace(/\/$/, '')
      const capsulePath = /^\/tmp\/codexdesktop-tasks\/[^/]+/.exec(path)?.[0]
      if (capsulePath) {
        addTraceArtifact(artifacts, {
          path: capsulePath,
          kind: 'researchCapsule',
          originEventId: item.id,
          availability: 'pathOnly'
        })
      }
      const leaf = path.split('/').pop() ?? ''
      addTraceArtifact(artifacts, {
        path,
        kind: leaf.includes('.') ? 'generatedFile' : 'researchCapsule',
        originEventId: item.id,
        availability: 'pathOnly'
      })
    }
  }
  return [...artifacts.values()]
}

function addTraceArtifact(artifacts: Map<string, TraceArtifact>, artifact: TraceArtifact): void {
  if (!artifacts.has(artifact.path)) artifacts.set(artifact.path, artifact)
}
