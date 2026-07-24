export const LOCAL_MACHINE_ID = "local";

export function machineProjectKey(machineId: string, projectId: string): string {
  return `${machineId}:${projectId}`;
}


export function machineSessionKey(machineId: string, sessionId: string): string {
  return `${machineId}:${sessionId}`;
}
