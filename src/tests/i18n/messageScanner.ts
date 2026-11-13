/**
 * Static inventory of user-facing API message copy.
 *
 * Walks the TypeScript sources and collects every string (or template) that
 * can reach a non-admin user through an API response:
 *
 *  - `msg` properties (the shared `{ success, msg }` envelope)
 *  - `message` / `error` properties of response bodies (objects passed to
 *    `.json()`/`.send()`, objects carrying `success`, and their `error` /
 *    `data` children)
 *  - `new UserFacingError(status, message)` and the other error classes whose
 *    message is forwarded to the client
 *  - `sendHandlerError` / `toHandlerError` fallbacks (shown on 5xx)
 *  - custom Mongoose validator messages in `src/models` (surfaced by the
 *    shared ValidationError handler)
 *  - literal arguments of local helpers that forward a parameter into any of
 *    the above, and identifiers bound to such literals
 *
 * Admin-only modules are excluded (the admin panel deliberately stays
 * English): a file is in scope only when it is reachable from `src/index.ts`
 * without passing through the admin router/handlers.
 *
 * Used by `messageCatalogCoverage.test.ts` and by the catalog generator.
 */
import fs from "fs";
import path from "path";
import ts from "typescript";

export type ScannedMessage = {
  /** English copy; template expressions are rendered as `{name}`. */
  text: string;
  /** `message` = whole sentence; `fragment` = value interpolated into one. */
  kind: "message" | "fragment";
  rule: string;
  file: string;
  line: number;
};

/**
 * Error classes whose message is forwarded verbatim to the client, with the
 * constructor argument index that carries the message.
 */
export const EXPOSED_ERROR_CLASSES = new Map<string, number>([
  ["UserFacingError", 1],
  ["RefundError", 1],
  ["BacklinkError", 0],
  ["UploadError", 1],
  ["AnonymizationError", 2],
]);

const RESPONSE_PROPS = new Set(["msg", "message", "error"]);
const VALIDATOR_TUPLE_PROPS = new Set(["required", "min", "max", "minlength", "maxlength", "match", "enum"]);

function listSourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "tests" || entry.name === "scripts" || entry.name === "node_modules") continue;
      listSourceFiles(full, out);
    } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) {
      out.push(full);
    }
  }
  return out;
}

function isAdminPath(rel: string): boolean {
  return (
    rel.startsWith("src/handlers/Admin/") ||
    rel.startsWith("src/routes/Admin/") ||
    rel === "src/middlewares/auditAdmin.ts"
  );
}

function resolveImport(fromFile: string, spec: string): string | null {
  if (!spec.startsWith(".")) return null;
  const base = path.resolve(path.dirname(fromFile), spec);
  for (const candidate of [`${base}.ts`, path.join(base, "index.ts")]) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function importsOf(sf: ts.SourceFile): string[] {
  const specs: string[] = [];
  const visit = (node: ts.Node) => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      specs.push(node.moduleSpecifier.text);
    } else if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === "require")) &&
      node.arguments[0] &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      specs.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return specs;
}

/** Files reachable from the app entry without entering admin-only code. */
function userReachableFiles(root: string, sources: Map<string, ts.SourceFile>): Set<string> {
  const entry = path.join(root, "src/index.ts");
  const seen = new Set<string>();
  const queue = [entry];
  while (queue.length) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    const rel = path.relative(root, file).split(path.sep).join("/");
    if (isAdminPath(rel)) continue;
    seen.add(file);
    const sf = sources.get(file);
    if (!sf) continue;
    for (const spec of importsOf(sf)) {
      const target = resolveImport(file, spec);
      if (target && !seen.has(target)) queue.push(target);
    }
  }
  return seen;
}

function placeholderName(expr: ts.Expression, used: Map<string, number>): string {
  let name = "value";
  let node: ts.Expression = expr;
  while (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isNonNullExpression(node)) {
    node = node.expression;
  }
  if (ts.isIdentifier(node)) name = node.text;
  else if (ts.isPropertyAccessExpression(node)) name = node.name.text;
  else if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.arguments.length === 1) {
    const inner = node.arguments[0];
    if (ts.isIdentifier(inner)) name = inner.text;
    else if (ts.isPropertyAccessExpression(inner)) name = inner.name.text;
  }
  name = name.replace(/[^A-Za-z0-9_]/g, "") || "value";
  const count = (used.get(name) || 0) + 1;
  used.set(name, count);
  return count === 1 ? name : `${name}${count}`;
}

