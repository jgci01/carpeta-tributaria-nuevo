import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { crearServidor } from '../server.js';
import { construirEnvelope } from '../public/envelope.js';

process.env.CTFORMEX_SILENCIO = '1';

const PDF = Buffer.concat([
  Buffer.from('%PDF-1.4\n'),
  Buffer.from([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a]),
  Buffer.from('1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF\n')
]);
const PDF_B64 = PDF.toString('base64');

function respuestaOk(mensaje = 'Carpeta tributaria procesada correctamente') {
  const interno = `<Respuesta><Codigo>0</Codigo><Mensaje>${mensaje}</Mensaje><TrackId>77235126-7</TrackId></Respuesta>`;
  return `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body>
    <procesaCTEResponse xmlns="http://portalcredex.cl/formex">
      <procesaCTEResult>${interno.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</procesaCTEResult>
    </procesaCTEResponse>
  </soap:Body>
</soap:Envelope>`;
}

const FAULT = `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body>
    <soap:Fault>
      <faultcode>soap:Server</faultcode>
      <faultstring>Credenciales inválidas</faultstring>
    </soap:Fault>
  </soap:Body>
</soap:Envelope>`;

function servir(servidor) {
  return new Promise((resolver) => {
    servidor.listen(0, '127.0.0.1', () => resolver(`http://127.0.0.1:${servidor.address().port}`));
  });
}

function cerrar(servidor) {
  return new Promise((resolver) => servidor.close(() => resolver()));
}

function mockSoap({ status = 200, cuerpo = respuestaOk(), demora = 0 } = {}) {
  const capturado = { peticiones: [] };
  const servidor = http.createServer((req, res) => {
    const partes = [];
    req.on('data', (parte) => partes.push(parte));
    req.on('end', () => {
      capturado.peticiones.push({
        metodo: req.method,
        url: req.url,
        cabeceras: req.headers,
        cuerpo: Buffer.concat(partes).toString('utf8')
      });
      setTimeout(() => {
        res.writeHead(status, { 'Content-Type': 'text/xml; charset=utf-8' });
        res.end(cuerpo);
      }, demora);
    });
  });
  return { servidor, capturado };
}

async function enviar(appUrl, cuerpo) {
  const respuesta = await fetch(`${appUrl}/api/enviar`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(cuerpo)
  });
  return { status: respuesta.status, datos: await respuesta.json() };
}

test('reenvía el sobre al servicio y devuelve la respuesta', async (t) => {
  const mock = mockSoap();
  const app = crearServidor();
  const mockUrl = await servir(mock.servidor);
  const appUrl = await servir(app);
  t.after(async () => {
    await cerrar(mock.servidor);
    await cerrar(app);
  });

  const envelope = construirEnvelope({ usuario: 'USUARIO_WS', clave: 'CLAVE_WS', origen: 'WS', pdfB64: PDF_B64 });
  const { status, datos } = await enviar(appUrl, {
    endpoint: `${mockUrl}/formex`,
    envelope,
    soapAction: 'http://portalcredex.cl/formex/procesaCTE',
    timeoutMs: 5000
  });

  assert.equal(status, 200);
  assert.equal(datos.ok, true);
  assert.equal(datos.httpStatus, 200);
  assert.match(datos.cuerpo, /procesaCTEResult/);
  assert.ok(datos.ms >= 0);

  const peticion = mock.capturado.peticiones[0];
  assert.equal(peticion.metodo, 'POST');
  assert.equal(peticion.url, '/formex');
  assert.match(peticion.cuerpo, /<for:Usuario>USUARIO_WS<\/for:Usuario>/);
  assert.match(peticion.cuerpo, /<for:Clave>CLAVE_WS<\/for:Clave>/);
  assert.equal(peticion.cabeceras.soapaction, '"http://portalcredex.cl/formex/procesaCTE"');
  assert.equal(peticion.cabeceras['content-type'], 'text/xml; charset=utf-8');

  const b64Recibido = /<for:PDFB64>([^<]+)<\/for:PDFB64>/.exec(peticion.cuerpo)?.[1];
  assert.ok(b64Recibido, 'el servicio debió recibir el PDFB64');
  assert.deepEqual(Buffer.from(b64Recibido, 'base64'), PDF);
});

