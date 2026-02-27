import OpenAI from "openai";
import { createReadStream } from "node:fs";

const openai = new OpenAI();

/**
 * Transcribe an audio file using OpenAI's Whisper API.
 * Requires OPENAI_API_KEY env var.
 */
export async function transcribeAudio(filePath: string): Promise<string> {
  const transcription = await openai.audio.transcriptions.create({
    model: "whisper-1",
    file: createReadStream(filePath),
  });
  return transcription.text;
}
