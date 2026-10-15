// The converter split (ARCHITECTURE §2.1, §12): moves top-level statements out of pristine upstream files into new
// modules, byte for byte, from a committed symbol manifest. Pure: pristine text and the manifest in, file text out.
//
// Manifest (vendor/extract/<root>.json); paths are relative to the root after joining `base`:
//   modules[]:  { path, take: [{ from, symbols } | { from, range: [first, last], except? }], views?: [className] }
//               `views` classes keep their class here, while decorate()'s body moves to the residual's registration.
//   rename:     { <source>: <residual> }   the remainder of a source lands at another path (X.tsx → X.view.tsx)
//   reroute:    [path]                     untouched files whose imports of moved names follow them
//   specifiers: { <from>: <to> }           bare specifiers rewritten in extracted modules
//   rewrite:    [{ file, from, to }]       one import specifier rewritten in one file
//   imports:    { <residual>: [spec] }     side-effect imports a residual gains
//   templates:  [path]                     added files, read from vendor/extract/<root>/<path>
// Every source that loses statements becomes a residual: the remainder, importing and re-exporting what moved.
import ts from 'typescript';
import { posix } from 'node:path';

export const SEAM = '// moss-multi seam: converter-split (A§12; S-conv §2.3)';
const VIEW_SEAM = '// moss-multi seam: node-views (A§12)';
const CODE_EXT = ['.ts', '.tsx', '.d.ts', '.js', '.jsx', '.mjs'];

const kindOf = (path) => (/\.(tsx|jsx)$/.test(path) ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
const stripExt = (path) => path.replace(/(\.d)?\.(tsx?|jsx?|mjs)$/, '');
const isRelative = (spec) => spec.startsWith('./') || spec.startsWith('../');
const byPath = ([a], [b]) => (a < b ? -1 : a > b ? 1 : 0);

function relSpec(fromFile, toPath) {
  const spec = posix.relative(posix.dirname(fromFile), toPath);
  return spec.startsWith('.') ? spec : `./${spec}`;
}

// One-file program: names resolve within the file; imports stay unresolved aliases.
function parse(path, text) {
  const sf = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, kindOf(path));
  const host = {
    getSourceFile: (name) => (name === path ? sf : undefined),
    getDefaultLibFileName: () => '/lib.d.ts',
    writeFile: () => {},
    getCurrentDirectory: () => '/',
    getCanonicalFileName: (name) => name,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => '\n',
    fileExists: (name) => name === path,
    readFile: () => undefined,
  };
  const options = { noResolve: true, noLib: true, types: [], jsx: ts.JsxEmit.Preserve, allowJs: true, target: ts.ScriptTarget.Latest };
  return { path, sf, text, checker: ts.createProgram([path], options, host).getTypeChecker() };
}

function bindingNames(name, out = []) {
  if (ts.isIdentifier(name)) out.push(name.text);
  else for (const element of name.elements) if (!ts.isOmittedExpression(element)) bindingNames(element.name, out);
  return out;
}

export function declaredNames(statement) {
  if (ts.isVariableStatement(statement)) return statement.declarationList.declarations.flatMap((d) => bindingNames(d.name));
  const named =
    ts.isFunctionDeclaration(statement) ||
    ts.isClassDeclaration(statement) ||
    ts.isInterfaceDeclaration(statement) ||
    ts.isTypeAliasDeclaration(statement) ||
    ts.isEnumDeclaration(statement) ||
    ts.isModuleDeclaration(statement);
  return named && statement.name ? [statement.name.text] : [];
}

const hasModifier = (node, kind) => Boolean(ts.canHaveModifiers(node) && ts.getModifiers(node)?.some((m) => m.kind === kind));
const isTypeDecl = (statement) => ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement);
const statementOf = (file, name) => file.sf.statements.find((s) => !ts.isImportDeclaration(s) && declaredNames(s).includes(name));

