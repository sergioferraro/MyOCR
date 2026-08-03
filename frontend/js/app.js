/* ── Local OCR — Frontend Controller (Sidebar + Split View) ──────
 * Sidebar: Impostazioni, File, Progresso, Log
 * Main area: sorgente (sinistra) ↔ risultato markdown (destra)
 * ──────────────────────────────────────────────────────────────── */

// ── DOM refs ─────────────────────────────────────────────────────
const $ = (sel) => document.querySelector(sel);

const serverUrlInput    = $('#serverUrl');
const modelSelect       = $('#modelSelect');
const btnRefreshModels  = $('#btnRefreshModels');
const dpiSelect         = $('#dpiSelect');
const forceVlmCheckbox  = $('#forceVlm');
const pageRangeInput    = $('#pageRangeInput');

const dropZone          = $('#dropZone');
const fileInput         = $('#fileInput');
const btnBrowse         = $('#btnBrowse');
const btnWebcam         = $('#btnWebcam');
const fileInfo          = $('#fileInfo');
const fileName          = $('#fileName');
const fileSize          = $('#fileSize');
const btnStart          = $('#btnStart');

// Preview (source pane)
const previewContainer  = $('#previewContainer');
const btnPrevPage       = $('#btnPrevPage');
const btnNextPage       = $('#btnNextPage');
const previewPageLabel  = $('#previewPageLabel');

// Result pane (zero-md)
const zeroMdResult      = $('#zeroMdResult');
const zeroMdScript      = $('#zeroMdScript');
const resultStatus      = $('#resultStatus');

// Progress & Log (sidebar)
const progressPanel     = $('#progressPanel');
const progressBarFill   = $('.progress-fill');
const progressText      = $('#progressText');
const logPanel          = $('#logPanel');
const logBox            = $('#logBox');

// Sidebar actions
const sidebarActions    = $('#sidebarActions');
const btnDownload       = $('#btnDownload');
const btnNewOcr         = $('#btnNewOcr');

// Per-page results
const pageResultsPanel  = $('#pageResultsPanel');
const pageResultsList   = $('#pageResultsList');

// Reprocess modal
const reprocessModal        = $('#reprocessModal');
const reprocessPageNum      = $('#reprocessPageNum');
const reprocessModelSelect  = $('#reprocessModelSelect');
const btnConfirmReprocess   = $('#btnConfirmReprocess');
const btnCloseReprocess     = $('#btnCloseReprocess');

// Webcam modals
const webcamModal       = $('#webcamModal');
const webcamVideo       = $('#webcamVideo');
const webcamCanvas      = $('#webcamCanvas');
const btnCapturePhoto   = $('#btnCapturePhoto');
const btnSwitchCamera   = $('#btnSwitchCamera');
const btnCloseWebcam    = $('#btnCloseWebcam');

// Add pages modal
const addPagesModal     = $('#addPagesModal');
const webcamPageCount   = $('#webcamPageCount');
const webcamThumbnails  = $('#webcamThumbnails');
const btnAddMorePages   = $('#btnAddMorePages');
const btnDoneCapturing  = $('#btnDoneCapturing');
const btnCloseAddPages  = $('#btnCloseAddPages');

// Rename modal
const renameModal       = $('#renameModal');
const renameInput       = $('#renameInput');
const btnConfirmRename  = $('#btnConfirmRename');
const btnCloseRename    = $('#btnCloseRename');

// ── State ────────────────────────────────────────────────────────
let selectedFile = null;
let currentJobId = null;
let eventSource  = null;

// Preview state
let previewThumbnails = [];
let previewPage = 0;
let previewTotal = 0;

// Webcam state
let webcamStream = null;
let webcamFacingMode = 'user';
let webcamCapturedPages = [];
let webcamSessionId = '';

// Per-page state
let pageResults = [];       // array of { page_num, markdown, model, method, status, error_msg }
let selectedPageNum = null; // which page's markdown is shown in result pane
let isViewingAll = true;    // true = merged view, false = single page view

