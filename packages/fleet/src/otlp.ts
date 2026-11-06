import { z } from "zod";

export const MAX_OTLP_BYTES = 16 * 1024 * 1024;
export const MAX_VALUE_CHARS = 256;
export const DROPPED_EVENTS = new Set(["codex.sse_event"]);
export const DROPPED_KEYS = new Set([
  "prompt",
  "arguments",
  "output",
  "tool_parameters",
  "tool_input",
  "user.email",
  "user.account_uuid",
]);

export type AnyValue = {
  stringValue?: string | undefined;
  boolValue?: boolean | undefined;
  intValue?: string | number | undefined;
  doubleValue?: string | number | undefined;
  bytesValue?: string | undefined;
  arrayValue?: { values?: AnyValue[] | undefined } | undefined;
  kvlistValue?: { values?: KeyValue[] | undefined } | undefined;
};
export type KeyValue = { key: string; value?: AnyValue | undefined };

const Int = z.union([z.string().regex(/^-?[0-9]+$/), z.number().int()]);
const Num = z.union([z.number(), z.string()]);

export const AnyValue: z.ZodType<AnyValue> = z.lazy(() =>
  z.object({
    stringValue: z.string().optional(),
    boolValue: z.boolean().optional(),
    intValue: Int.optional(),
    doubleValue: Num.optional(),
    bytesValue: z.string().optional(),
    arrayValue: z.object({ values: z.array(AnyValue).optional() }).optional(),
    kvlistValue: z.object({ values: z.array(KeyValue).optional() }).optional(),
  }),
);
export const KeyValue: z.ZodType<KeyValue> = z.lazy(() =>
  z.object({ key: z.string(), value: AnyValue.optional() }),
);

const Attributes = z.array(KeyValue).optional();
const Resource = z.object({ attributes: Attributes }).optional();
const Scope = z
  .object({
    name: z.string().optional(),
    version: z.string().optional(),
    attributes: Attributes,
  })
  .optional();

const LogRecord = z.object({
  timeUnixNano: Int.optional(),
  observedTimeUnixNano: Int.optional(),
  severityNumber: z.number().int().optional(),
  severityText: z.string().optional(),
  body: AnyValue.optional(),
  attributes: Attributes,
  traceId: z.string().optional(),
  spanId: z.string().optional(),
  flags: z.number().int().optional(),
  eventName: z.string().optional(),
});

export const LogsRequest = z.object({
  resourceLogs: z
    .array(
      z.object({
        resource: Resource,
        schemaUrl: z.string().optional(),
        scopeLogs: z
          .array(
            z.object({
              scope: Scope,
              schemaUrl: z.string().optional(),
              logRecords: z.array(LogRecord).optional(),
            }),
          )
          .optional(),
      }),
    )
    .optional(),
});
export type LogsRequest = z.infer<typeof LogsRequest>;

const NumberPoint = z.object({
  attributes: Attributes,
  startTimeUnixNano: Int.optional(),
  timeUnixNano: Int.optional(),
  asDouble: Num.optional(),
  asInt: Int.optional(),
  flags: z.number().int().optional(),
});

const HistogramPoint = z.object({
  attributes: Attributes,
  startTimeUnixNano: Int.optional(),
  timeUnixNano: Int.optional(),
  count: Int.optional(),
  sum: Num.optional(),
  bucketCounts: z.array(Int).optional(),
  explicitBounds: z.array(Num).optional(),
  min: Num.optional(),
  max: Num.optional(),
  flags: z.number().int().optional(),
});

const Metric = z.object({
  name: z.string(),
  description: z.string().optional(),
  unit: z.string().optional(),
  sum: z
    .object({
      dataPoints: z.array(NumberPoint).optional(),
      aggregationTemporality: z.number().int().optional(),
      isMonotonic: z.boolean().optional(),
    })
    .optional(),
  gauge: z.object({ dataPoints: z.array(NumberPoint).optional() }).optional(),
  histogram: z
    .object({
      dataPoints: z.array(HistogramPoint).optional(),
      aggregationTemporality: z.number().int().optional(),
    })
    .optional(),
});

export const MetricsRequest = z.object({
  resourceMetrics: z
    .array(
      z.object({
        resource: Resource,
        schemaUrl: z.string().optional(),
        scopeMetrics: z
          .array(
            z.object({
              scope: Scope,
              schemaUrl: z.string().optional(),
              metrics: z.array(Metric).optional(),
            }),
          )
          .optional(),
      }),
    )
    .optional(),
});
export type MetricsRequest = z.infer<typeof MetricsRequest>;

export type Dropped = Record<string, number>;

const bump = (dropped: Dropped, reason: string, n = 1) => {
  dropped[reason] = (dropped[reason] ?? 0) + n;
};

export function valueText(value: AnyValue | undefined): string {
  if (!value) return "";
  if (value.stringValue !== undefined) return value.stringValue;
  if (value.boolValue !== undefined) return String(value.boolValue);
  if (value.intValue !== undefined) return String(value.intValue);
  if (value.doubleValue !== undefined) return String(value.doubleValue);
  if (value.bytesValue !== undefined) return value.bytesValue;
  if (value.arrayValue) return JSON.stringify((value.arrayValue.values ?? []).map(valueText));
  if (value.kvlistValue)
    return JSON.stringify(
      Object.fromEntries(
        (value.kvlistValue.values ?? []).map((kv) => [kv.key, valueText(kv.value)]),
      ),
    );
  return "";
}

