import { query } from '@anthropic-ai/claude-agent-sdk'

const input = (async function* () {
  // never yields; we only need init + supportedModels
  await new Promise(() => {})
})()

const q = query({
  prompt: input,
  options: {
    cwd: process.env.HOME,
    systemPrompt: { type: 'preset', preset: 'claude_code', excludeDynamicSections: true },
    tools: { type: 'preset', preset: 'claude_code' },
    settingSources: ['project'],
    permissionMode: 'bypassPermissions',
    allowDangerouslySkipPermissions: true,
    env: { ...process.env, CLAUDE_AGENT_SDK_CLIENT_APP: 'codexdesktop/0.1.0' }
  }
})

try {
  const first = await q.next()
  console.log('FIRST done?', first.done)
  console.log('FIRST type/subtype:', first.value?.type, first.value?.subtype)
  console.log('apiKeySource:', first.value?.apiKeySource)
  const models = await q.supportedModels()
  console.log('MODELS COUNT:', models.length)
  console.log(JSON.stringify(models, null, 2))
} catch (e) {
  console.error('ERROR:', e?.message)
  console.error(e?.stack)
} finally {
  q.close()
  process.exit(0)
}
