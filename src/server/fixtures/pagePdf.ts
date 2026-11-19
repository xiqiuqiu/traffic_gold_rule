// Small independent content streams exercise routing and geometry without shipping case files.
export function makePagePdf(pages: Array<{ content: string; rotation?: number; userUnit?: number }>): Buffer {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Count ${pages.length} /Kids [${pages.map((_, i) => (5 + i * 2) + ' 0 R').join(' ')}] >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    '<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /ASCIIHexDecode /Length 3 >>\nstream\n00>\nendstream',
  ];
  for (const page of pages) {
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /CropBox [10 20 200 260] /Rotate ${page.rotation ?? 0} /UserUnit ${page.userUnit ?? 1}
         /Resources << /Font << /F0 3 0 R >> /XObject << /Im0 4 0 R >> >> /Contents ${objects.length + 2} 0 R >>`,
      `<< /Length ${Buffer.byteLength(page.content)} >>\nstream\n${page.content}\nendstream`,
    );
  }
  let pdf = '%PDF-1.6\n';
  const offsets = ['0000000000 65535 f \n'];
  for (const [index, object] of objects.entries()) {
    offsets.push(String(Buffer.byteLength(pdf)).padStart(10, '0') + ' 00000 n \n');
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const start = Buffer.byteLength(pdf);
  return Buffer.from(pdf + `xref\n0 ${offsets.length}\n${offsets.join('')}trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`);
}
