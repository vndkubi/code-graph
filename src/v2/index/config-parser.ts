import path from 'node:path';
import type { CallInfo, ImportInfo, ParseResult, SymbolInfo, TypeRefInfo } from '../../analyzers/base-analyzer.js';

type ConfigLanguage = 'xml' | 'json' | 'yaml' | 'properties';

interface ConfigParseContext {
  absPath: string;
  rootDir: string;
  relPath: string;
  moduleName: string;
  lines: string[];
  symbols: SymbolInfo[];
  seenSymbols: Set<string>;
  imports: ImportInfo[];
  calls: CallInfo[];
  typeReferences: TypeRefInfo[];
}

const XML_STATEMENT_TAGS = new Set(['select', 'insert', 'update', 'delete', 'sql', 'resultMap']);
const HTTP_METHODS = new Set(['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace']);
const MAX_CONFIG_SYMBOLS = 300;
const MAX_GENERIC_JSON_ARRAY_ITEMS = 20;

export function parseConfigFile(absPath: string, content: string, rootDir: string): ParseResult | undefined {
  const language = configLanguageFor(absPath);
  if (!language) return undefined;

  const relPath = path.relative(rootDir, absPath).replace(/\\/g, '/');
  const context: ConfigParseContext = {
    absPath,
    rootDir,
    relPath,
    moduleName: path.basename(absPath),
    lines: content.split(/\r?\n/),
    symbols: [],
    seenSymbols: new Set(),
    imports: [],
    calls: [],
    typeReferences: [],
  };

  addSymbol(context, {
    name: path.basename(absPath, path.extname(absPath)),
    kind: 'type',
    line: 1,
    endLine: Math.max(1, context.lines.length),
    signature: `${language} config file`,
    frameworkRole: `config:${language}`,
    frameworkMeta: { configLanguage: language },
  });

  try {
    switch (language) {
      case 'xml':
        parseXmlConfig(context, content);
        break;
      case 'json':
        parseJsonConfig(context, content);
        break;
      case 'yaml':
        parseYamlConfig(context);
        break;
      case 'properties':
        parsePropertiesConfig(context);
        break;
    }
  } catch {
    return {
      file: relPath,
      symbols: context.symbols,
      imports: context.imports,
      calls: context.calls,
      references: [],
      hasParseErrors: true,
      parseConfidence: 0.35,
      typeReferences: context.typeReferences,
    };
  }

  return {
    file: relPath,
    symbols: context.symbols,
    imports: context.imports,
    calls: context.calls,
    references: [],
    hasParseErrors: false,
    parseConfidence: language === 'json' ? 0.9 : 0.7,
    typeReferences: context.typeReferences,
  };
}

function configLanguageFor(absPath: string): ConfigLanguage | undefined {
  const ext = path.extname(absPath).toLowerCase();
  if (ext === '.xml') return 'xml';
  if (ext === '.json') return 'json';
  if (ext === '.yaml' || ext === '.yml') return 'yaml';
  if (ext === '.properties') return 'properties';
  return undefined;
}

