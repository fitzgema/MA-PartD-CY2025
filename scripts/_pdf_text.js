// scripts/_pdf_text.js
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";

// PDF.js needs a worker; in Node we can use the same build
pdfjs.GlobalWorkerOptions.workerSrc = require.resolve("pdfjs-dist/legacy/build/pdf.worker.mjs");

export async function pdfBufferToText(buffer, maxPages = 40) {
  const loadingTask = pdfjs.getDocument({ data: buffer });
  const doc = await loadingTask.promise;
  const pageCount = Math.min(doc.numPages, maxPages);
  const parts = [];

  for (let i = 1; i <= pageCount; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    const text = content.items.map(it => ("str" in it ? it.str : "")).join(" ");
    parts.push(text);
  }
  return parts.join("\n");
}
