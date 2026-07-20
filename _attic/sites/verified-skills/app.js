const skills = [
  {
    name: 'Frontend Design Principles',
    publisher: 'joshuadavidthomas / agent-skills',
    description: 'Builds product-specific visual direction before implementation and rejects generic frontend defaults.',
    category: 'design',
    score: 92,
    security: 'passed'
  },
  {
    name: 'Deep Research',
    publisher: 'daymade / claude-code-skills',
    description: 'Creates evidence-governed research reports with source registries, freshness checks, and counter-review.',
    category: 'research',
    score: 88,
    security: 'advisory'
  },
  {
    name: 'Accessibility Audit',
    publisher: 'open-interface / quality-skills',
    description: 'Reviews semantics, keyboard behavior, contrast, motion, and responsive interaction states.',
    category: 'design',
    score: 90,
    security: 'passed'
  },
  {
    name: 'Release Notes Editor',
    publisher: 'shipshape / product-workflows',
    description: 'Turns merged work into concise, audience-aware release notes with traceable change references.',
    category: 'workflow',
    score: 86,
    security: 'passed'
  },
  {
    name: 'Source-Backed Comparison',
    publisher: 'fieldnotes / research-kit',
    description: 'Compares products against a bounded evidence contract and labels uncertainty without hiding it.',
    category: 'research',
    score: 89,
    security: 'passed'
  },
  {
    name: 'Interface Copy Editor',
    publisher: 'plainspoken / ux-words',
    description: 'Rewrites interface language for clarity, action, consistency, recovery, and accessible comprehension.',
    category: 'workflow',
    score: 87,
    security: 'passed'
  }
]

const ledger = document.querySelector('#skillLedger')
const search = document.querySelector('#skillSearch')
const emptyState = document.querySelector('#emptyState')
const clearSearch = document.querySelector('#clearSearch')
const filters = [...document.querySelectorAll('.filter')]
const dialog = document.querySelector('#testDialog')
const runTest = document.querySelector('.run-test')
const testResult = document.querySelector('.test-result')
const bookmark = document.querySelector('.bookmark')
const savedCount = document.querySelector('#savedCount')
const toast = document.querySelector('.toast')

let activeFilter = 'all'
let toastTimer

function escapeHtml(value) {
  return value.replace(/[&<>'"]/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
  })[character])
}

function renderSkills() {
  const query = search.value.trim().toLowerCase()
  const visible = skills.filter(skill => {
    const categoryMatch = activeFilter === 'all' || skill.category === activeFilter
    const queryMatch = !query || `${skill.name} ${skill.publisher} ${skill.description}`.toLowerCase().includes(query)
    return categoryMatch && queryMatch
  })

  ledger.innerHTML = visible.map(skill => {
    const sourceIndex = skills.indexOf(skill) + 1
    const securityLabel = skill.security === 'passed' ? 'Scan passed' : 'Review advised'
    return `
      <article class="skill-row" data-category="${skill.category}">
        <span class="skill-index">${String(sourceIndex).padStart(3, '0')}</span>
        <div class="skill-name">
          <strong>${escapeHtml(skill.name)}</strong>
          <span>${escapeHtml(skill.publisher)}</span>
        </div>
        <p class="skill-description">${escapeHtml(skill.description)}</p>
        <div class="skill-score" aria-label="Quality score ${skill.score} out of 100">${skill.score}<span>${securityLabel}</span></div>
        <div class="skill-actions">
          <button class="row-button inspect" type="button" aria-label="Inspect ${escapeHtml(skill.name)}">↗</button>
          <button class="row-button install" type="button" aria-label="Simulate installing ${escapeHtml(skill.name)}">Install</button>
        </div>
      </article>
    `
  }).join('')

  emptyState.hidden = visible.length > 0
  ledger.hidden = visible.length === 0

  ledger.querySelectorAll('.inspect').forEach(button => {
    button.addEventListener('click', () => openTest())
  })
  ledger.querySelectorAll('.install').forEach(button => {
    button.addEventListener('click', () => {
      const installed = button.classList.toggle('is-installed')
      button.textContent = installed ? 'Added' : 'Install'
      button.setAttribute('aria-label', installed ? 'Simulated skill installed' : 'Simulate installing skill')
      showToast(installed ? 'Prototype state: skill added to the manifest.' : 'Prototype state: skill removed cleanly.')
    })
  })
}

function openTest() {
  testResult.hidden = true
  runTest.disabled = false
  runTest.innerHTML = 'Run simulated test <span aria-hidden="true">→</span>'
  dialog.showModal()
}

function showToast(message) {
  toast.textContent = message
  toast.classList.add('is-visible')
  window.clearTimeout(toastTimer)
  toastTimer = window.setTimeout(() => toast.classList.remove('is-visible'), 2600)
}

search.addEventListener('input', renderSkills)
filters.forEach(button => {
  button.addEventListener('click', () => {
    activeFilter = button.dataset.filter
    filters.forEach(candidate => {
      const active = candidate === button
      candidate.classList.toggle('is-active', active)
      candidate.setAttribute('aria-pressed', String(active))
    })
    renderSkills()
  })
})

clearSearch.addEventListener('click', () => {
  search.value = ''
  activeFilter = 'all'
  filters.forEach(button => {
    const active = button.dataset.filter === 'all'
    button.classList.toggle('is-active', active)
    button.setAttribute('aria-pressed', String(active))
  })
  renderSkills()
  search.focus()
})

document.querySelectorAll('[data-open-test]').forEach(button => button.addEventListener('click', openTest))
document.querySelectorAll('[data-open-method]').forEach(button => {
  button.addEventListener('click', () => document.querySelector('#method').scrollIntoView({ behavior: 'smooth' }))
})

runTest.addEventListener('click', () => {
  runTest.disabled = true
  runTest.textContent = 'Running isolated prompt…'
  window.setTimeout(() => {
    testResult.hidden = false
    runTest.textContent = 'Test complete'
    testResult.querySelector('strong').focus?.()
  }, 700)
})

bookmark.addEventListener('click', () => {
  const saved = bookmark.getAttribute('aria-pressed') !== 'true'
  bookmark.setAttribute('aria-pressed', String(saved))
  bookmark.innerHTML = saved ? '<span aria-hidden="true">✓</span> Saved' : '<span aria-hidden="true">＋</span> Save'
  savedCount.textContent = saved ? '1' : '0'
  showToast(saved ? 'Saved to your review list.' : 'Removed from your review list.')
})

dialog.addEventListener('click', event => {
  if (event.target === dialog) dialog.close()
})

renderSkills()
