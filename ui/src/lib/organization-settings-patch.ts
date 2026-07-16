export function buildOrganizationGeneralPatch(input: {
  name: string;
  description: string;
  brandColor: string | null;
}) {
  return {
    name: input.name.trim(),
    description: input.description.trim() || null,
    brandColor: input.brandColor || null,
  };
}