// A statement's text with its comments, without the blank lines before it.
function chunkOf(file, statement) {
  const full = file.text.slice(statement.getFullStart(), statement.end);
  const text = full.replace(/^\s*\n/, '');
  return { text, offset: statement.getFullStart() + full.length - text.length };
}

function importBindings(file) {
  const bindings = new Map();
  for (const statement of file.sf.statements) {
    if (!ts.isImportDeclaration(statement) || !statement.importClause) continue;
    const spec = statement.moduleSpecifier.text;
    const clause = statement.importClause;
    if (clause.name) bindings.set(clause.name.text, { spec, imported: 'default', typeOnly: clause.isTypeOnly });
    const named = clause.namedBindings;
    if (named && ts.isNamespaceImport(named)) bindings.set(named.name.text, { spec, imported: '*', typeOnly: clause.isTypeOnly });
    if (named && ts.isNamedImports(named)) {
      for (const element of named.elements) {
        const imported = (element.propertyName ?? element.name).text;
        bindings.set(element.name.text, { spec, imported, typeOnly: clause.isTypeOnly || element.isTypeOnly });
      }
    }
  }
  return bindings;
}

function isTypePosition(node, stop) {
  for (let n = node; n && n !== stop; n = n.parent) {
    if (ts.isExpressionWithTypeArguments(n)) {
      const clause = n.parent;
      if (ts.isHeritageClause(clause) && (clause.token === ts.SyntaxKind.ImplementsKeyword || ts.isInterfaceDeclaration(clause.parent))) return true;
      continue;
    }
    if (ts.isTypeNode(n) || ts.isInterfaceDeclaration(n) || ts.isTypeAliasDeclaration(n)) return true;
  }
  return false;
}

function isReference(node) {
  const parent = node.parent;
  if (!parent) return false;
  if (ts.isShorthandPropertyAssignment(parent)) return parent.name === node;
  if (ts.isExportSpecifier(parent)) return !parent.parent.parent.moduleSpecifier && node === (parent.propertyName ?? parent.name);
  if (parent.name === node) return false;
  if (ts.isQualifiedName(parent) && parent.right === node) return false;
  if ((ts.isImportSpecifier(parent) || ts.isBindingElement(parent)) && parent.propertyName === node) return false;
  if ((ts.isLabeledStatement(parent) || ts.isBreakOrContinueStatement(parent)) && parent.label === node) return false;
  if (ts.isImportClause(parent) || ts.isNamespaceImport(parent) || ts.isImportEqualsDeclaration(parent)) return false;
  return true;
}

function isTopLevelDecl(decl, sf) {
  if (decl.parent === sf) return true;
  if (ts.isVariableDeclaration(decl)) return decl.parent?.parent?.parent === sf;
  if (ts.isBindingElement(decl)) {
    let n = decl;
    while (n && (ts.isBindingElement(n) || ts.isObjectBindingPattern(n) || ts.isArrayBindingPattern(n))) n = n.parent;
    return Boolean(n && ts.isVariableDeclaration(n) && n.parent?.parent?.parent === sf);
  }
  return false;
}

// Names the statements use, each as an import binding, a top-level declaration or an unresolved (free) name, with
// whether any use needs the value. `skip` nodes are not read.
function referencesOf(file, statements, skip = new Set()) {
  const refs = new Map();
  const note = (name, kind, value) => {
    const ref = refs.get(name) ?? { kind, value: false };
    ref.value ||= value;
    refs.set(name, ref);
  };
  for (const statement of statements) {
    const visit = (node) => {
      if (skip.has(node) || ts.isImportDeclaration(node)) return;
      if (ts.isIdentifier(node) && isReference(node)) {
        const parent = node.parent;
        let symbol;
        if (ts.isShorthandPropertyAssignment(parent)) symbol = file.checker.getShorthandAssignmentValueSymbol(parent);
        else if (ts.isExportSpecifier(parent)) symbol = file.checker.getExportSpecifierLocalTargetSymbol(parent);
        else symbol = file.checker.getSymbolAtLocation(node);
        const decl = symbol?.declarations?.[0];
        const value = !isTypePosition(node, statement);
        if (!decl) note(node.text, 'free', value);
        else if (ts.isImportSpecifier(decl) || ts.isImportClause(decl) || ts.isNamespaceImport(decl)) note(node.text, 'import', value);
        else if (isTopLevelDecl(decl, file.sf)) note(node.text, 'top', value);
      }
      ts.forEachChild(node, visit);
    };
    visit(statement);
  }
  return refs;
}

