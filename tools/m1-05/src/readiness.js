const ALLOWED_NEXT = new Map([
  ['CREATED', new Set(['AWAITING_PROVIDER', 'CANCELLED', 'EXPIRED'])],
  ['AWAITING_PROVIDER', new Set(['CODE_RECEIVED', 'CANCELLED', 'EXPIRED'])],
  ['CODE_RECEIVED', new Set(['EXCHANGING', 'CANCELLED', 'EXPIRED'])],
  ['EXCHANGING', new Set(['ASSETS_VERIFIED', 'FAILED', 'CANCELLED', 'EXPIRED'])],
  ['ASSETS_VERIFIED', new Set(['PROVISIONING', 'FAILED', 'CANCELLED', 'EXPIRED'])],
  ['PROVISIONING', new Set(['READY', 'PARTIAL', 'FAILED', 'CANCELLED', 'EXPIRED'])],
  ['READY', new Set()],
  ['PARTIAL', new Set()],
  ['CANCELLED', new Set()],
  ['EXPIRED', new Set()],
  ['FAILED', new Set()],
]);

export function canTransition(from, to, context = {}) {
  if (from === 'PARTIAL' && to === 'PROVISIONING') {
    return Boolean(context.recoveryJobId && Number.isInteger(context.policyVersion));
  }
  return ALLOWED_NEXT.get(from)?.has(to) ?? false;
}

export function isObservationStale(observedAt, now, maxAgeMs) {
  if (!observedAt) return true;
  const time = Date.parse(observedAt);
  return !Number.isFinite(time) || time > now || now - time > maxAgeMs;
}

export function deriveReadiness({ policy, evidence, now, maxAgeMs }) {
  const reasons = [];
  for (const capability of policy.required) {
    const item = evidence[capability];
    if (!item || item.status !== 'VERIFIED' || isObservationStale(item.observedAt, now, maxAgeMs)) {
      reasons.push({ capability, required: true, reason: item?.status === 'VERIFIED' ? 'EVIDENCE_STALE' : (item?.status ?? 'MISSING') });
    }
  }
  for (const capability of policy.optional) {
    if (!policy.requested.includes(capability)) continue;
    const item = evidence[capability];
    if (!item || item.status !== 'VERIFIED' || isObservationStale(item.observedAt, now, maxAgeMs)) {
      reasons.push({ capability, required: false, reason: item?.status === 'VERIFIED' ? 'EVIDENCE_STALE' : (item?.status ?? 'MISSING') });
    }
  }
  if (evidence.routeConflict === true) reasons.push({ capability: 'ASSET_ROUTE', required: true, reason: 'CONFLICT' });
  return { status: reasons.length === 0 ? 'READY' : 'PARTIAL', reasons, policyVersion: policy.version };
}
