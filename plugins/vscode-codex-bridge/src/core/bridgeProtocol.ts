export const DEFAULT_STAGE_DONE_MARKERS = '{"bridge_stage":"done"},任务完成,阶段完成,END_OF_TASK,[DONE]';

const STAGE_JSON_PATTERN = /^\s*\{\s*"bridge_stage"\s*:\s*"(done|continue)"\s*\}\s*$/i;

export function composeOutboundMessage(
  message: string,
  options: { autoRelayEnabled: boolean; stopOnStageDone: boolean }
): string {
  if (!options.autoRelayEnabled || !options.stopOnStageDone) return message;
  return `${message}\n\n[Bridge 控制协议]\n- 回复最后一行必须是单行 JSON：{"bridge_stage":"continue"} 或 {"bridge_stage":"done"}`;
}

export function isStageDone(text: string, stageDoneMarkers: string): boolean {
  const lines = text.split(/\r?\n/).map((v) => v.trim()).filter(Boolean);
  const last = lines.length > 0 ? lines[lines.length - 1] : '';
  const match = STAGE_JSON_PATTERN.exec(last);
  if (match?.[1]?.toLowerCase() === 'done') return true;

  const markers = stageDoneMarkers
    .split(/[\n,;|]/)
    .map((v) => v.trim().toLowerCase())
    .filter(Boolean);

  const normalized = text.toLowerCase();
  return markers.some((m) => normalized.includes(m));
}

export function sanitizedRelayPayload(text: string): string {
  const lines = text.split(/\r?\n/);
  if (lines.length === 0) return text;
  const last = lines[lines.length - 1].trim();
  if (STAGE_JSON_PATTERN.test(last)) {
    return lines.slice(0, -1).join('\n').trim();
  }
  return text;
}
