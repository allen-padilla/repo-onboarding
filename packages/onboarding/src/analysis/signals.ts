import type { FileRole } from "../walkthrough-document";

// Local signals: a file's role and importance from its path and size alone,
// without reading it or calling a model. They choose the files to score, rank
// the files TypeSafe does not score, and break ties. Scores use TypeSafe's
// scale, from 0 ("never needs to open this") to 4 ("essential").

const CODE_EXTENSIONS = new Set([
  "js", "jsx", "mjs", "cjs", "ts", "tsx", "mts", "cts", "vue", "svelte", "astro", "html", "htm",
  "py", "go", "rs", "rb", "java", "kt", "scala", "groovy", "cs", "fs", "swift", "m", "mm",
  "c", "cc", "cpp", "cxx", "h", "hh", "hpp", "php", "ex", "exs", "erl", "hs", "ml", "clj", "cljs",
  "dart", "lua", "pl", "r", "jl", "zig", "nim", "elm", "sh", "bash", "zsh", "ps1", "sql",
]);

const DOCUMENTATION_EXTENSIONS = new Set(["md", "mdx", "markdown", "rst", "adoc", "asciidoc", "txt"]);

// Upper-case name without extension.
const DOCUMENTATION_NAMES = new Set([
  "README", "CHANGELOG", "CHANGES", "HISTORY", "CONTRIBUTING", "LICENSE", "LICENCE", "COPYING",
  "AUTHORS", "NOTICE", "CODE_OF_CONDUCT", "SECURITY", "SUPPORT", "ARCHITECTURE", "MAINTAINERS",
]);

// Documents a new engineer rarely needs.
const PERIPHERAL_DOCUMENTS = new Set(["CHANGELOG", "CHANGES", "HISTORY", "LICENSE", "LICENCE", "COPYING", "AUTHORS", "NOTICE", "CODE_OF_CONDUCT", "MAINTAINERS"]);

const DOCUMENTATION_DIRECTORIES = new Set(["docs", "doc", "documentation"]);
const EXAMPLE_DIRECTORIES = new Set(["examples", "example", "samples", "sample", "demo", "demos"]);
const TEST_DIRECTORIES = new Set(["test", "tests", "__tests__", "spec", "specs", "e2e", "testing", "testdata", "__mocks__", "fixtures"]);
const SOURCE_DIRECTORIES = new Set(["src", "lib", "app", "pkg", "internal", "cmd", "core", "server", "api", "packages", "crates"]);
const CONFIGURATION_DIRECTORIES = new Set([".github", ".circleci", ".gitlab", ".buildkite", ".husky", ".devcontainer", ".vscode", ".idea", ".config", "config", "configs", "deploy", "deployment"]);

// Package manifests and build definitions: the first files to read about how a
// project is built. Lower-case names.
const MANIFESTS = new Set([
  "package.json", "pyproject.toml", "setup.py", "setup.cfg", "requirements.txt", "pipfile", "cargo.toml",
  "go.mod", "go.work", "gemfile", "pom.xml", "build.gradle", "build.gradle.kts", "settings.gradle",
  "settings.gradle.kts", "composer.json", "mix.exs", "makefile", "cmakelists.txt", "deno.json", "deno.jsonc",
  "pnpm-workspace.yaml", "turbo.json", "nx.json", "lerna.json",
]);

const CONFIGURATION_NAMES = new Set([
  ...Array.from(MANIFESTS),
  "dockerfile", "procfile", "justfile", "rakefile", "vagrantfile", "jenkinsfile", ".gitignore", ".gitattributes",
  ".editorconfig", ".npmrc", ".nvmrc", ".node-version", ".python-version", ".ruby-version", ".tool-versions",
  ".dockerignore", ".env.example", "gradle.properties", "tox.ini", "noxfile.py",
]);

const CONFIGURATION_EXTENSIONS = new Set([
  "json", "jsonc", "json5", "toml", "ini", "cfg", "conf", "yaml", "yml", "properties", "gradle", "tf", "hcl",
  "nix", "gemspec", "csproj", "fsproj", "sln", "cabal", "xml", "plist",
]);

// Lower-case names without extension.
const ENTRY_POINT_NAMES = new Set(["main", "index", "app", "server", "cli", "__main__", "program", "entry", "application", "wsgi", "asgi", "manage"]);

interface PathParts {
  readonly segments: readonly string[];
  readonly directories: readonly string[];
  readonly name: string;
  /** Lower-case name without extension. */
  readonly stem: string;
  /** Lower-case extension, or `""`. */
  readonly extension: string;
}

function parts(path: string): PathParts {
  const segments = path.split("/");
  const name = segments[segments.length - 1]!;
  const dot = name.lastIndexOf(".");
  const hasExtension = dot > 0;
  return {
    segments,
    directories: segments.slice(0, -1),
    name,
    stem: (hasExtension ? name.slice(0, dot) : name).toLowerCase(),
    extension: hasExtension ? name.slice(dot + 1).toLowerCase() : "",
  };
}

