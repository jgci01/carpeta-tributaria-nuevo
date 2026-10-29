import test from 'node:test';
import assert from 'node:assert/strict';

import { construirEnvelope, escaparXml, NAMESPACE_FORMEX, SOAP_ACTION_SUGERIDA } from '../public/envelope.js';

const PDF_B64 = 'JVBERi0xLjQKJcOkw7zDtsOfCg==';

test('el sobre replica la estructura del request de Credex', () => {
  const sobre = construirEnvelope({ usuario: 'USUARIO1', clave: 'CLAVE1', origen: 'WS', pdfB64: PDF_B64 });

  assert.match(sobre, /^<soapenv:Envelope xmlns:soapenv="http:\/\/schemas\.xmlsoap\.org\/soap\/envelope\/" xmlns:for="http:\/\/portalcredex\.cl\/formex">/);
  assert.match(sobre, /<soapenv:Body>\s*<for:procesaCTE>/);
  assert.match(sobre, /<for:Input>/);
  assert.match(sobre, /<for:Credenciales>/);
  assert.match(sobre, /<for:Usuario>USUARIO1<\/for:Usuario>/);
  assert.match(sobre, /<for:Clave>CLAVE1<\/for:Clave>/);
  assert.match(sobre, /<for:Origen>WS<\/for:Origen>/);
  assert.ok(sobre.includes(`<for:PDFB64>${PDF_B64}</for:PDFB64>`));
  assert.match(sobre, /<\/for:procesaCTE>\s*<\/soapenv:Body>\s*<\/soapenv:Envelope>$/);
});

test('el orden de los nodos es el del servicio (Usuario, Clave, Origen, PDFB64)', () => {
  const sobre = construirEnvelope({ usuario: 'u', clave: 'c', pdfB64: PDF_B64 });
  const posiciones = ['<for:Usuario>', '<for:Clave>', '<for:Origen>', '<for:PDFB64>'].map((t) => sobre.indexOf(t));
  assert.deepEqual([...posiciones].sort((a, b) => a - b), posiciones);
  assert.ok(posiciones.every((p) => p > 0));
});

test('escapa caracteres especiales de XML en credenciales', () => {
  const sobre = construirEnvelope({ usuario: 'a&b<c>"d\'e', clave: 'clave&secreta', pdfB64: PDF_B64 });
  assert.ok(sobre.includes('<for:Usuario>a&amp;b&lt;c&gt;&quot;d&apos;e</for:Usuario>'));
  assert.ok(sobre.includes('<for:Clave>clave&amp;secreta</for:Clave>'));
  assert.equal(escaparXml('&<>"\''), '&amp;&lt;&gt;&quot;&apos;');
});

test('usa Origen WS por defecto y agrega la declaración XML solo si se pide', () => {
  const sin = construirEnvelope({ usuario: 'u', clave: 'c', pdfB64: PDF_B64 });
  assert.match(sin, /<for:Origen>WS<\/for:Origen>/);
  assert.ok(!sin.startsWith('<?xml'));

  const con = construirEnvelope({ usuario: 'u', clave: 'c', pdfB64: PDF_B64, incluirDeclaracion: true });
  assert.ok(con.startsWith('<?xml version="1.0" encoding="UTF-8"?>'));
});

test('rechaza un PDF vacío o con Base64 inválido', () => {
  assert.throws(() => construirEnvelope({ usuario: 'u', clave: 'c', pdfB64: '' }), /vacío/);
  assert.throws(() => construirEnvelope({ usuario: 'u', clave: 'c', pdfB64: 'esto no es base64!' }), /caracteres inválidos/);
  assert.throws(() => construirEnvelope({ usuario: 'u', clave: 'c', pdfB64: 'abc def' }), /caracteres inválidos/);
});

test('expone el namespace y la SOAPAction sugerida', () => {
  assert.equal(NAMESPACE_FORMEX, 'http://portalcredex.cl/formex');
  assert.equal(SOAP_ACTION_SUGERIDA, 'http://portalcredex.cl/formex/procesaCTE');
});