test('SOAP 1.2 lleva la acción en el Content-Type', async (t) => {
  const mock = mockSoap();
  const app = crearServidor();
  const mockUrl = await servir(mock.servidor);
  const appUrl = await servir(app);
  t.after(async () => {
    await cerrar(mock.servidor);
    await cerrar(app);
  });

  const { datos } = await enviar(appUrl, {
    endpoint: mockUrl,
    envelope: construirEnvelope({ usuario: 'u', clave: 'c', pdfB64: PDF_B64 }),
    soapAction: 'http://portalcredex.cl/formex/procesaCTE',
    contentType: 'application/soap+xml; charset=utf-8',
    timeoutMs: 5000
  });

  assert.equal(datos.httpStatus, 200);
  const peticion = mock.capturado.peticiones[0];
  assert.equal(peticion.cabeceras['content-type'], 'application/soap+xml; charset=utf-8; action="http://portalcredex.cl/formex/procesaCTE"');
  assert.equal(peticion.cabeceras.soapaction, undefined);
});

test('propaga un SOAP Fault del servicio sin romper el proxy', async (t) => {
  const mock = mockSoap({ status: 500, cuerpo: FAULT });
  const app = crearServidor();
  const mockUrl = await servir(mock.servidor);
  const appUrl = await servir(app);
  t.after(async () => {
    await cerrar(mock.servidor);
    await cerrar(app);
  });

  const { status, datos } = await enviar(appUrl, {
    endpoint: mockUrl,
    envelope: construirEnvelope({ usuario: 'u', clave: 'c', pdfB64: PDF_B64 }),
    timeoutMs: 5000
  });

  assert.equal(status, 200);
  assert.equal(datos.ok, true);
  assert.equal(datos.httpStatus, 500);
  assert.match(datos.cuerpo, /Credenciales inválidas/);
});

test('informa un error claro si el endpoint no responde (puerto cerrado)', async (t) => {
  const app = crearServidor();
  const appUrl = await servir(app);
  t.after(() => cerrar(app));

  // Se reserva un puerto efímero y se libera: queda cerrado pero permitido por fetch.
  const sonda = http.createServer();
  const puertoCerrado = await new Promise((resolver) => {
    sonda.listen(0, '127.0.0.1', () => {
      const puerto = sonda.address().port;
      sonda.close(() => resolver(puerto));
    });
  });

  const { status, datos } = await enviar(appUrl, {
    endpoint: `http://127.0.0.1:${puertoCerrado}/formex`,
    envelope: construirEnvelope({ usuario: 'u', clave: 'c', pdfB64: PDF_B64 }),
    timeoutMs: 3000
  });

  assert.equal(status, 502);
  assert.equal(datos.ok, false);
  assert.equal(datos.error.codigo, 'ECONNREFUSED');
  assert.match(datos.error.mensaje, /rechazó la conexión/i);
});

test('corta por timeout cuando el servicio no contesta', async (t) => {
  const mock = mockSoap({ demora: 2500 });
  const app = crearServidor();
  const mockUrl = await servir(mock.servidor);
  const appUrl = await servir(app);
  t.after(async () => {
    await cerrar(mock.servidor);
    await cerrar(app);
  });

  const inicio = Date.now();
  const { status, datos } = await enviar(appUrl, {
    endpoint: mockUrl,
    envelope: construirEnvelope({ usuario: 'u', clave: 'c', pdfB64: PDF_B64 }),
    timeoutMs: 1000
  });
  const transcurrido = Date.now() - inicio;

  assert.equal(status, 504);
  assert.equal(datos.error.codigo, 'TIMEOUT');
  assert.ok(transcurrido < 2400, `el timeout tardó demasiado: ${transcurrido} ms`);
});

