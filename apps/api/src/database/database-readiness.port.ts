export const DATABASE_READINESS_PORT = Symbol('DATABASE_READINESS_PORT');

export interface DatabaseReadinessPort {
  check(): Promise<void>;
}
