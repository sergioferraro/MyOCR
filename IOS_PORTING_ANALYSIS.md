# Analisi Tecnica — Porting Local OCR su iOS (iPad)

> **Obiettivo:** Portare l'applicazione Local OCR (attualmente desktop Python) su iPad, compilando su macOS con autofirma (development build) per lo stesso account Apple.
>
> **Data:** 2026-08-01
> **Stato:** Analisi tecnica — nessuna implementazione ancora iniziata.

---

## Sommario Esecutivo

L'applicazione attuale è un'applicazione desktop Python monolitica basata su `customtkinter` (Tkinter), `pymupdf` e il client `openai` Python che comunica con un server LM Studio locale. **Nessuno di questi componenti è direttamente disponibile su iOS.** Il porting richiede una riscrittura sostanziale dell'architettura.

Questo documento analizza le opzioni disponibili, i vincoli del platform iOS e le raccomandazioni tecniche.

---

## 1. Architettura Attuale (Riferimento)

```
┌─────────────────────────────────────────────┐
│  main.py (Python 3.10+)                     │
│  ┌─────────────┐  ┌──────────────┐         │
│  │ customtkinter│  │ pymupdf(fitz)│         │
│  │  (Tkinter)  │  │  (PDF render) │         │
│  └──────┬──────┘  └──────┬───────┘         │
│         │                │                  │
│  ┌──────▼────────────────▼───────┐         │
│  │      Event Queue (threading)  │         │
│  └────────────────┬──────────────┘         │
│                   │                         │
│         ┌─────────▼──────────┐              │
│         │  openai client →   │              │
│         │  LM Studio (VLM)   │              │
│         └────────────────────┘              │
└─────────────────────────────────────────────┘
```

**Punti di rottura per iOS:**
- ❌ `customtkinter` / Tkinter: non esiste su iOS
- ❌ `pymupdf`: bindings Python C non disponibili su iOS
- ❌ Python runtime: Apple non supporta Python nativamente su iOS
- ❌ LM Studio server locale: non esiste su iOS (è desktop-only)

---

## 2. Vincoli del Platform iOS

### 2.1 Restrizioni di Apple

| Vincolo | Dettaglio |
|---|---|
| **Nessun interprete script** | Python, Ruby, JS runtime non consentiti come linguaggio principale. L'app deve essere compilata in codice nativo (Swift/Objective-C) o tramite framework approvati |
| **Sandboxing** | Ogni app ha il proprio container. Accesso al filesystem limitato al proprio sandbox e ai picker di sistema |
| **App Store vs Development** | Per testing locale (autofirma), non serve App Store. Si usa un Development certificate. Limitazioni: provisioning profile valido 7 giorni (o 1 anno con paid account), max 10 device per free account |
| **Background execution** | Le task di lunga durata (come OCR multi-pagina) sono soggette a time-out del sistema. Serve gestione esplicita dei background task |
| **Memory limits** | iPad ha più RAM del telefono, ma il sistema può terminare app che superano ~70-80% della RAM disponibile |
| **App size** | App Store limit: ~4GB download iniziale. Per development build, nessun limite pratico |
| **Architetture** | iPad moderni: ARM64 (Apple Silicon / A-series). Non c'è più supporto ARMv7 |

### 2.2 Filesystem su iOS

- **Nessun filesystem globale:** L'app accede ai file tramite `UIDocumentPickerViewController` o il proprio Documents directory
- **Document Provider Extension:** Per integrarsi con Files app, serve una Document Provider Extension
- **Shared Photo Library:** Accesso alle foto tramite `Photos` framework (PHPicker / PHPhotoLibrary)
- **Output:** I file `.md` generati possono essere salvati nel container dell'app e condivisi via `UIDocumentPickerViewController.forExporting`

### 2.3 Autenticazione e Firma (Development)

```
macOS (Xcode)
  │
  ├─ Development Certificate (autogenerato da Xcode)
  ├─ Provisioning Profile (automatic code signing)
  │
  └─ Deploy su iPad collegato (USB / WiFi)
      └─ Stesso Apple ID su Mac e iPad
```

**Requisiti minimi:**
- macOS con Xcode installato
- iPad con iOS/iPadOS aggiornato
- Stesso Apple ID su entrambi i device
- USB cable o WiFi debug configurato
- "Developer Mode" abilitato sull'iPad (iPadOS 16.4+)

---

## 3. Opzioni di Porting

