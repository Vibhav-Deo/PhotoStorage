/**
 * CLIP BPE tokenizer, reimplemented from `tokenizer.json`.
 *
 * This exists only for the Node reference run. On device the tokenizer is the
 * runtime's concern (`react-native-executorch` bundles `tokenizers-cpp` and
 * loads the same `tokenizer.json`), so this file is not a component we would
 * ever ship.
 *
 * Scope limit, enforced rather than assumed: only ASCII input is supported. The
 * real pipeline includes a ByteLevel stage whose byte-to-unicode mapping is the
 * identity for printable ASCII but is not for anything else. Rather than
 * implement a mapping this spike cannot exercise, `encode` throws on non-ASCII
 * so a future caller cannot get a silently wrong tokenization.
 */

import { readFileSync } from 'node:fs';

const START_OF_TEXT = '<|startoftext|>';
const END_OF_TEXT = '<|endoftext|>';
const END_OF_WORD = '</w>';

/** CLIP ViT-B/32's text context length. */
export const CONTEXT_LENGTH = 77;

/** Matches the `Split` pre-tokenizer pattern from tokenizer.json. */
const SPLIT_PATTERN =
  /<\|startoftext\|>|<\|endoftext\|>|'s|'t|'re|'ve|'m|'ll|'d|[\p{L}]+|[\p{N}]|[^\s\p{L}\p{N}]+/gu;

interface TokenizerJson {
  model: {
    vocab: Record<string, number>;
    merges: string[] | [string, string][];
  };
}

export interface EncodedText {
  /** Length `CONTEXT_LENGTH`, padded with the end-of-text id. */
  readonly inputIds: BigInt64Array;
  /** Length `CONTEXT_LENGTH`, 1 for real tokens and 0 for padding. */
  readonly attentionMask: BigInt64Array;
  /** Token count before padding, including the two special tokens. */
  readonly realLength: number;
  /** True if the caption was longer than the context window. */
  readonly truncated: boolean;
}

export class ClipTokenizer {
  private readonly vocab: Record<string, number>;
  private readonly mergeRanks: Map<string, number>;
  private readonly startId: number;
  private readonly endId: number;
  /** BPE is deterministic per word, and captions repeat words, so cache. */
  private readonly wordCache = new Map<string, string[]>();

  constructor(tokenizerJsonPath: string) {
    const parsed = JSON.parse(
      readFileSync(tokenizerJsonPath, 'utf8')
    ) as TokenizerJson;
    this.vocab = parsed.model.vocab;

    this.mergeRanks = new Map();
    parsed.model.merges.forEach((merge, rank) => {
      const key = Array.isArray(merge) ? merge.join(' ') : merge;
      this.mergeRanks.set(key, rank);
    });

    const startId = this.vocab[START_OF_TEXT];
    const endId = this.vocab[END_OF_TEXT];
    if (startId === undefined || endId === undefined) {
      throw new Error(
        'tokenizer.json is missing the CLIP special tokens; wrong file?'
      );
    }
    this.startId = startId;
    this.endId = endId;
  }

  encode(text: string): EncodedText {
    // eslint-disable-next-line no-control-regex
    if (/[^\x00-\x7F]/.test(text)) {
      throw new Error(
        'ClipTokenizer (spike) supports ASCII only; see the note at the top ' +
          'of this file'
      );
    }

    const normalized = text.normalize('NFC').replace(/\s+/g, ' ').toLowerCase();
    const words = normalized.match(SPLIT_PATTERN) ?? [];

    const ids: number[] = [this.startId];
    for (const word of words) {
      for (const piece of this.bpe(word)) {
        const id = this.vocab[piece];
        if (id === undefined) {
          // Every byte-level char is in the CLIP vocab, so a miss means the
          // pipeline diverged. Surface it rather than substituting <unk>.
          throw new Error(`BPE produced an out-of-vocabulary piece: "${piece}"`);
        }
        ids.push(id);
      }
    }

    // Reserve room for the closing end-of-text token.
    const truncated = ids.length > CONTEXT_LENGTH - 1;
    if (truncated) ids.length = CONTEXT_LENGTH - 1;
    ids.push(this.endId);

    const realLength = ids.length;
    const inputIds = new BigInt64Array(CONTEXT_LENGTH);
    const attentionMask = new BigInt64Array(CONTEXT_LENGTH);
    for (let i = 0; i < CONTEXT_LENGTH; i++) {
      const isReal = i < realLength;
      // Padding with the end-of-text id (not 0) matches HF's CLIP config. It
      // also keeps `argmax(ids == eot)` pointing at the *first* end-of-text
      // token, which is how CLIP selects the pooled hidden state.
      inputIds[i] = BigInt(isReal ? ids[i]! : this.endId);
      attentionMask[i] = isReal ? 1n : 0n;
    }

    return { inputIds, attentionMask, realLength, truncated };
  }

  /** Standard BPE over a single pre-token, with CLIP's `</w>` word suffix. */
  private bpe(word: string): string[] {
    const cached = this.wordCache.get(word);
    if (cached) return cached;

    let symbols = [...word];
    if (symbols.length === 0) return [];
    symbols[symbols.length - 1] += END_OF_WORD;

    while (symbols.length > 1) {
      let bestRank = Infinity;
      let bestIndex = -1;
      for (let i = 0; i < symbols.length - 1; i++) {
        const rank = this.mergeRanks.get(`${symbols[i]} ${symbols[i + 1]}`);
        if (rank !== undefined && rank < bestRank) {
          bestRank = rank;
          bestIndex = i;
        }
      }
      if (bestIndex === -1) break;
      symbols = [
        ...symbols.slice(0, bestIndex),
        symbols[bestIndex]! + symbols[bestIndex + 1]!,
        ...symbols.slice(bestIndex + 2),
      ];
    }

    this.wordCache.set(word, symbols);
    return symbols;
  }
}
