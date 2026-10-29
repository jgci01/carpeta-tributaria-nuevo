/**
 * Servidor local para el Gestor de Carpetas Tributarias.
 *
 * Dos responsabilidades:
 *   1. Servir la interfaz web (carpeta ./public).
 *   2. Hacer de puente hacia el endpoint SOAP, evitando el bloqueo CORS del
 *      navegador al llamar a otro dominio. El navegador nunca habla directo
 *      con el servicio: siempre pasa por /api/enviar.
 *
 * No usa dependencias externas: solo la librería estándar de Node (>= 18).
 */
import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns';
import net from 'node:net';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { exec } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLICO = path.join(__dirname, 'public');

const VERSION = '1.1.0';
const PUERTO_BASE = Number(process.env.PORT) || 4599;
const HOST = process.env.HOST || '127.0.0.1';

// Una carpeta tributaria puede pesar bastante; el Base64 en JSON ocupa ~33% más.
const LIMITE_PETICION = 512 * 1024 * 1024; // 512 MB
const LIMITE_RESPUESTA = 32 * 1024 * 1024; // 32 MB

const TIPOS = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.png', 'image/png'],
  ['.ico', 'image/x-icon'],
  ['.woff2', 'font/woff2'],
  ['.txt', 'text/plain; charset=utf-8']
]);

const CABECERAS_SEGURIDAD = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy':
    "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'Cache-Control': 'no-store'
};

const hora = () => new Date().toLocaleTimeString('es-CL', { hour12: false });

function responderJson(res, codigo, objeto) {
  const cuerpo = JSON.stringify(objeto);
  res.writeHead(codigo, {
    ...CABECERAS_SEGURIDAD,
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(cuerpo)
  });
  res.end(cuerpo);
}

function errorHttp(codigo, mensaje, extra = {}) {
  return Object.assign(new Error(mensaje), { status: codigo, ...extra });
}

/** Lee el cuerpo completo controlando el tamaño máximo. */
function leerCuerpo(req, limite) {
  return new Promise((resolve, reject) => {
    const trozos = [];
    let total = 0;
    req.on('data', (trozo) => {
      total += trozo.length;
      if (total > limite) {
        reject(errorHttp(413, 'La petición es demasiado grande para el servidor local.'));
        req.destroy();
        return;
      }
      trozos.push(trozo);
    });
    req.on('end', () => resolve(Buffer.concat(trozos)));
    req.on('error', (err) => reject(errorHttp(400, `Error leyendo la petición: ${err.message}`)));
  });
}

async function leerJson(req) {
  const crudo = await leerCuerpo(req, LIMITE_PETICION);
  if (!crudo.length) throw errorHttp(400, 'La petición llegó vacía.');
  try {
    return JSON.parse(crudo.toString('utf8'));
  } catch {
    throw errorHttp(400, 'El cuerpo de la petición no es JSON válido.');
  }
}

function validarUrlEndpoint(valor) {
  let url;
  try {
    url = new URL(String(valor || '').trim());
  } catch {
    throw errorHttp(400, 'El endpoint no es una URL válida.');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw errorHttp(400, 'El endpoint debe comenzar con http:// o https://');
  }
  return url;
}

function ajustarTimeout(valor) {
  const n = Number(valor);
  if (!Number.isFinite(n)) return 120_000;
  return Math.min(Math.max(Math.round(n), 1_000), 600_000);
}

/** Traduce errores de red de Node a mensajes entendibles. */
function codigoDeError(err) {
  const vistos = new Set();
  const buscar = (nodo) => {
    if (!nodo || typeof nodo !== 'object' || vistos.has(nodo)) return null;
    vistos.add(nodo);
    if (typeof nodo.code === 'string') return nodo.code;
    const hijos = [nodo.cause, ...(Array.isArray(nodo.errors) ? nodo.errors : [])];
    for (const hijo of hijos) {
      const encontrado = buscar(hijo);
      if (encontrado) return encontrado;
    }
    return null;
  };
  return buscar(err) || err?.name || 'ERROR_RED';
}

