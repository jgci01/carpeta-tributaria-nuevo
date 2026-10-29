/**
 * Lógica de la interfaz: carga de carpetas, conversión a Base64,
 * envío del sobre SOAP a través del servidor local y reporte de resultados.
 */
import { construirEnvelope } from './envelope.js';
import { bytesABase64, esPDF, formatearBytes } from './base64.js';

const $ = (id) => document.getElementById(id);

const CLAVE_CONFIG = 'ctformex.config.v1';
const CLAVE_PREFS = 'ctformex.prefs.v1';
const MAX_REGISTRO = 300;
const LIMITE_VISTA_PREVIA = 200_000;

const CONFIG_BASE = {
  endpoint: '',
  usuario: '',
  clave: '',
  origen: 'WS',
  soapAction: '',
  contentType: 'text/xml; charset=utf-8',
  timeoutSeg: 120,
  concurrencia: 2,
  incluirDeclaracion: false,
  recordar: false
};

const PREFS_BASE = { modo: 'enviar', soloPDF: true };

const ETIQUETAS_ESTADO = {
  pendiente: 'Pendiente',
  convirtiendo: 'Convirtiendo',
  enviando: 'Enviando',
  ok: 'OK',
  error: 'Error',
  detenido: 'Detenido'
};

let config = { ...CONFIG_BASE };
let prefs = { ...PREFS_BASE };
let items = [];
let idSecuencia = 0;
let procesando = false;
let detenerSolicitado = false;
let temporizadorGuardado = null;
let temporizadorProgreso = null;
let registroLineas = [];
const filas = new Map();
const modalEstado = { texto: '', descarga: null, url: null };

/* ------------------------------------------------------------------ */
/* Persistencia                                                        */
/* ------------------------------------------------------------------ */

function leerAlmacen(clave, respaldo) {
  try {
    const crudo = localStorage.getItem(clave);
    if (!crudo) return { ...respaldo };
    const datos = JSON.parse(crudo);
    return { ...respaldo, ...(datos && typeof datos === 'object' ? datos : {}) };
  } catch {
    return { ...respaldo };
  }
}

function guardarConfig() {
  try {
    const copia = { ...config };
    if (!copia.recordar) delete copia.clave;
    localStorage.setItem(CLAVE_CONFIG, JSON.stringify(copia));
    marcarGuardado();
  } catch {
    /* almacenamiento lleno o bloqueado: se ignora */
  }
}

function guardarPrefs() {
  try {
    localStorage.setItem(CLAVE_PREFS, JSON.stringify(prefs));
  } catch {
    /* idem */
  }
}

function marcarGuardado() {
  const aviso = $('guardado');
  aviso.textContent = 'Guardado ✓';
  aviso.classList.add('visible');
  clearTimeout(temporizadorGuardado);
  temporizadorGuardado = setTimeout(() => aviso.classList.remove('visible'), 1500);
}

/* ------------------------------------------------------------------ */
/* Utilidades                                                          */
/* ------------------------------------------------------------------ */

function recortar(texto, maximo) {
  const limpio = String(texto ?? '').trim();
  return limpio.length > maximo ? `${limpio.slice(0, maximo - 1)}…` : limpio;
}

/** "1 archivo" / "3 archivos" según corresponda. */
function plural(cantidad, singular, pluralTexto) {
  return `${cantidad} ${cantidad === 1 ? singular : pluralTexto}`;
}

