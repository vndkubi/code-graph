import { estimateTokensSaved } from "../token-estimator.js";

export interface SpringContextBean {
  name: string;
  type: string;
  dependencies: string[];
}

export interface SpringContextAssembly {
  beanCount: number;
  entryPoints: SpringContextBean[];
  securityChain: SpringContextBean[];
  services: SpringContextBean[];
  dataLayer: SpringContextBean[];
  messaging: SpringContextBean[];
  transactionBoundaries: SpringContextBean[];
  originalChars: number;
  assembledChars: number;
  estimatedTokensSaved: number;
}

export function assembleSpringContext(input: string): SpringContextAssembly {
  const normalized = input.replace(/\r\n/g, "\n");
  const beans = extractBeans(normalized);
  const assemblyBase = {
    beanCount: beans.length,
    entryPoints: selectBeans(beans, /Controller|Resource|Endpoint|Handler|RouterFunction|Servlet|RestTemplate|WebClient/i),
    securityChain: selectBeans(beans, /Security|SecurityFilterChain|Authentication|Authorization|Jwt|OAuth|FilterChain/i),
    services: selectBeans(beans, /Service|Facade|Manager|Processor|Workflow|UseCase|Client/i),
    dataLayer: selectBeans(beans, /Repository|DataSource|EntityManager|Jdbc|Jpa|Hibernate|Mongo|Redis|Cache/i),
    messaging: selectBeans(beans, /Jms|JMS|Kafka|Rabbit|Queue|Topic|Listener|Message/i),
    transactionBoundaries: selectBeans(beans, /Transaction|Transactional|PlatformTransactionManager|TransactionTemplate/i)
  };
  const compact = JSON.stringify(assemblyBase);
  return {
    ...assemblyBase,
    originalChars: normalized.length,
    assembledChars: compact.length,
    estimatedTokensSaved: estimateTokensSaved(normalized.length, compact.length, { kind: "json" })
  };
}

function extractBeans(input: string): SpringContextBean[] {
  const parsed = tryParseJson(input);
  if (parsed !== undefined) {
    return extractBeansFromJson(parsed);
  }
  return extractBeansFromText(input);
}

function extractBeansFromJson(value: unknown): SpringContextBean[] {
  const beans: SpringContextBean[] = [];
  const contexts = getRecord(value)?.contexts;
  if (isRecord(contexts)) {
    for (const contextValue of Object.values(contexts)) {
      beans.push(...extractBeansFromJson(contextValue));
    }
    return dedupeBeans(beans);
  }
  const beanRecord = getRecord(value)?.beans;
  if (!isRecord(beanRecord)) {
    return [];
  }
  for (const [name, raw] of Object.entries(beanRecord)) {
    const record = getRecord(raw) ?? {};
    const type = stringValue(record.type) ?? stringValue(record.className) ?? stringValue(record.resource) ?? name;
    const dependencies = arrayStringValue(record.dependencies) ?? arrayStringValue(record.dependencyNames) ?? [];
    beans.push({
      name,
      type,
      dependencies: dependencies.slice(0, 12)
    });
  }
  return dedupeBeans(beans);
}

function extractBeansFromText(text: string): SpringContextBean[] {
  const beans: SpringContextBean[] = [];
  for (const match of text.matchAll(/\b([a-zA-Z0-9_.-]*(?:Controller|Service|Repository|Security|Jms|Kafka|Transaction|Endpoint|Handler)[a-zA-Z0-9_.-]*)\b/g)) {
    const type = match[1]!;
    beans.push({
      name: type.split(".").pop() ?? type,
      type,
      dependencies: []
    });
  }
  return dedupeBeans(beans);
}

function selectBeans(beans: SpringContextBean[], pattern: RegExp): SpringContextBean[] {
  return beans
    .filter((bean) => pattern.test(`${bean.name}\n${bean.type}\n${bean.dependencies.join("\n")}`))
    .slice(0, 24);
}

function dedupeBeans(beans: SpringContextBean[]): SpringContextBean[] {
  const seen = new Set<string>();
  const result: SpringContextBean[] = [];
  for (const bean of beans) {
    const key = `${bean.name}|${bean.type}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(bean);
  }
  return result;
}

function tryParseJson(input: string): unknown | undefined {
  try {
    return JSON.parse(input) as unknown;
  } catch {
    return undefined;
  }
}

function getRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function arrayStringValue(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  return value.filter((item): item is string => typeof item === "string" && item.length > 0);
}