class ImportSet {
  constructor() {
    this.bySpec = new Map();
    this.order = new Map();
  }
  add(spec, imported, local, typeOnly, rank = Infinity) {
    if (!this.order.has(spec) || this.order.get(spec) > rank) this.order.set(spec, rank);
    const entry = this.bySpec.get(spec) ?? { defaultName: null, namespace: null, named: new Map() };
    this.bySpec.set(spec, entry);
    const slot = imported === 'default' ? 'defaultName' : imported === '*' ? 'namespace' : null;
    if (slot) {
      entry[slot] = { local, typeOnly: typeOnly && (entry[slot]?.typeOnly ?? true) };
      return;
    }
    const prev = entry.named.get(local);
    if (prev && prev.imported !== imported) throw new Error(`import ${local}: both ${prev.imported} and ${imported} from ${spec}`);
    entry.named.set(local, { imported, local, typeOnly: typeOnly && (prev?.typeOnly ?? true) });
  }
  print() {
    const specs = [...this.bySpec.keys()].sort((a, b) => this.order.get(a) - this.order.get(b) || (a < b ? -1 : a > b ? 1 : 0));
    return specs.flatMap((spec) => {
      const { defaultName, namespace, named } = this.bySpec.get(spec);
      const lines = [];
      if (namespace) lines.push(`import ${namespace.typeOnly ? 'type ' : ''}* as ${namespace.local} from '${spec}';`);
      const names = [...named.values()].sort((a, b) => (a.local < b.local ? -1 : a.local > b.local ? 1 : 0));
      if (!defaultName && names.length === 0) return lines;
      const allTypes = names.every((n) => n.typeOnly) && (!defaultName || defaultName.typeOnly);
      const parts = names.map((n) => `${!allTypes && n.typeOnly ? 'type ' : ''}${n.imported === n.local ? n.local : `${n.imported} as ${n.local}`}`);
      const head = defaultName ? defaultName.local : '';
      const body = parts.length ? `{ ${parts.join(', ')} }` : '';
      lines.push(`import ${allTypes ? 'type ' : ''}${[head, body].filter(Boolean).join(', ')} from '${spec}';`);
      return lines;
    });
  }
}

export function loadManifest(json) {
  const manifest = typeof json === 'string' ? JSON.parse(json) : json;
  const at = (path) => posix.join(manifest.base ?? '', path);
  return {
    modules: (manifest.modules ?? []).map((m) => ({ path: at(m.path), take: m.take.map((t) => ({ ...t, from: at(t.from) })), views: m.views ?? [] })),
    rename: Object.fromEntries(Object.entries(manifest.rename ?? {}).map(([from, to]) => [at(from), at(to)])),
    reroute: (manifest.reroute ?? []).map(at),
    specifiers: manifest.specifiers ?? {},
    rewrite: (manifest.rewrite ?? []).map((r) => ({ ...r, file: at(r.file) })),
    imports: Object.fromEntries(Object.entries(manifest.imports ?? {}).map(([path, specs]) => [at(path), specs])),
    templates: (manifest.templates ?? []).map((path) => ({ path: at(path), template: path })),
  };
}

// Upstream paths whose pristine text the extraction reads.
export function inputsOf(manifest) {
  const paths = new Set();
  for (const m of manifest.modules) for (const t of m.take) paths.add(t.from);
  for (const path of manifest.reroute) paths.add(path);
  for (const r of manifest.rewrite) paths.add(r.file);
  return [...paths].sort();
}

