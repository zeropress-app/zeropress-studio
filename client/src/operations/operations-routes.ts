export const OPERATIONS_PATHS = {
  overview: '/system/operations',
  access: '/system/operations/access',
  database: '/system/operations/database',
  edge: '/system/operations/edge',
  recovery: '/system/operations/recovery',
  danger: '/system/operations/danger',
} as const;

export type OperationsSection = keyof typeof OPERATIONS_PATHS;

export function operationsSectionForPath(pathname: string): OperationsSection {
  const entry = Object.entries(OPERATIONS_PATHS).find(([, path]) => (
    path === OPERATIONS_PATHS.overview
      ? pathname === path
      : pathname === path || pathname.startsWith(`${path}/`)
  ));
  return (entry?.[0] as OperationsSection | undefined) ?? 'overview';
}
