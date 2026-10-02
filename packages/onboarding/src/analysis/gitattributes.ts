// Reads `linguist-generated` and `linguist-vendored` from a repository's root
// `.gitattributes`, with git's pattern rules (gitattributes(5), gitignore(5)).
// `path.matchesGlob` is not used: it never matches dotfiles with `*` and does
// not anchor patterns the way git does.

export interface LinguistAttributes {
  readonly generated: boolean;
  readonly vendored: boolean;
}

type Attribute = keyof LinguistAttributes;

// `true` (set or `=true`), `false` (unset with `-` or `=false`), or `null`
// (unspecified with `!`, which hides earlier lines).
type State = boolean | null;

interface Rule {
  readonly pattern: RegExp;
  readonly states: Partial<Record<Attribute, State>>;
}

const ATTRIBUTES: Record<string, Attribute> = {
  "linguist-generated": "generated",
  "linguist-vendored": "vendored",
};

/**
 * Parses the root `.gitattributes`. The result says whether a file path is
 * marked generated or vendored: for each attribute, the last line whose
 * pattern matches the path decides.
 */
export function parseGitAttributes(text: string): (path: string) => LinguistAttributes {
  const rules = text.split(/\r?\n/).flatMap((line) => {
    const rule = parseLine(line);
    return rule ? [rule] : [];
  });

  return (path) => ({ generated: resolve(rules, path, "generated"), vendored: resolve(rules, path, "vendored") });
}

function resolve(rules: readonly Rule[], path: string, attribute: Attribute): boolean {
  for (let index = rules.length - 1; index >= 0; index -= 1) {
    const rule = rules[index]!;
    const state = rule.states[attribute];
    if (state !== undefined && rule.pattern.test(path)) return state === true;
  }
  return false;
}

function parseLine(line: string): Rule | null {
  const [pattern, ...attributes] = line.trim().split(/[ \t]+/);
  // Comments, blank lines, macro definitions, and quoted patterns. Negative
  // patterns are not allowed in attribute files.
  if (!pattern || /^[#"!]/.test(pattern) || pattern.startsWith("[attr]")) return null;

  const states: Partial<Record<Attribute, State>> = {};
  for (const token of attributes) {
    const match = /^([-!]?)([^=]+)(?:=(.*))?$/.exec(token);
    const attribute = match && ATTRIBUTES[match[2]!];
    if (!match || !attribute) continue;

    const [, prefix, , value] = match;
    if (prefix === "!") states[attribute] = null;
    else if (prefix === "-" || value === "false") states[attribute] = false;
    else if (value === undefined || value === "true") states[attribute] = true;
  }
  if (Object.keys(states).length === 0) return null;

  const compiled = compilePattern(pattern);
  return compiled ? { pattern: compiled, states } : null;
}

/**
 * Compiles one gitattributes pattern to a regular expression over a file's
 * path from the repository root. Returns `null` for a pattern that can never
 * match a file: one ending in `/` matches directories only, and attributes do
 * not apply to the files inside a matched directory.
 */
export function compilePattern(pattern: string): RegExp | null {
  if (pattern.endsWith("/")) return null;

  // Without a slash, the pattern matches a file name at any depth. With one,
  // it is relative to the repository root.
  if (!pattern.includes("/")) return new RegExp(`^(?:.*/)?${segment(pattern)}$`, "s");

  const segments = pattern.replace(/^\//, "").split("/");
  let source = "";
  segments.forEach((part, index) => {
    const last = index === segments.length - 1;
    if (part === "**") source += last ? ".*" : "(?:[^/]*/)*";
    else source += segment(part) + (last ? "" : "/");
  });
  return new RegExp(`^${source}$`, "s");
}

// One path segment: `*` and `?` never match `/`, `[...]` is a character
// class, and `\` escapes the next character.
function segment(part: string): string {
  let source = "";
  for (let index = 0; index < part.length; index += 1) {
    const char = part[index]!;
    if (char === "\\" && index + 1 < part.length) {
      index += 1;
      source += escape(part[index]!);
    } else if (char === "*") {
      while (part[index + 1] === "*") index += 1;
      source += "[^/]*";
    } else if (char === "?") {
      source += "[^/]";
    } else if (char === "[") {
      const end = classEnd(part, index);
      if (end === -1) {
        source += "\\[";
      } else {
        source += characterClass(part.slice(index + 1, end));
        index = end;
      }
    } else {
      source += escape(char);
    }
  }
  return source;
}

// The index of the `]` that closes the class opened at `start`, or -1. A `]`
// right after `[` or `[!` is part of the class.
function classEnd(part: string, start: number): number {
  let index = start + 1;
  if (part[index] === "!" || part[index] === "^") index += 1;
  if (part[index] === "]") index += 1;
  return part.indexOf("]", index);
}

function characterClass(body: string): string {
  const negated = body.startsWith("!") || body.startsWith("^");
  const members = (negated ? body.slice(1) : body).replace(/[\\\]\[^]/g, "\\$&");
  return negated ? `[^/${members}]` : `[${members}]`;
}

function escape(char: string): string {
  return char.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
}
