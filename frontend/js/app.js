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
const pageRangeInput    = $('#pageRangeInput');

const dropZone          = $('#dropZone');
const fileInput         = $('#fileInput');
const btnBrowse         = $('#btnBrowse');
const btnWebcam         = $('#btnWebcam');
const fileInfo          = $('#fileInfo');
const fileName          = $('#fileName');
const fileSize          = $('#fileSize');
const btnStart          = $('#btnStart');

// Preview panel
const previewPanel      = $('#previewPanel');
const previewInfo       = $('#previewInfo');
const previewContainer  = $('#previewContainer');
const btnPrevPage       = $('#btnPrevPage');
const btnNextPage       = $('#btnNextPage');
const previewPageLabel  = $('#previewPageLabel');

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

// Preview state
let previewThumbnails = [];
let previewPage = 0;
let previewTotal = 0;

// ── Page Selection Toggle ────────────────────────────────────────
document.querySelectorAll('input[name="pageMode"]').forEach((radio) => {
  radio.addEventListener('change', () => {
    const isCustom = document.querySelector('input[name="pageMode"]:checked').value === 'custom';
    if (isCustom) {
      show(pageRangeInput);
    } else {
      hide(pageRangeInput);
    }
  });
});

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

// ── Webcam Capture (con anteprima live + multi-pagina) ──────────
let webcamStream = null;
let webcamFacingMode = 'user'; // 'user' (front) o 'environment' (back)

// Raccolta pagine webcam
let webcamCapturedPages = []; // array di { blob, dataUrl, pageNum }
let webcamSessionId = '';    // nome casuale della sessione

const webcamModal       = $('#webcamModal');
const webcamVideo       = $('#webcamVideo');
const webcamCanvas      = $('#webcamCanvas');
const btnCapturePhoto   = $('#btnCapturePhoto');
const btnSwitchCamera   = $('#btnSwitchCamera');
const btnCloseWebcam    = $('#btnCloseWebcam');

// Modali aggiuntivi
const addPagesModal     = $('#addPagesModal');
const webcamPageCount   = $('#webcamPageCount');
const webcamThumbnails  = $('#webcamThumbnails');
const btnAddMorePages   = $('#btnAddMorePages');
const btnDoneCapturing  = $('#btnDoneCapturing');
const btnCloseAddPages  = $('#btnCloseAddPages');

const renameModal       = $('#renameModal');
const renameInput       = $('#renameInput');
const btnConfirmRename  = $('#btnConfirmRename');
const btnCloseRename    = $('#btnCloseRename');

// ── Genera ID sessione casuale ───────────────────────────────────
function generateSessionId() {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  for (let i = 0; i < 8; i++) result += chars[Math.floor(Math.random() * chars.length)];
  return `webcam_${result}`;
}

// ── Apri webcam (primo avvio o aggiungi pagina) ──────────────────
function openWebcam() {
  // Al primo avvio, genera l'ID sessione e pulisce le pagine
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
      // Ferma stream precedente se attivo
      if (webcamStream) {
        webcamStream.getTracks().forEach(track => track.stop());
        webcamStream = null;
      }

      // Apri il modale
      show(webcamModal);

      // Richiedi accesso camera
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: webcamFacingMode }
      });

      webcamStream = stream;
      webcamVideo.srcObject = stream;
      webcamVideo.play();

    } catch (err) {
      console.error('Webcam error:', err);
      hide(webcamModal);

      let errorMsg = 'Errore durante l\'accesso alla webcam:\n';
      if (err.name === 'NotAllowedError') {
        errorMsg += 'Permesso negato. Assicurati di aver autorizzato l\'uso della camera nel browser.';
      } else if (err.name === 'NotFoundError') {
        errorMsg += 'Nessuna webcam rilevata sul dispositivo.';
      } else if (err.name === 'NotReadableError') {
        errorMsg += 'Impossibile accedere alla webcam. Potrebbe essere in uso da altri applicativi.';
      } else if (err.name === 'SecurityError') {
        errorMsg += 'Errore di sicurezza: la webcam non è accessibile in questo contesto.';
      } else {
        errorMsg += err.message || 'Errore sconosciuto';
      }

      alert(errorMsg);
    }
  });
}

// ── Cattura foto dal feed live ───────────────────────────────────
btnCapturePhoto.addEventListener('click', async () => {
  if (!webcamStream) return;

  // Disegna frame corrente sul canvas
  webcamCanvas.width  = webcamVideo.videoWidth;
  webcamCanvas.height = webcamVideo.videoHeight;
  const ctx = webcamCanvas.getContext('2d');
  ctx.drawImage(webcamVideo, 0, 0, webcamCanvas.width, webcamCanvas.height);

  // Converte in blob
  const blob = await new Promise(resolve => {
    webcamCanvas.toBlob(resolve, 'image/jpeg', 0.95);
  });

  // Genera data URL per l'anteprima
  const dataUrl = webcamCanvas.toDataURL('image/jpeg', 0.9);

  // Salva nella raccolta
  const pageNum = webcamCapturedPages.length + 1;
  webcamCapturedPages.push({ blob, dataUrl, pageNum });

  // Ferma stream e chiudi modale webcam
  webcamStream.getTracks().forEach(track => track.stop());
  webcamStream = null;
  webcamVideo.srcObject = null;
  hide(webcamModal);

  // Mostra modale "aggiungi pagine"
  showAddPagesModal();
});

