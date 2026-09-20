export interface SlateHubJob {
  id: string;
  description: string;
  run(): Promise<void>;
}
