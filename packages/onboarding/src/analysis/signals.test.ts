import { describe, expect, it } from "vitest";

import { localScore, pathRole } from "./signals";

describe("pathRole", () => {
  it.each([
    ["src/index.ts", "entry_point"],
    ["src/main.rs", "entry_point"],
    ["src/lib.rs", "entry_point"],
    ["cmd/server/main.go", "entry_point"],
    ["app.py", "entry_point"],
    ["mypkg/__main__.py", "entry_point"],
    ["manage.py", "entry_point"],
    ["bin/cli", "entry_point"],
    ["index.html", "entry_point"],
    ["package.json", "configuration"],
    ["pyproject.toml", "configuration"],
    ["Dockerfile", "configuration"],
    ["docker-compose.yml", "configuration"],
    [".github/workflows/ci.yml", "configuration"],
    ["tsconfig.base.json", "configuration"],
    ["vite.config.ts", "configuration"],
    [".eslintrc.cjs", "configuration"],
    ["requirements.txt", "configuration"],
    ["CMakeLists.txt", "configuration"],
    ["Makefile", "configuration"],
    ["config/routes.rb", "configuration"],
    ["src/server/routes.ts", "domain_logic"],
    ["lib/parser.rb", "domain_logic"],
    ["internal/store/store.go", "domain_logic"],
    ["src/styles/app.css", "domain_logic"],
    ["test/parser.test.ts", "test"],
    ["src/parser.test.ts", "test"],
    ["src/parser.spec.tsx", "test"],
    ["store/store_test.go", "test"],
    ["tests/test_api.py", "test"],
    ["conftest.py", "test"],
    ["src/test/java/AppTest.java", "test"],
    ["spec/models/user_spec.rb", "test"],
    ["README.md", "documentation"],
    ["docs/guide.md", "documentation"],
    ["docs/conf.py", "documentation"],
    ["CONTRIBUTING", "documentation"],
    ["LICENSE", "documentation"],
    ["notes.txt", "documentation"],
    ["examples/basic/main.go", "documentation"],
    ["tests/README.md", "documentation"],
  ])("%s is %s", (path, role) => {
    expect(pathRole(path)).toBe(role);
  });
});

describe("localScore", () => {
  const score = (path: string, size = 2_000) => localScore({ path, size });

  it("stays between 0 and 4", () => {
    for (const path of ["README.md", "a/b/c/d/e/f/g/h/i/j/k/test.ts", "x/y/z/LICENSE"]) {
      expect(score(path)).toBeGreaterThanOrEqual(0);
      expect(score(path)).toBeLessThanOrEqual(4);
    }
  });

  it("puts the root README, manifests, and entry points first", () => {
    expect(score("README.md")).toBe(4);
    expect(score("package.json")).toBeGreaterThan(score("src/utils/strings.ts"));
    expect(score("src/index.ts")).toBeGreaterThan(score("src/utils/strings.ts"));
  });

  it("ranks source above tests, examples, and peripheral documents", () => {
    expect(score("src/parser.ts")).toBeGreaterThan(score("test/parser.test.ts"));
    expect(score("src/parser.ts")).toBeGreaterThan(score("examples/basic/demo.ts"));
    expect(score("src/parser.ts")).toBeGreaterThan(score("CHANGELOG.md"));
  });

  it("lowers deep and near-empty files", () => {
    expect(score("src/a/b/c/d/parser.ts")).toBeLessThan(score("src/parser.ts"));
    expect(score("src/__init__.py", 0)).toBeLessThan(score("src/parser.py"));
  });
});
