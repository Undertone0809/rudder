export function macPortableZipArgs(sourceAppDir, outputPath, options = {}) {
  const compressionLevel = Number.isInteger(options.compressionLevel)
    ? Math.max(0, Math.min(9, options.compressionLevel))
    : 9;
  return [
    "-c",
    "-k",
    "--norsrc",
    "--noextattr",
    "--noqtn",
    "--noacl",
    "--zlibCompressionLevel",
    String(compressionLevel),
    "--keepParent",
    sourceAppDir,
    outputPath,
  ];
}
