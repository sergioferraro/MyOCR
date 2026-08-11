/* ── Local OCR — Frontend Controller (Sidebar + Split View) ──────
 * Sidebar: Setting, File, Progress, Log
 * Main area: source (left) ↔ result markdown (right)
 * ──────────────────────────────────────────────────────────────── */

// ── DOM refs ─────────────────────────────────────────────────────
const $ = (sel) => document.querySelector(sel);

const serverUrlInput    = $('#serverUrl');
const modelSelect       = $('#modelSelect');
const btnRefreshModels  = $('#btnRefreshModels');
const dpiSelect         = $('#dpiSelect');
const forceVlmCheckbox  = $('#forceVlm');
const groundingToggle   = $('#groundingToggle');
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

// Post-processing buttons
const btnCompact        = $('#btnCompact');
const btnHyphenation    = $('#btnHyphenation');
const btnCompactAll     = $('#btnCompactAll');
const btnHyphenationAll = $('#btnHyphenationAll');
const postProcessingPanel = $('#postProcessingPanel');

// Progress & Log (sidebar)
const progressPanel     = $('#progressPanel');
const progressBarFill   = $('.progress-fill');
const progressText      = $('#progressText');
const btnStop           = $('#btnStop');
const btnSaveConfig     = $('#btnSaveConfig');
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

// Settings modal
const settingsModal     = $('#settingsModal');
const btnOpenSettings   = $('#btnOpenSettings');
const btnCloseSettings  = $('#btnCloseSettings');

// Rename modal
const renameModal       = $('#renameModal');
const renameInput       = $('#renameInput');
const btnConfirmRename  = $('#btnConfirmRename');
const btnCloseRename    = $('#btnCloseRename');

// ── Settings Modal ─────────────────────────────────────────────
btnOpenSettings.addEventListener('click', () => show(settingsModal));
btnCloseSettings.addEventListener('click', () => hide(settingsModal));
settingsModal.querySelector('.modal-overlay').addEventListener('click', () => hide(settingsModal));

// Close settings modal on Escape key (only when no input is focused)
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !settingsModal.classList.contains('hidden')) {
    if (e.target.tagName !== 'INPUT' && e.target.tagName !== 'SELECT') {
      hide(settingsModal);
    }
  }
});

// ── State ────────────────────────────────────────────────────────
let selectedFile = null;
let currentJobId = null;
let eventSource  = null;
let groundingEnabled = false;       // toggle grounding per job corrente
let groundingImageCache = {};       // { "IMG_1.png": dataUri } — cache immagini caricate

