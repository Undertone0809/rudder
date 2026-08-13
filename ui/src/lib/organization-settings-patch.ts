export function buildOrganizationGeneralPatch(input: {
  name: string;
}) {
  return {
    name: input.name.trim(),
  };
}