test('valida endpoint y sobre antes de reenviar', async (t) => {
  const app = crearServidor();
  const appUrl = await servir(app);
  t.after(() => cerrar(app));

  const sinEnvelope = await enviar(appUrl, { endpoint: 'http://127.0.0.1:1', envelope: '' });
  assert.equal(sinEnvelope.status, 400);

  const urlInvalida = await enviar(appUrl, { endpoint: 'no-es-url', envelope: '<x/>' });
  assert.equal(urlInvalida.status, 400);

  const protocoloInvalido = await enviar(appUrl, { endpoint: 'ftp://x.cl/a', envelope: '<x/>' });
  assert.equal(protocoloInvalido.status, 400);

  const jsonInvalido = await fetch(`${appUrl}/api/enviar`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: 'no es json'
  });
  assert.equal(jsonInvalido.status, 400);
});

test('prueba de endpoint distingue alcanzable, 405 e inválido', async (t) => {
  const mock = mockSoap();
  const app = crearServidor();
  const mockUrl = await servir(mock.servidor);
  const appUrl = await servir(app);
  t.after(async () => {
    await cerrar(mock.servidor);
    await cerrar(app);
  });

  const probar = async (endpoint) => {
    const respuesta = await fetch(`${appUrl}/api/probar`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ endpoint, timeoutMs: 3000 })
    });
    return { status: respuesta.status, datos: await respuesta.json() };
  };

  const alcanzable = await probar(mockUrl);
  assert.equal(alcanzable.status, 200);
  assert.equal(alcanzable.datos.ok, true);
  assert.equal(alcanzable.datos.httpStatus, 200);

  // Un endpoint SOAP real suele responder 405 a un GET: sigue siendo alcanzable.
  const soloPost = http.createServer((req, res) => {
    res.writeHead(405, { Allow: 'POST' });
    res.end();
  });
  const soloPostUrl = await servir(soloPost);
  t.after(() => cerrar(soloPost));

  const con405 = await probar(soloPostUrl);
  assert.equal(con405.datos.ok, true);
  assert.equal(con405.datos.httpStatus, 405);
  assert.match(con405.datos.nota, /no acepta GET/i);

  const invalido = await probar('no-es-url');
  assert.equal(invalido.status, 400);
  assert.equal(invalido.datos.ok, false);
});

async function diagnosticar(appUrl, endpoint, timeoutMs = 5000) {
  const respuesta = await fetch(`${appUrl}/api/diagnostico`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ endpoint, timeoutMs })
  });
  return { status: respuesta.status, datos: await respuesta.json() };
}

test('diagnostica una IP directa viva con TCP, HTTP y tiempos', async (t) => {
  const mock = mockSoap();
  const app = crearServidor();
  const mockUrl = await servir(mock.servidor);
  const appUrl = await servir(app);
  t.after(async () => {
    await cerrar(mock.servidor);
    await cerrar(app);
  });

  const { status, datos } = await diagnosticar(appUrl, `${mockUrl}/formex`);

  assert.equal(status, 200);
  assert.equal(datos.ok, true);
  assert.equal(datos.esIpDirecta, true);
  assert.equal(datos.dns.total, 1);
  assert.equal(datos.maquinas.length, 1);

  const maquina = datos.maquinas[0];
  assert.equal(maquina.direccion, '127.0.0.1');
  assert.equal(maquina.familia, 'IPv4');
  assert.equal(maquina.estado, 'viva');
  assert.equal(maquina.viva, true);
  assert.equal(maquina.tcp.ok, true);
  assert.equal(maquina.http.responde, true);
  assert.equal(maquina.http.status, 200);
  assert.ok(maquina.ms >= 0);
  assert.equal(datos.resumen.vivas, 1);
});

