export function pathId(value: string) {
  if (!value || value === "." || value === ".." || /[/\\\p{Cc}]/u.test(value)) {
    throw new TypeError("Invalid route ID");
  }
  return encodeURIComponent(value);
}
