export interface FontSource {
  family: string;
  weight?: number;
  style?: 'normal' | 'italic';
  url: string | URL;
}

export interface HtmlToPdfOptions {
  width?: number;
  height?: number;
  margin?: number;
  background?: string | null;
  hairline?: number;
  css?: string;
  fonts?: FontSource[];
  noAutoFonts?: boolean;
  title?: string;
  author?: string;
  subject?: string;
  keywords?: string;
  creator?: string;
}

export function htmlToPdf(
  input: string | Node,
  opts?: HtmlToPdfOptions
): Promise<Uint8Array>;
export function pdfBlobUrl(pdf: Uint8Array): string;
export function openPdf(pdf: Uint8Array): void;
export function downloadPdf(pdf: Uint8Array, name?: string): void;
export function printPdf(pdf: Uint8Array): Promise<void>;
export function registerFont(font: {
  family: string;
  weight?: number;
  style?: 'normal' | 'italic';
  data: ArrayBuffer;
}): void;
export function registerFontUrl(
  family: string,
  url: string,
  opts?: { weight?: number; style?: 'normal' | 'italic' }
): Promise<void>;
