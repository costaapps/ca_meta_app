import type { ErrorAction, ErrorCode } from '../index.js';
export declare const ERROR_POLICIES: Readonly<Partial<Record<ErrorCode, { readonly retryable: boolean; readonly action: ErrorAction }>>>;