function parseXmlConfig(context: ConfigParseContext, content: string): void {
  const mapperMatch = /<mapper\b[^>]*\bnamespace\s*=\s*["']([^"']+)["'][^>]*>/i.exec(content);
  const namespace = mapperMatch?.[1];
  const mapperSimple = namespace ? simpleTypeName(namespace) : undefined;
  const mapperPackage = namespace && mapperSimple ? namespace.slice(0, -mapperSimple.length).replace(/\.$/, '') : undefined;

  if (namespace && mapperSimple) {
    const line = lineOfNeedle(context.lines, namespace);
    addSymbol(context, {
      name: mapperSimple,
      kind: 'type',
      line,
      signature: `<mapper namespace="${namespace}">`,
      packageName: mapperPackage,
      frameworkRole: 'mybatis:mapper-xml',
      frameworkMeta: { namespace, configLanguage: 'xml' },
    });
    addImport(context, namespace, [mapperSimple], line);
  }

  for (const match of content.matchAll(/<([A-Za-z][\w.-]*)\b([^>]*)>/g)) {
    if (context.symbols.length >= MAX_CONFIG_SYMBOLS) break;
    const tag = match[1] ?? '';
    const attrs = parseXmlAttributes(match[2] ?? '');
    const id = attrs.get('id');
    const line = lineOfOffset(context.lines, match.index ?? 0);

    if (XML_STATEMENT_TAGS.has(tag) && id) {
      addSymbol(context, {
        name: id,
        kind: tag === 'select' || tag === 'insert' || tag === 'update' || tag === 'delete' ? 'method' : 'type',
        line,
        signature: `<${tag} id="${id}">`,
        parent: mapperSimple,
        packageName: mapperPackage,
        frameworkRole: `mybatis:${tag}`,
        frameworkMeta: {
          id,
          namespace: namespace ?? '',
          xmlTag: tag,
          parameterType: attrs.get('parameterType') ?? '',
          resultType: attrs.get('resultType') ?? attrs.get('type') ?? '',
          configLanguage: 'xml',
        },
      });
    }

    addXmlTypeRef(context, attrs.get('parameterType'), 'parameter', line);
    addXmlTypeRef(context, attrs.get('resultType') ?? attrs.get('type'), 'return', line);

    const refid = attrs.get('refid');
    if (refid && mapperSimple) {
      context.calls.push({
        caller: mapperSimple,
        callee: refid.includes('.') ? refid : `${mapperSimple}.${refid}`,
        file: context.relPath,
        line,
      });
    }

    if (!XML_STATEMENT_TAGS.has(tag)) {
      addGenericXmlAttributeSymbols(context, tag, attrs, line);
    }
  }

  for (const match of content.matchAll(/<([A-Za-z][\w.-]*)\b[^>]*>([^<]{1,160})<\/\1>/g)) {
    if (context.symbols.length >= MAX_CONFIG_SYMBOLS) break;
    const tag = match[1] ?? '';
    const value = (match[2] ?? '').trim();
    if (!value || value.length > 120) continue;
    const line = lineOfOffset(context.lines, match.index ?? 0);
    if (!mapperSimple) {
      addSymbol(context, {
        name: `${tag}:${value}`,
        kind: 'field',
        line,
        signature: `<${tag}>${value}</${tag}>`,
        frameworkRole: 'config:xml-value',
        frameworkMeta: { tag, value, configLanguage: 'xml' },
      });
    }
  }
}

function parseJsonConfig(context: ConfigParseContext, content: string): void {
  const parsed = JSON.parse(content) as unknown;
  const symbolsBeforeSemantic = context.symbols.length;
  parseOpenApiJson(context, parsed);
  parsePostmanCollection(context, parsed);
  parseElasticRestApiSpecJson(context, parsed);
  const hasSemanticSymbols = context.symbols.length > symbolsBeforeSemantic;
  if (!hasSemanticSymbols) {
    walkJsonValue(context, parsed, [], 0);
  }
}

function walkJsonValue(context: ConfigParseContext, value: unknown, pathParts: string[], depth: number): void {
  if (context.symbols.length >= MAX_CONFIG_SYMBOLS || depth > 8) return;
  if (Array.isArray(value)) {
    for (const item of value.slice(0, MAX_GENERIC_JSON_ARRAY_ITEMS)) {
      walkJsonValue(context, item, pathParts, depth + 1);
      if (context.symbols.length >= MAX_CONFIG_SYMBOLS) break;
    }
    return;
  }
  if (!value || typeof value !== 'object') return;

  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (context.symbols.length >= MAX_CONFIG_SYMBOLS) break;
    const nextPath = [...pathParts, key];
    const name = nextPath.join('.');
    const line = lineOfNeedle(context.lines, `"${key}"`);
    addSymbol(context, {
      name,
      kind: 'field',
      line,
      signature: jsonSignature(name, child),
      frameworkRole: 'config:json-key',
      frameworkMeta: { keyPath: name, configLanguage: 'json' },
    });
    walkJsonValue(context, child, nextPath, depth + 1);
  }
}