function describirErrorRed(err) {
  const codigo = codigoDeError(err);
  const mapa = {
    ENOTFOUND: 'No se pudo resolver el dominio del endpoint (DNS). Revisa la URL o tu conexión.',
    EAI_AGAIN: 'El DNS no respondió. Revisa tu conexión a internet.',
    ECONNREFUSED: 'El servidor rechazó la conexión (puerto cerrado o servicio apagado).',
    ECONNRESET: 'La conexión se cortó inesperadamente durante el envío.',
    ETIMEDOUT: 'Se agotó el tiempo de espera al conectar con el endpoint.',
    UND_ERR_CONNECT_TIMEOUT: 'Se agotó el tiempo de espera al conectar con el endpoint.',
    UND_ERR_HEADERS_TIMEOUT: 'El servidor no respondió a tiempo.',
    CERT_HAS_EXPIRED: 'El certificado TLS del endpoint está vencido.',
    DEPTH_ZERO_SELF_SIGNED_CERT: 'El endpoint usa un certificado TLS autofirmado.',
    SELF_SIGNED_CERT_IN_CHAIN: 'La cadena TLS del endpoint incluye un certificado autofirmado.',
    UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'No se pudo verificar el certificado TLS del endpoint.',
    ERR_TLS_CERT_ALTNAME_INVALID: 'El certificado TLS no coincide con el dominio del endpoint.'
  };
  const detalle = err?.cause?.message || err?.message || 'error desconocido';
  const mensaje = mapa[codigo] || `No se pudo contactar el endpoint: ${detalle}`;
  if (/bad port/i.test(detalle)) {
    return { codigo, mensaje: 'El endpoint usa un puerto bloqueado por el navegador/protocolo HTTP.' };
  }
  return { codigo, mensaje };
}

function decodificarTexto(buffer, contentType) {
  const coincidencia = /charset\s*=\s*["']?([\w.-]+)/i.exec(contentType || '');
  const etiqueta = coincidencia ? coincidencia[1] : 'utf-8';
  try {
    return new TextDecoder(etiqueta).decode(buffer);
  } catch {
    return new TextDecoder('utf-8').decode(buffer);
  }
}

/** POST /api/enviar — reenvía un sobre SOAP ya armado por el navegador. */
async function manejarEnviar(req, res) {
  const datos = await leerJson(req);
  const url = validarUrlEndpoint(datos.endpoint);

  const envelope = typeof datos.envelope === 'string' ? datos.envelope.trim() : '';
  if (!envelope) throw errorHttp(400, 'Falta el sobre SOAP (envelope).');
  if (!envelope.startsWith('<')) throw errorHttp(400, 'El sobre SOAP no parece XML válido.');

  const timeoutMs = ajustarTimeout(datos.timeoutMs);
  const contentType = typeof datos.contentType === 'string' && datos.contentType.trim()
    ? datos.contentType.trim()
    : 'text/xml; charset=utf-8';

  const cabeceras = {
    'Content-Type': contentType,
    Accept: 'text/xml, application/soap+xml, application/xml, */*'
  };
  const soapAction = typeof datos.soapAction === 'string' ? datos.soapAction.replace(/[\r\n]/g, '').trim() : '';
  // SOAP 1.2 lleva la acción en el Content-Type; SOAP 1.1 en la cabecera SOAPAction.
  if (soapAction) {
    if (contentType.includes('application/soap+xml')) {
      const base = contentType.replace(/;\s*action\s*=\s*("[^"]*"|[^;]*)/i, '').trim();
      cabeceras['Content-Type'] = `${base}; action="${soapAction}"`;
    } else {
      cabeceras.SOAPAction = `"${soapAction}"`;
    }
  }

  const inicio = performance.now();
  let respuesta;
  try {
    respuesta = await fetch(url, {
      method: 'POST',
      headers: cabeceras,
      body: envelope,
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'follow'
    });
  } catch (err) {
    if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
      return responderJson(res, 504, {
        ok: false,
        error: {
          codigo: 'TIMEOUT',
          mensaje: `El endpoint no respondió en ${Math.round(timeoutMs / 1000)} s.`
        },
        ms: Math.round(performance.now() - inicio)
      });
    }
    const info = describirErrorRed(err);
    return responderJson(res, 502, {
      ok: false,
      error: { codigo: info.codigo, mensaje: info.mensaje },
      ms: Math.round(performance.now() - inicio)
    });
  }

  const bytes = Buffer.from(await respuesta.arrayBuffer());
  if (bytes.length > LIMITE_RESPUESTA) {
    throw errorHttp(502, `La respuesta del servicio supera los ${Math.round(LIMITE_RESPUESTA / 1024 / 1024)} MB.`);
  }

  const contentTypeRespuesta = respuesta.headers.get('content-type') || '';
  responderJson(res, 200, {
    ok: true,
    httpStatus: respuesta.status,
    statusText: respuesta.statusText,
    contentType: contentTypeRespuesta,
    bytes: bytes.length,
    ms: Math.round(performance.now() - inicio),
    cuerpo: decodificarTexto(bytes, contentTypeRespuesta),
    cabeceras: {
      soapaction: respuesta.headers.get('soapaction') || '',
      servidor: respuesta.headers.get('server') || ''
    }
  });
}

/** POST /api/probar — verifica que el endpoint exista y responda algo. */
async function manejarProbar(req, res) {
  const datos = await leerJson(req);
  const url = validarUrlEndpoint(datos.endpoint);
  const timeoutMs = Math.min(ajustarTimeout(datos.timeoutMs ?? 10_000), 30_000);
  const inicio = performance.now();

  try {
    const respuesta = await fetch(url, {
      method: 'GET',
      headers: { Accept: 'text/xml, application/soap+xml, */*' },
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'follow'
    });
    responderJson(res, 200, {
      ok: true,
      httpStatus: respuesta.status,
      statusText: respuesta.statusText,
      ms: Math.round(performance.now() - inicio),
      nota:
        respuesta.status === 405 || respuesta.status === 415
          ? 'El servicio respondió que no acepta GET (normal en SOAP): el endpoint existe.'
          : 'El endpoint respondió.'
    });
  } catch (err) {
    if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
      return responderJson(res, 200, {
        ok: false,
        error: { codigo: 'TIMEOUT', mensaje: `Sin respuesta en ${Math.round(timeoutMs / 1000)} s.` },
        ms: Math.round(performance.now() - inicio)
      });
    }
    const info = describirErrorRed(err);
    responderJson(res, 200, { ok: false, error: info, ms: Math.round(performance.now() - inicio) });
  }
}