### Opzione A — App Nativa Swift/SwiftUI (Raccomandata)

Riscrivere l'app come applicazione nativa iOS usando SwiftUI.

#### 3.1 Linguaggio e Framework

| Componente | Tecnologia |
|---|---|
| **Linguaggio** | Swift 5.9+ (concurenti, async/await) |
| **UI Framework** | SwiftUI (nativo, declarativo) |
| **Build System** | Xcode 15+ / Swift Package Manager |
| **Minimo iOS** | iPadOS 16+ (consigliato 17+ per feature moderne) |

#### 3.2 Sostituti dei Componenti Esistenti

| Componente Attuale | Sostituto iOS | Note |
|---|---|---|
| `customtkinter` (GUI) | **SwiftUI** | Framework nativo Apple. Dark mode nativo, responsive, adaptive layout |
| `pymupdf` (PDF render) | **PDFKit** + **Core Graphics** | Framework Apple nativo. Rendering PDF, estrazione testo nativo, thumbnail |
| `openai` Python client | **AsyncHTTPClient** (Swift) + REST | Chiamate HTTP dirette all'API OpenAI-compatible di LM Studio |
| `threading` + `queue` | **Swift Concurrency** (`async`/`await`, `Task`, `Actor`) | Modello moderno di concorrenza nativo in Swift |
| `tempfile` | **FileManager.default.temporaryDirectory** | Equivalente iOS del temp directory |

#### 3.3 Architettura Proposta

```
LocalOCRIOS (SwiftUI App)
│
├── App Entry Point
│   └── LocalOCRApp.swift (@main)
│
├── Views (SwiftUI)
│   ├── MainView.swift          — Layout principale
│   ├── FilePickerView.swift    — Selezione file (PDF/immagine)
│   ├── SettingsView.swift      — URL server, modello, DPI
│   ├── ProgressView.swift      — Barra progresso + log
│   └── OutputView.swift        — Anteprima risultato .md
│
├── ViewModels (ObservableObject / Observable)
│   └── OCRViewModel.swift      — Stato + logica di coordinamento
│
├── Services
│   ├── PDFService.swift        — Rendering PDF, estrazione testo nativo
│   ├── ImageService.swift      — Gestione immagini
│   ├── VLMClient.swift         — Client HTTP per LM Studio
│   ├── FileService.swift       — Salvataggio/output file
│   └── ModelManager.swift      — Fetch lista modelli dal server
│
├── Models
│   ├── OCRSettings.swift       — URL, modello, DPI
│   ├── OCRTask.swift           — Rappresentazione di una task in corso
│   └── OCRLogEntry.swift       — Entry del log
│
└── Utilities
    ├── Image+Extensions.swift  — Utility per immagini
    └── String+Extensions.swift — Utility varie
```

#### 3.4 Vantaggi

- ✅ Performance ottimali (codice nativo compilato)
- ✅ Accesso completo alle API iOS (PDFKit, Photos, File system)
- ✅ Dark mode nativo, animazioni fluide
- ✅ Futura distribuzione su App Store possibile
- ✅ Swift Concurrency è moderno e ben supportato
- ✅ Tooling eccellente (Xcode, SwiftUI Preview, Instruments)

#### 3.5 Svantaggi

- ❌ Riscrittura completa del codice (niente riuso diretto)
- ❌ Curva di apprendimento Swift/SwiftUI se non si conosce
- ❌ Il codice Python originale diventa un riferimento, non una base

#### 3.6 Stima Sforzo

| Fase | Stima |
|---|---|
| Setup progetto Xcode + struttura | 2-3 ore |
| UI SwiftUI (dark theme, responsive) | 4-6 ore |
| PDFKit integration (render + text extraction) | 3-4 ore |
| VLM HTTP client (async, base64, JSON) | 3-4 ore |
| File picker + output saving | 2-3 ore |
| Concurrency + progress + log | 2-3 ore |
| Testing su iPad + bug fixing | 3-4 ore |
| **Totale stimato** | **~20-27 ore** |

---

### Opzione B — Flutter

Usare Flutter (Dart) per un'app cross-platform compilata nativamente.

#### 3.7 Stack Flutter

| Componente | Tecnologia |
|---|---|
| **Linguaggio** | Dart 3.x |
| **UI Framework** | Flutter Widgets |
| **Build** | Flutter CLI + Xcode (per iOS build) |
| **Minimo iOS** | 12.0 (default Flutter) |

