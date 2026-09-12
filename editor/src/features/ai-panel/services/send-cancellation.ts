// Stop also invalidates work queued before a backend's prompt starts:
// module loading, reading a plan, or connecting an external agent.
let cancellationEpoch = 0;

export function cancelPendingSends(): void {
  cancellationEpoch++;
}

export function captureSendCancellation(): () => boolean {
  const epoch = cancellationEpoch;
  return () => epoch !== cancellationEpoch;
}
