import type { InstanceLocale } from "@rudderhq/shared";

type LibraryCopyKey =
  | "addFromLibrary"
  | "attachFromLibrary"
  | "attachFromLibraryDescription"
  | "agentPrivateSkillsHelp"
  | "couldNotLoadLibraryFiles"
  | "editInLibrary"
  | "findInLibrary"
  | "importSkillsIntoLibraryFirst"
  | "legacyLibraryDocument"
  | "library"
  | "libraryFiles"
  | "linkedLibrary"
  | "liveLibraryFile"
  | "liveLibraryFolder"
  | "liveLibraryLink"
  | "noLibraryFiles"
  | "noMatchingLibraryFiles"
  | "organizationSkillsHelp"
  | "projectContextHelp"
  | "resourceNotFoundInProjectLibrary"
  | "searchLibraryPlaceholder"
  | "libraryDocumentUnavailable"
  | "readOnlyInLibrary"
  | "cannotRenderInLibrary"
  | "useThisLibraryPath";

const copy: Record<LibraryCopyKey, { en: string; "zh-CN": string }> = {
  addFromLibrary: { en: "Add from Library", "zh-CN": "从文档添加" },
  attachFromLibrary: { en: "Attach from Library", "zh-CN": "从文档添加" },
  attachFromLibraryDescription: {
    en: "Choose a file to copy into this issue's attachments.",
    "zh-CN": "选择要复制到此任务附件的文件。",
  },
  agentPrivateSkillsHelp: {
    en: "Agent-private skills belong to this agent only. Edit them in Library, then enable them here when you want Rudder to load them.",
    "zh-CN": "智能体私有技能只属于当前智能体。先在文档中编辑，需要 Rudder 加载时再在这里启用。",
  },
  couldNotLoadLibraryFiles: { en: "Could not load Library files", "zh-CN": "无法加载文档文件" },
  editInLibrary: { en: "Edit in Library", "zh-CN": "在文档中编辑" },
  findInLibrary: { en: "Find in Library", "zh-CN": "在文档中查找" },
  importSkillsIntoLibraryFirst: {
    en: "Import or scan skills into Library first, then enable them here.",
    "zh-CN": "请先将技能导入或扫描到文档中，然后在这里启用。",
  },
  legacyLibraryDocument: { en: "Legacy Library document", "zh-CN": "旧版文档" },
  library: { en: "Library", "zh-CN": "文档" },
  libraryFiles: { en: "Library files", "zh-CN": "文档文件" },
  linkedLibrary: { en: "Linked Library", "zh-CN": "关联文档" },
  liveLibraryFile: { en: "live Library file", "zh-CN": "实时文档文件" },
  liveLibraryFolder: { en: "live Library folder", "zh-CN": "实时文档文件夹" },
  liveLibraryLink: { en: "live Library link", "zh-CN": "实时文档链接" },
  noLibraryFiles: { en: "No Library files available.", "zh-CN": "暂无文档文件。" },
  noMatchingLibraryFiles: { en: "No matching Library files.", "zh-CN": "没有匹配的文档文件。" },
  projectContextHelp: {
    en: "Attach the codebases, Library files, URLs, and external systems agents should use for this project.",
    "zh-CN": "添加这个项目中智能体应使用的代码库、文档文件、URL 和外部系统。",
  },
  organizationSkillsHelp: {
    en: "Bundled Rudder skills are locked on. Community presets and other organization skills stay optional; workspace-backed skills can be edited from Library.",
    "zh-CN": "内置 Rudder 技能固定开启。社区预设和其他组织技能保持可选；由工作区支持的技能可在文档中编辑。",
  },
  resourceNotFoundInProjectLibrary: {
    en: "Resource not found in this project Library.",
    "zh-CN": "在这个项目文档中未找到资源。",
  },
  searchLibraryPlaceholder: { en: "Search Library or paste relative path", "zh-CN": "搜索文档或粘贴相对路径" },
  libraryDocumentUnavailable: {
    en: "This Library document could not be found or is not available in this organization.",
    "zh-CN": "找不到这个文档，或它在当前组织中不可用。",
  },
  readOnlyInLibrary: {
    en: "This file is rendered read-only in Library.",
    "zh-CN": "这个文件在文档中以只读方式呈现。",
  },
  cannotRenderInLibrary: {
    en: "This file cannot be rendered in Library.",
    "zh-CN": "这个文件无法在文档中呈现。",
  },
  useThisLibraryPath: { en: "Use this Library path", "zh-CN": "使用这个文档路径" },
};

export function libraryCopy(key: LibraryCopyKey, locale: InstanceLocale) {
  return copy[key][locale] ?? copy[key].en;
}