#### 3.8 Sostituti dei Componenti

| Componente Attuale | Sostituto Flutter | Pacchetto |
|---|---|---|
| `customtkinter` (GUI) | Flutter Widgets | Built-in |
| `pymupdf` (PDF) | `pdf` + `printing` / `syncfusion_flutter_pdf` | pub.dev |
| `openai` client | `http` / `dio` | pub.dev |
| `threading` | `compute()` / `Isolate` | Built-in |

#### 3.9 Vantaggi

- ✅ Possibilità di ri-targetare anche Android in futuro
- ✅ Hot reload accelera lo sviluppo UI
- ✅ Dart è più simile a Python di Swift (tipi opzionali, async/await)
- ✅ Hot reload per iterazione rapida

#### 3.10 Svantaggi

- ❌ Bundle size maggiore (~10-20MB solo framework)
- ❌ PDF rendering su Flutter è meno maturo di PDFKit nativo
- ❌ Performance inferiori al nativo per rendering grafico intensivo
- ❌ Debugging su iOS richiede Xcode comunque
- ❌ Aggiornamenti iOS: Flutter deve essere aggiornato per supportare nuove API

#### 3.11 Stima Sforzo

| Fase | Stima |
|---|---|
| Setup Flutter + Xcode | 2-3 ore |
| UI Flutter (dark theme) | 3-5 ore |
| PDF handling | 4-6 ore (più complesso del nativo) |
| VLM HTTP client | 2-3 ore |
| File picker + output | 2-3 ore |
| Testing + bug fixing | 3-4 ore |
| **Totale stimato** | **~16-24 ore** |

---

### Opzione C — Python su iOS (CircuitPython / Briefcase)

Tentare di mantenere il codice Python esistente.

#### 3.12 Opzioni Python

| Approccio | Fattibilità | Note |
|---|---|---|
| **BeeWare (Toga/Briefcase)** | ⚠️ Limitata | Briefcase compila Python per iOS. Toga è la GUI. Supporto iOS esiste ma è **sperimentale**. Python runtime incluso nel bundle. |
| **Pyto / Pythonista-style** | ❌ Non applicabile | Questi sono interpreti Python su iOS, non framework di sviluppo |
| **Chameleon** | ❌ Obsoleto | Non più mantenuto |

#### 3.13 Analisi BeeWare/Briefcase

```
BeeWare (Toga + Briefcase)
  │
  ├─ Toga: GUI toolkit cross-platform (sostituto di tkinter)
  ├─ Briefcase: build tool che impacchetta Python per iOS
  │
  ├─ PRO: riusa la maggior parte del codice Python esistente
  ├─ PRO: Toga ha widget simili a tkinter
  │
  ├─ CONTRO: supporto iOS ancora maturo
  ├─ CONTRO: performance inferiori al nativo
  ├─ CONTRO: pymupdf potrebbe non compilare per iOS (C extension)
  ├─ CONTRO: bundle size molto grande (Python runtime + extensions)
  ├─ CONTRO: debugging complesso
  └─ CONTRO: Apple potrebbe rifiutare app con interprete script
```

> **Verdetto:** Non raccomandato per questo progetto. Il rischio di problemi di compilazione delle C extensions (`pymupdf`) e la maturità limitata del supporto iOS di BeeWare rendono questa opzione troppo rischiosa.

---

### Opzione C — React Native

Usare React Native per un'app iOS compilata nativamente.

#### 3.14 Stack React Native

| Componente | Tecnologia |
|---|---|
| **Linguaggio** | TypeScript / JavaScript |
| **UI Framework** | React Native (components nativi) |
| **Build** | Xcode (per iOS) |
| **Minimo iOS** | 13.0+ |

#### 3.15 Sostituti dei Componenti

| Componente Attuale | Sostituto RN |
|---|---|
| `customtkinter` | React Native Components |
| `pymupdf` | `react-native-pdf` / bridge nativo PDFKit |
| `openai` client | `fetch` / `axios` |
| `threading` | `Promise` / `Worker Threads` |

#### 3.16 Vantaggi

- ✅ Componenti UI nativi (non renderizzati, come Flutter)
- ✅ Grande ecosistema di librerie
- ✅ Possibilità Android futuro

#### 3.17 Svantaggi

