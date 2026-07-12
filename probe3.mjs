import { query } from '@anthropic-ai/claude-agent-sdk'
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
const withTimeout = (p, ms, label) => Promise.race([p, new Promise((_,r)=>setTimeout(()=>r(new Error('TIMEOUT '+label)), ms))])

async function tryOpts(name, options) {
  const input = new Q()
  const q = query({ prompt: input, options })
  try {
    const first = await withTimeout(q.next(), 20000, name)
    log(name, '=> OK type=', first.value?.type, first.value?.subtype, 'apiKeySource=', first.value?.apiKeySource)
    return true
  } catch(e) {
    log(name, '=>', e.message)
    return false
  } finally { input.close(); q.close() }
}

// A: bare minimum
await tryOpts('A_bare', { cwd: process.env.HOME })
// B: bare + settingSources project
await tryOpts('B_settings', { cwd: process.env.HOME, settingSources: ['project'] })
// C: with claude_code preset systemPrompt only
await tryOpts('C_preset', { cwd: process.env.HOME, systemPrompt:{type:'preset',preset:'claude_code',excludeDynamicSections:true} })
process.exit(0)