// ── Page Selection Toggle ────────────────────────────────────────
function syncPageRangeInput() {
  const isCustom = document.querySelector('input[name="pageMode"]:checked').value === 'custom';
  if (isCustom) {
    show(pageRangeInput);
  } else {
    hide(pageRangeInput);
  }
}

document.querySelectorAll('input[name="pageMode"]').forEach((radio) => {
  radio.addEventListener('change', syncPageRangeInput);
});

// Sync initial state on page load
syncPageRangeInput();

function getPageSpec() {
  const mode = document.querySelector('input[name="pageMode"]:checked').value;
  if (mode === 'custom') {
    return pageRangeInput.value.trim();
  }
  return 'all';
}

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

function setResultStatus(text, type) {
  resultStatus.textContent = text;
  resultStatus.className = 'result-status ' + type;
  show(resultStatus);
}

function clearResultStatus() {
  hide(resultStatus);
}

// ── Render Markdown in result pane (via zero-md) ────────────────
function renderMarkdown(text) {
  // Set markdown content in the zero-md script tag
  zeroMdScript.textContent = text;
  show(zeroMdResult);
  // Trigger render
  zeroMdResult.render().catch(err => {
    console.error('zero-md render error:', err);
  });
}

function clearMarkdown() {
  // Clear content and hide zero-md
  zeroMdScript.textContent = '';
  hide(zeroMdResult);
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
    btnRefreshModels.textContent = '⟳';
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

// ── Webcam Capture (con anteprima live + multi-pagina) ──────────
function generateSessionId() {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  for (let i = 0; i < 8; i++) result += chars[Math.floor(Math.random() * chars.length)];
  return `webcam_${result}`;
}

function openWebcam() {
  if (webcamCapturedPages.length === 0) {
    webcamSessionId = generateSessionId();
  }

  btnWebcam.addEventListener('click', async () => {
    const mediaApiAvailable = navigator.mediaDevices && typeof navigator.mediaDevices.getUserMedia === 'function';
    if (!mediaApiAvailable) {
      alert("Errore: la webcam non è supportata in questo contesto.\n" +
            "Assicurati che il server sia raggiungibile via HTTPS o localhost (non IP).\n" +
            "Il browser richiede un contesto sicuro per accedere alla camera.");
      return;
    }

    try {
      if (webcamStream) {
        webcamStream.getTracks().forEach(track => track.stop());
        webcamStream = null;
      }

      show(webcamModal);

      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: webcamFacingMode }
      });

      webcamStream = stream;
      webcamVideo.srcObject = stream;
      webcamVideo.play();

    } catch (err) {
      console.error('Webcam error:', err);
      hide(webcamModal);

      let errorMsg = "Errore durante l'accesso alla webcam:\n";
      if (err.name === 'NotAllowedError') {
        errorMsg += 'Permesso negato. Assicurati di aver autorizzato l\'uso della camera.';
      } else if (err.name === 'NotFoundError') {
        errorMsg += 'Nessuna webcam rilevata sul dispositivo.';
      } else if (err.name === 'NotReadableError') {
        errorMsg += 'Impossibile accedere alla webcam. Potrebbe essere in uso.';
      } else if (err.name === 'SecurityError') {
        errorMsg += 'Errore di sicurezza: la webcam non è accessibile.';
      } else {
        errorMsg += err.message || 'Errore sconosciuto';
      }

      alert(errorMsg);
    }
  });
}

btnCapturePhoto.addEventListener('click', async () => {
  if (!webcamStream) return;

  webcamCanvas.width  = webcamVideo.videoWidth;
  webcamCanvas.height = webcamVideo.videoHeight;
  const ctx = webcamCanvas.getContext('2d');
  ctx.drawImage(webcamVideo, 0, 0, webcamCanvas.width, webcamCanvas.height);

  const blob = await new Promise(resolve => {
    webcamCanvas.toBlob(resolve, 'image/jpeg', 0.95);
  });

  const dataUrl = webcamCanvas.toDataURL('image/jpeg', 0.9);

  const pageNum = webcamCapturedPages.length + 1;
  webcamCapturedPages.push({ blob, dataUrl, pageNum });

  webcamStream.getTracks().forEach(track => track.stop());
  webcamStream = null;
  webcamVideo.srcObject = null;
  hide(webcamModal);

  showAddPagesModal();
});