- ❌ PDFKit bridge richiede codice nativo Swift/Objective-C comunque
- ❌ Gestione immagini e base64 più complessa che in Swift
- ❌ Debugging su iOS può essere problematico (Metro bundler + Xcode)
- ❌ Aggiornamenti iOS richiedono aggiornamento React Native

#### 3.18 Stima Sforzo

Simile a Flutter: **~18-25 ore**, con overhead aggiuntivo per i bridge nativi PDF.

---

## 4. Gestione del VLM (LM Studio) su iOS

Il componente critico è il VLM. LM Studio è desktop-only. Su iOS, le opzioni sono:

### 4.1 Opzione 1 — LM Studio come Server di Rete (Conservativa)

Mantenere LM Studio in esecuzione sul Mac (o un altro device sulla rete locale) e far comunicare l'app iPad con il server via HTTP.

```
┌─────────────┐     WiFi/LAN     ┌──────────────────┐
│  iPad       │ ──────────────►  │  Mac              │
│  (App iOS)  │   REST API       │  (LM Studio)      │
│             │   :1234/v1       │                   │
└─────────────┘                  └──────────────────┘
```

**Vantaggi:**
- ✅ Niente cambiamento nella pipeline AI
- ✅ Il VLM gira su hardware potente (Mac con GPU dedicata)
- ✅ Niente problema di spazio storage per i modelli
- ✅ Stesso sistema di prompt e configurazione

**Svantaggi:**
- ❌ Richiede connessione di rete (anche se solo LAN)
- ❌ Latenza di rete per ogni pagina
- ❌ Il Mac deve restare acceso

### 4.2 Opzione 2 — Core ML (On-Device)

Usare modelli Core ML per OCR direttamente sull'iPad.

```
┌─────────────┐
│  iPad       │
│  ┌─────────┐│
│  │ Core ML ││  Modello VLM on-device
│  │ (VLM)   ││  (es. LLaVA, Moondream)
│  └─────────┘│
└─────────────┘
```

**Vantaggi:**
- ✅ Funziona offline
- ✅ Niente latenza di rete
- ✅ Privacy totale (i dati non lasciano il device)

**Svantaggi:**
- ❌ Modelli VLM sono pesanti (2-8GB+). Spazio limitato
- ❌ Performance su iPad inferiore al Mac con GPU dedicata
- ❌ Conversione modello → Core ML (.mlmodel) richiede tooling
- ❌ Non tutti i VLM supportano Core ML
- ❌ Heating/battery drain significativo

**Tooling per Core ML:**
- `MLModel` conversion via `coremltools` (Python)
- Apple MLX framework (per Apple Silicon, ma non direttamente su iOS)
- `llama.cpp` con delegate Core ML (sperimentale)

### 4.3 Opzione 3 — Ibrida (Raccomandata per MVP)

Fase 1: Server di rete (LM Studio sul Mac)
Fase 2: Aggiungere supporto Core ML opzionale per uso offline

```
┌────────────────────────────────────────┐
│  App iOS                               │
│  ┌──────────────────────────────────┐  │
│  │  Settings:                        │  │
│  │  ○ Use local server (LM Studio)  │  │
│  │  ○ Use on-device model (Core ML) │  │
│  └──────────────────────────────────┘  │
└────────────────────────────────────────┘
```

---

## 5. Estrazione Testo da PDF su iOS

### 5.1 PDFKit (Framework Apple Nativo)

PDFKit è il sostituto diretto di `pymupdf` su iOS.

```swift
import PDFKit

// Aprire un PDF
let document = PDFDocument(url: fileURL)

// Estrazione testo nativo (equivalente di page.get_text())
let page = document?.page(at: 0)
let textString = page?.string  // Testo nativo della pagina

// Rendering pagina come immagine (equivalente di get_pixmap(dpi:))
let pdfPage = page!
let renderer = PDFRenderer(pdfPage: pdfPage)
let image = renderer.image(
    for: pdfPage.bounds(for: .mediaBox),
    pageFrame: pdfPage.bounds(for: .mediaBox)
)
```

**Capacità di PDFKit:**
- ✅ Apertura PDF (inclusi PDF password-protetti)
- ✅ Estrazione testo nativo (per PDF non-scansionati)
- ✅ Rendering pagina → UIImage (configurabile risoluzione)
- ✅ Supporto annotazioni, form, layered PDF
- ✅ Integrato con SwiftUI via `PDFKit` bridge

