const dialog = document.querySelector('#image-dialog');
document.querySelectorAll('[data-enlarge]').forEach(button => button.addEventListener('click', () => {
  dialog.querySelector('img').src = button.dataset.enlarge;
  dialog.querySelector('img').alt = button.querySelector('img').alt;
  dialog.showModal();
}));
document.querySelector('#close-image').addEventListener('click', () => dialog.close());
dialog.addEventListener('click', event => { if (event.target === dialog) dialog.close(); });
document.querySelector('#copy-citation').addEventListener('click', async event => {
  const button = event.currentTarget;
  try { await navigator.clipboard.writeText(document.querySelector('#bibtex').textContent); button.textContent = 'Copied'; }
  catch { const selection = window.getSelection(); const range = document.createRange(); range.selectNodeContents(document.querySelector('#bibtex')); selection.removeAllRanges(); selection.addRange(range); button.textContent = 'Select & copy'; }
});