// Preview state
let previewThumbnails = [];    // data-URI thumbnails (initial batch)
let previewPage = 0;          // 0-based current page
let previewTotal = 0;         // total pages in the document
let previewFileName = '';     // filename for lazy-loading
let previewLoadedCount = 0;   // how many thumbnails we've loaded so far
let previewLoadingPage = null; // page currently being lazy-loaded (debounce)

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
  previewLoadedCount = 0;
  previewFileName = file.name;

  const formData = new FormData();
  formData.append('file', file);

  try {
    const res = await fetch('/api/preview', { method: 'POST', body: formData });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    previewThumbnails = data.thumbnails || [];
    previewTotal = data.total_pages || previewThumbnails.length;
    previewLoadedCount = previewThumbnails.length;
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

// ── Lazy-load a single page thumbnail ──────────────────────────
async function loadPageThumbnail(pageNum1based) {
  // Fetch a single page thumbnail from the server on-demand.
  if (!previewFileName) return null;
  try {
    const url = `/api/pdf-page?filename=${encodeURIComponent(previewFileName)}&page_num=${pageNum1based}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    return data.data_uri;
  } catch (err) {
    console.error(`Failed to load page ${pageNum1based}:`, err);
    return null;
  }
}

// ── Ensure thumbnail is loaded (lazy load if needed) ────────────
async function ensureThumbnailLoaded(idx) {
  if (idx < previewThumbnails.length && previewThumbnails[idx]) {
    return previewThumbnails[idx];
  }
  // Need to lazy-load
  const pageNum1based = idx + 1;
  const src = await loadPageThumbnail(pageNum1based);
  if (src) {
    // Extend array if needed and store
    while (previewThumbnails.length <= idx) {
      previewThumbnails.push(null);
    }
    previewThumbnails[idx] = src;
    previewLoadedCount = Math.max(previewLoadedCount, idx + 1);
  }
  return src;
}

function showPreviewPage(silent = false) {
  // Show the preview for the current page index.
  // If silent=true, don't update sidebar/markdown sync (used during internal updates).
  const pageNum1based = previewPage + 1;
  previewContainer.innerHTML = `
    <div class="preview-loading" style="display:flex;align-items:center;justify-content:center;color:var(--text-muted);font-size:0.85rem;">
      <span class="loading-spinner"></span> Caricamento pagina ${pageNum1based}...
    </div>`;

  // Async load then render
  (async () => {
    const src = await ensureThumbnailLoaded(previewPage);
    if (src) {
      previewContainer.innerHTML = `<img src="${src}" alt="Page ${pageNum1based}" style="max-width:100%;max-height:100%;object-fit:contain;">`;
    } else {
      previewContainer.innerHTML = `
        <div class="preview-placeholder">
          <span class="placeholder-icon">⚠️</span>
          <p>Impossibile caricare la pagina ${pageNum1based}</p>
        </div>`;
    }
    if (previewTotal > 1) {
      previewPageLabel.textContent = `${pageNum1based} / ${previewTotal}`;
    }
    btnPrevPage.disabled = previewPage === 0;
    btnNextPage.disabled = previewPage === previewTotal - 1;

    // Sync sidebar + markdown (only on user navigation)
    if (!silent) {
      syncFromPreview();
    }
  })();
}

// ── Sync: Preview → Sidebar + Markdown ─────────────────────────
async function syncFromPreview() {
  const pageNum1based = previewPage + 1;
  // Highlight matching page in sidebar
  const items = pageResultsList.querySelectorAll('.page-result-item');
  items.forEach((item, idx) => {
    if (idx === 0) return; // skip "View All" button
    const pageItemNum = parseInt(item.querySelector('.page-num')?.textContent || '0', 10);
    if (pageItemNum === pageNum1based && !isViewingAll) {
      item.classList.add('active');
    } else {
      item.classList.remove('active');
    }
  });
  // Update markdown for this page
  const pr = pageResults.find(p => p.page_num === pageNum1based);
  if (pr && !isViewingAll) {
    selectedPageNum = pageNum1based;
    let md = pr.markdown || '<!-- pagina non processata -->';
    if (groundingEnabled && currentJobId) {
      md = await resolveGroundingImages(md, currentJobId, pr.page_num);
    }
    renderMarkdown(md);
  }
}

// ── Sync: Sidebar → Preview + Markdown ─────────────────────────
function syncFromSidebar(pageNum1based) {
  const idx = pageNum1based - 1;
  if (idx >= 0 && idx < previewTotal) {
    // Update state first
    isViewingAll = false;
    selectedPageNum = pageNum1based;
    previewPage = idx;
    
    // Show preview page with silent=false so it updates the sidebar list
    showPreviewPage(false);
  }
}

btnPrevPage.addEventListener('click', () => {
  if (previewPage > 0) { previewPage--; showPreviewPage(); }
});

btnNextPage.addEventListener('click', () => {
  if (previewPage < previewTotal - 1) { previewPage++; showPreviewPage(); }
});

// ── Keyboard Navigation ─────────────────────────────────────────
document.addEventListener('keydown', (e) => {
  // Only navigate when a PDF is loaded and not typing in an input
  if (previewTotal <= 1) return;
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') return;

  if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
    e.preventDefault();
    if (previewPage > 0) { previewPage--; showPreviewPage(); }
  } else if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
    e.preventDefault();
    if (previewPage < previewTotal - 1) { previewPage++; showPreviewPage(); }
  }
});

// ── Start OCR ────────────────────────────────────────────────────
btnStart.addEventListener('click', async () => {
  if (!selectedFile) return;

  const url = serverUrlInput.value.trim();
  const model = modelSelect.value;
  const dpi = parseInt(dpiSelect.value, 10);
  const forceVlm = forceVlmCheckbox.checked;
  const grounding = groundingToggle.checked;
  const pageSpec = getPageSpec();

  if (!model) { alert('Select a model.'); return; }
  if (!url)   { alert('Select URL.'); return; }
  if (pageSpec !== 'all' && !pageSpec) { alert('Enter the pages to be processed.'); return; }

  // Reset UI
  btnStart.disabled = true;
  btnStart.textContent = '⏳ Processing...';
  clearLogs();
  clearMarkdown();
  show(progressPanel);
  show(btnStop);
  show(logPanel);
  hide(sidebarActions);
  setProgress(0, 'Invio file...');
  setResultStatus('Processing...', 'processing');

  const formData = new FormData();
  formData.append('file', selectedFile);
  formData.append('model', model);
  formData.append('url', url);
  formData.append('dpi', dpi.toString());
  formData.append('force_vlm', forceVlm ? 'true' : 'false');
  formData.append('grounding', grounding ? 'true' : 'false');
  formData.append('page_spec', pageSpec);

  try {
    const res = await fetch('/api/ocr', { method: 'POST', body: formData });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    currentJobId = data.job_id;
    addLog(`Job avviato: ${currentJobId}`, 'info');
    setProgress(5, 'Connecting to VLM server...');

    connectSSE(currentJobId);
  } catch (err) {
    addLog(`Errore: ${err.message}`, 'error');
    btnStart.disabled = false;
    btnStart.textContent = '🚀 Start OCR';
    hide(progressPanel);
    hide(btnStop);
    clearResultStatus();
  }
});

// ── Stop OCR ─────────────────────────────────────────────────────
btnStop.addEventListener('click', async () => {
  if (!currentJobId) return;

  btnStop.disabled = true;
  btnStop.textContent = '⏳ Stopping...';

  try {
    const res = await fetch(`/api/cancel/${currentJobId}`, { method: 'POST' });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      addLog(`Cancel error: ${err.detail || 'Unknown'}`, 'error');
    } else {
      addLog('[Info] Stop requested, waiting for current page to finish...', 'info');
    }
  } catch (err) {
    addLog(`Cancel request failed: ${err.message}`, 'error');
  } finally {
    btnStop.disabled = false;
    btnStop.textContent = '⏹ Stop OCR';
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
      setProgress(pct, `${data.processed_pages}/${data.total_pages} pages processed`);

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
      } else if (data.status === 'cancelled') {
        eventSource.close();
        eventSource = null;
        onJobCancelled(data);
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
      setProgress(pct, `${data.processed_pages}/${data.total_pages} pages`);

      const lastMsg = (data.logs || []).pop();
      if (lastMsg) addLog(lastMsg);

      if (data.status === 'done') {
        clearInterval(interval);
        onJobDone(data);
      } else if (data.status === 'error') {
        clearInterval(interval);
        onJobError(data);
      } else if (data.status === 'cancelled') {
        clearInterval(interval);
        onJobCancelled(data);
      }
    } catch {
      // keep polling
    }
  }, 1000);
}

// ── Job Complete ─────────────────────────────────────────────────
async function onJobDone(data) {
  btnStart.disabled = false;
  btnStart.textContent = '🚀 Start OCR';
  hide(btnStop);
  setProgress(100, 'Completed!');

  // Capture grounding state from server
  groundingEnabled = !!data.grounding_enabled;

  setResultStatus(`✅ ${data.processed_pages} pages processed${groundingEnabled ? ' (grounding)' : ''}`, 'success');

  // Fetch per-page results
  await fetchPageResults();

  // Show page results list in sidebar
  renderPageResultsList();
  show(pageResultsPanel);

  // Show merged markdown by default
  isViewingAll = true;
  selectedPageNum = null;
  await renderMergedMarkdown();

  // Show post-processing options and action buttons in sidebar
  if (pageResults && pageResults.length > 0) {
    show(postProcessingPanel);
  }
  show(sidebarActions);
}

function onJobError(data) {
  btnStart.disabled = false;
  btnStart.textContent = '🚀 Avvia OCR';
  hide(btnStop);
  setProgress(0, 'Errore');

  setResultStatus(`❌ ${data.message || 'Unknown error'}`, 'error');
}

function onJobCancelled(data) {
  btnStart.disabled = false;
  btnStart.textContent = '🚀 Start OCR';
  hide(btnStop);
  setProgress(0, 'Annullato');

  setResultStatus(`⏹ Job cancelled after ${data.processed_pages}/${data.total_pages} pages`, 'error');
  addLog('[Cancelled] Job stopped by user', 'error');
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
  // First, clear all existing page items but keep the "View All" button
  const existingItems = pageResultsList.querySelectorAll('.page-result-item:not(.view-all-btn), .image-entry');
  existingItems.forEach(item => item.remove());

  // "View All" button - create if not exists
  let allBtn = pageResultsList.querySelector('.view-all-btn');
  if (!allBtn) {
    allBtn = document.createElement('div');
    allBtn.className = 'page-result-item' + (isViewingAll ? ' active' : '') + ' view-all-btn';
    allBtn.innerHTML = `
      <span class="page-num">📄</span>
      <span class="page-meta">View all (merge)</span>
      <span class="page-status-dot done"></span>
    `;
    allBtn.addEventListener('click', async () => {
      isViewingAll = true;
      selectedPageNum = null;
      renderPageResultsList(); // update active state
      await renderMergedMarkdown();
    });
    pageResultsList.appendChild(allBtn);
  } else {
    allBtn.className = 'page-result-item' + (isViewingAll ? ' active' : '') + ' view-all-btn';
  }

  // Individual page items - create or update
  pageResults.forEach((pr, idx) => {
    let item = pageResultsList.querySelector(`.page-result-item[data-page="${pr.page_num}"]`);
    const isActive = !isViewingAll && selectedPageNum === pr.page_num;

    if (!item) {
      // Create new item
      item = document.createElement('div');
      item.className = 'page-result-item' + (isActive ? ' active' : '');
      item.setAttribute('data-page', pr.page_num);
    } else {
      // Update existing item class
      item.className = 'page-result-item' + (isActive ? ' active' : '');
    }

    const methodLabel = pr.method === 'vlm_grounding' ? 'VLM' : pr.method === 'vlm' ? 'VLM' : pr.method === 'text_extract' ? 'TXT' : pr.method === 'skipped' ? '—' : '?';
    const modelLabel = pr.model && pr.model !== '(text-extract)' ? pr.model.substring(0, 30) : '';
    const groundingBadge = pr.grounding_enabled ? '<span class="grounding-badge">🖼️ Grounding</span>' : '';

    item.innerHTML = `
      <span class="page-num">${pr.page_num}</span>
      <span class="page-meta">${methodLabel}${modelLabel ? ' · ' + modelLabel : ''}</span>
      ${groundingBadge}
      <span class="page-status-dot ${pr.status}"></span>
      ${pr.status === 'done' ? `<button class="btn-reprocess" data-page="${pr.page_num}">🔄</button>` : ''}
    `;

    // Remove any existing image entries below this page item
    const existingImgEntries = pageResultsList.querySelectorAll(`.image-entry[data-parent-page="${pr.page_num}"]`);
    existingImgEntries.forEach(e => e.remove());

    // Click on the row → sync preview + show that page's markdown
    item.addEventListener('click', async (e) => {
      if (e.target.classList.contains('btn-reprocess')) return; // let the button handle itself
      isViewingAll = false;
      selectedPageNum = pr.page_num;
      // Update sidebar list first, then sync preview
      renderPageResultsList();
      syncFromSidebar(pr.page_num);

      // Resolve grounding images in single-page markdown
      let md = pr.markdown || '<!-- page not processed -->';
      if (groundingEnabled && currentJobId) {
        md = await resolveGroundingImages(md, currentJobId, pr.page_num);
      }
      renderMarkdown(md);
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

    // Grounding: add image entries with thumbnails below the page item
    if (pr.grounding_images && pr.grounding_images.length > 0 && currentJobId) {
      pr.grounding_images.forEach(entry => {
        const imgEntry = document.createElement('div');
        imgEntry.className = 'image-entry';
        imgEntry.setAttribute('data-parent-page', pr.page_num);

        const imgFilename = entry.image_filename || `${entry.id}.png`;
        const desc = entry.description || 'image';

        imgEntry.innerHTML = `
          <span style="flex-shrink:0;">└─</span>
          <img class="image-thumbnail" src="/api/download-image/${currentJobId}/${imgFilename}?page_num=${pr.page_num}" alt="${desc}" onerror="this.style.display='none'">
          <span>${entry.id}: ${desc}</span>
        `;

        // Click on image entry → show that page's markdown
        imgEntry.addEventListener('click', async () => {
          isViewingAll = false;
          selectedPageNum = pr.page_num;
          renderPageResultsList();
          syncFromSidebar(pr.page_num);
          let md = pr.markdown || '<!-- page not processed -->';
          if (groundingEnabled && currentJobId) {
            md = await resolveGroundingImages(md, currentJobId, pr.page_num);
          }
          renderMarkdown(md);
        });

        pageResultsList.appendChild(imgEntry);
      });
    }
  });
}

// ── Resolve grounding image paths to data URIs ──────────────────
// The in-memory per-page markdown has raw ![desc](IMG_N) placeholders.
// The file output rewrites them to ![desc](images/pN_IMG_N.png).
// This function handles BOTH formats and replaces with data URIs
// so zero-md can render images inline.
//
// When `pageNum` is provided (single-page view), Phase 2 resolves raw
// IMG_N placeholders using ONLY that page's grounding_images metadata,
// so images are never mixed across pages.
// When `pageNum` is null (merged markdown), Phase 2 is skipped —
// buildMergedMarkdown() already rewrites paths so Phase 1 handles everything.
async function resolveGroundingImages(markdown, jobId, pageNum) {
  if (!groundingEnabled) return markdown;

  // ── Phase 1: resolve paths already rewritten (page-prefixed)
  //          e.g. ![desc](images/p1_IMG_1.png)
  const resolvedRe = /(!\[[^\]]*\])\(images\/(p\d+_IMG_\d+\.png)\)/g;
  const resolvedMatches = [...markdown.matchAll(resolvedRe)];

  if (resolvedMatches.length > 0) {
    const fetchPromises = [];
    for (const m of resolvedMatches) {
      const path = m[2]; // e.g. "p1_IMG_1.png"
      if (groundingImageCache[path]) continue;

      const pageMatch = path.match(/^p(\d+)/);
      const pn = pageMatch ? parseInt(pageMatch[1], 10) : 0;

      fetchPromises.push(
        fetch(`/api/download-image/${jobId}/${encodeURIComponent(path)}?page_num=${pn}`)
          .then(res => res.ok ? res.blob() : null)
          .then(blob => {
            if (blob) return blobToDataUri(blob).then(uri => { groundingImageCache[path] = uri; });
          })
          .catch(() => {}),
      );
    }
    if (fetchPromises.length > 0) await Promise.all(fetchPromises);

    markdown = markdown.replace(resolvedRe, (full, altPart, path) => {
      const uri = groundingImageCache[path];
      return uri ? `${altPart}(${uri})` : full;
    });
  }

  // ── Phase 2: resolve raw ![desc](IMG_N) placeholders
  //          Only active for single-page view (pageNum provided).
  //          For merged markdown, paths are already rewritten by
  //          buildMergedMarkdown() so Phase 1 handles everything.
  if (pageNum == null) return markdown;

  const rawRe = /(!\[[^\]]*\])\(IMG_(\d+)\)/g;
  const rawMatches = [...markdown.matchAll(rawRe)];
  if (rawMatches.length === 0) return markdown;

  // Build a lookup from ONLY this page's grounding_images
  const pr = pageResults.find(p => p.page_num === pageNum);
  if (!pr || !pr.grounding_images) return markdown;

  const imgMap = {};
  for (const entry of pr.grounding_images) {
    imgMap[entry.id] = entry.image_filename; // "IMG_1" → "p3_IMG_1.png"
  }

  // Pre-fetch images for this page
  const fetchPromises = [];
  for (const raw of rawMatches) {
    const id = `IMG_${raw[2]}`;
    const filename = imgMap[id];
    if (!filename || groundingImageCache[filename]) continue;
    fetchPromises.push(
      fetch(`/api/download-image/${jobId}/${encodeURIComponent(filename)}?page_num=${pageNum}`)
        .then(res => res.ok ? res.blob() : null)
        .then(blob => {
          if (blob) return blobToDataUri(blob).then(uri => { groundingImageCache[filename] = uri; });
        })
        .catch(() => {}),
    );
  }
  if (fetchPromises.length > 0) await Promise.all(fetchPromises);

  // Replace raw placeholders using this page's image map
  markdown = markdown.replace(rawRe, (full, altPart, num) => {
    const id = `IMG_${num}`;
    const filename = imgMap[id];
    if (!filename) return full;
    const uri = groundingImageCache[filename];
    return uri ? `${altPart}(${uri})` : full;
  });

  return markdown;
}

function blobToDataUri(blob) {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result);
    reader.readAsDataURL(blob);
  });
}

// ── Render Merged Markdown ──────────────────────────────────────
async function renderMergedMarkdown() {
  // Build merged markdown from pageResults (respects post-processing)
  let md;
  if (pageResults && pageResults.length > 0) {
    md = buildMergedMarkdown();
  } else {
    // Fallback: fetch from server
    try {
      const res = await fetch(`/api/download/${currentJobId}`);
      if (res.ok) {
        md = await res.text();
      }
    } catch (err) {
      console.error('Failed to fetch merged result:', err);
    }
  }

  if (md) {
    // Resolve grounding image paths to data URIs
    md = await resolveGroundingImages(md, currentJobId);
    renderMarkdown(md);
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
  btnConfirmReprocess.textContent = '⏳ Reprocessing...';

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
    alert(`Reprocessing error: ${err.message}`);
  } finally {
    btnConfirmReprocess.disabled = false;
    btnConfirmReprocess.textContent = '🔄 Reprocess';
  }
});

btnCloseReprocess.addEventListener('click', () => hide(reprocessModal));
reprocessModal.querySelector('.modal-overlay').addEventListener('click', () => hide(reprocessModal));

// ── Download Result ──────────────────────────────────────────────
btnDownload.addEventListener('click', async () => {
  if (!currentJobId) return;

  try {
    if (groundingEnabled) {
      // Download ZIP (grounding output: .md + images/)
      const res = await fetch(`/api/download/${currentJobId}`);
      if (!res.ok) {
        const err = await res.json().catch(() => ({ detail: `HTTP ${res.status}` }));
        alert(`Download failed: ${err.detail || 'Unknown error'}`);
        return;
      }
      const blob = await res.blob();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      const stem = selectedFile ? selectedFile.name.replace(/\.[^.]+$/, '') : `ocr_${currentJobId}`;
      a.download = `${stem}_grounding.zip`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(a.href);
    } else {
      // Download .md (classic)
      let content;
      if (pageResults && pageResults.length > 0) {
        content = buildMergedMarkdown();
      } else {
        const res = await fetch(`/api/download/${currentJobId}`);
        if (!res.ok) {
          const err = await res.json().catch(() => ({ detail: `HTTP ${res.status}` }));
          alert(`Download failed: ${err.detail || 'Unknown error'}`);
          return;
        }
        content = await res.text();
      }

      const blob = new Blob([content], { type: 'text/markdown' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;

      const stem = selectedFile ? selectedFile.name.replace(/\.[^.]+$/, '') : `ocr_${currentJobId}`;
      a.download = `${stem}.md`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }
  } catch (err) {
    alert(`Download error: ${err.message}`);
  }
});

// ── Post-processing functions ──────────────────────────────────

/** Compact text: resolve line breaks in paragraphs */
function compactMarkdown(text) {
  if (!text || typeof text !== 'string') return text;
  
  // Step 1: Normalize line endings
  text = text.replace(/\r\n/g, '\n');
  
  // Step 2: Keep double line breaks (paragraph separators) intact
  // Replace double line breaks with a placeholder
  text = text.replace(/\n\n/g, '\n\n\n');
  
  // Step 3: Remove single line breaks within paragraphs
  // Join lines that don't end with sentence-ending punctuation
  text = text.replace(/([^.!?])\n(?![\s#*\-|>])/g, '$1 ');
  
  // Step 4: Restore double line breaks
  text = text.replace(/\n\n\n/g, '\n\n');
  
  // Step 5: Clean up any remaining excessive whitespace
  text = text.replace(/  +/g, ' ');
  
  // Step 6: Remove empty lines within paragraphs
  text = text.replace(/\n\n+/g, '\n\n');
  
  return text;
}

/** Fix hyphenation: join words split across lines */
function fixHyphenation(text) {
  if (!text || typeof text !== 'string') return text;
  
  // Match hyphen at end of line followed by continuation (common hyphenation patterns)
  // Handles: word-\ncontinuation, word-\n\ncontinuation, and various whitespace scenarios
  text = text.replace(/(\w)-\s*\n\s*(\w)/g, '$1$2');
  
  // Also handle soft hyphens (Unicode U+00AD) and non-breaking hyphens
  text = text.replace(/(\w)\u00AD\s*\n\s*(\w)/g, '$1$2');
  
  // Handle hyphenation in the middle of words (not at word boundaries)
  text = text.replace(/([a-zA-Z])-\s*\n\s*([a-zA-Z])/g, '$1$2');
  
  return text;
}

/** Build merged markdown from pageResults (respects post-processing)
 * Rewrites raw IMG_N placeholders to page-prefixed paths (images/pN_IMG_N.png)
 * so that resolveGroundingImages Phase 1 can resolve them correctly.
 * Mirrors the backend logic in _write_grounding_output().
 */
function buildMergedMarkdown() {
  if (!pageResults || pageResults.length === 0) return '';
  const parts = pageResults.map(pr => {
    let md = pr.markdown || '';
    // Rewrite raw IMG_N → images/pN_IMG_N.png using this page's grounding metadata
    if (pr.grounding_images && pr.grounding_images.length > 0) {
      for (const entry of pr.grounding_images) {
        const id = entry.id;              // "IMG_1"
        const filename = entry.image_filename; // "p1_IMG_1.png"
        md = md.replace(
          new RegExp(`\\]\\(${id}\\)`, 'g'),
          `](images/${filename})`,
        );
      }
    }
    return md;
  });
  return parts.join('\n\n').trim();
}

/** Apply post-processing to current view and persist changes */
function applyPostProcessing(processType) {
  if (!currentJobId || !zeroMdScript.textContent) {
    alert('No markdown result available for post-processing.');
    return;
  }
  
  let processedText = zeroMdScript.textContent;
  const fn = processType === 'compact' ? compactMarkdown : fixHyphenation;
  processedText = fn(processedText);
  
  // Persist changes: update pageResults
  if (isViewingAll) {
    // Apply to all pages
    for (const pr of pageResults) {
      pr.markdown = fn(pr.markdown || '');
    }
  } else {
    // Apply to current page only
    const pr = pageResults.find(p => p.page_num === selectedPageNum);
    if (pr) pr.markdown = processedText;
  }
  
  // Update display
  zeroMdScript.textContent = processedText;
  zeroMdResult.render().catch(err => {
    console.error('zero-md render error:', err);
  });
}

// ── Reset for new OCR ────────────────────────────────────────────
btnNewOcr.addEventListener('click', () => {
  selectedFile = null;
  currentJobId = null;
  webcamCapturedPages = [];
  webcamSessionId = '';
  pageResults = [];
  selectedPageNum = null;
  isViewingAll = true;
  groundingEnabled = false;
  groundingImageCache = {};
  hide(fileInfo);
  hide(btnStart);
  hide(progressPanel);
  hide(btnStop);
  hide(logPanel);
  hide(pageResultsPanel);
  hide(postProcessingPanel);
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
      <p>No file uploaded</p>
    </div>`;
  hide(btnPrevPage);
  hide(btnNextPage);
  hide(previewPageLabel);
});

