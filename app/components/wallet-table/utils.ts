/**
 * Returns the unique values extracted from the provided rows.
 *
 * - When `returns` is omitted, the function gathers all truthy string values for `key`.
 * - When `returns` is provided, it creates objects containing only the requested fields while
 *   preserving the first occurrence that has data for those fields. Subsequent rows only replace
 *   the stored record if they provide a previously missing field value.
 */
const uniq = <TData>(rows: TData[], key: string, returns?: string[]) => {
  const isNonEmptyString = (value: unknown): value is string => {
    return typeof value === "string" && value.trim().length > 0;
  };

  if (!returns) {
    const values = new Set<string>();

    rows.forEach((row) => {
      const value = (row as Record<string, unknown>)[key];
      if (isNonEmptyString(value)) {
        values.add(value);
      }
    });

    return Array.from(values);
  }

  const records = new Map<string, Record<string, unknown>>();

  rows.forEach((row) => {
    const record = row as Record<string, unknown>;
    const value = record[key];

    if (!isNonEmptyString(value)) {
      return;
    }

    const next = returns.reduce<Record<string, unknown>>((acc, field) => {
      acc[field] = record[field];
      return acc;
    }, {});

    const current = records.get(value);
    if (!current) {
      records.set(value, next);
      return;
    }

    const shouldReplace = returns.some((field) => current[field] == null && next[field] != null);
    if (shouldReplace) {
      records.set(value, next);
    }
  });

  return Array.from(records.values());
};

const emptyPixel = "data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=";

export { uniq, emptyPixel };
