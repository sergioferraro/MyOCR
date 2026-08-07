# Implementation Plan: VLM Grounding Images

> **Branch**: `feature/vlm-grounding-images`
> **Model**: `qwen/qwen3-vl-30b` via LM Studio
> **Stato prompt**: ✅ Validato (Test 4 v2, context 32000 tokens)
> **File di riferimento**: `test_grounding.py`, `test_grounding_new_test4.log`

---

## Panoramica

La feature estende il flusso OCR esistente con una nuova modalità **"Grounding"** che:

- Rileva grafici, figure e diagrammi non convertibili in testo
- Restituisce bounding box normalizzate (`<box>(x1,y1,x2,y2)</box>`) dal VLM
- Ritaglia le immagini dalle coordinate e le salva in cartella dedicata
- Genera markdown con placeholder `![desc](images/IMG_N.png)` referenziati
- Salva l'output in una cartella univoca `<nome_file>/` contenente `.md` + `images/`

L'utente sceglie tra **OCR classico** (comportamento attuale) e **OCR con Grounding** tramite un toggle nell'interfaccia.

---

## 1. Struttura Output (nuova)

```
outputs/
├── documento_classico.md                          # OCR classico (comportamento esistente)
├── documento_grounding/                           # OCR con grounding (nuovo)
│   ├── extracted.md                               # markdown con ![...](images/IMG_N.png)
│   └── images/
│       ├── IMG_1.png                              # ritaglio da bounding box
│       ├── IMG_2.png
│       └── ...
└── altro_file_grounding/
    ├── extracted.md
    └── images/
        └── IMG_1.png
```

**Razionale**: separare classico da grounding evita conflitti di naming. Ogni job grounding ha la propria cartella con immagini autocontenute.

---

## 2. Backend — `main.py`

### 2.1. Nuovi costanti e prompt

| Aggiunta | Dettaglio |
|---|---|
| `GROUNDING_SYSTEM_PROMPT` | System prompt ottimizzato (dal Test 4 v2, validato) |
| `GROUNDING_USER_PROMPT` | User prompt con regole: delimitatori, `<box>`, max 5, math-safe, ignore UI |
| `GROUNDING_MAX_TOKENS` | 32000 (validato nei test — previene troncamento e allucinazioni) |

I prompt sono quelli già testati in `test_grounding.py` (Test 4 v2) e hanno dimostrato:
- OCR qualità eccelsa (formule LaTeX perfette)
- Rilevamento corretto di figure/grafici reali (PDF Springer)
- Nessun falso positivo su formule matematiche
- Delimitatori `===TEXT_START===` / `===BOXES_START===` sempre rispettati
- Cross-reference placeholder ↔ box entries funzionante

### 2.2. Estensione `PageResult`

```python
@dataclass
class PageResult:
    # ... campi esistenti (page_num, markdown, model, method, status, error_msg) ...

    # Nuovi campi grounding
    grounding_images: list[dict] = field(default_factory=list)
    # Ogni entry: {
    #   "id": "IMG_1",
    #   "description": "bar chart showing quarterly revenue",
    #   "bbox": [x1, y1, x2, y2],       # normalizzate 0-1000
    #   "image_filename": "IMG_1.png",  # salvato in images/
    # }
    grounding_enabled: bool = False
```

### 2.3. Nuove funzioni core

#### `parse_grounding_response(response_text: str) -> tuple[str, list[dict]]`

Parser della risposta strutturata del VLM.

**Input**: risposta grezza con `===TEXT_START===` ... `===BOXES_START===` ...

**Output**: `(markdown_text, list_of_image_metadata)`

**Logica**:
1. Estrarre sezione tra `===TEXT_START===` e `===TEXT_END===`
2. Estrarre sezione tra `===BOXES_START===` e `===BOXES_END===`
3. Parse box con regex robusta:
   ```regex
   <box>\s*\(?(\d+),(\d+),(\d+),(\d+)\)?\s*</box>\s*\|\s*IMG_(\d+)\s*\|\s*(.+)
   ```
