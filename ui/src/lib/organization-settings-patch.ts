export function buildOrganizationGeneralPatch(input: {
  name: string;
  description: string;
  brandColor: string | null;
  issuePrefix: string;
  persistedIssuePrefix: string;
}) {
  const issuePrefix = input.issuePrefix.trim();
  return {
    name: input.name.trim(),
    ...(issuePrefix !== input.persistedIssuePrefix ? { issuePrefix } : {}),
    description: input.description.trim() || null,
    brandColor: input.brandColor || null,
  };
}
