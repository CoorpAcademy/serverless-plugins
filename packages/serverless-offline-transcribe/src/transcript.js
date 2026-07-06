const {filter, flatMap, getOr, isNil, map, reduce} = require('lodash/fp');

// serverless-offline-transcribe — Whisper JSON → AWS Transcribe JSON shaping (pure).
//
// Turns the `openai-whisper --output_format json --word_timestamps True` document into the AWS
// Transcribe result shape a production transcript reader expects. Pure, total helpers (G1/G2/G3):
// new objects via lodash/fp, no mutation. The exact input shape was verified by SPIKE 2 against a
// live Whisper `base` run — words carry a LEADING SPACE and trailing punctuation GLUED to the word
// (e.g. `" world,"`, `" transcription."`), which is why splitWordPunctuation exists.

// Every numeric that AWS Transcribe emits is a STRING ("0.64", "1.0", confidence "0.998"). Total:
// coerces any value to a string, never NaN/throw (G12).
const numToStr = value => String(value);

// Unicode punctuation class: everything AWS breaks out into standalone `punctuation` items. Split a
// raw Whisper word (already possibly space-padded) into leading punctuation, the pronounceable core,
// and trailing punctuation — WITHOUT breaking internal apostrophes/hyphens ("don't", "well-known"),
// which are not at a boundary. Pure/total: a bad input degrades to an empty word, never throws.
const WORD_SPLIT_RE = /^(\p{P}*)(.*?)(\p{P}*)$/u;

const splitWordPunctuation = raw => {
  // Strip Whisper's leading/trailing whitespace first (words come as " Hello", " world,").
  const trimmed = (isNil(raw) ? '' : String(raw)).trim();
  const match = WORD_SPLIT_RE.exec(trimmed);
  if (!match) return {leading: [], word: trimmed, trailing: []};
  const [, lead, core, trail] = match;
  return {
    // Each punctuation mark becomes its own item, mirroring AWS (a comma and a period are separate).
    leading: lead ? [...lead] : [],
    word: core,
    trailing: trail ? [...trail] : []
  };
};

// AWS punctuation items OMIT start_time/end_time (Whisper does not time punctuation) and carry
// confidence '0.0' — the verified real-AWS shape.
const punctuationItem = (id, content) => ({
  id,
  type: 'punctuation',
  alternatives: [{confidence: '0.0', content}]
});

// AWS pronunciation item: timed, with the word's probability as confidence. All numerics stringified.
const pronunciationItem = (id, content, word) => ({
  id,
  type: 'pronunciation',
  start_time: numToStr(getOr(0, 'start', word)),
  end_time: numToStr(getOr(0, 'end', word)),
  alternatives: [{confidence: numToStr(getOr(0, 'probability', word)), content}]
});

// One Whisper word → its ordered AWS items (leading punct*, one pronunciation, trailing punct*).
// A pure-punctuation token (word === '') yields only punctuation items — never an empty pronunciation.
const wordToItems = word => {
  const {leading, word: core, trailing} = splitWordPunctuation(getOr('', 'word', word));
  return [
    ...map(punct => ({kind: 'punctuation', content: punct}), leading),
    ...(core === '' ? [] : [{kind: 'pronunciation', content: core, word}]),
    ...map(punct => ({kind: 'punctuation', content: punct}), trailing)
  ];
};

// Assign stable integer ids across the whole item stream (audio_segments reference these ids).
const assignIds = reduce(
  (acc, piece) => {
    const id = acc.items.length;
    const item =
      piece.kind === 'punctuation'
        ? punctuationItem(id, piece.content)
        : pronunciationItem(id, piece.content, piece.word);
    return {items: [...acc.items, item]};
  },
  {items: []}
);

// Per-Whisper-segment fidelity block: the segment transcript, its span, and the ids of the items it
// contributed. Diarization / speaker_labels are omitted (Non-Goal). Pure.
const buildAudioSegments = segments => {
  let cursor = 0;
  return map(segment => {
    const pieces = flatMap(wordToItems, getOr([], 'words', segment));
    const ids = pieces.map((piece, index) => cursor + index);
    cursor += pieces.length;
    return {
      id: getOr(0, 'id', segment),
      transcript: (getOr('', 'text', segment) || '').trim(),
      start_time: numToStr(getOr(0, 'start', segment)),
      end_time: numToStr(getOr(0, 'end', segment)),
      items: ids
    };
  }, segments);
};

// whisperJsonToTranscribe(whisperJson, {jobName, accountId}) → the AWS Transcribe result document.
// Top-level camelCase jobName/accountId + status:'COMPLETED' + results{transcripts,items,audio_segments}.
const whisperJsonToTranscribe = (whisperJson, {jobName, accountId}) => {
  const segments = getOr([], 'segments', whisperJson);
  const words = flatMap(getOr([], 'words'), segments);
  const pieces = flatMap(wordToItems, words);
  const {items} = assignIds(pieces);

  return {
    jobName,
    accountId: numToStr(accountId),
    status: 'COMPLETED',
    results: {
      transcripts: [{transcript: (getOr('', 'text', whisperJson) || '').trim()}],
      items,
      audio_segments: buildAudioSegments(segments)
    }
  };
};

// Count non-empty pronounceable words — used to fail a job that produced no speech (AC-C4) rather
// than emit a silently-empty transcript.
const countPronunciations = whisperJson =>
  filter(
    piece => piece.kind === 'pronunciation',
    flatMap(wordToItems, flatMap(getOr([], 'words'), getOr([], 'segments', whisperJson)))
  ).length;

module.exports = {
  numToStr,
  splitWordPunctuation,
  wordToItems,
  whisperJsonToTranscribe,
  countPronunciations
};