4. Validare:
   - Cross-reference: ogni placeholder `![desc](IMG_N)` ha un box corrispondente
   - Coordinate nel range 0-1000
   - Max 5 box per pagina (limite già nel prompt, doppio controllo)
5. Se parsing fallisce → **fallback a OCR classico** (ritorna `response_text` come markdown, lista vuota)
6. Restituire markdown pulito + lista metadata immagini

#### `crop_page_image(page_bytes: bytes, bbox: tuple, dpi: int) -> bytes`

Ritaglio dell'immagine pagina usando le coordinate normalizzate.

**Input**: PNG bytes dell'intera pagina, bbox `(x1, y1, x2, y2)` in 0-1000

**Output**: PNG bytes del ritaglio

**Logica**:
1. Open PNG con `PIL.Image`
2. Ottenere dimensioni pixel `(W, H)`
3. Mappare coordinate: `px1 = int(x1 / 1000 * W)`, etc.
4. Applicare **padding 5%** intorno al box per margine di sicurezza
5. Clamp coordinate ai bordi dell'immagine (prevenire crop fuori area)
6. Crop: `img.crop((px1, py1, px2, py2))`
7. Salvare come PNG bytes
8. On error: salvare pagina intera come fallback

### 2.4. Modifica `_process_single_page()`

Aggiungere parametro `grounding: bool = False`:

```python
def _process_single_page(
    doc: fitz.Document,
    page_idx: int,
    dpi: int,
    model: str,
    url: str,
    force_vlm: bool,
    job_id: str,
    grounding: bool = False,          # ← nuovo parametro
) -> None:
```

**Flusso grounding** (quando `grounding=True` e pagina va al VLM):
1. Renderizzare pagina → PNG bytes
2. Invio al VLM con `GROUNDING_SYSTEM_PROMPT` + `GROUNDING_USER_PROMPT`, `max_tokens=32000`
3. Parse risposta con `parse_grounding_response()`
4. Se parsing OK:
   - Salvare markdown in `PageResult.markdown`
   - Salvare metadata immagini in `PageResult.grounding_images`
   - Settare `PageResult.grounding_enabled = True`
   - Memorizzare PNG bytes della pagina in `PageResult.page_image_bytes` (per il crop successivo)
5. Se parsing fallisce → fallback: usare markdown grezzo, lista immagini vuota
6. **Crop differito**: il ritaglio effettivo delle immagini avviene in `_write_grounding_output()`, non qui (evita duplicazione lavoro)

### 2.5. `_write_grounding_output(job_id: str) -> str`

Scrittura output grounding (nuova funzione, coesiste con `_write_merged_output()`).

**Input**: `job_id`

**Output**: path alla cartella di output

**Logica**:
1. Creare `outputs/<safe_filename>_grounding/images/`
2. Per ogni pagina con `grounding_enabled=True`:
   - Per ogni entry in `grounding_images`:
     - Ritagliare immagine usando `crop_page_image()` dai PNG bytes memorizzati
     - Salvare in `images/IMG_N.png`
3. Scrivere `extracted.md` con markdown assemblato (placeholder già contengono `images/IMG_N.png`)
4. Restituire path alla cartella

### 2.6. Modifica `JobState`

```python
@dataclass
class JobState:
    # ... campi esistenti ...
    grounding_enabled: bool = False     # flag a livello job
    output_dir: str = ""               # path alla cartella grounding (se applicabile)
```

### 2.7. Endpoint API

#### Modifica esistenti

| Endpoint | Modifica |
|---|---|
| `POST /api/ocr` | Campo aggiuntivo: `grounding: bool = Form(False)` |
| `GET /api/status/{job_id}` | Risposta include `grounding_enabled` |
| `GET /api/pages/{job_id}` | Risposta include `grounding_images` e `grounding_enabled` per pagina |
| `GET /api/download/{job_id}` | Se grounding: restituisce **ZIP** della cartella `.md` + `images/` |