test('detecta varias direcciones del dominio y prueba cada máquina', async (t) => {
  const mock = mockSoap();
  const app = crearServidor();
  const mockUrl = await servir(mock.servidor);
  const appUrl = await servir(app);
  t.after(async () => {
    await cerrar(mock.servidor);
    await cerrar(app);
  });

  const puerto = new URL(mockUrl).port;
  const { status, datos } = await diagnosticar(appUrl, `http://localhost:${puerto}`);

  assert.equal(status, 200);
  assert.equal(datos.ok, true);
  assert.equal(datos.esIpDirecta, false);
  assert.ok(datos.dns.total >= 1, 'debe resolver al menos una dirección');
  assert.equal(datos.maquinas.length, datos.dns.total);
  assert.equal(datos.resumen.total, datos.dns.total);

  // 127.0.0.1 debe estar viva; si el sistema además resuelve ::1, esa máquina
  // no acepta la conexión y debe quedar como inaccesible (no como error global).
  const ipv4 = datos.maquinas.find((m) => m.direccion === '127.0.0.1');
  assert.ok(ipv4, 'debe incluir 127.0.0.1');
  assert.equal(ipv4.estado, 'viva');
  assert.equal(ipv4.http.status, 200);
  assert.ok(datos.resumen.vivas >= 1);

  for (const maquina of datos.maquinas) {
    assert.ok(['viva', 'tls-invalido', 'sin-http', 'inaccesible'].includes(maquina.estado), `estado raro: ${maquina.estado}`);
  }
});

test('marca como inaccesible una máquina con el puerto cerrado', async (t) => {
  const app = crearServidor();
  const appUrl = await servir(app);
  t.after(() => cerrar(app));

  const sonda = http.createServer();
  const puertoCerrado = await new Promise((resolver) => {
    sonda.listen(0, '127.0.0.1', () => {
      const puerto = sonda.address().port;
      sonda.close(() => resolver(puerto));
    });
  });

  const { datos } = await diagnosticar(appUrl, `http://127.0.0.1:${puertoCerrado}/formex`);
  assert.equal(datos.ok, true);
  assert.equal(datos.maquinas.length, 1);
  assert.equal(datos.maquinas[0].estado, 'inaccesible');
  assert.equal(datos.maquinas[0].viva, false);
  assert.equal(datos.maquinas[0].error.codigo, 'ECONNREFUSED');
  assert.equal(datos.resumen.inaccesibles, 1);
});

test('informa el fallo de DNS y valida la URL en el diagnóstico', async (t) => {
  const app = crearServidor();
  const appUrl = await servir(app);
  t.after(() => cerrar(app));

  const inexistente = await diagnosticar(appUrl, 'http://servicio-inexistente-ctformex.invalid/formex');
  assert.equal(inexistente.status, 200);
  assert.equal(inexistente.datos.ok, false);
  assert.deepEqual(inexistente.datos.maquinas, []);
  assert.ok(inexistente.datos.dns.error.codigo);
  assert.match(inexistente.datos.dns.error.mensaje, /resolver/i);

  const invalida = await diagnosticar(appUrl, 'no-es-url');
  assert.equal(invalida.status, 400);
  assert.equal(invalida.datos.ok, false);
});

test('sirve la interfaz y bloquea el acceso fuera de public/', async (t) => {
  const app = crearServidor();
  const appUrl = await servir(app);
  t.after(() => cerrar(app));

  const inicio = await fetch(appUrl);
  assert.equal(inicio.status, 200);
  assert.match(inicio.headers.get('content-type'), /text\/html/);
  assert.match(await inicio.text(), /Carpetas Tributarias/);

  for (const archivo of ['/styles.css', '/app.js', '/envelope.js', '/base64.js']) {
    const respuesta = await fetch(`${appUrl}${archivo}`);
    assert.equal(respuesta.status, 200, `no se sirvió ${archivo}`);
    assert.match(respuesta.headers.get('content-type'), /css|javascript/);
  }

  const salud = await fetch(`${appUrl}/api/salud`);
  assert.equal(salud.status, 200);
  assert.equal((await salud.json()).ok, true);

  const traversal = await fetch(`${appUrl}/%2e%2e%2fserver.js`);
  assert.ok([403, 404].includes(traversal.status), `traversal devolvió ${traversal.status}`);
  assert.ok(!(await traversal.text()).includes('crearServidor'));

  const inexistente = await fetch(`${appUrl}/no-existe.js`);
  assert.equal(inexistente.status, 404);
});
