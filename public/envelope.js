/**
 * Constructor del sobre SOAP para la operación procesaCTE
 * (namespace http://portalcredex.cl/formex).
 *
 * Réplica exacta de la estructura del request entregado por Credex.
 * Se usa desde el navegador (módulo ES) y desde las pruebas en Node.
 */

export const NAMESPACE_FORMEX = 'http://portalcredex.cl/formex';
export const NAMESPACE_SOAP = 'http://schemas.xmlsoap.org/soap/envelope/';

/** Escapa texto para que pueda viajar dentro de un nodo XML. */
export function escaparXml(valor) {
  return String(valor ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Arma el envelope procesaCTE.
 *
 * @param {object} opciones
 * @param {string} opciones.usuario    Usuario del servicio.
 * @param {string} opciones.clave      Clave del servicio.
 * @param {string} [opciones.origen]   Origen declarado (por defecto "WS").
 * @param {string} opciones.pdfB64     Contenido del PDF codificado en Base64 (sin saltos ni prefijo data:).
 * @param {boolean} [opciones.incluirDeclaracion] Agrega la declaración <?xml ...?>.
 * @returns {string} Sobre SOAP listo para enviar.
 */
export function construirEnvelope({
  usuario = '',
  clave = '',
  origen = 'WS',
  pdfB64 = '',
  incluirDeclaracion = false
} = {}) {
  if (typeof pdfB64 !== 'string' || !pdfB64.trim()) {
    throw new Error('El PDF en Base64 está vacío.');
  }
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(pdfB64.trim())) {
    throw new Error('El PDF en Base64 contiene caracteres inválidos.');
  }

  const declaracion = incluirDeclaracion ? '<?xml version="1.0" encoding="UTF-8"?>\n' : '';

  return `${declaracion}<soapenv:Envelope xmlns:soapenv="${NAMESPACE_SOAP}" xmlns:for="${NAMESPACE_FORMEX}">
   <soapenv:Header/>
   <soapenv:Body>
      <for:procesaCTE>
         <!--Optional:-->
         <for:Input>
            <!--Optional:-->
            <for:Credenciales>
               <!--Optional:-->
               <for:Usuario>${escaparXml(usuario)}</for:Usuario>
               <!--Optional:-->
               <for:Clave>${escaparXml(clave)}</for:Clave>
               <!--Optional:-->
               <for:Origen>${escaparXml(origen || 'WS')}</for:Origen>
            </for:Credenciales>
            <for:PDFB64>${pdfB64.trim()}</for:PDFB64>
         </for:Input>
      </for:procesaCTE>
   </soapenv:Body>
</soapenv:Envelope>`;
}

/** SOAPAction habitual de la operación (se deja editable en la interfaz). */
export const SOAP_ACTION_SUGERIDA = `${NAMESPACE_FORMEX}/procesaCTE`;
