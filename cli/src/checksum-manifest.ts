export function parseChecksumFile(contents: string): Map<string, string> {
  const checksums = new Map<string, string>();
  for (const [index, line] of contents.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    const match = line.match(/^([a-fA-F0-9]{64})[ \t]+\*?(\S+)[ \t]*$/);
    if (!match) {
      throw new Error(`Invalid SHA-256 checksum manifest line ${index + 1}.`);
    }
    const assetName = match[2];
    if (checksums.has(assetName)) {
      throw new Error(`Duplicate SHA-256 checksum manifest entry for ${assetName}.`);
    }
    checksums.set(assetName, match[1].toLowerCase());
  }
  if (checksums.size === 0) throw new Error("Desktop release checksum manifest is empty.");
  return checksums;
}
