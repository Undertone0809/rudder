const PACKAGE_NAME = "@rudderhq/cli";
const APPROVED_DIST_TAGS = new Set(["latest", "canary"]);
const EXACT_VERSION = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/;
const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const REPOSITORY = /^[A-Za-z0-9_.-]{1,100}$/;

export function validatePublicInstallPackageSpec(value) {
  const packageSpec = String(value ?? "");
  const prefix = `${PACKAGE_NAME}@`;
  if (!packageSpec.startsWith(prefix)) {
    throw new Error(`Package spec must target ${PACKAGE_NAME} with an exact version or approved dist-tag.`);
  }

  const selector = packageSpec.slice(prefix.length);
  if (!EXACT_VERSION.test(selector) && !APPROVED_DIST_TAGS.has(selector)) {
    throw new Error(
      `Invalid package selector. Use an exact semver or one of: ${[...APPROVED_DIST_TAGS].join(", ")}.`,
    );
  }

  return packageSpec;
}

export function validatePublicInstallReleaseRepo(value) {
  const repo = String(value ?? "");
  const parts = repo.split("/");
  if (
    parts.length !== 2 ||
    !OWNER.test(parts[0]) ||
    !REPOSITORY.test(parts[1]) ||
    parts[1] === "." ||
    parts[1] === ".."
  ) {
    throw new Error("Release repository must use a valid owner/repository slug.");
  }

  return repo;
}
