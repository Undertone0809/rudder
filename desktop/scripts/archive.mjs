export function macPortableZipArgs(sourceAppDir, outputPath) {
  return [
    "-c",
    "-k",
    "--norsrc",
    "--noextattr",
    "--noqtn",
    "--noacl",
    "--zlibCompressionLevel",
    "9",
    "--keepParent",
    sourceAppDir,
    outputPath,
  ];
}