function cleanAttributes(attributes: KeyValue[] | undefined, dropped: Dropped) {
  const kept: KeyValue[] = [];
  for (const kv of attributes ?? []) {
    if (DROPPED_KEYS.has(kv.key)) {
      bump(dropped, `attribute:${kv.key}`);
      continue;
    }
    if (kv.value?.bytesValue !== undefined) {
      bump(dropped, "attribute:bytes");
      continue;
    }
    const text = valueText(kv.value);
    if (text.length > MAX_VALUE_CHARS || kv.value?.arrayValue || kv.value?.kvlistValue) {
      bump(dropped, text.length > MAX_VALUE_CHARS ? "attribute:long" : "attribute:nested");
      kept.push({ key: `${kv.key}.length`, value: { intValue: String(text.length) } });
      continue;
    }
    kept.push(kv);
  }
  return kept;
}

export const attribute = (attributes: KeyValue[] | undefined, key: string) =>
  attributes?.find((kv) => kv.key === key)?.value;

export const eventNameOf = (record: {
  eventName?: string | undefined;
  attributes?: KeyValue[] | undefined;
}) => record.eventName || valueText(attribute(record.attributes, "event.name"));

export function stripLogs(request: LogsRequest) {
  const dropped: Dropped = {};
  let kept = 0;
  const resourceLogs = (request.resourceLogs ?? []).map((rl) => ({
    resource: { attributes: cleanAttributes(rl.resource?.attributes, dropped) },
    ...(rl.schemaUrl ? { schemaUrl: rl.schemaUrl } : {}),
    scopeLogs: (rl.scopeLogs ?? []).map((sl) => ({
      scope: {
        ...(sl.scope?.name ? { name: sl.scope.name } : {}),
        ...(sl.scope?.version ? { version: sl.scope.version } : {}),
        attributes: cleanAttributes(sl.scope?.attributes, dropped),
      },
      ...(sl.schemaUrl ? { schemaUrl: sl.schemaUrl } : {}),
      logRecords: (sl.logRecords ?? []).flatMap((record) => {
        const name = eventNameOf(record);
        if (DROPPED_EVENTS.has(name)) {
          bump(dropped, `event:${name}`);
          return [];
        }
        const { body, ...rest } = record;
        const sameAsName = body?.stringValue !== undefined && body.stringValue === name;
        if (body && !sameAsName) bump(dropped, "body");
        kept++;
        return [
          {
            ...rest,
            ...(sameAsName ? { body: { stringValue: name } } : {}),
            attributes: cleanAttributes(record.attributes, dropped),
          },
        ];
      }),
    })),
  }));
  return { request: { resourceLogs } satisfies LogsRequest, kept, dropped };
}

export function stripMetrics(raw: unknown, request: MetricsRequest) {
  const dropped: Dropped = {};
  let kept = 0;
  const rawMetrics = (raw as { resourceMetrics?: { scopeMetrics?: { metrics?: object[] }[] }[] })
    ?.resourceMetrics;
  for (const rm of rawMetrics ?? [])
    for (const sm of rm?.scopeMetrics ?? [])
      for (const m of sm?.metrics ?? []) {
        if ("exponentialHistogram" in m) bump(dropped, "metric:exponentialHistogram");
        if ("summary" in m) bump(dropped, "metric:summary");
      }
  const points = <T extends { attributes?: KeyValue[] | undefined }>(list: T[] | undefined) =>
    (list ?? []).map((p) => {
      kept++;
      return { ...p, attributes: cleanAttributes(p.attributes, dropped) };
    });
  const resourceMetrics = (request.resourceMetrics ?? []).map((rm) => ({
    resource: { attributes: cleanAttributes(rm.resource?.attributes, dropped) },
    ...(rm.schemaUrl ? { schemaUrl: rm.schemaUrl } : {}),
    scopeMetrics: (rm.scopeMetrics ?? []).map((sm) => ({
      scope: {
        ...(sm.scope?.name ? { name: sm.scope.name } : {}),
        ...(sm.scope?.version ? { version: sm.scope.version } : {}),
        attributes: cleanAttributes(sm.scope?.attributes, dropped),
      },
      ...(sm.schemaUrl ? { schemaUrl: sm.schemaUrl } : {}),
      metrics: (sm.metrics ?? []).flatMap((m) => {
        const kinds = [
          m.sum && { sum: { ...m.sum, dataPoints: points(m.sum.dataPoints) } },
          m.gauge && { gauge: { dataPoints: points(m.gauge.dataPoints) } },
          m.histogram && {
            histogram: { ...m.histogram, dataPoints: points(m.histogram.dataPoints) },
          },
        ].filter(Boolean);
        if (!kinds.length) return [];
        return [
          {
            name: m.name,
            ...(m.description ? { description: m.description } : {}),
            ...(m.unit ? { unit: m.unit } : {}),
            ...Object.assign({}, ...kinds),
          },
        ];
      }),
    })),
  }));
  return { request: { resourceMetrics } satisfies MetricsRequest, kept, dropped };
}