function marcaTiempo() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`;
}

function nombreSeguro(valor) {
  return String(valor || 'archivo')
    .replace(/[^\w.\- ]+/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120) || 'archivo';
}

function descargar(nombre, contenido, tipo = 'text/plain;charset=utf-8') {
  const blob = contenido instanceof Blob ? contenido : new Blob([contenido], { type: tipo });
  const url = URL.createObjectURL(blob);
  const enlace = document.createElement('a');
  enlace.href = url;
  enlace.download = nombre;
  document.body.appendChild(enlace);
  enlace.click();
  enlace.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

function avisar(mensaje, tipo = 'info', duracion = 4200) {
  const contenedor = $('avisos');
  while (contenedor.children.length >= 3) contenedor.firstElementChild.remove();
  const aviso = document.createElement('div');
  aviso.className = 'aviso';
  aviso.dataset.tipo = tipo;
  aviso.textContent = mensaje;
  contenedor.appendChild(aviso);
  setTimeout(() => {
    aviso.classList.add('saliendo');
    setTimeout(() => aviso.remove(), 220);
  }, duracion);
}

function log(mensaje, tipo = 'info') {
  const hora = new Date().toLocaleTimeString('es-CL', { hour12: false });
  const prefijo = tipo === 'error' ? '✕' : tipo === 'ok' ? '✓' : '·';
  registroLineas.push(`${hora}  ${prefijo}  ${mensaje}`);
  if (registroLineas.length > MAX_REGISTRO) registroLineas = registroLineas.slice(-MAX_REGISTRO);
  const caja = $('registro');
  caja.textContent = registroLineas.join('\n');
  caja.scrollTop = caja.scrollHeight;
  $('registroContador').textContent = String(registroLineas.length);
}

/* ------------------------------------------------------------------ */
/* Configuración                                                       */
/* ------------------------------------------------------------------ */

const CAMPOS_CONFIG = ['endpoint', 'usuario', 'clave', 'origen', 'soapAction'];

function pintarConfig() {
  for (const id of CAMPOS_CONFIG) {
    const el = $(id);
    if (el) el.value = config[id] ?? '';
  }
  $('contentType').value = config.contentType;
  $('timeoutSeg').value = String(config.timeoutSeg);
  $('concurrencia').value = String(config.concurrencia);
  $('incluirDeclaracion').checked = Boolean(config.incluirDeclaracion);
  $('recordar').checked = Boolean(config.recordar);
}

function conectarConfig() {
  for (const id of CAMPOS_CONFIG) {
    const el = $(id);
    el.addEventListener('input', () => {
      config[id] = el.value;
      guardarConfig();
      if (id === 'endpoint') limpiarDiagnostico();
    });
  }

  $('contentType').addEventListener('change', (e) => {
    config.contentType = e.target.value;
    guardarConfig();
  });

  $('timeoutSeg').addEventListener('input', (e) => {
    const valor = Number(e.target.value);
    config.timeoutSeg = Number.isFinite(valor) && valor > 0 ? Math.min(Math.max(valor, 5), 600) : 120;
    guardarConfig();
  });

  $('concurrencia').addEventListener('change', (e) => {
    config.concurrencia = Math.min(Math.max(Number(e.target.value) || 1, 1), 8);
    guardarConfig();
  });

  $('incluirDeclaracion').addEventListener('change', (e) => {
    config.incluirDeclaracion = e.target.checked;
    guardarConfig();
  });

  $('recordar').addEventListener('change', (e) => {
    config.recordar = e.target.checked;
    guardarConfig();
    try {
      if (!config.recordar) {
        const copia = JSON.parse(localStorage.getItem(CLAVE_CONFIG) || '{}');
        delete copia.clave;
        localStorage.setItem(CLAVE_CONFIG, JSON.stringify(copia));
      }
    } catch {
      /* ignora */
    }
    avisar(
      config.recordar
        ? 'Usuario y clave se guardarán en este navegador.'
        : 'Se dejó de recordar la clave en este navegador.',
      'info'
    );
  });

  $('verClave').addEventListener('click', () => {
    const entrada = $('clave');
    const visible = entrada.type === 'text';
    entrada.type = visible ? 'password' : 'text';
    $('verClave').setAttribute('aria-pressed', String(!visible));
    $('verClave').setAttribute('aria-label', visible ? 'Mostrar la clave' : 'Ocultar la clave');
  });

  $('probar').addEventListener('click', probarEndpoint);
}

function validarEndpoint() {
  const endpoint = config.endpoint.trim();
  if (!endpoint) return 'Ingresa el endpoint del servicio para verificarlo.';
  let url;
  try {
    url = new URL(endpoint);
  } catch {
    return 'El endpoint no es una URL válida (debe incluir http:// o https://).';
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return 'El endpoint debe usar http:// o https://.';
  return null;
}

function validarEnvio() {
  const problemaEndpoint = validarEndpoint();
  if (problemaEndpoint) return problemaEndpoint;
  if (!config.usuario.trim()) return 'Falta el usuario del servicio.';
  if (!config.clave) return 'Falta la clave del servicio.';
  return null;
}

function limpiarDiagnostico() {
  $('diagMaquinas').hidden = true;
  $('diagLista').textContent = '';
  const salida = $('resultadoPrueba');
  salida.hidden = true;
  salida.textContent = '';
  salida.dataset.tipo = '';
}

const ETIQUETAS_MAQUINA = {
  viva: 'Viva',
  'tls-invalido': 'TLS inválido',
  'sin-http': 'Sin HTTP',
  inaccesible: 'Sin conexión'
};

function describirMaquina(maquina) {
  const partes = [];
  if (maquina.tcp.ok) partes.push(`TCP ${maquina.tcp.ms} ms`);
  else partes.push(maquina.error?.codigo ? `TCP falló (${maquina.error.codigo})` : 'TCP sin conexión');

  if (maquina.tls.aplica) {
    if (maquina.tls.ok && maquina.tls.autorizacion === 'ok') partes.push(`TLS ${maquina.tls.protocolo || 'OK'}`);
    else if (maquina.tls.autorizacion === 'invalido') partes.push('TLS no válido');
  }

  if (maquina.http.responde) partes.push(`HTTP ${maquina.http.status}`);
  else if (maquina.tcp.ok) partes.push('sin respuesta HTTP');

  partes.push(`${maquina.ms} ms`);
  return partes.join(' · ');
}

function crearFilaDiagnostico(maquina) {
  const fila = document.createElement('li');
  fila.className = 'diag-fila';

  const info = document.createElement('div');
  info.className = 'diag-info';

  const linea = document.createElement('span');
  linea.className = 'diag-ip';
  linea.textContent = maquina.direccion;

  const familia = document.createElement('span');
  familia.className = 'diag-familia';
  familia.textContent = maquina.familia;
  linea.appendChild(familia);

  const detalle = document.createElement('span');
  detalle.className = 'diag-detalle';
  detalle.textContent = describirMaquina(maquina);
  if (maquina.error?.mensaje) detalle.title = maquina.error.mensaje;
  if (maquina.tls?.certificado) {
    const certificado = maquina.tls.certificado;
    detalle.title = [detalle.title, certificado.sujeto ? `Certificado: ${certificado.sujeto}` : '', certificado.vence ? `Vence: ${certificado.vence}` : '']
      .filter(Boolean)
      .join(' · ');
  }

  info.append(linea, detalle);

  const estado = document.createElement('span');
  estado.className = 'diag-estado';
  estado.dataset.estado = maquina.estado;
  estado.textContent = ETIQUETAS_MAQUINA[maquina.estado] || maquina.estado;

  fila.append(info, estado);
  return fila;
}

function renderDiagnostico(datos) {
  const salida = $('resultadoPrueba');
  const caja = $('diagMaquinas');
  const lista = $('diagLista');

  lista.textContent = '';
  salida.hidden = false;

  if (!datos.ok) {
    const mensaje = datos?.dns?.error?.mensaje || 'No se pudo resolver el endpoint.';
    salida.dataset.tipo = 'error';
    salida.textContent = mensaje;
    caja.hidden = true;
    log(`Diagnóstico: ${mensaje}`, 'error');
    return;
  }

  const { resumen, maquinas, dns } = datos;
  caja.hidden = false;
  $('diagHost').textContent = `${datos.hostname}:${datos.puerto}`;

  const vivas = resumen.vivas + resumen.tlsInvalidos;
  const total = resumen.total;

  if (vivas > 0) {
    salida.dataset.tipo = resumen.vivas === total && !resumen.tlsInvalidos ? 'ok' : 'aviso';
    salida.textContent =
      total === 1
        ? `Servicio alcanzable · 1 máquina respondió · ${datos.ms} ms`
        : `Servicio alcanzable · ${vivas} de ${total} máquinas responden · ${datos.ms} ms`;
  } else {
    salida.dataset.tipo = 'error';
    salida.textContent =
      total === 1 ? 'La máquina no respondió.' : `Ninguna de las ${total} máquinas respondió.`;
  }

  const resumenEl = $('diagResumen');
  resumenEl.dataset.tipo = resumen.vivas === total ? 'ok' : resumen.vivas > 0 ? 'aviso' : 'error';
  resumenEl.textContent = `${total} ${total === 1 ? 'máquina' : 'máquinas'} · ${resumen.vivas} ${resumen.vivas === 1 ? 'viva' : 'vivas'}`;

  for (const maquina of maquinas) lista.appendChild(crearFilaDiagnostico(maquina));

  const notas = [];
  if (datos.esIpDirecta) notas.push('El endpoint apunta directo a una IP: no hay DNS que resolver.');
  else if (total === 1) notas.push('El dominio resuelve a una sola dirección: no se detectaron varias máquinas.');
  else notas.push(`El dominio resuelve a ${total} direcciones y se probó cada una por separado.`);

  if (resumen.tlsInvalidos) {
    notas.push(
      `${resumen.tlsInvalidos} responde${resumen.tlsInvalidos === 1 ? '' : 'n'} con certificado TLS no válido: el servicio está vivo, pero el certificado no verifica.`
    );
  }
  if (resumen.sinRespuesta) {
    notas.push(
      `${resumen.sinRespuesta} acepta${resumen.sinRespuesta === 1 ? '' : 'n'} conexión TCP pero no entrega respuesta HTTP (firewall o servicio colgado).`
    );
  }
  if (resumen.inaccesibles) {
    notas.push(
      `${resumen.inaccesibles} no acepta${resumen.inaccesibles === 1 ? '' : 'n'} conexión: revisa firewall, VPN o esa réplica caída.`
    );
  }
  notas.push(`Prueba: GET ${datos.ruta} · DNS ${dns.ms} ms`);
  $('diagNota').textContent = notas.join(' ');

  log(
    `Diagnóstico ${datos.hostname}: ${resumen.vivas}/${total} viva(s)` +
      `${resumen.tlsInvalidos ? `, ${resumen.tlsInvalidos} con TLS inválido` : ''}` +
      `${resumen.inaccesibles ? `, ${resumen.inaccesibles} inaccesible(s)` : ''}.`,
    resumen.vivas ? 'ok' : 'error'
  );
}

async function probarEndpoint() {
  const problema = validarEndpoint();
  if (problema) {
    avisar(problema, 'error');
    $('endpoint').focus();
    return;
  }

  const boton = $('probar');
  const salida = $('resultadoPrueba');
  const original = boton.innerHTML;
  boton.disabled = true;
  boton.textContent = 'Verificando…';
  salida.hidden = false;
  salida.dataset.tipo = '';
  salida.textContent = 'Resolviendo el dominio y probando cada máquina…';
  $('diagMaquinas').hidden = true;

  try {
    const respuesta = await fetch('/api/diagnostico', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ endpoint: config.endpoint.trim(), timeoutMs: 8000 })
    });
    if (!respuesta.ok) {
      throw new Error(`El servidor local respondió HTTP ${respuesta.status}.`);
    }
    renderDiagnostico(await respuesta.json());
  } catch (err) {
    salida.dataset.tipo = 'error';
    salida.textContent = err?.message?.includes('servidor local')
      ? err.message
      : 'No se pudo hablar con el servidor local. ¿Sigue en ejecución?';
    log(`Diagnóstico falló: ${salida.textContent}`, 'error');
  } finally {
    boton.disabled = false;
    boton.innerHTML = original;
  }
}

/* ------------------------------------------------------------------ */
/* Carga de archivos                                                   */
/* ------------------------------------------------------------------ */

const esPDFPorNombre = (nombre) => /\.pdf$/i.test(String(nombre || ''));

function agregarRegistros(registros) {
  const vistos = new Set(items.map((i) => i.huella));
  let agregados = 0;
  let ignorados = 0;

  for (const { archivo, ruta } of registros) {
    if (!archivo) continue;
    const nombre = archivo.name || ruta || 'archivo';
    if (prefs.soloPDF && !esPDFPorNombre(nombre)) {
      ignorados += 1;
      continue;
    }
    const rutaFinal = ruta || nombre;
    const huella = `${rutaFinal}|${archivo.size}|${archivo.lastModified}`;
    if (vistos.has(huella)) continue;
    vistos.add(huella);

    items.push({
      id: ++idSecuencia,
      archivo,
      nombre,
      ruta: rutaFinal,
      tamano: archivo.size,
      huella,
      estado: 'pendiente',
      mensaje: '',
      b64: null,
      bytesB64: 0,
      httpStatus: null,
      duracion: null,
      respuesta: null,
      resumen: null
    });
    agregados += 1;
  }

  items.sort((a, b) => a.ruta.localeCompare(b.ruta, 'es', { numeric: true, sensitivity: 'base' }));
  renderTodo();

  if (agregados) {
    log(
      `${plural(agregados, 'archivo agregado', 'archivos agregados')}` +
        `${ignorados ? ` · ${plural(ignorados, 'omitido', 'omitidos')} por no ser PDF` : ''}.`
    );
    avisar(`${plural(agregados, 'archivo listo', 'archivos listos')} para procesar.`, 'ok', 2600);
  } else if (ignorados) {
    avisar(`No se agregó nada: ${plural(ignorados, 'archivo no es PDF', 'archivos no son PDF')}.`, 'info');
    log(`${plural(ignorados, 'archivo omitido', 'archivos omitidos')} por no ser PDF.`);
  } else {
    avisar('Los archivos ya estaban en la lista.', 'info');
  }
}

async function registrosDesdeDataTransfer(dt) {
  const entradas = [];
  if (dt.items && dt.items.length) {
    for (const elemento of Array.from(dt.items)) {
      const entrada = elemento.webkitGetAsEntry?.();
      if (entrada) entradas.push(entrada);
    }
  }
  if (!entradas.length) {
    return Array.from(dt.files || []).map((archivo) => ({
      archivo,
      ruta: archivo.webkitRelativePath || archivo.name
    }));
  }
  const salida = [];
  for (const entrada of entradas) await recorrerEntrada(entrada, '', salida);
  if (!salida.length) {
    return Array.from(dt.files || []).map((archivo) => ({
      archivo,
      ruta: archivo.webkitRelativePath || archivo.name
    }));
  }
  return salida;
}

function recorrerEntrada(entrada, prefijo, salida) {
  return new Promise((resolver) => {
    if (entrada.isFile) {
      entrada.file(
        (archivo) => {
          salida.push({ archivo, ruta: `${prefijo}${archivo.name}` });
          resolver();
        },
        () => resolver()
      );
      return;
    }
    if (entrada.isDirectory) {
      const lector = entrada.createReader();
      const leerLote = () => {
        lector.readEntries(
          async (lote) => {
            if (!lote.length) {
              resolver();
              return;
            }
            for (const hijo of lote) await recorrerEntrada(hijo, `${prefijo}${entrada.name}/`, salida);
            leerLote();
          },
          () => resolver()
        );
      };
      leerLote();
      return;
    }
    resolver();
  });
}

function conectarCarga() {
  const zona = $('zona');
  const inputCarpeta = $('inputCarpeta');
  const inputArchivos = $('inputArchivos');
  const inputTodos = $('inputTodos');

  const alSeleccionar = (evento) => {
    const archivos = Array.from(evento.target.files || []);
    if (archivos.length) {
      agregarRegistros(archivos.map((a) => ({ archivo: a, ruta: a.webkitRelativePath || a.name })));
    }
    evento.target.value = '';
  };

  // Cada botón abre su propio input. El stopPropagation evita que el clic llegue
  // a la zona, que abriría el selector de carpetas.
  const conectarBoton = (id, abrir) => {
    $(id).addEventListener('click', (evento) => {
      evento.stopPropagation();
      abrir();
    });
  };

  conectarBoton('btnCarpeta', () => inputCarpeta.click());
  conectarBoton('btnArchivos', () => inputArchivos.click());
  conectarBoton('btnTodos', () => inputTodos.click());

  zona.addEventListener('click', (evento) => {
    if (evento.target.closest('button, input, label')) return;
    inputCarpeta.click();
  });

  zona.addEventListener('keydown', (evento) => {
    if (evento.target !== zona) return;
    if (evento.key === 'Enter' || evento.key === ' ') {
      evento.preventDefault();
      inputCarpeta.click();
    }
  });

  inputCarpeta.addEventListener('change', alSeleccionar);
  inputArchivos.addEventListener('change', alSeleccionar);
  inputTodos.addEventListener('change', alSeleccionar);

  let contadorArrastre = 0;
  zona.addEventListener('dragenter', (e) => {
    e.preventDefault();
    contadorArrastre += 1;
    zona.classList.add('arrastrando');
  });
  zona.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  });
  zona.addEventListener('dragleave', () => {
    contadorArrastre = Math.max(0, contadorArrastre - 1);
    if (!contadorArrastre) zona.classList.remove('arrastrando');
  });
  zona.addEventListener('drop', async (e) => {
    e.preventDefault();
    contadorArrastre = 0;
    zona.classList.remove('arrastrando');
    if (!e.dataTransfer) return;
    try {
      const registros = await registrosDesdeDataTransfer(e.dataTransfer);
      agregarRegistros(registros);
    } catch (err) {
      avisar(`No se pudo leer lo arrastrado: ${err.message}`, 'error');
    }
  });

  // Evita que el navegador abra el PDF si se suelta fuera de la zona.
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => e.preventDefault());
}

/* ------------------------------------------------------------------ */
/* Tabla                                                               */
/* ------------------------------------------------------------------ */

function crearFila(item) {
  const tr = document.createElement('tr');
  tr.dataset.id = String(item.id);

  const tdNum = document.createElement('td');
  tdNum.className = 'col-num';
  tdNum.textContent = '';

  const tdArchivo = document.createElement('td');
  const contenedor = document.createElement('div');
  contenedor.className = 'nombre-archivo';

  const icono = document.createElement('span');
  icono.className = 'icono-pdf';
  icono.textContent = 'PDF';

  const bloque = document.createElement('div');
  bloque.className = 'nombre-texto';

  const principal = document.createElement('span');
  principal.className = 'principal';
  principal.textContent = item.nombre;
  principal.title = item.ruta;

  const ruta = document.createElement('span');
  ruta.className = 'ruta';
  ruta.textContent = item.ruta;
  ruta.hidden = item.ruta === item.nombre;
  ruta.title = item.ruta;

  const mensaje = document.createElement('span');
  mensaje.className = 'mensaje';
  mensaje.hidden = true;

  bloque.append(principal, ruta, mensaje);
  contenedor.append(icono, bloque);
  tdArchivo.appendChild(contenedor);

  const tdTamano = document.createElement('td');
  tdTamano.className = 'col-tamano';
  tdTamano.textContent = formatearBytes(item.tamano);

  const tdB64 = document.createElement('td');
  tdB64.className = 'col-b64';
  tdB64.textContent = '—';

  const tdEstado = document.createElement('td');
  tdEstado.className = 'col-estado';
  const estado = document.createElement('span');
  estado.className = 'estado';
  estado.dataset.estado = 'pendiente';
  estado.textContent = ETIQUETAS_ESTADO.pendiente;
  tdEstado.appendChild(estado);

  const tdHttp = document.createElement('td');
  tdHttp.className = 'col-http';
  tdHttp.textContent = '—';

  const tdTiempo = document.createElement('td');
  tdTiempo.className = 'col-tiempo';
  tdTiempo.textContent = '—';

  const tdAcciones = document.createElement('td');
  tdAcciones.className = 'col-acciones';
  const acciones = document.createElement('div');
  acciones.className = 'acciones-fila';

  const botones = {};
  const crearAccion = (accion, texto, extra = '') => {
    const boton = document.createElement('button');
    boton.type = 'button';
    boton.className = `accion ${extra}`.trim();
    boton.dataset.accion = accion;
    boton.textContent = texto;
    acciones.appendChild(boton);
    botones[accion] = boton;
    return boton;
  };

  crearAccion('b64', 'Base64');
  crearAccion('respuesta', 'Respuesta');
  crearAccion('reintentar', 'Reintentar');
  const quitar = crearAccion('quitar', '✕', 'accion-quitar');
  quitar.setAttribute('aria-label', `Quitar ${item.nombre}`);

  tdAcciones.appendChild(acciones);

  tr.append(tdNum, tdArchivo, tdTamano, tdB64, tdEstado, tdHttp, tdTiempo, tdAcciones);

  filas.set(item.id, { tr, tdNum, tdB64, estado, tdHttp, tdTiempo, mensaje, botones });
  return tr;
}

function actualizarFila(item) {
  const ref = filas.get(item.id);
  if (!ref) return;

  ref.tdNum.textContent = String(items.indexOf(item) + 1);
  ref.estado.dataset.estado = item.estado;
  ref.estado.textContent = ETIQUETAS_ESTADO[item.estado] || item.estado;
  ref.tdB64.textContent = item.bytesB64 ? formatearBytes(item.bytesB64) : '—';
  ref.tdHttp.textContent = item.httpStatus ? String(item.httpStatus) : '—';
  ref.tdTiempo.textContent = item.duracion != null ? `${item.duracion} ms` : '—';

  ref.mensaje.hidden = !item.mensaje;
  ref.mensaje.textContent = item.mensaje || '';
  ref.mensaje.dataset.tipo = item.estado === 'error' ? 'error' : '';

  ref.botones.b64.disabled = !item.b64;
  ref.botones.respuesta.disabled = !item.respuesta;
  ref.botones.reintentar.disabled = procesando || !['error', 'detenido', 'ok'].includes(item.estado);
  ref.botones.reintentar.hidden = !['error', 'detenido'].includes(item.estado);
  ref.botones.quitar.disabled = procesando;
  ref.botones.quitar.hidden = ['convirtiendo', 'enviando'].includes(item.estado);
}

function renderTodo() {
  const cuerpo = $('cuerpoTabla');
  cuerpo.textContent = '';
  filas.clear();
  for (const item of items) cuerpo.appendChild(crearFila(item));
  for (const item of items) actualizarFila(item);
  $('vacio').hidden = items.length > 0;
  actualizarResumen();
}

function actualizarResumen() {
  const total = items.length;
  const ok = items.filter((i) => i.estado === 'ok').length;
  const errores = items.filter((i) => i.estado === 'error').length;
  const pendientes = items.filter((i) => ['pendiente', 'detenido'].includes(i.estado)).length;
  const memoria = items.reduce((suma, i) => suma + (i.bytesB64 || 0), 0);

  $('chipTotal').textContent = `${total} archivo${total === 1 ? '' : 's'}`;
  $('chipOk').textContent = `${ok} OK`;
  $('chipError').textContent = `${errores} ${errores === 1 ? 'error' : 'errores'}`;
  $('chipError').classList.toggle('activo', errores > 0);
  $('chipMemoria').textContent = `Base64 ${formatearBytes(memoria)}`;
  $('chipMemoria').title = 'Memoria que ocupan los Base64 calculados';

  $('btnProcesar').disabled = procesando || total === 0;
  $('btnProcesarTexto').textContent = pendientes > 0 ? `Procesar (${pendientes})` : 'Procesar';
  $('btnDetener').disabled = !procesando || detenerSolicitado;
  $('btnLimpiar').disabled = procesando || total === 0;
  $('btnExportar').disabled = total === 0;
  $('btnLiberar').disabled = procesando || !items.some((i) => i.b64);
}

function conectarTabla() {
  $('cuerpoTabla').addEventListener('click', (e) => {
    const boton = e.target.closest('button[data-accion]');
    if (!boton) return;
    const tr = boton.closest('tr');
    if (!tr) return;
    const item = items.find((i) => String(i.id) === tr.dataset.id);
    if (!item) return;

    switch (boton.dataset.accion) {
      case 'b64':
        verBase64(item);
        break;
      case 'respuesta':
        verRespuesta(item);
        break;
      case 'reintentar':
        item.estado = 'pendiente';
        item.mensaje = '';
        item.respuesta = null;
        item.httpStatus = null;
        actualizarFila(item);
        actualizarResumen();
        procesar();
        break;
      case 'quitar': {
        if (procesando) return;
        items = items.filter((i) => i.id !== item.id);
        renderTodo();
        log(`Se quitó ${item.ruta}.`);
        break;
      }
      default:
        break;
    }
  });
}

/* ------------------------------------------------------------------ */
/* Procesamiento                                                       */
/* ------------------------------------------------------------------ */

async function procesar() {
  if (procesando) return;

  const objetivo = items.filter((i) => ['pendiente', 'error', 'detenido'].includes(i.estado));
  if (!objetivo.length) {
    avisar('No hay archivos pendientes de procesar.', 'info');
    return;
  }

  if (prefs.modo === 'enviar') {
    const problema = validarEnvio();
    if (problema) {
      avisar(problema, 'error', 5200);
      if (!config.endpoint.trim()) $('endpoint').focus();
      else if (!config.usuario.trim()) $('usuario').focus();
      else if (!config.clave) $('clave').focus();
      return;
    }
    if (/^http:\/\//i.test(config.endpoint.trim()) && !/^http:\/\/(localhost|127\.0\.0\.1)/i.test(config.endpoint.trim())) {
      avisar('El endpoint usa HTTP sin cifrado: usuario, clave y PDF viajan sin protección.', 'info', 6000);
    }
  }

  procesando = true;
  detenerSolicitado = false;
  const cola = [...objetivo];
  const total = cola.length;
  let terminados = 0;

  for (const item of cola) {
    item.estado = 'pendiente';
    item.mensaje = '';
    item.respuesta = null;
    item.httpStatus = null;
    item.duracion = null;
    actualizarFila(item);
  }

  $('progreso').hidden = false;
  clearTimeout(temporizadorProgreso);
  actualizarProgreso(0, total);
  actualizarResumen();
  log(
    `Inicio · ${total} archivo(s) · modo ${prefs.modo === 'enviar' ? `envío a ${config.endpoint.trim()}` : 'solo Base64'} · concurrencia ${config.concurrencia}`
  );

  const ancho = Math.max(1, Math.min(Number(config.concurrencia) || 1, total));

  const trabajador = async () => {
    while (true) {
      if (detenerSolicitado) return;
      const item = cola.shift();
      if (!item) return;
      await procesarItem(item);
      terminados += 1;
      actualizarProgreso(terminados, total);
    }
  };

  try {
    await Promise.all(Array.from({ length: ancho }, () => trabajador()));
  } finally {
    procesando = false;
    const pendientes = items.filter((i) => ['pendiente', 'detenido'].includes(i.estado)).length;
    if (pendientes) {
      $('progreso').hidden = false;
      actualizarProgreso(total - pendientes, total);
    } else {
      temporizadorProgreso = setTimeout(() => {
        $('progreso').hidden = true;
      }, 1500);
    }
    actualizarResumen();
    if (detenerSolicitado) log('Procesamiento detenido por el usuario.', 'error');
    const resumen = contarEstados();
    log(
      `Fin · ${resumen.ok} OK · ${plural(resumen.error, 'error', 'errores')} · ` +
        `${plural(resumen.pendiente, 'pendiente', 'pendientes')}.`
    );
    avisar(
      `Proceso finalizado: ${resumen.ok} OK, ${plural(resumen.error, 'error', 'errores')}.`,
      resumen.error ? 'error' : 'ok',
      5000
    );
  }
}

function contarEstados() {
  return {
    ok: items.filter((i) => i.estado === 'ok').length,
    error: items.filter((i) => i.estado === 'error').length,
    pendiente: items.filter((i) => ['pendiente', 'detenido'].includes(i.estado)).length
  };
}

function actualizarProgreso(hechos, total) {
  const porcentaje = total ? Math.round((hechos / total) * 100) : 0;
  $('progresoRelleno').style.width = `${porcentaje}%`;
  $('progresoTexto').textContent = `${hechos} de ${total} (${porcentaje}%)`;
}

async function procesarItem(item) {
  const inicio = performance.now();
  item.estado = 'convirtiendo';
  item.mensaje = 'Leyendo el PDF y codificando…';
  actualizarFila(item);

  try {
    const bytes = new Uint8Array(await item.archivo.arrayBuffer());
    if (!bytes.length) throw new Error('El archivo está vacío.');
    if (!esPDF(bytes)) throw new Error('No es un PDF válido: falta la firma %PDF- al inicio.');

    item.b64 = bytesABase64(bytes);
    item.bytesB64 = item.b64.length;

    if (prefs.modo === 'base64') {
      item.estado = 'ok';
      item.mensaje = `Convertido a Base64 · ${formatearBytes(item.bytesB64)}`;
      log(`${item.ruta} convertido a Base64.`);
    } else {
      item.estado = 'enviando';
      item.mensaje = 'Enviando al servicio…';
      actualizarFila(item);
      await enviarAlServicio(item);
    }
  } catch (err) {
    item.estado = 'error';
    item.mensaje = err?.message || 'Error desconocido al procesar el archivo.';
    log(`${item.ruta}: ${item.mensaje}`, 'error');
  } finally {
    item.duracion = Math.round(performance.now() - inicio);
    actualizarFila(item);
    actualizarResumen();
  }
}

async function enviarAlServicio(item) {
  let envelope;
  try {
    envelope = construirEnvelope({
      usuario: config.usuario,
      clave: config.clave,
      origen: config.origen,
      pdfB64: item.b64,
      incluirDeclaracion: Boolean(config.incluirDeclaracion)
    });
  } catch (err) {
    throw new Error(`No se pudo armar el sobre SOAP: ${err.message}`);
  }

  let respuesta;
  try {
    respuesta = await fetch('/api/enviar', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        endpoint: config.endpoint.trim(),
        envelope,
        soapAction: config.soapAction.trim(),
        contentType: config.contentType,
        timeoutMs: Number(config.timeoutSeg) * 1000,
        nombreArchivo: item.nombre
      })
    });
  } catch {
    throw new Error('No se pudo contactar el servidor local (¿está detenido?).');
  }

  let datos;
  try {
    datos = await respuesta.json();
  } catch {
    throw new Error(`El servidor local respondió HTTP ${respuesta.status} sin JSON.`);
  }

  if (!respuesta.ok || datos.ok === false) {
    throw new Error(datos?.error?.mensaje || `Error del servidor local (HTTP ${respuesta.status}).`);
  }

  item.httpStatus = datos.httpStatus;
  item.respuesta = datos.cuerpo || '';
  const resumen = interpretarRespuesta(item.respuesta);
  item.resumen = resumen;

  const exitoso = datos.httpStatus >= 200 && datos.httpStatus < 300 && !resumen.fault && !resumen.falloLogico;
  if (exitoso) {
    item.estado = 'ok';
    item.mensaje = resumen.mensaje || `HTTP ${datos.httpStatus}`;
    log(`${item.ruta} · HTTP ${datos.httpStatus} · ${datos.ms} ms · ${item.mensaje}`, 'ok');
  } else {
    item.estado = 'error';
    item.mensaje = resumen.mensaje || `HTTP ${datos.httpStatus}`;
    log(`${item.ruta} · HTTP ${datos.httpStatus} · ${item.mensaje}`, 'error');
  }
}

/* ------------------------------------------------------------------ */
/* Interpretación de la respuesta SOAP                                 */
/* ------------------------------------------------------------------ */

function analizarXml(texto) {
  try {
    const doc = new DOMParser().parseFromString(texto, 'text/xml');
    if (!doc || doc.getElementsByTagName('parsererror').length) return null;
    if (!doc.documentElement || doc.documentElement.nodeName === 'parsererror') return null;
    return doc;
  } catch {
    return null;
  }
}

function hojasDe(elemento) {
  const salida = [];
  const recorrer = (nodo) => {
    for (const hijo of Array.from(nodo.children)) {
      if (hijo.children.length === 0) {
        const valor = (hijo.textContent || '').trim();
        if (valor) salida.push({ etiqueta: hijo.localName, valor });
      } else {
        recorrer(hijo);
      }
    }
  };
  recorrer(elemento);
  return salida;
}

function interpretarRespuesta(texto) {
  if (!texto || !texto.trim()) {
    return { fault: false, falloLogico: false, mensaje: 'El servicio respondió sin contenido.', campos: [] };
  }

  const doc = analizarXml(texto);
  if (!doc) {
    return {
      fault: false,
      falloLogico: false,
      mensaje: recortar(texto.trim().replace(/\s+/g, ' '), 200),
      campos: []
    };
  }

  const todos = Array.from(doc.getElementsByTagName('*'));

  if (todos.some((e) => e.localName === 'Fault')) {
    const detalle =
      todos.find((e) => e.localName === 'faultstring')?.textContent?.trim() ||
      todos.find((e) => e.localName === 'faultcode')?.textContent?.trim() ||
      'SOAP Fault sin detalle.';
    return {
      fault: true,
      falloLogico: false,
      mensaje: recortar(detalle, 240),
      campos: [{ etiqueta: 'faultstring', valor: detalle }]
    };
  }

  const nodoResultado = todos.find(
    (e) => /(result|resultado)$/i.test(e.localName) && ((e.textContent || '').trim() || e.children.length)
  );

  let campos = [];
  const interno = nodoResultado ? (nodoResultado.textContent || '').trim() : '';
  if (interno.startsWith('<')) {
    const docInterno = analizarXml(interno) || analizarXml(`<raiz>${interno}</raiz>`);
    if (docInterno) campos = hojasDe(docInterno.documentElement);
  }
  if (!campos.length) campos = hojasDe(doc.documentElement);
  if (!campos.length && interno) campos = [{ etiqueta: nodoResultado.localName, valor: interno }];

  const buscar = (patron) => campos.find((c) => patron.test(c.etiqueta));
  const principal =
    buscar(/mensaje|message|descripcion|glosa|observacion|detalle/i) || buscar(/estado|resultado/i) || buscar(/codigo|code/i);

  let mensaje;
  if (principal) {
    const otros = campos
      .filter((c) => c !== principal && /codigo|estado|resultado|mensaje/i.test(c.etiqueta))
      .slice(0, 2);
    mensaje = [principal, ...otros].map((c) => `${c.etiqueta}: ${c.valor}`).join(' · ');
  } else if (campos.length) {
    mensaje = campos.slice(0, 3).map((c) => `${c.etiqueta}: ${c.valor}`).join(' · ');
  } else {
    mensaje = 'Respuesta sin campos reconocibles.';
  }

  return {
    fault: false,
    falloLogico: detectarFalloLogico(campos),
    mensaje: recortar(mensaje, 240),
    campos
  };
}

function detectarFalloLogico(campos) {
  const valor = (nombre) => campos.find((c) => c.etiqueta.toLowerCase() === nombre)?.valor.toLowerCase();
  for (const clave of ['exito', 'success', 'exitoso', 'ok']) {
    const v = valor(clave);
    if (v === 'false' || v === '0' || v === 'no') return true;
  }
  const estado = valor('estado');
  if (estado && /^(error|rechazad|fallid|falla|no\s)/i.test(estado)) return true;
  return false;
}

function embellecerXml(xml) {
  const texto = String(xml ?? '').trim();
  if (!texto) return '';
  const lineas = texto.replace(/>\s*</g, '><').replace(/></g, '>\n<').split('\n');
  let nivel = 0;
  const salida = [];
  for (let linea of lineas) {
    linea = linea.trim();
    if (!linea) continue;
    if (/^<\?/.test(linea) || /^<!/.test(linea)) {
      salida.push(`${'  '.repeat(nivel)}${linea}`);
      continue;
    }
    if (/^<\//.test(linea)) {
      nivel = Math.max(0, nivel - 1);
      salida.push(`${'  '.repeat(nivel)}${linea}`);
      continue;
    }
    const seCierraSolo = /\/>$/.test(linea);
    const abreYCierra = /^<([\w:.-]+)(\s[^>]*)?>[^<]*<\/\1>$/.test(linea);
    salida.push(`${'  '.repeat(nivel)}${linea}`);
    if (!seCierraSolo && !abreYCierra) nivel += 1;
  }
  return salida.join('\n');
}

/* ------------------------------------------------------------------ */
/* Modales                                                             */
/* ------------------------------------------------------------------ */

function abrirModal({ titulo, meta, texto, nombreDescarga, contenidoCompleto }) {
  $('modalTitulo').textContent = titulo;
  $('modalMeta').textContent = meta || '';
  $('modalTexto').value = texto || '';
  $('modalAviso').textContent = '';
  modalEstado.texto = texto || '';
  modalEstado.contenidoCompleto = contenidoCompleto ?? texto ?? '';

  if (modalEstado.url) {
    URL.revokeObjectURL(modalEstado.url);
    modalEstado.url = null;
  }
  const blob = new Blob([modalEstado.contenidoCompleto], { type: 'text/plain;charset=utf-8' });
  modalEstado.url = URL.createObjectURL(blob);
  const enlace = $('modalDescargar');
  enlace.href = modalEstado.url;
  enlace.download = nombreSeguro(nombreDescarga || 'detalle.txt');

  $('modal').hidden = false;
  document.body.style.overflow = 'hidden';
  $('modalCerrar').focus();
}

function cerrarModal() {
  $('modal').hidden = true;
  document.body.style.overflow = '';
  if (modalEstado.url) {
    URL.revokeObjectURL(modalEstado.url);
    modalEstado.url = null;
  }
  $('modalTexto').value = '';
  modalEstado.contenidoCompleto = '';
}

function conectarModal() {
  $('modalCerrar').addEventListener('click', cerrarModal);
  $('modal').addEventListener('click', (e) => {
    if (e.target === $('modal')) cerrarModal();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('modal').hidden) cerrarModal();
  });

  $('modalCopiar').addEventListener('click', async () => {
    const boton = $('modalCopiar');
    const original = boton.textContent;
    try {
      await navigator.clipboard.writeText(modalEstado.contenidoCompleto);
      boton.textContent = 'Copiado ✓';
    } catch {
      const area = $('modalTexto');
      area.select();
      document.execCommand('copy');
      boton.textContent = 'Copiado ✓';
    }
    setTimeout(() => {
      boton.textContent = original;
    }, 1400);
  });
}

function verBase64(item) {
  if (!item.b64) {
    avisar('Ese Base64 ya no está en memoria. Vuelve a procesar el archivo.', 'info');
    return;
  }
  const parcial = item.b64.length > LIMITE_VISTA_PREVIA;
  const base = item.nombre.replace(/\.pdf$/i, '');
  abrirModal({
    titulo: `Base64 · ${item.nombre}`,
    meta: `${item.b64.length.toLocaleString('es-CL')} caracteres · PDF de ${formatearBytes(item.tamano)} · sin prefijo data:`,
    texto: parcial ? `${item.b64.slice(0, LIMITE_VISTA_PREVIA)}\n\n… vista previa recortada …` : item.b64,
    nombreDescarga: `${nombreSeguro(base)}.pdf.b64.txt`,
    contenidoCompleto: item.b64
  });
  $('modalAviso').textContent = parcial
    ? `Vista parcial: se muestran ${LIMITE_VISTA_PREVIA.toLocaleString('es-CL')} de ${item.b64.length.toLocaleString('es-CL')} caracteres. Copiar y Descargar entregan el contenido completo.`
    : '';
}

function verRespuesta(item) {
  if (!item.respuesta) {
    avisar('Este archivo todavía no tiene respuesta del servicio.', 'info');
    return;
  }
  const campos = (item.resumen?.campos || [])
    .slice(0, 8)
    .map((c) => `  ${c.etiqueta} = ${recortar(c.valor, 200)}`)
    .join('\n');

  let encabezado = `HTTP ${item.httpStatus ?? '—'}${item.duracion != null ? ` · ${item.duracion} ms` : ''}`;
  if (campos) encabezado += `\n\nCampos detectados:\n${campos}`;
  encabezado += '\n\n--- XML de respuesta ---\n\n';

  abrirModal({
    titulo: `Respuesta · ${item.nombre}`,
    meta: item.mensaje || '',
    texto: `${encabezado}${embellecerXml(item.respuesta)}`,
    nombreDescarga: `${nombreSeguro(item.nombre.replace(/\.pdf$/i, ''))}.respuesta.xml`,
    contenidoCompleto: item.respuesta
  });
}

/* ------------------------------------------------------------------ */
/* Acciones globales                                                   */
/* ------------------------------------------------------------------ */

function liberarBase64() {
  let liberados = 0;
  for (const item of items) {
    if (item.b64) {
      item.b64 = null;
      item.bytesB64 = 0;
      liberados += 1;
    }
  }
  actualizarResumen();
  for (const item of items) actualizarFila(item);
  log(`${plural(liberados, 'Base64 liberado', 'Base64 liberados')} de memoria.`);
  avisar(`${plural(liberados, 'Base64 liberado', 'Base64 liberados')} de la memoria.`, 'info');
}

function limpiar() {
  if (procesando) return;
  items = [];
  renderTodo();
  registroLineas = [];
  $('registro').textContent = '';
  $('registroContador').textContent = '0';
  $('progreso').hidden = true;
  log('Lista limpiada.');
}

function exportarCSV() {
  if (!items.length) return;
  const filasCsv = [['archivo', 'ruta', 'tamano_bytes', 'estado', 'http', 'duracion_ms', 'base64_caracteres', 'mensaje']];
  for (const item of items) {
    filasCsv.push([
      item.nombre,
      item.ruta,
      String(item.tamano),
      item.estado,
      item.httpStatus != null ? String(item.httpStatus) : '',
      item.duracion != null ? String(item.duracion) : '',
      item.bytesB64 ? String(item.bytesB64) : '',
      item.mensaje || ''
    ]);
  }
  const escapar = (valor) => `"${String(valor ?? '').replace(/"/g, '""')}"`;
  const contenido = `\uFEFF${filasCsv.map((f) => f.map(escapar).join(';')).join('\r\n')}`;
  descargar(`reporte-carpetas-${marcaTiempo()}.csv`, contenido, 'text/csv;charset=utf-8');
  log(`Reporte CSV exportado (${plural(items.length, 'archivo', 'archivos')}).`);
  avisar('Reporte CSV descargado.', 'ok');
}

