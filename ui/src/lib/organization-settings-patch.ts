export function buildOrganizationGeneralPatch(input: {
  name: string;
  brandColor: string | null;
}) {
  return {
    name: input.name.trim(),
    brandColor: input.brandColor || null,
  };
}