/**
 * @param {object} args
 * @param {ReturnType<typeof loadManifest>} args.manifest
 * @param {(path: string) => string | undefined} args.read   pristine upstream text by path
 * @param {(path: string) => boolean} args.exists            whether an upstream path exists, for module resolution
 * @param {(template: string) => string} args.readTemplate
 * @returns {Map<string, {text: string, kind: 'extracted'|'residual'|'rerouted'|'template', sources: string[], upstreamPath?: string, symbols?: string[], template?: string}>}
 */
export function extract({ manifest, read, exists, readTemplate }) {
  const files = new Map();
  const fileOf = (path) => {
    if (!files.has(path)) {
      const text = read(path);
      if (text === undefined) throw new Error(`${path}: not in the pristine tree`);
      files.set(path, parse(path, text));
    }
    return files.get(path);
  };
  const resolve = (fromFile, spec) => {
    if (!isRelative(spec)) return null;
    const target = posix.normalize(posix.join(posix.dirname(fromFile), spec));
    const candidates = [target, ...CODE_EXT.map((ext) => target + ext), `${target}/index.ts`, `${target}/index.tsx`];
    return candidates.find((candidate) => exists(candidate)) ?? null;
  };

  // Which statements move where.
  const moved = new Map(); // source → Map(statement → module)
  const movedName = new Map(); // `${source}\0${name}` → module
  const byName = new Map(); // moved name → { source, module }
  for (const m of manifest.modules) {
    for (const take of m.take) {
      const file = fileOf(take.from);
      const statements = file.sf.statements.filter((s) => !ts.isImportDeclaration(s));
      const indexOf = (name) => {
        const i = statements.findIndex((s) => declaredNames(s).includes(name));
        if (i < 0) throw new Error(`${take.from}: no top-level ${name}`);
        return i;
      };
      let chosen;
      if (take.range) {
        const [first, last] = take.range.map(indexOf);
        if (last < first) throw new Error(`${take.from}: range ${take.range.join('..')} is reversed`);
        const except = new Set(take.except ?? []);
        for (const name of except) indexOf(name);
        chosen = statements.slice(first, last + 1).filter((s) => !declaredNames(s).some((n) => except.has(n)));
      } else {
        chosen = [...new Set(take.symbols.map((name) => statements[indexOf(name)]))];
      }
      const map = moved.get(take.from) ?? new Map();
      moved.set(take.from, map);
      for (const statement of chosen) {
        if (map.has(statement)) throw new Error(`${take.from}: ${declaredNames(statement).join(',') || 'a statement'} is taken twice`);
        map.set(statement, m.path);
        for (const name of declaredNames(statement)) {
          if (byName.has(name)) throw new Error(`${name} moves from both ${byName.get(name).source} and ${take.from}`);
          movedName.set(`${take.from}\0${name}`, m.path);
          byName.set(name, { source: take.from, module: m.path });
        }
      }
    }
  }

  const templateExports = new Map(); // name → template path
  const templates = manifest.templates.map((t) => {
    const parsed = parse(t.path, readTemplate(t.template));
    for (const statement of parsed.sf.statements) {
      if (hasModifier(statement, ts.SyntaxKind.ExportKeyword)) for (const name of declaredNames(statement)) templateExports.set(name, t.path);
    }
    return { ...t, text: parsed.text };
  });

  const residualPath = (source) => manifest.rename[source] ?? source;
  const isExported = (source, name) => {
    const statement = statementOf(fileOf(source), name);
    return Boolean(statement && hasModifier(statement, ts.SyntaxKind.ExportKeyword));
  };
  const isTypeName = (source, name) => {
    const statement = statementOf(fileOf(source), name);
    return Boolean(statement && isTypeDecl(statement));
  };
  // A module exports a moved name already, or through an appended `export {}`.
  const needsExport = new Map();
  const requireExport = (module, source, name) => {
    if (isExported(source, name)) return;
    needsExport.set(module, new Set([...(needsExport.get(module) ?? []), name]));
  };

  // A name a barrel re-exports, followed to the module that defines it.
  const leafOf = (path, name, seen = new Set()) => {
    if (seen.has(path)) return { path, name };
    seen.add(path);
    for (const statement of fileOf(path).sf.statements) {
      if (!ts.isExportDeclaration(statement) || !statement.moduleSpecifier || !statement.exportClause) continue;
      if (!ts.isNamedExports(statement.exportClause)) continue;
      const element = statement.exportClause.elements.find((e) => e.name.text === name);
      const next = element && resolve(path, statement.moduleSpecifier.text);
      if (next) return leafOf(next, (element.propertyName ?? element.name).text, seen);
    }
    return { path, name };
  };

  // Where an import binding of `filePath` points once things have moved, as seen from `outPath`. Extracted
  // modules (`bare` given) import leaves, never barrels, so the converter closure stays small.
  const routeImport = (filePath, outPath, binding, bare) => {
    if (bare && isRelative(binding.spec) && binding.imported !== '*' && binding.imported !== 'default') {
      const target = resolve(filePath, binding.spec);
      if (target && !moved.has(target)) {
        const leaf = leafOf(target, binding.imported);
        if (leaf.path !== target) return { spec: relSpec(outPath, stripExt(leaf.path)), imported: leaf.name };
      }
    }
    const target = resolve(filePath, binding.spec);
    if (target && moved.has(target) && binding.imported !== '*' && binding.imported !== 'default') {
      const module = movedName.get(`${target}\0${binding.imported}`);
      if (module) {
        requireExport(module, target, binding.imported);
        return { spec: relSpec(outPath, stripExt(module)), imported: binding.imported };
      }
      if (manifest.rename[target]) return { spec: relSpec(outPath, stripExt(manifest.rename[target])), imported: binding.imported };
    }
    if (isRelative(binding.spec)) {
      return { spec: relSpec(outPath, posix.normalize(posix.join(posix.dirname(filePath), binding.spec))), imported: binding.imported };
    }
    return { spec: bare?.[binding.spec] ?? binding.spec, imported: binding.imported };
  };

  // Rewrites a file's imports of moved names so they point at the modules that now hold them.
  function rerouteImports(file, outPath) {
    let text = '';
    let at = 0;
    for (const statement of file.sf.statements) {
      if (!ts.isImportDeclaration(statement) || !statement.importClause) continue;
      const spec = statement.moduleSpecifier.text;
      const target = resolve(file.path, spec);
      if (!target || !moved.has(target)) continue;
      const clause = statement.importClause;
      if (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings)) throw new Error(`${file.path}: a namespace import of ${spec} cannot be rerouted`);
      const set = new ImportSet();
      let changed = false;
      if (clause.name) set.add(spec, 'default', clause.name.text, clause.isTypeOnly, 0);
      for (const element of clause.namedBindings?.elements ?? []) {
        const imported = (element.propertyName ?? element.name).text;
        const routed = routeImport(file.path, outPath, { spec, imported });
        changed ||= routed.spec !== spec;
        set.add(routed.spec === spec ? spec : routed.spec, imported, element.name.text, clause.isTypeOnly || element.isTypeOnly, routed.spec === spec ? 0 : 1);
      }
      // Nothing moved away from this import: keep upstream's bytes.
      if (!changed) continue;
      const printed = set.print();
      text += `${file.text.slice(at, statement.getStart(file.sf))}${SEAM}\n${printed.join('\n')}`;
      at = statement.end;
    }
    return text + file.text.slice(at);
  }

  const outputs = new Map();

  // Extracted modules.
  for (const m of manifest.modules) {
    const sources = [];
    const chunks = [];
    const views = new Set(m.views);
    const set = new ImportSet();
    for (const take of m.take) {
      if (sources.includes(take.from)) continue;
      sources.push(take.from);
      const file = fileOf(take.from);
      const bindings = importBindings(file);
      const rank = new Map([...bindings.values()].map((b, i) => [b.spec, i]));
      const statements = file.sf.statements.filter((s) => moved.get(take.from)?.get(s) === m.path);
      const skip = new Set();
      for (const statement of statements) {
        const split = ts.isClassDeclaration(statement) && views.has(statement.name?.text);
        if (split) skip.add(decorateOf(statement).body);
        chunks.push({ statement, source: take.from, text: movedText(file, statement, m.path, split) });
        if (split) views.delete(statement.name.text);
      }
      for (const [name, ref] of referencesOf(file, statements, skip)) {
        if (ref.kind === 'import') {
          const binding = bindings.get(name);
          const routed = routeImport(take.from, m.path, binding, manifest.specifiers);
          set.add(routed.spec, routed.imported, name, binding.typeOnly || !ref.value, rank.get(binding.spec));
        } else if (ref.kind === 'top') {
          const module = movedName.get(`${take.from}\0${name}`);
          if (module === m.path) continue;
          if (module) {
            requireExport(module, take.from, name);
            set.add(relSpec(m.path, stripExt(module)), name, name, !ref.value || isTypeName(take.from, name), 1000);
          } else if (!ref.value && isExported(take.from, name)) {
            set.add(relSpec(m.path, stripExt(residualPath(take.from))), name, name, true, 1000);
          } else {
            throw new Error(`${m.path}: moved code uses ${name}, which stays in ${take.from}`);
          }
        }
      }
    }
    if (views.size > 0) throw new Error(`${m.path}: views lists ${[...views].join(", ")}, not a class moved here`);
    if (m.views.length > 0) set.add(relSpec(m.path, stripExt(templateExports.get('renderNodeView'))), 'renderNodeView', 'renderNodeView', false, 2000);
    const symbols = chunks.flatMap((c) => declaredNames(c.statement));
    outputs.set(m.path, { kind: 'extracted', sources, symbols, chunks, imports: set.print() });
  }

  // Residuals: the source minus what moved, plus view registrations.
  for (const [source, map] of moved) {
    const file = fileOf(source);
    const removed = [...map.keys()].sort((a, b) => a.getFullStart() - b.getFullStart());
    let text = '';
    let at = 0;
    for (const statement of removed) {
      text += file.text.slice(at, statement.getFullStart());
      at = statement.end;
    }
    text += file.text.slice(at);
    const registrations = removed
      .filter((s) => ts.isClassDeclaration(s) && manifest.modules.find((m) => m.path === map.get(s)).views.includes(s.name.text))
      .map((s) => viewRegistration(file, s));
    if (registrations.length > 0) text = `${text.replace(/(?<!\n)\n*$/, '\n')}\n${VIEW_SEAM}\n${registrations.join('\n\n')}\n`;
    outputs.set(residualPath(source), { kind: 'residual', sources: [source], upstreamPath: source, raw: text, moved: removed });
  }

  for (const path of manifest.reroute) {
    if (moved.has(path)) throw new Error(`${path}: is a source; reroute applies to untouched files`);
    const text = rerouteImports(fileOf(path), path);
    if (text === fileOf(path).text) throw new Error(`${path}: imports nothing that moved`);
    outputs.set(path, { kind: 'rerouted', sources: [path], upstreamPath: path, text });
  }
  for (const r of manifest.rewrite) {
    const current = outputs.get(r.file)?.text ?? fileOf(r.file).text;
    const parsed = ts.createSourceFile(r.file, current, ts.ScriptTarget.Latest, true, kindOf(r.file));
    const decl = parsed.statements.find((s) => ts.isImportDeclaration(s) && s.moduleSpecifier.text === r.from);
    if (!decl) throw new Error(`${r.file}: no import from '${r.from}' to rewrite`);
    const quote = current[decl.moduleSpecifier.getStart(parsed)];
    const start = decl.getStart(parsed);
    const head = current.slice(start, decl.moduleSpecifier.getStart(parsed));
    const text = `${current.slice(0, start)}${SEAM}\n${head}${quote}${r.to}${quote}${current.slice(decl.moduleSpecifier.end)}`;
    outputs.set(r.file, { kind: 'rerouted', sources: [r.file], upstreamPath: r.file, text });
  }

  // Residual imports: kept bindings, rerouted ones, and the moved names the remainder still uses.
  for (const [path, output] of outputs) {
    if (output.kind !== 'residual') continue;
    const source = output.sources[0];
    let residual = parse(path, output.raw);
    const refs = referencesOf(residual, residual.sf.statements);
    residual = parse(path, pruneImports(residual, refs));
    residual = parse(path, rerouteImports(residual, path));
    const set = new ImportSet();
    for (const [name, ref] of refs) {
      if (ref.kind !== 'free') continue;
      const place = byName.get(name);
      if (place) {
        requireExport(place.module, place.source, name);
        set.add(relSpec(path, stripExt(place.module)), name, name, !ref.value || isTypeName(place.source, name));
      } else if (templateExports.has(name)) {
        set.add(relSpec(path, stripExt(templateExports.get(name))), name, name, !ref.value);
      }
    }
    const lines = set.print();
    // Re-export what the source exported, so every importer keeps working.
    const reexports = new Map();
    for (const name of output.moved.flatMap(declaredNames)) {
      if (!isExported(source, name)) continue;
      const module = movedName.get(`${source}\0${name}`);
      const list = reexports.get(module) ?? { values: [], types: [] };
      (isTypeName(source, name) ? list.types : list.values).push(name);
      reexports.set(module, list);
    }
    for (const [module, { values, types }] of [...reexports].sort(byPath)) {
      const spec = relSpec(path, stripExt(module));
      if (values.length) lines.push(`export { ${values.sort().join(', ')} } from '${spec}';`);
      if (types.length) lines.push(`export type { ${types.sort().join(', ')} } from '${spec}';`);
    }
    for (const spec of manifest.imports[path] ?? []) lines.push(`import '${spec}';`);
    output.text = insertAfterImports(residual, lines.length ? [SEAM, ...lines] : []);
  }

  for (const [path, output] of outputs) {
    if (output.kind !== 'extracted') continue;
    const exports = [...(needsExport.get(path) ?? [])].sort();
    const isType = (name) => isTypeDecl(output.chunks.find((c) => declaredNames(c.statement).includes(name)).statement);
    const tail = [];
    if (exports.some((n) => !isType(n))) tail.push(`export { ${exports.filter((n) => !isType(n)).join(', ')} };`);
    if (exports.some(isType)) tail.push(`export type { ${exports.filter(isType).join(', ')} };`);
    const head = output.imports.length ? `${output.imports.join('\n')}\n\n` : '';
    output.text = `${head}${output.chunks.map((c) => c.text).join('\n\n')}\n${tail.length ? `\n${tail.join('\n')}\n` : ''}`;
  }

  for (const t of templates) outputs.set(t.path, { kind: 'template', sources: [], template: t.template, text: t.text });

  const result = new Map();
  for (const [path, o] of [...outputs].sort(byPath)) {
    result.set(path, {
      text: o.text,
      kind: o.kind,
      sources: o.sources,
      ...(o.upstreamPath ? { upstreamPath: o.upstreamPath } : {}),
      ...(o.symbols ? { symbols: o.symbols } : {}),
      ...(o.template ? { template: o.template } : {}),
    });
  }
  return result;
}

