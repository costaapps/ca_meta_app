export const ERROR_POLICIES = Object.freeze({
  "OUTCOME_UNKNOWN": {
    "retryable": false,
    "action": "CHECK_STATUS"
  },
  "IDEMPOTENCY_KEY_REUSED": {
    "retryable": false,
    "action": "USE_NEW_REQUEST_KEY"
  },
  "COEXISTENCE_SESSION_ACTIVE": {
    "retryable": false,
    "action": "CHECK_STATUS"
  },
  "HOST_NOT_ALLOWED": {
    "retryable": false,
    "action": "CONTACT_ADMIN"
  },
  "INTERNAL_ERROR": {
    "retryable": false,
    "action": "CONTACT_ADMIN"
  }
});