/* ------------------------------------------------------------------ */
/* Diagnóstico del endpoint: DNS, máquinas, TCP, TLS y HTTP            */
/* ------------------------------------------------------------------ */

const CODIGOS_CERTIFICADO = new Set([
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'UNABLE_TO_GET_ISSUER_CERT',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'CERT_HAS_EXPIRED',
  'CERT_NOT_YET_VALID',
  'CERT_SIGNATURE_FAILURE',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'HOSTNAME_MISMATCH'
]);

function esErrorCertificado(codigo) {
  return CODIGOS_CERTIFICADO.has(String(codigo || '').toUpperCase());
}

function sinCorchetes(hostname) {
  return hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
}

/** Resuelve todas las direcciones del dominio (A y AAAA) con límite de tiempo. */
function resolverDirecciones(hostname, timeoutMs) {
  const tipoIp = net.isIP(hostname);
  if (tipoIp) {
    return Promise.resolve({
      direcciones: [{ direccion: hostname, familia: tipoIp === 6 ? 'IPv6' : 'IPv4' }],
      origen: 'ip-directa',
      error: null
    });
  }

  return new Promise((resolver) => {
    let terminado = false;
    const temporizador = setTimeout(() => {
      if (terminado) return;
      terminado = true;
      resolver({
        direcciones: [],
        origen: 'dns',
        error: { codigo: 'DNS_TIMEOUT', mensaje: 'El servidor DNS no respondió a tiempo.' }
      });
    }, timeoutMs);

    dns.lookup(hostname, { all: true, verbatim: true }, (err, direcciones) => {
      if (terminado) return;
      terminado = true;
      clearTimeout(temporizador);
      if (err) {
        resolver({
          direcciones: [],
          origen: 'dns',
          error: { codigo: err.code || 'DNS_ERROR', mensaje: `No se pudo resolver "${hostname}": ${err.message}` }
        });
        return;
      }
      resolver({
        direcciones: (direcciones || []).map((d) => ({
          direccion: d.address,
          familia: d.family === 6 || d.family === 'IPv6' ? 'IPv6' : 'IPv4'
        })),
        origen: 'dns',
        error: null
      });
    });
  });
}