// ── Post-processing button event listeners ──────────────────────
btnCompact.addEventListener('click', () => applyPostProcessing('compact'));
btnHyphenation.addEventListener('click', () => applyPostProcessing('hyphenation'));

btnCompactAll.addEventListener('click', () => {
  if (!pageResults || pageResults.length === 0) {
    alert('No processed pages available for post-processing.');
    return;
  }
  
  // Apply compact to all pages and persist
  for (const pr of pageResults) {
    pr.markdown = compactMarkdown(pr.markdown || '');
  }
  
  // Re-render current view
  if (isViewingAll) {
    renderMarkdown(buildMergedMarkdown());
  } else {
    const pr = pageResults.find(p => p.page_num === selectedPageNum);
    renderMarkdown(pr ? pr.markdown : '');
  }
});

btnHyphenationAll.addEventListener('click', () => {
  if (!pageResults || pageResults.length === 0) {
    alert('No processed pages available for post-processing.');
    return;
  }
  
  // Apply hyphenation fix to all pages and persist
  for (const pr of pageResults) {
    pr.markdown = fixHyphenation(pr.markdown || '');
  }
  
  // Re-render current view
  if (isViewingAll) {
    renderMarkdown(buildMergedMarkdown());
  } else {
    const pr = pageResults.find(p => p.page_num === selectedPageNum);
    renderMarkdown(pr ? pr.markdown : '');
  }
});

