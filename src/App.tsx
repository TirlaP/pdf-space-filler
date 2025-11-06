import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type {
  ChangeEvent,
  DragEvent as ReactDragEvent,
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
} from 'react';
import {
  GlobalWorkerOptions,
  getDocument,
  type PDFDocumentProxy,
  type RenderTask,
} from 'pdfjs-dist';
import workerSrc from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { detectFields } from './utils/detection';
import {
  usePdfStore,
  type Field,
  type PageMeta,
  type PdfDocumentRecord,
} from './store/usePdfStore';
import { createZipFromFiles } from './utils/zip';
import './App.css';

GlobalWorkerOptions.workerSrc = workerSrc;

const MIN_FIELD_WIDTH = 80;
const MIN_FIELD_HEIGHT = 22;
const EXPORT_FIELD_TEXT_COLOR = rgb(0.2, 0.2, 0.2);
const EXPORT_FIELD_BORDER_WIDTH = 0;
const EXPORT_FIELD_BACKGROUND_COLOR = rgb(0.95, 0.95, 0.95);
const EXPORT_FIELD_FONT_SIZE = 10;

const clamp = (value: number, min: number, max: number) =>
  Math.min(Math.max(value, min), max);

const generateFieldId = () =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `field_${Math.random().toString(36).slice(2, 9)}`;

const generateDocumentId = () =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `doc_${Math.random().toString(36).slice(2, 9)}`;

type FieldOverlayProps = {
  field: Field;
  pageMeta: PageMeta;
  selected: boolean;
  onSelect: (id: string) => void;
  onUpdate: (id: string, updates: Partial<Field>) => void;
};

const FieldOverlay = ({
  field,
  pageMeta,
  selected,
  onSelect,
  onUpdate,
}: FieldOverlayProps) => {
  const ref = useRef<HTMLDivElement>(null);

  const startInteraction = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      event.preventDefault();
      event.stopPropagation();
      if (event.button !== 0) return;

      const target = event.target as HTMLElement;
      const handle = target.dataset.handle as
        | 'nw'
        | 'ne'
        | 'sw'
        | 'se'
        | undefined;

      onSelect(field.id);

      const origin = {
        pointerX: event.clientX,
        pointerY: event.clientY,
        x: field.x,
        y: field.y,
        width: field.width,
        height: field.height,
      };

      const onPointerMove = (moveEvent: PointerEvent) => {
        moveEvent.preventDefault();
        const dx = moveEvent.clientX - origin.pointerX;
        const dy = moveEvent.clientY - origin.pointerY;

        if (!handle) {
          const nextX = clamp(origin.x + dx, 0, pageMeta.width - origin.width);
          const nextY = clamp(origin.y + dy, 0, pageMeta.height - origin.height);
          onUpdate(field.id, { x: nextX, y: nextY });
          return;
        }

        let next = { ...origin };

        if (handle.includes('n')) {
          const newY = clamp(origin.y + dy, 0, origin.y + origin.height - MIN_FIELD_HEIGHT);
          const heightDelta = origin.y - newY;
          next = {
            ...next,
            y: newY,
            height: clamp(origin.height + heightDelta, MIN_FIELD_HEIGHT, pageMeta.height),
          };
        }

        if (handle.includes('s')) {
          const maxHeight = pageMeta.height - origin.y;
          const newHeight = clamp(origin.height + dy, MIN_FIELD_HEIGHT, maxHeight);
          next = { ...next, height: newHeight };
        }

        if (handle.includes('w')) {
          const newX = clamp(origin.x + dx, 0, origin.x + origin.width - MIN_FIELD_WIDTH);
          const widthDelta = origin.x - newX;
          next = {
            ...next,
            x: newX,
            width: clamp(origin.width + widthDelta, MIN_FIELD_WIDTH, pageMeta.width),
          };
        }

        if (handle.includes('e')) {
          const maxWidth = pageMeta.width - origin.x;
          const newWidth = clamp(origin.width + dx, MIN_FIELD_WIDTH, maxWidth);
          next = { ...next, width: newWidth };
        }

        const boundedX = clamp(next.x, 0, pageMeta.width - next.width);
        const boundedY = clamp(next.y, 0, pageMeta.height - next.height);

        onUpdate(field.id, {
          x: boundedX,
          y: boundedY,
          width: Math.min(next.width, pageMeta.width - boundedX),
          height: Math.min(next.height, pageMeta.height - boundedY),
        });
      };

      const onPointerUp = () => {
        window.removeEventListener('pointermove', onPointerMove);
        window.removeEventListener('pointerup', onPointerUp);
      };

      window.addEventListener('pointermove', onPointerMove);
      window.addEventListener('pointerup', onPointerUp, { once: true });
    },
    [field.id, field.height, field.width, field.x, field.y, onSelect, onUpdate, pageMeta.height, pageMeta.width],
  );

  return (
    <div
      ref={ref}
      role="button"
      tabIndex={0}
      onPointerDown={startInteraction}
      onKeyDown={(event) => {
        if (event.key === 'Delete' || event.key === 'Backspace') {
          event.preventDefault();
        }
      }}
      className={`field-overlay${selected ? ' selected' : ''}`}
      style={{
        left: `${field.x}px`,
        top: `${field.y}px`,
        width: `${field.width}px`,
        height: `${field.height}px`,
      }}
    >
      {['nw', 'ne', 'sw', 'se'].map((pos) => (
        <span
          key={pos}
          className={`field-overlay__handle field-overlay__handle--${pos}`}
          data-handle={pos}
        />
      ))}
    </div>
  );
};

