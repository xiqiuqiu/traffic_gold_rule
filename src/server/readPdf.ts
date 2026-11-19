import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

export class PermanentPdfError extends Error {}

export async function readOriginal(path: string, sha256: string): Promise<Buffer> {
  const bytes = await readFile(path);
  if (createHash('sha256').update(bytes).digest('hex') !== sha256.replace(/^sha256:/, '')) {
    throw new PermanentPdfError('原件的 SHA-256 校验失败，请检查原件卷。');
  }
  return bytes;
}
