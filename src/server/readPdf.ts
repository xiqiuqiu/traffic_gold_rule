import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { readPdfPageTexts } from '../utils/pdfPageText';

export class PermanentPdfError extends Error {}

export async function readOriginal(path: string, sha256: string): Promise<Buffer> {
  const bytes = await readFile(path);
  if (createHash('sha256').update(bytes).digest('hex') !== sha256.replace(/^sha256:/, '')) {
    throw new PermanentPdfError('原件的 SHA-256 校验失败，请检查原件卷。');
  }
  return bytes;
}

export async function extractOriginalText(path: string, sha256: string) {
  const data = new Uint8Array(await readOriginal(path, sha256));
  const loading = getDocument({
    data,
    cMapUrl: resolve('public/pdfjs/cmaps') + sep,
    cMapPacked: true,
    standardFontDataUrl: resolve('public/pdfjs/standard_fonts') + sep,
    stopAtErrors: true,
  });
  try {
    const document = await loading.promise;
    const pageTexts = await readPdfPageTexts(document);
    for (const page of Object.keys(pageTexts)) {
      // PostgreSQL jsonb cannot store U+0000 in a string.
      pageTexts[Number(page)] = pageTexts[Number(page)].replaceAll('\0', '');
    }
    return { pageCount: document.numPages, pageTexts };
  } catch (error) {
    if (error instanceof Error && error.name === 'PasswordException') {
      throw new PermanentPdfError('PDF 需要密码，请提供已解密的原件。');
    }
    throw new PermanentPdfError('PDF 无法读取，请检查原件是否完整。');
  } finally {
    await loading.destroy();
  }
}
