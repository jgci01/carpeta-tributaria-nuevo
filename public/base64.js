/**
 * Utilidades Base64 para navegador y Node (módulo ES, sin dependencias).
 *
 * El Base64 estándar de btoa() falla con archivos grandes si se usa
 * String.fromCharCode(...bytes) de una sola vez, así que se procesa por trozos.
 */

const TROZO = 0x8000; // 32 KB de bytes por iteración

/** Firma de un PDF: los primeros bytes deben ser "%PDF-". */
export function esPDF(bytes) {
  const firma = [0x25, 0x50, 0x44, 0x46, 0x2d]; // %PDF-
  if (!bytes || bytes.length < firma.length) return false;
  return firma.every((valor, indice) => bytes[indice] === valor);
}

/** Convierte un Uint8Array a Base64 estándar (sin saltos de línea). */
export function bytesABase64(bytes) {
  if (!(bytes instanceof Uint8Array)) {
    throw new TypeError('bytesABase64 espera un Uint8Array.');
  }
  let binario = '';
  for (let i = 0; i < bytes.length; i += TROZO) {
    binario += String.fromCharCode.apply(null, bytes.subarray(i, i + TROZO));
  }
  return btoa(binario);
}

/** Formatea bytes de forma legible (KB, MB, GB). */
export function formatearBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  const unidades = ['KB', 'MB', 'GB', 'TB'];
  let valor = n / 1024;
  let indice = 0;
  while (valor >= 1024 && indice < unidades.length - 1) {
    valor /= 1024;
    indice += 1;
  }
  return `${valor.toFixed(valor >= 10 ? 0 : 1)} ${unidades[indice]}`;
}
