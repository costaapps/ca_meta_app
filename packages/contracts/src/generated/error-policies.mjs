export const ERROR_POLICIES = Object.freeze({
  "OUTCOME_UNKNOWN": {
    "retryable": false,
    "action": "CHECK_STATUS"
  },
  "IDEMPOTENCY_KEY_REUSED": {
    "retryable": false,
    "action": "USE_NEW_REQUEST_KEY"
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
