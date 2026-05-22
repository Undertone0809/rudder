import { expect } from "vitest";

export const clearInheritedGitIdentityEnv = {
  GIT_AUTHOR_NAME: "",
  GIT_AUTHOR_EMAIL: "",
  GIT_COMMITTER_NAME: "",
  GIT_COMMITTER_EMAIL: "",
};

export type GitIdentityCapture = {
  configGlobal: string | null;
  configGlobalContent: string | null;
  authorName: string | null;
  authorEmail: string | null;
  committerName: string | null;
  committerEmail: string | null;
};

export const gitIdentityCaptureSnippet = `
function captureGitIdentityEnv() {
  const configGlobal = process.env.GIT_CONFIG_GLOBAL || null;
  return {
    configGlobal,
    configGlobalContent: configGlobal && fs.existsSync(configGlobal)
      ? fs.readFileSync(configGlobal, "utf8")
      : null,
    authorName: process.env.GIT_AUTHOR_NAME || null,
    authorEmail: process.env.GIT_AUTHOR_EMAIL || null,
    committerName: process.env.GIT_COMMITTER_NAME || null,
    committerEmail: process.env.GIT_COMMITTER_EMAIL || null,
  };
}
`;

export function expectPreparedGitConfigCapture(capture: { gitIdentity: GitIdentityCapture }): void {
  expect(capture.gitIdentity.configGlobal).toEqual(expect.any(String));
  expect(capture.gitIdentity.configGlobal).toContain(".gitconfig");
  expect(capture.gitIdentity.configGlobalContent).toContain("useConfigOnly = true");
  expect(capture.gitIdentity.configGlobalContent).not.toContain("Confirmed Operator");
  expect(capture.gitIdentity.configGlobalContent).not.toContain("confirmed@example.com");
  expect(capture.gitIdentity.authorName).toBeNull();
  expect(capture.gitIdentity.authorEmail).toBeNull();
  expect(capture.gitIdentity.committerName).toBeNull();
  expect(capture.gitIdentity.committerEmail).toBeNull();
}