**Limitazioni rispetto a PyMuPDF:**
- ❌ Non supporta PDF con struttura complessa (XMP metadata avanzata)
- ❌ Rendering DPI non configurabile con la stessa granularità
- ❌ Non ha OCR integrato (serve il VLM comunque per pagine scansionate)

### 5.2 Strategia Ibrida (come il codice Python attuale)

Mantenere la logica "hybrid" del codice attuale:
1. Prova estrazione testo nativo con PDFKit
2. Se la pagina ha testo nativo sufficiente → usa quello
3. Altrimenti → rendera pagina → invia a VLM

---

## 6. UI/UX Considerazioni per iPad

### 6.1 Layout iPad-Specifico

| Considerazione | Dettaglio |
|---|---|
| **Multi-tasking** | iPad supporta Split View e Slide Over. L'UI deve essere responsive |
| **Keyboard** | Keyboard fisica o virtuale può coprire parte dello schermo. Usare `keyboardLayoutGuide` |
| **Gesture** | Swipe, pinch-to-zoom per anteprima PDF |
| **Dark Mode** | SwiftUI supporta dark mode nativo con `@Environment(\.colorScheme)` |
| **Safe Area** | Gestire notch, home indicator, rounded corners |

### 6.2 File Selection su iPad

```swift
// Document Picker (per PDF dal Files app)
import UIKit

func presentFilePicker() {
    let picker = UIDocumentPickerViewController(
        forOpeningContentTypes: [.pdf, .png, .jpeg, .webP],
        asCopy: true
    )
    picker.delegate = self
    present(picker, animated: true)
}

// Photo Library Picker (per immagini dalla galleria)
import PhotosUI

func presentPhotoPicker() {
    var config = PHPickerConfiguration()
    config.filter = .images
    let picker = PHPickerViewController(configuration: config)
    present(picker, animated: true)
}
```

### 6.3 Salvataggio Output

```swift
// Export del file .md generato
func saveMarkdown(_ content: String, named: String) {
    let picker = UIDocumentPickerViewController(
        forExporting: [outputURL],
        asCopy: true
    )
    present(picker, animated: true)
}
```

---

## 7. Librerie e Dipendenze Richieste

### 7.1 Frameworks Apple (Built-in, nessuna installazione)

| Framework | Scopo |
|---|---|
| **SwiftUI** | UI framework declarativo |
| **PDFKit** | Apertura, rendering ed estrazione testo da PDF |
| **UIKit** | Document picker, file management, alert |
| **PhotosUI** | Selezione immagini dalla libreria foto |
| **UniformTypeIdentifiers** | Gestione tipi file (MIME types) |
| **Foundation** | URL handling, JSON, data encoding |
| **Combine** | Reactive programming (opzionale) |

### 7.2 Swift Package Manager Dependencies

| Pacchetto | Scopo | Necessario? |
|---|---|---|
| **Nessuno richiesto** | Per la versione base con server remoto, tutto è built-in | — |
| `swift-markdown` (Apple) | Rendering markdown nell'output | Opzionale |
| `Logging` (swift-log) | Logging strutturato | Opzionale |

> **Nota importante:** Per la fase 1 (MVP) con LM Studio come server remoto, **non servono dipendenze di terze parti**. Tutto il necessario è nei framework Apple built-in.

### 7.3 Se si aggiunge supporto Core ML (Fase 2)

| Pacchetto | Scopo |
|---|---|
| `CoreML` framework | Esecuzione modelli ML on-device |
| `NaturalLanguage` framework | Tokenizzazione testo |
| `llama.cpp` (via SPM) | Inference LLM on-device (sperimentale) |

---

## 8. Struttura Progetto Xcode

