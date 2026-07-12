const toggle = document.querySelector('.menu-toggle')
const nav = document.querySelector('.site-nav')

toggle?.addEventListener('click', () => {
  const open = toggle.getAttribute('aria-expanded') === 'true'
  toggle.setAttribute('aria-expanded', String(!open))
  nav?.classList.toggle('is-open', !open)
  document.body.classList.toggle('menu-open', !open)
})

nav?.querySelectorAll('a').forEach((link) => {
  link.addEventListener('click', () => {
    toggle?.setAttribute('aria-expanded', 'false')
    nav.classList.remove('is-open')
    document.body.classList.remove('menu-open')
  })
})

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && nav?.classList.contains('is-open')) {
    toggle?.setAttribute('aria-expanded', 'false')
    nav.classList.remove('is-open')
    document.body.classList.remove('menu-open')
    toggle?.focus()
  }
})

document.querySelector('[data-year]').textContent = new Date().getFullYear()

const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
if (!reduceMotion && 'IntersectionObserver' in window) {
  document.documentElement.classList.add('has-motion')
  const observer = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (entry.isIntersecting) {
        entry.target.classList.add('is-visible')
        observer.unobserve(entry.target)
      }
    })
  }, { threshold: 0.12 })

  document.querySelectorAll('.reveal').forEach((element) => observer.observe(element))
}