function parseYamlConfig(context: ConfigParseContext): void {
  parseElasticYamlRestTest(context);

  const stack: Array<{ indent: number; key: string }> = [];
  context.lines.forEach((sourceLine, index) => {
    if (context.symbols.length >= MAX_CONFIG_SYMBOLS) return;
    const withoutComment = sourceLine.replace(/\s+#.*$/, '');
    const match = /^(\s*)([A-Za-z0-9_.-]+)\s*:\s*(.*)$/.exec(withoutComment);
    if (!match) return;

    const indent = match[1]?.length ?? 0;
    const key = match[2] ?? '';
    const rawValue = (match[3] ?? '').trim();
    while (stack.length > 0 && stack[stack.length - 1]!.indent >= indent) stack.pop();
    stack.push({ indent, key });
    const keyPath = stack.map(item => item.key).join('.');
    const frameworkRole = yamlFrameworkRole(keyPath);
    addSymbol(context, {
      name: keyPath,
      kind: 'field',
      line: index + 1,
      signature: rawValue ? `${keyPath}: ${truncate(rawValue, 120)}` : `${keyPath}:`,
      frameworkRole,
      frameworkMeta: { keyPath, value: rawValue, configLanguage: 'yaml' },
    });
  });
}

function parsePropertiesConfig(context: ConfigParseContext): void {
  context.lines.forEach((sourceLine, index) => {
    if (context.symbols.length >= MAX_CONFIG_SYMBOLS) return;
    const line = sourceLine.trim();
    if (!line || line.startsWith('#') || line.startsWith('!')) return;
    const match = /^([^:=\s]+)\s*[:=]\s*(.*)$/.exec(line);
    if (!match) return;
    const key = match[1] ?? '';
    const value = match[2] ?? '';
    addSymbol(context, {
      name: key,
      kind: 'field',
      line: index + 1,
      signature: `${key}=${truncate(value, 120)}`,
      frameworkRole: 'config:properties-key',
      frameworkMeta: { keyPath: key, configLanguage: 'properties' },
    });
  });
}

function parseOpenApiJson(context: ConfigParseContext, value: unknown): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const paths = (value as Record<string, unknown>).paths;
  if (!paths || typeof paths !== 'object' || Array.isArray(paths)) return;

  for (const [routePath, routeValue] of Object.entries(paths as Record<string, unknown>)) {
    if (!routeValue || typeof routeValue !== 'object' || Array.isArray(routeValue)) continue;
    for (const [method, operation] of Object.entries(routeValue as Record<string, unknown>)) {
      const lowerMethod = method.toLowerCase();
      if (!HTTP_METHODS.has(lowerMethod)) continue;
      const operationObj = operation && typeof operation === 'object' && !Array.isArray(operation)
        ? operation as Record<string, unknown>
        : {};
      const operationId = typeof operationObj.operationId === 'string' ? operationObj.operationId : '';
      const line = lineOfNeedle(context.lines, routePath);
      addSymbol(context, {
        name: operationId || `${lowerMethod.toUpperCase()} ${routePath}`,
        kind: 'method',
        line,
        signature: `${lowerMethod.toUpperCase()} ${routePath}${operationId ? ` (${operationId})` : ''}`,
        parent: path.basename(context.absPath, path.extname(context.absPath)),
        frameworkRole: 'openapi:endpoint',
        frameworkMeta: {
          httpMethod: lowerMethod.toUpperCase(),
          path: routePath,
          operationId,
          configLanguage: 'json',
        },
      });
    }
  }
}

function parsePostmanCollection(context: ConfigParseContext, value: unknown): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const root = value as Record<string, unknown>;
  if (!Array.isArray(root.item)) return;
  walkPostmanItems(context, root.item, []);
}

function walkPostmanItems(context: ConfigParseContext, items: unknown[], parents: string[]): void {
  for (const item of items) {
    if (context.symbols.length >= MAX_CONFIG_SYMBOLS) break;
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const objectItem = item as Record<string, unknown>;
    const name = typeof objectItem.name === 'string' ? objectItem.name : 'request';
    if (Array.isArray(objectItem.item)) {
      walkPostmanItems(context, objectItem.item, [...parents, name]);
      continue;
    }
    const request = objectItem.request;
    if (!request || typeof request !== 'object' || Array.isArray(request)) continue;
    const requestObj = request as Record<string, unknown>;
    const method = typeof requestObj.method === 'string' ? requestObj.method.toUpperCase() : 'GET';
    const routePath = postmanRequestPath(requestObj.url);
    if (!routePath) continue;
    const line = lineOfNeedle(context.lines, name);
    const displayName = [...parents, name].join(' / ');
    addSymbol(context, {
      name: displayName || `${method} ${routePath}`,
      kind: 'method',
      line,
      signature: `${method} ${routePath}${displayName ? ` (${displayName})` : ''}`,
      parent: path.basename(context.absPath, path.extname(context.absPath)),
      frameworkRole: 'postman:request',
      frameworkMeta: {
        httpMethod: method,
        path: routePath,
        requestName: displayName,
        configLanguage: 'json',
      },
    });
  }
}