type PageViewProps = {
  pdfDoc: PDFDocumentProxy;
  pageMeta: PageMeta;
  fields: Field[];
  selectedFieldId?: string;
  onSelectField: (id?: string) => void;
  onFieldChange: (id: string, updates: Partial<Field>) => void;
  onAddFieldAt: (pageIndex: number, x: number, y: number) => void;
};

const PageView = ({
  pdfDoc,
  pageMeta,
  fields,
  selectedFieldId,
  onSelectField,
  onFieldChange,
  onAddFieldAt,
}: PageViewProps) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    let renderTask: RenderTask | null = null;

    const renderPage = async () => {
      const canvas = canvasRef.current;
      if (!canvas) return;

      const page = await pdfDoc.getPage(pageMeta.index + 1);
      const viewport = page.getViewport({ scale: pageMeta.scale });

      canvas.width = viewport.width;
      canvas.height = viewport.height;
      canvas.style.width = `${viewport.width}px`;
      canvas.style.height = `${viewport.height}px`;

      const task = page.render({ canvas, viewport });
      renderTask = task;

      try {
        await task.promise;
      } catch (renderError) {
        if (
          !(renderError instanceof Error) ||
          renderError.name !== 'RenderingCancelledException'
        ) {
          console.error(renderError);
        }
      } finally {
        if (!cancelled) {
          page.cleanup();
        }
        renderTask = null;
      }
    };

    renderPage();

    return () => {
      cancelled = true;
      if (renderTask) {
        renderTask.cancel();
      }
    };
  }, [pdfDoc, pageMeta.index, pageMeta.scale]);

  const handleDoubleClick = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>) => {
      const container = containerRef.current;
      if (!container) return;
      const rect = container.getBoundingClientRect();
      const x = event.clientX - rect.left;
      const y = event.clientY - rect.top;
      onAddFieldAt(pageMeta.index, x, y);
    },
    [onAddFieldAt, pageMeta.index],
  );

  const fieldsOnPage = fields.filter((field) => field.pageIndex === pageMeta.index);

  return (
    <div className="page-wrapper">
      <div
        ref={containerRef}
        className="page-layer"
        style={{ width: pageMeta.width, height: pageMeta.height }}
        onDoubleClick={handleDoubleClick}
        onPointerDown={(event) => {
          if (event.target === containerRef.current) {
            onSelectField(undefined);
          }
        }}
      >
        <canvas ref={canvasRef} />
        {fieldsOnPage.map((field) => (
          <FieldOverlay
            key={field.id}
            field={field}
            pageMeta={pageMeta}
            selected={field.id === selectedFieldId}
            onSelect={(id) => onSelectField(id)}
            onUpdate={onFieldChange}
          />
        ))}
      </div>
    </div>
  );
};

type FieldListProps = {
  fields: Field[];
  selectedFieldId?: string;
  onSelectField: (id: string) => void;
  onUpdateField: (id: string, updates: Partial<Field>) => void;
  onDeleteField: (id: string) => void;
};

