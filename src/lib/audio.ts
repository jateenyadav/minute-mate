// Turn any recording the browser can play (mp3, m4a, wav, webm, ogg…) into ~90 s pieces of
// 16 kHz mono 16-bit WAV — what Whisper uses internally — so every upload is under ~3 MB and
// fits a single Netlify Function call. Pieces are cut at the quietest moment near each boundary,
// so words are not chopped in half.

export const RATE = 16000;
export const PIECE_SECONDS = 90;
const SEARCH_SECONDS = 8;

export async function decodeToMono(file: Blob): Promise<Float32Array> {
  const data = await file.arrayBuffer();
  const ctx = new OfflineAudioContext(1, RATE, RATE);
  let buf: AudioBuffer;
  try {
    buf = await ctx.decodeAudioData(data);
  } catch {
    throw new Error("This file can't be read as audio here. Try an MP3, M4A or WAV file.");
  }
  if (buf.numberOfChannels === 1) return buf.getChannelData(0);
  const out = new Float32Array(buf.length);
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const ch = buf.getChannelData(c);
    for (let i = 0; i < ch.length; i++) out[i] += ch[i] / buf.numberOfChannels;
  }
  return out;
}

/** Index of the quietest 0.25 s window within ±SEARCH_SECONDS of `target`. */
function quietestNear(samples: Float32Array, target: number): number {
  const win = RATE / 4;
  const from = Math.max(0, target - SEARCH_SECONDS * RATE);
  const to = Math.min(samples.length - win, target + SEARCH_SECONDS * RATE);
  let best = target;
  let bestEnergy = Infinity;
  for (let i = from; i <= to; i += win / 2) {
    let e = 0;
    for (let k = i; k < i + win; k += 4) e += samples[k] * samples[k];
    if (e < bestEnergy) {
      bestEnergy = e;
      best = i + win / 2;
    }
  }
  return Math.round(best);
}

export type Piece = { offset: number; samples: Float32Array };

export function splitPieces(samples: Float32Array, pieceSeconds = PIECE_SECONDS): Piece[] {
  const pieces: Piece[] = [];
  const size = pieceSeconds * RATE;
  let start = 0;
  while (start < samples.length) {
    let end = start + size;
    if (end + (size * 0.25) >= samples.length) end = samples.length; // don't leave a tiny last piece
    else end = quietestNear(samples, end);
    pieces.push({ offset: start / RATE, samples: samples.subarray(start, end) });
    start = end;
  }
  return pieces;
}

export function encodeWav(samples: Float32Array): Blob {
  const buf = new ArrayBuffer(44 + samples.length * 2);
  const v = new DataView(buf);
  const str = (o: number, s: string) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); v.setUint32(4, 36 + samples.length * 2, true); str(8, 'WAVE');
  str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, RATE, true); v.setUint32(28, RATE * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  str(36, 'data'); v.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const x = Math.max(-1, Math.min(1, samples[i]));
    v.setInt16(44 + i * 2, x < 0 ? x * 0x8000 : x * 0x7fff, true);
  }
  return new Blob([buf], { type: 'audio/wav' });
}

/** True if the audio is basically silent (nothing to transcribe). */
export function isSilent(samples: Float32Array): boolean {
  let peak = 0;
  for (let i = 0; i < samples.length; i += 16) peak = Math.max(peak, Math.abs(samples[i]));
  return peak < 0.01;
}
