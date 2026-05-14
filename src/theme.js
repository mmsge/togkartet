const themeToggle = document.createElement('button');
themeToggle.id = 'theme-toggle';
themeToggle.textContent = '◐';
themeToggle.title = 'Bytt mellom lyst og mørkt';
themeToggle.addEventListener('click', () => {
  document.body.classList.toggle('dark');
});
document.body.appendChild(themeToggle);
