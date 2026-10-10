const ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";

/**
 * Случайный идентификатор из 16 символов [0-9a-z].
 * crypto.getRandomValues работает и вне secure context (например, при открытии по IP в локальной сети).
 */
export function newId(): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  let id = "";
  for (const b of bytes) id += ALPHABET[b % ALPHABET.length];
  return id;
}
