/** Hand a file to the browser's own download, the way a link to it would. */
export function saveFile(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  // Not revoked at once: Safari drops a download whose address is revoked
  // in the same task that started it.
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** Today's date as the reader's calendar has it, for a file name. */
export function localDateStamp(date = new Date()) {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}
