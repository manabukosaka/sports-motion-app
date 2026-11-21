const dateTime =
  /^([0-9]{4}-[0-9]{2}-[0-9]{2})T((?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9])(?:\.([0-9]+))?(Z|[+-](?:[01][0-9]|2[0-3]):[0-5][0-9])(?![\s\S])/iu;

export function timestampKey(value: string) {
  const [, day, time, fraction = "", offset] = dateTime.exec(value) ?? [];
  if (!day || !time || !offset || day.startsWith("0000-")) {
    return undefined;
  }
  const midnight = new Date(`${day}T00:00:00Z`);
  if (!Number.isFinite(midnight.getTime()) || !midnight.toISOString().startsWith(day)) {
    return undefined;
  }
  let precision = fraction.length;
  while (fraction[precision - 1] === "0") {
    precision--;
  }
  return {
    wholeSecond: Date.parse(`${day}T${time}${offset.toUpperCase()}`) / 1000,
    fraction: fraction.slice(0, precision),
  };
}