function showAddPagesModal() {
  const total = webcamCapturedPages.length;
  webcamPageCount.textContent = total;

  webcamThumbnails.innerHTML = '';
  webcamCapturedPages.forEach((page) => {
    const img = document.createElement('img');
    img.src = page.dataUrl;
    img.alt = `Pagina ${page.pageNum}`;
    webcamThumbnails.appendChild(img);
  });

  show(addPagesModal);
}

btnAddMorePages.addEventListener('click', async () => {
  hide(addPagesModal);

  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: webcamFacingMode }
    });
    webcamStream = stream;
    webcamVideo.srcObject = stream;
    webcamVideo.play();
    show(webcamModal);
  } catch (err) {
    console.error('Webcam re-open error:', err);
    alert('Impossibile riaprire la webcam.');
  }
});

btnDoneCapturing.addEventListener('click', () => {
  hide(addPagesModal);
  showRenameModal();
});

btnCloseAddPages.addEventListener('click', () => {
  hide(addPagesModal);
});

function showRenameModal() {
  renameInput.value = webcamSessionId;
  show(renameModal);
  setTimeout(() => { renameInput.focus(); renameInput.select(); }, 100);
}

btnConfirmRename.addEventListener('click', async () => {
  const outputName = renameInput.value.trim().replace(/[^a-zA-Z0-9àèéìòùÀÈÉÌÒÙ_\- \s]/g, '_');
  if (!outputName) {
    alert('Inserisci un nome per il file.');
    return;
  }

  hide(renameModal);
  await buildWebcamPdf(outputName);
});

btnCloseRename.addEventListener('click', () => {
  hide(renameModal);
});

async function buildWebcamPdf(outputName) {
  try {
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF();

    for (let i = 0; i < webcamCapturedPages.length; i++) {
      const page = webcamCapturedPages[i];
      const img = new Image();
      img.src = page.dataUrl;

      await new Promise((resolve, reject) => {
        img.onload = () => {
          if (i > 0) doc.addPage();

          const pageWidth = doc.internal.pageSize.getWidth();
          const pageHeight = doc.internal.pageSize.getHeight();
          const imgRatio = img.width / img.height;
          const pageRatio = pageWidth / pageHeight;

          let drawW, drawH;
          if (imgRatio > pageRatio) {
            drawW = pageWidth;
            drawH = pageWidth / imgRatio;
          } else {
            drawH = pageHeight;
            drawW = pageHeight * imgRatio;
          }

          const offsetX = (pageWidth - drawW) / 2;
          const offsetY = (pageHeight - drawH) / 2;

          doc.addImage(img, 'JPEG', offsetX, offsetY, drawW, drawH);
          resolve();
        };
        img.onerror = reject;
      });
    }

    const pdfBlob = doc.output('blob');
    const pdfFile = new File([pdfBlob], `${outputName}.pdf`, { type: 'application/pdf' });

    webcamCapturedPages = [];
    handleFile(pdfFile);

  } catch (err) {
    console.error('PDF build error:', err);
    alert('Errore nella generazione del PDF dalle immagini catturate.');
    if (webcamCapturedPages.length > 0) {
      const first = webcamCapturedPages[0];
      const fallbackFile = new File([first.blob], `${outputName}.jpg`, { type: 'image/jpeg' });
      webcamCapturedPages = [];
      handleFile(fallbackFile);
    }
  }
}

btnSwitchCamera.addEventListener('click', async () => {
  if (!webcamStream) return;

  try {
    webcamStream.getTracks().forEach(track => track.stop());
    webcamFacingMode = webcamFacingMode === 'user' ? 'environment' : 'user';

    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: webcamFacingMode }
    });

    webcamStream = stream;
    webcamVideo.srcObject = stream;
    webcamVideo.play();

  } catch (err) {
    console.error('Switch camera error:', err);
    alert('Impossibile cambiare camera.');
  }
});