function parseElasticRestApiSpecJson(context: ConfigParseContext, value: unknown): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const root = value as Record<string, unknown>;
  const entries = Object.entries(root);
  if (entries.length !== 1) return;
  const [apiName, apiValue] = entries[0]!;
  if (!apiValue || typeof apiValue !== 'object' || Array.isArray(apiValue)) return;
  const api = apiValue as Record<string, unknown>;
  const url = api.url;
  const paths = url && typeof url === 'object' && !Array.isArray(url)
    ? (url as Record<string, unknown>).paths
    : undefined;
  if (!Array.isArray(paths)) return;

  const parent = path.basename(context.absPath, path.extname(context.absPath));
  for (const route of paths) {
    if (context.symbols.length >= MAX_CONFIG_SYMBOLS) break;
    if (!route || typeof route !== 'object' || Array.isArray(route)) continue;
    const routeObj = route as Record<string, unknown>;
    const routePath = typeof routeObj.path === 'string' ? routeObj.path : '';
    const methods = Array.isArray(routeObj.methods)
      ? routeObj.methods.map(method => String(method).toUpperCase()).filter(method => HTTP_METHODS.has(method.toLowerCase()))
      : [];
    if (!routePath || methods.length === 0) continue;
    const line = lineOfNeedle(context.lines, routePath);
    for (const method of methods) {
      addSymbol(context, {
        name: `${apiName} ${method} ${routePath}`,
        kind: 'method',
        line,
        signature: `${method} ${routePath} (${apiName})`,
        parent,
        frameworkRole: 'elastic-rest:endpoint',
        frameworkMeta: {
          apiName,
          httpMethod: method,
          path: routePath,
          configLanguage: 'json',
        },
      });
    }
  }

  addElasticObjectFieldSymbols(context, apiName, api.params, 'elastic-rest:param');
  const headers = api.headers;
  if (headers && typeof headers === 'object' && !Array.isArray(headers)) {
    for (const [headerName, headerValue] of Object.entries(headers as Record<string, unknown>)) {
      if (context.symbols.length >= MAX_CONFIG_SYMBOLS) break;
      const values = Array.isArray(headerValue) ? headerValue.map(item => String(item)) : [String(headerValue)];
      const line = lineOfNeedle(context.lines, headerName);
      addSymbol(context, {
        name: `${apiName}.${headerName}`,
        kind: 'field',
        line,
        signature: `${headerName}: ${values.join(', ')}`,
        parent: apiName,
        frameworkRole: 'elastic-rest:header',
        frameworkMeta: {
          apiName,
          headerName,
          values: values.join(','),
          configLanguage: 'json',
        },
      });
    }
  }
}

function addElasticObjectFieldSymbols(
  context: ConfigParseContext,
  apiName: string,
  value: unknown,
  frameworkRole: string,
): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (context.symbols.length >= MAX_CONFIG_SYMBOLS) break;
    const childObj = child && typeof child === 'object' && !Array.isArray(child)
      ? child as Record<string, unknown>
      : {};
    const line = lineOfNeedle(context.lines, key);
    const type = typeof childObj.type === 'string' ? childObj.type : '';
    const options = Array.isArray(childObj.options) ? childObj.options.map(item => String(item)) : [];
    const description = typeof childObj.description === 'string' ? childObj.description : '';
    addSymbol(context, {
      name: `${apiName}.${key}`,
      kind: 'field',
      line,
      signature: [
        key,
        type ? `type=${type}` : '',
        options.length > 0 ? `options=${options.join('|')}` : '',
        description ? truncate(description, 120) : '',
      ].filter(Boolean).join(' '),
      parent: apiName,
      frameworkRole,
      frameworkMeta: {
        apiName,
        key,
        type,
        options: options.join('|'),
        configLanguage: 'json',
      },
    });
  }
}