const FieldList = ({
  fields,
  selectedFieldId,
  onSelectField,
  onUpdateField,
  onDeleteField,
}: FieldListProps) => {
  const sorted = useMemo(
    () =>
      [...fields].sort(
        (a, b) =>
          a.pageIndex - b.pageIndex || a.y - b.y || a.x - b.x || a.name.localeCompare(b.name),
      ),
    [fields],
  );

  if (!sorted.length) {
    return (
      <div className="field-list__empty">
        No fields yet. Double-click on a page or run auto-detect to add fields.
      </div>
    );
  }

  return (
    <div className="field-list">
      {sorted.map((field) => {
        const isSelected = field.id === selectedFieldId;
        return (
          <div
            key={field.id}
            className={`field-list__item${isSelected ? ' field-list__item--active' : ''}`}
            onClick={() => onSelectField(field.id)}
          >
            <div className="field-list__header">
              <span className="field-list__title">
                Page {field.pageIndex + 1}
              </span>
              <button
                type="button"
                className="field-list__delete"
                onClick={(event) => {
                  event.stopPropagation();
                  onDeleteField(field.id);
                }}
              >
                Remove
              </button>
            </div>
            <label className="field-list__label">
              Name
              <input
                type="text"
                value={field.name}
                onChange={(event) =>
                  onUpdateField(field.id, { name: event.target.value })
                }
                onBlur={(event) => {
                  const value = event.target.value.trim();
                  const fallback = `page${field.pageIndex + 1}_field_${field.id.slice(-4)}`;
                  const nextValue = value.length ? value : fallback;
                  if (event.target.value !== nextValue) {
                    event.target.value = nextValue;
                  }
                  onUpdateField(field.id, {
                    name: nextValue,
                  });
                }}
              />
            </label>
            <label className="field-list__label">
              Placeholder (optional)
              <input
                type="text"
                value={field.placeholder ?? ''}
                onChange={(event) =>
                  onUpdateField(field.id, { placeholder: event.target.value })
                }
              />
            </label>
            <label className="field-list__checkbox">
              <input
                type="checkbox"
                checked={field.multiline}
                onChange={(event) =>
                  onUpdateField(field.id, { multiline: event.target.checked })
                }
              />
              Multiline
            </label>
            {typeof field.confidence === 'number' && (
              <p className="field-list__confidence">
                Auto-detect confidence: {(field.confidence * 100).toFixed(0)}%
              </p>
            )}
          </div>
        );
      })}
    </div>
  );
};

type DocumentListProps = {
  documents: PdfDocumentRecord[];
  activeDocumentId?: string;
  processingDocumentId?: string;
  onSelect: (documentId: string) => void;
  onRemove: (documentId: string) => void;
};

const DocumentList = ({
  documents,
  activeDocumentId,
  processingDocumentId,
  onSelect,
  onRemove,
}: DocumentListProps) => {
  if (!documents.length) {
    return (
      <aside className="documents-panel">
        <div className="documents-panel__header">
          <h2>Documents</h2>
        </div>
        <p className="documents-panel__empty">
          Upload one or more PDFs to begin.
        </p>
      </aside>
    );
  }

  return (
    <aside className="documents-panel">
      <div className="documents-panel__header">
        <h2>Documents</h2>
        <span className="documents-panel__count">{documents.length}</span>
      </div>
      <div className="documents-panel__list">
        {documents.map((document) => {
          const isActive = document.id === activeDocumentId;
          const isProcessing = document.id === processingDocumentId;
          return (
            <div
              key={document.id}
              role="button"
              tabIndex={0}
              className={`documents-panel__item${isActive ? ' documents-panel__item--active' : ''}`}
              onClick={() => onSelect(document.id)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  onSelect(document.id);
                }
              }}
            >
              <span className="documents-panel__name" title={document.fileName}>
                {document.fileName}
              </span>
              <span className="documents-panel__meta">
                {document.fields.length} field{document.fields.length === 1 ? '' : 's'}
                {isProcessing && <span className="documents-panel__status">Detecting…</span>}
              </span>
              <span className="documents-panel__remove">
                <button
                  type="button"
                  onClick={(event) => {
                    event.stopPropagation();
                    onRemove(document.id);
                  }}
                  aria-label={`Remove ${document.fileName}`}
                >
                  ✕
                </button>
              </span>
            </div>
          );
        })}
      </div>
    </aside>
  );
};

