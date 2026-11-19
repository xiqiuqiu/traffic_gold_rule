// Visible page coordinates. bbox is normalized; rawBox uses pixels for OCR and page points for native text.
export type PdfBox = [number, number, number, number];

export interface PdfEvidenceLine {
  text: string;
  bbox: PdfBox;
  rawBox?: PdfBox;
  confidence?: number;
}

export interface PdfPageEvidence {
  pageNumber: number;
  width: number;
  height: number;
  rotation: number;
  source: 'native' | 'ocr' | 'blank';
  reason: string | null;
  text: string;
  lines: PdfEvidenceLine[];
  renderWidth?: number;
  renderHeight?: number;
  engine?: string;
}
