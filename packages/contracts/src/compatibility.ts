import { schemaRefs, schemas } from "./schemas.js";
import {
  CONTRACT_VERSION,
  type ContractKind,
  type ContractTypes,
  validateContract,
} from "./validators.js";

type ObjectValue = Record<string, unknown>;
interface SchemaPart {
  document: string;
  node: ObjectValue;
}
interface Projection {
  closed: boolean;
  fields: ReadonlyMap<string, Projection>;
  item: Projection | undefined;
}

function isObject(value: unknown): value is ObjectValue {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function resolveReference(ref: string, document?: string): SchemaPart {
  const url = new URL(ref, document);
  const pointer = decodeURIComponent(url.hash.slice(1));
  url.hash = "";
  let node: unknown = schemas.get(url.href);
  for (const token of pointer.split("/").slice(1)) {
    const key = token.replace(/~1/gu, "/").replace(/~0/gu, "~");
    node = isObject(node) && Object.hasOwn(node, key) ? node[key] : undefined;
  }
  if (!isObject(node)) {
    throw new Error(`Unknown contract schema reference ${ref}`);
  }
  return { document: url.href, node };
}

function* schemaParts(part: SchemaPart): Generator<SchemaPart> {
  const { document, node } = part;
  yield part;
  const { $ref: ref } = node;
  if (typeof ref === "string") {
    yield* schemaParts(resolveReference(ref, document));
  }
  for (const key of ["allOf", "anyOf", "oneOf", "then", "else"]) {
    const children = node[key];
    for (const child of Array.isArray(children) ? children : [children]) {
      if (isObject(child)) {
        yield* schemaParts({ document, node: child });
      }
    }
  }
}

function compileProjection(parts: SchemaPart[]): Projection {
  const properties = new Map<string, SchemaPart[]>();
  const items: SchemaPart[] = [];
  let closed = false;
  // Include every branch so a known field in the wrong variant survives for strict validation.
  for (const part of parts.flatMap((part) => [...schemaParts(part)])) {
    const { document, node } = part;
    const { additionalProperties, items: item, properties: fields } = node;
    closed ||= additionalProperties === false;
    if (isObject(item)) {
      items.push({ document, node: item });
    }
    if (isObject(fields)) {
      for (const [key, value] of Object.entries(fields)) {
        if (isObject(value)) {
          const children = properties.get(key) ?? [];
          children.push({ document, node: value });
          properties.set(key, children);
        }
      }
    }
  }
  return {
    closed,
    fields: new Map([...properties].map(([key, children]) => [key, compileProjection(children)])),
    item: items.length > 0 ? compileProjection(items) : undefined,
  };
}

type VersionedKind = Exclude<ContractKind, "evidence_catalog">;
const projections = new Map(
  Object.entries(schemaRefs)
    .filter(([kind]) => kind !== "evidence_catalog")
    .map(([kind, ref]) => [kind, compileProjection([resolveReference(ref)])]),
);

function project(
  value: unknown,
  { closed, fields, item }: Projection,
  checkField: (key: string, value: unknown) => void,
): unknown {
  if (Array.isArray(value) && item) {
    return value.map((element: unknown) => project(element, item, checkField));
  }
  if (!isObject(value) || (!closed && fields.size === 0)) {
    return value;
  }
  const entries: [string, unknown][] = [];
  for (const [key, member] of Object.entries(value)) {
    const field = fields.get(key);
    if (field) {
      checkField(key, member);
      entries.push([key, project(member, field, checkField)]);
    } else if (!closed) {
      entries.push([key, member]);
    }
  }
  return Object.fromEntries(entries);
}

const majorPrefix = `${CONTRACT_VERSION.split(".")[0]}.`;

export function readCompatibleContract<Kind extends VersionedKind>(
  kind: Kind,
  value: unknown,
): ContractTypes[Kind] | undefined {
  const projection = projections.get(kind);
  if (!projection) {
    return undefined;
  }
  let compatible = true;
  const projected = project(value, projection, (key, member) => {
    // AJV treats undefined optional values like absent properties.
    compatible &&=
      member !== undefined &&
      (key !== "contract_version" ||
        (typeof member === "string" && member.startsWith(majorPrefix)));
  });
  return compatible && validateContract(kind, projected) ? projected : undefined;
}