/**
 * Hace un GET al endpoint forzando la conexión a una dirección concreta,
 * conservando el Host y el SNI del dominio original.
 */
function intentarConexion({ url, direccion, familia, timeoutMs, validarTls }) {
  return new Promise((resolver) => {
    const inicio = performance.now();
    const esHttps = url.protocol === 'https:';
    const puerto = Number(url.port) || (esHttps ? 443 : 80);
    const familiaNumero = familia === 'IPv6' ? 6 : 4;

    const resultado = {
      direccion,
      familia,
      estado: 'inaccesible',
      viva: false,
      tcp: { ok: false, ms: null },
      tls: esHttps
        ? { aplica: true, ok: false, autorizacion: 'desconocida', ms: null, protocolo: '', certificado: null, error: '' }
        : { aplica: false },
      http: { responde: false, status: null, statusText: '', servidor: '', tipoContenido: '', ms: null },
      error: null,
      ms: 0
    };

    let terminado = false;
    let temporizador = null;
    let marcaTcp = null;

    const terminar = (err) => {
      if (terminado) return;
      terminado = true;
      clearTimeout(temporizador);
      if (err && !resultado.error) {
        const info = describirErrorRed(err);
        resultado.error = { codigo: info.codigo, mensaje: info.mensaje };
      }
      resultado.ms = Math.round(performance.now() - inicio);
      resolver(resultado);
    };

    const opciones = {
      protocol: url.protocol,
      hostname: url.hostname,
      port: puerto,
      path: `${url.pathname || '/'}${url.search || ''}`,
      method: 'GET',
      agent: false,
      headers: {
        Accept: 'text/xml, application/soap+xml, application/xml, */*',
        'User-Agent': 'CarpetasTributarias-Diagnostico/1.0',
        Connection: 'close'
      },
      lookup: (_host, opcionesLookup, cb) => {
        if (opcionesLookup && opcionesLookup.all) cb(null, [{ address: direccion, family: familiaNumero }]);
        else cb(null, direccion, familiaNumero);
      },
      rejectUnauthorized: validarTls,
      servername: esHttps && !net.isIP(sinCorchetes(url.hostname)) ? sinCorchetes(url.hostname) : undefined
    };

    const modulo = esHttps ? https : http;
    let peticion;

    try {
      peticion = modulo.request(opciones, (respuesta) => {
        resultado.http.responde = true;
        resultado.http.status = respuesta.statusCode ?? null;
        resultado.http.statusText = respuesta.statusMessage || '';
        resultado.http.servidor = String(respuesta.headers.server || '');
        resultado.http.tipoContenido = String(respuesta.headers['content-type'] || '');
        resultado.http.ms = Math.round(performance.now() - inicio);
        resultado.viva = true;
        respuesta.resume();
        respuesta.on('end', () => terminar());
        respuesta.on('close', () => terminar());
        respuesta.on('error', (err) => terminar(err));
      });
    } catch (err) {
      terminar(err);
      return;
    }

    peticion.on('socket', (socket) => {
      socket.once('connect', () => {
        resultado.tcp.ok = true;
        marcaTcp = performance.now();
        resultado.tcp.ms = Math.round(marcaTcp - inicio);
      });
      if (!esHttps) return;
      socket.once('secureConnect', () => {
        resultado.tls.ok = true;
        if (marcaTcp != null) resultado.tls.ms = Math.round(performance.now() - marcaTcp);
        try {
          resultado.tls.protocolo = typeof socket.getProtocol === 'function' ? socket.getProtocol() || '' : '';
        } catch {
          resultado.tls.protocolo = '';
        }
        try {
          const certificado = typeof socket.getPeerCertificate === 'function' ? socket.getPeerCertificate() : null;
          if (certificado && certificado.subject) {
            resultado.tls.certificado = {
              sujeto: certificado.subject.CN || '',
              emisor: certificado.issuer?.CN || '',
              vence: certificado.valid_to || ''
            };
          }
        } catch {
          resultado.tls.certificado = null;
        }
        resultado.tls.autorizacion = socket.authorized ? 'ok' : 'invalido';
        if (!socket.authorized && socket.authorizationError) {
          resultado.tls.error = String(socket.authorizationError);
        }
      });
    });

    peticion.on('error', (err) => terminar(err));
    peticion.end();

    temporizador = setTimeout(() => {
      try {
        peticion.destroy();
      } catch {
        /* ignora */
      }
      terminar(Object.assign(new Error('Tiempo de espera agotado'), { code: 'TIMEOUT' }));
    }, timeoutMs);
  });
}

