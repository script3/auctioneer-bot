function replacer(_: any, value: any): any {
  if (typeof value === 'bigint') {
    return { type: 'bigint', value: value.toString() };
  }
  if (value instanceof Map) {
    return {
      type: 'map',
      value: Object.fromEntries(Array.from(value.entries(), ([k, v]) => [k, replacer(_, v)])),
    };
  }
  return value;
}

function reviver(_: any, value: any): any {
  if (typeof value === 'object' && value !== null) {
    if (value.type === 'bigint') {
      return BigInt(value.value);
    }
    if (value.type === 'map') {
      return new Map(
        Object.entries(value.value).map(([k, v]) => [
          k !== '' && Number.isSafeInteger(Number(k)) ? Number(k) : k,
          reviver(_, v),
        ])
      );
    }
  }
  return value;
}

/**
 * Safe stringify function that can handle BigInt and Map objects.
 * @param value - The object to stringify
 * @param space - The space parameter for JSON.stringify
 * @returns A json string representation of the object
 */
export function stringify(value: any, space?: string | number): string {
  return JSON.stringify(value, replacer, space);
}

/**
 * Safe parse function that can handle BigInt and Map objects.
 * @param jsonString - The json string to parse (created by the safe stringify function)
 * @returns The object represented by the json string, typecast to T
 */
export function parse<T>(jsonString: string): T {
  return JSON.parse(jsonString, reviver) as T;
}
