import { query } from '@anthropic-ai/claude-agent-sdk'

// Minimal queue that mirrors AsyncMessageQueue: blocks (never ends) until pushed.
class Q {
  constructor(){ this.values=[]; this.waiters=[]; this.ended=false }
  push(v){ const w=this.waiters.shift(); if(w) w({value:v,done:false}); else this.values.push(v) }
  close(){ this.ended=true; let w; while((w=this.waiters.shift())) w({value:undefined,done:true}) }
  [Symbol.asyncIterator](){ return { next: ()=> {
    if(this.values.length) return Promise.resolve({value:this.values.shift(),done:false})
    if(this.ended) return Promise.resolve({value:undefined,done:true})
    return new Promise(res=>this.waiters.push(res))
  }}}
}

const log = (...a)=>console.log(new Date().toISOString().slice(11,23), ...a)

const input = new Q()
log('creating query...')
const q = query({
  prompt: input,
  options: {
    cwd: process.env.HOME,
    systemPrompt: { type: 'preset', preset: 'claude_code', excludeDynamicSections: true },
    tools: { type: 'preset', preset: 'claude_code' },
    settingSources: ['project'],
    strictMcpConfig: true,
    disallowedTools: ['WebSearch','WebFetch','Agent'],
    permissionMode: 'bypassPermissions',
    allowDangerouslySkipPermissions: true,
    env: { ...process.env, CLAUDE_AGENT_SDK_CLIENT_APP: 'codexdesktop/0.1.0' }
  }
})

const withTimeout = (p, ms, label) => Promise.race([p, new Promise((_,r)=>setTimeout(()=>r(new Error('TIMEOUT '+label+' '+ms+'ms')), ms))])

try {
  log('awaiting first q.next() (init)...')
  const first = await withTimeout(q.next(), 30000, 'q.next')
  log('first.done=', first.done, 'type=', first.value?.type, 'subtype=', first.value?.subtype)
  log('apiKeySource=', first.value?.apiKeySource)
  log('awaiting supportedModels()...')
  const models = await withTimeout(q.supportedModels(), 30000, 'supportedModels')
  log('MODELS COUNT:', models.length)
  console.log(JSON.stringify(models.slice(0,4), null, 2))
} catch (e) {
  log('ERROR:', e?.message)
} finally {
  input.close(); q.close(); process.exit(0)
}
