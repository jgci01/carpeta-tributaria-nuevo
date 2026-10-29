/**
 * Genera PDFs de ejemplo (sin datos reales) para probar la aplicación.
 *
 *   node herramientas/generar-ejemplo.js
 *
 * Crea:
 *   ejemplos/Carpeta Tributaria 77235126-7/Carpeta_Tributaria_Regular_77235126-7.pdf
 *   ejemplos/Carpeta Tributaria 77235126-7/Anexos/Anexo_F29_2026-08.pdf
 *   ejemplos/Carpeta Tributaria 77235126-7/leeme.txt   (no es PDF: la app debe omitirlo)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RAIZ = path.resolve(__dirname, '..');

const escaparPdf = (texto) => String(texto).replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');

/** Construye un PDF de una página con líneas de texto. */
function crearPdf(lineas) {
  const operaciones = [];
  let y = 790;
  for (const { texto, tamano = 11, salto = 1.9 } of lineas) {
    operaciones.push(`BT /F1 ${tamano} Tf 1 0 0 1 56 ${y.toFixed(1)} Tm (${escaparPdf(texto)}) Tj ET`);
    y -= tamano * salto;
  }
  const contenido = operaciones.join('\n');

  let pdf = '%PDF-1.4\n';
  const desplazamientos = [];

  const objeto = (numero, cuerpo) => {
    desplazamientos[numero] = Buffer.byteLength(pdf, 'latin1');
    pdf += `${numero} 0 obj\n${cuerpo}\nendobj\n`;
  };

  objeto(1, '<< /Type /Catalog /Pages 2 0 R >>');
  objeto(2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
  objeto(
    3,
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] ' +
      '/Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>'
  );
  objeto(4, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  objeto(
    5,
    `<< /Length ${Buffer.byteLength(contenido, 'latin1')} >>\nstream\n${contenido}\nendstream`
  );

  const inicioXref = Buffer.byteLength(pdf, 'latin1');
  pdf += 'xref\n0 6\n0000000000 65535 f \n';
  for (let i = 1; i <= 5; i += 1) {
    pdf += `${String(desplazamientos[i]).padStart(10, '0')} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size 6 /Root 1 0 R /Info << /Title (Ejemplo) /Producer (Generador local) >> >>\n`;
  pdf += `startxref\n${inicioXref}\n%%EOF\n`;

  return Buffer.from(pdf, 'latin1');
}

const carpeta = path.join(RAIZ, 'ejemplos', 'Carpeta Tributaria 77235126-7');
fs.mkdirSync(path.join(carpeta, 'Anexos'), { recursive: true });

const principal = crearPdf([
  { texto: 'CARPETA TRIBUTARIA REGULAR', tamano: 17, salto: 2.4 },
  { texto: 'Documento de EJEMPLO generado localmente', tamano: 10, salto: 2.8 },
  { texto: 'RUT: 77.235.126-7' },
  { texto: 'Razon social: COMERCIALIZADORA DEL SUR LIMITADA' },
  { texto: 'Periodo: Agosto 2026' },
  { texto: '' },
  { texto: 'Este archivo no contiene informacion tributaria real.' },
  { texto: 'Se usa unicamente para probar la conversion a Base64 y el envio SOAP.' }
]);

const anexo = crearPdf([
  { texto: 'ANEXO FORMULARIO 29', tamano: 15, salto: 2.4 },
  { texto: 'Documento de EJEMPLO', tamano: 10, salto: 2.8 },
  { texto: 'RUT: 77.235.126-7' },
  { texto: 'Periodo: Agosto 2026' },
  { texto: 'Total declarado: $1.234.567' },
  { texto: 'Este archivo no contiene informacion tributaria real.' }
]);

fs.writeFileSync(path.join(carpeta, 'Carpeta_Tributaria_Regular_77235126-7.pdf'), principal);
fs.writeFileSync(path.join(carpeta, 'Anexos', 'Anexo_F29_2026-08.pdf'), anexo);
fs.writeFileSync(
  path.join(carpeta, 'leeme.txt'),
  'Archivo de texto de ejemplo: la aplicación debe omitirlo porque no es PDF.\n'
);

console.log('PDFs de ejemplo creados en:');
console.log(`  ${carpeta}`);
console.log(`  - Carpeta_Tributaria_Regular_77235126-7.pdf (${principal.length} bytes)`);
console.log(`  - Anexos/Anexo_F29_2026-08.pdf (${anexo.length} bytes)`);
console.log('  - leeme.txt (no PDF)');