type Piece = { text: string; params: ts.Expression[] };

/** Renders a literal / template / `+` concatenation as copy with `{name}` holes. */
function renderLiteral(node: ts.Expression): Piece | null {
  while (ts.isParenthesizedExpression(node) || ts.isAsExpression(node)) node = node.expression;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return { text: node.text, params: [] };
  if (ts.isTemplateExpression(node)) {
    const used = new Map<string, number>();
    let text = node.head.text;
    const params: ts.Expression[] = [];
    for (const span of node.templateSpans) {
      text += `{${placeholderName(span.expression, used)}}${span.literal.text}`;
      params.push(span.expression);
    }
    return { text, params };
  }
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const parts: ts.Expression[] = [];
    const flatten = (n: ts.Expression) => {
      if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.PlusToken) {
        flatten(n.left);
        flatten(n.right);
      } else parts.push(n);
    };
    flatten(node);
    if (!parts.some((p) => ts.isStringLiteral(p) || ts.isNoSubstitutionTemplateLiteral(p) || ts.isTemplateExpression(p))) {
      return null;
    }
    const used = new Map<string, number>();
    let text = "";
    const params: ts.Expression[] = [];
    for (const part of parts) {
      const rendered = ts.isStringLiteral(part) || ts.isNoSubstitutionTemplateLiteral(part) || ts.isTemplateExpression(part)
        ? renderLiteral(part)
        : null;
      if (rendered) {
        text += rendered.text;
        params.push(...rendered.params);
      } else {
        text += `{${placeholderName(part, used)}}`;
        params.push(part);
      }
    }
    return { text, params };
  }
  return null;
}

function isUserCopy(text: string): boolean {
  // Copy has at least one word of letters; skip codes/enums/empty strings.
  const stripped = text.replace(/\{[A-Za-z0-9_]+\}/g, "").trim();
  if (!/[A-Za-z]{2,}/.test(stripped)) return false;
  if (/^[A-Z0-9_]+$/.test(stripped)) return false; // ERROR_CODE
  if (/^[a-z][A-Za-z0-9_.-]*$/.test(stripped)) return false; // machine token / field name
  return true;
}

function propName(node: ts.PropertyName | ts.Identifier): string | null {
  if (ts.isIdentifier(node) || ts.isStringLiteral(node)) return node.text;
  return null;
}

function objectHasProp(obj: ts.ObjectLiteralExpression, name: string): boolean {
  return obj.properties.some((p) => p.name && propName(p.name as ts.PropertyName) === name);
}

/** True for objects that are (part of) an API response body. */
function isResponseObject(obj: ts.ObjectLiteralExpression): boolean {
  if (objectHasProp(obj, "success")) return true;
  const parent = obj.parent;
  if (ts.isCallExpression(parent) && ts.isPropertyAccessExpression(parent.expression)) {
    const method = parent.expression.name.text;
    if ((method === "json" || method === "send") && parent.arguments.includes(obj)) return true;
  }
  // `{ error: { code, message } }` / `{ data: { message } }` children.
  if (ts.isPropertyAssignment(parent) && ts.isObjectLiteralExpression(parent.parent)) {
    const key = propName(parent.name);
    if ((key === "error" || key === "data") && isResponseObject(parent.parent)) return true;
  }
  return false;
}

function enclosingFunction(node: ts.Node): ts.SignatureDeclaration | undefined {
  let cur: ts.Node | undefined = node.parent;
  while (cur) {
    if (ts.isFunctionDeclaration(cur) || ts.isArrowFunction(cur) || ts.isFunctionExpression(cur) || ts.isMethodDeclaration(cur)) {
      return cur;
    }
    cur = cur.parent;
  }
  return undefined;
}

function functionName(fn: ts.SignatureDeclaration): string | null {
  if ((ts.isFunctionDeclaration(fn) || ts.isMethodDeclaration(fn)) && fn.name && ts.isIdentifier(fn.name)) return fn.name.text;
  const parent = fn.parent;
  if (parent && ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) return parent.name.text;
  return null;
}

function paramIndex(fn: ts.SignatureDeclaration, name: string): number {
  return fn.parameters.findIndex((p) => ts.isIdentifier(p.name) && p.name.text === name);
}