function clasificarMaquina(resultado) {
  if (resultado.http.responde) {
    resultado.viva = true;
    resultado.estado =
      resultado.tls.aplica && resultado.tls.autorizacion === 'invalido' ? 'tls-invalido' : 'viva';
  } else if (resultado.tcp.ok) {
    resultado.viva = false;
    resultado.estado = 'sin-http';
  } else {
    resultado.viva = false;
    resultado.estado = 'inaccesible';
  }
  return resultado;
}

/** Prueba una máquina. Si el certificado TLS falla, reintenta sin validarlo. */
async function probarDireccion({ url, direccion, familia, timeoutMs }) {
  const intento = clasificarMaquina(await intentarConexion({ url, direccion, familia, timeoutMs, validarTls: true }));

  if (url.protocol === 'https:' && !intento.http.responde && esErrorCertificado(intento.error?.codigo)) {
    const sinValidar = await intentarConexion({ url, direccion, familia, timeoutMs, validarTls: false });
    sinValidar.tls.autorizacion = 'invalido';
    sinValidar.tls.error = intento.error?.mensaje || 'Certificado TLS no válido.';
    sinValidar.tls.inseguroConfirmado = true;
    return clasificarMaquina(sinValidar);
  }

  return intento;
}

/** POST /api/diagnostico — resuelve el dominio y prueba cada máquina detectada. */
async function manejarDiagnostico(req, res) {
  const datos = await leerJson(req);
  const url = validarUrlEndpoint(datos.endpoint);
  const hostname = sinCorchetes(url.hostname);
  const esHttps = url.protocol === 'https:';
  const puerto = Number(url.port) || (esHttps ? 443 : 80);
  const timeoutMs = Math.min(Math.max(Number(datos.timeoutMs) || 8000, 1000), 20_000);
  const inicio = performance.now();

  const resolucion = await resolverDirecciones(hostname, Math.min(timeoutMs, 6000));
  const dnsMs = Math.round(performance.now() - inicio);

  const base = {
    hostname,
    puerto,
    protocolo: url.protocol.replace(':', ''),
    ruta: `${url.pathname || '/'}${url.search || ''}`,
    esIpDirecta: net.isIP(hostname) !== 0,
    dns: { ms: dnsMs, total: 0, origen: resolucion.origen, error: resolucion.error || null }
  };

  if (resolucion.error) {
    responderJson(res, 200, {
      ...base,
      ok: false,
      maquinas: [],
      resumen: { total: 0, vivas: 0, tlsInvalidos: 0, sinRespuesta: 0, inaccesibles: 0 },
      ms: Math.round(performance.now() - inicio)
    });
    return;
  }

  const vistas = new Set();
  const direcciones = [];
  for (const entrada of resolucion.direcciones) {
    if (vistas.has(entrada.direccion)) continue;
    vistas.add(entrada.direccion);
    direcciones.push(entrada);
    if (direcciones.length >= 16) break; // evita diagnósticos enormes
  }
  base.dns.total = direcciones.length;

  const maquinas = await Promise.all(
    direcciones.map((entrada) =>
      probarDireccion({ url, direccion: entrada.direccion, familia: entrada.familia, timeoutMs })
    )
  );

  const resumen = {
    total: maquinas.length,
    vivas: maquinas.filter((m) => m.estado === 'viva').length,
    tlsInvalidos: maquinas.filter((m) => m.estado === 'tls-invalido').length,
    sinRespuesta: maquinas.filter((m) => m.estado === 'sin-http').length,
    inaccesibles: maquinas.filter((m) => m.estado === 'inaccesible').length
  };

  responderJson(res, 200, {
    ...base,
    ok: true,
    maquinas,
    resumen,
    ms: Math.round(performance.now() - inicio)
  });
}

