const {execFile} = require('child_process');
const fs = require('fs');
const path = require('path');
const {promisify} = require('util');
const {isNil} = require('lodash/fp');

// serverless-offline-transcribe — OpenAI Whisper worker (side effects isolated).
//
// Invokes the `whisper` CLI via execFile (NO shell — the audio path is passed as an argv element, so
// a hostile filename can never be interpreted as a command; G5 hardening). Pure argument/format
// helpers are exported for unit test; the process spawn + file reads are the isolated side effects.

const execFileAsync = promisify(execFile);

const DEFAULT_MODEL = 'base';

// AWS LanguageCode (`en-US`, `fr-FR`) → Whisper's short language (`en`, `fr`). Returning undefined
// lets Whisper auto-detect. Total/pure (G12).
const mapLanguageCode = code => {
  if (isNil(code) || code === '') return undefined;
  return String(code).split('-')[0].toLowerCase();
};

// Build the Whisper argv (pure/testable). `--word_timestamps True` is MANDATORY — it is what
// populates `segments[].words[]`, the source of the AWS `items[]` word timings. `--language` is
// omitted when unmapped so Whisper auto-detects.
const buildWhisperArgs = ({audioPath, model, outputDir, language}) => [
  audioPath,
  '--model',
  model || DEFAULT_MODEL,
  '--word_timestamps',
  'True',
  '--output_format',
  'json',
  '--output_dir',
  outputDir,
  ...(isNil(language) ? [] : ['--language', language])
];

// Whisper writes `<basename-without-ext>.json` into outputDir. Pure.
const whisperOutputPath = (audioPath, outputDir) =>
  path.join(outputDir, `${path.basename(audioPath, path.extname(audioPath))}.json`);

// Fail-fast probe (AC-C5): resolves true when the `whisper` binary is invokable, false when it is
// missing (ENOENT). Never throws — the caller decides how to surface the missing prerequisite.
const isWhisperAvailable = async (bin = 'whisper') => {
  try {
    await execFileAsync(bin, ['--help'], {maxBuffer: 1024 * 1024});
    return true;
  } catch (err) {
    // A non-ENOENT error (e.g. --help returned non-zero) still proves the binary exists.
    return err.code !== 'ENOENT';
  }
};

// Side effect: run Whisper on an audio file and return the parsed JSON. A missing binary (ENOENT)
// throws an actionable error naming the `whisper` prerequisite (AC-C5); any other non-zero exit
// (unsupported format/language, corrupt audio) throws with Whisper's stderr so the job FAILs with a
// real reason (AC-C4) rather than emitting an empty transcript.
const runWhisper = async ({audioPath, model, outputDir, language, bin = 'whisper', timeout}) => {
  const args = buildWhisperArgs({audioPath, model, outputDir, language});
  try {
    await execFileAsync(bin, args, {maxBuffer: 64 * 1024 * 1024, timeout});
  } catch (err) {
    if (err.code === 'ENOENT')
      throw new Error(
        `serverless-offline-transcribe: the "whisper" binary was not found on PATH. Install it with ` +
          '`pip install openai-whisper` (and ffmpeg) — see the plugin README.'
      );
    throw new Error(
      `serverless-offline-transcribe: whisper failed on ${audioPath}: ${err.stderr || err.message}`
    );
  }
  const jsonPath = whisperOutputPath(audioPath, outputDir);
  const raw = await fs.promises.readFile(jsonPath);
  return JSON.parse(raw);
};

module.exports = {
  DEFAULT_MODEL,
  mapLanguageCode,
  buildWhisperArgs,
  whisperOutputPath,
  isWhisperAvailable,
  runWhisper
};
