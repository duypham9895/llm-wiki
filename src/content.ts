// Decide whether a converted page body has enough real prose to be worth syncing,
// so 'Not Started' backlog stubs (empty bodies) are skipped.
export function hasRealContent(markdown: string, minChars: number): boolean {
  const meaningful = markdown
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')   // drop image embeds
    .replace(/[#>*_`|\-\\]/g, ' ')          // drop markdown punctuation / table borders
    .replace(/\s+/g, ' ')                   // collapse whitespace
    .trim();
  return meaningful.length >= minChars;
}