```
LocalOCRIOS.xcodeproj/
├── LocalOCRIOS/
│   ├── LocalOCRApp.swift              // @main entry point
│   │
│   ├── Views/
│   │   ├── MainView.swift             // View principale con tab/navigation
│   │   ├── FileSelectionView.swift    // Picker file (PDF + immagini)
│   │   ├── SettingsView.swift         // URL, modello, DPI, modalità VLM
│   │   ├── ProcessingView.swift       // Progress bar + log real-time
│   │   ├── OutputView.swift           // Anteprima markdown risultato
│   │   └── Components/
│   │       ├── LogEntryView.swift     // Singola entry del log
│   │       └── StatusBadge.swift      // Indicatore stato
│   │
│   ├── ViewModels/
│   │   └── OCRViewModel.swift         // @Observable stato + business logic
│   │
│   ├── Services/
│   │   ├── PDFService.swift           // PDFKit wrapper
│   │   ├── ImageService.swift         // UIImage processing
│   │   ├── VLMClient.swift            // HTTP client per LM Studio
│   │   ├── FileService.swift          // File I/O nel sandbox
│   │   └── ModelManager.swift         // Fetch modelli dal server
│   │
│   ├── Models/
│   │   ├── OCRSettings.swift          // Struct impostazioni
│   │   ├── OCRTask.swift              // Task in corso
│   │   ├── OCRLogEntry.swift          // Entry log
│   │   └── VLMResponse.swift          // Decodifica risposta VLM
│   │
│   ├── Utilities/
│   │   ├── Image+Base64.swift         // Extension UIImage → base64
│   │   ├── URL+Helpers.swift          // Extension URL
│   │   └── Constants.swift            // Prompt, default values
│   │
│   ├── Resources/
│   │   ├── Assets.xcassets            // Icone, colori tema
│   │   └── Info.plist                 // Permessi, document types
│   │
│   └── LocalOCRIOS.entitlements       // Entitlements development
│
└── Tests/
    └── LocalOCRIOSTests/
        ├── VLMClientTests.swift
        ├── PDFServiceTests.swift
        └── OCRViewModelTests.swift
```

---

## 9. Mappatura Funzionalità (Python → Swift)

| Funzionalità Python | Equivalente iOS/Swift | Note |
|---|---|---|
| `filedialog.askopenfilename()` | `UIDocumentPickerViewController` + `PHPickerViewController` | Due picker separati: Files + Photos |
| `customtkinter` dark theme | SwiftUI `colorScheme(.dark)` | Nativo, segue sistema |
| `fitz.open(filepath)` | `PDFDocument(url:)` | PDFKit nativo |
| `page.get_text("text")` | `PDFPage.string` | Estrazione testo nativo |
| `page.get_pixmap(dpi=N)` | `PDFRenderer.image(for:pageFrame)` | DPI configurabile via scale factor |
| `base64.b64encode()` | `Data.base64EncodedString()` | Built-in Foundation |
| `openai.OpenAI().chat.completions.create()` | `URLSession.shared.async` + JSON | Stesso API OpenAI-compatible |
| `threading.Thread` | `Task { ... }` (Swift Concurrency) | Async/await nativo |
| `queue.Queue` | `@MainActor` + `@Observable` | State management reattivo |
| `tempfile.mkdtemp()` | `FileManager.default.temporaryDirectory` | Equivalente iOS |
| `shutil.rmtree()` | `FileManager.default.removeItem(at:)` | Cleanup temp files |
| `messagebox.showinfo()` | SwiftUI `.alert()` modifier | Alert nativo |
| `CTkProgressBar` | `ProgressView` / `ProgressBar` | SwiftUI built-in |
| `CTkTextbox` (log) | `ScrollView` + `LazyVStack` di log entries | Real-time scroll |

---

## 10. System Prompt (Invariato)

Il system prompt per il VLM rimane identico:

```
Convert this image into Markdown text format. Your task is to perform
high-accuracy Optical Character Recognition (OCR). Preserve the document's
structure as accurately as possible: headers, lists, and tables. Do not add
any greetings, explanations, or introductory/concluding remarks. Output only
the raw recognized text.
```

L'API call al VLM (LM Studio) è identica: stesso endpoint OpenAI-compatible, stessa struttura JSON, stesso base64 encoding delle immagini.

---

## 11. Piano di Sviluppo Raccomandato

### Fase 1 — Setup e Scheletro (Giorno 1-2)

- [ ] Creare progetto Xcode (SwiftUI, iOS target, iPad)
- [ ] Configurare code signing (automatic, development)
- [ ] Strutturare il progetto (Views, Services, Models, ViewModels)
- [ ] Implementare navigazione base
- [ ] Test deploy su iPad

### Fase 2 — UI Core (Giorno 2-4)

- [ ] File selection view (UIDocumentPicker + PHPicker)
- [ ] Settings view (URL entry, model selector, DPI picker)
- [ ] Processing view (progress + log real-time)
- [ ] Dark theme consistente
- [ ] Responsive layout per iPad (Split View ready)

### Fase 3 — PDF Service (Giorno 4-5)