function closeWebcamModal() {
  if (webcamStream) {
    webcamStream.getTracks().forEach(track => track.stop());
    webcamStream = null;
  }
  webcamVideo.srcObject = null;
  hide(webcamModal);
}

btnCloseWebcam.addEventListener('click', closeWebcamModal);
webcamModal.querySelector('.modal-overlay').addEventListener('click', closeWebcamModal);
addPagesModal.querySelector('.modal-overlay').addEventListener('click', () => hide(addPagesModal));
renameModal.querySelector('.modal-overlay').addEventListener('click', () => hide(renameModal));

openWebcam();

// ── Handle File (common) ─────────────────────────────────────────
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

  // Load preview in source pane
  loadPreview(file);
}

// ── File Preview (Source Pane) ───────────────────────────────────
async function loadPreview(file) {
  previewThumbnails = [];
  previewPage = 0;
  previewTotal = 0;

  const formData = new FormData();
  formData.append('file', file);

  try {
    const res = await fetch('/api/preview', { method: 'POST', body: formData });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    previewThumbnails = data.thumbnails || [];
    previewTotal = previewThumbnails.length;
    previewPage = 0;

    // Show/hide navigation
    if (previewTotal > 1) {
      show(btnPrevPage);
      show(btnNextPage);
      show(previewPageLabel);
    } else {
      hide(btnPrevPage);
      hide(btnNextPage);
      hide(previewPageLabel);
    }

    showPreviewPage();
  } catch (err) {
    console.error('Preview error:', err);
  }
}

function showPreviewPage() {
  const src = previewThumbnails[previewPage];
  previewContainer.innerHTML = `<img src="${src}" alt="Page ${previewPage + 1}">`;
  if (previewTotal > 1) {
    previewPageLabel.textContent = `${previewPage + 1} / ${previewTotal}`;
  }
  btnPrevPage.disabled = previewPage === 0;
  btnNextPage.disabled = previewPage === previewTotal - 1;
}

btnPrevPage.addEventListener('click', () => {
  if (previewPage > 0) { previewPage--; showPreviewPage(); }
});

btnNextPage.addEventListener('click', () => {
  if (previewPage < previewTotal - 1) { previewPage++; showPreviewPage(); }
});

// ── Start OCR ────────────────────────────────────────────────────
btnStart.addEventListener('click', async () => {
  if (!selectedFile) return;

  const url = serverUrlInput.value.trim();
  const model = modelSelect.value;
  const dpi = parseInt(dpiSelect.value, 10);
  const forceVlm = forceVlmCheckbox.checked;
  const pageSpec = getPageSpec();

  if (!model) { alert('Seleziona un modello.'); return; }
  if (!url)   { alert('Inserisci l\'URL del server.'); return; }
  if (pageSpec !== 'all' && !pageSpec) { alert('Inserisci le pagine da processare.'); return; }

  // Reset UI
  btnStart.disabled = true;
  btnStart.textContent = '⏳ Elaborazione...';
  clearLogs();
  clearMarkdown();
  show(progressPanel);
  show(logPanel);
  hide(sidebarActions);
  setProgress(0, 'Invio file...');
  setResultStatus('In elaborazione...', 'processing');

  const formData = new FormData();
  formData.append('file', selectedFile);
  formData.append('model', model);
  formData.append('url', url);
  formData.append('dpi', dpi.toString());
  formData.append('force_vlm', forceVlm ? 'true' : 'false');
  formData.append('page_spec', pageSpec);

  try {
    const res = await fetch('/api/ocr', { method: 'POST', body: formData });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    currentJobId = data.job_id;
    addLog(`Job avviato: ${currentJobId}`, 'info');
    setProgress(5, 'Connessione al server VLM...');

    connectSSE(currentJobId);
  } catch (err) {
    addLog(`Errore: ${err.message}`, 'error');
    btnStart.disabled = false;
    btnStart.textContent = '🚀 Avvia OCR';
    hide(progressPanel);
    clearResultStatus();
  }
});

