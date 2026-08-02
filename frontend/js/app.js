/* ── Local OCR — Frontend Controller ─────────────────────────────
 * Handles file upload, OCR job lifecycle, SSE progress streaming,
 * result download, and Markdown preview.
 * ──────────────────────────────────────────────────────────────── */

// ── DOM refs ─────────────────────────────────────────────────────
const $ = (sel) => document.querySelector(sel);

const serverUrlInput    = $('#serverUrl');
const modelSelect       = $('#modelSelect');
const btnRefreshModels  = $('#btnRefreshModels');
const dpiSelect         = $('#dpiSelect');
const forceVlmCheckbox  = $('#forceVlm');

const dropZone          = $('#dropZone');
const fileInput         = $('#fileInput');
const btnBrowse         = $('#btnBrowse');
const fileInfo          = $('#fileInfo');
const fileName          = $('#fileName');
const fileSize          = $('#fileSize');
const btnStart          = $('#btnStart');

const progressPanel     = $('#progressPanel');
const progressBarFill   = $('.progress-fill');
const progressText      = $('#progressText');

const logPanel          = $('#logPanel');
const logBox            = $('#logBox');

const resultPanel       = $('#resultPanel');
const resultMessage     = $('#resultMessage');
const btnDownload       = $('#btnDownload');
const btnPreview        = $('#btnPreview');
const btnNewOcr         = $('#btnNewOcr');

const previewModal      = $('#previewModal');
const previewBody       = $('#previewBody');
const btnCloseModal     = $('#btnCloseModal');

// ── State ────────────────────────────────────────────────────────
let selectedFile = null;
let currentJobId = null;
let eventSource  = null;

// ── Helpers ──────────────────────────────────────────────────────
function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

function show(el)    { el.classList.remove('hidden'); }
function hide(el)    { el.classList.add('hidden'); }

function addLog(text, cls = '') {
  const line = document.createElement('div');
  line.className = 'log-line' + (cls ? ' ' + cls : '');
  line.textContent = text;
  logBox.appendChild(line);
  logBox.scrollTop = logBox.scrollHeight;
}

function clearLogs() {
  logBox.innerHTML = '';
  window._ocrLogsShown = 0;
}

function setProgress(pct, text) {
  progressBarFill.style.width = pct + '%';
  progressText.textContent = text;
}

