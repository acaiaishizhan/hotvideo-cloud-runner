export function buildVideoInfraInvocation(config, action, args = []) {
  if (!config?.videoInfraCmd) {
    throw new Error('source config 缺少 videoInfraCmd');
  }
  return {
    command: config.videoInfraCmd,
    args: [...(config.videoInfraArgs || []), action, ...args],
  };
}
