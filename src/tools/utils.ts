export function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null || isNaN(bytes)) return 'N/A';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'];
  let v = bytes; let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(2)} ${units[i]}`;
}