// ── Config persistence ───────────────────────────────────────────
const configStatus = $('#configStatus');

function flashConfigStatus(msg, isError = false) {
  configStatus.textContent = msg;
  configStatus.className = 'config-status' + (isError ? ' error' : '');
  show(configStatus);
  setTimeout(() => hide(configStatus), 2500);
}

async function loadConfig() {
  try {
    const res = await fetch('/api/config');
    if (!res.ok) return;
    const cfg = await res.json();

    if (cfg.vlm_url) serverUrlInput.value = cfg.vlm_url;
    if (cfg.model) modelSelect.value = cfg.model;
    if (cfg.dpi) dpiSelect.value = String(cfg.dpi);
    if (cfg.force_vlm != null) forceVlmCheckbox.checked = cfg.force_vlm;
    if (cfg.grounding != null) groundingToggle.checked = cfg.grounding;
  } catch (err) {
    console.warn('Config load failed:', err);
  }
}

async function saveConfig() {
  try {
    const payload = {
      vlm_url: serverUrlInput.value.trim(),
      model: modelSelect.value,
      dpi: parseInt(dpiSelect.value, 10),
      force_vlm: forceVlmCheckbox.checked,
      grounding: groundingToggle.checked,
    };
    const res = await fetch('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    flashConfigStatus('Settings saved ✓');
  } catch (err) {
    flashConfigStatus(`Save failed: ${err.message}`, true);
  }
}

btnSaveConfig.addEventListener('click', async () => {
  await saveConfig();
  setTimeout(() => hide(settingsModal), 800);
});

// ── Init ─────────────────────────────────────────────────────────
(async () => {
  await loadConfig();
  refreshModels();
})();