// ── Refresh Models ───────────────────────────────────────────────
async function refreshModels() {
  const url = serverUrlInput.value.trim();
  btnRefreshModels.disabled = true;
  btnRefreshModels.textContent = '⟳ ...';

  try {
    const res = await fetch(`/api/models?url=${encodeURIComponent(url)}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    modelSelect.innerHTML = '';
    if (data.models.length === 0) {
      modelSelect.innerHTML = '<option value="">— Nessun modello —</option>';
    } else {
      data.models.forEach((m) => {
        const opt = document.createElement('option');
        opt.value = m;
        opt.textContent = m;
        modelSelect.appendChild(opt);
      });
    }
  } catch (err) {
    alert(`Errore caricamento modelli: ${err.message}`);
  } finally {
    btnRefreshModels.disabled = false;
    btnRefreshModels.textContent = '⟳ Modelli';
  }
}

btnRefreshModels.addEventListener('click', refreshModels);

// ── File Handling ────────────────────────────────────────────────
btnBrowse.addEventListener('click', (e) => {
  e.stopPropagation();
  fileInput.click();
});

dropZone.addEventListener('click', () => fileInput.click());

dropZone.addEventListener('dragover', (e) => {
  e.preventDefault();
  dropZone.classList.add('dragover');
});

dropZone.addEventListener('dragleave', () => {
  dropZone.classList.remove('dragover');
});

dropZone.addEventListener('drop', (e) => {
  e.preventDefault();
  dropZone.classList.remove('dragover');
  if (e.dataTransfer.files.length) {
    handleFile(e.dataTransfer.files[0]);
  }
});

fileInput.addEventListener('change', () => {
  if (fileInput.files.length) {
    handleFile(fileInput.files[0]);
  }
});

function handleFile(file) {
  const allowed = ['.pdf', '.png', '.jpg', '.jpeg', '.webp'];
  const ext = '.' + file.name.split('.').pop().toLowerCase();

  if (!allowed.includes(ext)) {
    alert(`Formato non supportato: ${ext}`);
    return;
  }

  selectedFile = file;
  fileName.textContent = file.name;
  fileSize.textContent = formatBytes(file.size);
  show(fileInfo);
  show(btnStart);
}

// ── Start OCR ────────────────────────────────────────────────────
btnStart.addEventListener('click', async () => {
  if (!selectedFile) return;

  const url = serverUrlInput.value.trim();
  const model = modelSelect.value;
  const dpi = parseInt(dpiSelect.value, 10);
  const forceVlm = forceVlmCheckbox.checked;

  if (!model) { alert('Seleziona un modello.'); return; }
  if (!url)   { alert('Inserisci l\'URL del server.'); return; }

  // Reset UI
  btnStart.disabled = true;
  btnStart.textContent = '⏳ Elaborazione...';
  clearLogs();
  hide(resultPanel);
  show(progressPanel);
  show(logPanel);
  setProgress(0, 'Invio file...');

  const formData = new FormData();
  formData.append('file', selectedFile);
  formData.append('model', model);
  formData.append('url', url);
  formData.append('dpi', dpi.toString());
  formData.append('force_vlm', forceVlm ? 'true' : 'false');

  try {
    const res = await fetch('/api/ocr', { method: 'POST', body: formData });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    currentJobId = data.job_id;
    addLog(`Job avviato: ${currentJobId}`, 'info');
    setProgress(5, 'Connessione al server VLM...');

    // Start SSE stream
    connectSSE(currentJobId);
  } catch (err) {
    addLog(`Errore: ${err.message}`, 'error');
    btnStart.disabled = false;
    btnStart.textContent = '🚀 Avvia OCR';
    hide(progressPanel);
  }
});

// ── SSE Streaming ────────────────────────────────────────────────
function connectSSE(jobId) {
  if (eventSource) eventSource.close();

  eventSource = new EventSource(`/api/stream/${jobId}`);

  eventSource.onmessage = (e) => {
    try {
      const data = JSON.parse(e.data);

      // Update progress
      const pct = data.total_pages > 0
        ? Math.round((data.processed_pages / data.total_pages) * 100)
        : 0;
      setProgress(pct, `${data.processed_pages}/${data.total_pages} pagine elaborate`);

      // Append new log lines (track how many we've already shown)
      const newLogs = data.logs || [];
      if (typeof window._ocrLogsShown === 'undefined') {
        window._ocrLogsShown = 0;
      }
      const startIdx = window._ocrLogsShown;
      for (let i = startIdx; i < newLogs.length; i++) {
        let cls = '';
        if (newLogs[i].includes('[Error]')) cls = 'error';
        else if (newLogs[i].includes('[Success]')) cls = 'success';
        else if (newLogs[i].includes('[Info]')) cls = 'info';
        addLog(newLogs[i], cls);
      }
      window._ocrLogsShown = newLogs.length;

      // Check final status
      if (data.status === 'done') {
        eventSource.close();
        eventSource = null;
        onJobDone(data);
      } else if (data.status === 'error') {
        eventSource.close();
        eventSource = null;
        onJobError(data);
      }
    } catch {
      // Ignore parse errors
    }
  };

  eventSource.onerror = () => {
    eventSource.close();
    eventSource = null;
    // Fallback: poll status
    pollStatus(jobId);
  };
}

// ── Fallback polling (if SSE disconnects) ────────────────────────
async function pollStatus(jobId) {
  const interval = setInterval(async () => {
    try {
      const res = await fetch(`/api/status/${jobId}`);
      const data = await res.json();

      const pct = data.total_pages > 0
        ? Math.round((data.processed_pages / data.total_pages) * 100)
        : 0;
      setProgress(pct, `${data.processed_pages}/${data.total_pages} pagine`);

      const lastMsg = (data.logs || []).pop();
      if (lastMsg) addLog(lastMsg);

      if (data.status === 'done') {
        clearInterval(interval);
        onJobDone(data);
      } else if (data.status === 'error') {
        clearInterval(interval);
        onJobError(data);
      }
    } catch {
      // keep polling
    }
  }, 1000);
}

// ── Job Complete ─────────────────────────────────────────────────
function onJobDone(data) {
  btnStart.disabled = false;
  btnStart.textContent = '🚀 Avvia OCR';
  setProgress(100, 'Completato!');

  resultMessage.textContent = `✅ OCR completato — ${data.processed_pages} pagine elaborate`;
  show(resultPanel);
}

function onJobError(data) {
  btnStart.disabled = false;
  btnStart.textContent = '🚀 Avvia OCR';
  setProgress(0, 'Errore');

  resultMessage.textContent = `❌ Errore: ${data.message || 'Sconosciuto'}`;
  resultMessage.style.color = 'var(--error)';
  show(resultPanel);
}

// ── Download Result ──────────────────────────────────────────────
btnDownload.addEventListener('click', async () => {
  if (!currentJobId) return;

  try {
    const res = await fetch(`/api/download/${currentJobId}`);
    if (!res.ok) {
      const err = await res.json().catch(() => ({ detail: `HTTP ${res.status}` }));
      alert(`Download fallito: ${err.detail || 'Errore sconosciuto'}`);
      return;
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${currentJobId}_extracted.md`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  } catch (err) {
    alert(`Errore download: ${err.message}`);
  }
});

// ── Markdown Preview ─────────────────────────────────────────────
btnPreview.addEventListener('click', async () => {
  if (!currentJobId) return;

  try {
    const res = await fetch(`/api/download/${currentJobId}`);
    const text = await res.text();
    previewBody.innerHTML = typeof marked !== 'undefined'
      ? marked.parse(text)
      : `<pre style="white-space:pre-wrap">${text}</pre>`;
    show(previewModal);
  } catch (err) {
    alert(`Errore caricamento anteprima: ${err.message}`);
  }
});

btnCloseModal.addEventListener('click', () => hide(previewModal));
previewModal.querySelector('.modal-overlay').addEventListener('click', () => hide(previewModal));

// ── Reset for new OCR ────────────────────────────────────────────
btnNewOcr.addEventListener('click', () => {
  selectedFile = null;
  currentJobId = null;
  hide(fileInfo);
  hide(btnStart);
  hide(progressPanel);
  hide(logPanel);
  hide(resultPanel);
  clearLogs();
  setProgress(0, '');
  resultMessage.style.color = '';
  fileInput.value = '';
});

// ── Init ─────────────────────────────────────────────────────────
// Auto-refresh models on load
refreshModels();
