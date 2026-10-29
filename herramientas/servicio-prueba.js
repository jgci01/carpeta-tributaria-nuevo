/**
 * Servicio SOAP de prueba (NO es el servicio real de Credex).
 *
 * Sirve para validar la aplicación de punta a punta sin credenciales reales:
 * recibe el mismo sobre procesaCTE y responde con una estructura similar.
 *
 * Uso:
 *   node herramientas/servicio-prueba.js
 *   → endpoint a configurar en la aplicación: http://127.0.0.1:4601/formex
 *
 * Reglas:
 *   - Clave "error"  → responde un SOAP Fault 500 (para probar errores).
 *   - Sin usuario/clave → responde un SOAP Fault 500.
 *   - Cualquier otra combinación → respuesta exitosa.
 */
import http from 'node:http';

const PUERTO = Number(process.env.PUERTO || 4601);
const HOST = process.env.HOST || '127.0.0.1';

const escapar = (texto) => String(texto ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function respuestaOk({ usuario, bytesPdf, nombre }) {
  const track = `TRK-${Date.now().toString(36).toUpperCase()}`;
  const interno = [
    '<Respuesta>',
    '<Codigo>0</Codigo>',
    '<Mensaje>Carpeta tributaria recibida correctamente</Mensaje>',
    `<TrackId>${track}</TrackId>`,
    `<Usuario>${escapar(usuario)}</Usuario>`,
    `<PdfBytes>${bytesPdf}</PdfBytes>`,
    `<Archivo>${escapar(nombre)}</Archivo>`,
    '</Respuesta>'
  ].join('');
  const escapado = interno.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body>
    <procesaCTEResponse xmlns="http://portalcredex.cl/formex">
      <procesaCTEResult>${escapado}</procesaCTEResult>
    </procesaCTEResponse>
  </soap:Body>
</soap:Envelope>`;
}

function respuestaFault(mensaje) {
  return `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body>
    <soap:Fault>
      <faultcode>soap:Server</faultcode>
      <faultstring>${escapar(mensaje)}</faultstring>
    </soap:Fault>
  </soap:Body>
</soap:Envelope>`;
}

const servidor = http.createServer((req, res) => {
  const partes = [];
  req.on('data', (parte) => partes.push(parte));
  req.on('end', () => {
    const cuerpo = Buffer.concat(partes).toString('utf8');
    const ruta = (req.url || '/').split('?')[0];

    if (ruta !== '/formex' && ruta !== '/') {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Ruta no encontrada. Usa /formex');
      return;
    }

    if (req.method !== 'POST') {
      res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8', Allow: 'POST' });
      res.end('Este servicio solo acepta POST (SOAP).');
      return;
    }

    const usuario = /<for:Usuario>([\s\S]*?)<\/for:Usuario>/.exec(cuerpo)?.[1]?.trim() || '';
    const clave = /<for:Clave>([\s\S]*?)<\/for:Clave>/.exec(cuerpo)?.[1]?.trim() || '';
    const pdfB64 = /<for:PDFB64>([\s\S]*?)<\/for:PDFB64>/.exec(cuerpo)?.[1]?.trim() || '';
    const bytesPdf = Math.floor((pdfB64.length * 3) / 4);

    console.log(
      `[${new Date().toLocaleTimeString('es-CL', { hour12: false })}] procesaCTE · usuario="${usuario}" · PDF ${bytesPdf.toLocaleString('es-CL')} bytes`
    );

    if (!usuario || !clave) {
      const fault = respuestaFault('Credenciales incompletas: se requiere Usuario y Clave.');
      res.writeHead(500, { 'Content-Type': 'text/xml; charset=utf-8' });
      res.end(fault);
      return;
    }

    if (clave.toLowerCase() === 'error') {
      const fault = respuestaFault('Clave inválida para el usuario indicado.');
      res.writeHead(500, { 'Content-Type': 'text/xml; charset=utf-8' });
      res.end(fault);
      return;
    }

    setTimeout(() => {
      res.writeHead(200, { 'Content-Type': 'text/xml; charset=utf-8' });
      res.end(respuestaOk({ usuario, bytesPdf, nombre: 'carpeta.pdf' }));
    }, 250);
  });
});

servidor.listen(PUERTO, HOST, () => {
  console.log('');
  console.log('  Servicio SOAP de PRUEBA (no es Credex)');
  console.log(`  Endpoint: http://${HOST}:${PUERTO}/formex`);
  console.log('  Usuario: cualquiera · Clave: cualquiera (usa "error" para simular fallo)');
  console.log('  Ctrl+C para detener.');
  console.log('');
});
