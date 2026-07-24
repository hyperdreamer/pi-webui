export const piWebUiPluginIdPattern = /^[a-z][a-z0-9.-]*$/u;

export function isPiWebUiPluginId(value: string): boolean {
  return piWebUiPluginIdPattern.test(value);
}