function parseElasticYamlRestTest(context: ConfigParseContext): void {
  if (!context.relPath.includes('/rest-api-spec/test/')) return;
  let activeApi = '';
  let activeApiIndent = -1;
  for (let i = 0; i < context.lines.length; i++) {
    if (context.symbols.length >= MAX_CONFIG_SYMBOLS) break;
    const line = context.lines[i]!;
    const indent = line.match(/^\s*/)?.[0].length ?? 0;
    if (activeApi && line.trim().startsWith('- ') && indent <= activeApiIndent) {
      activeApi = '';
      activeApiIndent = -1;
    }

    const testMatch = /^(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9][^:]*))\s*:\s*$/.exec(line);
    if (testMatch) {
      const testName = (testMatch[1] ?? testMatch[2] ?? testMatch[3])?.trim();
      if (testName && !testName.startsWith('-')) {
        addSymbol(context, {
          name: testName,
          kind: 'type',
          line: i + 1,
          signature: `YAML REST test: ${testName}`,
          frameworkRole: 'elastic-rest:yaml-test',
          frameworkMeta: { testName, configLanguage: 'yaml' },
        });
      }
    }

    const doMatch = /^\s{4,}([A-Za-z0-9_.-]+)\s*:\s*(?:\{\})?\s*$/.exec(line);
    if (doMatch && previousNonEmptyLineIncludes(context.lines, i, '- do:')) {
      activeApi = doMatch[1] ?? '';
      activeApiIndent = indent;
      addSymbol(context, {
        name: activeApi,
        kind: 'method',
        line: i + 1,
        signature: `do: ${activeApi}`,
        frameworkRole: 'elastic-rest:yaml-do',
        frameworkMeta: { apiName: activeApi, configLanguage: 'yaml' },
      });
      continue;
    }

    const paramMatch = /^\s{6,}([A-Za-z0-9_.-]+)\s*:\s*(.+)$/.exec(line);
    if (activeApi && paramMatch && indent > activeApiIndent) {
      const paramName = paramMatch[1] ?? '';
      const rawValue = (paramMatch[2] ?? '').trim();
      if (paramName && !['body', 'settings', 'mappings'].includes(paramName)) {
        addSymbol(context, {
          name: `${activeApi}.${paramName}`,
          kind: 'field',
          line: i + 1,
          signature: `${activeApi}.${paramName}: ${truncate(rawValue, 120)}`,
          parent: activeApi,
          frameworkRole: 'elastic-rest:yaml-param',
          frameworkMeta: {
            apiName: activeApi,
            key: paramName,
            value: rawValue,
            configLanguage: 'yaml',
          },
        });
      }
    }
  }
}

function previousNonEmptyLineIncludes(lines: string[], startIndex: number, needle: string): boolean {
  for (let i = startIndex - 1; i >= 0 && i >= startIndex - 4; i--) {
    const line = lines[i]?.trim();
    if (!line) continue;
    return line.includes(needle);
  }
  return false;
}