function decorateOf(statement) {
  const method = statement.members.find((m) => ts.isMethodDeclaration(m) && ts.isIdentifier(m.name) && m.name.text === 'decorate');
  if (!method?.body) throw new Error(`class ${statement.name.text} has no decorate() body`);
  return method;
}

// A moved statement's text for its new module. Relative paths in `import('…')` types and calls are rebased on
// the new location; a view class's decorate() body becomes a registry call, so the class stays pure and the
// view (which only the client registers) keeps the body.
function movedText(file, statement, outPath, split) {
  const { text, offset } = chunkOf(file, statement);
  const edits = [];
  let body = null;
  if (split) {
    const method = decorateOf(statement);
    const args = method.parameters.map((p) => p.name.getText(file.sf));
    const call = args.length ? `renderNodeView(this, [${args.join(', ')}])` : 'renderNodeView(this)';
    body = [method.body.getStart(file.sf), method.body.end];
    edits.push({ start: body[0], end: body[1], text: `{\n    ${VIEW_SEAM}\n    return ${call};\n  }` });
  }
  const visit = (node) => {
    let literal = null;
    if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal)) literal = node.argument.literal;
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) literal = node.arguments[0];
    const start = literal?.getStart(file.sf);
    if (literal && isRelative(literal.text) && !(body && start >= body[0] && start < body[1])) {
      const spec = relSpec(outPath, posix.normalize(posix.join(posix.dirname(file.path), literal.text)));
      const quote = file.text[start];
      if (spec !== literal.text) edits.push({ start, end: literal.end, text: `${quote}${spec}${quote}` });
    }
    ts.forEachChild(node, visit);
  };
  visit(statement);
  let result = text;
  for (const edit of edits.sort((a, b) => b.start - a.start)) {
    result = `${result.slice(0, edit.start - offset)}${edit.text}${result.slice(edit.end - offset)}`;
  }
  return result;
}