async function buildFillablePdf(document: PdfDocumentRecord): Promise<Uint8Array> {
  const pdfDocInstance = await PDFDocument.load(document.documentData.slice());
  const form = pdfDocInstance.getForm();
  const font = await pdfDocInstance.embedFont(StandardFonts.Helvetica);
  const nameUsage = new Map<string, number>();

  document.fields.forEach((field) => {
    const pageMeta = document.pages[field.pageIndex];
    if (!pageMeta) return;
    const page = pdfDocInstance.getPage(field.pageIndex);
    const scale = pageMeta.scale;

    const x = field.x / scale;
    const yFromTop = field.y / scale;
    const width = field.width / scale;
    const height = field.height / scale;
    const y = pageMeta.originalHeight - yFromTop - height;

    const baseName = field.name || 'field';
    const usageCount = nameUsage.get(baseName) ?? 0;
    nameUsage.set(baseName, usageCount + 1);
    const uniqueName = usageCount === 0 ? baseName : `${baseName}_${usageCount + 1}`;

    const textField = form.createTextField(uniqueName);
    textField.setText(field.placeholder ?? '');
    textField.addToPage(page, {
      x,
      y,
      width,
      height,
      textColor: EXPORT_FIELD_TEXT_COLOR,
      backgroundColor: EXPORT_FIELD_BACKGROUND_COLOR,
      borderColor: undefined,
      borderWidth: EXPORT_FIELD_BORDER_WIDTH,
    });
    textField.setFontSize(EXPORT_FIELD_FONT_SIZE);
    textField.updateAppearances(font);
    if (field.multiline) {
      textField.enableMultiline();
    }
  });

  form.updateFieldAppearances(font);
  return pdfDocInstance.save();
}