function conectarAcciones() {
  $('btnProcesar').addEventListener('click', procesar);

  $('btnDetener').addEventListener('click', () => {
    if (!procesando) return;
    detenerSolicitado = true;
    $('btnDetener').disabled = true;
    log('Deteniendo: se completan los envíos en curso…', 'error');
    avisar('Se detendrá al terminar los envíos en curso.', 'info');
  });

  $('btnLimpiar').addEventListener('click', limpiar);
  $('btnLiberar').addEventListener('click', liberarBase64);
  $('btnExportar').addEventListener('click', exportarCSV);

  const aplicarModo = (modo) => {
    prefs.modo = modo === 'base64' ? 'base64' : 'enviar';
    $(prefs.modo === 'base64' ? 'modoBase64' : 'modoEnviar').checked = true;
    guardarPrefs();
    actualizarResumen();
  };

  $('modoEnviar').addEventListener('change', () => aplicarModo('enviar'));
  $('modoBase64').addEventListener('change', () => aplicarModo('base64'));

  $('soloPDF').addEventListener('change', (e) => {
    prefs.soloPDF = e.target.checked;
    $('inputArchivos').accept = prefs.soloPDF ? '.pdf' : '';
    guardarPrefs();
    avisar(
      prefs.soloPDF ? 'Solo se aceptarán archivos .pdf' : 'Se aceptarán todos los archivos (se validará la firma PDF al procesar).',
      'info',
      3000
    );
  });
}