// The view keeps decorate()'s body byte for byte, bound to the node.
function viewRegistration(file, statement) {
  const method = decorateOf(statement);
  const name = statement.name.text;
  const params = [`this: ${name}`, ...method.parameters.map((p) => p.getText(file.sf))].join(', ');
  const returns = method.type ? `: ${method.type.getText(file.sf)}` : '';
  return `registerNodeView(${name}.getType(), function decorate(${params})${returns} ${method.body.getText(file.sf)});`;
}

// Drops import bindings the remaining code no longer uses; side-effect imports stay.
function pruneImports(file, refs) {
  const used = (id) => refs.get(id.text)?.kind === 'import';
  let text = '';
  let at = 0;
  for (const statement of file.sf.statements) {
    if (!ts.isImportDeclaration(statement) || !statement.importClause) continue;
    const clause = statement.importClause;
    const ns = clause.namedBindings && ts.isNamespaceImport(clause.namedBindings) ? clause.namedBindings : null;
    const elements = clause.namedBindings && ts.isNamedImports(clause.namedBindings) ? clause.namedBindings.elements : [];
    const keepDefault = Boolean(clause.name && used(clause.name));
    const keepNs = Boolean(ns && used(ns.name));
    const keptElements = elements.filter((e) => used(e.name));
    const total = (clause.name ? 1 : 0) + (ns ? 1 : 0) + elements.length;
    if ((keepDefault ? 1 : 0) + (keepNs ? 1 : 0) + keptElements.length === total) continue;
    text += file.text.slice(at, statement.getFullStart());
    at = statement.end;
    if (!keepDefault && !keepNs && keptElements.length === 0) continue;
    const leading = file.text.slice(statement.getFullStart(), statement.getStart(file.sf));
    const parts = [keepDefault ? clause.name.text : '', keepNs ? `* as ${ns.name.text}` : '', keptElements.length ? `{ ${keptElements.map((e) => e.getText(file.sf)).join(', ')} }` : ''];
    text += `${leading}import ${clause.isTypeOnly ? 'type ' : ''}${parts.filter(Boolean).join(', ')} from ${statement.moduleSpecifier.getText(file.sf)};`;
  }
  return text + file.text.slice(at);
}

function insertAfterImports(file, lines) {
  if (lines.length === 0) return file.text;
  const imports = file.sf.statements.filter(ts.isImportDeclaration);
  const block = lines.join('\n');
  if (imports.length === 0) return `${block}\n\n${file.text}`;
  const at = imports[imports.length - 1].end;
  return `${file.text.slice(0, at)}\n${block}${file.text.slice(at)}`;
}