#### Nuovi

| Method | Endpoint | Descrizione |
|---|---|---|
| `GET` | `/api/download-image/{job_id}/{img_filename}` | Restituisce singola immagine PNG (per rendering frontend in preview) |

**Download ZIP**: usare `zipfile` (stdlib, nessuna dipendenza extra).

### 2.8. Modifica `requirements.txt`

```
Pillow>=10.0.0    # ritaglio immagini da bounding box
```

---

## 3. Frontend — `frontend/`

### 3.1. Settings Panel (`index.html`)

Aggiungere toggle grounding sotto "Force VLM":

```html
<div class="field checkbox-field">
  <label class="checkbox-label">
    <input type="checkbox" id="groundingToggle">
    <span>🖼️ Preserve Charts &amp; Figures (Grounding)</span>
  </label>
  <p class="help-text">Save charts, graphs, and figures as separate images in the output</p>
</div>
```

### 3.2. JavaScript State (`app.js`)

Nuovi stati:

```javascript
let groundingEnabled = false;        // toggle grounding
let groundingImageCache = {};        // { "IMG_1.png": dataUri } — cache immagini caricate
```

### 3.3. Modifica Start OCR

Nel `btnStart.addEventListener`:

```javascript
const grounding = groundingToggle.checked;
formData.append('grounding', grounding ? 'true' : 'false');
```

### 3.4. Rendering Markdown con immagini

Quando grounding è attivo, il markdown contiene:
```markdown
![bar chart](images/IMG_1.png)
```

**Problema**: `zero-md` renderizza `![alt](path)` ma `images/IMG_1.png` è un path relativo locale, non disponibile nel browser.

**Soluzione**: prima di passare il markdown a `zero-md`, sostituire i path relativi con fetch dinamici:

```javascript
async function resolveGroundingImages(markdown, jobId) {
    // Sostituire ![desc](images/IMG_N.png) con data URI caricati via API
    const matches = markdown.match(/!\[([^\]]+)\]\(images\/(IMG_\d+\.png)\)/g) || [];
    for (const match of matches) {
        const imgFilename = match.match(/IMG_\d+\.png/)[0];
        let dataUri = groundingImageCache[imgFilename];

        if (!dataUri) {
            try {
                const res = await fetch(`/api/download-image/${jobId}/${imgFilename}`);
                if (res.ok) {
                    const blob = await res.blob();
                    dataUri = await blobToDataUri(blob);
                    groundingImageCache[imgFilename] = dataUri;
                }
            } catch {
                // On error, keep original placeholder
                continue;
            }
        }

        if (dataUri) {
            markdown = markdown.replace(
                `images/${imgFilename}`,
                dataUri
            );
        }
    }
    return markdown;
}
```

### 3.5. Download Grounding (ZIP)

Modificare `btnDownload`:

```javascript
btnDownload.addEventListener('click', async () => {
    if (!currentJobId) return;

    if (groundingEnabled) {
        // Download ZIP
        const res = await fetch(`/api/download/${currentJobId}`);
        const blob = await res.blob();
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `${stem}_grounding.zip`;
        a.click();
        URL.revokeObjectURL(a.href);
    } else {
        // Download .md (comportamento esistente)
        // ...
    }
});
```

### 3.6. Sidebar — Page Results

Quando grounding è attivo, mostrare nel pannello "Processed Pages":

```
Page 3  [VLM · grounding]  ✅
         └─ IMG_1: bar chart (12KB)       ← thumbnail cliccabile
         └─ IMG_2: flow diagram (8KB)     ← thumbnail cliccabile
```

Aggiungere un mini-thumbnail cliccabile accanto a ogni immagine estratta. Click → mostra l'immagine ingrandita nel pannello risultato.

### 3.7. CSS