async function servirEstatico(req, res, ruta) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { ...CABECERAS_SEGURIDAD, Allow: 'GET, HEAD' });
    res.end();
    return;
  }
  let relativa;
  try {
    relativa = decodeURIComponent(ruta.split('?')[0]);
  } catch {
    relativa = '/';
  }
  if (relativa === '/' || relativa === '') relativa = '/index.html';

  const destino = path.resolve(PUBLICO, '.' + path.posix.normalize(relativa));
  if (destino !== PUBLICO && !destino.startsWith(PUBLICO + path.sep)) {
    res.writeHead(403, CABECERAS_SEGURIDAD);
    res.end('Prohibido');
    return;
  }

  try {
    const info = await fsp.stat(destino);
    if (info.isDirectory()) {
      res.writeHead(302, { Location: `${relativa.replace(/\/$/, '')}/index.html` });
      res.end();
      return;
    }
    const extension = path.extname(destino).toLowerCase();
    const tipo = TIPOS.get(extension) || 'application/octet-stream';
    res.writeHead(200, {
      ...CABECERAS_SEGURIDAD,
      'Content-Type': tipo,
      'Content-Length': info.size
    });
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    res.end(await fsp.readFile(destino));
  } catch {
    res.writeHead(404, { ...CABECERAS_SEGURIDAD, 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('No encontrado');
  }
}

export function crearServidor() {
  return http.createServer(async (req, res) => {
    const inicio = performance.now();
    const ruta = (req.url || '/').split('?')[0];

    res.on('finish', () => {
      if (process.env.CTFORMEX_SILENCIO === '1') return;
      const ms = Math.round(performance.now() - inicio);
      console.log(`[${hora()}] ${req.method} ${ruta} → ${res.statusCode} (${ms} ms)`);
    });

    try {
      if (ruta === '/api/salud' && req.method === 'GET') {
        responderJson(res, 200, { ok: true, version: VERSION, node: process.version });
        return;
      }
      if (ruta === '/api/enviar' && req.method === 'POST') {
        await manejarEnviar(req, res);
        return;
      }
      if (ruta === '/api/probar' && req.method === 'POST') {
        await manejarProbar(req, res);
        return;
      }
      if (ruta === '/api/diagnostico' && req.method === 'POST') {
        await manejarDiagnostico(req, res);
        return;
      }
      if (ruta.startsWith('/api/')) {
        responderJson(res, 404, { ok: false, error: { codigo: 'NO_ENCONTRADO', mensaje: `Ruta ${ruta} no existe.` } });
        return;
      }
      await servirEstatico(req, res, ruta);
    } catch (err) {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      const status = err?.status || 500;
      if (status >= 500) console.error(`[${hora()}] Error en ${req.method} ${ruta}:`, err);
      responderJson(res, status, {
        ok: false,
        error: { codigo: err?.codigo || 'ERROR', mensaje: err?.message || 'Error interno del servidor local.' }
      });
    }
  });
}

function abrirNavegador(url) {
  const comando =
    process.platform === 'win32'
      ? `start "" "${url}"`
      : process.platform === 'darwin'
        ? `open "${url}"`
        : `xdg-open "${url}"`;
  exec(comando, (err) => {
    if (err) console.log(`Abre manualmente: ${url}`);
  });
}

export function iniciar({ puerto = PUERTO_BASE, host = HOST, abrir = false, intentos = 15 } = {}) {
  const servidor = crearServidor();

  servidor.on('error', (err) => {
    if (err.code === 'EADDRINUSE' && intentos > 0) {
      console.log(`El puerto ${puerto} está ocupado, probando ${puerto + 1}…`);
      servidor.close();
      iniciar({ puerto: puerto + 1, host, abrir, intentos: intentos - 1 });
      return;
    }
    console.error('No se pudo iniciar el servidor:', err.message);
    process.exitCode = 1;
  });

  servidor.listen(puerto, host, () => {
    const url = `http://${host}:${puerto}`;
    if (process.env.CTFORMEX_SILENCIO !== '1') {
      console.log('');
      console.log('  Gestor de Carpetas Tributarias · Formex');
      console.log(`  Interfaz: ${url}`);
      console.log(`  Node ${process.version} · puerto ${puerto}`);
      console.log('  Detén el proceso con Ctrl+C.');
      console.log('');
    }
    if (abrir) abrirNavegador(url);
  });

  return servidor;
}

const ejecutadoDirectamente =
  process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (ejecutadoDirectamente) {
  iniciar({ abrir: process.argv.includes('--abrir') });
}