function App() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [detecting, setDetecting] = useState(false);
  const [detectingDocumentId, setDetectingDocumentId] = useState<string | undefined>();
  const [exporting, setExporting] = useState(false);
  const [exportingAll, setExportingAll] = useState(false);
  const [isDragActive, setIsDragActive] = useState(false);
  const dragCounterRef = useRef(0);

  const documents = usePdfStore((state) => state.documents);
  const activeDocumentId = usePdfStore((state) => state.activeDocumentId);
  const setActiveDocument = usePdfStore((state) => state.setActiveDocument);
  const addDocument = usePdfStore((state) => state.addDocument);
  const removeDocument = usePdfStore((state) => state.removeDocument);
  const addField = usePdfStore((state) => state.addField);
  const updateField = usePdfStore((state) => state.updateField);
  const removeField = usePdfStore((state) => state.removeField);
  const mergeFields = usePdfStore((state) => state.mergeFields);
  const selectField = usePdfStore((state) => state.selectField);

  const activeDocument = useMemo(
    () => documents.find((document) => document.id === activeDocumentId),
    [documents, activeDocumentId],
  );

  const ingestFiles = useCallback(
    async (files: File[]) => {
      if (!files.length) return;
      setError(null);
      setLoading(true);
      setDetecting(false);
      setExporting(false);
      setExportingAll(false);

      for (const file of files) {
        if (!file.name.toLowerCase().endsWith('.pdf')) {
          setError('Please upload PDF documents (.pdf).');
          continue;
        }

        let loadingTask: ReturnType<typeof getDocument> | null = null;
        try {
          const buffer = await file.arrayBuffer();
          const pdfBytes = new Uint8Array(buffer);
          const workerBytes = pdfBytes.slice();
          loadingTask = getDocument({ data: workerBytes });
          const doc = await loadingTask.promise;
          const scale = 1.25;

          const metas: PageMeta[] = [];
          for (let pageIndex = 0; pageIndex < doc.numPages; pageIndex += 1) {
            const page = await doc.getPage(pageIndex + 1);
            const viewport = page.getViewport({ scale });
            const baseViewport = page.getViewport({ scale: 1 });
            metas.push({
              index: pageIndex,
              width: viewport.width,
              height: viewport.height,
              originalWidth: baseViewport.width,
              originalHeight: baseViewport.height,
              scale,
            });
            page.cleanup();
          }

          addDocument({
            id: generateDocumentId(),
            fileName: file.name,
            pdfDoc: doc,
            documentData: pdfBytes,
            pages: metas,
            fields: [],
          });
        } catch (loadError) {
          console.error(loadError);
          setError(`Failed to read ${file.name}. Make sure the file is not corrupted.`);
          if (loadingTask) {
            try {
              await loadingTask.destroy();
            } catch (destroyError) {
              console.error(destroyError);
            }
          }
        }
      }

      setLoading(false);
    },
    [addDocument],
  );

  const handleFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    const fileList = event.target.files;
    event.target.value = '';
    if (!fileList || !fileList.length) return;
    const files = Array.from(fileList);
    void ingestFiles(files);
  };

  const processDroppedFiles = useCallback(
    (files: FileList | null | undefined) => {
      if (!files || !files.length) {
        setError('No file detected. Try dropping PDF files.');
        return;
      }
      const pdfFiles = Array.from(files).filter(
        (file) => file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf'),
      );
      if (!pdfFiles.length) {
        setError('No PDFs found. Please drop PDF files.');
        return;
      }
      void ingestFiles(pdfFiles);
    },
    [ingestFiles],
  );

  const handleDragEnter = useCallback(
    (event: ReactDragEvent<HTMLDivElement>) => {
      const hasFiles = Array.from(event.dataTransfer?.types ?? []).includes('Files');
      if (!hasFiles) return;
      event.preventDefault();
      event.stopPropagation();
      dragCounterRef.current += 1;
      if (!loading) {
        setIsDragActive(true);
      }
    },
    [loading],
  );

  const handleDragOver = useCallback((event: ReactDragEvent<HTMLDivElement>) => {
    const hasFiles = Array.from(event.dataTransfer?.types ?? []).includes('Files');
    if (!hasFiles) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = 'copy';
  }, []);

  const handleDragLeave = useCallback((event: ReactDragEvent<HTMLDivElement>) => {
    const hasFiles = Array.from(event.dataTransfer?.types ?? []).includes('Files');
    if (!hasFiles) return;
    event.preventDefault();
    event.stopPropagation();
    dragCounterRef.current = Math.max(dragCounterRef.current - 1, 0);
    if (dragCounterRef.current === 0) {
      setIsDragActive(false);
    }
  }, []);

  const handleDrop = useCallback(
    (event: ReactDragEvent<HTMLDivElement>) => {
      const hasFiles = Array.from(event.dataTransfer?.types ?? []).includes('Files');
      if (!hasFiles) return;
      event.preventDefault();
      event.stopPropagation();

      dragCounterRef.current = 0;
      setIsDragActive(false);
      processDroppedFiles(event.dataTransfer?.files);
      event.dataTransfer?.clearData();
    },
    [processDroppedFiles],
  );

  const handleSelectDocument = useCallback(
    (documentId: string) => {
      setActiveDocument(documentId);
    },
    [setActiveDocument],
  );

  const handleRemoveDocument = useCallback(
    (documentId: string) => {
      removeDocument(documentId);
    },
    [removeDocument],
  );

  const handleAutoDetect = async () => {
    const snapshot = usePdfStore.getState().documents;
    if (!snapshot.length) return;
    setDetecting(true);
    setDetectingDocumentId(undefined);
    setError(null);

    for (const document of snapshot) {
      try {
        setDetectingDocumentId(document.id);
        const detected = await detectFields(document.pdfDoc, document.pages);
        mergeFields(document.id, detected);
      } catch (detectError) {
        console.error(detectError);
        setError('Auto-detect failed on one or more documents. You can still add fields manually.');
      }
    }

    setDetecting(false);
    setDetectingDocumentId(undefined);
  };

  const handleAddFieldAt = useCallback(
    (pageIndex: number, rawX: number, rawY: number) => {
      if (!activeDocument) return;
      const pageMeta = activeDocument.pages.find((meta) => meta.index === pageIndex);
      if (!pageMeta) return;

      const width = 150;
      const height = 24;
      const x = clamp(rawX, 0, pageMeta.width - width);
      const y = clamp(rawY, 0, pageMeta.height - height);

      const perPageCount =
        activeDocument.fields.filter((field) => field.pageIndex === pageIndex).length + 1;

      addField(activeDocument.id, {
        id: generateFieldId(),
        pageIndex,
        x,
        y,
        width,
        height,
        multiline: false,
        name: `page${pageIndex + 1}_manual_${perPageCount}`,
      });
    },
    [activeDocument, addField],
  );

  const handleExportCurrent = async () => {
    if (!activeDocument || !activeDocument.fields.length) {
      setError('Nothing to export yet. Add fields first.');
      return;
    }

    setExporting(true);
    setError(null);

    try {
      const bytes = await buildFillablePdf(activeDocument);
      const arrayBuffer = bytes.buffer.slice(
        bytes.byteOffset,
        bytes.byteOffset + bytes.byteLength,
      ) as ArrayBuffer;
      const blob = new Blob([arrayBuffer], { type: 'application/pdf' });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = activeDocument.fileName.replace(/\.pdf$/i, '') + '-fillable.pdf';
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (exportError) {
      console.error(exportError);
      setError('Export failed. Try again or refresh the page.');
    } finally {
      setExporting(false);
    }
  };

  const handleExportAll = async () => {
    const snapshot = usePdfStore.getState().documents;
    if (!snapshot.length) {
      setError('No documents to export.');
      return;
    }

    setExportingAll(true);
    setError(null);

    try {
      const files: { name: string; data: Uint8Array }[] = [];
      for (const document of snapshot) {
        if (!document.fields.length) continue;
        const data = await buildFillablePdf(document);
        const name = document.fileName.replace(/\.pdf$/i, '') + '-fillable.pdf';
        files.push({ name, data });
      }

      if (!files.length) {
        setError('No fields found to export. Add fields before exporting.');
        return;
      }

      const zipBlob = createZipFromFiles(files);
      const url = URL.createObjectURL(zipBlob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = 'fillable-pdfs.zip';
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (exportError) {
      console.error(exportError);
      setError('Failed to export all documents.');
    } finally {
      setExportingAll(false);
    }
  };

  const activeFields = activeDocument?.fields ?? [];

  return (
    <div
      className="app-shell"
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <header className="app-header">
        <div>
          <h1>Fillable PDF Creator</h1>
          <p className="subtitle">Upload PDFs, detect blanks, tweak fields, export.</p>
        </div>
        <div className="actions">
          <label className={`file-input${loading ? ' file-input--disabled' : ''}`}>
            <input
              type="file"
              accept="application/pdf"
              multiple
              onChange={handleFileChange}
              disabled={loading}
            />
            {loading ? 'Loading…' : 'Upload PDFs'}
          </label>
          {activeDocument && (
            <span className="file-name" title={activeDocument.fileName}>
              {activeDocument.fileName}
            </span>
          )}
          {activeDocument && (
            <button
              type="button"
              className="secondary"
              onClick={() => handleRemoveDocument(activeDocument.id)}
            >
              Remove current
            </button>
          )}
        </div>
      </header>

      {error && <div className="banner banner--error">{error}</div>}

      {!documents.length && !loading && (
        <div className="empty-state">
          <p>Drop PDFs or click “Upload PDFs” to get started.</p>
          <p className="hint">You can manage multiple PDFs and detect blanks for all of them.</p>
        </div>
      )}

      {documents.length > 0 && (
        <main className="workspace">
          <DocumentList
            documents={documents}
            activeDocumentId={activeDocumentId}
            processingDocumentId={detectingDocumentId}
            onSelect={handleSelectDocument}
            onRemove={handleRemoveDocument}
          />
          <section className="viewer">
            <div className="viewer-toolbar">
              <button
                type="button"
                onClick={handleAutoDetect}
                disabled={detecting || loading || !documents.length}
              >
                {detecting ? 'Detecting…' : 'Auto-detect blanks (all)'}
              </button>
              <button
                type="button"
                className="primary"
                onClick={handleExportCurrent}
                disabled={exporting || !activeDocument || !activeFields.length}
              >
                {exporting ? 'Exporting…' : 'Download current'}
              </button>
              <button
                type="button"
                onClick={handleExportAll}
                disabled={exportingAll || documents.every((doc) => !doc.fields.length)}
              >
                {exportingAll ? 'Preparing ZIP…' : 'Download all (ZIP)'}
              </button>
            </div>
            <div className="pages">
              {activeDocument ? (
                activeDocument.pages.map((pageMeta) => (
                  <PageView
                    key={pageMeta.index}
                    pdfDoc={activeDocument.pdfDoc}
                    pageMeta={pageMeta}
                    fields={activeFields}
                    selectedFieldId={activeDocument.selectedFieldId}
                    onSelectField={(id) => selectField(activeDocument.id, id)}
                    onFieldChange={(id, updates) => updateField(activeDocument.id, id, updates)}
                    onAddFieldAt={handleAddFieldAt}
                  />
                ))
              ) : (
                <div className="empty-state small">
                  <p>Select a document to preview and edit its fields.</p>
                </div>
              )}
            </div>
          </section>
          <aside className="sidebar">
            <h2>Fields</h2>
            {activeDocument ? (
              <FieldList
                fields={activeFields}
                selectedFieldId={activeDocument.selectedFieldId}
                onSelectField={(id) => selectField(activeDocument.id, id)}
                onUpdateField={(id, updates) => updateField(activeDocument.id, id, updates)}
                onDeleteField={(id) => removeField(activeDocument.id, id)}
              />
            ) : (
              <div className="field-list__empty">
                Select a document to view its fields.
              </div>
            )}
          </aside>
        </main>
      )}

      {isDragActive && (
        <div className="drop-overlay">
          <div className="drop-overlay__content">
            <p>Drop your PDFs to upload</p>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
