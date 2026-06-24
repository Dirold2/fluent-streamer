export function getTimeString(): string {
  return new Date().toLocaleTimeString("en-US", { hour12: false });
}