function postmanRequestPath(value: unknown): string {
  if (typeof value === 'string') {
    try {
      const parsed = new URL(value);
      return parsed.pathname || '/';
    } catch {
      return value.startsWith('/') ? value : `/${value}`;
    }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return '';
  const obj = value as Record<string, unknown>;
  if (Array.isArray(obj.path)) {
    return `/${obj.path.map(segment => String(segment)).join('/')}`.replace(/\/+/g, '/');
  }
  if (typeof obj.raw === 'string') return postmanRequestPath(obj.raw);
  return '';
}

function yamlFrameworkRole(keyPath: string): string {
  if (/^services\.[^.]+$/.test(keyPath)) return 'docker:service';
  if (/^services\.[^.]+\.image$/.test(keyPath)) return 'docker:image';
  if (/^services\.[^.]+\.ports$/.test(keyPath)) return 'docker:ports';
  if (keyPath === 'server.port') return 'spring:server-port';
  if (keyPath.startsWith('spring.datasource.')) return 'spring:datasource';
  if (keyPath.startsWith('spring.redis.') || keyPath.startsWith('redis.')) return 'spring:redis';
  if (keyPath.startsWith('spring.elasticsearch.') || keyPath.startsWith('elasticsearch.')) return 'spring:elasticsearch';
  if (keyPath.startsWith('management.endpoints.')) return 'spring:actuator';
  return 'config:yaml-key';
}

function addGenericXmlAttributeSymbols(
  context: ConfigParseContext,
  tag: string,
  attrs: Map<string, string>,
  line: number,
): void {
  for (const attr of ['id', 'name', 'key', 'path', 'url', 'ref', 'bean', 'class']) {
    const value = attrs.get(attr);
    if (!value) continue;
    addSymbol(context, {
      name: `${tag}.${attr}:${value}`,
      kind: 'field',
      line,
      signature: `<${tag} ${attr}="${value}">`,
      frameworkRole: 'config:xml-attribute',
      frameworkMeta: { tag, attr, value, configLanguage: 'xml' },
    });
  }
}

function addXmlTypeRef(
  context: ConfigParseContext,
  typeName: string | undefined,
  refContext: TypeRefInfo['context'],
  line: number,
): void {
  if (!typeName || isPrimitiveOrJdkType(typeName)) return;
  const simple = simpleTypeName(typeName);
  context.typeReferences.push({
    file: context.relPath,
    referencedType: simple,
    context: refContext,
    line,
  });
  addImport(context, typeName, [simple], line);
}

function addSymbol(
  context: ConfigParseContext,
  input: Partial<SymbolInfo> & Pick<SymbolInfo, 'name' | 'kind' | 'line' | 'signature'>,
): void {
  if (context.symbols.length >= MAX_CONFIG_SYMBOLS) return;
  const line = Math.max(1, input.line);
  const key = [
    input.packageName ?? '',
    input.parent ?? '',
    input.name,
    input.kind,
    line,
  ].join('\0');
  if (context.seenSymbols.has(key)) return;
  context.seenSymbols.add(key);
  context.symbols.push({
    name: input.name,
    kind: input.kind,
    file: context.relPath,
    line,
    column: input.column ?? 0,
    endLine: Math.max(line, input.endLine ?? line),
    signature: input.signature,
    visibility: input.visibility ?? 'public',
    module: context.moduleName,
    parent: input.parent,
    packageName: input.packageName,
    returnType: input.returnType,
    parameterTypes: input.parameterTypes,
    annotations: input.annotations ?? [],
    frameworkRole: input.frameworkRole,
    frameworkMeta: input.frameworkMeta,
  });
}

function addImport(context: ConfigParseContext, source: string, symbols: string[], line: number): void {
  context.imports.push({
    source,
    symbols,
    file: context.relPath,
    line,
    isExternal: isPrimitiveOrJdkType(source),
  });
}

function parseXmlAttributes(value: string): Map<string, string> {
  const attrs = new Map<string, string>();
  for (const match of value.matchAll(/([A-Za-z_:][\w:.-]*)\s*=\s*["']([^"']*)["']/g)) {
    const key = match[1];
    const attrValue = match[2];
    if (key && attrValue !== undefined) attrs.set(key, attrValue);
  }
  return attrs;
}

function lineOfNeedle(lines: string[], needle: string): number {
  const lowerNeedle = needle.toLowerCase();
  const index = lines.findIndex(line => line.toLowerCase().includes(lowerNeedle));
  return index >= 0 ? index + 1 : 1;
}

function lineOfOffset(lines: string[], offset: number): number {
  let cursor = 0;
  for (let i = 0; i < lines.length; i++) {
    cursor += lines[i]!.length + 1;
    if (cursor > offset) return i + 1;
  }
  return Math.max(1, lines.length);
}

function simpleTypeName(typeName: string): string {
  const withoutGenerics = typeName.replace(/<.*>$/, '');
  const parts = withoutGenerics.split('.').filter(Boolean);
  return parts[parts.length - 1] ?? withoutGenerics;
}

function isPrimitiveOrJdkType(typeName: string): boolean {
  return /^(byte|short|int|long|float|double|boolean|char|void|string)$/i.test(typeName)
    || /^(java|javax|jakarta)\./.test(typeName);
}

function jsonSignature(keyPath: string, value: unknown): string {
  if (value === null) return `${keyPath}: null`;
  if (typeof value === 'string') return `${keyPath}: "${truncate(value, 120)}"`;
  if (typeof value === 'number' || typeof value === 'boolean') return `${keyPath}: ${String(value)}`;
  if (Array.isArray(value)) return `${keyPath}: array(${value.length})`;
  return `${keyPath}: object`;
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 3)}...`;
}