// ── SSE Streaming ────────────────────────────────────────────────
function connectSSE(jobId) {
  if (eventSource) eventSource.close();

  eventSource = new EventSource(`/api/stream/${jobId}`);

  eventSource.onmessage = (e) => {
    try {
      const data = JSON.parse(e.data);

      const pct = data.total_pages > 0
        ? Math.round((data.processed_pages / data.total_pages) * 100)
        : 0;
      setProgress(pct, `${data.processed_pages}/${data.total_pages} pagine elaborate`);

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
    pollStatus(jobId);
  };
}

// ── Fallback polling ─────────────────────────────────────────────
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
async function onJobDone(data) {
  btnStart.disabled = false;
  btnStart.textContent = '🚀 Avvia OCR';
  setProgress(100, 'Completato!');

  setResultStatus(`✅ ${data.processed_pages} pagine elaborate`, 'success');

  // Fetch per-page results
  await fetchPageResults();

  // Show page results list in sidebar
  renderPageResultsList();
  show(pageResultsPanel);

  // Show merged markdown by default
  isViewingAll = true;
  selectedPageNum = null;
  await renderMergedMarkdown();

  // Show action buttons in sidebar
  show(sidebarActions);
}

function onJobError(data) {
  btnStart.disabled = false;
  btnStart.textContent = '🚀 Avvia OCR';
  setProgress(0, 'Errore');

  setResultStatus(`❌ ${data.message || 'Errore sconosciuto'}`, 'error');
}

// ── Fetch Per-Page Results ───────────────────────────────────────
async function fetchPageResults() {
  try {
    const res = await fetch(`/api/pages/${currentJobId}`);
    if (res.ok) {
      const data = await res.json();
      pageResults = data.pages || [];
    }
  } catch (err) {
    console.error('Failed to fetch page results:', err);
    pageResults = [];
  }
}

// ── Render Per-Page Results List ─────────────────────────────────
function renderPageResultsList() {
  pageResultsList.innerHTML = '';

  // "View All" button
  const allBtn = document.createElement('div');
  allBtn.className = 'page-result-item' + (isViewingAll ? ' active' : '');
  allBtn.innerHTML = `
    <span class="page-num">📄</span>
    <span class="page-meta">Visualizza tutto (merge)</span>
    <span class="page-status-dot done"></span>
  `;
  allBtn.addEventListener('click', async () => {
    isViewingAll = true;
    selectedPageNum = null;
    renderPageResultsList(); // update active state
    await renderMergedMarkdown();
  });
  pageResultsList.appendChild(allBtn);

  // Individual page items
  pageResults.forEach((pr) => {
    const item = document.createElement('div');
    item.className = 'page-result-item' + (selectedPageNum === pr.page_num ? ' active' : '');

    const methodLabel = pr.method === 'vlm' ? 'VLM' : pr.method === 'text_extract' ? 'TXT' : pr.method === 'skipped' ? '—' : '?';
    const modelLabel = pr.model && pr.model !== '(text-extract)' ? pr.model.substring(0, 30) : '';

    item.innerHTML = `
      <span class="page-num">${pr.page_num}</span>
      <span class="page-meta">${methodLabel}${modelLabel ? ' · ' + modelLabel : ''}</span>
      <span class="page-status-dot ${pr.status}"></span>
      ${pr.status === 'done' ? `<button class="btn-reprocess" data-page="${pr.page_num}">🔄</button>` : ''}
    `;

    // Click on the row → show that page's markdown
    item.addEventListener('click', async (e) => {
      if (e.target.classList.contains('btn-reprocess')) return; // let the button handle itself
      isViewingAll = false;
      selectedPageNum = pr.page_num;
      renderPageResultsList(); // update active state
      renderMarkdown(pr.markdown || '<!-- pagina non processata -->');
    });

    // Reprocess button
    const reprocessBtn = item.querySelector('.btn-reprocess');
    if (reprocessBtn) {
      reprocessBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        openReprocessModal(pr.page_num);
      });
    }

    pageResultsList.appendChild(item);
  });
}

