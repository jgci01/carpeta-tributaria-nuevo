import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';

import { bytesABase64, esPDF, formatearBytes } from '../public/base64.js';

test('bytesABase64 coincide con Buffer en tamaños pequeños y de borde', () => {
  for (const tamano of [0, 1, 2, 3, 4, 5, 255, 256, 32_767, 32_768, 32_769, 100_003]) {
    const bytes = randomBytes(tamano);
    assert.equal(bytesABase64(new Uint8Array(bytes)), bytes.toString('base64'), `falló con ${tamano} bytes`);
  }
});

test('bytesABase64 funciona con un PDF grande (no desborda la pila)', () => {
  const bytes = randomBytes(3 * 1024 * 1024);
  const resultado = bytesABase64(new Uint8Array(bytes));
  assert.equal(resultado.length, Math.ceil(bytes.length / 3) * 4);
  assert.equal(resultado, bytes.toString('base64'));
});

test('el Base64 no incluye prefijo data: ni saltos de línea', () => {
  const resultado = bytesABase64(new Uint8Array(Buffer.from('%PDF-1.4 contenido')));
  assert.ok(!resultado.includes('data:'));
  assert.ok(!resultado.includes('\n'));
  assert.equal(Buffer.from(resultado, 'base64').toString(), '%PDF-1.4 contenido');
});

test('esPDF detecta la firma %PDF-', () => {
  assert.equal(esPDF(new Uint8Array(Buffer.from('%PDF-1.7\n...'))), true);
  assert.equal(esPDF(new Uint8Array(Buffer.from('<html>'))), false);
  assert.equal(esPDF(new Uint8Array(Buffer.from('%PDF'))), false);
  assert.equal(esPDF(new Uint8Array()), false);
});

test('formatearBytes muestra unidades legibles', () => {
  assert.equal(formatearBytes(0), '0 B');
  assert.equal(formatearBytes(900), '900 B');
  assert.equal(formatearBytes(1536), '1.5 KB');
  assert.equal(formatearBytes(480956), '470 KB');
  assert.equal(formatearBytes(5 * 1024 * 1024), '5.0 MB');
});

test('rechaza tipos que no son Uint8Array', () => {
  assert.throws(() => bytesABase64('texto'), /Uint8Array/);
  assert.throws(() => bytesABase64([1, 2, 3]), /Uint8Array/);
});
