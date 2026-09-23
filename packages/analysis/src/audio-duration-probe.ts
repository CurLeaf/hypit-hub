import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function probeAudioDurationSeconds(audioPath: string): Promise<number> {
  const { stdout } = await execFileAsync("ffprobe", [
    "-hide_banner", "-loglevel", "error",
    "-show_entries", "format=duration",
    "-of", "default=noprint_wrappers=1:nokey=1",
    audioPath,
  ], { windowsHide: true });
  const seconds = Number.parseFloat(stdout.trim());
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new Error(`无法读取音频时长：${audioPath}`);
  }
  return seconds;
}