/* ------------------------------------------------------------------ */
/* Arranque                                                            */
/* ------------------------------------------------------------------ */

async function comprobarServidor() {
  const salud = $('salud');
  try {
    const respuesta = await fetch('/api/salud', { cache: 'no-store' });
    const datos = await respuesta.json();
    salud.dataset.estado = 'ok';
    $('saludTexto').textContent = `Servidor local listo · v${datos.version}`;
  } catch {
    salud.dataset.estado = 'error';
    $('saludTexto').textContent = 'Sin conexión con el servidor local';
    log('No se pudo contactar /api/salud. ¿El servidor local está en ejecución?', 'error');
  }
}

function iniciar() {
  config = { ...CONFIG_BASE, ...leerAlmacen(CLAVE_CONFIG, {}) };
  prefs = { ...PREFS_BASE, ...leerAlmacen(CLAVE_PREFS, {}) };
  prefs.soloPDF = prefs.soloPDF !== false;

  pintarConfig();
  $('modoEnviar').checked = prefs.modo !== 'base64';
  $('modoBase64').checked = prefs.modo === 'base64';
  $('soloPDF').checked = Boolean(prefs.soloPDF);

  conectarConfig();
  conectarCarga();
  conectarTabla();
  conectarModal();
  conectarAcciones();

  renderTodo();
  comprobarServidor();

  log('Aplicación iniciada. Carga una carpeta tributaria para comenzar.');
  if (!config.endpoint) {
    setTimeout(() => $('endpoint').focus(), 300);
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', iniciar, { once: true });
} else {
  iniciar();
}