- [ ] Apertura PDF con PDFKit
- [ ] Rilevamento testo nativo per pagina (equivalente `_is_text_page`)
- [ ] Estrazione testo nativo
- [ ] Rendering pagina → UIImage (configurabile risoluzione)
- [ ] Gestione immagini (PNG, JPG, WebP)

### Fase 4 — VLM Client (Giorno 5-6)

- [ ] HTTP client async per LM Studio
- [ ] Costruzione richiesta OpenAI-compatible (messages, base64 image)
- [ ] Decodifica risposta JSON
- [ ] Fetch lista modelli
- [ ] Error handling (timeout, connection refused, server error)

### Fase 5 — Integrazione e Testing (Giorno 6-7)

- [ ] Wire tutto insieme tramite ViewModel
- [ ] Flusso completo: seleziona file → OCR → salva .md
- [ ] Salvataggio output con document picker
- [ ] Test su iPad con LM Studio sul Mac
- [ ] Bug fixing e polish

---

## 12. Rischi e Mitigazioni

| Rischio | Probabilità | Impatto | Mitigazione |
|---|---|---|---|
| LM Studio non raggiungibile dalla rete | Media | Alto | Implementare retry logic + messaggi chiari. Testare con IP statico del Mac |
| PDFKit non estrae testo da PDF complessi | Bassa | Medio | Fallback al VLM per tutte le pagine (opzione "Force VLM") |
| Immagini base64 troppo grandi per l'API | Media | Medio | Implementare resize immagine prima dell'invio |
| Background task kill durante OCR lungo | Media | Medio | Registrare background task con `beginBackgroundTask` |
| Memory pressure su PDF molto grandi | Bassa | Alto | Processare pagine in sequenza, rilasciare memory tra pagine |
| WebP non supportato da UIKit | Bassa | Basso | Convertire WebP → PNG con `ImageIO` |

---

## 13. Confronto Finale delle Opzioni

| Criterio | A. Swift Nativo | B. Flutter | C. BeeWare | D. React Native |
|---|---|---|---|---|
| **Performance** | ⭐⭐⭐⭐⭐ | ⭐⭐⭐⭐ | ⭐⭐ | ⭐⭐⭐⭐ |
| **Accesso API native** | ⭐⭐⭐⭐⭐ | ⭐⭐⭐ | ⭐⭐ | ⭐⭐⭐ |
| **Riuso codice Python** | ❌ Niente | ❌ Niente | ⚠️ Parziale | ❌ Niente |
| **Maturità iOS** | ⭐⭐⭐⭐⭐ | ⭐⭐⭐⭐ | ⭐⭐ | ⭐⭐⭐⭐ |
| **App Store readiness** | ⭐⭐⭐⭐⭐ | ⭐⭐⭐⭐ | ⭐⭐ | ⭐⭐⭐ |
| **Sviluppo futuro** | ⭐⭐⭐⭐⭐ | ⭐⭐⭐⭐ | ⭐ | ⭐⭐⭐ |
| **Bundle size** | ~5-10MB | ~15-25MB | ~50-100MB+ | ~20-30MB |
| **Learning curve** | Media | Bassa-Media | Bassa | Media |
| **Dipendenze esterne** | Zero | Molte | Molte | Molte |

---

## 14. Raccomandazione

**Opzione A (Swift Nativo / SwiftUI)** è la scelta raccomandata per i seguenti motivi:

1. **Zero dipendenze esterne** — Tutti i framework necessari (PDFKit, SwiftUI, Foundation) sono built-in in iOS. Il progetto è leggero e manutenibile.

2. **Performance ottimali** — Codice nativo compilato, nessun overhead di interprete o bridge.

3. **MVP rapido** — La fase 1 (server remoto LM Studio) può essere completata in ~1 settimana di sviluppo.

4. **Futuro-proof** — Se in futuro si vuole distribuire su App Store, l'app è già pronta. Se si vuole aggiungere Core ML per OCR offline, i framework sono già disponibili.

5. **Nessun problema legale** — A differenza di `pymupdf` (AGPL), i framework Apple sono utilizzabili liberamente.

### Next Steps

1. Creare il progetto Xcode sulla branch `feature/ios-porting`
2. Implementare lo scheletro SwiftUI
3. Partire dal flusso più semplice: immagine singola → VLM remoto → output .md
4. Estendere a PDF multi-pagina con logica ibrida
5. Testare su iPad con LM Studio sul Mac

---

*Documento generato il 2026-08-01 — Branch: `feature/ios-porting`*