// ── Mostra modale "aggiungi altre pagine" ────────────────────────
function showAddPagesModal() {
  const total = webcamCapturedPages.length;
  webcamPageCount.textContent = total;

  // Aggiorna thumbnails
  webcamThumbnails.innerHTML = '';
  webcamCapturedPages.forEach((page) => {
    const img = document.createElement('img');
    img.src = page.dataUrl;
    img.alt = `Pagina ${page.pageNum}`;
    webcamThumbnails.appendChild(img);
  });

  show(addPagesModal);
}

// ── Aggiungi altra pagina (torna alla webcam) ────────────────────
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

// ── Fatto: passa al rename ───────────────────────────────────────
btnDoneCapturing.addEventListener('click', () => {
  hide(addPagesModal);
  showRenameModal();
});

// ── Chiudi modale "aggiungi pagine" ──────────────────────────────
btnCloseAddPages.addEventListener('click', () => {
  hide(addPagesModal);
});

// ── Mostra modale "rinomina file" ────────────────────────────────
function showRenameModal() {
  // Pre-riempie con l'ID sessione
  renameInput.value = webcamSessionId;
  show(renameModal);
  // Focus sull'input e seleziona il testo per modificarlo facilmente
  setTimeout(() => renameInput.focus(), 100);
  renameInput.select();
}

// ── Conferma rename → avvia OCR ─────────────────────────────────
btnConfirmRename.addEventListener('click', async () => {
  const outputName = renameInput.value.trim().replace(/[^a-zA-Z0-9àèéìòùÀÈÉÌÒÙ_\-\s]/g, '_');
  if (!outputName) {
    alert('Inserisci un nome per il file.');
    return;
  }

  hide(renameModal);

  // Combina le immagini catturate in un unico PDF
  await buildWebcamPdf(outputName);
});

// ── Chiudi modale "rinomina" ────────────────────────────────────
btnCloseRename.addEventListener('click', () => {
  hide(renameModal);
});

// ── Combina immagini in PDF (jsPDF) ─────────────────────────────
async function buildWebcamPdf(outputName) {
  try {
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF();

    for (let i = 0; i < webcamCapturedPages.length; i++) {
      const page = webcamCapturedPages[i];

      // Carica l'immagine come elemento Image
      const img = new Image();
      img.src = page.dataUrl;

      await new Promise((resolve, reject) => {
        img.onload = () => {
          // Aggiungi una nuova pagina per ogni immagine (tranne la prima)
          if (i > 0) doc.addPage();

          // Calcola dimensioni per adattare all'A4 (210x297 mm)
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

    // Genera blob PDF
    const pdfBlob = doc.output('blob');
    const pdfFile = new File([pdfBlob], `${outputName}.pdf`, { type: 'application/pdf' });

    // Pulisci raccolta webcam
    webcamCapturedPages = [];

    // Passa il PDF al flusso OCR normale
    handleFile(pdfFile);

  } catch (err) {
    console.error('PDF build error:', err);
    alert('Errore nella generazione del PDF dalle immagini catturate.');
    // Fallback: usa solo la prima immagine
    if (webcamCapturedPages.length > 0) {
      const first = webcamCapturedPages[0];
      const fallbackFile = new File([first.blob], `${outputName}.jpg`, { type: 'image/jpeg' });
      webcamCapturedPages = [];
      handleFile(fallbackFile);
    }
  }
}

// ── Cambia camera (front/back) ───────────────────────────────────
btnSwitchCamera.addEventListener('click', async () => {
  if (!webcamStream) return;

  try {
    // Ferma stream corrente
    webcamStream.getTracks().forEach(track => track.stop());

    // Alterna facing mode
    webcamFacingMode = webcamFacingMode === 'user' ? 'environment' : 'user';

    // Riapri stream con la camera opposta
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

// ── Chiudi modale webcam ─────────────────────────────────────────
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

// ── Chiudi modali overlay ────────────────────────────────────────
addPagesModal.querySelector('.modal-overlay').addEventListener('click', () => hide(addPagesModal));
renameModal.querySelector('.modal-overlay').addEventListener('click', () => hide(renameModal));

// ── Init: avvia listener webcam ──────────────────────────────────
openWebcam();

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

  // Load preview
  loadPreview(file);
}

// ── File Preview ─────────────────────────────────────────────
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

    // Update info
    const typeLabel = data.type === 'pdf' ? `PDF — ${data.pages} pag.` : 'Immagine';
    previewInfo.textContent = `${file.name} · ${formatBytes(file.size)} · ${typeLabel}`;

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
    show(previewPanel);
  } catch (err) {
    console.error('Preview error:', err);
    hide(previewPanel);
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
  hide(resultPanel);
  hide(previewPanel);
  show(progressPanel);
  show(logPanel);
  setProgress(0, 'Invio file...');

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
  webcamCapturedPages = [];
  webcamSessionId = '';
  hide(fileInfo);
  hide(btnStart);
  hide(previewPanel);
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
