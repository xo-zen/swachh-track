import { describe, expect, it } from 'vitest';
import { decodePDFRawStream, PDFArray, PDFDocument, PDFRawStream } from 'pdf-lib';
import sharp from 'sharp';
import { inspectionPdf, istTimestamp, reportPdf } from '../src/pdf.js';

// These fixtures use standard Helvetica: decode the hex text in actual page streams,
// not metadata or compressed bytes. This is not a general Unicode PDF text parser.
const pageTexts = (pdf: PDFDocument) => pdf.getPages().map(page => {
  const contents = page.node.Contents();
  const streams = contents instanceof PDFArray ? Array.from({ length: contents.size() }, (_, i) => contents.lookup(i, PDFRawStream)) : contents instanceof PDFRawStream ? [contents] : [];
  return streams.map(stream => {
    const decoded = Buffer.from(decodePDFRawStream(stream).decode()).toString('latin1');
    return [...decoded.matchAll(/<([\da-f]+)>/gi)].map(match => Buffer.from(match[1], 'hex').toString('latin1')).join('');
  }).join('');
});

describe('Inspection evidence documents', () => {
  it('renders UTC instants in IST in generated documents', () => {
    expect(istTimestamp(new Date('2026-10-25T00:00:00Z'))).toContain('5:30');
    expect(istTimestamp(new Date('2026-10-25T00:00:00Z'))).toContain('IST');
  });
  it('includes original PDF pages and normalized image evidence with global page numbers', async () => {
    const manifest = await reportPdf('Inspection pack', [{ heading: 'Manifest', lines: Array.from({ length: 100 }, (_, i) => `Manifest evidence ${i}`) }]);
    const manifestPages = (await PDFDocument.load(manifest)).getPageCount();
    expect(manifestPages).toBeGreaterThan(1);
    const original = await PDFDocument.create();
    original.addPage([421, 595]).drawText('ORIGINAL REGISTRATION EVIDENCE');
    const jpeg = await sharp({ create: { width: 120, height: 80, channels: 3, background: '#036847' } }).jpeg().toBuffer();
    const result = await inspectionPdf(manifest, [{ label: 'Registration', bytes: Buffer.from(await original.save()) }, { label: 'Vendor authorization', bytes: jpeg }]);
    const parsed = await PDFDocument.load(result);
    expect(parsed.getPageCount()).toBe(manifestPages + 3);
    expect(parsed.getTitle()).toContain('inspection evidence');
    expect(result.subarray(0, 5).toString()).toBe('%PDF-');
    const text = pageTexts(parsed);
    expect(text.slice(0, manifestPages).join('')).toContain('Manifest evidence 99');
    expect(text[manifestPages + 1]).toContain('ORIGINAL REGISTRATION EVIDENCE');
    expect(parsed.getPages()[manifestPages + 1].getSize()).toEqual({ width: 421, height: 595 });
    expect(text[manifestPages + 2]).toContain('Vendor authorization');
    expect(parsed.context.enumerateIndirectObjects().some(([, object]) => object instanceof PDFRawStream && Buffer.from(object.getContents()).equals(jpeg))).toBe(true);
    text.forEach((page, i) => expect(page).toContain(`Swachh-Track | ${i + 1}/${text.length} | Generated `));
  });
  it('renders every row and final evidence across explicit pages at scale', async () => {
    const lines = Array.from({ length: 4100 }, (_, i) => `Evidence ${i}: 4e94c0c0-6988-47a0-a4d4-7199d38f982d`);
    const pdf = await PDFDocument.load(await reportPdf('Scale', [{ heading: 'Obligations', lines }]));
    pdf.getPages().forEach(page => {
      expect(page.getWidth()).toBeCloseTo(595.28, 2);
      expect(page.getHeight()).toBeCloseTo(841.89, 2);
    });
    const text = pageTexts(pdf);
    expect(text.length).toBeGreaterThan(1);
    expect(text[0]).toContain('ScaleGenerated ');
    expect(text[0]).toContain('IST | Swachh-Track');
    expect(text[0]).toContain('Obligations');
    text.forEach((page, i) => expect(page).toContain(`Swachh-Track | Page ${i + 1} of ${text.length}`));
    const allText = text.join('');
    for (const line of lines) expect(allText).toContain(line);
    expect(text.at(-1)).toContain(lines.at(-1));
  }, 60000);
  it.each(['Inspection pack', 'Invoice'])('preserves a huge single JSON line in %s', async title => {
    const ids = Array.from({ length: 3000 }, (_, i) => `4e94c0c0-6988-47a0-a4d4-${i.toString().padStart(12, '0')}`);
    const evidence = JSON.stringify({ ids, token: 'W'.repeat(5000), notes: 'Verified obligation with evidence '.repeat(100), final: 'FINAL-EVIDENCE' });
    const pdf = await PDFDocument.load(await reportPdf(title, [{ heading: 'Evidence', lines: [evidence, 'After evidence', 'Due 2026-10-25T00:00:00Z'] }]));
    const text = pageTexts(pdf);
    expect(text.length).toBeGreaterThan(1);
    const body = text.map(page => page.replace(/Swachh-Track \| Page \d+ of \d+/g, '')).join('');
    expect(body).toContain(evidence);
    expect(body).toContain(`After evidenceDue ${istTimestamp(new Date('2026-10-25T00:00:00Z'))}`);
    expect(text.at(-1)).toContain('FINAL-EVIDENCE');
  }, 60000);
  it('fails visibly for invalid original evidence instead of omitting it', async () => {
    const manifest = await reportPdf('Inspection', []);
    await expect(inspectionPdf(manifest, [{ label: 'Invalid', bytes: Buffer.from('not a valid image or PDF') }])).rejects.toThrow();
  });
});