// ── Render Merged Markdown ──────────────────────────────────────
async function renderMergedMarkdown() {
  try {
    const res = await fetch(`/api/download/${currentJobId}`);
    if (res.ok) {
      const text = await res.text();
      renderMarkdown(text);
    }
  } catch (err) {
    console.error('Failed to fetch merged result:', err);
  }
}

// ── Reprocess Modal ─────────────────────────────────────────────
let reprocessTargetPage = null;

function openReprocessModal(pageNum) {
  reprocessTargetPage = pageNum;
  reprocessPageNum.textContent = `#${pageNum}`;

  // Populate model select with current models
  const currentModels = Array.from(modelSelect.options).map(o => o.value).filter(v => v);
  reprocessModelSelect.innerHTML = '<option value="">— Seleziona modello —</option>';
  currentModels.forEach(m => {
    const opt = document.createElement('option');
    opt.value = m;
    opt.textContent = m;
    reprocessModelSelect.appendChild(opt);
  });

  show(reprocessModal);
}

btnConfirmReprocess.addEventListener('click', async () => {
  const model = reprocessModelSelect.value;
  if (!model) { alert('Seleziona un modello.'); return; }

  btnConfirmReprocess.disabled = true;
  btnConfirmReprocess.textContent = '⏳ Riprocessando...';

  try {
    const formData = new FormData();
    formData.append('page_num', String(reprocessTargetPage));
    formData.append('model', model);
    formData.append('url', serverUrlInput.value.trim());
    formData.append('dpi', dpiSelect.value);

    const res = await fetch(`/api/reprocess/${currentJobId}`, { method: 'POST', body: formData });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.detail || 'Reprocess failed');
    }

    // Refresh page results
    await fetchPageResults();
    renderPageResultsList();

    // Re-render the current view
    if (isViewingAll) {
      await renderMergedMarkdown();
    } else {
      const pr = pageResults.find(p => p.page_num === selectedPageNum);
      if (pr) renderMarkdown(pr.markdown);
    }

    hide(reprocessModal);
  } catch (err) {
    alert(`Errore riprocessamento: ${err.message}`);
  } finally {
    btnConfirmReprocess.disabled = false;
    btnConfirmReprocess.textContent = '🔄 Riprocessa';
  }
});

btnCloseReprocess.addEventListener('click', () => hide(reprocessModal));
reprocessModal.querySelector('.modal-overlay').addEventListener('click', () => hide(reprocessModal));

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

    // Derive filename from the original file name
    const stem = selectedFile ? selectedFile.name.replace(/\.[^.]+$/, '') : `ocr_${currentJobId}`;
    a.download = `${stem}.md`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  } catch (err) {
    alert(`Errore download: ${err.message}`);
  }
});

// ── Reset for new OCR ────────────────────────────────────────────
btnNewOcr.addEventListener('click', () => {
  selectedFile = null;
  currentJobId = null;
  webcamCapturedPages = [];
  webcamSessionId = '';
  pageResults = [];
  selectedPageNum = null;
  isViewingAll = true;
  hide(fileInfo);
  hide(btnStart);
  hide(progressPanel);
  hide(logPanel);
  hide(pageResultsPanel);
  hide(sidebarActions);
  clearLogs();
  clearMarkdown();
  clearResultStatus();
  setProgress(0, '');
  fileInput.value = '';

  // Reset source pane
  previewContainer.innerHTML = `
    <div class="preview-placeholder">
      <span class="placeholder-icon">📄</span>
      <p>Nessun file caricato</p>
    </div>`;
  hide(btnPrevPage);
  hide(btnNextPage);
  hide(previewPageLabel);
});

// ── Init ─────────────────────────────────────────────────────────
refreshModels();
