const menuButton = document.querySelector('[data-menu-toggle]')
const navigation = document.querySelector('[data-nav]')
const header = document.querySelector('[data-header]')

function closeMenu() {
  menuButton?.setAttribute('aria-expanded', 'false')
  navigation?.classList.remove('open')
}

menuButton?.addEventListener('click', () => {
  const isOpen = menuButton.getAttribute('aria-expanded') === 'true'
  menuButton.setAttribute('aria-expanded', String(!isOpen))
  navigation?.classList.toggle('open', !isOpen)
})

navigation?.querySelectorAll('a').forEach((link) => link.addEventListener('click', closeMenu))
window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    closeMenu()
    menuButton?.focus()
  }
})

function updateHeader() {
  header?.classList.toggle('scrolled', window.scrollY > 24)
}
window.addEventListener('scroll', updateHeader, { passive: true })
updateHeader()

const today = new Date().getDay()
document.querySelector(`[data-day="${today === 0 || today === 6 ? today : 1}"]`)?.classList.add('today')
const hours = today === 0 ? '8am–3pm' : today === 6 ? '8am–5pm' : '7am–5pm'
const todayHours = document.querySelector('[data-today-hours]')
if (todayHours) todayHours.textContent = hours

document.querySelector('[data-year]').textContent = new Date().getFullYear()

const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
const revealItems = document.querySelectorAll('.reveal')
if (prefersReducedMotion || !('IntersectionObserver' in window)) {
  revealItems.forEach((item) => item.classList.add('visible'))
} else {
  const observer = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (entry.isIntersecting) {
        entry.target.classList.add('visible')
        observer.unobserve(entry.target)
      }
    })
  }, { threshold: 0.13 })
  revealItems.forEach((item) => observer.observe(item))
}
