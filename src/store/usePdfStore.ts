import { create } from 'zustand';
import type { PDFDocumentProxy } from 'pdfjs-dist/types/src/display/api';

export type Field = {
  id: string;
  pageIndex: number;
  x: number;
  y: number;
  width: number;
  height: number;
  multiline: boolean;
  confidence?: number;
  name: string;
  placeholder?: string;
};

export type PageMeta = {
  index: number;
  width: number;
  height: number;
  originalWidth: number;
  originalHeight: number;
  scale: number;
};

export type PdfDocumentRecord = {
  id: string;
  fileName: string;
  pdfDoc: PDFDocumentProxy;
  documentData: Uint8Array;
  pages: PageMeta[];
  fields: Field[];
  selectedFieldId?: string;
};

type PdfState = {
  documents: PdfDocumentRecord[];
  activeDocumentId?: string;
  addDocument: (entry: PdfDocumentRecord) => void;
  removeDocument: (id: string) => void;
  clearAll: () => void;
  setActiveDocument: (id: string) => void;
  addField: (documentId: string, field: Field) => void;
  updateField: (documentId: string, fieldId: string, updates: Partial<Field>) => void;
  removeField: (documentId: string, fieldId: string) => void;
  setFields: (documentId: string, fields: Field[]) => void;
  mergeFields: (documentId: string, candidates: Field[]) => void;
  selectField: (documentId: string, fieldId?: string) => void;
};

const updateDocument = (
  documents: PdfDocumentRecord[],
  id: string,
  updater: (document: PdfDocumentRecord) => PdfDocumentRecord,
): PdfDocumentRecord[] =>
  documents.map((document) => (document.id === id ? updater(document) : document));

export const usePdfStore = create<PdfState>((set) => ({
  documents: [],
  activeDocumentId: undefined,
  addDocument: (entry) =>
    set((state) => ({
      documents: [...state.documents, { ...entry, fields: entry.fields ?? [] }],
      activeDocumentId: entry.id,
    })),
  removeDocument: (id) =>
    set((state) => {
      const target = state.documents.find((document) => document.id === id);
      target?.pdfDoc.destroy();
      const remaining = state.documents.filter((document) => document.id !== id);
      const nextActive =
        state.activeDocumentId === id
          ? remaining.length
            ? remaining[0]?.id
            : undefined
          : state.activeDocumentId;
      return {
        documents: remaining,
        activeDocumentId: nextActive,
      };
    }),
  clearAll: () =>
    set((state) => {
      state.documents.forEach((document) => {
        document.pdfDoc.destroy();
      });
      return {
        documents: [],
        activeDocumentId: undefined,
      };
    }),
  setActiveDocument: (id) =>
    set((state) => ({
      activeDocumentId: state.documents.some((document) => document.id === id)
        ? id
        : state.activeDocumentId,
    })),
  addField: (documentId, field) =>
    set((state) => ({
      documents: updateDocument(state.documents, documentId, (document) => ({
        ...document,
        fields: [...document.fields, field],
        selectedFieldId: field.id,
      })),
    })),
  updateField: (documentId, fieldId, updates) =>
    set((state) => ({
      documents: updateDocument(state.documents, documentId, (document) => ({
        ...document,
        fields: document.fields.map((field) =>
          field.id === fieldId ? { ...field, ...updates } : field,
        ),
      })),
    })),
  removeField: (documentId, fieldId) =>
    set((state) => ({
      documents: updateDocument(state.documents, documentId, (document) => ({
        ...document,
        fields: document.fields.filter((field) => field.id !== fieldId),
        selectedFieldId:
          document.selectedFieldId === fieldId ? undefined : document.selectedFieldId,
      })),
    })),
  setFields: (documentId, fields) =>
    set((state) => ({
      documents: updateDocument(state.documents, documentId, (document) => ({
        ...document,
        fields,
        selectedFieldId: fields.length ? fields[fields.length - 1]?.id : undefined,
      })),
    })),
  mergeFields: (documentId, candidates) =>
    set((state) => ({
      documents: updateDocument(state.documents, documentId, (document) => {
        const combined = [...document.fields];
        candidates.forEach((candidate) => {
          const duplicate = combined.some(
            (existing) =>
              existing.pageIndex === candidate.pageIndex &&
              Math.abs(existing.x - candidate.x) < 10 &&
              Math.abs(existing.y - candidate.y) < 10 &&
              Math.abs(existing.width - candidate.width) < 15,
          );
          if (!duplicate) {
            combined.push(candidate);
          }
        });
        return {
          ...document,
          fields: combined,
          selectedFieldId: combined.length ? combined[combined.length - 1]?.id : undefined,
        };
      }),
    })),
  selectField: (documentId, fieldId) =>
    set((state) => ({
      documents: updateDocument(state.documents, documentId, (document) => ({
        ...document,
        selectedFieldId: fieldId,
      })),
    })),
}));