Aggiungere stili per:

- `.help-text` — testo descrittivo piccolo sotto il toggle grounding
- `.grounding-badge` — badge visivo "🖼️ Grounding" nella sidebar
- `.image-entry` — riga con thumbnail + descrizione nel page results list
- `.image-thumbnail` — miniatura 40x40px con border, hover zoom

---

## 4. Flusso Completo (sequenza operativa)

```
┌─────────────────────────────────────────────────────────────────┐
│ 1. Utente carica PDF, attiva "Grounding", clicca Start OCR       │
└─────────────────────────────────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────────┐
│ 2. Backend: _process_single_page(grounding=True)                 │
│    └─ Renderizza pagina → PNG (memorizzato in PageResult)        │
│    └─ Invia a VLM con GROUNDING prompts, max_tokens=32000       │
└─────────────────────────────────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────────┐
│ 3. VLM risponde con formato strutturato:                          │
│    ===TEXT_START=== ... ===TEXT_END===                            │
│    ===BOXES_START=== <box>(...) | IMG_1 | desc ===BOXES_END===   │
└─────────────────────────────────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────────┐
│ 4. parse_grounding_response()                                     │
│    └─ Estrae markdown + lista metadata immagini                   │
│    └─ Cross-reference: placeholder ↔ box                          │
│    └─ Fallback a OCR classico se parsing fallisce                 │
└─────────────────────────────────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────────┐
│ 5. Job completato → _write_grounding_output()                     │
│    └─ Per ogni box: crop_page_image() → salva in images/IMG_N.png │
│    └─ Scrive extracted.md con placeholder images/IMG_N.png       │
│    └─ Output in outputs/<nome>_grounding/                        │
└─────────────────────────────────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────────┐
│ 6. Frontend riceve via SSE, renderizza markdown                   │
│    └─ resolveGroundingImages(): sostituisce path con data URI     │
│    └─ zero-md renderizza con immagini inline                     │
└─────────────────────────────────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────────┐
│ 7. Utente clicca Download → riceve ZIP (.md + images/)            │
└─────────────────────────────────────────────────────────────────┘
```

---

## 5. Gestione Errori e Fallback

| Scenario | Comportamento |
|---|---|
| VLM non rispetta delimitatori | Fallback a OCR classico (usa response come markdown puro) |
| Box senza placeholder corrispondente | Ignora il box, log warning |
| Placeholder senza box | Mantiene placeholder nel testo ma senza immagine |
| Coordinate fuori range (0-1000) | Ignora quel box, log warning |
| Troppe box (>10, possibile allucinazione) | Trunca a 5, log warning, fallback |
| Crop fallisce (PIL error) | Salva pagina intera come fallback, log warning |
| Job grounding + reprocess classico | Mix permesso: pagina reprocessata senza grounding |
| Model non supporta grounding | Rilevato dal parsing fallito → fallback automatico |

---

## 6. Ordine di Implementazione (step)

| Step | Cosa | File toccati | Stima |
|---|---|---|---|
| **1** | `requirements.txt` + `Pillow` | `requirements.txt` | 5 min |
| **2** | Costanti prompt + `parse_grounding_response()` | `main.py` | 1h |
| **3** | `crop_page_image()` + test ritaglio | `main.py` | 45 min |
| **4** | Estensione `PageResult` + `JobState` | `main.py` | 30 min |
| **5** | Modifica `_process_single_page()` + grounding flag | `main.py` | 1h |
| **6** | `_write_grounding_output()` + struttura cartelle | `main.py` | 45 min |
| **7** | Endpoint `/api/download-image/` + ZIP download | `main.py` | 45 min |
| **8** | Toggle grounding in Settings UI + CSS | `index.html` + `style.css` | 30 min |
| **9** | Frontend: state, Start OCR, SSE handling | `app.js` | 1h |
| **10** | Frontend: resolve image paths + zero-md rendering | `app.js` | 45 min |
| **11** | Frontend: download ZIP + sidebar grounding info | `app.js` + `style.css` | 45 min |
| **12** | Testing end-to-end + fallback validation | — | 1h |