/** `console.*(...)` / logger arguments are diagnostics, never response copy. */
function insideLogCall(node: ts.Node): boolean {
  let cur: ts.Node | undefined = node.parent;
  while (cur && !ts.isSourceFile(cur)) {
    if (ts.isCallExpression(cur)) {
      const callee = cur.expression;
      if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression) && callee.expression.text === "console") {
        return true;
      }
    }
    if (ts.isFunctionLike(cur)) return false;
    cur = cur.parent;
  }
  return false;
}

type Sink = { node: ts.Expression; rule: string };

export function scanUserFacingMessages(root: string): {
  messages: ScannedMessage[];
  inScopeFiles: string[];
} {
  const files = listSourceFiles(path.join(root, "src"));
  const sources = new Map<string, ts.SourceFile>();
  for (const file of files) {
    sources.set(file, ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true));
  }
  const reachable = userReachableFiles(root, sources);
  const inScope = files.filter((f) => reachable.has(f));

  const out: ScannedMessage[] = [];
  /** helper name -> parameter indexes forwarded into a message sink */
  const messageHelpers = new Map<string, Set<number>>();
  /** helper name -> parameter indexes (or `index:property`) interpolated into message templates */
  const fragmentHelpers = new Map<string, Set<number | string>>();

  const addHelper = (map: Map<string, Set<any>>, name: string, index: number, property?: string) => {
    if (!map.has(name)) map.set(name, new Set());
    map.get(name)!.add(property ? `${index}:${property}` : index);
  };

  const record = (sf: ts.SourceFile, node: ts.Node, text: string, kind: ScannedMessage["kind"], rule: string) => {
    if (!isUserCopy(text)) return;
    out.push({
      text,
      kind,
      rule,
      file: path.relative(root, sf.fileName).split(path.sep).join("/"),
      line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
    });
  };

  /** Resolves a sink expression to literal copy, following simple bindings. */
  const collect = (sf: ts.SourceFile, expr: ts.Expression, rule: string, depth = 0): void => {
    if (depth > 4) return;
    while (ts.isParenthesizedExpression(expr) || ts.isAsExpression(expr) || ts.isNonNullExpression(expr)) expr = expr.expression;
    const rendered = renderLiteral(expr);
    if (rendered) {
      record(sf, expr, rendered.text, "message", rule);
      // Template parameters bound to a helper parameter: the call-site
      // literals are fragments interpolated into this message.
      const fn = enclosingFunction(expr);
      const name = fn && functionName(fn);
      if (fn && name) {
        for (const param of rendered.params) {
          if (ts.isIdentifier(param)) {
            const idx = paramIndex(fn, param.text);
            if (idx >= 0) addHelper(fragmentHelpers, name, idx);
          } else if (ts.isPropertyAccessExpression(param) && ts.isIdentifier(param.expression)) {
            // `${options.itemLabel}`: call sites pass `{ itemLabel: "..." }`.
            const idx = paramIndex(fn, param.expression.text);
            if (idx >= 0) addHelper(fragmentHelpers, name, idx, param.name.text);
          }
        }
      }
      return;
    }
    if (ts.isConditionalExpression(expr)) {
      collect(sf, expr.whenTrue, rule, depth + 1);
      collect(sf, expr.whenFalse, rule, depth + 1);
      return;
    }
    if (
      ts.isBinaryExpression(expr) &&
      (expr.operatorToken.kind === ts.SyntaxKind.BarBarToken || expr.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken)
    ) {
      collect(sf, expr.left, rule, depth + 1);
      collect(sf, expr.right, rule, depth + 1);
      return;
    }
    if (ts.isIdentifier(expr)) {
      const name = expr.text;
      const fn = enclosingFunction(expr);
      const idx = fn ? paramIndex(fn, name) : -1;
      const fnName = fn && functionName(fn);
      if (fn && idx >= 0 && fnName) {
        addHelper(messageHelpers, fnName, idx);
        // Default parameter values are copy too.
        const init = fn.parameters[idx].initializer;
        if (init) collect(sf, init, rule, depth + 1);
        return;
      }
      // Local bindings: `const message = cond ? "A" : "B"` / `message = "C"`.
      const scope: ts.Node = fn ?? sf;
      const visit = (node: ts.Node) => {
        if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name && node.initializer) {
          collect(sf, node.initializer, rule, depth + 1);
        } else if (
          ts.isBinaryExpression(node) &&
          node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
          ts.isIdentifier(node.left) &&
          node.left.text === name
        ) {
          collect(sf, node.right, rule, depth + 1);
        }
        ts.forEachChild(node, visit);
      };
      visit(scope);
    }
  };

  const sinksOf = (sf: ts.SourceFile): Sink[] => {
    const sinks: Sink[] = [];
    const isModel = sf.fileName.split(path.sep).join("/").includes("/src/models/");
    const visit = (node: ts.Node) => {
      if (ts.isPropertyAssignment(node) && ts.isObjectLiteralExpression(node.parent)) {
        const key = propName(node.name);
        if (key && RESPONSE_PROPS.has(key)) {
          if (key === "msg" || isResponseObject(node.parent)) sinks.push({ node: node.initializer, rule: `response.${key}` });
          else if (isModel && key === "message") sinks.push({ node: node.initializer, rule: "schema.message" });
          else if (!insideLogCall(node)) sinks.push({ node: node.initializer, rule: `result.${key}` });
        }
        if (isModel && key && VALIDATOR_TUPLE_PROPS.has(key) && ts.isArrayLiteralExpression(node.initializer)) {
          const elements = node.initializer.elements;
          if (elements.length === 2) sinks.push({ node: elements[1] as ts.Expression, rule: `schema.${key}` });
        }
      }
      if (ts.isShorthandPropertyAssignment(node) && ts.isObjectLiteralExpression(node.parent)) {
        const key = node.name.text;
        if (RESPONSE_PROPS.has(key) && (key === "msg" || isResponseObject(node.parent))) {
          sinks.push({ node: node.name, rule: `response.${key}` });
        }
      }
      if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && EXPOSED_ERROR_CLASSES.has(node.expression.text)) {
        const arg = node.arguments?.[EXPOSED_ERROR_CLASSES.get(node.expression.text)!];
        if (arg) sinks.push({ node: arg, rule: `error.${node.expression.text}` });
      }
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
        const callee = node.expression.text;
        if (callee === "sendHandlerError" && node.arguments[2]) sinks.push({ node: node.arguments[2], rule: "fallback" });
        if (callee === "toHandlerError" && node.arguments[1]) sinks.push({ node: node.arguments[1], rule: "fallback" });
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
    return sinks;
  };

  // Pass 1: direct sinks (also discovers helper functions).
  for (const file of inScope) {
    const sf = sources.get(file)!;
    for (const sink of sinksOf(sf)) collect(sf, sink.node, sink.rule);
  }

  // Pass 2: literal arguments of helpers, iterated until no new helpers.
  let previous = -1;
  for (let round = 0; round < 5 && previous !== messageHelpers.size + fragmentHelpers.size; round++) {
    previous = messageHelpers.size + fragmentHelpers.size;
    for (const file of inScope) {
      const sf = sources.get(file)!;
      const visit = (node: ts.Node) => {
        if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
          const callee = node.expression;
          const name = ts.isIdentifier(callee)
            ? callee.text
            : ts.isPropertyAccessExpression(callee)
              ? callee.name.text
              : null;
          if (name) {
            for (const idx of messageHelpers.get(name) || []) {
              const arg = node.arguments?.[idx];
              if (arg) collect(sf, arg, `helper.${name}`);
            }
            for (const spec of fragmentHelpers.get(name) || []) {
              const [idx, property] = typeof spec === "number" ? [spec, undefined] : [Number(spec.split(":")[0]), spec.split(":")[1]];
              let arg = node.arguments?.[idx];
              if (arg && property) {
                const prop = ts.isObjectLiteralExpression(arg)
                  ? arg.properties.find((p) => ts.isPropertyAssignment(p) && propName(p.name) === property)
                  : undefined;
                arg = prop && ts.isPropertyAssignment(prop) ? prop.initializer : undefined;
              }
              const rendered = arg && renderLiteral(arg);
              if (rendered) record(sf, arg!, rendered.text, "fragment", `fragment.${name}`);
            }
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(sf);
    }
  }

  // Dedupe identical (text, kind, file, line, rule) rows.
  const seen = new Set<string>();
  const messages = out.filter((m) => {
    const key = `${m.kind}\u0000${m.text}\u0000${m.file}\u0000${m.line}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return {
    messages,
    inScopeFiles: inScope.map((f) => path.relative(root, f).split(path.sep).join("/")),
  };
}
