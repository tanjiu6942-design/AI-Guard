export type CheckState = 'ok' | 'fail' | 'warn' | 'unknown';

export interface CheckResult {
  key: string;
  title: string;
  state: CheckState;
  detail: string;
}

export interface DoctorReport {
  at: string;
  items: CheckResult[];
  overall: CheckState;
}

export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;
