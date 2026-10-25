import React from 'react';
import { Document, Page, Text, View, Image, renderToBuffer, StyleSheet, type Styles } from '@react-pdf/renderer';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

export const istTimestamp = (date: Date) => `${new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' }).format(date)} IST`;
const documentText = (value: string) => value.replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g, value => istTimestamp(new Date(value)));

const styles = StyleSheet.create({
  page: { padding: 36, fontSize: 9, fontFamily: 'Helvetica', lineHeight: 1.4 },
  title: { fontSize: 19, marginBottom: 8, color: '#164b3d' },
  section: { fontSize: 12, marginTop: 14, marginBottom: 6 },
  row: { borderBottomWidth: 0.5, borderBottomColor: '#cccccc', paddingVertical: 5 },
  footer: { position: 'absolute', bottom: 20, left: 36, right: 36, fontSize: 8, color: '#666666' },
  grid: { flexDirection: 'row', flexWrap: 'wrap' },
  sticker: { width: '25%', padding: 8, borderWidth: 0.5, borderColor: '#cccccc', alignItems: 'center' },
});
const h = React.createElement;
export async function reportPdf(title: string, sections: { heading: string; lines: string[] }[]) {
  const pages: React.ReactElement[][] = [[]];
  let height = 0;
  const addText = (value: string, style: Styles[string], fontSize: number, spacing: number) => {
    // Conservative Helvetica widths keep even unbroken IDs within the A4 content area.
    const width = Math.floor(500 / fontSize);
    const lines = value.split('\n').flatMap(line => {
      const characters = Array.from(line);
      const wrapped: string[] = [];
      for (let start = 0; start < characters.length;) {
        let end = Math.min(start + width, characters.length);
        if (end < characters.length) {
          for (let i = end - 1; i > start; i--) {
            if (/\s/u.test(characters[i])) { end = i + 1; break; }
          }
        }
        wrapped.push(characters.slice(start, end).join(''));
        start = end;
      }
      return wrapped.length ? wrapped : [''];
    });
    for (let i = 0; i < lines.length; i += 8) {
      const chunk = lines.slice(i, i + 8);
      const chunkHeight = chunk.length * fontSize * 1.4 + spacing;
      if (height + chunkHeight > 700) { pages.push([]); height = 0; }
      const page = pages[pages.length - 1];
      page.push(h(Text, { key: page.length, wrap: false, hyphenationCallback: word => [word], style: [style, { fontSize, lineHeight: 1.4, flexShrink: 0 }] }, chunk.join('\n')));
      height += chunkHeight;
    }
  };
  addText(title, styles.title, 19, 8);
  addText(`Generated ${istTimestamp(new Date())} | Swachh-Track`, {}, 9, 0);
  for (const section of sections) {
    addText(section.heading, styles.section, 12, 20);
    for (const line of section.lines) addText(documentText(line), styles.row, 9, 11);
  }
  // No oversized section Views or automatic relayout of an ever-shrinking remainder.
  return renderToBuffer(h(Document, {}, ...pages.map((children, i) => h(Page, { key: i, size: 'A4', style: [styles.page, { minHeight: 841.89, maxHeight: 841.89 }], wrap: false },
    ...children,
    h(Text, { style: styles.footer }, `Swachh-Track | Page ${i + 1} of ${pages.length}`),
  ))));
}

export async function inspectionPdf(manifest: Buffer, originals: { label: string; bytes: Buffer }[]) {
  const combined = await PDFDocument.load(manifest);
  const font = await combined.embedFont(StandardFonts.Helvetica);
  for (const original of originals) {
    const separator = combined.addPage([595.28, 841.89]);
    separator.drawText('Original evidence document', { x: 36, y: 790, size: 16, font });
    const label = original.label.replace(/[^\x20-\x7e]/g, '?');
    separator.drawText(label.slice(0, 95), { x: 36, y: 760, size: 9, font });
    if (original.bytes.subarray(0, 5).toString() === '%PDF-') {
      const document = await PDFDocument.load(original.bytes);
      const pages = await combined.copyPages(document, document.getPageIndices());
      pages.forEach(page => combined.addPage(page));
    } else {
      const image = await combined.embedJpg(original.bytes);
      const fitted = image.scaleToFit(523, 680);
      separator.drawImage(image, { x: 36, y: 60, width: fitted.width, height: fitted.height });
    }
  }
  const generatedAt = istTimestamp(new Date());
  const pages = combined.getPages();
  for (const [index, page] of pages.entries()) {
    page.drawRectangle({ x: 0, y: 8, width: page.getWidth(), height: 25, color: rgb(1, 1, 1) });
    page.drawText(`Swachh-Track | ${index + 1}/${pages.length} | Generated ${generatedAt}`, { x: 36, y: 18, font, size: 8, color: rgb(0.35, 0.35, 0.35) });
  }
  combined.setTitle('Swachh-Track inspection evidence pack');
  return Buffer.from(await combined.save());
}
export async function qrPdf(title: string, items: { label: string; code: string; image: string }[]) {
  return renderToBuffer(h(Document, {}, h(Page, { size: 'A4', style: styles.page },
    h(Text, { style: styles.title }, title),
    h(View, { style: styles.grid }, ...items.map((item, i) => h(View, { key: i, style: styles.sticker, wrap: false }, h(Image, { src: item.image, style: { width: 90, height: 90 } }), h(Text, {}, item.label), h(Text, {}, item.code)))),
    h(Text, { fixed: true, style: styles.footer, render: ({ pageNumber, totalPages }) => `Property evidence tokens: keep these stickers at the property | ${pageNumber}/${totalPages}` }),
  )));
}