function isDocumentationFile({ name, stem, extension }: PathParts): boolean {
  if (DOCUMENTATION_NAMES.has(stem.toUpperCase().split(".")[0]!)) return extension === "" || DOCUMENTATION_EXTENSIONS.has(extension);
  // requirements.txt and CMakeLists.txt are configuration.
  if (extension === "txt") return !CONFIGURATION_NAMES.has(name.toLowerCase()) && !/^requirements/i.test(name);
  return DOCUMENTATION_EXTENSIONS.has(extension);
}

function isTest({ directories, name }: PathParts): boolean {
  if (directories.some((directory) => TEST_DIRECTORIES.has(directory.toLowerCase()))) return true;
  return (
    /\.(?:test|spec)\.[^.]+$/i.test(name) ||
    /_test\.(?:go|py|rs|exs?|dart|cc|cpp)$/.test(name) ||
    /^test_.+\.py$/.test(name) ||
    /(?:Test|Tests|Spec)\.(?:java|kt|cs|swift|scala|php)$/.test(name) ||
    /_spec\.rb$/.test(name) ||
    name === "conftest.py"
  );
}

function isConfiguration({ directories, name, extension }: PathParts): boolean {
  const lower = name.toLowerCase();
  if (CONFIGURATION_NAMES.has(lower)) return true;
  if (lower.startsWith("dockerfile") || lower.endsWith(".dockerfile")) return true;
  if (/^(?:docker-)?compose(?:\.[\w-]+)?\.ya?ml$/.test(lower)) return true;
  if (/\.config\.[cm]?[jt]s$/.test(lower) || /^tsconfig.*\.json$/.test(lower)) return true;
  if (/^\.[\w.-]*rc(?:\.\w+)?$/.test(lower)) return true;
  if (/^requirements.*\.txt$/.test(lower)) return true;
  if (CONFIGURATION_EXTENSIONS.has(extension)) return true;
  return directories.some((directory) => CONFIGURATION_DIRECTORIES.has(directory.toLowerCase()));
}

function isEntryPoint({ directories, stem, extension, name }: PathParts): boolean {
  const code = CODE_EXTENSIONS.has(extension);
  if (code && ENTRY_POINT_NAMES.has(stem)) return true;
  const parent = directories[directories.length - 1]?.toLowerCase();
  if (name === "lib.rs" && parent === "src") return true;
  if (parent === "bin" && (code || extension === "")) return true;
  return directories[0] === "cmd" && code;
}

/** The role the path rule gives a file. */
export function pathRole(path: string): FileRole {
  const file = parts(path);
  if (isDocumentationFile(file)) return "documentation";
  if (isTest(file)) return "test";
  if (file.directories.some((directory) => EXAMPLE_DIRECTORIES.has(directory.toLowerCase()))) return "documentation";
  if (isConfiguration(file)) return "configuration";
  if (isEntryPoint(file)) return "entry_point";
  if (file.directories.some((directory) => DOCUMENTATION_DIRECTORIES.has(directory.toLowerCase()))) return "documentation";
  return "domain_logic";
}

/** A file's importance from local signals, from 0 to 4. */
export function localScore(file: { readonly path: string; readonly size: number }): number {
  const path = parts(file.path);
  const depth = path.directories.length;
  const role = pathRole(file.path);
  const docName = path.stem.toUpperCase().split(".")[0]!;
  const examples = path.directories.some((directory) => EXAMPLE_DIRECTORIES.has(directory.toLowerCase()));

  let score: number;
  switch (role) {
    case "documentation":
      if (docName === "README") score = depth === 0 ? 4 : 2.5;
      else if (PERIPHERAL_DOCUMENTS.has(docName)) score = 0.5;
      else if (examples) score = 1;
      else score = depth === 0 ? 2.5 : 1.5;
      break;
    case "entry_point":
      score = 3.5;
      break;
    case "configuration":
      if (MANIFESTS.has(path.name.toLowerCase())) score = depth === 0 ? 3.5 : 2.5;
      else if (path.name.toLowerCase().startsWith("dockerfile")) score = 2.5;
      else score = 1.5;
      break;
    case "domain_logic":
      if (!CODE_EXTENSIONS.has(path.extension)) score = 1.25;
      else if (SOURCE_DIRECTORIES.has(path.segments[0]!.toLowerCase())) score = 2.75;
      else score = 2.25;
      break;
    case "test":
      score = 1;
      break;
  }

  // Deeper files matter less, and near-empty files matter little.
  score -= Math.max(0, depth - 2) * 0.25;
  if (file.size < 100) score -= 0.5;

  return Math.round(Math.min(4, Math.max(0, score)) * 100) / 100;
}
