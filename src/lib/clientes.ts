export function etiquetaCliente(
  ruc: string | null | undefined,
  razonSocial: string | null | undefined,
): string | null {
  if (!razonSocial) return null;
  return ruc ? `${ruc} - ${razonSocial}` : razonSocial;
}
