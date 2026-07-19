const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const toast = $('#toast');
let toastTimer;
let lastFocused;

function showToast(message) {
  toast.textContent = message;
  toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.hidden = true; }, 3200);
}

function scrollToCard(id) {
  const target = document.getElementById(id);
  if (!target) return;
  target.scrollIntoView({ behavior: 'smooth', block: 'center' });
  target.classList.add('flash');
  setTimeout(() => target.classList.remove('flash'), 1200);
}

$$('[data-jump]').forEach((button) => button.addEventListener('click', () => scrollToCard(button.dataset.jump)));
$$('[data-source]').forEach((button) => button.addEventListener('click', () => {
  const source = $$('.transcript-item').find((item) => item.querySelector('time')?.textContent === button.dataset.source);
  if (source) { source.scrollIntoView({ behavior: 'smooth', block: 'center' }); source.classList.add('flash'); setTimeout(() => source.classList.remove('flash'), 1200); }
}));

const searchInput = $('#searchInput');
let activeFilter = 'all';
function applyFilters() {
  const term = searchInput.value.trim().toLowerCase();
  const cards = $$('.outcome-card');
  let shown = 0;
  cards.forEach((card) => {
    const matchesText = !term || card.dataset.search.includes(term) || card.textContent.toLowerCase().includes(term);
    const matchesFilter = activeFilter === 'all' || (activeFilter === 'needs-review' && card.classList.contains('needs-review')) || (activeFilter === 'assigned' && !card.textContent.includes('Owner missing')) || card.dataset.type === activeFilter;
    const visible = matchesText && matchesFilter;
    card.hidden = !visible;
    if (visible) shown += 1;
  });
  $$('.transcript-item').forEach((item) => { item.hidden = Boolean(term) && !item.dataset.search.includes(term); });
  $('#noResults').hidden = shown !== 0;
}
searchInput.addEventListener('input', applyFilters);
$$('.filter').forEach((filter) => filter.addEventListener('click', () => {
  activeFilter = filter.dataset.filter;
  $$('.filter').forEach((item) => item.classList.toggle('is-selected', item === filter));
  applyFilters();
}));
document.addEventListener('keydown', (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); searchInput.focus(); }
  if (event.key === 'Escape' && !$('#importModal').hidden) closeImport();
});

$$('.task-check').forEach((check) => check.addEventListener('click', () => {
  check.classList.toggle('is-done');
  check.textContent = check.classList.contains('is-done') ? '✓' : '';
  check.setAttribute('aria-label', check.classList.contains('is-done') ? 'Mark task incomplete' : 'Mark task complete');
  showToast(check.classList.contains('is-done') ? 'Task marked complete.' : 'Task returned to the review queue.');
}));

$('.assign-button').addEventListener('click', (event) => {
  const button = event.currentTarget;
  button.outerHTML = '<span class="person-chip"><i class="avatar avatar-nia">N</i>Nia</span>';
  $('#action-2 .review-pill').textContent = '✓ Confirmed';
  $('#action-2 .review-pill').className = 'confirmed-pill';
  $('#action-2').classList.remove('needs-review');
  updateConfirmed();
  showToast('Nia assigned to the import-state task.');
});

function updateConfirmed() {
  const count = $$('.confirmed-pill').length;
  $('#confirmedCount').textContent = `${count} of 5`;
}
$('#reviewButton').addEventListener('click', () => {
  const next = $('.needs-review:not([hidden])');
  if (next) scrollToCard(next.id);
  else showToast('Everything visible in this view has been reviewed.');
});

const modal = $('#importModal');
function openImport() { lastFocused = document.activeElement; modal.hidden = false; $('#closeImport').focus(); }
function closeImport() { modal.hidden = true; $('#importStatus').textContent = ''; lastFocused?.focus(); }
$('#importButton').addEventListener('click', openImport);
$('#closeImport').addEventListener('click', closeImport);
modal.addEventListener('click', (event) => { if (event.target === modal) closeImport(); });
$('#fileInput').addEventListener('change', (event) => {
  const file = event.target.files[0];
  if (!file) return;
  $('#importStatus').textContent = `“${file.name}” queued locally. In this prototype, the current mock workspace stays visible.`;
  showToast('Local import simulated — no file was uploaded.');
});

$('#exportButton').addEventListener('click', () => {
  const handoff = `# Pricing & packaging working session\n\n## Confirmed decisions\n- Target small product teams for the beta.\n\n## Confirmed action items\n- [ ] Eli — Recruit 5 target users for prototype interviews. Due Jul 24.\n- [ ] Maya — Draft the confirmed-only handoff export. Due Jul 23.\n\nGenerated locally by Signal Notes prototype.`;
  const link = document.createElement('a');
  link.href = URL.createObjectURL(new Blob([handoff], { type: 'text/markdown' }));
  link.download = 'signal-notes-handoff.md';
  link.click();
  URL.revokeObjectURL(link.href);
  showToast('Confirmed-only handoff exported as Markdown.');
});
