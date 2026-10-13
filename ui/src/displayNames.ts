/** Words of a machine id for display: "site_location" reads "site location". Tokens with digits keep their case. */
export function idWords(id: string): string {
  return id
    .split(/[_\s]+/)
    .filter(Boolean)
    .map((token) => (/\d/.test(token) ? token : token.toLowerCase()))
    .join(" ");
}

/** A machine id as a sentence-case label: BEDROOM_CORRIDOR reads "Bedroom corridor". Display only. */
export function humaniseId(id: string): string {
  const words = idWords(id);
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Prose from the server with any snake_case token spelled out. */
export function plainText(text: string): string {
  return text.replace(/\b[a-z0-9]+(?:_[a-z0-9]+)+\b/gi, (token) => idWords(token));
}
