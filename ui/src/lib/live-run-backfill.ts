export function shouldPollLiveRunBackfill({
  isLive,
}: {
  isLive: boolean;
  isStreamingConnected: boolean;
}) {
  return isLive;
}