**Totale stimato**: ~8-9 ore

---

## 7. Decisioni Aperte

| Domanda | Opzione A | Opzione B | Raccomandazione |
|---|---|---|---|
| Download grounding | ZIP | Multi-file download | **ZIP** — più portabile, un solo click |
| Immagini nel preview | Fetch on-demand via API | Base64 inline in SSE | **Fetch on-demand** — meno memoria frontend |
| Reprocess con grounding | Supportato | Solo classico | **Supportato** — coerenza UX |
| DPI grounding | Stesso DPI dell'OCR | DPI separato (più alto) | **Stesso DPI** — semplicità |
| Max immagini/pagina | 5 (dal prompt) | Configurabile | **5 hard-coded** — il VLM gestisce bene questo limite |
| Padding crop | 5% | Nessuno | **5%** — margine di sicurezza per coordinate imprecise |

---

## 8. Rischi

| Rischio | Probabilità | Mitigazione |
|---|---|---|
| VLM non supporta grounding su alcuni modelli | Media | Fallback automatico a OCR classico al parsing |
| Coordinate imprecise → crop sbagliato | Bassa | Padding 5% + clamp ai bordi |
| PDF con 100+ pagine → troppe immagini | Bassa | Limite max 5/page già nel prompt |
| Memoria: pagine PDF tenute in RAM | Bassa | `file_bytes` già esiste; PNG bytes scartati dopo crop |
| LM Studio strips `<box>` tokens | Bassissima | Già validato nei test: token passano correttamente |
| Context window insufficiente | Eliminato | 32000 tokens validati — nessun troncamento |
| Allucinazione box (loop) | Eliminata | Test 4 v2 + 32k ctx: 0 allucinazioni su 3 pagine matematiche |

---

## 9. Note Tecniche

### Coordinate normalizzate 0-1000

Qwen3-VL restituisce coordinate nel range 0-1000 indipendentemente dalla risoluzione dell'immagine. La mappatura è:

```python
pixel_x = int(normalized_x / 1000 * image_width)
pixel_y = int(normalized_y / 1000 * image_height)
```

### Formato box validato

Il regex di parsing deve gestire entrambe le forme osservate nei test:
- `<box>(222,198,774,341)</box>` — forma corretta (maggioranza)
- `<box>222,198,774,341)</box>` — forma malformata (rara, Test 1)

Regex robusta:
```regex
<box>\s*\(?(\d+),(\d+),(\d+),(\d+)\)?\s*</box>
```

### Prompt già validato

I prompt del Test 4 v2 hanno dimostrato:
- ✅ OCR qualità eccelsa (formule LaTeX perfette, struttura preservata)
- ✅ Rilevamento corretto di figure/grafici (PDF Springer: 2/2 figure identificate)
- ✅ Nessun falso positivo su formule matematiche (pagina 3 Analisi Matematica: 0 box su formule)
- ✅ Delimitatori sempre rispettati (6/6 pagine)
- ✅ Cross-reference placeholder ↔ box: 100% (Springer)
- ✅ Token `<box>` passano attraverso LM Studio senza strip
- ✅ Max 5 box/pagina rispettato

### Dipendenze esistenti non toccate

| Pacchetto | Uso | Modifiche |
|---|---|---|
| `fastapi` | Web server | Solo nuovi endpoint |
| `pymupdf` | PDF rendering | Nessuna |
| `openai` | Client VLM | Solo nuovi prompt + max_tokens |
| `uvicorn` | ASGI server | Nessuna |
| `python-multipart` | File upload | Nessuna |

### Nuovo pacchetto

| Pacchetto | Versione | Scopo |
|---|---|---|
| `Pillow` | `>=10.0.0` | Ritaglio immagini da bounding box |
